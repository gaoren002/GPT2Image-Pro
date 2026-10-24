/**
 * 图像操作共用的进程内队列：运行并发取运行设置，任务容量取环境预算。
 * 容量包含预留、运行和等待；等待可取消，运行槽位只能在真实工作结束后释放。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { QueuePriority } from "@repo/shared/config/subscription-plan";
import { logWarn } from "@repo/shared/logger";

type QueueOwner = { userId: string; apiKeyId?: string };
type QueueAdmissionOptions = QueueOwner & {
  estimatedBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
};
/** 仅在进程内传递的单次准入凭证；release 对已转入队列的任务无效。 */
export type ImageGenerationQueueReservation = {
  readonly token: symbol;
  release: () => boolean;
};
type ReservationEntry = QueueOwner & {
  estimatedBytes: number;
  expiresAt: number;
  timeout?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
};
type QueueTask = QueueOwner & {
  estimatedBytes: number;
  id: number;
  priority: QueuePriority;
  userConcurrency: number;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  run: () => Promise<unknown>;
  timeout?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
};

/** 队列过载/超时的稳定错误码供传输层映射；文案兼容既有字符串错误链。 */
export class ImageGenerationQueueError extends Error {
  readonly status: number = 429;
  readonly code: string = "image_generation_queue_busy";
}

/** 请求在空队列中也放不下，必须减少输入；不能让客户端按 429 无限重试。 */
export class ImageGenerationQueueInputTooLargeError extends ImageGenerationQueueError {
  override readonly status = 413;
  override readonly code = "image_generation_input_too_large";

  constructor() {
    super(
      "Image generation input exceeds the request memory budget. Please reduce total attachment size or batch size (减少总附件大小或批量数)."
    );
    this.name = "ImageGenerationQueueInputTooLargeError";
  }
}

/** 仅表示等待已取消，不表示已经开始的上游工作已停止。 */
export class ImageGenerationQueueCancelledError extends Error {
  readonly status = 499;
  readonly code = "image_generation_cancelled";

  constructor() {
    super("Image generation queue request cancelled.");
    this.name = "ImageGenerationQueueCancelledError";
  }
}

/** HTTP 准入错误响应；后台任务创建前调用，显式保留 413/429/499，不依赖字符串猜测。 */
export function toImageGenerationQueueErrorResponse(
  error: ImageGenerationQueueError | ImageGenerationQueueCancelledError
) {
  return Response.json(
    {
      error: {
        message: error.message,
        code: error.code,
        status: error.status,
        type:
          error.status === 429 ? "rate_limit_error" : "invalid_request_error",
      },
    },
    { status: error.status }
  );
}

const PRIORITY_WEIGHT: Record<QueuePriority, number> = {
  normal: 0,
  priority: 1,
  highest: 2,
};
let nextTaskId = 1;
let running = 0;
let outstanding = 0;
let outstandingBytes = 0;
let scheduling = false;
const runningByUser = new Map<string, number>();
const outstandingByUser = new Map<string, number>();
const outstandingByKey = new Map<string, number>();
const bytesByUser = new Map<string, number>();
const bytesByKey = new Map<string, number>();
const queue: QueueTask[] = [];
const reservations = new Map<symbol, ReservationEntry>();
const reservationContext =
  new AsyncLocalStorage<ImageGenerationQueueReservation>();

/** 只接收完整的正安全整数；非法配置使用保守默认，不允许关闭预算。 */
function getPositiveIntegerEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** Key 在所属用户内计数，防字符串拼接碰撞；无 Key 请求仍受用户预算保护。 */
function keyBucket(owner: QueueOwner) {
  return owner.apiKeyId
    ? JSON.stringify([owner.userId, owner.apiKeyId])
    : undefined;
}

/** 增减计数并移除归零项，避免用户/Key 索引随历史请求无限增长。 */
function changeCount(map: Map<string, number>, key: string, delta: number) {
  const value = (map.get(key) ?? 0) + delta;
  if (value > 0) map.set(key, value);
  else map.delete(key);
}

