/**
 * 池 API 上游的异步任务协议（兼容速度马 suduma）。
 *
 * 这类上游的图片接口只异步出图：POST /images/generations 或 /images/edits 受理后立即返回
 * {requestId, status}，图要几十秒才出；结果用 GET {baseUrl}/tasks/{requestId} 轮询，状态
 * processing / succeeded / failed，成功时图片在 data[].url。后端池成员在 metadata 打开
 * asyncTaskMode 后，service.ts 用本模块解析受理响应并轮询，出图、计费、退款流程不变。
 *
 * WHY 不轻易放弃：这类上游受理即扣费、失败才退，提前放弃等于付了钱却拿不到图。轮询对网络
 * 抖动、5xx、429 持续重试到截止时间；只有鉴权失败、任务不存在等确定性结果才立即结束。
 *
 * 本模块不直接发请求：查询由调用方注入（走同 origin 的 pinned HTTPS），便于单测。
 * 使用方：image-generation/service.ts。
 */

/** 默认轮询间隔：速度马建议 3～5 秒查一次。 */
export const UPSTREAM_TASK_POLL_INTERVAL_MS = 3_000;
/** 默认最长等待：与单次上游请求的 socket 超时一致。 */
export const UPSTREAM_TASK_TIMEOUT_MS = 20 * 60_000;
/** 查询连续出错时的最长退避间隔。 */
const UPSTREAM_TASK_MAX_BACKOFF_MS = 15_000;
/** 连续多少次无法识别的查询响应后放弃，避免对协议不符的上游空等 20 分钟。 */
const UPSTREAM_TASK_MAX_UNRECOGNIZED = 5;
/** 错误信息的长度上限。 */
const UPSTREAM_TASK_ERROR_MAX_CHARS = 500;

/**
 * 任务号拼进查询路径，只接受常见 ID 字符且不以点开头：
 * 排除 "/"、"?"、"#" 与 ".."，防止路径穿越到上游其他接口。
 */
const TASK_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._:-]{0,199}$/;

const PENDING_STATUSES = new Set([
  "created",
  "submitted",
  "queued",
  "pending",
  "processing",
  "running",
  "in_progress",
]);
const SUCCEEDED_STATUSES = new Set(["succeeded", "success", "completed"]);
const FAILED_STATUSES = new Set([
  "failed",
  "failure",
  "error",
  "canceled",
  "cancelled",
  "expired",
]);

export type UpstreamTaskImage = { url?: string; b64_json?: string };

export type UpstreamTaskState =
  | { status: "processing" }
  | { status: "succeeded"; images: UpstreamTaskImage[] }
  | { status: "failed"; error: string };

/**
 * 从受理响应中取任务号。
 *
 * @returns 合法任务号；响应不是对象、没有任务号字段或字段含非法字符时为 null
 */
export function readUpstreamTaskId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  for (const key of ["requestId", "request_id", "taskId", "task_id"]) {
    const value = record[key];
    if (typeof value === "string" && TASK_ID_PATTERN.test(value.trim())) {
      return value.trim();
    }
  }
  return null;
}

/** 取 data[] 中带地址或 base64 的图片项。 */
function readTaskImages(data: unknown): UpstreamTaskImage[] {
  if (!Array.isArray(data)) return [];
  const images: UpstreamTaskImage[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const image: UpstreamTaskImage = {};
    if (typeof record.url === "string" && record.url.trim()) {
      image.url = record.url.trim();
    }
    if (typeof record.b64_json === "string" && record.b64_json) {
      image.b64_json = record.b64_json;
    }
    if (image.url || image.b64_json) images.push(image);
  }
  return images;
}

/** 失败原因：error 可能是字符串或 {message}；压成单行并截断。 */
function readTaskError(value: unknown) {
  const message =
    typeof value === "string"
      ? value
      : value &&
          typeof value === "object" &&
          typeof (value as { message?: unknown }).message === "string"
        ? (value as { message: string }).message
        : "";
  return message
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, UPSTREAM_TASK_ERROR_MAX_CHARS);
}

/**
 * 解析一次任务查询的响应体。
 *
 * - succeeded 但没有图片：按失败处理，不再空轮询。
 * - 状态字段缺失或取值未知：返回 null，由调用方计入“无法识别”。
 */
