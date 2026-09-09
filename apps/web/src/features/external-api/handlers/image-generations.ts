import { randomUUID } from "node:crypto";
import { withApiLogging } from "@repo/shared/api-logger";
import {
  MAX_PLAN_BATCH_COUNT,
  canUsePlanCapability,
  getPlanLimits,
} from "@repo/shared/subscription/services/plan-capabilities";
import { getUserPlan } from "@repo/shared/subscription/services/user-plan";
import type { NextRequest } from "next/server";
import { z } from "zod";

import {
  completeAsyncImageTask,
  createAsyncImageTask,
  postAsyncImageCallback,
  toAsyncImageTaskResponse,
  validateCallbackUrl,
} from "@/features/external-api/async-image-tasks";
import { authenticateExternalApiRequest } from "@/features/external-api/auth";
import {
  createExternalImageStreamResponse,
  createJsonKeepAliveResponse,
  getExternalFinalImageOutputs,
  getImageBase64,
  getPublicImageUrl,
  IMAGE_JSON_KEEP_ALIVE_INITIAL_WAIT_MS,
  openAIImageError,
  toExternalErrorStreamData,
  toLoggedOpenAIErrorPayload,
  toOpenAIErrorPayload,
  toOpenAIImagesResponse,
  wantsImageStreamResponse,
} from "@/features/external-api/images";
import { runBatchImageGeneration } from "@/features/image-generation/batch-runner";
import { runImageGenerationForUser } from "@/features/image-generation/operations";
import {
  normalizeOutputCompression,
  normalizeOutputFormat,
} from "@/features/image-generation/output-format";
import {
  alignImageSizeToStep,
  DEFAULT_IMAGE_SIZE,
  getImageModel,
  IMAGE_PROMPT_MAX_CHARACTERS,
  IMAGE_PROMPT_TOO_LONG_MESSAGE,
  validateImageSize,
} from "@/features/image-generation/resolution";
import type { PartialImageResult } from "@/features/image-generation/types";

const externalImageGenerationSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .max(IMAGE_PROMPT_MAX_CHARACTERS, IMAGE_PROMPT_TOO_LONG_MESSAGE),
  promptOptimization: z.boolean().optional(),
  prompt_optimization: z.boolean().optional(),
  // 审核改写重试开关(issue #24):传 false 时,审核拦截后不自动改写提示词重试,直接返回真实错误。
  promptRepair: z.boolean().optional(),
  prompt_repair: z.boolean().optional(),
  model: z.string().optional(),
  gptModel: z.string().optional(),
  gpt_model: z.string().optional(),
  thinking: z
    .enum(["minimal", "none", "low", "medium", "high", "xhigh"])
    .optional(),
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
  response_format: z.enum(["url", "b64_json"]).optional(),
  output_format: z.enum(["png", "jpeg", "webp"]).optional(),
  output_compression: z.number().int().min(0).max(100).optional(),
  background: z.enum(["transparent", "opaque", "auto"]).optional(),
  // 透明背景抠图回退显式开关(issue #27):true 且 background=transparent 时,后端不支持透明则
  // 服务端 ISNet 抠图得到透明结果;不传则透明直接透传、不支持即返回真实错误。
  transparentMatte: z.boolean().optional(),
  transparent_matte: z.boolean().optional(),
  force_web: z.boolean().optional(),
  forceWeb: z.boolean().optional(),
  web_first: z.boolean().optional(),
  webFirst: z.boolean().optional(),
  // force_firefly：强制把本次请求路由到 adobe（firefly）后端，对任意模型生效。
  force_firefly: z.boolean().optional(),
  forceFirefly: z.boolean().optional(),
  // 高清修复:上游图偏小需超分时选模型。默认(含省略)=SwinIR(文字/结构复原最佳,较慢);
  // 显式 false=general-x4v3(轻量快)。仅在超分主开关开且触发超分时生效。
  hdRepair: z.boolean().optional(),
  hd_repair: z.boolean().optional(),
  stream: z.boolean().optional(),
  async: z.boolean().optional(),
  callback_url: z.string().url().optional(),
});

