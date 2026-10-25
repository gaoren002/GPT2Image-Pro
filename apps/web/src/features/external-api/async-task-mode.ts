/**
 * 外部 API 的异步任务模式（兼容速度马 suduma 的提交与查询格式）。
 *
 * 开启方式二选一：API Key 打开 asyncTaskMode（该 Key 的生图/编辑一律异步），或单次请求
 * 传 async:"task"（multipart 或 URL 写 async=task）。提交后立即返回
 * {requestId, status:"processing"}；结果用 GET /v1/tasks/{requestId} 查询，状态只有
 * processing / succeeded / failed，成功时图片地址在 data[].url。
 *
 * 只改提交响应与查询格式：执行、扣费、失败退款沿用普通 async 的同一条管线。
 * 使用方：handlers/image-generations.ts、handlers/image-edits.ts、handlers/tasks.ts。
 * 本模块只含纯函数，不访问数据库或任务存储。
 */

/** async 参数的取值：普通异步，或任务模式。 */
export type AsyncParameter = "async" | "task";

/**
 * 解析单个 async 参数值。
 *
 * @returns true / "true" / "1" 为普通异步；"task" 为任务模式；其他（含 false、缺省）为 undefined
 */
export function parseAsyncParameter(
  value: unknown
): AsyncParameter | undefined {
  if (value === true) return "async";
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "task") return "task";
  if (normalized === "true" || normalized === "1") return "async";
  return undefined;
}

/**
 * 合并 Key 开关与请求参数，得出本次请求的异步方式。
 *
 * Key 开启任务模式时一律走任务模式：速度马的客户端提交时不带任何 async 参数，
 * 只换接口地址和密钥就要能用。请求参数只能开启异步，不能关闭 Key 级开关。
 *
 * @param params.values 请求里的 async 取值（JSON 字段、表单字段、URL 参数）
 */
export function resolveAsyncRequestMode(params: {
  keyTaskMode: boolean;
  values: readonly unknown[];
}) {
  const requested = params.values.map(parseAsyncParameter);
  const taskMode = params.keyTaskMode || requested.includes("task");
  return { taskMode, useAsync: taskMode || requested.includes("async") };
}

/** 提交受理后的立即响应，字段与速度马一致。 */
export function toAsyncTaskSubmission(requestId: string) {
  return { requestId, status: "processing" as const };
}

export type TaskModeStatus = "processing" | "succeeded" | "failed";

export type TaskModeResponse = {
  id: string;
  status: TaskModeStatus;
  progress: number;
  error: string;
  data: { type: "image"; url: string }[];
};

/** error 字段的长度上限，避免把上游整段错误正文回给客户端。 */
const TASK_ERROR_MAX_CHARS = 1000;

/** 兜底失败原因：管线没有给出具体原因时使用。 */
const TASK_FAILED_MESSAGE = "Image generation failed.";

/** 从任务载荷的 error（字符串或 {message}）中取单行信息。 */
function readTaskError(value: unknown) {
  const message =
    typeof value === "string"
      ? value
      : value &&
          typeof value === "object" &&
          typeof (value as { message?: unknown }).message === "string"
        ? (value as { message: string }).message
        : "";
  return message.replace(/\s+/g, " ").trim().slice(0, TASK_ERROR_MAX_CHARS);
}

/** 取 data[] 里的图片地址；只有 b64 时转成 data URI（纯中转没有站内存储）。 */
function readTaskImages(data: unknown): TaskModeResponse["data"] {
  if (!Array.isArray(data)) return [];
  const images: TaskModeResponse["data"] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const record = item as { url?: unknown; b64_json?: unknown };
    if (typeof record.url === "string" && record.url) {
      images.push({ type: "image", url: record.url });
    } else if (typeof record.b64_json === "string" && record.b64_json) {
      images.push({
        type: "image",
        url: `data:image/png;base64,${record.b64_json}`,
      });
    }
  }
  return images;
}

/**
 * 把内存异步任务映射为任务模式响应。
 *
 * - 处理中：progress 为 0。本站拿不到真实进度，速度马约定取不到时为 0。
 * - 有任意一张已交付的图：succeeded；批量中部分失败的原因放在 error。
 * - 其余终态：failed，error 为失败原因；费用已按失败结算退回。
 *
 * @param payload resolveAsyncImageTaskResponse 按 url 格式渲染的结果（含 status、data、error）
 */
export function toTaskModeResponse(
  id: string,
  payload: Record<string, unknown>
): TaskModeResponse {
  if (payload.status === "processing") {
    return { id, status: "processing", progress: 0, error: "", data: [] };
  }
  const data = readTaskImages(payload.data);
  const error = readTaskError(payload.error);
  if (data.length > 0) {
    return { id, status: "succeeded", progress: 100, error, data };
  }
  return {
    id,
    status: "failed",
    progress: 0,
    error: error || TASK_FAILED_MESSAGE,
    data: [],
  };
}

/**
 * 数据库回退：同步请求返回的 generation_id，或服务重启后已不在内存中的单张任务。
 *
 * @param imageUrl 已签名的站内图片地址；图片已按保留策略删除时为 null
 */
export function toGenerationTaskModeResponse(
  row: {
    id: string;
    status: "pending" | "completed" | "failed";
    error: string | null;
  },
  imageUrl: string | null
): TaskModeResponse {
  if (row.status === "pending") {
    return {
      id: row.id,
      status: "processing",
      progress: 0,
      error: "",
      data: [],
    };
  }
  if (row.status === "failed") {
    return {
      id: row.id,
      status: "failed",
      progress: 0,
      error: readTaskError(row.error) || TASK_FAILED_MESSAGE,
      data: [],
    };
  }
  return imageUrl
    ? {
        id: row.id,
        status: "succeeded",
        progress: 100,
        error: "",
        data: [{ type: "image", url: imageUrl }],
      }
    : {
        id: row.id,
        status: "succeeded",
        progress: 100,
        error: "Image is no longer available.",
        data: [],
      };
}