export function parseUpstreamTaskState(
  payload: unknown
): UpstreamTaskState | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const status =
    typeof record.status === "string" ? record.status.trim().toLowerCase() : "";
  if (PENDING_STATUSES.has(status)) return { status: "processing" };
  if (SUCCEEDED_STATUSES.has(status)) {
    const images = readTaskImages(record.data);
    return images.length > 0
      ? { status: "succeeded", images }
      : { status: "failed", error: "task succeeded without image data" };
  }
  if (FAILED_STATUSES.has(status)) {
    return {
      status: "failed",
      error: readTaskError(record.error) || `task ${status}`,
    };
  }
  return null;
}

/**
 * 查询返回的 HTTP 状态是否为确定性失败：鉴权失败、任务不存在或请求非法时立即结束；
 * 408、425、429 与 5xx 视为暂时性，继续轮询。
 */
function isDefinitiveTaskHttpStatus(status: number) {
  return (
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 425 &&
    status !== 429
  );
}

/** 可被 signal 中断的等待；中断时以 signal.reason 拒绝，与 fetch 的取消语义一致。 */
function abortableSleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function describePollError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export type PollUpstreamTaskOptions = {
  taskId: string;
  /** 发起一次查询；调用方负责拼 URL、带鉴权并限定同 origin。 */
  fetchTask: (signal?: AbortSignal) => Promise<Response>;
  /** 把查询的 HTTP 错误转成与提交阶段一致的文案，使后端错误分类规则同样适用。 */
  formatHttpError: (response: Response, body: string) => string;
  signal?: AbortSignal;
  intervalMs?: number;
  timeoutMs?: number;
  /** 测试注入；默认可被 signal 中断的 setTimeout。 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
};

export type PollUpstreamTaskResult =
  | { images: UpstreamTaskImage[] }
  | { error: string };

/**
 * 轮询任务直到成功、失败或超时。每次先等待再查询：受理后立刻查询几乎必然仍在处理中。
 *
 * @returns 成功时为图片列表；任务失败、确定性 HTTP 错误、连续无法识别或超时时为 error
 * @throws signal 中断时抛出 signal.reason（与上游请求被取消时一致），由调用方按取消处理
 */
export async function pollUpstreamImageTask(
  options: PollUpstreamTaskOptions
): Promise<PollUpstreamTaskResult> {
  const interval = options.intervalMs ?? UPSTREAM_TASK_POLL_INTERVAL_MS;
  const timeout = options.timeoutMs ?? UPSTREAM_TASK_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const deadline = now() + timeout;
  let delay = interval;
  let unrecognized = 0;
  let lastPollError = "";

  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      const suffix = lastPollError
        ? ` (last poll error: ${lastPollError})`
        : "";
      return {
        error: `Upstream Images API task ${options.taskId} did not finish within ${Math.round(timeout / 1000)}s${suffix}`,
      };
    }
    await sleep(Math.min(delay, remaining), options.signal);

    let response: Response;
    try {
      response = await options.fetchTask(options.signal);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      lastPollError = describePollError(error).slice(
        0,
        UPSTREAM_TASK_ERROR_MAX_CHARS
      );
      delay = Math.min(delay * 2, UPSTREAM_TASK_MAX_BACKOFF_MS);
      continue;
    }

    const body = await response.text().catch(() => "");
    if (!response.ok) {
      const message = options.formatHttpError(response, body);
      if (isDefinitiveTaskHttpStatus(response.status))
        return { error: message };
      lastPollError = message.slice(0, UPSTREAM_TASK_ERROR_MAX_CHARS);
      delay = Math.min(delay * 2, UPSTREAM_TASK_MAX_BACKOFF_MS);
      continue;
    }

    let payload: unknown = null;
    try {
      payload = JSON.parse(body);
    } catch {
      payload = null;
    }
    const state = parseUpstreamTaskState(payload);
    if (!state) {
      unrecognized += 1;
      if (unrecognized >= UPSTREAM_TASK_MAX_UNRECOGNIZED) {
        return {
          error: `Upstream Images API task ${options.taskId} returned an unrecognized response`,
        };
      }
      delay = Math.min(delay * 2, UPSTREAM_TASK_MAX_BACKOFF_MS);
      continue;
    }

    // 查询恢复正常：重置退避，超时提示也不再引用之前的旧错误。
    unrecognized = 0;
    lastPollError = "";
    delay = interval;
    if (state.status === "succeeded") return { images: state.images };
    if (state.status === "failed") {
      return {
        error: `Upstream Images API task ${options.taskId} failed: ${state.error}`,
      };
    }
  }
}