async function toStreamCompletedPayload(
  request: Request,
  result: Awaited<ReturnType<typeof runImageGenerationForUser>>,
  responseFormat: "url" | "b64_json",
  index: number
) {
  const outputs = getExternalFinalImageOutputs(result);
  const images = [];
  for (const output of outputs) {
    const image =
      responseFormat === "b64_json"
        ? {
            b64_json:
              output.imageBase64 ||
              (await getImageBase64(request, output.imageUrl)),
          }
        : {
            // 纯中转若上游仅给 base64（无 URL），退化为 data: URI 以保证可用。
            url:
              getPublicImageUrl(request, output.imageUrl) ??
              (output.imageBase64
                ? `data:image/png;base64,${output.imageBase64}`
                : undefined),
          };
    images.push({
      ...image,
      revised_prompt: output.revisedPrompt || result.revisedPrompt,
      prompt_repair_notice:
        output.promptRepairNotice || result.promptRepairNotice,
    });
  }
  const primary = images[images.length - 1] || {};

  return {
    type: "image_generation.completed",
    index,
    generation_id: result.generationId,
    generationId: result.generationId,
    model: result.model,
    size: result.size,
    revised_prompt: result.revisedPrompt,
    prompt_repair_notice: result.promptRepairNotice,
    credits_consumed: result.creditsConsumed,
    ...primary,
    data: images,
  };
}

function toPartialPayload(image: PartialImageResult, index: number) {
  return {
    type: "image_generation.partial_image",
    index,
    partial_image_index: image.partialImageIndex,
    b64_json: image.imageBase64,
    url: image.imageUrl,
  };
}

function resolveImageModel(model: string | undefined) {
  return getImageModel(model);
}

