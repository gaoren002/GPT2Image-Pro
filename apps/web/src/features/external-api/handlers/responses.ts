import { db } from "@repo/database";
import { generation } from "@repo/database/schema";
import { withApiLogging } from "@repo/shared/api-logger";
import {
  canUsePlanCapability,
  getPlanLimits,
} from "@repo/shared/subscription/services/plan-capabilities";
import { logError } from "@repo/shared/logger";
import { getUserPlan } from "@repo/shared/subscription/services/user-plan";
import { and, desc, eq, sql } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { authenticateExternalApiRequest } from "@/features/external-api/auth";
import {
  fetchPublicImage,
  readResponseBytesWithLimit,
} from "@/features/external-api/safe-image-fetch";
import {
  createExternalImageStreamResponse,
  createJsonKeepAliveResponse,
  getImageBase64,
  openAIImageError,
  toOpenAIErrorPayload,
  toOpenAIResponseImageItem,
  toOpenAIResponseTextItem,
  wantsImageStreamResponse,
} from "@/features/external-api/images";
import { isExternalResponsesImageModelAllowed } from "@/features/external-api/models";
import { runImageGenerationForUser } from "@/features/image-generation/operations";
import { bindImageBackendStickyMember } from "@/features/image-backend-pool/service";
import {
  normalizeOutputCompression,
  normalizeOutputFormat,
} from "@/features/image-generation/output-format";
import {
  alignImageSizeToStep,
  DEFAULT_IMAGE_SIZE,
  getImageModel,
  validateImageSize,
} from "@/features/image-generation/resolution";
import {
  DEFAULT_MAX_IMAGE_BYTES,
  uploadTemporaryImageUrls,
} from "@/features/image-generation/request-utils";
import type {
  ChatGptWebConversationState,
  ChatHistoryMessage,
  ImageInputFile,
  ImageModeration,
  ImageOutputFormat,
  ImageQuality,
  StickyBackendMemberState,
  ThinkingLevel,
} from "@/features/image-generation/types";

type ImageGenerationResult = Awaited<
  ReturnType<typeof runImageGenerationForUser>
>;

type StoredResponsesContinuation = {
  webConversation?: ChatGptWebConversationState;
  backendMember?: StickyBackendMemberState;
  fallbackHistory?: ChatHistoryMessage[];
};

const CONTINUATION_CACHE_LIMIT = 1000;
const MAX_STORED_HISTORY_MESSAGES = 24;
const MAX_STORED_HISTORY_TEXT = 4000;
const responseContinuationCache = new Map<string, StoredResponsesContinuation>();

const responseInputContentSchema = z.union([
  z.object({
    type: z.enum(["input_text", "output_text"]),
    text: z.string(),
  }),
  z.object({
    type: z.literal("input_image"),
    image_url: z.string(),
  }),
]);

const responseInputMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system", "developer"]).optional(),
  content: z.union([z.string(), z.array(responseInputContentSchema)]),
});

const responseSchema = z.object({
  model: z.string().optional(),
  input: z.union([z.string(), z.array(responseInputMessageSchema)]),
  previous_response_id: z.string().optional(),
  prompt_cache_key: z.string().optional(),
  tools: z.array(z.object({ type: z.string() }).passthrough()).optional(),
  tool_choice: z.unknown().optional(),
  stream: z.boolean().optional(),
  store: z.boolean().optional(),
  size: z
    .string()
    .transform(alignImageSizeToStep)
    .optional()
    .refine((value) => !value || validateImageSize(value).valid, {
      message: "Invalid image size",
    }),
  quality: z.enum(["auto", "low", "medium", "high", "xhigh", "max"]).optional(),
  moderation: z.enum(["auto", "low"]).optional(),
  output_format: z.enum(["png", "jpeg", "webp"]).optional(),
  output_compression: z.number().int().min(0).max(100).optional(),
  background: z.enum(["transparent", "opaque", "auto"]).optional(),
  transparentMatte: z.boolean().optional(),
  transparent_matte: z.boolean().optional(),
  // 审核改写重试开关(issue #24):传 false 时,审核拦截后不自动改写提示词重试,直接返回真实错误。
  promptRepair: z.boolean().optional(),
  prompt_repair: z.boolean().optional(),
  reasoning: z
    .object({
      effort: z
        .enum(["minimal", "none", "low", "medium", "high", "xhigh"])
        .optional(),
    })
    .passthrough()
    .optional(),
}).passthrough();

