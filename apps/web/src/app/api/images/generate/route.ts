import { withApiLogging } from "@repo/shared/api-logger";
import { auth } from "@repo/shared/auth";
import {
  canUsePlanCapability,
  getPlanLimits,
} from "@repo/shared/subscription/services/plan-capabilities";
import { getUserPlan } from "@repo/shared/subscription/services/user-plan";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  firstBatchError,
  runBatchImageGeneration,
} from "@/features/image-generation/batch-runner";
import { runImageGenerationForUser } from "@/features/image-generation/operations";
import {
  normalizeOutputCompression,
  normalizeOutputFormat,
} from "@/features/image-generation/output-format";
import {
  alignImageSizeToStep,
  DEFAULT_IMAGE_SIZE,
  IMAGE_PROMPT_MAX_CHARACTERS,
  IMAGE_PROMPT_TOO_LONG_MESSAGE,
  validateImageSize,
} from "@/features/image-generation/resolution";
import { createImageStreamResponse } from "@/features/image-generation/streaming";

const generateImageSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .max(IMAGE_PROMPT_MAX_CHARACTERS, IMAGE_PROMPT_TOO_LONG_MESSAGE),
  generationId: z.string().min(1).max(128).optional(),
  generation_id: z.string().min(1).max(128).optional(),
  generationIds: z.array(z.string().min(1).max(128)).optional(),
  generation_ids: z.array(z.string().min(1).max(128)).optional(),
  apiPrompt: z.string().min(1).max(8000).optional(),
  promptOptimization: z.boolean().optional(),
  size: z
    .string()
    .transform(alignImageSizeToStep)
    .optional()
    .refine((value) => !value || validateImageSize(value).valid, {
      message: "Invalid image size",
    }),
  model: z.string().optional(),
  gptModel: z.string().optional(),
  gpt_model: z.string().optional(),
  thinking: z.enum(["none", "low", "medium", "high", "xhigh"]).optional(),
  stream: z.boolean().optional(),
  count: z.number().int().min(1).max(10_000).optional(),
  quality: z.enum(["auto", "low", "medium", "high", "xhigh", "max"]).optional(),
  moderation: z.enum(["auto", "low"]).optional(),
  output_format: z.enum(["png", "jpeg", "webp"]).optional(),
  outputFormat: z.enum(["png", "jpeg", "webp"]).optional(),
  background: z.enum(["transparent", "opaque", "auto"]).optional(),
  transparentMatte: z.boolean().optional(),
  transparent_matte: z.boolean().optional(),
  output_compression: z.number().int().min(0).max(100).optional(),
  outputCompression: z.number().int().min(0).max(100).optional(),
  mixWebFirst: z.boolean().optional(),
  mix_web_first: z.boolean().optional(),
  // force_firefly：强制把本次请求路由到 adobe（firefly）后端，对任意模型生效。
  force_firefly: z.boolean().optional(),
  forceFirefly: z.boolean().optional(),
  requiresResponsesBackend: z.boolean().optional(),
  requires_responses_backend: z.boolean().optional(),
  // 高清修复:上游图偏小需超分时选模型。默认(含省略)=SwinIR;显式 false=general-x4v3(快)。
  hdRepair: z.boolean().optional(),
  hd_repair: z.boolean().optional(),
});