/** 获取物理预算；单请求和累计预算独立可配，不把套餐上传上限当作已验证内存容量。 */
function getQueueByteLimits(owner: QueueOwner) {
  return {
    request: getPositiveIntegerEnv(
      "IMAGE_GENERATION_QUEUE_MAX_REQUEST_BYTES",
      64 * 1024 * 1024
    ),
    global: getPositiveIntegerEnv(
      "IMAGE_GENERATION_QUEUE_MAX_BYTES",
      128 * 1024 * 1024
    ),
    user: getPositiveIntegerEnv(
      "IMAGE_GENERATION_QUEUE_MAX_BYTES_PER_USER",
      64 * 1024 * 1024
    ),
    key: owner.apiKeyId
      ? getPositiveIntegerEnv(
          "IMAGE_GENERATION_QUEUE_MAX_BYTES_PER_KEY",
          64 * 1024 * 1024
        )
      : Number.POSITIVE_INFINITY,
  };
}

/** 单请求独自也无法满足任一相关字节预算时先返回 413，等待其它任务没有帮助。 */
function assertRequestFitsBudget(owner: QueueOwner, estimatedBytes: number) {
  const limits = getQueueByteLimits(owner);
  if (
    estimatedBytes >
    Math.min(limits.request, limits.global, limits.user, limits.key)
  ) {
    throw new ImageGenerationQueueInputTooLargeError();
  }
}

/** 同步检查累计准入；没有 await，突发请求也不能穿透全局或用户/Key 容量。 */
function assertQueueCapacity(owner: QueueOwner, estimatedBytes: number) {
  const key = keyBucket(owner);
  assertRequestFitsBudget(owner, estimatedBytes);
  const limits = getQueueByteLimits(owner);
  if (
    outstanding >=
      getPositiveIntegerEnv("IMAGE_GENERATION_QUEUE_MAX_TASKS", 512) ||
    (outstandingByUser.get(owner.userId) ?? 0) >=
      getPositiveIntegerEnv("IMAGE_GENERATION_QUEUE_MAX_TASKS_PER_USER", 128) ||
    (key !== undefined &&
      (outstandingByKey.get(key) ?? 0) >=
        getPositiveIntegerEnv(
          "IMAGE_GENERATION_QUEUE_MAX_TASKS_PER_KEY",
          128
        )) ||
    outstandingBytes + estimatedBytes > limits.global ||
    (bytesByUser.get(owner.userId) ?? 0) + estimatedBytes > limits.user ||
    (key !== undefined &&
      (bytesByKey.get(key) ?? 0) + estimatedBytes > limits.key)
  ) {
    throw new ImageGenerationQueueError(
      "Image generation queue is busy. Capacity limit reached. Please retry shortly."
    );
  }
}

/** 预留/释放整个任务的容量；启动运行时不释放，以约束闭包及输入的总数量。 */
function changeOutstanding(
  owner: QueueOwner & { estimatedBytes: number },
  delta: number
) {
  outstanding += delta;
  outstandingBytes += delta * owner.estimatedBytes;
  changeCount(outstandingByUser, owner.userId, delta);
  changeCount(bytesByUser, owner.userId, delta * owner.estimatedBytes);
  const key = keyBucket(owner);
  if (key !== undefined) {
    changeCount(outstandingByKey, key, delta);
    changeCount(bytesByKey, key, delta * owner.estimatedBytes);
  }
}

/**
 * 估算队列所持输入：预留 64KiB 元数据，字符串/二进制按两份计入，Blob 按 size。
 * 重复引用只计一次；这是准入估算，不是整个生成过程或 V8 堆的硬上限。
 */
