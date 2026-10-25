/**
 * 图像后端"测活"：发起一次真实的最小生图请求，看上游是否真的返回图片。
 *
 * WHY 真实请求：仅探 `/models` 只能判断连通性与密钥，无法区分"接口通但出不了图"
 * （例如模型没有 image_generation 工具、只回文字）。本模块复用单次上游生图原语
 * `generateImage`，按后端自身的 interfaceMode/imagesUpstreamMode 走同一条出图路径。
 *
 * 副作用：`backend.reportResult=false` 时 `generateImage` 是纯上游调用——不计费、
 * 不落存储、不改成员 success/fail 统计；状态回写由调用方（service 的
 * probeImageBackendApi）自行完成。代价：每次测活会向上游真实消耗 1 张图的额度。
 *
 * 使用方：image-backend-pool 的后台 API 测活；settings 的用户自配 API 测活。
 */
import { isInvalidBackendCredentialError } from "./backend-credential-error";
import type { ApiConfig } from "@/features/image-generation/types";

import type {
  ChatCompletionsUpstreamMode,
  ImageBackendApiInterfaceMode,
  ImagesUpstreamMode,
} from "./types";

/**
 * 测活结果状态：
 * - `ok`：真实返回了图片。
 * - `no_image`：连接成功但没有图片（多为模型无图像工具/只回文字）。
 * - `auth_failed`：密钥被拒绝（401/403）。
 * - `error`：上游返回其他错误。
 * - `unreachable`：连接失败/超时/被取消。
 */
export type ImageApiHealthStatus =
  | "ok"
  | "no_image"
  | "auth_failed"
  | "error"
  | "unreachable";

/** 单次测活结果；message 只含固定分类文案，不含上游正文或异常原文。 */
export interface ImageApiHealthResult {
  ok: boolean;
  status: ImageApiHealthStatus;
  latencyMs: number;
  imageReturned: boolean;
  message: string;
}

/** 测活入参：足以构造与真实出图一致的上游路由。 */
export interface ImageApiHealthCheckInput {
  baseUrl: string;
  apiKey: string;
  model?: string | null;
  modelMapping?: ApiConfig["modelMapping"];
  useStream?: boolean;
  /** 池 API 异步任务模式：受理只回任务号的上游，测活同样轮询任务取图。 */
  asyncTaskMode?: boolean;
  apiInterfaceMode?: ImageBackendApiInterfaceMode;
  imagesUpstreamMode?: ImagesUpstreamMode;
  chatCompletionsUpstreamMode?: ChatCompletionsUpstreamMode;
  /** 后端类型：后台池成员用 "pool-api"，用户自配 API 用 "user-api"。 */
  backendType?: "pool-api" | "user-api";
  timeoutMs?: number;
  signal?: AbortSignal;
}

// 真实出图可能较慢（实测有可用后端需 45s+），给慢但可用的后端留足时间，
// 避免把"慢"误判成"不可用"。仍设上限防止挂死。
const DEFAULT_TIMEOUT_MS = 90_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 180_000;
const HEALTH_CHECK_PROMPT =
  "Health check: a small solid red circle centered on a plain white background.";

/** 把上游错误文本归类为非 ok 的测活状态（纯函数，便于单测）。 */
export function classifyImageHealthError(
  error: string
): Exclude<ImageApiHealthStatus, "ok"> {
  const n = error.toLowerCase();
  if (isInvalidBackendCredentialError(error)) return "auth_failed";
  if (
    n.includes("no image output") ||
    n.includes("no image data") ||
    n.includes("图像生成工具")
  ) {
    return "no_image";
  }
  if (
    n.includes("timeout") ||
    n.includes("timed out") ||
    n.includes("aborted") ||
    n.includes("fetch failed") ||
    n.includes("econnrefused") ||
    n.includes("enotfound") ||
    n.includes("terminated") ||
    n.includes("socket") ||
    n.includes("network")
  ) {
    return "unreachable";
  }
  return "error";
}