export const postExternalImageGenerations = withApiLogging(
  async (request: NextRequest) => {
    const auth = await authenticateExternalApiRequest(request);
    if (!auth) {
      return openAIImageError(
        "Invalid or missing API key",
        401,
        "invalid_api_key"
      );
    }
    if (
      !(await canUsePlanCapability(auth.plan, "externalApi.images.generate"))
    ) {
      return openAIImageError(
        "External image generation is not enabled for this plan.",
        403,
        "insufficient_plan"
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return openAIImageError("Invalid JSON body");
    }

    const parsed = externalImageGenerationSchema.safeParse(body);
    if (!parsed.success) {
      return openAIImageError(
        parsed.error.issues[0]?.message || "Invalid request"
      );
    }

    const imageModel = resolveImageModel(parsed.data.model);
    if (!imageModel) {
      return openAIImageError(
        "Unsupported model for /v1/images/generations. Use a gpt-image-* model, or call /v1/responses for Responses image models."
      );
    }

    const plan = await getUserPlan(auth.userId);
    const limits = await getPlanLimits(plan.plan);
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
    const useAsync =
      parsed.data.async === true ||
      request.nextUrl.searchParams.get("async") === "true";
    const useStreamResponse = wantsImageStreamResponse(
      request,
      parsed.data.stream
    );
    if (useAsync && useStreamResponse) {
      return openAIImageError("async cannot be used with stream.");
    }
    let callbackUrl: string | undefined;
    if (parsed.data.callback_url) {
      try {
        callbackUrl = await validateCallbackUrl(parsed.data.callback_url);
      } catch (error) {
        return openAIImageError(
          error instanceof Error ? error.message : "Invalid callback_url."
        );
      }
    }
    const background = parsed.data.background;
    const transparentMatte =
      parsed.data.transparentMatte ?? parsed.data.transparent_matte;

    const input = {
      mode: "generate" as const,
      userId: auth.userId,
      apiKeyId: auth.apiKeyId,
      relayOnly: auth.relayOnly,
      backendRequestKind: "image_generation" as const,
      prompt: parsed.data.prompt,
      promptOptimization:
        parsed.data.promptOptimization ?? parsed.data.prompt_optimization,
      moderationPromptRepair:
        parsed.data.promptRepair ?? parsed.data.prompt_repair,
      moderationBlockRiskLevel: auth.moderationBlockRiskLevel,
      size: parsed.data.size || DEFAULT_IMAGE_SIZE,
      model: imageModel,
      gptModel: parsed.data.gptModel || parsed.data.gpt_model,
      thinking: parsed.data.thinking,
      quality: parsed.data.quality,
      moderation: parsed.data.moderation || "auto",
      outputFormat: normalizeOutputFormat(parsed.data.output_format),
      outputCompression: normalizeOutputCompression(
        parsed.data.output_compression
      ),
      background,
      transparentMatte,
      forceWebBackend:
        parsed.data.web_first ??
        parsed.data.webFirst ??
        parsed.data.force_web ??
        parsed.data.forceWeb,
      forceFirefly: parsed.data.forceFirefly ?? parsed.data.force_firefly,
      hdRepair: parsed.data.hdRepair ?? parsed.data.hd_repair,
    };
    const responseFormat = parsed.data.response_format || "b64_json";

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
                event: "image_generation.partial_image",
                data: toPartialPayload(image, index),
              });
            },
          }),
          onResult: async (result, index) => {
            if (result.error) {
              const errorPayload = toLoggedOpenAIErrorPayload(
                result.error,
                {
                  route: "/v1/images/generations",
                  stream: true,
                  index,
                  model: imageModel,
                  size: input.size,
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

            await emit({
              event: "image_generation.completed",
              data: await toStreamCompletedPayload(
                request,
                result,
                responseFormat,
                index
              ),
            });
          },
        });
      });
    }

    if (useAsync) {
      const created = Math.floor(Date.now() / 1000);
      const generationIds = Array.from({ length: count }, () => randomUUID());
      const task = createAsyncImageTask({
        userId: auth.userId,
        apiKeyId: auth.apiKeyId,
        model: imageModel,
        generationIds,
      });

      void (async () => {
        const results = await runBatchImageGeneration({
          count,
          concurrency: limits.imageGenerationConcurrency,
          generationIds,
          run: (generationId) =>
            runImageGenerationForUser({ ...input, generationId }),
        });
        const resultPayload = await toOpenAIImagesResponse(
          request,
          results,
          responseFormat,
          created,
          {
            route: "/v1/images/generations",
            async: true,
            model: imageModel,
            size: input.size,
          }
        );
        const completedTask = completeAsyncImageTask(task.id, {
          error:
            resultPayload &&
            typeof resultPayload === "object" &&
            "error" in resultPayload
              ? resultPayload
              : undefined,
          result: resultPayload,
        });
        if (completedTask && callbackUrl) {
          await postAsyncImageCallback(callbackUrl, completedTask);
        }
      })().catch(async (error) => {
        const errorPayload = toOpenAIErrorPayload(
          error instanceof Error
            ? error.message
            : "Async image generation failed"
        );
        const completedTask = completeAsyncImageTask(task.id, {
          error: errorPayload,
        });
        if (completedTask && callbackUrl) {
          await postAsyncImageCallback(callbackUrl, completedTask);
        }
      });

      return Response.json(toAsyncImageTaskResponse(task));
    }

    return createJsonKeepAliveResponse(
      async () => {
        const created = Math.floor(Date.now() / 1000);

        const results = await runBatchImageGeneration({
          count,
          concurrency: limits.imageGenerationConcurrency,
          run: () => runImageGenerationForUser(input),
        });
        return await toOpenAIImagesResponse(
          request,
          results,
          responseFormat,
          created,
          {
            route: "/v1/images/generations",
            stream: false,
            model: imageModel,
            size: input.size,
          }
        );
      },
      { initialWaitMs: IMAGE_JSON_KEEP_ALIVE_INITIAL_WAIT_MS }
    );
  }
);