function errorResponse(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function wantsStreamResponse(request: NextRequest, stream?: boolean) {
  if (stream) return true;
  return request.headers.get("accept")?.includes("text/event-stream") ?? false;
}

function generationErrorResponse(error: unknown) {
  return errorResponse(
    error instanceof Error ? error.message : "Failed to generate image."
  );
}

export const POST = withApiLogging(async (request: NextRequest) => {
  const session = await auth.api.getSession({
    headers: request.headers,
  });

  if (!session?.user) {
    return errorResponse("Unauthorized", 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body");
  }

  const parsed = generateImageSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(parsed.error.issues[0]?.message || "Invalid request");
  }

  const plan = await getUserPlan(session.user.id);
  const planLimits = await getPlanLimits(plan.plan);
  const count = parsed.data.count || 1;
  if (
    count > 1 &&
    !(await canUsePlanCapability(plan.plan, "imageGeneration.batch"))
  ) {
    return errorResponse(
      "Batch image generation is not enabled for this plan.",
      403
    );
  }
  if (count > planLimits.maxBatchCount) {
    return errorResponse(
      `count must be between 1 and ${planLimits.maxBatchCount}.`
    );
  }

  const input = {
    mode: "generate" as const,
    userId: session.user.id,
    backendRequestKind: "image_generation" as const,
    prompt: parsed.data.prompt,
    apiPrompt: parsed.data.apiPrompt,
    promptOptimization: parsed.data.promptOptimization,
    size: parsed.data.size || DEFAULT_IMAGE_SIZE,
    model: parsed.data.model,
    gptModel: parsed.data.gptModel || parsed.data.gpt_model,
    thinking: parsed.data.thinking,
    quality: parsed.data.quality || "auto",
    moderation: parsed.data.moderation || "auto",
    outputFormat: normalizeOutputFormat(
      parsed.data.output_format || parsed.data.outputFormat
    ),
    background: parsed.data.background,
    transparentMatte:
      parsed.data.transparentMatte ?? parsed.data.transparent_matte,
    outputCompression: normalizeOutputCompression(
      parsed.data.output_compression ?? parsed.data.outputCompression
    ),
    mixWebFirst:
      parsed.data.requiresResponsesBackend ||
      parsed.data.requires_responses_backend
        ? false
        : (parsed.data.mixWebFirst ?? parsed.data.mix_web_first),
    requiresResponsesBackend:
      parsed.data.requiresResponsesBackend ??
      parsed.data.requires_responses_backend,
    forceFirefly: parsed.data.forceFirefly ?? parsed.data.force_firefly,
    hdRepair: parsed.data.hdRepair ?? parsed.data.hd_repair,
  };
  const requestedGenerationIds =
    parsed.data.generationIds || parsed.data.generation_ids;
  const requestedGenerationId =
    parsed.data.generationId ||
    parsed.data.generation_id ||
    requestedGenerationIds?.[0];
  const batchGenerationIds =
    requestedGenerationIds?.length === count
      ? requestedGenerationIds
      : count === 1 && requestedGenerationId
        ? [requestedGenerationId]
        : undefined;

  try {
    const useStreamResponse = wantsStreamResponse(request, parsed.data.stream);

    if (useStreamResponse) {
      return createImageStreamResponse(async (emit) => {
        await runBatchImageGeneration({
          count,
          concurrency: planLimits.imageGenerationConcurrency,
          generationIds: batchGenerationIds,
          run: (generationId, callbacks) =>
            runImageGenerationForUser({ ...input, generationId }, callbacks),
          callbacks: (index) => ({
            onPartialImage: async (image) => {
              await emit({
                type: "partial_image",
                index,
                partial_image_index: image.partialImageIndex,
                b64_json: image.imageBase64,
                url: image.imageUrl,
              });
            },
          }),
          onResult: async (result) => {
            if (result.error) {
              await emit({
                type: "error",
                error: result.error,
                generationId: result.generationId,
                creditsConsumed: result.creditsConsumed,
              });
              return;
            }
            await emit({ type: "completed", ...result });
          },
          stopOnError: true,
        });

        return null;
      });
    }

    if (count === 1) {
      return NextResponse.json(
        await runImageGenerationForUser({
          ...input,
          generationId: requestedGenerationId,
        })
      );
    }

    const results = await runBatchImageGeneration({
      count,
      concurrency: planLimits.imageGenerationConcurrency,
      generationIds: batchGenerationIds,
      run: (generationId) =>
        runImageGenerationForUser({ ...input, generationId }),
    });

    return NextResponse.json({
      results,
      error: firstBatchError(results)?.error,
    });
  } catch (error) {
    return generationErrorResponse(error);
  }
});