type ResponseRequest = z.infer<typeof responseSchema>;

function responseId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function continuationCacheKey(params: {
  userId: string;
  apiKeyId: string;
  responseId: string;
}) {
  return `${params.userId}:${params.apiKeyId}:${params.responseId}`;
}

function setContinuationCache(
  key: string,
  value: StoredResponsesContinuation
) {
  responseContinuationCache.set(key, value);
  if (responseContinuationCache.size <= CONTINUATION_CACHE_LIMIT) return;
  const oldestKey = responseContinuationCache.keys().next().value;
  if (oldestKey) responseContinuationCache.delete(oldestKey);
}

function normalizeWebConversationState(
  value: unknown
): ChatGptWebConversationState | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.conversationId !== "string" ||
    typeof value.parentMessageId !== "string"
  ) {
    return undefined;
  }
  return {
    conversationId: value.conversationId,
    parentMessageId: value.parentMessageId,
    accountId: typeof value.accountId === "string" ? value.accountId : undefined,
  };
}

function normalizeBackendMemberState(
  value: unknown
): StickyBackendMemberState | undefined {
  if (!isRecord(value)) return undefined;
  const type = value.type === "api" || value.type === "account" ? value.type : null;
  if (!type || typeof value.id !== "string" || !value.id.trim()) {
    return undefined;
  }
  return {
    type,
    id: value.id,
    groupId:
      typeof value.groupId === "string"
        ? value.groupId
        : value.groupId === null
          ? null
          : undefined,
    accountBackend:
      value.accountBackend === "web" || value.accountBackend === "responses"
        ? value.accountBackend
        : undefined,
  };
}

function normalizeHistoryVariant(value: unknown) {
  if (!isRecord(value)) return null;
  const webConversation = normalizeWebConversationState(value.webConversation);
  const backendMember = normalizeBackendMemberState(value.backendMember);
  const responsesPreviousResponse = isRecord(value.responsesPreviousResponse)
    ? {
        responseId:
          typeof value.responsesPreviousResponse.responseId === "string"
            ? value.responsesPreviousResponse.responseId
            : "",
        backendMember: normalizeBackendMemberState(
          value.responsesPreviousResponse.backendMember
        ),
        store: value.responsesPreviousResponse.store === true,
        createdAt:
          typeof value.responsesPreviousResponse.createdAt === "string"
            ? value.responsesPreviousResponse.createdAt
            : undefined,
      }
    : null;
  return {
    text:
      typeof value.text === "string"
        ? value.text.slice(0, MAX_STORED_HISTORY_TEXT)
        : undefined,
    imageUrl:
      typeof value.imageUrl === "string"
        ? value.imageUrl.slice(0, MAX_STORED_HISTORY_TEXT)
        : undefined,
    size: typeof value.size === "string" ? value.size : undefined,
    timestamp:
      typeof value.timestamp === "string" ? value.timestamp : undefined,
    webConversation,
    backendMember,
    responsesPreviousResponse:
      responsesPreviousResponse?.responseId &&
      responsesPreviousResponse.backendMember &&
      responsesPreviousResponse.store
        ? {
            responseId: responsesPreviousResponse.responseId,
            backendMember: responsesPreviousResponse.backendMember,
            store: true as const,
            createdAt: responsesPreviousResponse.createdAt,
          }
        : undefined,
  };
}

