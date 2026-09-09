/** 图像与对话上游服务，供统一生成操作调用；负责模型校验、后端切换和协议构造。 */
import { db } from "@repo/database";
import { userApiConfig } from "@repo/database/schema";
import {
  GPT55_CHAT_MODEL,
  GPT6_ASTRA_CHAT_MODEL,
  isPremiumChatModel,
  isResponsesImageModel,
  RESPONSES_IMAGE_MODELS,
} from "@repo/shared/config/subscription-plan";
import {
  buildAdobeImageRequestBody,
  parseAdobeMediaResult,
} from "@repo/shared/adobe";
import { logError, logWarn } from "@repo/shared/logger";
import { canUsePlanCapability } from "@repo/shared/subscription/services/plan-capabilities";
import { getUserPlan } from "@repo/shared/subscription/services/user-plan";
import {
  getRuntimeSettingBoolean,
  getRuntimeSettingNumber,
  getRuntimeSettingString,
} from "@repo/shared/system-settings";
import { eq } from "drizzle-orm";
import { assertPublicApiBaseUrl } from "@/features/external-api/safe-image-fetch";
import { imageBackendApiUsesResponsesEndpoint } from "@/features/image-backend-pool/api-interface-mode";
import {
  acquireImageBackendInflight,
  bindImageBackendStickyMember,
  ImageBackendPoolUnavailableError,
  isImageBackendSwitchableError,
  isUnclassifiedBackendError,
  recordImageBackendSchedulerSwitch,
  releaseImageBackendInflightLease,
  reportImageBackendResult,
  resolveImageBackendPoolConfig,
} from "@/features/image-backend-pool/service";
import type {
  ImageBackendAccountBackend,
  ImageBackendPreferenceMode,
  ImageBackendRequestKind,
} from "@/features/image-backend-pool/types";
import { runAdobeDirectImageRequest } from "./adobe-direct";
import {
  pickAdobeFamilyFromModel,
  reverseFireflyToGptRequest,
} from "./adobe-sourced-firefly";
import {
  AGENT_CONTINUE_INSTRUCTIONS,
  createDefaultAgentAdditionalTools,
  DEFAULT_AGENT_IMAGE_ROUNDS,
  DEFAULT_RESPONSES_IMAGE_INSTRUCTIONS,
  LAYERED_CONTINUE_INSTRUCTIONS,
  LAYERED_RESPONSES_IMAGE_INSTRUCTIONS,
  ORIGINAL_PROMPT_RESPONSES_IMAGE_INSTRUCTIONS,
} from "./agent-tools";
import {
  chatWithChatGptWeb,
  editImageWithChatGptWeb,
  generateImageWithChatGptWeb,
} from "./chatgpt-web";
import {
  getInputImageUrl,
  isImageDownloadUpstreamError,
} from "./input-image-url";
import {
  appendImagesUpstreamNonce,
  buildOpenAIPromptCacheKey,
  buildPromptCacheSalt,
} from "./openai-prompt-cache";
import {
  normalizeImageBackground,
  normalizeOutputCompression,
  normalizeOutputFormat,
} from "./output-format";
import { ensureInputImageRehosted } from "./rehost-input-images";
import {
  AUTO_IMAGE_SIZE,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_SIZE,
  getImageModel,
  getImageModelForGroup,
  getUpstreamImageModel,
  isImageModel,
  normalizeImageModel,
  parseImageSize,
} from "./resolution";
import {
  buildResponsesImageEditRequest,
  buildResponsesImageGenerationRequest,
} from "./responses-image";
import {
  buildAgentContinuationInput,
  buildContinueGenerationFunctionCallItems,
  buildCurrentResponsesContent,
  buildGeneratedImageReferenceInstruction,
  buildPreviousResponseFallbackRequestBody,
  buildResponsesInput,
  buildResponsesStoreFalseFallbackRequestBody,
  getContinueGenerationFunctionCalls,
  getNextAssistantImageRoundIndex,
  isPreviousResponseStateError,
  isResponsesStoreUnsupportedError,
  type ResponsesRequestInputItem,
  resolvePromptImageReferences,
  resolveResponsesNativeState,
  shouldEnableResponsesPreviousResponse,
  withResponsesImageReferenceInstructions,
} from "./responses-native-state";
import { extractResponsesImageCallBase64 } from "./responses-output";
import {
  normalizeResponsesImageRequestBody,
  type ResponsesStreamRequestBody,
} from "./responses-request-normalizer";
import { extractResponsesTokenUsage } from "./responses-usage";
import { getCodexRetryAfterSeconds } from "./retry-metadata";
import type {
  AgentRunEvent,
  AgentRunEventStatus,
  ApiConfig,
  ChatImageParams,
  EditImageParams,
  GenerateImageParams,
  GenerateImageResult,
  ImageGenerationCallbacks,
  ImageInputFile,
  ImageModeration,
  ImageOutputFormat,
  ImageQuality,
  PartialImageResult,
  ThinkingLevel,
} from "./types";

const VALID_QUALITIES = new Set<ImageQuality>([
  "auto",
  "low",
  "medium",
  "high",
  // gpt-image-2.5（sunburst/flare）新增档位。
  "xhigh",
  "max",
]);
const VALID_MODERATION = new Set<ImageModeration>(["auto", "low"]);
const DEFAULT_RESPONSES_MODEL = GPT55_CHAT_MODEL;
const DEFAULT_CHAT_RESPONSES_IMAGE_INSTRUCTIONS =
  "You are a multimodal chat assistant. Use image_generation when the user asks for an image, edit, or visual output. Keep replies concise and preserve the conversation context.";
const ORIGINAL_PROMPT_CHAT_RESPONSES_IMAGE_INSTRUCTIONS =
  "You are a multimodal chat assistant. When calling image_generation, use the user's original image prompt exactly as written. Do not rewrite, expand, translate, polish, or optimize the latest user prompt before image generation.";

type ImageOutput = {
  b64_json?: string;
  url?: string;
  revised_prompt?: string;
  index?: number;
};

type ImageResponsePayload = {
  type?: string;
  data?: ImageOutput[];
  b64_json?: string;
  partial_image_b64?: string;
  url?: string;
  revised_prompt?: string;
  index?: number;
  partial_image_index?: number;
  error?: { message?: string } | string;
  message?: string;
};

type ResponsesOutputItem = {
  type?: string;
  id?: string;
  item_id?: string;
  output_item_id?: string;
  status?: string;
  role?: string;
  name?: string;
  action?: unknown;
  arguments?: string;
  call_id?: string;
  query?: string;
  results?: unknown;
  result?:
    | string
    | {
        b64_json?: unknown;
        base64?: unknown;
        image?: unknown;
        data?: unknown;
      };
  revised_prompt?: string;
  content?: Array<{
    type?: string;
    text?: string;
  }>;
  summary?: Array<{
    type?: string;
    text?: string;
  }>;
};

type ResponsesPayload = {
  id?: string;
  output?: ResponsesOutputItem[];
  error?: { message?: string } | string;
  message?: string;
  usage?: unknown;
};

type ResponsesResultWithOutput = GenerateImageResult & {
  responseId?: string;
  outputItems?: ResponsesOutputItem[];
  responsesStoreDisabledFallback?: boolean;
};

type ReasoningConfig = {
  effort: ThinkingLevel;
  summary?: "concise";
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** 解析已选分组的图片型号并映射 API 别名；非 Web 的非法型号仍在发送前拒绝。 */
function getModel(config: ApiConfig, model?: string) {
  const imageModel = getImageModelForGroup(
    model,
    config.model,
    config.backend?.groupBackendType
  );
  if (!imageModel) {
    throw new Error(
      "Unsupported model for image generation. Use a gpt-image-* model."
    );
  }
  return getUpstreamImageModel(imageModel);
}

function getHeaders(
  config: ApiConfig,
  defaults: Record<string, string>
): Record<string, string> {
  return {
    ...defaults,
    ...(config.headers || {}),
    Authorization: `Bearer ${config.apiKey}`,
  };
}

/** 校验文本模型目录和旗舰权限；隐式旧配置回落，显式非法选择抛出可读错误。 */
function normalizeResponsesModel(
  model: string,
  options?: { allowPremiumModels?: boolean },
  explicit = false
) {
  const requested = model.trim();
  if (!requested) return null;
  if (!isResponsesImageModel(requested)) {
    if (explicit) {
      throw new Error(
        `Unsupported chat model. Use ${RESPONSES_IMAGE_MODELS.join(", ")}.`
      );
    }
    return null;
  }
  if (isPremiumChatModel(requested) && !options?.allowPremiumModels) {
    if (explicit) {
      throw new Error("Premium chat models require Ultra plan.");
    }
    return null;
  }
  return requested;
}

function isPoolApiResponsesBackend(config: ApiConfig) {
  return (
    config.backend?.type === "pool-api" &&
    imageBackendApiUsesResponsesEndpoint(
      config.backend.apiInterfaceMode,
      config.backend.requestKind,
      config.backend.apiForceResponsesEndpoint,
      config.backend.imagesUpstreamMode
    )
  );
}

/** 解析 Responses 文本模型；所有后端先校验用户显式选择，再读取可用默认配置。 */
export async function getResponsesModel(
  config: ApiConfig,
  model?: string,
  options?: { allowPremiumModels?: boolean }
) {
  const requested = model?.trim();
  const poolApiResponsesBackend = isPoolApiResponsesBackend(config);
  if (requested && !(poolApiResponsesBackend && isImageModel(requested))) {
    const normalized = normalizeResponsesModel(requested, options, true);
    if (normalized) return normalized;
  }

  const configured = config.model?.trim();
  if (configured) {
    const normalized = normalizeResponsesModel(configured, options);
    if (normalized) return normalized;
    // 管理员的自定义 API 别名仍可作为后端默认；GPT 旧版和受限新版不能从此绕过权限。
    if (poolApiResponsesBackend && !configured.startsWith("gpt-")) {
      return configured;
    }
  }

  const fallbackModel =
    (await getRuntimeSettingString("PLATFORM_RESPONSES_MODEL")) ||
    (await getRuntimeSettingString("PLATFORM_CHAT_MODEL"));
  return (
    normalizeResponsesModel(fallbackModel || "", options) ||
    DEFAULT_RESPONSES_MODEL
  );
}

async function getDefaultImageGptModel(
  config: ApiConfig,
  options?: { allowPremiumModels?: boolean }
) {
  if (
    config.backend?.type !== "pool-account" &&
    !isPoolApiResponsesBackend(config)
  ) {
    return undefined;
  }
  return await getResponsesModel(config, undefined, options);
}

function getApiErrorMessage(errorData: unknown): string | null {
  if (typeof errorData === "string" && errorData.trim()) {
    return errorData.trim();
  }

  if (Array.isArray(errorData)) {
    const parts = errorData
      .map((item) => getApiErrorMessage(item))
      .filter((item): item is string => Boolean(item));
    return parts.length ? parts.join(" | ") : null;
  }

  if (
    errorData &&
    typeof errorData === "object" &&
    "error" in errorData &&
    errorData.error
  ) {
    const nested = getApiErrorMessage(errorData.error);
    if (nested) return nested;
  }

  if (
    errorData &&
    typeof errorData === "object" &&
    "response" in errorData &&
    errorData.response
  ) {
    const nested = getApiErrorMessage(errorData.response);
    if (nested) return nested;
  }

  if (errorData && typeof errorData === "object") {
    const record = errorData as Record<string, unknown>;
    const parts = [
      record.message,
      record.detail,
      record.details,
      record.code,
      record.type,
      record.status,
    ]
      .flatMap((value) => {
        if (typeof value === "string" && value.trim()) return [value.trim()];
        if (typeof value === "number" && Number.isFinite(value)) {
          return [String(value)];
        }
        const nested = getApiErrorMessage(value);
        return nested ? [nested] : [];
      })
      .filter(Boolean);
    if (parts.length) return parts.join(" | ");
  }

  return null;
}

function getApiError(errorData: unknown, fallback: string) {
  return getApiErrorMessage(errorData) || fallback;
}

function getHeaderValue(headers: Headers, names: string[]) {
  for (const name of names) {
    const value = headers.get(name);
    if (value?.trim()) return value.trim();
  }
  return null;
}

function parseRetryAfterHeader(value: string | null) {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const durationMs = parseDurationMs(value);
  if (durationMs) return Math.max(1, Math.ceil(durationMs / 1000));
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return Math.max(1, Math.ceil((date.getTime() - Date.now()) / 1000));
}

function parseDurationMs(value: string) {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  if (/^\d+(?:\.\d+)?\s*ms$/.test(trimmed)) {
    return Number.parseFloat(trimmed) || null;
  }
  if (/^\d+(?:\.\d+)?\s*s$/.test(trimmed)) {
    return Number.parseFloat(trimmed) * 1000;
  }
  if (/^\d+(?:\.\d+)?\s*m$/.test(trimmed)) {
    return Number.parseFloat(trimmed) * 60_000;
  }
  if (/^\d+(?:\.\d+)?\s*h$/.test(trimmed)) {
    return Number.parseFloat(trimmed) * 60 * 60_000;
  }
  if (/^\d+(?:\.\d+)?\s*d(?:ay|ays)?$/.test(trimmed)) {
    return Number.parseFloat(trimmed) * 24 * 60 * 60_000;
  }
  const parts = [
    ...trimmed.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|day|days)/g),
  ];
  if (!parts.length) return null;
  const total = parts.reduce((sum, match) => {
    const amount = Number.parseFloat(match[1] || "0");
    const unit = match[2];
    if (unit === "ms") return sum + amount;
    if (unit === "s") return sum + amount * 1000;
    if (unit === "m") return sum + amount * 60_000;
    if (unit === "h") return sum + amount * 60 * 60_000;
    if (unit === "d" || unit === "day" || unit === "days") {
      return sum + amount * 24 * 60 * 60_000;
    }
    return sum;
  }, 0);
  return total > 0 ? total : null;
}

function getResponseRetryMetadata(response: Response) {
  const retryAfterSeconds = parseRetryAfterHeader(
    getHeaderValue(response.headers, ["retry-after"])
  );
  const upstreamResetAt = getHeaderValue(response.headers, [
    "x-ratelimit-reset",
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset-tokens",
    "x-ratelimit-reset-images",
    "x-ratelimit-reset-image-requests",
    "x-ratelimit-reset-input-tokens",
    "x-ratelimit-reset-output-tokens",
  ]);
  const codexResetAfterSeconds = getCodexRetryAfterSeconds(response.headers);
  return {
    upstreamResetAt: upstreamResetAt || undefined,
    retryAfterSeconds:
      Math.max(retryAfterSeconds || 0, codexResetAfterSeconds || 0) ||
      undefined,
  };
}

function extractPayloadRetryMetadata(payload: unknown): {
  upstreamResetAt?: string;
  retryAfterSeconds?: number;
} {
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const metadata = extractPayloadRetryMetadata(item);
      if (metadata.upstreamResetAt || metadata.retryAfterSeconds) {
        return metadata;
      }
    }
    return {};
  }
  if (!payload || typeof payload !== "object") return {};
  const record = payload as Record<string, unknown>;
  const nested = [
    record.error,
    record.response,
    record.details,
    record.metadata,
    record.payload,
    record.data,
  ];
  const keys = [
    "resetAt",
    "reset_at",
    "resetAfter",
    "reset_after",
    "reset_after_seconds",
    "resetsAt",
    "resets_at",
    "resetsInSeconds",
    "resets_in_seconds",
    "restore_at",
    "restoreAt",
    "restoreAfter",
    "restore_after",
    "quotaResetDelay",
    "retry_at",
    "upstreamResetAt",
    "upstream_reset_at",
  ];
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      if (
        /after$/i.test(key) ||
        /seconds$/i.test(key) ||
        key === "quotaResetDelay"
      ) {
        const parsed = parseRetryAfterHeader(value.trim());
        if (parsed) return { retryAfterSeconds: parsed };
      }
      return { upstreamResetAt: value.trim() };
    }
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      if (
        /after$/i.test(key) ||
        /seconds$/i.test(key) ||
        key === "quotaResetDelay"
      ) {
        return { retryAfterSeconds: value };
      }
      return { upstreamResetAt: String(value) };
    }
  }
  const retryAfter = record.retry_after ?? record.retryAfter;
  if (
    typeof retryAfter === "number" &&
    Number.isFinite(retryAfter) &&
    retryAfter > 0
  ) {
    return { retryAfterSeconds: retryAfter };
  }
  if (typeof retryAfter === "string" && retryAfter.trim()) {
    const parsed = parseRetryAfterHeader(retryAfter.trim());
    if (parsed) return { retryAfterSeconds: parsed };
  }
  for (const value of nested) {
    const metadata = extractPayloadRetryMetadata(value);
    if (metadata.upstreamResetAt || metadata.retryAfterSeconds) return metadata;
  }
  return {};
}

function withRetryMetadata<T extends GenerateImageResult>(
  result: T,
  metadata: { upstreamResetAt?: string; retryAfterSeconds?: number }
): T {
  if (!metadata.upstreamResetAt && !metadata.retryAfterSeconds) return result;
  return {
    ...result,
    upstreamResetAt: result.upstreamResetAt || metadata.upstreamResetAt,
    retryAfterSeconds: result.retryAfterSeconds ?? metadata.retryAfterSeconds,
  } as T;
}

