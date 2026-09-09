import { withApiLogging } from "@repo/shared/api-logger";
import {
  canUsePlanCapability,
  getPlanLimits,
  MAX_PLAN_BATCH_COUNT,
} from "@repo/shared/subscription/services/plan-capabilities";
import { getUserPlan } from "@repo/shared/subscription/services/user-plan";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { authenticateExternalApiRequest } from "@/features/external-api/auth";
import {
  createExternalImageStreamResponse,
  createJsonKeepAliveResponse,
  getExternalFinalImageOutputs,
  getImageBase64,
  getPublicImageUrl,
  openAIImageError,
  toExternalErrorStreamData,
  toExternalGenerationUsage,
  toLoggedOpenAIErrorPayload,
  wantsImageStreamResponse,
} from "@/features/external-api/images";
import {
  fetchPublicImage,
  readResponseBytesWithLimit,
} from "@/features/external-api/safe-image-fetch";
import { runBatchImageGeneration } from "@/features/image-generation/batch-runner";
import { runImageGenerationForUser } from "@/features/image-generation/operations";
import {
  normalizeOutputCompression,
  normalizeOutputFormat,
} from "@/features/image-generation/output-format";
import { uploadTemporaryImageUrls } from "@/features/image-generation/request-utils";
import {
  alignImageSizeToStep,
  DEFAULT_IMAGE_SIZE,
  getImageModel,
  isImageModel,
  validateImageSize,
} from "@/features/image-generation/resolution";
import type {
  ImageInputFile,
  ImageModeration,
  ImageOutputFormat,
  ImageQuality,
  PartialImageResult,
  ThinkingLevel,
} from "@/features/image-generation/types";

import {
  buildChatCompletionAssistantContent,
  type ChatCompletionImageData,
  chatCompletionMessagesToChatParams,
} from "./chat-completions-utils";

const chatCompletionContentPartSchema = z
  .object({ type: z.string() })
  .passthrough();

const chatCompletionMessageSchema = z
  .object({
    role: z.enum([
      "system",
      "developer",
      "user",
      "assistant",
      "tool",
      "function",
    ]),
    content: z
      .union([z.string(), z.array(chatCompletionContentPartSchema), z.null()])
      .optional(),
  })
  .passthrough();

const chatCompletionSchema = z
  .object({
    model: z.string().optional(),
    messages: z.array(chatCompletionMessageSchema).min(1),
    stream: z.boolean().optional(),
    n: z.number().int().min(1).max(MAX_PLAN_BATCH_COUNT).optional(),
    size: z
      .string()
      .transform(alignImageSizeToStep)
      .optional()
      .refine((value) => !value || validateImageSize(value).valid, {
        message: "Invalid image size",
      }),
    quality: z.enum(["auto", "low", "medium", "high", "xhigh", "max"]).optional(),
    moderation: z.enum(["auto", "low"]).optional(),
    response_format: z
      .union([
        z.enum(["url", "b64_json"]),
        z.object({ type: z.string() }).passthrough(),
      ])
      .optional(),
    output_format: z.enum(["png", "jpeg", "webp"]).optional(),
    output_compression: z.number().int().min(0).max(100).optional(),
    background: z.enum(["transparent", "opaque", "auto"]).optional(),
    transparentMatte: z.boolean().optional(),
    transparent_matte: z.boolean().optional(),
    promptOptimization: z.boolean().optional(),
    prompt_optimization: z.boolean().optional(),
    // 审核改写重试开关(issue #24):传 false 时,审核拦截后不自动改写提示词重试,直接返回真实错误。
    promptRepair: z.boolean().optional(),
    prompt_repair: z.boolean().optional(),
    imageModel: z.string().optional(),
    image_model: z.string().optional(),
    thinking: z
      .enum(["minimal", "none", "low", "medium", "high", "xhigh"])
      .optional(),
    reasoning: z
      .object({
        effort: z
          .enum(["minimal", "none", "low", "medium", "high", "xhigh"])
          .optional(),
      })
      .passthrough()
      .optional(),
    mixWebFirst: z.boolean().optional(),
    mix_web_first: z.boolean().optional(),
    requiresResponsesBackend: z.boolean().optional(),
    requires_responses_backend: z.boolean().optional(),
  })
  .passthrough();

type ChatCompletionRequest = z.infer<typeof chatCompletionSchema>;
type ChatCompletionResult = Awaited<
  ReturnType<typeof runImageGenerationForUser>
>;