function normalizeStoredHistory(value: unknown): ChatHistoryMessage[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_STORED_HISTORY_MESSAGES).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const role = entry.role === "assistant" ? "assistant" : "user";
    const variants = Array.isArray(entry.variants)
      ? entry.variants
          .map(normalizeHistoryVariant)
          .filter((item): item is NonNullable<typeof item> => Boolean(item))
          .slice(0, 10)
      : undefined;
    return [
      {
        role,
        text:
          typeof entry.text === "string"
            ? entry.text.slice(0, MAX_STORED_HISTORY_TEXT)
            : undefined,
        imageUrls: Array.isArray(entry.imageUrls)
          ? entry.imageUrls
              .filter((url): url is string => typeof url === "string")
              .filter((url) => url.startsWith("http://") || url.startsWith("https://"))
              .slice(0, 16)
          : undefined,
        variants,
        activeVariant:
          typeof entry.activeVariant === "number" ? entry.activeVariant : 0,
        error: typeof entry.error === "string" ? entry.error : undefined,
      },
    ] satisfies ChatHistoryMessage[];
  });
}

function getStoredContinuationFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
  params: { responseId: string; apiKeyId: string }
): StoredResponsesContinuation | null {
  if (!isRecord(metadata)) return null;
  const externalResponse = metadata.externalResponse;
  if (!isRecord(externalResponse)) return null;
  if (
    externalResponse.responseId !== params.responseId ||
    externalResponse.apiKeyId !== params.apiKeyId
  ) {
    return null;
  }
  const webConversation = normalizeWebConversationState(
    externalResponse.webConversation
  );
  const backendMember = normalizeBackendMemberState(
    externalResponse.backendMember
  );
  const fallbackHistory = normalizeStoredHistory(
    externalResponse.fallbackHistory
  );
  if (!webConversation && !backendMember && !fallbackHistory.length) {
    return null;
  }
  return {
    webConversation,
    backendMember,
    fallbackHistory: fallbackHistory.length ? fallbackHistory : undefined,
  };
}

async function getStoredResponsesContinuation(params: {
  userId: string;
  apiKeyId: string;
  responseId?: string;
}) {
  if (!params.responseId) return null;
  const key = continuationCacheKey({
    userId: params.userId,
    apiKeyId: params.apiKeyId,
    responseId: params.responseId,
  });
  const cached = responseContinuationCache.get(key);
  if (cached) return cached;

  const rows = await db
    .select({ metadata: generation.metadata })
    .from(generation)
    .where(
      and(
        eq(generation.userId, params.userId),
        sql`${generation.metadata}::jsonb @> ${JSON.stringify({
          externalResponse: {
            responseId: params.responseId,
            apiKeyId: params.apiKeyId,
          },
        })}::jsonb`
      )
    )
    .orderBy(desc(generation.createdAt))
    .limit(1);
  const state = getStoredContinuationFromMetadata(rows[0]?.metadata, {
    responseId: params.responseId,
    apiKeyId: params.apiKeyId,
  });
  if (state) setContinuationCache(key, state);
  return state;
}

async function getPromptCacheBackendMember(params: {
  userId: string;
  apiKeyId: string;
  promptCacheKey?: string;
}) {
  const promptCacheKey = params.promptCacheKey?.trim();
  if (!promptCacheKey) return undefined;
  const rows = await db
    .select({ metadata: generation.metadata })
    .from(generation)
    .where(
      and(
        eq(generation.userId, params.userId),
        sql`${generation.metadata}::jsonb @> ${JSON.stringify({
          externalResponse: {
            apiKeyId: params.apiKeyId,
            promptCacheKey,
          },
        })}::jsonb`
      )
    )
    .orderBy(desc(generation.createdAt))
    .limit(1);
  const metadata = rows[0]?.metadata;
  if (!isRecord(metadata) || !isRecord(metadata.externalResponse)) {
    return undefined;
  }
  return normalizeBackendMemberState(metadata.externalResponse.backendMember);
}

function withWebContinuationMarker(
  history: ChatHistoryMessage[],
  webConversation?: ChatGptWebConversationState
) {
  if (!webConversation) return history;
  return [
    ...history,
    {
      role: "assistant" as const,
      variants: [{ webConversation }],
      activeVariant: 0,
    },
  ];
}

function trimHistoryForStorage(history: ChatHistoryMessage[]) {
  return normalizeStoredHistory(history).slice(-MAX_STORED_HISTORY_MESSAGES);
}

function storableImageUrl(url: string) {
  return url.startsWith("http://") || url.startsWith("https://");
}