/** 把 generateImage 结果解释为测活结果（纯函数，便于单测）。 */
export function interpretImageHealthResult(
  result: {
    imageBase64?: string;
    imageUrl?: string;
    imageOutputs?: unknown[];
    error?: string;
  },
  latencyMs: number
): ImageApiHealthResult {
  const imageReturned = Boolean(
    result.imageBase64 ||
      result.imageUrl ||
      (result.imageOutputs && result.imageOutputs.length > 0)
  );
  if (imageReturned) {
    return {
      ok: true,
      status: "ok",
      latencyMs,
      imageReturned: true,
      message: "OK",
    };
  }
  if (result.error) {
    const status = classifyImageHealthError(result.error);
    return {
      ok: false,
      status,
      latencyMs,
      imageReturned: false,
      message: healthStatusMessage(status),
    };
  }
  return {
    ok: false,
    status: "no_image",
    latencyMs,
    imageReturned: false,
    message: "上游未返回图片数据",
  };
}

/** 管理端/用户端共用固定摘要，避免上游回显密钥和内部服务正文。 */
function healthStatusMessage(
  status: Exclude<ImageApiHealthStatus, "ok">
): string {
  return {
    no_image: "上游未返回图片数据",
    auth_failed: "上游拒绝凭据",
    unreachable: "无法连接上游或请求超时",
    error: "上游请求失败",
  }[status];
}

/**
 * 对一个图像后端执行真实出图测活。
 *
 * @param input 端点/密钥/接口模式等，足以复刻真实出图路由。
 * @returns 结构化测活结果；本函数不抛错——所有失败都映射为对应 status。
 * @remarks 纯上游调用（reportResult=false，无计费/存储/统计副作用）；会真实消耗
 *          上游 1 张图额度。带超时与外部取消。
 */
export async function checkImageBackendApiHealth(
  input: ImageApiHealthCheckInput
): Promise<ImageApiHealthResult> {
  // 异步上游先受理再出图，加上轮询间隔通常更慢，默认给到上限。
  const timeoutMs = Math.min(
    Math.max(
      input.timeoutMs ??
        (input.asyncTaskMode ? MAX_TIMEOUT_MS : DEFAULT_TIMEOUT_MS),
      MIN_TIMEOUT_MS
    ),
    MAX_TIMEOUT_MS
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (input.signal) {
    if (input.signal.aborted) controller.abort();
    else
      input.signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
  }

  const config: ApiConfig = {
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    model: input.model || undefined,
    modelMapping: input.modelMapping,
    useStream: input.useStream ?? false,
    backend: {
      type: input.backendType ?? "pool-api",
      requestKind: "image_generation",
      apiInterfaceMode: input.apiInterfaceMode,
      imagesUpstreamMode: input.imagesUpstreamMode,
      chatCompletionsUpstreamMode: input.chatCompletionsUpstreamMode,
      asyncTaskMode: input.asyncTaskMode === true,
      // 关键：关闭上报与租约，保证纯探测、无副作用。
      reportResult: false,
      inflightLease: false,
    },
  };

  const startedAt = Date.now();
  try {
    // 动态导入打破 image-backend-pool/service ⇄ image-generation/service 的静态环依赖。
    const { generateImage } = await import(
      "@/features/image-generation/service"
    );
    const result = await generateImage(config, {
      prompt: HEALTH_CHECK_PROMPT,
      size: "1024x1024",
      n: 1,
      signal: controller.signal,
    });
    return interpretImageHealthResult(result, Date.now() - startedAt);
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    if (controller.signal.aborted) {
      return {
        ok: false,
        status: "unreachable",
        latencyMs,
        imageReturned: false,
        message: `超时（${timeoutMs}ms）或已取消`,
      };
    }
    const message =
      error instanceof Error ? error.message : "Connection failed";
    const status = classifyImageHealthError(message);
    return {
      ok: false,
      status,
      latencyMs,
      imageReturned: false,
      message: healthStatusMessage(status),
    };
  } finally {
    clearTimeout(timer);
  }
}