export function estimateImageGenerationQueueBytes(input: unknown) {
  const seen = new WeakSet<object>();
  const pending: unknown[] = [input];
  let bytes = 64 * 1024;
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === "string") {
      bytes += 2 * Math.max(value.length, Buffer.byteLength(value, "utf8"));
      continue;
    }
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    bytes += 64;
    if (ArrayBuffer.isView(value)) bytes += 2 * value.buffer.byteLength;
    else if (value instanceof ArrayBuffer) bytes += 2 * value.byteLength;
    else if (typeof Blob !== "undefined" && value instanceof Blob)
      bytes += 2 * value.size;
    else for (const field of Object.values(value)) pending.push(field);
  }
  return bytes;
}

/** 释放未使用的准入凭证；清理定时器/监听器并原子退回任务及字节预算。 */
function releaseReservation(token: symbol) {
  const entry = reservations.get(token);
  if (!entry) return false;
  reservations.delete(token);
  if (entry.timeout !== undefined) clearTimeout(entry.timeout);
  if (entry.signal && entry.onAbort)
    entry.signal.removeEventListener("abort", entry.onAbort);
  changeOutstanding(entry, -1);
  return true;
}

/**
 * 在异步响应/昂贵工作前同步预留容量；单请求过大返回 413，累计占满返回 429。
 * 未认领的凭证有等待 TTL。
 * async handler 仅在调用前检查 request.signal，不把该信号附到已受理后台任务。
 */
export function reserveImageGenerationQueue(
  options: QueueAdmissionOptions
): ImageGenerationQueueReservation {
  if (options.signal?.aborted) throw new ImageGenerationQueueCancelledError();
  const estimatedBytes = options.estimatedBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes <= 0) {
    throw new ImageGenerationQueueError(
      "Image generation queue is busy. Invalid input byte estimate."
    );
  }
  assertQueueCapacity(options, estimatedBytes);
  const token = Symbol("image-generation-queue-reservation");
  const timeoutMs = getQueueTimeoutMs(options.timeoutMs);
  const entry: ReservationEntry = {
    userId: options.userId,
    apiKeyId: options.apiKeyId,
    estimatedBytes,
    expiresAt: Date.now() + timeoutMs,
    signal: options.signal,
  };
  const release = () => releaseReservation(token);
  entry.timeout = setTimeout(release, timeoutMs);
  entry.timeout.unref?.();
  entry.onAbort = release;
  reservations.set(token, entry);
  changeOutstanding(entry, 1);
  options.signal?.addEventListener("abort", release, { once: true });
  return { token, release };
}

/**
 * async 批次在返回前预留所有任务容量，部分失败则全部退回。
 * request.signal 只在准入前检查一次，不绑定 HTTP 响应之后的后台工作。
 */
export function reserveAsyncImageGenerationQueueBatch(
  options: QueueAdmissionOptions & { count: number }
) {
  if (options.signal?.aborted) throw new ImageGenerationQueueCancelledError();
  if (!Number.isSafeInteger(options.count) || options.count <= 0) {
    throw new ImageGenerationQueueError(
      "Image generation queue is busy. Invalid admission count."
    );
  }
  assertRequestFitsBudget(
    options,
    (options.estimatedBytes ?? 1024 * 1024) * options.count
  );
  const result: ImageGenerationQueueReservation[] = [];
  try {
    for (let index = 0; index < options.count; index += 1) {
      result.push(
        reserveImageGenerationQueue({ ...options, signal: undefined })
      );
    }
    return result;
  } catch (error) {
    for (const reservation of result) reservation.release();
    throw error;
  }
}

/**
 * 把一个准入凭证沿异步调用链交给单一图像管线；withImageGenerationQueue 只认领一次。
 * 操作在进入队列前失败/返回时也退还预算，不要求 operations 增加传输层凭证字段。
 */
export async function runWithImageGenerationQueueReservation<T>(
  reservation: ImageGenerationQueueReservation,
  run: () => Promise<T>
) {
  try {
    return await reservationContext.run(reservation, run);
  } finally {
    reservation.release();
  }
}