function buildFallbackHistoryForStorage(params: {
  baseHistory: ChatHistoryMessage[];
  prompt: string;
  promptImageUrls: string[];
  result: ImageGenerationResult;
}) {
  const promptImageUrls = params.promptImageUrls.filter(storableImageUrl);
  const assistantVariant = {
    text: params.result.responseText,
    imageUrl: params.result.imageUrl,
    size: params.result.size,
    timestamp: new Date().toISOString(),
    webConversation: params.result.webConversation,
    backendMember: params.result.backendMember,
    responsesPreviousResponse: params.result.responsesPreviousResponse,
  };
  return trimHistoryForStorage([
    ...params.baseHistory,
    {
      role: "user",
      text: params.prompt,
      imageUrls: promptImageUrls.length ? promptImageUrls : undefined,
    },
    {
      role: "assistant",
      text: params.result.responseText || "",
      variants: [assistantVariant],
      activeVariant: 0,
    },
  ]);
}

async function storeResponsesContinuation(params: {
  userId: string;
  apiKeyId: string;
  responseId: string;
  previousResponseId?: string;
  promptCacheKey?: string;
  result: ImageGenerationResult;
  fallbackHistory: ChatHistoryMessage[];
}) {
  if (!params.result.generationId) return;
  const state: StoredResponsesContinuation = {
    webConversation: params.result.webConversation,
    backendMember: params.result.responsesPreviousResponse?.backendMember ??
      params.result.backendMember,
    fallbackHistory: params.fallbackHistory,
  };
  try {
    await db
      .update(generation)
      .set({
        metadata: sql`COALESCE(${generation.metadata}, '{}'::json)::jsonb || ${JSON.stringify(
          {
            externalResponse: {
              responseId: params.responseId,
              previousResponseId: params.previousResponseId || null,
              promptCacheKey: params.promptCacheKey || null,
              apiKeyId: params.apiKeyId,
              endpoint: "responses",
              hasWebConversation: Boolean(params.result.webConversation),
              webConversation: params.result.webConversation || null,
              backendMember:
                params.result.responsesPreviousResponse?.backendMember ||
                params.result.backendMember ||
                null,
              fallbackHistory: params.fallbackHistory,
              storedAt: new Date().toISOString(),
            },
          }
        )}::jsonb`,
      })
      .where(
        and(
          eq(generation.id, params.result.generationId),
          eq(generation.userId, params.userId)
        )
      );
    if (state.webConversation || state.fallbackHistory?.length) {
      setContinuationCache(
        continuationCacheKey({
          userId: params.userId,
          apiKeyId: params.apiKeyId,
          responseId: params.responseId,
        }),
        state
      );
    }
  } catch (error) {
    logError(error, {
      source: "external-responses-continuation",
      responseId: params.responseId,
      generationId: params.result.generationId,
    });
  }
}

function getContentText(
  content: string | z.infer<typeof responseInputContentSchema>[]
) {
  if (typeof content === "string") return content;
  return content
    .filter((item) => item.type === "input_text" || item.type === "output_text")
    .map((item) => ("text" in item ? item.text : ""))
    .join("\n")
    .trim();
}

function getContentImages(
  content: string | z.infer<typeof responseInputContentSchema>[]
) {
  if (typeof content === "string") return [];
  return content
    .filter((item) => item.type === "input_image")
    .map((item) => ("image_url" in item ? item.image_url : ""))
    .filter(Boolean);
}

function inputToChatParams(input: ResponseRequest["input"]) {
  if (typeof input === "string") {
    return {
      prompt: input,
      history: [] as ChatHistoryMessage[],
      promptImageUrls: [] as string[],
    };
  }

  const history: ChatHistoryMessage[] = [];
  let prompt = "";
  let promptImages: string[] = [];

  const flushPromptToHistory = () => {
    if (!prompt && !promptImages.length) return;
    history.push({ role: "user", text: prompt, imageUrls: promptImages });
    prompt = "";
    promptImages = [];
  };

  for (const item of input) {
    const role = item.role || "user";
    const text = getContentText(item.content);
    const imageUrls = getContentImages(item.content);

    if (role === "assistant") {
      flushPromptToHistory();
      history.push({ role: "assistant", text });
      continue;
    }

    if (role === "user") {
      flushPromptToHistory();
      prompt = text;
      promptImages = imageUrls;
    }
  }

  return {
    prompt: prompt.trim(),
    history,
    promptImageUrls: promptImages,
  };
}