function completionId() {
  return `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function imageResponseFormat(value: ChatCompletionRequest["response_format"]) {
  return value === "b64_json" ? "b64_json" : "url";
}

function normalizeThinking(value: ThinkingLevel | undefined) {
  return value === "none" ? undefined : value;
}

function parseDataImageUrl(url: string): ImageInputFile | null {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(url);
  if (!match) return null;
  return {
    data: Buffer.from(match[2] || "", "base64"),
    name: "chat-completion-input-image.png",
    type: match[1] || "image/png",
    url,
  };
}

async function imageUrlToInputFile(params: {
  imageUrl: string;
  index: number;
  maxImageBytes: number;
  userId?: string;
  requestId?: string;
}) {
  if (params.imageUrl.startsWith("data:image/")) {
    const file = parseDataImageUrl(params.imageUrl);
    if (!file) throw new Error("Invalid data image_url.");
    if (file.data.byteLength > params.maxImageBytes) {
      throw new Error("Input image exceeds this plan's per-file limit.");
    }
    return file;
  }

  if (
    !params.imageUrl.startsWith("http://") &&
    !params.imageUrl.startsWith("https://")
  ) {
    throw new Error("input image_url must be an http(s) URL or data URL.");
  }

  const response = await fetchPublicImage(params.imageUrl);
  if (!response.ok) {
    throw new Error(`Failed to load input image: HTTP ${response.status}`);
  }

  const type = response.headers.get("content-type") || "image/png";
  if (!type.startsWith("image/")) {
    throw new Error("input image_url must point to an image.");
  }

  // 流式读取并在累计超限时主动 abort：content-length 头可伪造，不能据其预判大小，
  // 也不能先把整段正文缓冲进内存（否则可被巨大响应逼近 OOM）。
  const data = await readResponseBytesWithLimit(
    response,
    params.maxImageBytes,
    () => {
      throw new Error("Input image exceeds this plan's per-file limit.");
    }
  );

  const file = new File(
    [data],
    `chat-completion-input-image-${params.index + 1}`,
    { type }
  );
  const uploaded = params.userId
    ? await uploadTemporaryImageUrls(
        params.userId,
        params.requestId || "chat",
        [file]
      )
    : undefined;

  return {
    data,
    name: `chat-completion-input-image-${params.index + 1}`,
    type,
    url: uploaded?.[0]?.url || params.imageUrl,
    storageBucket: uploaded?.[0]?.bucket,
    storageKey: uploaded?.[0]?.key,
  } satisfies ImageInputFile;
}

async function inputImageUrlsToFiles(params: {
  imageUrls: readonly string[];
  maxImageBytes: number;
  maxRequestBytes: number;
  userId?: string;
  requestId?: string;
}) {
  const files = await Promise.all(
    params.imageUrls.map((imageUrl, index) =>
      imageUrlToInputFile({
        imageUrl,
        index,
        maxImageBytes: params.maxImageBytes,
        userId: params.userId,
        requestId: params.requestId,
      })
    )
  );
  const totalBytes = files.reduce(
    (total, file) => total + file.data.byteLength,
    0
  );
  if (totalBytes > params.maxRequestBytes) {
    throw new Error(
      "Total input image size exceeds this plan's request limit."
    );
  }
  return files;
}

async function toChatCompletionImages(params: {
  request: Request;
  result: ChatCompletionResult;
  responseFormat: "url" | "b64_json";
}) {
  const outputs = getExternalFinalImageOutputs(params.result);

  const images: ChatCompletionImageData[] = [];
  for (const [index, output] of outputs.entries()) {
    const item: ChatCompletionImageData = {
      index,
      revised_prompt: output.revisedPrompt || params.result.revisedPrompt,
      prompt_repair_notice:
        output.promptRepairNotice || params.result.promptRepairNotice,
      generation_id: output.generationId || params.result.generationId,
      generationId: output.generationId || params.result.generationId,
    };
    const publicImageUrl = getPublicImageUrl(params.request, output.imageUrl);
    if (publicImageUrl) item.url = publicImageUrl;
    if (params.responseFormat === "b64_json") {
      item.b64_json =
        output.imageBase64 ||
        (await getImageBase64(params.request, output.imageUrl));
    }
    images.push(item);
  }
  return images;
}

function toChatCompletionPayload(params: {
  id: string;
  created: number;
  model?: string;
  results: ChatCompletionResult[];
  choices: {
    index: number;
    content: string;
    images: ChatCompletionImageData[];
  }[];
}) {
  const images = params.choices.flatMap((choice) => choice.images);
  return {
    id: params.id,
    object: "chat.completion",
    created: params.created,
    model: params.model || params.results[0]?.model || "gpt2image-chat",
    choices: params.choices.map((choice) => ({
      index: choice.index,
      message: {
        role: "assistant",
        content: choice.content,
        images: choice.images,
      },
      finish_reason: "stop",
    })),
    usage: null,
    images,
    ...toExternalGenerationUsage(params.results),
  };
}

function toChatCompletionChunk(params: {
  id: string;
  created: number;
  model?: string;
  index: number;
  delta: Record<string, unknown>;
  finishReason?: "stop" | null;
  images?: ChatCompletionImageData[];
  generationId?: string;
  creditsConsumed?: number;
}) {
  return {
    id: params.id,
    object: "chat.completion.chunk",
    created: params.created,
    model: params.model || "gpt2image-chat",
    choices: [
      {
        index: params.index,
        delta: params.delta,
        finish_reason: params.finishReason ?? null,
      },
    ],
    ...(params.images ? { images: params.images } : {}),
    ...(params.generationId
      ? {
          generation_id: params.generationId,
          generationId: params.generationId,
        }
      : {}),
    ...(params.creditsConsumed !== undefined
      ? { credits_consumed: params.creditsConsumed }
      : {}),
  };
}

function toPartialPayload(image: PartialImageResult, index: number) {
  return {
    type: "chat.completion.partial_image",
    index,
    partial_image_index: image.partialImageIndex,
    b64_json: image.imageBase64,
    url: image.imageUrl,
  };
}

export const postExternalChatCompletions = withApiLogging(
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

    const parsed = chatCompletionSchema.safeParse(body);
    if (!parsed.success) {
      return openAIImageError(
        parsed.error.issues[0]?.message || "Invalid request"
      );
    }

    const plan = await getUserPlan(auth.userId);
    if (
      !(await canUsePlanCapability(plan.plan, "externalApi.chat.completions"))
    ) {
      return openAIImageError(
        "External Chat Completions is not enabled for this plan.",
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

    const { prompt, apiPrompt, history, promptImageUrls } =
      chatCompletionMessagesToChatParams(parsed.data.messages);
    if (!prompt) {
      return openAIImageError(
        "Chat Completions messages must include a final user message with text."
      );
    }

    const limits = await getPlanLimits(plan.plan);
    const id = completionId();
    const count = parsed.data.n || 1;
    if (
      count > 1 &&
      !(await canUsePlanCapability(plan.plan, "imageGeneration.batch"))
    ) {
      return openAIImageError(
        "Batch image generation is not enabled for this plan.",
        403,
        "insufficient_plan"
      );
    }
    if (count > limits.maxBatchCount) {
      return openAIImageError(
        `n must be between 1 and ${limits.maxBatchCount}.`
      );
    }

    let images: ImageInputFile[] = [];
    try {
      images = await inputImageUrlsToFiles({
        imageUrls: promptImageUrls,
        maxImageBytes: limits.maxFileMb * 1024 * 1024,
        maxRequestBytes: limits.maxUploadMb * 1024 * 1024,
        userId: auth.userId,
        requestId: id,
      });
    } catch (error) {
      return openAIImageError(
        error instanceof Error ? error.message : "Failed to load input image"
      );
    }

    const topLevelModel = parsed.data.model?.trim();
    const topLevelModelIsImage = isImageModel(topLevelModel);
    const explicitImageModel =
      parsed.data.imageModel || parsed.data.image_model;
    const imageModel = getImageModel(
      explicitImageModel || (topLevelModelIsImage ? topLevelModel : undefined)
    );
    if ((parsed.data.imageModel || parsed.data.image_model) && !imageModel) {
      return openAIImageError(
        "Unsupported image_model. Use a gpt-image-* model."
      );
    }

    const responseFormat = imageResponseFormat(parsed.data.response_format);
    const useStreamResponse = wantsImageStreamResponse(
      request,
      parsed.data.stream
    );
    const requiresResponsesBackend =
      parsed.data.requiresResponsesBackend ??
      parsed.data.requires_responses_backend;
    const useDirectImageCompatibility =
      topLevelModelIsImage &&
      history.length === 0 &&
      requiresResponsesBackend !== true;
    const sharedInput = {
      userId: auth.userId,
      apiKeyId: auth.apiKeyId,
      relayOnly: auth.relayOnly,
      prompt,
      apiPrompt,
      promptOptimization:
        parsed.data.promptOptimization ?? parsed.data.prompt_optimization,
      // 审核改写重试开关(issue #24):传 false 时,审核拦截后不自动改写提示词重试,直接返回真实错误。
      moderationPromptRepair:
        parsed.data.promptRepair ?? parsed.data.prompt_repair,
      history,
      maxChatContextChars: limits.maxChatContextChars,
      images,
      moderationBlockRiskLevel: auth.moderationBlockRiskLevel,
      size: parsed.data.size || DEFAULT_IMAGE_SIZE,
      model: topLevelModelIsImage ? undefined : parsed.data.model,
      imageModel: imageModel || undefined,
      quality: parsed.data.quality as ImageQuality | undefined,
      moderation: (parsed.data.moderation || "auto") as ImageModeration,
      outputFormat: normalizeOutputFormat(parsed.data.output_format) as
        | ImageOutputFormat
        | undefined,
      outputCompression: normalizeOutputCompression(
        parsed.data.output_compression
      ),
      background: parsed.data.background,
      // 透明背景抠图回退显式开关(issue #27);chat 模式(agentMode:false)适用。
      transparentMatte:
        parsed.data.transparentMatte ?? parsed.data.transparent_matte,
      thinking: normalizeThinking(
        parsed.data.thinking || parsed.data.reasoning?.effort
      ),
      mixWebFirst: parsed.data.mixWebFirst ?? parsed.data.mix_web_first,
      requiresResponsesBackend,
    };
    const input = useDirectImageCompatibility
      ? images.length > 0
        ? {
            ...sharedInput,
            mode: "edit" as const,
            backendRequestKind: "image_edit" as const,
            images,
            model: imageModel || undefined,
          }
        : {
            ...sharedInput,
            mode: "generate" as const,
            backendRequestKind: "image_generation" as const,
            model: imageModel || undefined,
          }
      : {
          ...sharedInput,
          mode: "chat" as const,
          backendRequestKind: "chat" as const,
          history,
          maxChatContextChars: limits.maxChatContextChars,
          images,
          model: topLevelModelIsImage ? undefined : parsed.data.model,
          imageModel: imageModel || undefined,
          // Downstream streaming is handled by this route. Upstream streaming is
          // controlled by the selected backend config.
          stream: undefined,
          rawChatCompletionsBody: topLevelModelIsImage
            ? { ...parsed.data, model: undefined }
            : parsed.data,
          agentMode: false,
        };
    const created = nowSeconds();

    if (useStreamResponse) {
      return createExternalImageStreamResponse(async (emit) => {
        await runBatchImageGeneration({
          count,
          concurrency: limits.imageGenerationConcurrency,
          run: (generationId, callbacks) =>
            runImageGenerationForUser({ ...input, generationId }, callbacks),
          callbacks: (index) => ({
            onPartialImage: async (image) => {
              await emit({
                event: "chat.completion.partial_image",
                data: toPartialPayload(image, index),
              });
            },
            onTextDelta: async (delta) => {
              await emit({
                data: toChatCompletionChunk({
                  id,
                  created,
                  model: parsed.data.model,
                  index,
                  delta: { content: delta },
                }),
              });
            },
          }),
          onResult: async (result, index) => {
            if (result.error) {
              const errorPayload = toLoggedOpenAIErrorPayload(
                result.error,
                {
                  route: "/v1/chat/completions",
                  stream: true,
                  model: parsed.data.model,
                  imageModel,
                },
                {
                  generationId: result.generationId,
                  creditsConsumed: result.creditsConsumed,
                }
              );
              await emit({
                event: "error",
                data: toExternalErrorStreamData(result.error, errorPayload),
              });
              return;
            }

            const images = await toChatCompletionImages({
              request,
              result,
              responseFormat,
            });
            const content = buildChatCompletionAssistantContent({
              text: result.responseText,
              images,
              includeText: false,
            });
            if (content) {
              await emit({
                data: toChatCompletionChunk({
                  id,
                  created,
                  model: result.model || parsed.data.model,
                  index,
                  delta: { content },
                }),
              });
            }
            await emit({
              data: toChatCompletionChunk({
                id,
                created,
                model: result.model || parsed.data.model,
                index,
                delta: {},
                finishReason: "stop",
                images,
                generationId: result.generationId,
                creditsConsumed: result.creditsConsumed,
              }),
            });
          },
        });
      });
    }

    return createJsonKeepAliveResponse(async () => {
      const results = await runBatchImageGeneration({
        count,
        concurrency: limits.imageGenerationConcurrency,
        run: (generationId) =>
          runImageGenerationForUser({ ...input, generationId }),
      });
      const choices = [];
      for (const [index, result] of results.entries()) {
        if (result.error) {
          return toLoggedOpenAIErrorPayload(
            result.error,
            {
              route: "/v1/chat/completions",
              stream: false,
              choiceIndex: index,
              model: parsed.data.model,
              imageModel,
            },
            {
              generationId: result.generationId,
              creditsConsumed: result.creditsConsumed,
            }
          );
        }
        const resultImages = await toChatCompletionImages({
          request,
          result,
          responseFormat,
        });
        choices.push({
          index,
          content: buildChatCompletionAssistantContent({
            text: result.responseText,
            images: resultImages,
          }),
          images: resultImages,
        });
      }

      return toChatCompletionPayload({
        id,
        created,
        model: results[0]?.model || parsed.data.model,
        results,
        choices,
      });
    });
  }
);
