/**
 * v1 图像/PPT/PSD 的进程内异步任务与公网回调。
 * 普通图像仅留存对象引用，投递时编码；纯中转执行前预留完整交付上界，完成起计 TTL。
 */
import { randomUUID } from "node:crypto";
import { logError, logWarn } from "@repo/shared/logger";
import {
  ASYNC_IMAGE_RELAY_RESERVATION_BYTES,
  ASYNC_IMAGE_STORAGE_RESERVATION_BYTES,
} from "@/features/image-generation/async-image-limits";
import {
  type AsyncImageResult,
  type AsyncImageResultReference,
  renderAsyncImageResult,
  toAsyncImageResultReference,
  toAsyncGenerationUsage,
} from "./async-image-result";
import {
  assertPublicCallbackUrl,
  fetchPublicCallback,
} from "./safe-image-fetch";

type AsyncImageTaskStatus = "processing" | "completed" | "failed";

export type AsyncImageTask = {
  id: string;
  object: "image.generation" | "image" | "editable_file_task";
  userId: string;
  apiKeyId?: string;
  model?: string;
  status: AsyncImageTaskStatus;
  created_at: string;
  completed_at?: string;
  generation_id?: string;
  generationId?: string;
  generation_ids?: string[];
  generationIds?: string[];
  [key: string]: unknown;
};

type CreateAsyncImageTaskParams = {
  userId: string;
  apiKeyId?: string;
  model?: string;
  generationIds?: string[];
  retention?: "storage" | "relay";
};

type CompleteAsyncImageTaskParams = {
  result?: unknown;
  error?: unknown;
  imageResult?: AsyncImageResult;
  // 完成后的 object 类型。图像任务从 image.generation 转为 image(默认);可编辑文件任务
  // 传 "editable_file_task" 以保持类型不变(不被误标成 image)。
  completedObject?: AsyncImageTask["object"];
};

const CALLBACK_TIMEOUT_MS = 10_000;
type TaskEntry = {
  task: AsyncImageTask;
  bytes: number;
  reservationBytes: number;
  retention?: "storage" | "relay";
  imageResult?: AsyncImageResultReference;
  expiresAt?: number;
  timeout?: ReturnType<typeof setTimeout>;
};
const asyncImageTasks = new Map<string, TaskEntry>();

/** 单笔无法放下为 413，当前占用导致暂满为 429；均须在启动后台付费工作前返回。 */
export class AsyncImageTaskCapacityError extends Error {
  readonly status: 413 | 429;
  readonly code:
    | "async_image_task_reservation_too_large"
    | "async_image_task_capacity_exceeded";

  constructor(status: 413 | 429 = 429) {
    super(
      status === 413
        ? "Async image task reservation exceeds the result byte budget. Reduce n."
        : "Async image task capacity exceeded. Please retry shortly."
    );
    this.status = status;
    this.code =
      status === 413
        ? "async_image_task_reservation_too_large"
        : "async_image_task_capacity_exceeded";
    this.name = "AsyncImageTaskCapacityError";
  }
}

/** 准入失败的薄 HTTP 适配，显式设置类型/状态，不依赖图片错误的字符串分类。 */
export function toAsyncImageTaskCapacityResponse(
  error: AsyncImageTaskCapacityError
) {
  return Response.json(
    {
      error: {
        message: error.message,
        type:
          error.status === 413 ? "invalid_request_error" : "rate_limit_error",
        code: error.code,
        status: error.status,
      },
    },
    { status: error.status }
  );
}