function parseDataImageUrl(url: string): ImageInputFile | null {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(url);
  if (!match) return null;
  return {
    data: Buffer.from(match[2] || "", "base64"),
    name: "response-input-image.png",
    type: match[1] || "image/png",
    url,
  };
}

async function imageUrlToInputFile(
  imageUrl: string,
  index: number,
  options?: { userId?: string; requestId?: string }
): Promise<ImageInputFile | null> {
  if (imageUrl.startsWith("data:image/")) {
    return parseDataImageUrl(imageUrl);
  }
  if (!imageUrl.startsWith("http://") && !imageUrl.startsWith("https://")) {
    return null;
  }

  const response = await fetchPublicImage(imageUrl);
  if (!response.ok) {
    throw new Error(`Failed to load input image: ${response.status}`);
  }
  const type = response.headers.get("content-type") || "image/png";
  if (!type.startsWith("image/")) return null;
  // 流式读取并在累计超 25MB 时主动 abort：此前完全无上限，巨大响应可逼近 OOM。
  // content-length 头可伪造，必须按真实字节累计判断。
  const data = await readResponseBytesWithLimit(
    response,
    DEFAULT_MAX_IMAGE_BYTES,
    () => {
      throw new Error("Input image exceeds the 25MB limit.");
    }
  );
  const file = new File([data], `response-input-image-${index + 1}`, { type });
  const uploaded = options?.userId
    ? await uploadTemporaryImageUrls(options.userId, options.requestId || "responses", [
        file,
      ])
    : undefined;

  return {
    data,
    name: `response-input-image-${index + 1}`,
    type,
    url: uploaded?.[0]?.url || imageUrl,
    storageBucket: uploaded?.[0]?.bucket,
    storageKey: uploaded?.[0]?.key,
  };
}

async function inputImageUrlsToFiles(
  imageUrls: string[],
  options?: { userId?: string; requestId?: string }
) {
  const files = await Promise.all(
    imageUrls.map((imageUrl, index) =>
      imageUrlToInputFile(imageUrl, index, options)
    )
  );
  return files.filter((file): file is ImageInputFile => Boolean(file));
}

function hasImageGenerationTool(tools: ResponseRequest["tools"]) {
  return tools?.some((tool) => tool.type === "image_generation") ?? false;
}

function normalizeThinking(value: ThinkingLevel | undefined) {
  return value === "none" ? undefined : value;
}

function getRequestedToolImageModel(tools: ResponseRequest["tools"]) {
  const imageTool = tools?.find((tool) => tool.type === "image_generation");
  if (!imageTool || typeof imageTool.model !== "string") return undefined;
  return getImageModel(imageTool.model) || undefined;
}

function getRequestedToolOutputFormat(tools: ResponseRequest["tools"]) {
  const imageTool = tools?.find((tool) => tool.type === "image_generation");
  if (!imageTool || typeof imageTool.output_format !== "string") {
    return undefined;
  }
  return normalizeOutputFormat(imageTool.output_format);
}

function getRequestedToolOutputCompression(tools: ResponseRequest["tools"]) {
  const imageTool = tools?.find((tool) => tool.type === "image_generation");
  if (
    !imageTool ||
    (typeof imageTool.output_compression !== "number" &&
      typeof imageTool.output_compression !== "string")
  ) {
    return undefined;
  }
  return normalizeOutputCompression(imageTool.output_compression);
}

async function loadPreviousContinuation(params: {
  userId: string;
  apiKeyId: string;
  responseId?: string;
}) {
  try {
    return await getStoredResponsesContinuation(params);
  } catch (error) {
    logError(error, {
      source: "external-responses-continuation-load",
      responseId: params.responseId,
    });
    return null;
  }
}