/** 原子把预留转为等待任务，不重复计费；过期/重复/跨用户认领一律拒绝。 */
function claimReservation(
  reservation: ImageGenerationQueueReservation,
  owner: QueueOwner
) {
  const entry = reservations.get(reservation.token);
  if (
    !entry ||
    entry.expiresAt <= Date.now() ||
    entry.userId !== owner.userId ||
    (owner.apiKeyId !== undefined && entry.apiKeyId !== owner.apiKeyId)
  ) {
    throw new ImageGenerationQueueError(
      "Image generation queue is busy. Admission reservation expired or invalid."
    );
  }
  reservations.delete(reservation.token);
  if (entry.timeout !== undefined) clearTimeout(entry.timeout);
  if (entry.signal && entry.onAbort)
    entry.signal.removeEventListener("abort", entry.onAbort);
  return entry;
}

/** 获取全局运行并发；无效数值不能变成无限并发。设置读取异常由调度器收敛。 */
async function getGlobalConcurrency() {
  // 准入/估算不查询设置或数据库；只有真正调度时才加载运行设置，便于传输层 DB-free 校验。
  const { getRuntimeSettingNumber } = await import(
    "@repo/shared/system-settings"
  );
  const value = await getRuntimeSettingNumber(
    "IMAGE_GENERATION_GLOBAL_CONCURRENCY",
    500,
    { positive: true }
  );
  return Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : 500;
}

/** 返回等待预算，限制到 Node 定时器范围，避免大配置溢出为 1ms。 */
function getQueueTimeoutMs(timeoutMs?: number) {
  const value =
    timeoutMs !== undefined && Number.isSafeInteger(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : getPositiveIntegerEnv("IMAGE_GENERATION_QUEUE_TIMEOUT_MS", 20 * 60_000);
  return Math.min(value, 2_147_483_647);
}

/** 把等待时间格式化到既有对外错误文案。 */
function formatDuration(seconds: number) {
  return seconds % 60 === 0
    ? `${seconds / 60} minute(s)`
    : `${seconds} second(s)`;
}

/** 区分用户槽位耗尽与全局繁忙，两者均按 429 返回。 */
function getQueuedTaskTimeoutError(task: QueueTask, timeoutMs: number) {
  const duration = formatDuration(Math.ceil(timeoutMs / 1000));
  if ((runningByUser.get(task.userId) ?? 0) >= task.userConcurrency) {
    return new ImageGenerationQueueError(
      `Image generation concurrency limit reached for this plan. Your plan allows ${task.userConcurrency} concurrent image generation task(s); this queued request waited ${duration} without a free slot.`
    );
  }
  return new ImageGenerationQueueError(
    `Image generation queue is busy. This queued request waited ${duration} without a free global slot. Please retry shortly.`
  );
}

/** 清理等待的定时器和监听器；开始运行、超时、取消和拒绝共用。 */
function cleanWaitingResources(task: QueueTask) {
  if (task.timeout !== undefined) clearTimeout(task.timeout);
  if (task.signal && task.onAbort)
    task.signal.removeEventListener("abort", task.onAbort);
  task.timeout = undefined;
  task.onAbort = undefined;
  task.signal = undefined;
}

/** 原子移除一个等待任务并释放预算；已运行任务不在 queue 中，不会被误释放。 */
function rejectQueuedTask(task: QueueTask, error: Error) {
  const index = queue.indexOf(task);
  if (index === -1) return false;
  queue.splice(index, 1);
  cleanWaitingResources(task);
  changeOutstanding(task, -1);
  task.reject(error);
  return true;
}

/** 清理匹配用户/Key 的未认领预留和等待任务；无筛选时清理全部，不打断运行任务。 */
export function cancelQueuedImageGenerationTasks(
  owner: Partial<QueueOwner> = {}
) {
  let cancelled = 0;
  for (const [token, entry] of reservations) {
    if (owner.userId !== undefined && owner.userId !== entry.userId) continue;
    if (owner.apiKeyId !== undefined && owner.apiKeyId !== entry.apiKeyId)
      continue;
    if (releaseReservation(token)) cancelled += 1;
  }
  for (const task of [...queue]) {
    if (owner.userId !== undefined && owner.userId !== task.userId) continue;
    if (owner.apiKeyId !== undefined && owner.apiKeyId !== task.apiKeyId)
      continue;
    if (rejectQueuedTask(task, new ImageGenerationQueueCancelledError()))
      cancelled += 1;
  }
  return cancelled;
}

/**
 * 按套餐优先级/FIFO 调度，跳过已达用户运行上限的任务，避免堵住其他用户。
 * 设置故障时拒绝等待任务并释放预算，不留下悬挂 promise 或未处理 rejection。
 */
async function scheduleQueue() {
  if (scheduling || queue.length === 0) return;
  scheduling = true;
  try {
    const globalConcurrency = await getGlobalConcurrency();
    // 等待读取设置时可能有新任务入队，排序必须在 await 后进行。
    queue.sort(
      (a, b) =>
        PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority] || a.id - b.id
    );
    for (let index = 0; index < queue.length && running < globalConcurrency; ) {
      const task = queue[index];
      if (!task) break;
      if ((runningByUser.get(task.userId) ?? 0) >= task.userConcurrency) {
        index += 1;
        continue;
      }
      queue.splice(index, 1);
      startTask(task);
    }
  } catch {
    logWarn("Image generation queue settings unavailable", {
      source: "image-generation-queue",
    });
    for (const task of [...queue]) {
      rejectQueuedTask(
        task,
        new ImageGenerationQueueError(
          "Image generation queue is busy. Queue settings are unavailable. Please retry shortly."
        )
      );
    }
  } finally {
    scheduling = false;
  }
}