/** 预算必须是正安全整数；零、负数、部分数字和无穷值不能关闭保护。 */
function getTaskLimit(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** 删除终态并清理定时器；处理态从不按创建时间驱逐。 */
function removeExpiredTasks() {
  const now = Date.now();
  for (const [id, entry] of asyncImageTasks) {
    if (entry.expiresAt !== undefined && entry.expiresAt <= now) {
      if (entry.timeout !== undefined) clearTimeout(entry.timeout);
      asyncImageTasks.delete(id);
    }
  }
}

/** UTF-8 JSON 字节是留存预算，不等同于 V8 堆大小；不可序列化的结果按超限处理。 */
function retainedBytes(task: AsyncImageTask) {
  try {
    return Buffer.byteLength(JSON.stringify(task), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * 有界扫描同时核对数量和字节；Key 在用户内分桶，绝不驱逐其他用户来腾空间。
 * 创建时把完整结果预留计入预算，所有检查和更新均无 await，避免并发穿透。
 */
function hasTaskCapacity(task: AsyncImageTask, bytes: number) {
  const totalLimit = getTaskLimit(
    "ASYNC_IMAGE_TASK_MAX_TOTAL_RESULT_BYTES",
    512 * 1024 * 1024
  );
  const userLimit = getTaskLimit(
    "ASYNC_IMAGE_TASK_MAX_RESULT_BYTES_PER_USER",
    256 * 1024 * 1024
  );
  const keyLimit = getTaskLimit(
    "ASYNC_IMAGE_TASK_MAX_RESULT_BYTES_PER_KEY",
    256 * 1024 * 1024
  );
  // 先忽略所有现有占用核对单笔完整预留；永久放不下不能让客户端无限重试。
  if (
    bytes > totalLimit ||
    bytes > userLimit ||
    (task.apiKeyId && bytes > keyLimit)
  ) {
    throw new AsyncImageTaskCapacityError(413);
  }
  let count = 0;
  let userCount = 0;
  let keyCount = 0;
  let totalBytes = 0;
  let userBytes = 0;
  let keyBytes = 0;
  for (const entry of asyncImageTasks.values()) {
    count += 1;
    totalBytes += entry.bytes;
    if (entry.task.userId !== task.userId) continue;
    userCount += 1;
    userBytes += entry.bytes;
    if (task.apiKeyId && entry.task.apiKeyId === task.apiKeyId) {
      keyCount += 1;
      keyBytes += entry.bytes;
    }
  }
  return (
    count < getTaskLimit("ASYNC_IMAGE_TASK_MAX_COUNT", 256) &&
    userCount < getTaskLimit("ASYNC_IMAGE_TASK_MAX_COUNT_PER_USER", 16) &&
    (!task.apiKeyId ||
      keyCount < getTaskLimit("ASYNC_IMAGE_TASK_MAX_COUNT_PER_KEY", 8)) &&
    totalBytes + bytes <= totalLimit &&
    userBytes + bytes <= userLimit &&
    (!task.apiKeyId || keyBytes + bytes <= keyLimit)
  );
}

/** 开始工作前按批次预留完整结果预算；元数据也计费，不能只为小型错误占位。 */
function retainProcessingTask(
  task: AsyncImageTask,
  retention?: "storage" | "relay"
) {
  removeExpiredTasks();
  const imageCount = task.generationIds?.length || 1;
  const perGenerationBytes =
    retention === "storage"
      ? ASYNC_IMAGE_STORAGE_RESERVATION_BYTES
      : retention === "relay"
        ? Math.max(
            ASYNC_IMAGE_RELAY_RESERVATION_BYTES,
            getTaskLimit(
              "ASYNC_IMAGE_TASK_RESULT_RESERVATION_BYTES",
              16 * 1024 * 1024
            )
          )
        : getTaskLimit(
            "ASYNC_IMAGE_TASK_RESULT_RESERVATION_BYTES",
            16 * 1024 * 1024
          );
  const reservationBytes = Math.max(
    perGenerationBytes * imageCount +
      (retention ? retainedBytes(task) + 4096 : 0),
    retainedBytes(task) + 512
  );
  if (!hasTaskCapacity(task, reservationBytes))
    throw new AsyncImageTaskCapacityError();
  asyncImageTasks.set(task.id, {
    task,
    bytes: reservationBytes,
    reservationBytes,
    retention,
  });
  return task;
}

/** 回调 URL 提交期校验：强制 https + 公网，复用 safe-image-fetch 单一来源。 */
export async function validateCallbackUrl(value: string) {
  const url = await assertPublicCallbackUrl(value);
  return url.toString();
}

/** 创建处理态图像任务；超过数量或元数据预算时同步拒绝，不启动后台工作。 */
export function createAsyncImageTask(params: CreateAsyncImageTaskParams) {
  const id = `task_${randomUUID().replace(/-/g, "")}`;
  const generationIds = params.generationIds?.filter(Boolean);
  const now = new Date();
  const task: AsyncImageTask = {
    id,
    object: "image.generation",
    userId: params.userId,
    apiKeyId: params.apiKeyId,
    model: params.model,
    status: "processing",
    created: Math.floor(now.getTime() / 1000),
    created_at: now.toISOString(),
    ...(generationIds?.length === 1
      ? {
          generation_id: generationIds[0],
          generationId: generationIds[0],
        }
      : generationIds?.length
        ? {
            generation_ids: generationIds,
            generationIds,
          }
        : {}),
  };
  return retainProcessingTask(task, params.retention);
}

type CreateAsyncEditableFileTaskParams = {
  userId: string;
  apiKeyId?: string;
  kind: "ppt" | "psd";
  clientTaskId?: string;
};

/**
 * 创建一个可编辑文件(PPT/PSD)异步任务(与图像任务同一内存存储/TTL/回调基础设施)。
 * object=editable_file_task;返回 task_<uuid> 立即回给客户端,后台跑完再 completeAsyncImageTask
 * (completedObject 传 editable_file_task 保持类型)。可编辑文件无 DB generation 行,故只走内存态。
 */
export function createAsyncEditableFileTask(
  params: CreateAsyncEditableFileTaskParams
) {
  const id = `task_${randomUUID().replace(/-/g, "")}`;
  const now = new Date();
  const task: AsyncImageTask = {
    id,
    object: "editable_file_task",
    userId: params.userId,
    apiKeyId: params.apiKeyId,
    kind: params.kind,
    ...(params.clientTaskId ? { client_task_id: params.clientTaskId } : {}),
    status: "processing",
    created: Math.floor(now.getTime() / 1000),
    created_at: now.toISOString(),
  };
  return retainProcessingTask(task);
}

/** 查询内存任务；惰性清理补偿事件循环延迟，不延长 TTL。 */
export function getAsyncImageTask(id: string) {
  removeExpiredTasks();
  return asyncImageTasks.get(id)?.task;
}

/** 移除内部归属字段，供轮询、初始响应和 callback 共用。 */
export function toAsyncImageTaskResponse(task: AsyncImageTask) {
  const { userId: _userId, apiKeyId: _apiKeyId, ...publicTask } = task;
  return publicTask;
}

/** 归属由 handler 先验证；普通图在 poll/callback 时才读取内容，不缓存编码后的响应。 */
export async function resolveAsyncImageTaskResponse(
  task: AsyncImageTask,
  request: Request
) {
  const reference = asyncImageTasks.get(task.id)?.imageResult;
  const publicTask = toAsyncImageTaskResponse(task);
  if (!reference) return publicTask;
  const {
    history_pending: _history,
    settlement_status: _settlement,
    settlements: _settlements,
    ...identity
  } = publicTask;
  return {
    ...identity,
    ...(await renderAsyncImageResult(request, reference)),
  };
}

/** 一条 generation 记录(DB 回退查询用的最小字段集)。 */
export type GenerationTaskRow = {
  id: string;
  model: string;
  status: "pending" | "completed" | "failed";
  revisedPrompt: string | null;
  creditsConsumed: string | number | null;
  error: string | null;
  createdAt: Date;
  completedAt: Date | null;
};

/**
 * 把一条 generation 记录转成 /v1/images/{id} 的响应（DB 回退路径，纯函数 DB-free）。
 *
 * 内存异步任务存储是临时态（仅 async=true 创建、按 task_<uuid> 为键、进程内、30 分钟
 * 完成后 TTL、多实例不共享、重启即清），同步请求拿到的是 generation_id 而非 task id。本函数让
 * 接口可按 generation_id 从 DB 持久取回，对同步/异步、跨实例/重启都稳。归属校验（userId）
 * 由调用方在查库后完成，本函数只做结构映射，不含权限判断。
 *
 * 结构对齐同步成功响应（data:[{url, revised_prompt}]）+ 任务状态字段；并额外给
 * image_url 顶层兜底，便于只取单一 URL 的客户端。
 */
export function toGenerationImageTaskResponse(
  row: GenerationTaskRow,
  imageUrl: string | null
) {
  const status: AsyncImageTaskStatus =
    row.status === "completed"
      ? "completed"
      : row.status === "failed"
        ? "failed"
        : "processing";
  const credits = Number(row.creditsConsumed ?? 0);
  return {
    id: row.id,
    object: status === "completed" ? "image" : "image.generation",
    model: row.model,
    status,
    created: Math.floor(row.createdAt.getTime() / 1000),
    created_at: row.createdAt.toISOString(),
    ...(row.completedAt ? { completed_at: row.completedAt.toISOString() } : {}),
    generation_id: row.id,
    generationId: row.id,
    ...(status === "completed" && imageUrl
      ? {
          image_url: imageUrl,
          data: [
            {
              url: imageUrl,
              ...(row.revisedPrompt
                ? { revised_prompt: row.revisedPrompt }
                : {}),
            },
          ],
        }
      : {}),
    ...(status === "failed" && row.error
      ? { error: { message: row.error } }
      : {}),
    ...(Number.isFinite(credits) ? { credits_consumed: credits } : {}),
  };
}

/**
 * 幂等完成并从此刻计 TTL；普通图仅保存引用，relay 图片已在成功结算前限制交付上界。
 * 兼容的 editable 路径或调用契约异常仍保付费交付并阻止后续准入，不在此丢弃结果。
 * 字节记账衡量留存 JSON，不声称 V8/RSS 硬上限；处理态超过 30min 仍保留完成入口。
 */
export function completeAsyncImageTask(
  id: string,
  params: CompleteAsyncImageTaskParams
) {
  removeExpiredTasks();
  const entry = asyncImageTasks.get(id);
  if (!entry) return undefined;
  const existing = entry.task;
  if (existing.status !== "processing") return existing;

  const now = new Date();
  const completedAt = now.toISOString();
  const imageResult = params.imageResult
    ? toAsyncImageResultReference(params.imageResult, existing.userId)
    : undefined;
  const resultFailed =
    imageResult?.results.some((result) => result.error) === true;
  const payload =
    params.error && entry.retention && !params.result
      ? boundedTaskError(params.error)
      : (params.error ?? params.result);
  const payloadFields =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : params.error
        ? { error: payload }
        : { result: payload };
  let task: AsyncImageTask = {
    ...existing,
    ...payloadFields,
    ...(imageResult
      ? {
          created: imageResult.created,
          ...toAsyncGenerationUsage(imageResult.results),
        }
      : {}),
    id: existing.id,
    userId: existing.userId,
    apiKeyId: existing.apiKeyId,
    created_at: existing.created_at,
    object: params.completedObject ?? "image",
    status: params.error || resultFailed ? "failed" : "completed",
    completed: Math.floor(now.getTime() / 1000),
    completed_at: completedAt,
  };
  let bytes =
    retainedBytes(task) +
    (imageResult ? Buffer.byteLength(JSON.stringify(imageResult)) : 0);
  if (!Number.isFinite(bytes)) {
    task = {
      ...existing,
      object: params.completedObject ?? "image",
      status: "failed",
      completed: Math.floor(now.getTime() / 1000),
      completed_at: completedAt,
      error: {
        message: "Async image task result is not serializable.",
        type: "invalid_request_error",
        code: "async_image_result_invalid",
        status: 413,
      },
    };
    bytes = retainedBytes(task);
  }
  if (bytes > entry.reservationBytes) {
    logWarn(
      "Async image task result exceeded its reservation; retaining delivery",
      {
        source: "external-api-async-image-tasks",
        taskId: id,
        resultBytes: bytes,
        reservationBytes: entry.reservationBytes,
      }
    );
  }
  entry.task = task;
  entry.imageResult = imageResult;
  entry.bytes = bytes;
  const ttl = Math.min(
    getTaskLimit("ASYNC_IMAGE_TASK_RESULT_TTL_MS", 30 * 60_000),
    2_147_483_647
  );
  entry.expiresAt = now.getTime() + ttl;
  entry.timeout = setTimeout(() => {
    removeExpiredTasks();
  }, ttl);
  entry.timeout.unref?.();
  return task;
}

/** 失败只留有限错误标量，防上游把整段正文当异常消息挂在 30 分钟任务中。 */
function boundedTaskError(payload: unknown) {
  const record =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const error =
    record.error && typeof record.error === "object"
      ? (record.error as Record<string, unknown>)
      : record;
  return {
    error: {
      message: String(error.message ?? payload).slice(0, 4096),
      ...(typeof error.type === "string"
        ? { type: error.type.slice(0, 128) }
        : {}),
      ...(typeof error.code === "string"
        ? { code: error.code.slice(0, 128) }
        : {}),
      ...(typeof error.status === "number" ? { status: error.status } : {}),
    },
  };
}

/** 逐跳校验公网地址并在 10 秒内尝试回调；失败只记录元信息，不改变任务终态。 */
export async function postAsyncImageCallback(
  callbackUrl: string,
  payload: AsyncImageTask
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CALLBACK_TIMEOUT_MS);
  try {
    // 完成时再经逐跳复检投递：弥补"提交校验通过、30 分钟后被 302 跳内网"的 TOCTOU 盲 SSRF。
    const response = await fetchPublicCallback(callbackUrl, {
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Tokens-Callback": "true",
      },
      body: JSON.stringify(
        await resolveAsyncImageTaskResponse(
          payload,
          new Request(
            process.env.NEXT_PUBLIC_APP_URL ||
              process.env.BETTER_AUTH_URL ||
              callbackUrl,
            { signal: controller.signal }
          )
        )
      ),
    });
    if (!response.ok) {
      logError(new Error(`Callback returned HTTP ${response.status}`), {
        source: "external-api-async-image-callback",
        taskId: payload.id,
        callbackUrl,
      });
    }
  } catch (error) {
    logError(error, {
      source: "external-api-async-image-callback",
      taskId: payload.id,
      callbackUrl,
    });
  } finally {
    clearTimeout(timeout);
  }
}