function toResponsePayload(params: {
  requestId: string;
  model?: string;
  result: ImageGenerationResult;
  imageBase64?: string;
  previousResponseId?: string;
  previousContinuation?: StoredResponsesContinuation | null;
}) {
  const output = [];
  const imageOutputs = params.result.imageOutputs?.length
    ? params.result.imageOutputs
    : params.imageBase64
      ? [
        {
          imageBase64: params.imageBase64,
          revisedPrompt: params.result.revisedPrompt,
          promptRepairNotice: params.result.promptRepairNotice,
        },
        ]
      : [];
  for (const image of imageOutputs) {
    const outputB64 = image.imageBase64;
    if (!outputB64) continue;
    output.push(
      toOpenAIResponseImageItem({
        id: responseId("ig"),
        b64Json: outputB64,
        revisedPrompt: image.revisedPrompt || params.result.revisedPrompt,
      })
    );
  }
  if (params.result.responseText) {
    output.push(
      toOpenAIResponseTextItem({
        id: responseId("msg"),
        text: params.result.responseText,
      })
    );
  }

  return {
    id: params.requestId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: params.result.model || params.model,
    output,
    usage: null,
    metadata: {
      generation_id: params.result.generationId,
      credits_consumed: params.result.creditsConsumed,
      size: params.result.size,
      ...(params.previousResponseId
        ? { previous_response_id: params.previousResponseId }
        : {}),
      ...(params.previousContinuation
        ? {
            web_native_continuation_available: Boolean(
              params.previousContinuation.webConversation
            ),
            fallback_history_loaded: Boolean(
              params.previousContinuation.fallbackHistory?.length
            ),
          }
        : {}),
      web_conversation_stored: Boolean(params.result.webConversation),
    },
  };
}

function toResponseErrorPayload(message: string, requestId?: string) {
  const payload = toOpenAIErrorPayload(message);
  return {
    error: payload.error,
    ...(requestId
      ? {
          response: {
            id: requestId,
            status: "failed",
            error: payload.error,
          },
        }
      : {}),
  };
}