/** 同步抛错、异步失败和成功均先释放真实槽位再完成调用方 promise。 */
function startTask(task: QueueTask) {
  cleanWaitingResources(task);
  running += 1;
  changeCount(runningByUser, task.userId, 1);
  const finish = () => {
    running -= 1;
    changeCount(runningByUser, task.userId, -1);
    changeOutstanding(task, -1);
    void scheduleQueue();
  };
  void Promise.resolve()
    // 准入凭证已经认领；运行阶段发起的独立任务必须重新准入，不能继承旧凭证。
    .then(() => reservationContext.exit(task.run))
    .then(
      (value) => {
        finish();
        task.resolve(value);
      },
      (error: unknown) => {
        finish();
        task.reject(error);
      }
    );
}

/**
 * 在有界队列执行图像操作。apiKeyId 缺省无独立 Key 桶；signal 缺省不监听取消。
 * estimatedBytes 缺省按 1MiB 计；生产管线应使用估算器计入真实输入，async 预留只认领一次。
 * signal 只取消等待；要终止运行工作，调用方须把同一信号继续传给上游。
 */
export async function withImageGenerationQueue<T>(
  options: QueueAdmissionOptions & {
    priority: QueuePriority;
    userConcurrency: number;
  },
  run: () => Promise<T>
): Promise<T> {
  if (options.signal?.aborted) throw new ImageGenerationQueueCancelledError();
  const reservation =
    reservationContext.getStore() ?? reserveImageGenerationQueue(options);
  const admission = claimReservation(reservation, options);
  return new Promise<T>((resolve, reject) => {
    const timeoutMs = Math.max(1, admission.expiresAt - Date.now());
    const task: QueueTask = {
      ...options,
      apiKeyId: admission.apiKeyId,
      estimatedBytes: admission.estimatedBytes,
      id: nextTaskId++,
      userConcurrency: Number.isFinite(options.userConcurrency)
        ? Math.max(1, Math.floor(options.userConcurrency))
        : 1,
      resolve: (value) => resolve(value as T),
      reject,
      run,
    };
    task.timeout = setTimeout(() => {
      rejectQueuedTask(task, getQueuedTaskTimeoutError(task, timeoutMs));
    }, timeoutMs);
    task.timeout.unref?.();
    task.onAbort = () => {
      rejectQueuedTask(task, new ImageGenerationQueueCancelledError());
    };
    queue.push(task);
    options.signal?.addEventListener("abort", task.onAbort, { once: true });
    void scheduleQueue();
  });
}