function safeParseJson(value: string) {
  if (!value.trim()) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function truncateResponseBody(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

function getHttpErrorMessage(
  response: Response,
  rawBody: string,
  apiName: "Images API" | "Responses API" | "Adobe Firefly API"
) {
  const fallback = `Upstream ${apiName} returned HTTP ${response.status}`;
  const trimmedBody = truncateResponseBody(rawBody);

  if (!trimmedBody) return fallback;
  if (trimmedBody.startsWith("<")) {
    return `${fallback}: HTML response body. Check that the API base URL points to an OpenAI-compatible /v1 endpoint.`;
  }

  let errorData: unknown = trimmedBody;
  try {
    errorData = JSON.parse(rawBody);
  } catch {
    return `${fallback}: ${trimmedBody}`;
  }

  const apiError = getApiErrorMessage(errorData);
  return apiError ? `${fallback}: ${apiError}` : `${fallback}: ${trimmedBody}`;
}

function getNonJsonErrorMessage(
  rawBody: string,
  apiName: "Images API" | "Responses API",
  response?: Response
) {
  const trimmedBody = truncateResponseBody(rawBody);
  const statusText = response
    ? `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`
    : null;
  const contentType = response?.headers.get("content-type") || "";
  const context = [statusText, contentType ? `content-type=${contentType}` : ""]
    .filter(Boolean)
    .join(", ");
  const suffix = context ? ` (${context})` : "";
  if (trimmedBody.startsWith("<")) {
    return `API returned an HTML page instead of a ${apiName} response${suffix}. Check that the API base URL points to an OpenAI-compatible /v1 endpoint.`;
  }
  if (!trimmedBody)
    return `API returned an empty non-JSON ${apiName} response${suffix}.`;
  return `API returned a non-JSON ${apiName} response${suffix}: ${trimmedBody}`;
}

function looksLikeEventStreamText(text: string) {
  return /(?:^|\n)(?:event|data):/.test(text.replace(/\r\n/g, "\n"));
}

function tryParseJsonPayloadError(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
    return null;
  }
  return getPayloadError(safeParseJson(trimmed));
}

function withStreamJsonErrorFallback<T extends { error?: string }>(
  result: T,
  rawText: string
): T {
  if (result.error !== "API returned no image data") return result;
  const jsonError = tryParseJsonPayloadError(rawText);
  return jsonError ? ({ ...result, error: jsonError } as T) : result;
}

function normalizeQuality(quality?: string): ImageQuality | undefined {
  if (!quality || quality === "auto") return undefined;
  return VALID_QUALITIES.has(quality as ImageQuality)
    ? (quality as ImageQuality)
    : undefined;
}

function normalizeModeration(moderation?: string): ImageModeration | undefined {
  if (!moderation) return undefined;
  return VALID_MODERATION.has(moderation as ImageModeration)
    ? (moderation as ImageModeration)
    : undefined;
}

function normalizeThinking(
  thinking?: string,
  model?: string
): ThinkingLevel | undefined {
  if (
    model === GPT6_ASTRA_CHAT_MODEL &&
    (thinking === "none" || thinking === "minimal")
  ) {
    return "low";
  }
  if (
    thinking === "minimal" ||
    thinking === "none" ||
    thinking === "low" ||
    thinking === "medium" ||
    thinking === "high" ||
    thinking === "xhigh"
  ) {
    return thinking;
  }

  return undefined;
}

function describeEndpoint(baseUrl: string, path: string) {
  try {
    const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    return `${url.origin}${url.pathname}`;
  } catch {
    return `${baseUrl.replace(/\/$/, "")}${path}`;
  }
}

function logImageRequestError(
  error: unknown,
  context: {
    operation: "generate" | "edit" | "chat";
    baseUrl: string;
    path: string;
    model?: string;
    useStream?: boolean;
  }
) {
  logError(error, {
    source: "image-generation",
    operation: context.operation,
    endpoint: describeEndpoint(context.baseUrl, context.path),
    model: context.model,
    useStream: Boolean(context.useStream),
  });
}

function toBlobPart(buffer: Buffer): BlobPart {
  const arrayBuffer = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(arrayBuffer).set(buffer);
  return arrayBuffer;
}

function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function responseToolCacheSignature(params: {
  tool: Record<string, unknown>;
  additionalTools?: Record<string, unknown>[];
}) {
  return JSON.stringify({
    imageTool: {
      type: params.tool.type,
      action: params.tool.action,
      model: params.tool.model,
      size: params.tool.size,
      quality: params.tool.quality,
      moderation: params.tool.moderation,
      output_format: params.tool.output_format,
      output_compression: params.tool.output_compression,
      background: params.tool.background,
    },
    additionalTools: (params.additionalTools || []).map((tool) => ({
      type: tool.type,
      name: tool.name,
    })),
  });
}

function isPoolAccountBackend(
  config: ApiConfig,
  accountBackend: "web" | "responses"
) {
  return (
    config.backend?.type === "pool-account" &&
    config.backend.accountBackend === accountBackend
  );
}

function isResponsesBackend(config: ApiConfig) {
  if (isPoolAccountBackend(config, "responses")) return true;
  return isPoolApiResponsesBackend(config);
}

// codex(pool-account "responses")后端的普通生成/图生图走直连 images 端点
// (generateImage → JSON /images/generations;editImage → JSON /images/edits,照 CPA
// codex 直连格式:images[].image_url 的 base64 data URL + size 顶层),而非 /responses
// 的 image_generation 工具。
// WHY 仍走直连端点:codex 托管 image_generation 工具的工具循环/多轮语义对单张生图是多余
// 开销,直连端点用【同一账号、同一 OAuth 凭据、同一 baseUrl】只改 path/body,请求更简单、
// 标准字段对齐 gpt-image。codex images 端点用 JSON(不接受 multipart→400 Unsupported
// content type),也不认非标准 width/height 与 response_format,故两条直连路径都按 CPA
// 格式只发标准字段。
// 注意 size 仍不可靠:codex 托管图像工具不尊重 size(openai/codex #19175),而 CLIProxyAPI
// 的 direct image API 只是把请求转成同一个工具,所以【直连 images 端点照样忽略顶层 size】——
// 我方虽确发了 size,codex 仍按提示词内容自挑长宽比。生产实测:本组 1024x1024 请求约 40%
// 返回非方正、70%+ 返回任意非 1024 尺寸(2026-06 审计)。要精确尺寸须避开 codex 组改用真
// gpt-image 后端,或出图后服务端裁剪兜底;别再以为换到直连端点 size 就被尊重。
// chat/agent/瀑布流依赖工具循环与多轮,仍走 /responses。仅作用于 codex 账号
// (pool-account responses);pool-api 的 responses 后端不受影响。
function shouldCodexUseDirectImagesEndpoint(config: ApiConfig) {
  return isPoolAccountBackend(config, "responses");
}

function isResponsesImageToolChoiceMismatch(error?: string | null) {
  const normalized = (error || "").toLowerCase();
  return (
    Boolean(normalized) &&
    (normalized.includes("tool_choice") ||
      normalized.includes("tool choice")) &&
    normalized.includes("image_generation") &&
    normalized.includes("not found")
  );
}

async function postResponsesImageRequest(
  config: ApiConfig,
  requestBody: unknown,
  params: {
    signal?: AbortSignal;
  },
  callbacks?: ImageGenerationCallbacks
) {
  const response = await fetch(
    `${stripTrailingSlash(config.baseUrl)}/responses`,
    {
      method: "POST",
      redirect: "manual",
      signal: params.signal,
      cache: "no-store",
      headers: getHeaders(config, {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "Accept-Encoding": "identity",
        "Cache-Control": "no-cache",
      }),
      body: JSON.stringify(requestBody),
    }
  );
  return await parseResponsesResponse(response, callbacks, {
    preferEventStream: true,
  });
}

async function postResponsesImageRequestWithToolChoiceFallback(
  config: ApiConfig,
  requestBody: Record<string, unknown>,
  params: {
    signal?: AbortSignal;
  },
  callbacks?: ImageGenerationCallbacks
) {
  const result = await postResponsesImageRequest(
    config,
    requestBody,
    params,
    callbacks
  );
  if (!isResponsesImageToolChoiceMismatch(result.error)) {
    return result;
  }

  const fallbackBody = { ...requestBody };
  delete fallbackBody.tool_choice;
  return await postResponsesImageRequest(
    config,
    fallbackBody,
    params,
    callbacks
  );
}

async function reportPoolBackendResult(
  config: ApiConfig,
  result: GenerateImageResult,
  durationMs?: number
): Promise<boolean> {
  if (!config.backend?.reportResult) return false;
  if (
    config.backend.type !== "pool-api" &&
    config.backend.type !== "pool-account" &&
    config.backend.type !== "pool-adobe"
  ) {
    return false;
  }
  try {
    const outcome = await reportImageBackendResult({
      memberType: poolBackendMemberType(config.backend.type),
      memberId: config.backend.id,
      success: !result.error,
      error: result.error,
      upstreamResetAt: result.upstreamResetAt,
      retryAfterSeconds: result.retryAfterSeconds,
      durationMs,
    });
    return outcome.switchable;
  } catch (error) {
    logError(error, {
      source: "image-backend-pool",
      operation: "report-result",
      backendType: config.backend.type,
      backendId: config.backend.id,
    });
  }
  return false;
}

function poolBackendMemberKey(config: ApiConfig) {
  if (
    config.backend?.type !== "pool-api" &&
    config.backend?.type !== "pool-account"
  ) {
    return null;
  }
  if (!config.backend.id) return null;
  return `${poolBackendMemberType(config.backend.type)}:${config.backend.id}`;
}

function getStickyBackendMember(config: ApiConfig) {
  const backend = config.backend;
  if (
    !backend?.id ||
    (backend.type !== "pool-api" && backend.type !== "pool-account")
  ) {
    return undefined;
  }
  return {
    type: poolBackendMemberType(backend.type),
    id: backend.id,
    groupId: backend.groupId,
    accountBackend: backend.accountBackend,
  };
}

function attachStickyBackendMember(
  config: ApiConfig,
  result: GenerateImageResult
): GenerateImageResult {
  if (result.error) return result;
  const backendMember = getStickyBackendMember(config);
  if (!backendMember) return result;
  return {
    ...result,
    backendMember,
  };
}

function attachResponsesPreviousResponseState(
  config: ApiConfig,
  result: ResponsesResultWithOutput,
  enabled: boolean
): ResponsesResultWithOutput {
  const { responsesStoreDisabledFallback, ...publicResult } = result;
  if (
    !enabled ||
    responsesStoreDisabledFallback ||
    publicResult.error ||
    !publicResult.responseId
  ) {
    return publicResult;
  }
  const backendMember = getStickyBackendMember(config);
  if (!backendMember || backendMember.accountBackend !== "responses") {
    return publicResult;
  }
  return {
    ...publicResult,
    responsesPreviousResponse: {
      responseId: publicResult.responseId,
      backendMember,
      store: true,
      createdAt: new Date().toISOString(),
    },
  };
}

async function fetchResponsesWithPreviousResponseFallback(
  config: ApiConfig,
  requestBody: ResponsesStreamRequestBody,
  fallbackInput: ResponsesRequestInputItem[],
  options: {
    signal?: AbortSignal;
    stream: boolean;
    previousResponseUsed: boolean;
  },
  callbacks?: ImageGenerationCallbacks
) {
  const result = await fetchResponses(
    config,
    requestBody,
    {
      signal: options.signal,
      stream: options.stream,
    },
    callbacks
  );
  if (result.error && isResponsesStoreUnsupportedError(result.error)) {
    const fallbackResult = await fetchResponses(
      config,
      {
        ...buildResponsesStoreFalseFallbackRequestBody(requestBody),
        input: fallbackInput,
      },
      {
        signal: options.signal,
        stream: options.stream,
      },
      callbacks
    );
    return {
      ...fallbackResult,
      responsesStoreDisabledFallback: true,
    };
  }
  if (
    !options.previousResponseUsed ||
    !result.error ||
    !isPreviousResponseStateError(result.error)
  ) {
    return result;
  }
  const previousResponseFallbackBody = buildPreviousResponseFallbackRequestBody(
    requestBody,
    fallbackInput
  );
  const previousResponseFallbackResult = await fetchResponses(
    config,
    previousResponseFallbackBody,
    {
      signal: options.signal,
      stream: options.stream,
    },
    callbacks
  );
  if (
    previousResponseFallbackResult.error &&
    isResponsesStoreUnsupportedError(previousResponseFallbackResult.error)
  ) {
    const storeFalseResult = await fetchResponses(
      config,
      buildResponsesStoreFalseFallbackRequestBody(previousResponseFallbackBody),
      {
        signal: options.signal,
        stream: options.stream,
      },
      callbacks
    );
    return {
      ...storeFalseResult,
      responsesStoreDisabledFallback: true,
    };
  }
  return previousResponseFallbackResult;
}

// 未知(未被任何分类记录)错误允许的最大切换次数：这类错误疑似平台问题，给
// 有限次换后端机会兜底新形态错误，同时防止真终态错误在大池子里无限放大。
const MAX_UNCLASSIFIED_ERROR_SWITCHES = 3;
const DEFAULT_MAX_POOL_BACKEND_ATTEMPTS = 8;
const DEFAULT_MAX_NO_IMAGE_OUTPUT_ATTEMPTS = 3;

function isNoImageOutputError(error?: string | null) {
  const normalized = (error || "").toLowerCase();
  return (
    normalized.includes("no image output") ||
    normalized.includes("no image data") ||
    normalized.includes("no downloadable image")
  );
}

// firefly-* / force_firefly 请求只允许落 Adobe：pool-adobe 直连,或上游即 Adobe 的
// adobe_sourced pool-api。换号重试时据此约束目标,防止按 Adobe 计费的请求漂到非 Adobe。
function isAdobeRoutedBackend(backend: ApiConfig["backend"]): boolean {
  if (!backend) return false;
  return (
    backend.type === "pool-adobe" ||
    (backend.type === "pool-api" && backend.adobeSourced === true)
  );
}

async function retryPoolBackendResult(
  config: ApiConfig,
  run: (candidate: ApiConfig) => Promise<GenerateImageResult>,
  options?: {
    mixWebFirst?: boolean;
    accountBackendPreference?: ImageBackendAccountBackend;
    accountBackendPreferenceMode?: ImageBackendPreferenceMode;
    allowAnyResponsesBackend?: boolean;
  }
) {
  // 仅"不需要上报"的后端直接跑一次返回。pool-adobe 等带 reportResult 的池后端必须进入
  // 下方主循环(跑一次→上报→释放租约→因非 api/account 而 break 不切换);若在此提前
  // return run(config),config 仍带 reportResult=true,generateImage 会再次进入本函数,
  // 形成同步无限递归(Maximum call stack size exceeded)。
  if (!config.backend?.reportResult) {
    return run(config);
  }

  const requestKind = config.backend.requestKind;
  // firefly 意图(解析时盖在 config 上,反映请求口径而非后端类型)。换号 re-resolve 时强制
  // forceFirefly 以保持「只走 Adobe」,并对换号结果做不变量校验兜底。
  const fireflyRequest = config.backend.fireflyOnly === true;
  const excluded = new Set<string>();
  let accountBackendPreference: ImageBackendAccountBackend | undefined =
    options?.accountBackendPreference ||
    (options?.mixWebFirst ? "web" : undefined);
  let candidate = config;
  let lastResult: GenerateImageResult | null = null;
  let attempt = 0;
  let unclassifiedErrorSwitches = 0;
  let noImageOutputAttempts = 0;
  const backendAttempts: NonNullable<GenerateImageResult["backendAttempts"]> =
    [];
  const [configuredMaxAttempts, configuredMaxNoImageOutputAttempts] =
    await Promise.all([
      getRuntimeSettingNumber(
        "IMAGE_BACKEND_MAX_ATTEMPTS",
        DEFAULT_MAX_POOL_BACKEND_ATTEMPTS,
        { positive: true }
      ),
      getRuntimeSettingNumber(
        "IMAGE_BACKEND_MAX_NO_IMAGE_OUTPUT_ATTEMPTS",
        DEFAULT_MAX_NO_IMAGE_OUTPUT_ATTEMPTS,
        { positive: true }
      ),
    ]);
  const maxAttempts = Math.max(1, Math.floor(configuredMaxAttempts));
  const maxNoImageOutputAttempts = Math.max(
    1,
    Math.floor(configuredMaxNoImageOutputAttempts)
  );
  const withAttemptDiagnostics = (result: GenerateImageResult) => ({
    ...result,
    backendAttempts,
  });
  const shouldFallbackFromWebPreference = () =>
    accountBackendPreference === "web" &&
    (options?.mixWebFirst || options?.accountBackendPreference === "web") &&
    // web→codex 回退仅在【混合分组】生效:纯 web / 纯 codex 分组各自闭环,web 耗尽即止于
    // web,不跨车道回退(目标分组 backendType 在解析时盖在 config.backend 上)。
    config.backend?.groupBackendType === "mixed";
  const resolveResponsesFallback = async (lastError?: string) => {
    logWarn("混合分组 Web 优先阶段已无可用账号，切换 Codex", {
      attempt,
      requestKind,
      excludedCount: excluded.size,
      lastError,
    });
    accountBackendPreference = "responses";
    try {
      return await resolveImageBackendPoolConfig({
        userId: config.backend?.userId || "",
        apiKeyId: config.backend?.apiKeyId,
        requestKind: requestKind as ImageBackendRequestKind,
        excludedMemberKeys: Array.from(excluded),
        accountBackendPreference,
        accountBackendPreferenceMode: options?.accountBackendPreferenceMode,
        allowAnyResponsesBackend: options?.allowAnyResponsesBackend,
        forceFirefly: fireflyRequest,
      });
    } catch (fallbackError) {
      if (fallbackError instanceof ImageBackendPoolUnavailableError) {
        logWarn("生图后端没有可切换的账号池成员", {
          attempt,
          requestKind,
          excludedCount: excluded.size,
          lastError,
        });
        return null;
      }
      throw fallbackError;
    }
  };

  while (true) {
    attempt += 1;
    let result: GenerateImageResult;
    const startedAt = Date.now();
    const currentBackend = candidate.backend;
    const hasPoolBackend =
      currentBackend?.type === "pool-api" ||
      currentBackend?.type === "pool-account" ||
      currentBackend?.type === "pool-adobe";
    const acquiredBeforeRun =
      hasPoolBackend && currentBackend.inflightLease !== true;
    if (acquiredBeforeRun) {
      acquireImageBackendInflight({
        memberType: poolBackendMemberType(currentBackend.type),
        memberId: currentBackend.id,
      });
    }
    try {
      result = await run(withoutPoolBackendReport(candidate));
    } finally {
      if (hasPoolBackend) {
        await releaseImageBackendInflightLease({
          memberType: poolBackendMemberType(currentBackend.type),
          memberId: currentBackend.id,
          leaseId: currentBackend.inflightLeaseId,
          leasePersisted: currentBackend.inflightLeasePersisted,
        });
        currentBackend.inflightLease = false;
      }
    }
    const durationMs = Date.now() - startedAt;
    const shouldRetry = await reportPoolBackendResult(
      candidate,
      result,
      durationMs
    );
    backendAttempts.push({
      attempt,
      backendType: currentBackend?.type,
      backendId: currentBackend?.id,
      accountBackend: currentBackend?.accountBackend,
      durationMs,
      ...(result.error ? { error: result.error.slice(0, 500) } : {}),
    });
    if (isNoImageOutputError(result.error)) noImageOutputAttempts += 1;
    lastResult = result;

    // 未被任何分类记录的未知错误：白名单制下默认不可切换，但首次出现的新
    // 形态平台错误不应当场砸在用户头上，允许有限次切换后端兜底。
    const unclassifiedRetry =
      unclassifiedErrorSwitches < MAX_UNCLASSIFIED_ERROR_SWITCHES &&
      isUnclassifiedBackendError(result.error);

    if (
      !result.error ||
      !(
        shouldRetry ||
        isImageBackendSwitchableError(result.error) ||
        unclassifiedRetry
      )
    ) {
      return withAttemptDiagnostics(
        attachStickyBackendMember(candidate, result)
      );
    }
    if (unclassifiedRetry) unclassifiedErrorSwitches += 1;

    const retryLimitReason =
      attempt >= maxAttempts
        ? "max_attempts"
        : noImageOutputAttempts >= maxNoImageOutputAttempts
          ? "max_no_image_output_attempts"
          : null;
    if (retryLimitReason) {
      logWarn("生图后端重试达到上限，停止切换账号池成员", {
        attempt,
        requestKind,
        backendType: currentBackend?.type,
        backendId: currentBackend?.id,
        error: result.error,
        retryLimitReason,
        maxAttempts,
        noImageOutputAttempts,
        maxNoImageOutputAttempts,
      });
      return withAttemptDiagnostics(
        attachStickyBackendMember(candidate, result)
      );
    }

    const memberKey = poolBackendMemberKey(candidate);
    if (memberKey) excluded.add(memberKey);
    if (!requestKind || !config.backend.userId) break;
    const backend = candidate.backend;
    if (
      !backend ||
      (backend.type !== "pool-api" && backend.type !== "pool-account")
    ) {
      break;
    }

    logWarn("生图后端可重试错误，准备切换账号池成员", {
      attempt,
      requestKind,
      backendType: backend.type,
      backendId: backend.id,
      groupId: backend.groupId,
      error: result.error,
      unclassifiedRetry,
      unclassifiedErrorSwitches,
    });

    let next: Awaited<ReturnType<typeof resolveImageBackendPoolConfig>>;
    try {
      next = await resolveImageBackendPoolConfig({
        userId: config.backend.userId,
        apiKeyId: config.backend.apiKeyId,
        requestKind,
        excludedMemberKeys: Array.from(excluded),
        accountBackendPreference,
        accountBackendPreferenceMode: options?.accountBackendPreferenceMode,
        allowAnyResponsesBackend: options?.allowAnyResponsesBackend,
        forceFirefly: fireflyRequest,
      });
    } catch (error) {
      if (error instanceof ImageBackendPoolUnavailableError) {
        if (shouldFallbackFromWebPreference()) {
          next = await resolveResponsesFallback(result.error);
          if (!next?.config?.backend) break;
        } else {
          logWarn("生图后端没有可切换的账号池成员", {
            attempt,
            requestKind,
            excludedCount: excluded.size,
            lastError: result.error,
          });
          break;
        }
      } else {
        throw error;
      }
    }
    if (!next?.config?.backend && shouldFallbackFromWebPreference()) {
      next = await resolveResponsesFallback(result.error);
    }
    if (!next?.config?.backend) break;
    // 不变量兜底:firefly 请求的换号目标必须仍是 Adobe 路由(pool-adobe 或 adobe_sourced
    // api)。正常已由上面的 forceFirefly 约束保证;此处 fail-closed 拦截任何未来回归,宁可
    // 不换号失败,也不让按 Adobe 计费的请求落到非 Adobe 后端。
    if (fireflyRequest && !isAdobeRoutedBackend(next.config.backend)) {
      await releaseImageBackendInflightLease({
        memberType: poolBackendMemberType(next.config.backend.type),
        memberId: next.config.backend.id,
        leaseId: next.config.backend.inflightLeaseId,
        leasePersisted: next.config.backend.inflightLeasePersisted,
      });
      next.config.backend.inflightLease = false;
      logError(new Error("firefly 请求换号命中非 Adobe 后端，已阻断"), {
        source: "image-backend-pool",
        operation: "firefly-retry-guard",
        requestKind,
        nextBackendType: next.config.backend.type,
        nextBackendId: next.config.backend.id,
      });
      break;
    }
    if (poolBackendMemberKey(next.config) === memberKey) {
      await releaseImageBackendInflightLease({
        memberType: poolBackendMemberType(next.config.backend.type),
        memberId: next.config.backend.id,
        leaseId: next.config.backend.inflightLeaseId,
        leasePersisted: next.config.backend.inflightLeasePersisted,
      });
      next.config.backend.inflightLease = false;
      logWarn("生图后端重试选回同一成员，停止切换", {
        requestKind,
        memberKey,
        lastError: result.error,
      });
      break;
    }
    logWarn("生图后端已切换账号池成员重试", {
      nextAttempt: attempt + 1,
      requestKind,
      previousMemberKey: memberKey,
      nextBackendType: next.config.backend.type,
      nextBackendId: next.config.backend.id,
      nextGroupId: next.config.backend.groupId,
      excludedCount: excluded.size,
    });
    await recordImageBackendSchedulerSwitch({
      requestKind,
      memberType: poolBackendMemberType(next.config.backend.type),
      memberId: next.config.backend.id,
      groupId: next.config.backend.groupId,
    });
    candidate = next.config;
  }

  if (lastResult) return withAttemptDiagnostics(lastResult);
  return attachStickyBackendMember(
    config,
    await run(withoutPoolBackendReport(config))
  );
}

function withoutPoolBackendReport(config: ApiConfig): ApiConfig {
  if (!config.backend) return config;
  return {
    ...config,
    backend: {
      ...config.backend,
      reportResult: false,
    },
  };
}

function applyPromptOptimizationResultVisibility(
  result: GenerateImageResult
): GenerateImageResult {
  if (result.error) return result;
  const upstreamRevisedPrompt =
    result.upstreamRevisedPrompt || result.revisedPrompt;
  if (!upstreamRevisedPrompt) return result;

  return {
    ...result,
    revisedPrompt: result.revisedPrompt || upstreamRevisedPrompt,
    upstreamRevisedPrompt,
  };
}

const MISSING_IMAGE_OUTPUT_ERROR = "Upstream returned no image output";

function hasRequiredImageOutput(result: GenerateImageResult) {
  return Boolean(
    result.imageBase64 ||
      result.imageUrl ||
      result.imageOutputs?.some((item) => item.imageBase64 || item.imageUrl)
  );
}

function compactMissingImageDetail(result: GenerateImageResult) {
  const detail = (result.responseText || result.responseAgent || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!detail) return "";
  return detail.length > 500 ? `${detail.slice(0, 500)}...` : detail;
}

function requireImageOutput(result: GenerateImageResult): GenerateImageResult {
  if (result.error || hasRequiredImageOutput(result)) return result;
  const detail = compactMissingImageDetail(result);
  return {
    ...result,
    error: detail
      ? `${MISSING_IMAGE_OUTPUT_ERROR}: ${detail}`
      : MISSING_IMAGE_OUTPUT_ERROR,
  };
}

function sanitizePromptRepairOutput(value?: string) {
  const trimmed = (value || "").trim();
  if (!trimmed) return "";
  const withoutFence = trimmed
    .replace(/^```(?:text|prompt|markdown)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  return withoutFence
    .replace(/^修剪(?:后)?提示词[:：]\s*/i, "")
    .replace(/^rewritten prompt[:：]\s*/i, "")
    .trim();
}

export async function repairModerationBlockedPromptWithResponses(
  config: ApiConfig,
  params: {
    prompt: string;
    failureReason: string;
    allowPremiumModels?: boolean;
    mode: "generate" | "edit" | "chat";
    size?: string;
    signal?: AbortSignal;
  }
): Promise<{ prompt?: string; error?: string }> {
  const originalPrompt = params.prompt.trim();
  if (!originalPrompt) return { error: "Prompt is empty" };

  const result = await retryPoolBackendResult(
    config,
    async (candidate) => {
      const model = await getResponsesModel(candidate, undefined, {
        allowPremiumModels: params.allowPremiumModels,
      });
      const input: ResponsesRequestInputItem[] = [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "Rewrite this image prompt so it is more likely to pass image safety moderation.",
                "Preserve the user's benign intent, subject, style, composition, language, aspect ratio, and useful details.",
                "Remove or soften only the risky content implied by the failure reason.",
                "Do not add new unsafe content. Do not add explanations, markdown, labels, or quotes.",
                `Mode: ${params.mode}`,
                params.size ? `Requested size: ${params.size}` : "",
                `Moderation failure: ${params.failureReason.slice(0, 1200)}`,
                "Original prompt:",
                originalPrompt,
              ]
                .filter(Boolean)
                .join("\n"),
            },
          ],
        },
      ];
      const repaired = await fetchResponses(
        candidate,
        {
          model,
          input,
          instructions:
            "You are a prompt safety editor. Return only the rewritten image prompt text, with no commentary.",
          store: false,
          stream: Boolean(candidate.useStream),
        },
        {
          signal: params.signal,
          stream: Boolean(candidate.useStream),
        }
      );
      if (repaired.error) return { error: repaired.error };
      const repairedPrompt = sanitizePromptRepairOutput(repaired.responseText);
      if (!repairedPrompt) {
        return { error: "Responses prompt repair returned empty text" };
      }
      return { responseText: repairedPrompt };
    },
    {
      accountBackendPreference: "responses",
      allowAnyResponsesBackend: true,
    }
  );
  if (result.error) return { error: result.error };

  const repairedPrompt = sanitizePromptRepairOutput(result.responseText);
  if (!repairedPrompt) {
    return { error: "Responses prompt repair returned empty text" };
  }
  if (repairedPrompt === originalPrompt) {
    return { prompt: repairedPrompt };
  }
  return { prompt: repairedPrompt };
}

type ChatCompletionImageItem = {
  url?: unknown;
  b64_json?: unknown;
  revised_prompt?: unknown;
  generation_id?: unknown;
  generationId?: unknown;
};

/**
 * 是否存在至少一张带字节的输入图。base64 兜底重试的前置条件：无字节则无法内联，
 * 重试也救不了，直接放弃（历史图为空 Buffer，不计入）。
 */
function hasInputImageBytes(images?: ImageInputFile[]): boolean {
  return Boolean(images?.some((image) => image.data?.length));
}

function buildChatCompletionContent(
  text?: string,
  images?: ImageInputFile[],
  forceBase64?: boolean
) {
  const parts: Array<Record<string, unknown>> = [];
  if (text?.trim()) {
    parts.push({ type: "text", text: text.trim() });
  }
  for (const image of images || []) {
    parts.push({
      type: "image_url",
      image_url: { url: getInputImageUrl(image, { forceBase64 }) },
    });
  }
  if (parts.length === 1 && parts[0]?.type === "text") {
    return parts[0].text as string;
  }
  return parts;
}

function buildChatCompletionsMessages(
  params: ChatImageParams,
  forceBase64?: boolean
) {
  const messages: Array<Record<string, unknown>> = [];
  if (params.apiPrompt?.trim()) {
    messages.push({ role: "system", content: params.apiPrompt.trim() });
  }
  for (const item of params.history || []) {
    const historyImages = (item.imageUrls || []).map((url, index) => ({
      data: Buffer.alloc(0),
      name: `history-image-${index + 1}.png`,
      type: "image/png",
      url,
    }));
    // 历史图为空 Buffer，无字节，forceBase64 对其自动失效（保持透传原 url）。
    messages.push({
      role: item.role,
      content: buildChatCompletionContent(
        item.text,
        historyImages,
        forceBase64
      ),
    });
  }
  messages.push({
    role: "user",
    content: buildChatCompletionContent(
      getEffectivePrompt(params),
      params.images,
      forceBase64
    ),
  });
  return messages;
}

function extractChatCompletionText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      isPlainRecord(part) && typeof part.text === "string" ? part.text : ""
    )
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractChatCompletionImages(
  payload: unknown
): ChatCompletionImageItem[] {
  const images: ChatCompletionImageItem[] = [];
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (isPlainRecord(item) && (item.url || item.b64_json)) {
        images.push(item);
      }
    }
  };

  if (isPlainRecord(payload)) {
    collect(payload.images);
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    for (const choice of choices) {
      if (!isPlainRecord(choice)) continue;
      collect(choice.images);
      if (isPlainRecord(choice.message)) collect(choice.message.images);
    }
  }
  return images;
}

function chatCompletionPayloadToResult(
  payload: Record<string, unknown>
): GenerateImageResult {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const firstChoice = choices.find(isPlainRecord);
  const message = isPlainRecord(firstChoice?.message)
    ? firstChoice.message
    : undefined;
  const text = extractChatCompletionText(message?.content);
  const images = extractChatCompletionImages(payload);
  const imageOutputs = images.map((image, index) => ({
    imageBase64:
      typeof image.b64_json === "string" ? image.b64_json : undefined,
    imageUrl: typeof image.url === "string" ? image.url : undefined,
    revisedPrompt:
      typeof image.revised_prompt === "string"
        ? image.revised_prompt
        : undefined,
    generationId:
      typeof image.generation_id === "string"
        ? image.generation_id
        : typeof image.generationId === "string"
          ? image.generationId
          : undefined,
    index,
  }));
  const firstImage = imageOutputs.find(
    (item) => item.imageBase64 || item.imageUrl
  );

  return {
    responseText: text || undefined,
    model: typeof payload.model === "string" ? payload.model : undefined,
    imageBase64: firstImage?.imageBase64,
    imageUrl: firstImage?.imageUrl,
    revisedPrompt: firstImage?.revisedPrompt,
    imageOutputs: imageOutputs.length ? imageOutputs : undefined,
    imageOutputCount: imageOutputs.length || undefined,
    generationId: firstImage?.generationId,
  };
}

async function parseChatCompletionsResponse(
  response: Response,
  callbacks?: ImageGenerationCallbacks
): Promise<GenerateImageResult> {
  const responseRetryMetadata = getResponseRetryMetadata(response);
  if (!response.ok) {
    const rawBody = await response.text().catch(() => "");
    return {
      error: getHttpErrorMessage(response, rawBody, "Responses API"),
      ...responseRetryMetadata,
      ...extractPayloadRetryMetadata(safeParseJson(rawBody)),
    };
  }

  const parseSseText = async (text: string) => {
    let responseText = "";
    let finalPayload: Record<string, unknown> | null = null;
    const parseBlock = async (block: string) => {
      const dataLines = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());
      if (!dataLines.length) return null;
      const data = dataLines.join("\n").trim();
      if (!data || data === "[DONE]") return null;
      const payload = safeParseJson(data);
      if (!isPlainRecord(payload)) return null;
      const apiError = getPayloadError(payload);
      if (apiError) return apiError;
      finalPayload = payload;
      const choices = Array.isArray(payload.choices) ? payload.choices : [];
      const choice = choices.find(isPlainRecord);
      const delta = isPlainRecord(choice?.delta) ? choice.delta : undefined;
      const deltaText = extractChatCompletionText(delta?.content);
      if (deltaText) {
        responseText += deltaText;
        await callbacks?.onTextDelta?.(deltaText);
      }
      return null;
    };

    for (const block of text.replace(/\r\n/g, "\n").split("\n\n")) {
      const error = await parseBlock(block);
      if (error) return { error, ...responseRetryMetadata };
    }
    if (finalPayload) {
      const result = chatCompletionPayloadToResult(finalPayload);
      return {
        ...result,
        responseText: result.responseText || responseText || undefined,
        ...responseRetryMetadata,
      };
    }
    const jsonError = tryParseJsonPayloadError(text);
    return {
      error: jsonError || "API returned no image data",
      ...responseRetryMetadata,
    };
  };

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream") && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let rawText = "";
    let buffer = "";
    let responseText = "";
    let finalPayload: Record<string, unknown> | null = null;
    while (true) {
      const { value, done } = await reader.read();
      const chunk = decoder.decode(value, { stream: !done });
      rawText += chunk;
      buffer += chunk;
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || "";
      for (const block of blocks) {
        const dataLines = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());
        if (!dataLines.length) continue;
        const data = dataLines.join("\n").trim();
        if (!data || data === "[DONE]") continue;
        const payload = safeParseJson(data);
        if (!isPlainRecord(payload)) continue;
        const apiError = getPayloadError(payload);
        if (apiError) {
          await reader.cancel().catch(() => undefined);
          return { error: apiError, ...responseRetryMetadata };
        }
        finalPayload = payload;
        const choices = Array.isArray(payload.choices) ? payload.choices : [];
        const choice = choices.find(isPlainRecord);
        const delta = isPlainRecord(choice?.delta) ? choice.delta : undefined;
        const deltaText = extractChatCompletionText(delta?.content);
        if (deltaText) {
          responseText += deltaText;
          await callbacks?.onTextDelta?.(deltaText);
        }
      }
      if (done) break;
    }
    if (buffer.trim()) {
      return await parseSseText(`${rawText}\n\n${buffer}`);
    }
    if (finalPayload) {
      const result = chatCompletionPayloadToResult(finalPayload);
      return {
        ...result,
        responseText: result.responseText || responseText || undefined,
        ...responseRetryMetadata,
      };
    }
    const jsonError = tryParseJsonPayloadError(rawText);
    return {
      error: jsonError || "API returned no image data",
      ...responseRetryMetadata,
    };
  }

  const text = await response.text().catch(() => "");
  if (looksLikeEventStreamText(text)) {
    return await parseSseText(text);
  }

  const payload = safeParseJson(text);
  if (!isPlainRecord(payload)) {
    return {
      error: getNonJsonErrorMessage(text, "Responses API", response),
      ...responseRetryMetadata,
    };
  }
  const apiError = getPayloadError(payload);
  if (apiError) return { error: apiError, ...responseRetryMetadata };
  return {
    ...chatCompletionPayloadToResult(payload),
    ...responseRetryMetadata,
  };
}

async function generateChatImageWithChatCompletions(
  config: ApiConfig,
  params: ChatImageParams,
  callbacks?: ImageGenerationCallbacks
): Promise<GenerateImageResult> {
  const requestedModel = params.model?.trim();
  const configuredModel = config.model?.trim();
  const model =
    (requestedModel && !isImageModel(requestedModel)
      ? requestedModel
      : undefined) ||
    (configuredModel && !isImageModel(configuredModel)
      ? configuredModel
      : undefined) ||
    GPT55_CHAT_MODEL;
  const stream = Boolean(params.stream || config.useStream);
  const rawBody =
    params.rawChatCompletionsBody &&
    isPlainRecord(params.rawChatCompletionsBody)
      ? params.rawChatCompletionsBody
      : null;

  // 单次转发：按 forceBase64 重建 messages（仅我方构造时可重建；rawBody 自带
  // messages 则无图可换，retry 退化为同一请求，因此不重试）。
  const attempt = async (
    forceBase64: boolean
  ): Promise<GenerateImageResult> => {
    const messages =
      rawBody?.messages || buildChatCompletionsMessages(params, forceBase64);
    const body = {
      ...(rawBody || {}),
      model,
      messages,
      ...(model === GPT6_ASTRA_CHAT_MODEL &&
      (rawBody?.reasoning_effort === "none" ||
        rawBody?.reasoning_effort === "minimal")
        ? { reasoning_effort: "low" }
        : {}),
      prompt_cache_key:
        rawBody?.prompt_cache_key ||
        buildOpenAIPromptCacheKey(config, {
          scope: "chat-completions",
          model,
          imageModel: params.imageModel,
          promptOptimization: params.promptOptimization,
          inputSignature: buildPromptCacheSalt(),
        }),
      ...(stream ? { stream: true } : {}),
    };
    delete (body as Record<string, unknown>).size;
    delete (body as Record<string, unknown>).quality;
    delete (body as Record<string, unknown>).moderation;
    delete (body as Record<string, unknown>).output_format;
    delete (body as Record<string, unknown>).output_compression;
    delete (body as Record<string, unknown>).promptOptimization;
    delete (body as Record<string, unknown>).prompt_optimization;
    delete (body as Record<string, unknown>).imageModel;
    delete (body as Record<string, unknown>).image_model;
    delete (body as Record<string, unknown>).thinking;
    delete (body as Record<string, unknown>).mixWebFirst;
    delete (body as Record<string, unknown>).mix_web_first;
    delete (body as Record<string, unknown>).requiresResponsesBackend;
    delete (body as Record<string, unknown>).requires_responses_backend;

    try {
      const response = await fetch(
        `${stripTrailingSlash(config.baseUrl)}/chat/completions`,
        {
          method: "POST",
          redirect: "manual",
          signal: params.signal,
          cache: stream ? "no-store" : "default",
          headers: getHeaders(config, {
            "Content-Type": "application/json",
            Accept: stream ? "text/event-stream" : "application/json",
            ...(stream
              ? {
                  "Accept-Encoding": "identity",
                  "Cache-Control": "no-cache",
                }
              : {}),
          }),
          body: JSON.stringify(body),
        }
      );
      return await parseChatCompletionsResponse(response, callbacks);
    } catch (error) {
      logImageRequestError(error, {
        operation: "chat",
        baseUrl: config.baseUrl,
        path: "/chat/completions",
        model,
        useStream: stream,
      });
      return {
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      };
    }
  };

  const result = await attempt(false);
  // 一次性同后端兜底：上游下载我方输入图 URL 失败（如 407）且我方有字节，
  // 重发同一请求并把输入图强制内联 base64。仅当我方构造 messages 时可重建。
  if (
    isImageDownloadUpstreamError(result.error) &&
    !rawBody?.messages &&
    hasInputImageBytes(params.images)
  ) {
    logWarn("上游下载输入图失败，改用 base64 内联重试（chat/completions）", {
      baseUrl: config.baseUrl,
      model,
    });
    return await attempt(true);
  }
  return result;
}

function stripToolTypes(
  body: ResponsesStreamRequestBody,
  blockedTypes: Set<string>
) {
  const tools = Array.isArray(body.tools)
    ? body.tools.filter(
        (tool) =>
          !(
            isPlainRecord(tool) &&
            typeof tool.type === "string" &&
            (blockedTypes.has(tool.type) ||
              (tool.type === "function" &&
                typeof tool.name === "string" &&
                blockedTypes.has(tool.name)))
          )
      )
    : body.tools;
  return {
    ...body,
    tools,
  };
}

async function fetchAgentResponsesAttempt(params: {
  config: ApiConfig;
  requestBody: ResponsesStreamRequestBody;
  signal?: AbortSignal;
  stream: boolean;
  callbacks?: ImageGenerationCallbacks;
  storeFalseFallbackInput?: ResponsesRequestInputItem[];
  onStoreDisabledFallback?: () => void;
}) {
  let requestBody = params.requestBody;
  let result = await fetchResponses(
    params.config,
    requestBody,
    {
      signal: params.signal,
      stream: params.stream,
    },
    params.callbacks
  );

  if (
    requestBody.store !== false &&
    result.error &&
    isResponsesStoreUnsupportedError(result.error)
  ) {
    requestBody = {
      ...buildResponsesStoreFalseFallbackRequestBody(requestBody),
      ...(params.storeFalseFallbackInput
        ? { input: params.storeFalseFallbackInput }
        : {}),
    };
    params.onStoreDisabledFallback?.();
    await emitAgentDecision(params.callbacks, {
      status: "completed",
      title: "Agent 上下文重试",
      detail: "上游要求关闭 Responses store，已改用手动历史重试",
    });
    result = await fetchResponses(
      params.config,
      requestBody,
      {
        signal: params.signal,
        stream: params.stream,
      },
      params.callbacks
    );
    result = {
      ...result,
      responsesStoreDisabledFallback: true,
    };
  }

  return { requestBody, result };
}

async function fetchAgentRoundResponses(params: {
  config: ApiConfig;
  requestBody: ResponsesStreamRequestBody;
  signal?: AbortSignal;
  stream: boolean;
  callbacks?: ImageGenerationCallbacks;
  storeFalseFallbackInput?: ResponsesRequestInputItem[];
  onStoreDisabledFallback?: () => void;
}) {
  let { requestBody, result } = await fetchAgentResponsesAttempt(params);

  const unsupportedTools = getUnsupportedToolTypes(result);
  if (unsupportedTools.size > 0) {
    await emitAgentProgress(params.callbacks, {
      kind: "tool",
      status: "completed",
      title: "工具兼容性调整",
      detail: `已移除 ${Array.from(unsupportedTools).join(", ")} 后重试`,
      timestamp: new Date().toISOString(),
      toolType: "agent_tool_compat",
    });
    ({ requestBody, result } = await fetchAgentResponsesAttempt({
      ...params,
      requestBody: stripToolTypes(requestBody, unsupportedTools),
    }));

    const secondUnsupportedTools = getUnsupportedToolTypes(result);
    if (secondUnsupportedTools.size > 0) {
      await emitAgentProgress(params.callbacks, {
        kind: "tool",
        status: "completed",
        title: "工具兼容性调整",
        detail: "扩展工具仍不可用，已切换为仅保留图片生成工具重试",
        timestamp: new Date().toISOString(),
        toolType: "agent_tool_compat",
      });
      ({ result } = await fetchAgentResponsesAttempt({
        ...params,
        requestBody: stripToolTypes(
          requestBody,
          new Set(["web_search", "code_interpreter", "function"])
        ),
      }));
    }
  }

  return result;
}

function shouldRetryAgentRoundWithManualHistory(error?: string | null) {
  const normalized = (error || "").toLowerCase();
  return Boolean(
    normalized &&
      (isPreviousResponseStateError(error || undefined) ||
        isResponsesStoreUnsupportedError(error || undefined) ||
        normalized.includes("empty non-json") ||
        normalized.includes("empty response") ||
        normalized.includes("http 200 ok"))
  );
}

function getUnsupportedToolTypes(result: GenerateImageResult) {
  if (!result.error) return new Set<string>();
  const message = result.error.toLowerCase();
  const looksUnsupported =
    message.includes("unsupported") ||
    message.includes("not supported") ||
    message.includes("invalid") ||
    message.includes("unknown") ||
    message.includes("unrecognized") ||
    message.includes("not available");
  if (!looksUnsupported) return new Set<string>();
  const types = new Set<string>();
  if (message.includes("web_search")) types.add("web_search");
  if (message.includes("code_interpreter")) types.add("code_interpreter");
  if (message.includes("function") || message.includes("continue_generation")) {
    types.add("function");
  }
  return types;
}

function hasAgentImage(result: GenerateImageResult) {
  return Boolean(
    result.imageBase64 ||
      result.imageUrl ||
      result.imageOutputs?.some((item) => item.imageBase64 || item.imageUrl)
  );
}

async function getAgentMaxRounds() {
  return Math.max(
    1,
    Math.min(
      8,
      Math.floor(
        await getRuntimeSettingNumber(
          "IMAGE_AGENT_MAX_ROUNDS",
          DEFAULT_AGENT_IMAGE_ROUNDS,
          { positive: true }
        )
      )
    )
  );
}

function normalizeAgentMaxRounds(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(1, Math.min(8, Math.floor(numeric)));
}

async function getAgentForceMaxRounds() {
  return await getRuntimeSettingBoolean("IMAGE_AGENT_FORCE_MAX_ROUNDS", false);
}

async function fetchResponses(
  config: ApiConfig,
  requestBody: ResponsesStreamRequestBody,
  options: {
    signal?: AbortSignal;
    stream: boolean;
  },
  callbacks?: ImageGenerationCallbacks
): Promise<ResponsesResultWithOutput> {
  const response = await fetch(
    `${stripTrailingSlash(config.baseUrl)}/responses`,
    {
      method: "POST",
      redirect: "manual",
      signal: options.signal,
      cache: options.stream ? "no-store" : "default",
      headers: getHeaders(config, {
        "Content-Type": "application/json",
        Accept: options.stream ? "text/event-stream" : "application/json",
        ...(options.stream
          ? {
              "Accept-Encoding": "identity",
              "Cache-Control": "no-cache",
            }
          : {}),
      }),
      body: JSON.stringify(requestBody),
    }
  );

  return await parseResponsesResponse(response, callbacks, {
    preferEventStream: options.stream,
  });
}

function getEffectivePrompt(params: {
  prompt: string;
  apiPrompt?: string;
  fileContext?: string;
  promptOptimization?: boolean;
}) {
  const prompt =
    params.promptOptimization === false
      ? params.prompt
      : params.apiPrompt || params.prompt;
  return params.fileContext ? `${prompt}\n\n${params.fileContext}` : prompt;
}

async function generateChatImageWithImages(
  config: ApiConfig,
  params: ChatImageParams,
  callbacks?: ImageGenerationCallbacks
) {
  const prompt = getEffectivePrompt(params);
  const images = params.images || [];
  const imageModel = params.imageModel || DEFAULT_IMAGE_MODEL;
  const withRequestKind = (
    requestKind: "image_generation" | "image_edit"
  ): ApiConfig => ({
    ...config,
    backend: config.backend
      ? {
          ...config.backend,
          requestKind,
          imagesUpstreamMode: "images",
          apiForceResponsesEndpoint: false,
        }
      : undefined,
  });
  const common = {
    prompt,
    apiPrompt: prompt,
    promptOptimization: params.promptOptimization,
    signal: params.signal,
    size: params.size,
    model: imageModel,
    quality: params.quality,
    n: params.n,
    moderation: params.moderation,
    outputFormat: params.outputFormat,
    outputCompression: params.outputCompression,
    background: params.background,
  };

  if (images.length) {
    return await editImage(
      withRequestKind("image_edit"),
      { ...common, images },
      callbacks
    );
  }
  return await generateImage(
    withRequestKind("image_generation"),
    common,
    callbacks
  );
}

function appendImageParams(
  formData: FormData,
  config: ApiConfig,
  params: {
    prompt: string;
    model?: string;
    n?: number;
    size?: string;
    quality?: ImageQuality;
    moderation?: ImageModeration;
    promptOptimization?: boolean;
    outputFormat?: ImageOutputFormat;
    outputCompression?: number;
    background?: string;
  }
) {
  formData.append("model", getModel(config, params.model));
  // multipart 改图同样注入每请求唯一零宽 nonce 破上游内容缓存（仅上游请求体）。
  formData.append("prompt", appendImagesUpstreamNonce(params.prompt));
  formData.append("n", String(params.n || 1));
  formData.append("response_format", "b64_json");

  if (params.size) {
    formData.append("size", params.size);
    const dimensions = parseImageSize(params.size);
    if (dimensions) {
      formData.append("width", String(dimensions.width));
      formData.append("height", String(dimensions.height));
    }
  }

  const quality = normalizeQuality(params.quality);
  if (quality) {
    formData.append("quality", quality);
  }

  const moderation = normalizeModeration(params.moderation);
  if (moderation) {
    formData.append("moderation", moderation);
  }

  const outputFormat = normalizeOutputFormat(params.outputFormat);
  if (outputFormat) {
    formData.append("output_format", outputFormat);
  }

  const outputCompression = normalizeOutputCompression(
    params.outputCompression
  );
  if (outputCompression !== undefined) {
    formData.append("output_compression", String(outputCompression));
  }

  const background = normalizeImageBackground(params.background);
  if (background) {
    formData.append("background", background);
  }

  if (config.useStream) {
    formData.append("stream", "true");
    formData.append("partial_images", "2");
  }
}

function toGenerateImageResult(image: ImageOutput): GenerateImageResult {
  const result: GenerateImageResult = {};
  if (image.b64_json) result.imageBase64 = image.b64_json;
  if (image.url) result.imageUrl = image.url;
  if (image.b64_json || image.url) result.imageOutputCount = 1;
  if (image.revised_prompt) {
    result.upstreamRevisedPrompt = image.revised_prompt;
  }
  if (image.b64_json || image.url) {
    result.imageOutputs = [
      {
        imageBase64: image.b64_json,
        imageUrl: image.url,
        upstreamRevisedPrompt: image.revised_prompt,
        index: typeof image.index === "number" ? image.index : 0,
      },
    ];
  }
  return result;
}

function getPayloadError(payload: unknown): string | null {
  const apiError = getApiErrorMessage(payload);
  if (apiError) return apiError;

  if (
    payload &&
    typeof payload === "object" &&
    "type" in payload &&
    payload.type === "upstream_error" &&
    "message" in payload &&
    typeof payload.message === "string"
  ) {
    return payload.message;
  }

  return null;
}

function extractImageFromPayload(
  payload: ImageResponsePayload
): GenerateImageResult | null {
  const images = (payload.data || []).filter(
    (item) => item.b64_json || item.url
  );
  const image = images.at(-1);
  if (image) {
    return toGenerateImageResult(image);
  }

  if (payload.b64_json || payload.url) {
    return toGenerateImageResult(payload);
  }

  return null;
}

function extractPartialImage(
  payload: ImageResponsePayload
): PartialImageResult | null {
  const imageBase64 = payload.b64_json || payload.partial_image_b64;
  if (!imageBase64 && !payload.url) {
    return null;
  }

  const result: PartialImageResult = {};
  if (imageBase64) result.imageBase64 = imageBase64;
  if (payload.url) result.imageUrl = payload.url;
  if (typeof payload.index === "number") result.index = payload.index;
  if (typeof payload.partial_image_index === "number") {
    result.partialImageIndex = payload.partial_image_index;
  }
  return result;
}

function parseResponsesOutput(
  output: ResponsesOutputItem[] | undefined
): ResponsesResultWithOutput | null {
  let imageBase64: string | undefined;
  let revisedPrompt: string | undefined;
  let responseText: string | undefined;
  let responseThinking: string | undefined;
  let responseAgent: string | undefined;
  const agentEvents: AgentRunEvent[] = [];
  let imageOutputCount = 0;
  const imageOutputs: NonNullable<GenerateImageResult["imageOutputs"]> = [];

  for (const item of output || []) {
    if (item.type === "reasoning" && item.summary) {
      const text = item.summary
        .filter((part) => part.type === "summary_text" && part.text)
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (text) {
        responseThinking = responseThinking
          ? `${responseThinking}\n${text}`
          : text;
      }
    }

    const itemImageBase64 = extractResponsesImageCallBase64(item);
    if (item.type === "image_generation_call" && itemImageBase64) {
      imageBase64 = itemImageBase64;
      imageOutputCount += 1;
      if (item.revised_prompt) revisedPrompt = item.revised_prompt;
      imageOutputs.push({
        imageBase64: itemImageBase64,
        upstreamRevisedPrompt: item.revised_prompt,
        index: imageOutputCount - 1,
      });
      const event = toAgentRunEvent(item, { done: true });
      if (event) {
        event.title = "最终图片已生成";
        event.index = imageOutputCount - 1;
        event.partialImageIndex = imageOutputCount - 1;
        agentEvents.push(event);
      }
      continue;
    }

    if (item.type === "message" && item.content) {
      const text = item.content
        .filter((part) => part.type === "output_text" && part.text)
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (text) responseText = responseText ? `${responseText}\n${text}` : text;
    }

    const agentLine = describeResponsesToolItem(item, { done: true });
    if (agentLine) {
      responseAgent = responseAgent
        ? `${responseAgent}\n${agentLine}`
        : agentLine;
      const event = toAgentRunEvent(item, { done: true });
      if (event) agentEvents.push(event);
    }
  }

  if (!imageBase64 && !responseText && !responseThinking) return null;

  return {
    imageBase64,
    imageOutputs: imageOutputs.length ? imageOutputs : undefined,
    imageOutputCount: imageOutputCount || undefined,
    upstreamRevisedPrompt: revisedPrompt,
    responseText,
    responseThinking,
    responseAgent,
    agentEvents: agentEvents.length ? agentEvents : undefined,
    outputItems: output,
  };
}

function compactToolText(value: unknown, maxLength = 140) {
  if (typeof value !== "string") return undefined;
  const compacted = value.replace(/\s+/g, " ").trim();
  if (!compacted) return undefined;
  return compacted.length > maxLength
    ? `${compacted.slice(0, maxLength - 3)}...`
    : compacted;
}

function compactToolJson(value: unknown, maxLength = 140) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return compactToolText(value, maxLength);
  try {
    return compactToolText(JSON.stringify(value), maxLength);
  } catch {
    return undefined;
  }
}

function describeWebSearchAction(action: unknown) {
  if (!isPlainRecord(action)) return undefined;
  const type = typeof action.type === "string" ? action.type : "";
  if (type === "search" && Array.isArray(action.queries)) {
    const queries = action.queries
      .filter((item): item is string => typeof item === "string")
      .slice(0, 2)
      .join("; ");
    return compactToolText(queries);
  }
  if (type === "open_page" && typeof action.url === "string") {
    return compactToolText(action.url);
  }
  return compactToolJson(action);
}

function describeResponsesToolItem(
  item: ResponsesOutputItem | undefined,
  options: { done?: boolean } = {}
) {
  if (!item?.type) return null;

  if (item.type === "image_generation_call") {
    return options.done
      ? `图片生成: ${item.status || (item.result ? "completed" : "finished")}`
      : "图片生成: started";
  }

  if (item.type === "web_search_call") {
    const detail =
      compactToolText(item.query) || describeWebSearchAction(item.action);
    const suffix = detail
      ? ` - ${detail}`
      : item.status
        ? ` - ${item.status}`
        : "";
    return `${options.done ? "联网搜索完成" : "联网搜索"}${suffix}`;
  }

  if (item.type === "function_call") {
    const name = item.name ? ` ${item.name}` : "";
    const args = compactToolText(item.arguments);
    return `调用工具${name}${args ? ` - ${args}` : ""}`;
  }

  if (item.type.endsWith("_call")) {
    const detail =
      compactToolText(item.query) ||
      compactToolText(item.name) ||
      compactToolJson(item.action) ||
      item.status;
    return `${options.done ? "工具完成" : "运行工具"}: ${item.type}${
      detail ? ` - ${detail}` : ""
    }`;
  }

  return null;
}

function getToolEventKind(item: ResponsesOutputItem): AgentRunEvent["kind"] {
  if (item.type === "web_search_call") return "web_search";
  if (item.type === "code_interpreter_call") return "code_interpreter";
  if (item.type === "image_generation_call") return "image_generation";
  return "tool";
}

function getToolEventTitle(
  item: ResponsesOutputItem,
  options: { done?: boolean; partial?: boolean } = {}
) {
  if (options.partial) return "中间图已生成";
  if (item.type === "web_search_call") {
    return options.done ? "联网搜索完成" : "联网搜索";
  }
  if (item.type === "code_interpreter_call") {
    return options.done ? "代码/文件分析完成" : "代码/文件分析";
  }
  if (item.type === "image_generation_call") {
    return options.done ? "图片生成完成" : "图片生成";
  }
  if (item.type === "function_call") {
    return item.name
      ? `${options.done ? "工具调用完成" : "调用工具"}: ${item.name}`
      : options.done
        ? "工具调用完成"
        : "调用工具";
  }
  return options.done ? "工具完成" : "运行工具";
}

function getToolEventDetail(item: ResponsesOutputItem) {
  if (item.type === "web_search_call") {
    return compactToolText(item.query) || describeWebSearchAction(item.action);
  }
  if (item.type === "function_call") {
    return compactToolText(item.arguments);
  }
  return (
    compactToolText(item.query) ||
    compactToolText(item.name) ||
    compactToolJson(item.action) ||
    item.status
  );
}

function toAgentRunEvent(
  item: ResponsesOutputItem | undefined,
  options: { done?: boolean } = {}
): AgentRunEvent | null {
  if (!item?.type) return null;
  if (item.type === "message" || item.type === "reasoning") return null;
  return {
    id: item.id || item.call_id,
    kind: getToolEventKind(item),
    status: options.done ? "completed" : "started",
    title: getToolEventTitle(item, options),
    detail: getToolEventDetail(item),
    timestamp: new Date().toISOString(),
    toolType: item.type,
  };
}

function getAgentEventKey(event: AgentRunEvent) {
  if (event.id) return `id:${event.id}`;
  if (event.kind === "image_partial") {
    return [
      event.kind,
      event.toolType || "",
      event.partialImageIndex ?? "",
      event.index ?? "",
    ].join("|");
  }
  return [
    event.kind,
    event.toolType || "",
    event.partialImageIndex ?? "",
    event.index ?? "",
    event.title,
  ].join("|");
}

function getResponseItemId(item: ResponsesOutputItem | undefined) {
  return item?.id || item?.call_id || item?.item_id || item?.output_item_id;
}

function getToolEventSignature(item: ResponsesOutputItem | undefined) {
  if (!item?.type) return "";
  return [
    item.type,
    compactToolText(item.query),
    compactToolText(item.name),
    compactToolText(item.arguments),
    compactToolJson(item.action),
    item.status,
  ].join("|");
}

function inferToolStatusFromEventName(eventName: string): AgentRunEventStatus {
  if (
    eventName.endsWith(".done") ||
    eventName.endsWith(".completed") ||
    eventName.endsWith(".succeeded")
  ) {
    return "completed";
  }
  if (eventName.endsWith(".failed") || eventName.endsWith(".error")) {
    return "failed";
  }
  if (
    eventName.endsWith(".in_progress") ||
    eventName.endsWith(".searching") ||
    eventName.endsWith(".delta")
  ) {
    return "running";
  }
  if (eventName.endsWith(".added") || eventName.endsWith(".created")) {
    return "started";
  }
  return "running";
}

function mergeResponseOutputItem(
  previous: ResponsesOutputItem | undefined,
  next: ResponsesOutputItem
): ResponsesOutputItem {
  return {
    ...(previous || {}),
    ...next,
    id: next.id ?? previous?.id,
    call_id: next.call_id ?? previous?.call_id,
    item_id: next.item_id ?? previous?.item_id,
    output_item_id: next.output_item_id ?? previous?.output_item_id,
    action: next.action ?? previous?.action,
    arguments:
      typeof previous?.arguments === "string" ||
      typeof next.arguments === "string"
        ? `${previous?.arguments || ""}${next.arguments || ""}`
        : undefined,
    query: next.query ?? previous?.query,
    results: next.results ?? previous?.results,
    result: next.result ?? previous?.result,
    revised_prompt: next.revised_prompt ?? previous?.revised_prompt,
    content: next.content ?? previous?.content,
    summary: next.summary ?? previous?.summary,
  };
}

function getStreamItem(
  state: EventStreamParseState,
  payload: Record<string, unknown>
) {
  const item = payload.item as ResponsesOutputItem | undefined;
  if (item?.type) return item;

  const itemId =
    typeof payload.item_id === "string"
      ? payload.item_id
      : typeof payload.output_item_id === "string"
        ? payload.output_item_id
        : typeof payload.id === "string"
          ? payload.id
          : typeof payload.call_id === "string"
            ? payload.call_id
            : undefined;
  if (!itemId) return undefined;
  return state.streamItems?.[itemId];
}

function updateStreamItem(
  state: EventStreamParseState,
  item: ResponsesOutputItem | undefined
) {
  if (!item?.type) return item;
  const itemId = getResponseItemId(item);
  if (!itemId) return item;
  state.streamItems = state.streamItems || {};
  const merged = mergeResponseOutputItem(state.streamItems[itemId], item);
  state.streamItems[itemId] = merged;
  return merged;
}

function getStreamDeltaItem(
  state: EventStreamParseState,
  payload: Record<string, unknown>
) {
  const previous = getStreamItem(state, payload);
  const delta = isPlainRecord(payload.delta)
    ? (payload.delta as ResponsesOutputItem)
    : undefined;
  const argumentsDelta =
    typeof payload.delta === "string" ? payload.delta : undefined;
  if (!previous && !delta?.type && argumentsDelta === undefined) {
    return undefined;
  }
  const deltaItem: ResponsesOutputItem = {
    ...(delta || {}),
    id: previous?.id || delta?.id,
    call_id: previous?.call_id || delta?.call_id,
    item_id: previous?.item_id || delta?.item_id,
    output_item_id: previous?.output_item_id || delta?.output_item_id,
    type: previous?.type || delta?.type,
    name:
      previous?.name ||
      delta?.name ||
      (typeof payload.name === "string" ? payload.name : undefined),
    arguments: argumentsDelta,
  };
  return updateStreamItem(state, deltaItem);
}

function mergeAgentEvents(
  ...groups: Array<AgentRunEvent[] | undefined>
): AgentRunEvent[] | undefined {
  const merged: AgentRunEvent[] = [];
  const seen = new Map<string, number>();
  for (const events of groups) {
    for (const event of events || []) {
      const key = getAgentEventKey(event);
      const existingIndex = seen.get(key);
      if (existingIndex === undefined) {
        seen.set(key, merged.length);
        merged.push(event);
        continue;
      }
      merged[existingIndex] = { ...merged[existingIndex], ...event };
    }
  }
  return merged.length ? merged : undefined;
}

function mergeGenerateImageResults(
  results: ResponsesResultWithOutput[]
): ResponsesResultWithOutput {
  const last = results[results.length - 1];
  if (!last) return { error: "API returned no image data" };

  const imageOutputs: NonNullable<GenerateImageResult["imageOutputs"]> = [];
  const outputItems: ResponsesOutputItem[] = [];
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  const agentParts: string[] = [];
  let imageBase64: string | undefined;
  let imageUrl: string | undefined;
  let revisedPrompt: string | undefined;
  let upstreamRevisedPrompt: string | undefined;

  for (const result of results) {
    if (result.responseText?.trim()) textParts.push(result.responseText.trim());
    if (result.responseThinking?.trim()) {
      thinkingParts.push(result.responseThinking.trim());
    }
    if (result.responseAgent?.trim()) {
      agentParts.push(result.responseAgent.trim());
    }
    if (result.outputItems?.length) outputItems.push(...result.outputItems);

    for (const output of result.imageOutputs || []) {
      if (!output.imageBase64 && !output.imageUrl) continue;
      const nextOutput = {
        ...output,
        index: imageOutputs.length,
      } satisfies NonNullable<GenerateImageResult["imageOutputs"]>[number];
      imageOutputs.push(nextOutput);
      if (output.imageBase64) imageBase64 = output.imageBase64;
      if (output.imageUrl) imageUrl = output.imageUrl;
      revisedPrompt = output.revisedPrompt || revisedPrompt;
      upstreamRevisedPrompt =
        output.upstreamRevisedPrompt || upstreamRevisedPrompt;
    }

    if (
      !result.imageOutputs?.length &&
      (result.imageBase64 || result.imageUrl)
    ) {
      imageOutputs.push({
        imageBase64: result.imageBase64,
        imageUrl: result.imageUrl,
        revisedPrompt: result.revisedPrompt,
        upstreamRevisedPrompt: result.upstreamRevisedPrompt,
        index: imageOutputs.length,
      });
      imageBase64 = result.imageBase64 || imageBase64;
      imageUrl = result.imageUrl || imageUrl;
      revisedPrompt = result.revisedPrompt || revisedPrompt;
      upstreamRevisedPrompt =
        result.upstreamRevisedPrompt || upstreamRevisedPrompt;
    }
  }

  return {
    ...last,
    responsesStoreDisabledFallback: results.some(
      (result) => result.responsesStoreDisabledFallback
    ),
    imageBase64,
    imageUrl,
    imageOutputs: imageOutputs.length
      ? imageOutputs.map((output, index) => ({
          ...output,
          outputRole:
            output.outputRole === "choice"
              ? "choice"
              : index === imageOutputs.length - 1
                ? "final"
                : output.outputRole || "agent_draft",
        }))
      : last.imageOutputs,
    imageOutputCount: imageOutputs.length || last.imageOutputCount,
    revisedPrompt: last.revisedPrompt || revisedPrompt,
    upstreamRevisedPrompt:
      last.upstreamRevisedPrompt || upstreamRevisedPrompt || revisedPrompt,
    responseText: textParts.length ? textParts.join("\n\n") : last.responseText,
    responseThinking: thinkingParts.length
      ? thinkingParts.join("\n\n")
      : last.responseThinking,
    responseAgent: agentParts.length
      ? agentParts.join("\n")
      : last.responseAgent,
    agentEvents: mergeAgentEvents(
      ...results.map((result) => result.agentEvents)
    ),
    agentRoundCount: results.length,
    outputItems: outputItems.length ? outputItems : last.outputItems,
  };
}

async function emitAgentEvent(
  callbacks: ImageGenerationCallbacks | undefined,
  event: AgentRunEvent
) {
  await callbacks?.onAgentEvent?.(event);
}

async function emitAgentProgress(
  callbacks: ImageGenerationCallbacks | undefined,
  event: AgentRunEvent
) {
  await callbacks?.onAgentDelta?.(
    `${event.title}${event.detail ? ` - ${event.detail}` : ""}\n`
  );
  await emitAgentEvent(callbacks, event);
}

async function emitAgentDecision(
  callbacks: ImageGenerationCallbacks | undefined,
  params: {
    status: AgentRunEventStatus;
    title: string;
    detail?: string;
  }
) {
  await emitAgentProgress(callbacks, {
    kind: "tool",
    status: params.status,
    title: params.title,
    detail: params.detail,
    timestamp: new Date().toISOString(),
    toolType: "agent_decision",
  });
}

async function emitAgentRoundRequestStatus(
  callbacks: ImageGenerationCallbacks | undefined,
  params: {
    round: number;
    status: AgentRunEventStatus;
    title?: string;
    detail?: string;
  }
) {
  await emitAgentProgress(callbacks, {
    id: `agent-round-${params.round}-upstream`,
    kind: "tool",
    status: params.status,
    title: params.title || "等待 Codex/Responses 上游响应",
    detail: params.detail,
    timestamp: new Date().toISOString(),
    toolType: "agent_round_request",
  });
}

function createAgentRoundRequestTracker(
  callbacks: ImageGenerationCallbacks | undefined,
  round: number
) {
  const startedAt = Date.now();
  let stopped = false;
  let settled = false;
  let interval: ReturnType<typeof setInterval> | undefined;

  const emitStatus = async (
    status: AgentRunEventStatus,
    detail: string,
    options: { rawLog?: boolean } = {}
  ) => {
    const event: AgentRunEvent = {
      id: `agent-round-${round}-upstream`,
      kind: "tool",
      status,
      title: "等待 Codex/Responses 上游响应",
      detail,
      timestamp: new Date().toISOString(),
      toolType: "agent_round_request",
    };
    if (options.rawLog) {
      await emitAgentProgress(callbacks, event);
      return;
    }
    await emitAgentEvent(callbacks, event);
  };

  if (callbacks) {
    interval = setInterval(() => {
      if (stopped || settled) return;
      const elapsedSeconds = Math.max(
        5,
        Math.floor((Date.now() - startedAt) / 1000)
      );
      void emitStatus(
        "running",
        `模型仍在处理，已等待 ${elapsedSeconds} 秒`
      ).catch((error) => {
        logWarn("Agent round heartbeat failed", { error });
      });
    }, 5_000);
  }

  const stopTimer = () => {
    stopped = true;
    if (interval) {
      clearInterval(interval);
      interval = undefined;
    }
  };

  const markReceived = async () => {
    if (settled) return;
    settled = true;
    stopTimer();
    await emitStatus("completed", "已收到上游流式响应，正在继续处理");
  };

  const noteStillWaiting = async (detail: string) => {
    if (settled) return;
    await emitStatus("running", detail);
  };

  const finish = async (params: { error?: string }) => {
    stopTimer();
    if (params.error) {
      settled = true;
      await emitStatus("failed", params.error, { rawLog: true });
      return;
    }
    if (!settled) {
      settled = true;
      await emitStatus("completed", "上游响应已返回，正在整理本轮结果", {
        rawLog: true,
      });
    }
  };

  const wrapCallbacks = (): ImageGenerationCallbacks | undefined => {
    if (!callbacks) return undefined;
    return {
      ...callbacks,
      onPartialImage: async (image) => {
        await markReceived();
        await callbacks.onPartialImage?.(image);
      },
      onTextDelta: async (delta) => {
        await markReceived();
        await callbacks.onTextDelta?.(delta);
      },
      onThinkingDelta: async (delta) => {
        await markReceived();
        await callbacks.onThinkingDelta?.(delta);
      },
      onAgentDelta: async (delta) => {
        await callbacks.onAgentDelta?.(delta);
      },
      onAgentEvent: async (event) => {
        if (event.toolType === "responses_stream_event") {
          await noteStillWaiting(
            event.detail
              ? `已收到上游事件：${event.detail}`
              : "已收到上游流式事件，等待可展示的工具结果"
          );
        } else if (event.toolType === "agent_tool_compat") {
          await noteStillWaiting("已调整工具配置，正在重试上游请求");
        } else if (event.toolType !== "agent_round_request") {
          await markReceived();
        }
        await callbacks.onAgentEvent?.(event);
      },
    };
  };

  return {
    finish,
    wrapCallbacks,
  };
}

async function recordAgentEvent(
  state: EventStreamParseState,
  callbacks: ImageGenerationCallbacks | undefined,
  event: AgentRunEvent
) {
  state.agentEvents = [...(state.agentEvents || []), event];
  await emitAgentEvent(callbacks, event);
}

function shouldReportResponsesToolItem(
  eventName: string,
  item: ResponsesOutputItem | undefined
) {
  if (!item?.type) return false;
  if (item.type === "message" || item.type === "reasoning") return false;
  if (
    item.type === "image_generation_call" &&
    eventName === "response.output_item.done"
  ) {
    return true;
  }
  return item.type.endsWith("_call");
}

function extractStreamItemId(payload: Record<string, unknown>) {
  return (
    (typeof payload.item_id === "string" && payload.item_id) ||
    (typeof payload.output_item_id === "string" && payload.output_item_id) ||
    (typeof payload.id === "string" && payload.id) ||
    (typeof payload.call_id === "string" && payload.call_id) ||
    undefined
  );
}

function eventNameToFallbackToolType(eventName: string) {
  if (eventName.includes("web_search_call")) return "web_search_call";
  if (eventName.includes("code_interpreter_call")) {
    return "code_interpreter_call";
  }
  if (eventName.includes("image_generation_call")) {
    return "image_generation_call";
  }
  if (eventName.includes("function_call")) return "function_call";
  return undefined;
}

function getFallbackToolEventKey(
  eventName: string,
  payload: Record<string, unknown>
) {
  const fallbackType = eventNameToFallbackToolType(eventName);
  if (!fallbackType) return undefined;
  const action = isPlainRecord(payload.action) ? payload.action : undefined;
  const detail =
    compactToolText(typeof payload.query === "string" ? payload.query : "") ||
    describeWebSearchAction(action) ||
    compactToolText(typeof payload.name === "string" ? payload.name : "") ||
    compactToolText(
      typeof payload.item_id === "string" ? payload.item_id : ""
    ) ||
    compactToolText(
      typeof payload.output_item_id === "string" ? payload.output_item_id : ""
    ) ||
    fallbackType;
  return `${fallbackType}:${detail || "active"}`;
}

function getStreamToolItem(
  state: EventStreamParseState,
  eventName: string,
  payload: Record<string, unknown>
) {
  const item =
    getStreamItem(state, payload) ||
    (payload.item as ResponsesOutputItem | undefined);
  if (item?.type) return updateStreamItem(state, item);

  const itemId = extractStreamItemId(payload);
  const fallbackType = eventNameToFallbackToolType(eventName);
  const fallbackKey = itemId || getFallbackToolEventKey(eventName, payload);
  if (!fallbackKey || !fallbackType) return undefined;
  return updateStreamItem(state, {
    id: fallbackKey,
    call_id: fallbackKey,
    item_id: fallbackKey,
    output_item_id: fallbackKey,
    type: fallbackType,
    status: typeof payload.status === "string" ? payload.status : undefined,
    query: typeof payload.query === "string" ? payload.query : undefined,
    action: isPlainRecord(payload.action) ? payload.action : undefined,
    name: typeof payload.name === "string" ? payload.name : undefined,
  });
}

async function reportResponsesToolEvent(
  state: EventStreamParseState,
  callbacks: ImageGenerationCallbacks | undefined,
  item: ResponsesOutputItem | undefined,
  status: AgentRunEventStatus
) {
  if (
    !item?.type ||
    !shouldReportResponsesToolItem("response.output_item.added", item)
  ) {
    return;
  }
  const itemId = getResponseItemId(item);
  if (itemId) {
    state.emittedToolEvents = state.emittedToolEvents || {};
    const signature = `${status}:${getToolEventSignature(item)}`;
    const previousSignature = state.emittedToolEvents[itemId];
    if (previousSignature === signature) return;
    state.emittedToolEvents[itemId] = signature;
  }

  const done = status === "completed";
  const displayItem: ResponsesOutputItem = {
    ...item,
    status: done
      ? "completed"
      : status === "running"
        ? item.status || "in_progress"
        : status,
  };
  const line = describeResponsesToolItem(displayItem, { done });
  if (line) {
    await callbacks?.onAgentDelta?.(`${line}\n`);
    state.responseAgent = `${state.responseAgent || ""}${line}\n`;
  }
  const event = toAgentRunEvent(displayItem, { done });
  if (event) {
    event.status = status;
    await recordAgentEvent(state, callbacks, event);
  }
}

function isResponsesPartialImageEvent(
  eventName: string,
  payload: Record<string, unknown>
) {
  return (
    eventName.includes("partial_image") ||
    (typeof payload.type === "string" && payload.type.includes("partial_image"))
  );
}

function shouldSurfaceRawResponsesStreamEvent(eventName: string) {
  if (!eventName) return false;
  if (eventName === "response.completed" || eventName === "response.failed") {
    return true;
  }
  return (
    eventName.includes("web_search_call") ||
    eventName.includes("image_generation_call") ||
    eventName.includes("code_interpreter_call") ||
    eventName.includes("function_call") ||
    eventName.includes("output_item") ||
    eventName.includes("output_text") ||
    eventName.includes("reasoning")
  );
}

async function surfaceRawResponsesStreamEvent(
  eventName: string,
  state: EventStreamParseState,
  callbacks?: ImageGenerationCallbacks
) {
  if (!state.debugRawStreamEvents) return;
  if (!callbacks || !shouldSurfaceRawResponsesStreamEvent(eventName)) return;
  state.emittedRawStreamEvents = state.emittedRawStreamEvents || {};
  const previous = state.emittedRawStreamEvents[eventName];
  if (previous) return;
  state.emittedRawStreamEvents[eventName] = true;
  await callbacks.onAgentDelta?.(`上游事件: ${eventName}\n`);
  await emitAgentEvent(callbacks, {
    id: `raw-upstream-${eventName}`,
    kind: "tool",
    status: inferToolStatusFromEventName(eventName),
    title: "收到上游流式事件",
    detail: eventName,
    timestamp: new Date().toISOString(),
    toolType: "responses_stream_event",
  });
}

function extractResponseCompletedPayload(
  payload: ResponsesPayload | { response?: ResponsesPayload }
) {
  if ("response" in payload && payload.response) {
    return payload.response;
  }
  return payload as ResponsesPayload;
}

async function processResponsesEventPayload(
  eventName: string,
  dataLines: string[],
  state: EventStreamParseState,
  callbacks?: ImageGenerationCallbacks
) {
  const data = dataLines.join("\n").trim();
  if (!data || data === "[DONE]") return null;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
  const streamEventName =
    eventName || (typeof payload.type === "string" ? payload.type : "");
  await surfaceRawResponsesStreamEvent(streamEventName, state, callbacks);

  if (
    streamEventName === "response.failed" ||
    streamEventName === "error" ||
    payload.type === "response.failed" ||
    payload.type === "error"
  ) {
    const retryMetadata = extractPayloadRetryMetadata(payload);
    const message = getApiError(payload, "Responses API stream failed");
    if (!retryMetadata.upstreamResetAt && !retryMetadata.retryAfterSeconds) {
      return message;
    }
    return `${message} ${JSON.stringify(retryMetadata)}`;
  }

  if (streamEventName === "response.output_item.done") {
    const item = updateStreamItem(
      state,
      payload.item as ResponsesOutputItem | undefined
    );
    // 按顺序累积已完成的输出项,作为 response.completed.output 为空时的兜底来源。
    if (item?.type) {
      state.completedOutputItems = state.completedOutputItems || [];
      const itemId = getResponseItemId(item);
      const existingIndex = itemId
        ? state.completedOutputItems.findIndex(
            (existing) => getResponseItemId(existing) === itemId
          )
        : -1;
      if (existingIndex >= 0) {
        state.completedOutputItems[existingIndex] = item;
      } else {
        state.completedOutputItems.push(item);
      }
    }
    await reportResponsesToolEvent(state, callbacks, item, "completed");
    const itemImageBase64 = extractResponsesImageCallBase64(item);
    if (item?.type === "image_generation_call" && itemImageBase64) {
      const imageOutputCount =
        (state.fallbackResult?.imageOutputCount || 0) + 1;
      const imageOutput = {
        imageBase64: itemImageBase64,
        upstreamRevisedPrompt: item.revised_prompt,
        index: imageOutputCount - 1,
        outputRole: "agent_draft" as const,
      };
      const partialImage = {
        imageBase64: itemImageBase64,
        partialImageIndex: imageOutput.index,
        final: true,
      };
      await recordAgentEvent(state, callbacks, {
        id: item.id,
        kind: "image_generation",
        status: "completed",
        title: "最终图片已生成",
        index: imageOutput.index,
        partialImageIndex: imageOutput.index,
        timestamp: new Date().toISOString(),
        toolType: item.type,
      });
      await callbacks?.onPartialImage?.(partialImage);
      state.fallbackResult = {
        ...(state.fallbackResult || {}),
        imageBase64: itemImageBase64,
        imageOutputs: [
          ...(state.fallbackResult?.imageOutputs || []),
          imageOutput,
        ],
        imageOutputCount,
        upstreamRevisedPrompt: item.revised_prompt,
        responseAgent:
          state.fallbackResult?.responseAgent || state.responseAgent,
      };
    }
    return null;
  }

  if (streamEventName === "response.output_item.added") {
    const item = updateStreamItem(
      state,
      payload.item as ResponsesOutputItem | undefined
    );
    await reportResponsesToolEvent(state, callbacks, item, "started");
    return null;
  }

  // 不逐 token 汇报函数调用参数(如 continue_generation 的 reason):工具事件签名含 arguments,
  // 每个 delta 累积参数都不同 → 绕过去重 → 日志逐字刷屏。必须在 fallbackToolType 兜底块【之前】
  // 拦截,否则会被 eventNameToFallbackToolType("...function_call...") 归类后逐 delta 发出(兜底块
  // 在前,之前放在其后的分支是死代码)。函数调用起止已由 output_item.added/done 与轮次循环的
  // 「Agent 请求继续」单独汇报。
  if (streamEventName === "response.function_call_arguments.delta") {
    return null;
  }

  const fallbackToolType = isResponsesPartialImageEvent(
    streamEventName,
    payload
  )
    ? undefined
    : eventNameToFallbackToolType(streamEventName);
  if (fallbackToolType) {
    const item =
      getStreamDeltaItem(state, payload) ||
      getStreamToolItem(state, streamEventName, payload);
    await reportResponsesToolEvent(
      state,
      callbacks,
      item,
      inferToolStatusFromEventName(streamEventName)
    );
    return null;
  }

  if (
    streamEventName === "response.output_item.in_progress" ||
    streamEventName === "response.web_search_call.in_progress" ||
    streamEventName === "response.code_interpreter_call.in_progress" ||
    streamEventName === "response.image_generation_call.in_progress"
  ) {
    const item = getStreamToolItem(state, streamEventName, payload);
    await reportResponsesToolEvent(state, callbacks, item, "running");
    return null;
  }

  if (
    streamEventName === "response.output_item.delta" ||
    streamEventName === "response.web_search_call.searching" ||
    streamEventName === "response.web_search_call.in_progress" ||
    streamEventName === "response.code_interpreter_call.code.delta"
  ) {
    const item =
      getStreamDeltaItem(state, payload) ||
      getStreamToolItem(state, streamEventName, payload);
    await reportResponsesToolEvent(state, callbacks, item, "running");
    return null;
  }

  if (isResponsesPartialImageEvent(streamEventName, payload)) {
    const partialImage = extractPartialImage(payload as ImageResponsePayload);
    if (partialImage) {
      await recordAgentEvent(state, callbacks, {
        kind: "image_partial",
        status: "completed",
        title: "流式预览已生成",
        imageBase64: partialImage.imageBase64,
        imageUrl: partialImage.imageUrl,
        index: partialImage.index,
        partialImageIndex: partialImage.partialImageIndex,
        timestamp: new Date().toISOString(),
        toolType:
          typeof payload.type === "string"
            ? payload.type
            : streamEventName || undefined,
      });
      await callbacks?.onPartialImage?.(partialImage);
    }
    return null;
  }

  if (streamEventName === "response.output_text.delta") {
    const delta = payload.delta;
    if (typeof delta === "string" && delta) {
      await callbacks?.onTextDelta?.(delta);
      state.fallbackResult = {
        ...(state.fallbackResult || {}),
        responseText: `${state.fallbackResult?.responseText || ""}${delta}`,
        responseAgent:
          state.fallbackResult?.responseAgent || state.responseAgent,
      };
    }
    return null;
  }

  if (streamEventName === "response.reasoning_summary_text.delta") {
    const delta = payload.delta;
    if (typeof delta === "string" && delta) {
      await callbacks?.onThinkingDelta?.(delta);
      state.fallbackResult = {
        ...(state.fallbackResult || {}),
        responseThinking: `${state.fallbackResult?.responseThinking || ""}${delta}`,
        responseAgent:
          state.fallbackResult?.responseAgent || state.responseAgent,
      };
    }
    return null;
  }

  if (streamEventName === "response.completed") {
    const completedPayload = extractResponseCompletedPayload(
      payload as ResponsesPayload | { response?: ResponsesPayload }
    );
    // codex(store:false)的 completed.output 常为空;此时退回流式累积的 output_item.done 项,
    // 否则会丢掉 function_call(continue_generation)等输出项,导致 agent 续轮被误判停止。
    const completedOutput =
      completedPayload.output && completedPayload.output.length > 0
        ? completedPayload.output
        : state.completedOutputItems && state.completedOutputItems.length > 0
          ? state.completedOutputItems
          : completedPayload.output;
    const result = parseResponsesOutput(completedOutput);
    if (result) {
      const completedImageOutputCount = result.imageOutputs?.length || 0;
      state.completedResult = {
        ...result,
        responseId: completedPayload.id,
        outputItems: completedOutput,
        responsesUsage: extractResponsesTokenUsage(completedPayload),
        imageOutputs:
          completedImageOutputCount > 0
            ? result.imageOutputs
            : state.fallbackResult?.imageOutputs,
        imageOutputCount:
          completedImageOutputCount > 0
            ? completedImageOutputCount
            : state.fallbackResult?.imageOutputCount,
        responseAgent: state.responseAgent || result.responseAgent,
        agentEvents: mergeAgentEvents(state.agentEvents, result.agentEvents),
      };
    }
  }

  return null;
}

async function processResponsesEventBlock(
  block: string,
  state: EventStreamParseState,
  callbacks?: ImageGenerationCallbacks
) {
  let eventName = "";
  const dataLines: string[] = [];
  const lines = block.replace(/\r\n/g, "\n").split("\n");

  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;

    const separatorIndex = line.indexOf(":");
    const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
    const rawValue =
      separatorIndex === -1 ? "" : line.slice(separatorIndex + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

    if (field === "event") {
      eventName = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
  }

  return await processResponsesEventPayload(
    eventName,
    dataLines,
    state,
    callbacks
  );
}

async function parseResponsesEventStreamResponse(
  response: Response,
  callbacks?: ImageGenerationCallbacks
): Promise<ResponsesResultWithOutput> {
  if (!response.body) {
    return parseResponsesEventStreamText(await response.text(), callbacks);
  }

  const state: EventStreamParseState = {
    completedResult: null,
    fallbackResult: null,
    debugRawStreamEvents:
      Boolean(callbacks) &&
      process.env.IMAGE_AGENT_DEBUG_STREAM_EVENTS === "true",
  };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let rawText = "";

  while (true) {
    const { value, done } = await reader.read();
    const chunk = decoder.decode(value, { stream: !done });
    rawText += chunk;
    buffer += chunk;
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";

    for (const block of blocks) {
      if (!block.trim()) continue;
      const error = await processResponsesEventBlock(block, state, callbacks);
      if (error) {
        await reader.cancel().catch(() => undefined);
        return { error };
      }
    }

    if (done) break;
  }

  if (buffer.trim()) {
    const error = await processResponsesEventBlock(buffer, state, callbacks);
    if (error) return { error };
  }

  return withStreamJsonErrorFallback(finishEventStream(state), rawText);
}

async function parseResponsesEventStreamText(
  text: string,
  callbacks?: ImageGenerationCallbacks
): Promise<ResponsesResultWithOutput> {
  const jsonError = tryParseJsonPayloadError(text);
  if (jsonError) return { error: jsonError };

  const state: EventStreamParseState = {
    completedResult: null,
    fallbackResult: null,
    debugRawStreamEvents:
      Boolean(callbacks) &&
      process.env.IMAGE_AGENT_DEBUG_STREAM_EVENTS === "true",
  };

  for (const block of text.replace(/\r\n/g, "\n").split("\n\n")) {
    if (!block.trim()) continue;
    const error = await processResponsesEventBlock(block, state, callbacks);
    if (error) return { error };
  }

  return finishEventStream(state);
}

async function parseResponsesResponse(
  response: Response,
  callbacks?: ImageGenerationCallbacks,
  options: { preferEventStream?: boolean } = {}
): Promise<ResponsesResultWithOutput> {
  const responseRetryMetadata = getResponseRetryMetadata(response);
  if (!response.ok) {
    const rawBody = await response.text().catch(() => "");
    return {
      error: getHttpErrorMessage(response, rawBody, "Responses API"),
      ...responseRetryMetadata,
      ...extractPayloadRetryMetadata(safeParseJson(rawBody)),
    };
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream")) {
    return withRetryMetadata(
      await parseResponsesEventStreamResponse(response, callbacks),
      responseRetryMetadata
    );
  }

  if (options.preferEventStream && !contentType.includes("application/json")) {
    return withRetryMetadata(
      await parseResponsesEventStreamResponse(response, callbacks),
      responseRetryMetadata
    );
  }

  if (!contentType.includes("application/json")) {
    const text = await response.text().catch(() => "");
    if (looksLikeEventStreamText(text)) {
      return withRetryMetadata(
        await parseResponsesEventStreamText(text, callbacks),
        responseRetryMetadata
      );
    }
    return {
      error: getNonJsonErrorMessage(text, "Responses API", response),
      ...responseRetryMetadata,
    };
  }

  const data = (await response.json()) as ResponsesPayload;
  const result = parseResponsesOutput(data.output);

  return withRetryMetadata(
    result
      ? {
          ...result,
          responseId: data.id,
          outputItems: data.output,
          responsesUsage: extractResponsesTokenUsage(data),
        }
      : { error: getPayloadError(data) || "API returned no image data" },
    { ...responseRetryMetadata, ...extractPayloadRetryMetadata(data) }
  );
}

type EventStreamParseState = {
  completedResult: ResponsesResultWithOutput | null;
  fallbackResult: ResponsesResultWithOutput | null;
  responseAgent?: string;
  agentEvents?: AgentRunEvent[];
  streamItems?: Record<string, ResponsesOutputItem>;
  // 按到达顺序累积的 output_item.done 项。WHY:codex(store:false)的 response.completed
  // 返回的 output 为空数组,真正的输出项(含带 call_id 的 continue_generation function_call)
  // 只通过 output_item.done 逐条下发;completed.output 为空时用本列表兜底,否则会漏判"请求继续"。
  completedOutputItems?: ResponsesOutputItem[];
  emittedToolEvents?: Record<string, string>;
  emittedRawStreamEvents?: Record<string, true>;
  debugRawStreamEvents?: boolean;
};

async function processEventPayload(
  eventName: string,
  dataLines: string[],
  state: EventStreamParseState,
  callbacks?: ImageGenerationCallbacks
) {
  if (dataLines.length === 0) return null;

  const data = dataLines.join("\n").trim();
  if (!data || data === "[DONE]") return null;

  let payload: ImageResponsePayload;
  try {
    payload = JSON.parse(data) as ImageResponsePayload;
  } catch {
    return null;
  }

  if (eventName === "error" || payload.type === "upstream_error") {
    return getPayloadError(payload) || "Image generation stream failed";
  }

  if (
    eventName.includes("partial_image") ||
    payload.type?.includes("partial_image")
  ) {
    const partialImage = extractPartialImage(payload);
    if (partialImage) {
      await callbacks?.onPartialImage?.(partialImage);
    }
    return null;
  }

  const result = extractImageFromPayload(payload);
  if (!result) return null;

  if (
    eventName.endsWith(".completed") ||
    payload.type?.endsWith(".completed")
  ) {
    state.completedResult = result;
  } else if (!state.fallbackResult) {
    state.fallbackResult = result;
  }

  return null;
}

async function processEventBlock(
  block: string,
  state: EventStreamParseState,
  callbacks?: ImageGenerationCallbacks
) {
  let eventName = "";
  const dataLines: string[] = [];
  const lines = block.replace(/\r\n/g, "\n").split("\n");

  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;

    const separatorIndex = line.indexOf(":");
    const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
    const rawValue =
      separatorIndex === -1 ? "" : line.slice(separatorIndex + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

    if (field === "event") {
      eventName = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
  }

  return await processEventPayload(eventName, dataLines, state, callbacks);
}

function finishEventStream(
  state: EventStreamParseState
): ResponsesResultWithOutput {
  const result = state.completedResult || state.fallbackResult;
  if (result) {
    return {
      ...result,
      responseAgent: result.responseAgent || state.responseAgent,
      agentEvents: mergeAgentEvents(state.agentEvents, result.agentEvents),
    };
  }

  return { error: "API returned no image data" };
}

async function parseEventStreamText(
  text: string,
  callbacks?: ImageGenerationCallbacks
): Promise<GenerateImageResult> {
  const jsonError = tryParseJsonPayloadError(text);
  if (jsonError) return { error: jsonError };

  const state: EventStreamParseState = {
    completedResult: null,
    fallbackResult: null,
  };

  const blocks = text.replace(/\r\n/g, "\n").split("\n\n");
  for (const block of blocks) {
    if (!block.trim()) continue;
    const error = await processEventBlock(block, state, callbacks);
    if (error) return { error };
  }

  return finishEventStream(state);
}

async function parseEventStreamResponse(
  response: Response,
  callbacks?: ImageGenerationCallbacks
): Promise<GenerateImageResult> {
  if (!response.body) {
    return parseEventStreamText(await response.text(), callbacks);
  }

  const state: EventStreamParseState = {
    completedResult: null,
    fallbackResult: null,
  };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let rawText = "";

  while (true) {
    const { value, done } = await reader.read();
    const chunk = decoder.decode(value, { stream: !done });
    rawText += chunk;
    buffer += chunk;
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";

    for (const block of blocks) {
      if (!block.trim()) continue;
      const error = await processEventBlock(block, state, callbacks);
      if (error) {
        await reader.cancel().catch(() => undefined);
        return { error };
      }
    }

    if (done) break;
  }

  if (buffer.trim()) {
    const error = await processEventBlock(buffer, state, callbacks);
    if (error) return { error };
  }

  return withStreamJsonErrorFallback(finishEventStream(state), rawText);
}

async function parseImageResponse(
  response: Response,
  callbacks?: ImageGenerationCallbacks
): Promise<GenerateImageResult> {
  const responseRetryMetadata = getResponseRetryMetadata(response);
  if (!response.ok) {
    const rawBody = await response.text().catch(() => "");
    return {
      error: getHttpErrorMessage(response, rawBody, "Images API"),
      ...responseRetryMetadata,
      ...extractPayloadRetryMetadata(safeParseJson(rawBody)),
    };
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream")) {
    return withRetryMetadata(
      await parseEventStreamResponse(response, callbacks),
      responseRetryMetadata
    );
  }

  if (!contentType.includes("application/json")) {
    const text = await response.text().catch(() => "");
    if (looksLikeEventStreamText(text)) {
      return withRetryMetadata(
        await parseEventStreamText(text, callbacks),
        responseRetryMetadata
      );
    }
    return {
      error: getNonJsonErrorMessage(text, "Images API", response),
      ...responseRetryMetadata,
    };
  }

  const data = (await response.json()) as ImageResponsePayload;
  const result = extractImageFromPayload(data);

  if (!result) {
    return withRetryMetadata(
      { error: getPayloadError(data) || "API returned no image data" },
      { ...responseRetryMetadata, ...extractPayloadRetryMetadata(data) }
    );
  }

  return withRetryMetadata(result, responseRetryMetadata);
}

export async function getUserApiConfig(
  userId: string
): Promise<ApiConfig | null> {
  const plan = await getUserPlan(userId);
  if (!(await canUsePlanCapability(plan.plan, "customApi.configure"))) {
    return null;
  }

  const config = await db
    .select()
    .from(userApiConfig)
    .where(eq(userApiConfig.userId, userId))
    .limit(1);

  const row = config[0];
  if (!row?.isActive || !row.baseUrl || !row.apiKey) {
    return null;
  }

  // 请求时复检自定义 baseUrl 指向公网（弥补"仅保存时校验"的 TOCTOU：
  // 例如保存后 DNS 变更 / 指向内网）。指向内网或不可解析则丢弃该配置、回落平台后端。
  try {
    await assertPublicApiBaseUrl(row.baseUrl);
  } catch (error) {
    logWarn("Rejected user API base URL failing SSRF re-check", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const result: ApiConfig = { baseUrl: row.baseUrl, apiKey: row.apiKey };
  const normalizedModel = normalizeImageModel(row.model);
  if (normalizedModel) result.model = normalizedModel;
  if (row.useStream) result.useStream = true;
  result.contentSafetyEnabled = true;
  result.backend = {
    type: "user-api",
    chatCompletionsUpstreamMode: row.chatCompletionsUpstreamMode as
      | "responses"
      | "chat_completions"
      | "images",
  };
  return result;
}

export async function getEffectiveConfig(
  userConfig: ApiConfig | null,
  options?: {
    userId?: string;
    apiKeyId?: string;
    requestKind?: ImageBackendRequestKind;
    requestedModel?: string;
    preferredMemberId?: string;
    preferredMemberType?: "api" | "account" | "adobe";
    stickyPreviousResponseId?: string;
    stickySessionKey?: string;
    accountBackendPreference?: ImageBackendAccountBackend;
    accountBackendPreferenceMode?: ImageBackendPreferenceMode;
    // force_firefly：强制把候选收敛到 adobe（firefly）后端，对任意模型生效。
    forceFirefly?: boolean;
    ignoreUserConfig?: boolean;
    allowAnyResponsesBackend?: boolean;
  }
): Promise<{
  config: ApiConfig;
  useCredits: boolean;
}> {
  if (userConfig && !options?.ignoreUserConfig) {
    return { config: userConfig, useCredits: false };
  }
  if (options?.userId && options.requestKind) {
    let poolConfig: Awaited<ReturnType<typeof resolveImageBackendPoolConfig>>;
    try {
      poolConfig = await resolveImageBackendPoolConfig({
        userId: options.userId,
        apiKeyId: options.apiKeyId,
        requestKind: options.requestKind,
        requestedModel: options.requestedModel,
        preferredMemberId: options.preferredMemberId,
        preferredMemberType: options.preferredMemberType,
        stickyPreviousResponseId: options.stickyPreviousResponseId,
        stickySessionKey: options.stickySessionKey,
        accountBackendPreference: options.accountBackendPreference,
        accountBackendPreferenceMode: options.accountBackendPreferenceMode,
        forceFirefly: options.forceFirefly,
        allowAnyResponsesBackend: options.allowAnyResponsesBackend,
      });
    } catch (error) {
      if (error instanceof ImageBackendPoolUnavailableError) {
        throw error;
      }
      throw error;
    }
    if (poolConfig) {
      return { config: poolConfig.config, useCredits: true };
    }
  }
  // firefly-* / nano-banana 仅由 Adobe / adobe_sourced 后端出图。若这些后端因限流或上游错误
  // (502/服务不可用)被标 error 踢空,resolve 返回 null——此处给出指向 Adobe 后端的明确报错,
  // 避免运维误以为是"模型检索不到/模型不存在"。
  const isFireflyRequest =
    options?.forceFirefly === true ||
    /^firefly-/i.test((options?.requestedModel || "").trim());
  throw new ImageBackendPoolUnavailableError(
    isFireflyRequest
      ? "没有可用的 Adobe（Firefly）后端：firefly-* / nano-banana 仅由 Adobe / adobe_sourced 后端出图，当前该分组内此类后端均不可用（可能被限流，或因上游 502/服务不可用被标记 error 踢出）。请在账号池检查 Adobe / adobe_sourced 后端状态并测活或重新启用。"
      : "没有可用的默认生图后端，请在账号池中配置默认分组和 API/账号"
  );
}

/**
 * api 后端（pool-api）分发前的输入图 re-host 守卫。
 *
 * 仅在最终选定的后端为 pool-api 且已知 userId 时生效（account 后端不受影响）：
 * 把待发送给上游的输入图、mask、历史图逐张确保转存到我方对象存储，避免把第三方
 * 外链交给上游（上游下载外链会被图床限流返回 "failed download file 429"）。
 *
 * 幂等：直接原地改写 params 内的 image 对象/字符串，已转存（带 storageKey 或
 * 第一方 url）的项会被 ensureInputImageRehosted 短路；重试时不会重复下载/上传。
 * 任何单张失败不影响其他图，也不中断主流程（失败语义见 ensureInputImageRehosted）。
 *
 * @param config 已选定的后端配置（用于判定 pool-api 与取 userId）。
 * @param params 含 images / mask / history 的请求参数（原地改写）。
 * @param signal 透传给下载的 abort 信号。
 */
async function rehostApiBackendInputImages(
  config: ApiConfig,
  params: {
    images?: ImageInputFile[];
    mask?: ImageInputFile;
    history?: ChatImageParams["history"];
  },
  signal?: AbortSignal
): Promise<void> {
  const backend = config.backend;
  if (backend?.type !== "pool-api") return;
  const userId = backend.userId?.trim();
  if (!userId) return;

  const generationId = backend.id || "rehost";

  if (params.images?.length) {
    for (let index = 0; index < params.images.length; index++) {
      const image = params.images[index];
      if (!image) continue;
      params.images[index] = await ensureInputImageRehosted(image, {
        userId,
        generationId,
        scope: "rehost",
        index,
        signal,
      });
    }
  }

  if (params.mask) {
    params.mask = await ensureInputImageRehosted(params.mask, {
      userId,
      generationId,
      scope: "rehost-mask",
      index: 0,
      signal,
    });
  }

  // 历史图只有 url、无字节，属于"下载再传"分支：转存后回填第一方签名 url，
  // 让 getInputImageUrl 透传我方 URL 而非原外链。
  for (const message of params.history || []) {
    const urls = message.imageUrls;
    if (!urls?.length) continue;
    for (let index = 0; index < urls.length; index++) {
      const url = urls[index]?.trim();
      if (!url) continue;
      const rehosted = await ensureInputImageRehosted(
        {
          data: Buffer.alloc(0),
          name: `history-image-${index + 1}.png`,
          type: "image/png",
          url,
        },
        {
          userId,
          generationId,
          scope: "rehost-history",
          index,
          signal,
        }
      );
      if (rehosted.url) urls[index] = rehosted.url;
    }
  }
}

// 把池后端的 backend.type 映射为调度成员类型（用于 reportImageBackendResult / 租约
// 键）。pool-adobe → adobe；pool-api → api；其余（pool-account）→ account。
export function poolBackendMemberType(
  backendType: string | undefined
): "api" | "account" | "adobe" {
  if (backendType === "pool-api") return "api";
  if (backendType === "pool-adobe") return "adobe";
  return "account";
}

// 「Adobe 来源」api 接 firefly-* 请求的反向转换薄封装：仅判定后端（pool-api + adobeSourced），
// 纯映射逻辑（截家族名 + 推 size，可选 backendModel 覆盖）见 ./adobe-sourced-firefly。
function reverseAdobeSourcedApiFirefly(
  config: ApiConfig,
  requestedModel: string | null | undefined,
  requestedSize: string | null | undefined
): { model: string; size: string | undefined } | null {
  if (config.backend?.type !== "pool-api" || !config.backend.adobeSourced) {
    return null;
  }
  return reverseFireflyToGptRequest({
    requestedModel,
    requestedSize,
    backendModel: config.model,
  });
}

// adobe（pool-adobe）派发：用 Firefly 适配器构造 /v1/chat/completions 请求，解析产物
// URL 后取回字节返回 base64（由管线 re-host），不长期依赖 adobe2api 本机 /generated URL。
// 文生图只传 prompt；图生图把输入图以 base64 data URL 放进 messages。
async function runAdobeImageRequest(
  config: ApiConfig,
  params: {
    prompt: string;
    model?: string | null;
    size?: string | null;
    quality?: string | null;
    images?: Array<{ data: Buffer; type?: string | null }>;
    signal?: AbortSignal;
  }
): Promise<GenerateImageResult> {
  // direct 模式：用本仓库移植的逆向逻辑直连 Adobe Firefly（经 Go TLS 旁路），不走网关。
  if (config.backend?.adobeMode === "direct") {
    return runAdobeDirectImageRequest(config, params);
  }
  // 网关模式：family 优先取请求 model 的族（firefly-*）；非 firefly 模型（如普通 gpt-image
  // 经 force_firefly 强制路由到 adobe）一律落 gpt-image-2，而非后端 enabledModels 首项。
  const family = pickAdobeFamilyFromModel(params.model) ?? "gpt-image-2";
  const body = buildAdobeImageRequestBody({
    family,
    prompt: params.prompt,
    size: params.size,
    ...(params.images && params.images.length > 0
      ? { images: params.images }
      : {}),
  });
  const response = await fetch(
    `${stripTrailingSlash(config.baseUrl)}/v1/chat/completions`,
    {
      method: "POST",
      redirect: "manual",
      signal: params.signal,
      headers: getHeaders(config, { "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    }
  );
  if (!response.ok) {
    const rawBody = await response.text().catch(() => "");
    return {
      error: getHttpErrorMessage(response, rawBody, "Adobe Firefly API"),
    };
  }
  const json = (await response.json().catch(() => null)) as unknown;
  const parsed = parseAdobeMediaResult(json, config.baseUrl);
  if ("error" in parsed) return { error: parsed.error };
  const mediaResponse = await fetch(parsed.url, { signal: params.signal });
  if (!mediaResponse.ok) {
    return {
      error: `Adobe Firefly 媒体下载失败 HTTP ${mediaResponse.status}`,
    };
  }
  const buffer = Buffer.from(await mediaResponse.arrayBuffer());
  return { imageBase64: buffer.toString("base64") };
}

export async function generateImage(
  config: ApiConfig,
  params: GenerateImageParams,
  callbacks?: ImageGenerationCallbacks
): Promise<GenerateImageResult> {
  if (config.backend?.groupBackendType === "web") {
    params = { ...params, model: DEFAULT_IMAGE_MODEL };
  }
  if (config.backend?.reportResult) {
    return retryPoolBackendResult(
      config,
      (candidate) => generateImage(candidate, params, callbacks),
      {
        mixWebFirst: params.mixWebFirst,
        accountBackendPreference: params.requiresResponsesBackend
          ? "responses"
          : params.forceWebBackend
            ? "web"
            : undefined,
        accountBackendPreferenceMode: params.forceWebBackend
          ? "mixed-only"
          : undefined,
      }
    );
  }

  const fireflyRewrite = reverseAdobeSourcedApiFirefly(
    config,
    params.model,
    params.size
  );
  if (fireflyRewrite) {
    // 反向转换后 size 改写一次，下游所有 params.size 读取（含 appendImageParams）即一致。
    params = { ...params, size: fireflyRewrite.size };
  }
  const model = fireflyRewrite?.model ?? getModel(config, params.model);
  if (isPoolAccountBackend(config, "web")) {
    return requireImageOutput(
      await generateImageWithChatGptWeb(config, {
        ...params,
        model,
        gptModel: params.gptModel,
      })
    );
  }
  if (config.backend?.type === "pool-adobe") {
    return requireImageOutput(
      applyPromptOptimizationResultVisibility(
        await runAdobeImageRequest(config, {
          prompt: getEffectivePrompt(params),
          model,
          size: params.size,
          quality: params.quality,
          signal: params.signal,
        })
      )
    );
  }
  if (
    isResponsesBackend(config) &&
    !shouldCodexUseDirectImagesEndpoint(config)
  ) {
    try {
      return requireImageOutput(
        applyPromptOptimizationResultVisibility(
          await postResponsesImageRequestWithToolChoiceFallback(
            config,
            buildResponsesImageGenerationRequest(config, {
              ...params,
              model,
              gptModel:
                params.gptModel ||
                (await getDefaultImageGptModel(config, {
                  allowPremiumModels: params.allowPremiumModels,
                })),
            }),
            { signal: params.signal },
            callbacks
          )
        )
      );
    } catch (error) {
      logImageRequestError(error, {
        operation: "generate",
        baseUrl: config.baseUrl,
        path: "/responses",
        model,
        useStream: config.useStream,
      });
      return {
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      };
    }
  }

  try {
    const prompt = getEffectivePrompt(params);
    const size = params.size || DEFAULT_IMAGE_SIZE;
    const dimensions = parseImageSize(size);
    const background = normalizeImageBackground(params.background);
    // codex 直连 OpenAI 标准 images 接口:拒绝非标准的 width/height(返回 400 Unknown
    // parameter: 'width')与 gpt-image 不支持的 response_format,故对 codex 去掉这些字段
    // (b64 为默认返回)。中转(pool-api)后端不受影响,原样发送。
    // size 仍照发,但 codex 上游不尊重(#19175,直连端点亦然,见 shouldCodexUseDirectImagesEndpoint)。
    const isCodexDirect = shouldCodexUseDirectImagesEndpoint(config);
    const response = await fetch(`${config.baseUrl}/images/generations`, {
      method: "POST",
      redirect: "manual",
      signal: params.signal,
      headers: getHeaders(config, {
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({
        model,
        // images 端点不吃 prompt_cache_key,改在 prompt 注入每请求唯一零宽 nonce,
        // 打掉上游中转按请求体内容缓存导致的"同图同词出同图"。仅作用于上游请求体。
        prompt: appendImagesUpstreamNonce(prompt),
        n: params.n || 1,
        size,
        ...(dimensions && !isCodexDirect
          ? { width: dimensions.width, height: dimensions.height }
          : {}),
        ...(normalizeQuality(params.quality)
          ? { quality: normalizeQuality(params.quality) }
          : {}),
        ...(normalizeModeration(params.moderation)
          ? { moderation: normalizeModeration(params.moderation) }
          : {}),
        ...(normalizeOutputFormat(params.outputFormat)
          ? { output_format: normalizeOutputFormat(params.outputFormat) }
          : {}),
        ...(normalizeOutputCompression(params.outputCompression) !== undefined
          ? {
              output_compression: normalizeOutputCompression(
                params.outputCompression
              ),
            }
          : {}),
        ...(background ? { background } : {}),
        ...(config.useStream ? { stream: true, partial_images: 2 } : {}),
        ...(isCodexDirect ? {} : { response_format: "b64_json" }),
      }),
    });

    return requireImageOutput(
      applyPromptOptimizationResultVisibility(
        await parseImageResponse(response, callbacks)
      )
    );
  } catch (error) {
    logImageRequestError(error, {
      operation: "generate",
      baseUrl: config.baseUrl,
      path: "/images/generations",
      model,
      useStream: config.useStream,
    });
    return {
      error: error instanceof Error ? error.message : "Unknown error occurred",
    };
  }
}

export async function editImage(
  config: ApiConfig,
  params: EditImageParams,
  callbacks?: ImageGenerationCallbacks
): Promise<GenerateImageResult> {
  if (config.backend?.groupBackendType === "web") {
    params = { ...params, model: DEFAULT_IMAGE_MODEL };
  }
  if (config.backend?.reportResult) {
    return retryPoolBackendResult(
      config,
      (candidate) => editImage(candidate, params, callbacks),
      {
        mixWebFirst: params.mixWebFirst,
        accountBackendPreference: params.requiresResponsesBackend
          ? "responses"
          : params.forceWebBackend
            ? "web"
            : undefined,
        accountBackendPreferenceMode: params.forceWebBackend
          ? "mixed-only"
          : undefined,
      }
    );
  }

  // pool-api 后端分发前确保输入图/ mask 已 re-host，避免把外链交给上游。
  await rehostApiBackendInputImages(
    config,
    { images: params.images, mask: params.mask },
    params.signal
  );

  const fireflyRewrite = reverseAdobeSourcedApiFirefly(
    config,
    params.model,
    params.size
  );
  if (fireflyRewrite) {
    // 反向转换后 size 改写一次，下游所有 params.size 读取（含 appendImageParams）即一致。
    params = { ...params, size: fireflyRewrite.size };
  }
  const model = fireflyRewrite?.model ?? getModel(config, params.model);
  const editPromptRefs = resolvePromptImageReferences({
    prompt: getEffectivePrompt(params),
    images: params.images,
  });
  const effectiveEditPrompt = editPromptRefs.prompt.replace(
    /current-reference-/g,
    "edit-reference-"
  );
  const paramsWithResolvedPrompt: EditImageParams = {
    ...params,
    prompt: effectiveEditPrompt,
    apiPrompt: effectiveEditPrompt,
  };
  if (isPoolAccountBackend(config, "web")) {
    return requireImageOutput(
      await editImageWithChatGptWeb(config, {
        ...paramsWithResolvedPrompt,
        model,
        gptModel: params.gptModel,
      })
    );
  }
  if (config.backend?.type === "pool-adobe") {
    return requireImageOutput(
      applyPromptOptimizationResultVisibility(
        await runAdobeImageRequest(config, {
          prompt: effectiveEditPrompt,
          model,
          size: params.size,
          quality: params.quality,
          images: params.images,
          signal: params.signal,
        })
      )
    );
  }
  // codex(pool-account responses)图生图:直连 JSON /images/edits(照 CPA codex 直连格式)。
  // 输入图/mask 用 images[].image_url / mask.image_url 的 base64 data URL,size 走顶层。
  // 注意 size 仍不被尊重:codex 上游忽略它(#19175,直连端点亦然),实测改图同样高比例返回
  // 非请求尺寸,详见 shouldCodexUseDirectImagesEndpoint。codex /images/edits 不接受 multipart
  // (400 Unsupported content type),也不认非标准 width/height 与 response_format
  // (b64_json 为默认返回),故均不发送。
  if (shouldCodexUseDirectImagesEndpoint(config)) {
    try {
      const size = params.size || DEFAULT_IMAGE_SIZE;
      const background = normalizeImageBackground(params.background);
      const toImageUrl = (file: { data: Buffer; type: string }) =>
        `data:${file.type || "image/png"};base64,${Buffer.from(
          file.data
        ).toString("base64")}`;
      const response = await fetch(`${config.baseUrl}/images/edits`, {
        method: "POST",
        redirect: "manual",
        signal: params.signal,
        headers: getHeaders(config, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          model,
          // 同生图：注入每请求唯一零宽 nonce 破上游内容缓存（仅上游请求体）。
          prompt: appendImagesUpstreamNonce(effectiveEditPrompt),
          n: params.n || 1,
          size,
          images: params.images.map((image) => ({
            image_url: toImageUrl(image),
          })),
          ...(params.mask
            ? { mask: { image_url: toImageUrl(params.mask) } }
            : {}),
          ...(normalizeQuality(params.quality)
            ? { quality: normalizeQuality(params.quality) }
            : {}),
          ...(normalizeModeration(params.moderation)
            ? { moderation: normalizeModeration(params.moderation) }
            : {}),
          ...(normalizeOutputFormat(params.outputFormat)
            ? { output_format: normalizeOutputFormat(params.outputFormat) }
            : {}),
          ...(normalizeOutputCompression(params.outputCompression) !== undefined
            ? {
                output_compression: normalizeOutputCompression(
                  params.outputCompression
                ),
              }
            : {}),
          ...(background ? { background } : {}),
          ...(config.useStream ? { stream: true, partial_images: 2 } : {}),
        }),
      });
      return requireImageOutput(
        applyPromptOptimizationResultVisibility(
          await parseImageResponse(response, callbacks)
        )
      );
    } catch (error) {
      logImageRequestError(error, {
        operation: "edit",
        baseUrl: config.baseUrl,
        path: "/images/edits",
        model,
        useStream: config.useStream,
      });
      return {
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      };
    }
  }
  // pool-api 的 responses 后端走 /responses;codex 图生图已在上面走直连 JSON /images/edits。
  if (isResponsesBackend(config)) {
    try {
      const gptModel =
        params.gptModel ||
        (await getDefaultImageGptModel(config, {
          allowPremiumModels: params.allowPremiumModels,
        }));
      // 单次转发：按 forceBase64 重建请求并提交。
      const attempt = (forceBase64: boolean) =>
        postResponsesImageRequestWithToolChoiceFallback(
          config,
          buildResponsesImageEditRequest(
            config,
            { ...paramsWithResolvedPrompt, model, gptModel },
            forceBase64
          ),
          { signal: params.signal },
          callbacks
        );

      let result = await attempt(false);
      // 一次性同后端兜底：上游下载我方输入图 URL 失败（如 407）且我方有字节，
      // 重发同一请求并把输入图与 mask 强制内联 base64。
      if (
        isImageDownloadUpstreamError(result.error) &&
        (hasInputImageBytes(paramsWithResolvedPrompt.images) ||
          paramsWithResolvedPrompt.mask?.data?.length)
      ) {
        logWarn("上游下载输入图失败，改用 base64 内联重试（responses 改图）", {
          baseUrl: config.baseUrl,
          model,
        });
        result = await attempt(true);
      }
      return requireImageOutput(
        applyPromptOptimizationResultVisibility(result)
      );
    } catch (error) {
      logImageRequestError(error, {
        operation: "edit",
        baseUrl: config.baseUrl,
        path: "/responses",
        model,
        useStream: config.useStream,
      });
      return {
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      };
    }
  }

  try {
    const prompt = effectiveEditPrompt;
    const formData = new FormData();
    appendImageParams(formData, config, {
      prompt,
      model,
      n: params.n,
      size: params.size,
      quality: params.quality,
      moderation: params.moderation,
      outputFormat: params.outputFormat,
      outputCompression: params.outputCompression,
      background: params.background,
      promptOptimization: params.promptOptimization,
    });

    for (const image of params.images) {
      formData.append(
        params.images.length === 1 ? "image" : "image[]",
        new Blob([toBlobPart(image.data)], { type: image.type }),
        image.name
      );
    }

    if (params.mask) {
      formData.append(
        "mask",
        new Blob([toBlobPart(params.mask.data)], { type: params.mask.type }),
        params.mask.name
      );
    }

    const response = await fetch(`${config.baseUrl}/images/edits`, {
      method: "POST",
      redirect: "manual",
      signal: params.signal,
      headers: getHeaders(config, {}),
      body: formData,
    });

    return requireImageOutput(
      applyPromptOptimizationResultVisibility(
        await parseImageResponse(response, callbacks)
      )
    );
  } catch (error) {
    logImageRequestError(error, {
      operation: "edit",
      baseUrl: config.baseUrl,
      path: "/images/edits",
      model,
      useStream: config.useStream,
    });
    return {
      error: error instanceof Error ? error.message : "Unknown error occurred",
    };
  }
}

export async function generateChatImage(
  config: ApiConfig,
  params: ChatImageParams,
  callbacks?: ImageGenerationCallbacks
): Promise<GenerateImageResult> {
  // 分组仅固定图片型号；顶层文本模型仍走统一白名单和套餐校验。
  if (config.backend?.groupBackendType === "web") {
    params = { ...params, imageModel: DEFAULT_IMAGE_MODEL };
  }
  if (config.backend?.reportResult) {
    return retryPoolBackendResult(
      config,
      (candidate) => generateChatImage(candidate, params, callbacks),
      {
        mixWebFirst: params.mixWebFirst,
        accountBackendPreference: params.requiresResponsesBackend
          ? "responses"
          : undefined,
      }
    );
  }

  const useImagesChatUpstream =
    config.backend?.chatCompletionsUpstreamMode === "images";
  if (
    useImagesChatUpstream &&
    (params.agentMode ||
      params.rawResponsesBody ||
      params.requiresResponsesBackend ||
      params.history?.length)
  ) {
    return {
      error:
        "Images Chat upstream mode only supports single-turn, non-Agent Chat requests.",
    };
  }

  // pool-api 后端分发前确保输入图/历史图已 re-host，避免把外链交给上游。
  await rehostApiBackendInputImages(
    config,
    { images: params.images, history: params.history },
    params.signal
  );

  const model = await getResponsesModel(config, params.model, {
    allowPremiumModels: params.allowPremiumModels,
  });
  if (useImagesChatUpstream) {
    return await generateChatImageWithImages(
      config,
      { ...params, model },
      callbacks
    );
  }
  if (isPoolAccountBackend(config, "web")) {
    const webPrompt =
      params.fileContext && params.promptOptimization === false
        ? `${params.prompt}\n\n${params.fileContext}`
        : params.prompt;
    const webApiPrompt = params.fileContext
      ? `${params.apiPrompt || params.prompt}\n\n${params.fileContext}`
      : params.apiPrompt;
    const webParams = {
      prompt: webPrompt,
      apiPrompt: webApiPrompt,
      promptOptimization: params.promptOptimization,
      history: params.history,
      size: params.size,
      model: params.imageModel || DEFAULT_IMAGE_MODEL,
      gptModel: model,
      thinking: params.thinking,
      quality: params.quality,
      n: params.n,
      moderation: params.moderation,
      outputFormat: params.outputFormat,
      outputCompression: params.outputCompression,
      background: params.background,
      files: params.files,
    };
    // 网页对话轮次:走 text-capable 路径(回文字、按需出图),不强制出图。
    if (params.webChat) {
      return chatWithChatGptWeb(config, webParams, params.images || []);
    }
    if (params.images?.length) {
      return editImageWithChatGptWeb(config, {
        ...webParams,
        images: params.images,
      });
    }
    return generateImageWithChatGptWeb(config, webParams);
  }
  if (
    config.backend?.chatCompletionsUpstreamMode === "chat_completions" &&
    !params.agentMode &&
    !params.rawResponsesBody
  ) {
    return await generateChatImageWithChatCompletions(
      config,
      { ...params, model },
      callbacks
    );
  }
  try {
    // 单次转发：按 forceBase64 重建 responses 输入并跑完整条 responses 路径（含 agent
    // 多轮 / 非 agent 单轮）。上游下载我方输入图 URL 失败（如 407）时，调用方据此用
    // base64 内联当前输入图重发一次（下载失败意味着尚未产出图/分块，重发安全）。
    const attempt = async (
      forceBase64: boolean
    ): Promise<GenerateImageResult> => {
      const currentBackendMember = getStickyBackendMember(config);
      const promptRefs = resolvePromptImageReferences({
        prompt: getEffectivePrompt(params),
        images: params.images,
        history: params.history,
        currentBackendMember,
      });
      const prompt = promptRefs.prompt;
      const size = params.size || DEFAULT_IMAGE_SIZE;
      const responsesPreviousResponseEnabled =
        shouldEnableResponsesPreviousResponse({
          settingEnabled: await getRuntimeSettingBoolean(
            "IMAGE_RESPONSES_PREVIOUS_RESPONSE_ENABLED",
            false
          ),
          rawResponsesBody: params.rawResponsesBody,
          currentBackendMember,
          files: params.files,
        });
      const {
        previousState: previousResponsesState,
        canUsePreviousResponseId,
      } = resolveResponsesNativeState({
        enabled: responsesPreviousResponseEnabled,
        currentBackendMember,
        history: params.history,
      });
      const responseImageRoundIndex = getNextAssistantImageRoundIndex(
        params.history
      );
      const generatedImageReferenceInstruction =
        buildGeneratedImageReferenceInstruction({
          roundIndex: responseImageRoundIndex,
        });
      const manualHistoryInput = buildResponsesInput(
        prompt,
        params.images,
        params.files,
        params.history,
        {
          extraCurrentImageReferences: promptRefs.historyImageReferences,
          generatedImageReferenceInstruction,
          currentBackendMember,
          forceBase64,
        }
      );
      const input = canUsePreviousResponseId
        ? [
            {
              role: "user" as const,
              content: buildCurrentResponsesContent(
                prompt,
                params.images,
                params.files,
                {
                  extraImageReferences: promptRefs.historyImageReferences,
                  generatedImageReferenceInstruction,
                  forceBase64,
                }
              ),
            },
          ]
        : manualHistoryInput;
      // 分层生成:agent 模式下走专用"生成即分层"指令(先出整图、逐层生成)。
      const useLayered = Boolean(params.agentMode && params.layeredGeneration);
      const baseInstructions = useLayered
        ? LAYERED_RESPONSES_IMAGE_INSTRUCTIONS
        : params.promptOptimization === false
          ? params.agentMode
            ? ORIGINAL_PROMPT_RESPONSES_IMAGE_INSTRUCTIONS
            : ORIGINAL_PROMPT_CHAT_RESPONSES_IMAGE_INSTRUCTIONS
          : params.agentMode
            ? DEFAULT_RESPONSES_IMAGE_INSTRUCTIONS
            : DEFAULT_CHAT_RESPONSES_IMAGE_INSTRUCTIONS;
      const instructions =
        withResponsesImageReferenceInstructions(baseInstructions);
      const tool: {
        type: "image_generation";
        action: "auto";
        model?: string;
        partial_images?: number;
        size?: string;
        quality?: ImageQuality;
        moderation?: ImageModeration;
        output_format?: ImageOutputFormat;
        output_compression?: number;
        background?: string;
      } = {
        type: "image_generation",
        action: "auto",
        partial_images: 2,
      };

      const toolModel = getUpstreamImageModel(
        getImageModel(params.imageModel) || DEFAULT_IMAGE_MODEL
      );
      if (toolModel) {
        tool.model = toolModel;
      }
      if (size && size !== AUTO_IMAGE_SIZE) {
        tool.size = size;
      }
      const quality = normalizeQuality(params.quality);
      if (quality) tool.quality = quality;
      const moderation = normalizeModeration(params.moderation);
      if (moderation) tool.moderation = moderation;
      const outputFormat = normalizeOutputFormat(params.outputFormat);
      if (outputFormat) tool.output_format = outputFormat;
      const outputCompression = normalizeOutputCompression(
        params.outputCompression
      );
      if (outputCompression !== undefined) {
        tool.output_compression = outputCompression;
      }
      const background = normalizeImageBackground(params.background);
      if (background) tool.background = background;

      const thinking = normalizeThinking(params.thinking, model);
      const reasoning: ReasoningConfig | undefined = thinking
        ? { effort: thinking, summary: "concise" }
        : undefined;

      const stream = Boolean(params.stream || config.useStream);
      const defaultAdditionalTools = params.agentMode
        ? createDefaultAgentAdditionalTools()
        : [];
      const promptCacheKey = buildOpenAIPromptCacheKey(config, {
        scope: params.agentMode ? "responses-agent" : "responses-chat",
        model,
        imageModel: toolModel,
        agentMode: params.agentMode,
        promptOptimization: params.promptOptimization,
        toolSignature: responseToolCacheSignature({
          tool,
          additionalTools: defaultAdditionalTools,
        }),
        inputSignature: buildPromptCacheSalt(),
      });
      const requestBody: ResponsesStreamRequestBody =
        params.rawResponsesBody && isPlainRecord(params.rawResponsesBody)
          ? normalizeResponsesImageRequestBody(params.rawResponsesBody, {
              model,
              fallbackTool: tool,
              additionalTools: defaultAdditionalTools,
              instructions,
              stream,
            })
          : {
              model,
              input,
              tools: [tool, ...defaultAdditionalTools],
              instructions,
              store: responsesPreviousResponseEnabled,
              prompt_cache_key: promptCacheKey,
              ...(canUsePreviousResponseId
                ? { previous_response_id: previousResponsesState?.responseId }
                : {}),
              ...(reasoning ? { reasoning } : {}),
              ...(stream ? { stream: true } : {}),
            };

      let result: ResponsesResultWithOutput | undefined;
      if (params.agentMode && !params.rawResponsesBody) {
        // 分层生成需"整图 + 背景 + 每个元素"各一轮,层数由模型规划、事先未知,用上限轮数(8)给足,
        // 让其逐层跑完(模型生成完最后一层不再调 continue_generation 会自行提前停),避免被用户的小
        // 轮数(默认 3)截断而丢层(如"没有狗")。分层也不强制跑满轮数(否则会硬凑出多余层)。
        const maxRounds = useLayered
          ? 8
          : normalizeAgentMaxRounds(params.agentMaxRounds) ||
            (await getAgentMaxRounds());
        const forceMaxRounds = useLayered
          ? false
          : (params.agentForceMaxRounds ?? (await getAgentForceMaxRounds()));
        const roundResults: ResponsesResultWithOutput[] = [];
        let nextInput = input;
        let agentPreviousResponseEnabled = responsesPreviousResponseEnabled;
        let agentPreviousResponseId = canUsePreviousResponseId
          ? previousResponsesState?.responseId
          : undefined;
        const disableAgentNativeState = () => {
          agentPreviousResponseEnabled = false;
          agentPreviousResponseId = undefined;
        };

        for (let round = 1; round <= maxRounds; round += 1) {
          const roundRequestBody: ResponsesStreamRequestBody = {
            ...requestBody,
            input: nextInput,
            store: agentPreviousResponseEnabled,
            previous_response_id: agentPreviousResponseEnabled
              ? agentPreviousResponseId
              : undefined,
            instructions:
              round === 1
                ? requestBody.instructions
                : `${requestBody.instructions || instructions}\n\n${
                    useLayered
                      ? LAYERED_CONTINUE_INSTRUCTIONS
                      : AGENT_CONTINUE_INSTRUCTIONS
                  }`,
          };
          await emitAgentProgress(callbacks, {
            kind: "message",
            status: "started",
            title: `Agent 第 ${round} 轮开始`,
            detail:
              round === 1
                ? "分析请求并按需调用工具"
                : "根据上一版结果继续判断是否迭代",
            timestamp: new Date().toISOString(),
          });

          await emitAgentRoundRequestStatus(callbacks, {
            round,
            status: "running",
            detail: "已发送请求，等待模型返回工具调用、文本或图片",
          });
          const roundRequestTracker = createAgentRoundRequestTracker(
            callbacks,
            round
          );
          const roundCallbacks = roundRequestTracker.wrapCallbacks();
          let roundResult: ResponsesResultWithOutput;
          try {
            roundResult = await fetchAgentRoundResponses({
              config,
              requestBody: roundRequestBody,
              signal: params.signal,
              stream,
              callbacks: roundCallbacks,
              storeFalseFallbackInput: manualHistoryInput,
              onStoreDisabledFallback: disableAgentNativeState,
            });
            if (
              round === 1 &&
              roundResult.error &&
              canUsePreviousResponseId &&
              isPreviousResponseStateError(roundResult.error)
            ) {
              agentPreviousResponseId = undefined;
              roundResult = await fetchAgentRoundResponses({
                config,
                requestBody: {
                  ...roundRequestBody,
                  input: manualHistoryInput,
                  previous_response_id: undefined,
                },
                signal: params.signal,
                stream,
                callbacks: roundCallbacks,
                storeFalseFallbackInput: manualHistoryInput,
                onStoreDisabledFallback: disableAgentNativeState,
              });
            }
            if (
              round === 1 &&
              agentPreviousResponseEnabled &&
              roundResult.error &&
              isResponsesStoreUnsupportedError(roundResult.error)
            ) {
              disableAgentNativeState();
              roundResult = await fetchAgentRoundResponses({
                config,
                requestBody: {
                  ...roundRequestBody,
                  input: manualHistoryInput,
                  previous_response_id: undefined,
                  store: false,
                },
                signal: params.signal,
                stream,
                callbacks: roundCallbacks,
                storeFalseFallbackInput: manualHistoryInput,
                onStoreDisabledFallback: disableAgentNativeState,
              });
            }
            if (
              round > 1 &&
              agentPreviousResponseEnabled &&
              roundResult.error &&
              shouldRetryAgentRoundWithManualHistory(roundResult.error)
            ) {
              await emitAgentDecision(callbacks, {
                status: "completed",
                title: "Agent 上下文重试",
                detail:
                  "上游原生会话状态返回异常，已改用手动历史和上一版图片重试当前轮",
              });
              disableAgentNativeState();
              roundResult = await fetchAgentRoundResponses({
                config,
                requestBody: {
                  ...roundRequestBody,
                  input: buildAgentContinuationInput({
                    baseInput: input,
                    previousResult: mergeGenerateImageResults(roundResults),
                    currentRound: round - 1,
                    maxRounds,
                    outputFormat,
                    historyRoundIndex: responseImageRoundIndex,
                    includeImageEntities: true,
                  }),
                  previous_response_id: undefined,
                  store: false,
                },
                signal: params.signal,
                stream,
                callbacks: roundCallbacks,
                onStoreDisabledFallback: disableAgentNativeState,
              });
            }
          } catch (error) {
            roundResult = {
              error:
                error instanceof Error
                  ? error.message
                  : "Unknown error occurred",
            };
          }
          await roundRequestTracker.finish({ error: roundResult.error });
          roundResults.push(roundResult);
          if (roundResult.responsesStoreDisabledFallback) {
            disableAgentNativeState();
          }
          if (
            agentPreviousResponseEnabled &&
            !roundResult.responsesStoreDisabledFallback &&
            roundResult.responseId
          ) {
            agentPreviousResponseId = roundResult.responseId;
          }

          if (roundResult.error) {
            if (roundResults.slice(0, -1).some(hasAgentImage)) {
              const partial = mergeGenerateImageResults(
                roundResults.slice(0, -1)
              );
              // 续轮遇到"可切换"上游错误(如 token 失效/限流/账号不可用)时,上抛 error,交由外层
              // retryPoolBackendResult 换号重跑整个 agent(多轮任务如分层尤其需要:否则只会停在
              // 第一轮)。同时保留已产出的图,池子彻底耗尽时仍把这版返回。非切换类错误(如内容审核)
              // 维持原"保留上一版、不重试"语义。
              if (isImageBackendSwitchableError(roundResult.error)) {
                await emitAgentProgress(callbacks, {
                  kind: "message",
                  status: "failed",
                  title: `Agent 第 ${round} 轮失败`,
                  detail: `后续迭代上游错误，尝试切换账号重试：${roundResult.error}`,
                  timestamp: new Date().toISOString(),
                });
                result = {
                  ...partial,
                  error: roundResult.error,
                  upstreamResetAt: roundResult.upstreamResetAt,
                  retryAfterSeconds: roundResult.retryAfterSeconds,
                  partialAgentError: roundResult.error,
                };
                break;
              }
              await reportPoolBackendResult(config, {
                error: roundResult.error,
                upstreamResetAt: roundResult.upstreamResetAt,
                retryAfterSeconds: roundResult.retryAfterSeconds,
              });
              await emitAgentProgress(callbacks, {
                kind: "message",
                status: "failed",
                title: `Agent 第 ${round} 轮停止`,
                detail: `后续迭代失败，已保留上一版图片：${roundResult.error}`,
                timestamp: new Date().toISOString(),
              });
              result = {
                ...partial,
                partialAgentError: roundResult.error,
              };
              break;
            }
            result = mergeGenerateImageResults(roundResults);
            break;
          }

          await emitAgentProgress(callbacks, {
            kind: "message",
            status: "completed",
            title: `Agent 第 ${round} 轮完成`,
            detail: hasAgentImage(roundResult)
              ? "已生成图片，正在判断是否继续"
              : "未生成图片，继续推动执行",
            timestamp: new Date().toISOString(),
          });

          const continueCalls = getContinueGenerationFunctionCalls(
            roundResult.outputItems
          );
          const continueFunctionCallItems =
            buildContinueGenerationFunctionCallItems({
              outputItems: roundResult.outputItems,
              includeFunctionCallInputs: !agentPreviousResponseEnabled,
            });
          const continueReason = continueCalls
            .map((call) => call.reason)
            .find((reason): reason is string => Boolean(reason));
          const shouldForceContinue = forceMaxRounds && round < maxRounds;
          if (continueCalls.length > 0) {
            await emitAgentProgress(callbacks, {
              kind: "tool",
              status: "completed",
              title: "Agent 请求继续",
              detail: continueReason,
              timestamp: new Date().toISOString(),
              toolType: "continue_generation",
            });
          } else if (forceMaxRounds) {
            await emitAgentDecision(callbacks, {
              status: "completed",
              title: shouldForceContinue
                ? "Agent 强制继续"
                : "Agent 强制轮数完成",
              detail: shouldForceContinue
                ? `系统已开启强制迭代，将继续执行第 ${round + 1} 轮`
                : `已完成强制迭代轮数 ${maxRounds}`,
            });
          }

          if (round >= maxRounds) {
            if (continueCalls.length > 0) {
              await emitAgentDecision(callbacks, {
                status: "completed",
                title: "Agent 最大轮数完成",
                detail: `模型请求继续，但已达到最大轮数 ${maxRounds}`,
              });
            }
            result = mergeGenerateImageResults(roundResults);
            break;
          }

          if (hasAgentImage(roundResult)) {
            if (continueCalls.length === 0 && !shouldForceContinue) {
              await emitAgentDecision(callbacks, {
                status: "completed",
                title: "Agent 自检完成",
                detail: "模型未请求继续，已停止迭代",
              });
              result = mergeGenerateImageResults(roundResults);
              break;
            }
            nextInput = buildAgentContinuationInput({
              baseInput: agentPreviousResponseEnabled ? [] : input,
              previousResult: mergeGenerateImageResults(roundResults),
              currentRound: round,
              maxRounds,
              outputFormat,
              historyRoundIndex: responseImageRoundIndex,
              includeImageEntities: !agentPreviousResponseEnabled,
              functionCallItems: continueFunctionCallItems,
            });
            continue;
          }

          if (
            roundResults.some(hasAgentImage) &&
            continueCalls.length === 0 &&
            !shouldForceContinue
          ) {
            await emitAgentDecision(callbacks, {
              status: "completed",
              title: "Agent 自检完成",
              detail: "模型未请求继续，已停止迭代",
            });
            result = mergeGenerateImageResults(roundResults);
            break;
          }

          const textOnly = Boolean(
            roundResult.responseText?.trim() ||
              roundResult.responseAgent?.trim()
          );
          if (!textOnly) {
            result = mergeGenerateImageResults(roundResults);
            break;
          }

          nextInput = buildAgentContinuationInput({
            baseInput: agentPreviousResponseEnabled ? [] : input,
            previousResult: mergeGenerateImageResults(roundResults),
            currentRound: round,
            maxRounds,
            outputFormat,
            historyRoundIndex: responseImageRoundIndex,
            includeImageEntities: !agentPreviousResponseEnabled,
            functionCallItems: continueFunctionCallItems,
          });
        }

        if (!result) {
          result = mergeGenerateImageResults(roundResults);
        }
        const completedRounds =
          result.agentRoundCount ||
          roundResults.filter((item) => !item.error).length;
        const finalAgentEvent: AgentRunEvent = {
          kind: "message",
          status: result.error ? "failed" : "completed",
          title: result.error ? "Agent 执行失败" : "Agent 执行完成",
          detail: result.error
            ? result.error
            : `已完成 ${completedRounds || roundResults.length} 轮 Agent 执行`,
          timestamp: new Date().toISOString(),
        };
        await emitAgentProgress(callbacks, finalAgentEvent);
        result = {
          ...result,
          agentEvents: mergeAgentEvents(result.agentEvents, [finalAgentEvent]),
        };
      } else {
        result = await fetchResponsesWithPreviousResponseFallback(
          config,
          requestBody,
          manualHistoryInput,
          {
            signal: params.signal,
            stream,
            previousResponseUsed: canUsePreviousResponseId,
          },
          callbacks
        );
      }

      if (!result) {
        result = { error: "API returned no image data" };
      }

      if (params.agentMode && params.rawResponsesBody) {
        const unsupportedTools = getUnsupportedToolTypes(result);
        if (unsupportedTools.size > 0) {
          result = await fetchAgentRoundResponses({
            config,
            requestBody,
            signal: params.signal,
            stream,
            callbacks,
          });
        }
      }

      const resultWithNativeState = attachResponsesPreviousResponseState(
        config,
        result,
        responsesPreviousResponseEnabled
      );
      if (resultWithNativeState.responsesPreviousResponse) {
        await bindImageBackendStickyMember({
          layer: "previous_response_id",
          key: resultWithNativeState.responsesPreviousResponse.responseId,
          member: resultWithNativeState.responsesPreviousResponse.backendMember,
          metadata: {
            source: params.agentMode ? "responses-agent" : "responses-chat",
          },
        });
      }
      return applyPromptOptimizationResultVisibility(resultWithNativeState);
    };

    let result = await attempt(false);
    // 一次性同后端兜底：上游下载我方当前输入图 URL 失败（如 407）且我方有字节，
    // 用 base64 内联当前输入图重发同一请求（仅限 responses 聊天/agent 路径）。
    if (
      isImageDownloadUpstreamError(result.error) &&
      hasInputImageBytes(params.images)
    ) {
      logWarn(
        "上游下载输入图失败，改用 base64 内联重试（responses 聊天/agent）",
        {
          baseUrl: config.baseUrl,
          model,
        }
      );
      result = await attempt(true);
    }
    return result;
  } catch (error) {
    logImageRequestError(error, {
      operation: "chat",
      baseUrl: config.baseUrl,
      path: "/responses",
      model,
      useStream: config.useStream,
    });
    return {
      error: error instanceof Error ? error.message : "Unknown error occurred",
    };
  }
}