export const postExternalResponses = withApiLogging(
  async (request: NextRequest) => {
    const auth = await authenticateExternalApiRequest(request);
    if (!auth) {
      return openAIImageError(
        "Invalid or missing API key",
        401,
        "invalid_api_key"
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return openAIImageError("Invalid JSON body");
    }

    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) {
      return openAIImageError(
        parsed.error.issues[0]?.message || "Invalid request"
      );
    }

    if (parsed.data.tools && !hasImageGenerationTool(parsed.data.tools)) {
      return openAIImageError(
        "The external Responses API currently requires the image_generation tool."
      );
    }

    const plan = await getUserPlan(auth.userId);
    if (!(await canUsePlanCapability(plan.plan, "externalApi.responses"))) {
      return openAIImageError(
        "External Responses image generation requires Pro plan or higher.",
        403,
        "insufficient_plan"
      );
    }
    if (
      wantsImageStreamResponse(request, parsed.data.stream) &&
      !(await canUsePlanCapability(plan.plan, "externalApi.streaming"))
    ) {
      return openAIImageError(
        "External API streaming is not enabled for this plan.",
        403,
        "insufficient_plan"
      );
    }

    if (
      !(await isExternalResponsesImageModelAllowed(parsed.data.model, plan.plan))
    ) {
      return openAIImageError(
        "Unsupported model for this plan. Use /v1/models to list available Responses image models."
      );
    }

    const { prompt, history, promptImageUrls } = inputToChatParams(
      parsed.data.input
    );
    if (!prompt) {
      return openAIImageError("Responses input must include user text.");
    }

    const previousResponseId = parsed.data.previous_response_id?.trim();
    const previousContinuation = await loadPreviousContinuation({
      userId: auth.userId,
      apiKeyId: auth.apiKeyId,
      responseId: previousResponseId,
    });
    const webConversationBackendMember =
      previousContinuation?.webConversation?.accountId
        ? {
            type: "account" as const,
            id: previousContinuation.webConversation.accountId,
            accountBackend: "web" as const,
          }
        : undefined;
    const promptCacheBackendMember =
      previousContinuation?.backendMember || webConversationBackendMember
        ? undefined
        : await getPromptCacheBackendMember({
            userId: auth.userId,
            apiKeyId: auth.apiKeyId,
            promptCacheKey: parsed.data.prompt_cache_key,
          });
    const baseHistory = [
      ...(previousContinuation?.fallbackHistory || []),
      ...history,
    ];
    const requestHistory = withWebContinuationMarker(
      baseHistory,
      previousContinuation?.webConversation
    );
    const preferredBackendMember =
      previousContinuation?.backendMember ||
      webConversationBackendMember ||
      promptCacheBackendMember;
    const requestId = responseId("resp");

    let images: ImageInputFile[] = [];
    try {
      images = await inputImageUrlsToFiles(promptImageUrls, {
        userId: auth.userId,
        requestId,
      });
    } catch (error) {
      return openAIImageError(
        error instanceof Error ? error.message : "Failed to load input image"
      );
    }

    const limits = await getPlanLimits(plan.plan);
    const input = {
      mode: "chat" as const,
      userId: auth.userId,
      apiKeyId: auth.apiKeyId,
      relayOnly: auth.relayOnly,
      backendRequestKind: "responses" as const,
      preferredBackendMemberId: preferredBackendMember?.id,
      preferredBackendMemberType: preferredBackendMember?.type,
      stickyPreviousResponseId: previousResponseId,
      stickySessionKey: parsed.data.prompt_cache_key,
      prompt,
      history: requestHistory,
      maxChatContextChars: limits.maxChatContextChars,
      images,
      moderationBlockRiskLevel: auth.moderationBlockRiskLevel,
      size: parsed.data.size || DEFAULT_IMAGE_SIZE,
      model: parsed.data.model,
      imageModel: getRequestedToolImageModel(parsed.data.tools),
      quality: parsed.data.quality as ImageQuality | undefined,
      moderation: (parsed.data.moderation || "auto") as ImageModeration,
      outputFormat: (normalizeOutputFormat(parsed.data.output_format) ||
        getRequestedToolOutputFormat(
          parsed.data.tools
        )) as ImageOutputFormat | undefined,
      outputCompression:
        normalizeOutputCompression(parsed.data.output_compression) ??
        getRequestedToolOutputCompression(parsed.data.tools),
      background: parsed.data.background,
      // 透明背景抠图回退显式开关(issue #27)。
      transparentMatte:
        parsed.data.transparentMatte ?? parsed.data.transparent_matte,
      // 审核改写重试开关(issue #24)。
      moderationPromptRepair:
        parsed.data.promptRepair ?? parsed.data.prompt_repair,
      thinking: normalizeThinking(parsed.data.reasoning?.effort),
      stream: undefined,
      rawResponsesBody: parsed.data,
    };

    if (wantsImageStreamResponse(request, parsed.data.stream)) {
      return createExternalImageStreamResponse(async (emit) => {
        const result = await runImageGenerationForUser(input, {
          onPartialImage: async (image) => {
            await emit({
              event: "response.image_generation_call.partial_image",
              data: {
                type: "response.image_generation_call.partial_image",
                partial_image_index: image.partialImageIndex,
                partial_image_b64: image.imageBase64,
              },
            });
          },
          onTextDelta: async (delta) => {
            await emit({
              event: "response.output_text.delta",
              data: { type: "response.output_text.delta", delta },
            });
          },
          onThinkingDelta: async (delta) => {
            await emit({
              event: "response.reasoning_summary_text.delta",
              data: { type: "response.reasoning_summary_text.delta", delta },
            });
          },
        });

        if (result.error) {
          const payload = toOpenAIErrorPayload(result.error, {
            generationId: result.generationId,
            creditsConsumed: result.creditsConsumed,
          });
          await emit({
            event: "response.failed",
            data: {
              type: "response.failed",
              response: {
                id: requestId,
                status: "failed",
                error: payload.error,
              },
              error: payload.error,
              generation_id: result.generationId,
              generationId: result.generationId,
              credits_consumed: result.creditsConsumed,
            },
          });
          return;
        }

        const imageBase64 =
          result.imageBase64 ??
          (result.imageUrl
            ? await getImageBase64(request, result.imageUrl)
            : undefined);
        const imageOutputs = result.imageOutputs?.length
          ? await Promise.all(
              result.imageOutputs.map(async (output) => ({
                ...output,
                imageBase64:
                  output.imageBase64 ??
                  (output.imageUrl
                    ? await getImageBase64(request, output.imageUrl)
                    : undefined),
              }))
            )
          : undefined;
        const responseResult = imageOutputs
          ? { ...result, imageOutputs }
          : result;
        const fallbackHistory = buildFallbackHistoryForStorage({
          baseHistory,
          prompt,
          promptImageUrls,
          result,
        });
        // 纯中转：不持久化续承（不写 generation.metadata / 不入会话缓存）。
        if (!auth.relayOnly) {
          await bindImageBackendStickyMember({
            layer: "previous_response_id",
            key: requestId,
            member:
              result.responsesPreviousResponse?.backendMember ||
              result.backendMember,
            metadata: { source: "external-responses" },
          });
          await bindImageBackendStickyMember({
            layer: "session_hash",
            key: parsed.data.prompt_cache_key,
            member:
              result.responsesPreviousResponse?.backendMember ||
              result.backendMember,
            metadata: { source: "external-responses" },
          });
          await storeResponsesContinuation({
            userId: auth.userId,
            apiKeyId: auth.apiKeyId,
            responseId: requestId,
            previousResponseId,
            promptCacheKey: parsed.data.prompt_cache_key,
            result,
            fallbackHistory,
          });
        }
        const response = toResponsePayload({
          requestId,
          model: parsed.data.model,
          result: responseResult,
          imageBase64,
          previousResponseId,
          previousContinuation,
        });

        for (const item of response.output) {
          await emit({
            event: "response.output_item.done",
            data: { type: "response.output_item.done", item },
          });
        }

        await emit({
          event: "response.completed",
          data: { type: "response.completed", response },
        });
      });
    }

    return createJsonKeepAliveResponse(async () => {
      const result = await runImageGenerationForUser(input);
      if (result.error) {
        const payload = toOpenAIErrorPayload(result.error, {
          generationId: result.generationId,
          creditsConsumed: result.creditsConsumed,
        });
        return {
          ...toResponseErrorPayload(result.error, requestId),
          error: payload.error,
          response: {
            id: requestId,
            status: "failed",
            error: payload.error,
          },
          generation_id: result.generationId,
          generationId: result.generationId,
          credits_consumed: result.creditsConsumed,
        };
      }

      const imageBase64 =
        result.imageBase64 ??
        (result.imageUrl
          ? await getImageBase64(request, result.imageUrl)
          : undefined);
      const imageOutputs = result.imageOutputs?.length
        ? await Promise.all(
            result.imageOutputs.map(async (output) => ({
              ...output,
              imageBase64:
                output.imageBase64 ??
                (output.imageUrl
                  ? await getImageBase64(request, output.imageUrl)
                  : undefined),
            }))
          )
        : undefined;
      const responseResult = imageOutputs
        ? { ...result, imageOutputs }
        : result;
      const fallbackHistory = buildFallbackHistoryForStorage({
        baseHistory,
        prompt,
        promptImageUrls,
        result,
      });
      // 纯中转：不持久化续承（不写 generation.metadata / 不入会话缓存）。
      if (!auth.relayOnly) {
        await bindImageBackendStickyMember({
          layer: "previous_response_id",
          key: requestId,
          member:
            result.responsesPreviousResponse?.backendMember ||
            result.backendMember,
          metadata: { source: "external-responses" },
        });
        await bindImageBackendStickyMember({
          layer: "session_hash",
          key: parsed.data.prompt_cache_key,
          member:
            result.responsesPreviousResponse?.backendMember ||
            result.backendMember,
          metadata: { source: "external-responses" },
        });
        await storeResponsesContinuation({
          userId: auth.userId,
          apiKeyId: auth.apiKeyId,
          responseId: requestId,
          previousResponseId,
          promptCacheKey: parsed.data.prompt_cache_key,
          result,
          fallbackHistory,
        });
      }

      return toResponsePayload({
        requestId,
        model: parsed.data.model,
        result: responseResult,
        imageBase64,
        previousResponseId,
        previousContinuation,
      });
    });
  }
);
