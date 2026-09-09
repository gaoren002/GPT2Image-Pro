import { randomUUID } from "node:crypto";
import { withApiLogging } from "@repo/shared/api-logger";
import { auth } from "@repo/shared/auth";
import {
  canUsePlanCapability,
  getPlanLimits,
} from "@repo/shared/subscription/services/plan-capabilities";
import { getPlanUploadLimits } from "@repo/shared/subscription/services/upload-limits";
import { getUserPlan } from "@repo/shared/subscription/services/user-plan";
import { type NextRequest, NextResponse } from "next/server";
import {
  firstBatchError,
  runBatchImageGeneration,
} from "@/features/image-generation/batch-runner";
import { runImageGenerationForUser } from "@/features/image-generation/operations";
import {
  normalizeImageBackground,
  normalizeOutputCompression,
  normalizeOutputFormat,
  VALID_IMAGE_BACKGROUNDS,
  VALID_OUTPUT_FORMATS,
} from "@/features/image-generation/output-format";
import {
  deleteTemporaryImages,
  filesToImageInputs,
  formatMegabytes,
  getTotalUploadSize,
  uploadTemporaryImageUrls,
  validateImageFile,
} from "@/features/image-generation/request-utils";
import {
  alignImageSizeToStep,
  IMAGE_PROMPT_MAX_CHARACTERS,
  IMAGE_PROMPT_TOO_LONG_MESSAGE,
  parseImageSize,
  validateImageSize,
} from "@/features/image-generation/resolution";
import { createImageStreamResponse } from "@/features/image-generation/streaming";
import type {
  ImageBackground,
  ImageModeration,
  ImageOutputFormat,
  ImageQuality,
  ThinkingLevel,
} from "@/features/image-generation/types";

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
const VALID_THINKING = new Set<ThinkingLevel>([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
]);
const PROMPT_IMAGE_REFERENCE_PATTERN = /@(?:第)?\d+轮图\d+|@图\d+/;

function errorResponse(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function getText(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getCount(formData: FormData, key: string, maxBatchCount: number) {
  const value = getText(formData, key);
  if (!value) return 1;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${key} must be an integer.`);
  }
  const count = Number(value);
  if (count < 1 || count > maxBatchCount) {
    throw new Error(`${key} must be between 1 and ${maxBatchCount}.`);
  }
  return count;
}

function getOptionalBoolean(formData: FormData, ...keys: string[]) {
  for (const key of keys) {
    const value = getText(formData, key).toLowerCase();
    if (!value) continue;
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
  }
  return undefined;
}

function getGenerationIds(formData: FormData, count: number) {
  const directValues = formData
    .getAll("generationIds")
    .concat(formData.getAll("generation_ids"))
    .filter((value): value is string => typeof value === "string")
    .flatMap((value) => {
      const trimmed = value.trim();
      if (!trimmed) return [];
      if (!trimmed.startsWith("[")) return [trimmed];
      try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed)
          ? parsed.filter((item): item is string => typeof item === "string")
          : [];
      } catch {
        return [trimmed];
      }
    })
    .map((value) => value.trim())
    .filter(Boolean);

  if (directValues.length !== count) return undefined;
  if (directValues.some((value) => value.length > 128)) {
    throw new Error("generationIds contains an ID that is too long.");
  }
  return directValues;
}

function hasPromptImageReference(text: string | undefined) {
  return Boolean(text && PROMPT_IMAGE_REFERENCE_PATTERN.test(text));
}

function wantsStreamResponse(request: NextRequest, formData: FormData) {
  if (formData.get("stream") === "true") return true;
  return request.headers.get("accept")?.includes("text/event-stream") ?? false;
}

function getImageFiles(formData: FormData) {
  const images: File[] = [];

  for (const [key, value] of formData.entries()) {
    if (
      value instanceof File &&
      (key === "image" || key === "image[]" || key.startsWith("image_"))
    ) {
      images.push(value);
    }
  }

  return images;
}

export const POST = withApiLogging(async (request: NextRequest) => {
  const session = await auth.api.getSession({
    headers: request.headers,
  });

  if (!session?.user) {
    return errorResponse("Unauthorized", 401);
  }

  const plan = await getUserPlan(session.user.id);
  const planLimits = await getPlanLimits(plan.plan);
  const uploadLimits = await getPlanUploadLimits(plan.plan);
  const maxImageBytes = uploadLimits.maxFileSizeBytes;
  const maxRequestBytes = uploadLimits.maxUploadBytes;

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse(
      `Upload is too large or incomplete. Each source image must be ${formatMegabytes(maxImageBytes)} or smaller, and the total upload must be ${formatMegabytes(maxRequestBytes)} or smaller.`,
      413
    );
  }
  const prompt = getText(formData, "prompt");
  if (!prompt) {
    return errorResponse("Prompt is required.");
  }

  if (prompt.length > IMAGE_PROMPT_MAX_CHARACTERS) {
    return errorResponse(IMAGE_PROMPT_TOO_LONG_MESSAGE);
  }
  const apiPrompt = getText(formData, "apiPrompt") || undefined;
  if (apiPrompt && apiPrompt.length > 8000) {
    return errorResponse("Context prompt exceeds the 8000 character limit.");
  }
  const promptOptimization = getOptionalBoolean(
    formData,
    "promptOptimization",
    "prompt_optimization"
  );
  const requestedGenerationId =
    getText(formData, "generationId") || getText(formData, "generation_id");
  if (requestedGenerationId.length > 128) {
    return errorResponse("generationId is too long.");
  }
  const mixWebFirst = getOptionalBoolean(
    formData,
    "mixWebFirst",
    "mix_web_first"
  );
  const requiresResponsesBackend =
    getOptionalBoolean(
      formData,
      "requiresResponsesBackend",
      "requires_responses_backend"
    ) === true ||
    hasPromptImageReference(prompt) ||
    hasPromptImageReference(apiPrompt);

  const requestedSize = getText(formData, "size") || undefined;
  const size = requestedSize ? alignImageSizeToStep(requestedSize) : undefined;
  if (size) {
    const sizeCheck = validateImageSize(size);
    if (!sizeCheck.valid) {
      return errorResponse(sizeCheck.message);
    }
  }

  const qualityValue = getText(formData, "quality") || "auto";
  if (!VALID_QUALITIES.has(qualityValue as ImageQuality)) {
    return errorResponse("Invalid quality.");
  }
  const quality = qualityValue as ImageQuality;
  const moderationValue = getText(formData, "moderation") || "auto";
  if (!VALID_MODERATION.has(moderationValue as ImageModeration)) {
    return errorResponse("Invalid moderation.");
  }
  const moderation = moderationValue as ImageModeration;
  const outputFormatValue =
    getText(formData, "output_format") || getText(formData, "outputFormat");
  const outputFormat = normalizeOutputFormat(outputFormatValue);
  if (
    outputFormatValue &&
    !VALID_OUTPUT_FORMATS.has(outputFormat as ImageOutputFormat)
  ) {
    return errorResponse("Invalid output_format.");
  }
  const outputCompression = normalizeOutputCompression(
    getText(formData, "output_compression") ||
      getText(formData, "outputCompression")
  );
  const backgroundValue = getText(formData, "background");
  const background = normalizeImageBackground(backgroundValue);
  if (
    backgroundValue &&
    !VALID_IMAGE_BACKGROUNDS.has(background as ImageBackground)
  ) {
    return errorResponse("Invalid background.");
  }
  // 透明背景抠图回退显式开关(issue #27)。
  const transparentMatte = getOptionalBoolean(
    formData,
    "transparentMatte",
    "transparent_matte"
  );
  // 高清修复:显式 false 走轻量 general-x4v3;undefined/true 由后端选 SwinIR 超分。
  const hdRepair = getOptionalBoolean(formData, "hdRepair", "hd_repair");
  let count = 1;
  try {
    count = getCount(formData, "count", planLimits.maxBatchCount);
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : "Invalid count."
    );
  }
  if (
    count > 1 &&
    !(await canUsePlanCapability(plan.plan, "imageGeneration.batch"))
  ) {
    return errorResponse(
      "Batch image editing is not enabled for this plan.",
      403
    );
  }
  let requestedGenerationIds: string[] | undefined;
  try {
    requestedGenerationIds = getGenerationIds(formData, count);
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : "Invalid generationIds."
    );
  }

  const model = getText(formData, "model") || undefined;
  const gptModel =
    getText(formData, "gptModel") ||
    getText(formData, "gpt_model") ||
    undefined;
  const thinkingValue = getText(formData, "thinking") || undefined;
  if (thinkingValue && !VALID_THINKING.has(thinkingValue as ThinkingLevel)) {
    return errorResponse("Invalid thinking level.");
  }
  const thinking = thinkingValue as ThinkingLevel | undefined;
  const displaySize = getText(formData, "displaySize") || undefined;
  if (displaySize && !parseImageSize(displaySize)) {
    return errorResponse("Invalid display size.");
  }
  const sourceFiles = getImageFiles(formData);
  if (sourceFiles.length === 0) {
    return errorResponse("At least one source image is required.");
  }

  if (sourceFiles.length > planLimits.maxEditImages) {
    return errorResponse(
      `No more than ${planLimits.maxEditImages} images are allowed.`
    );
  }

  try {
    for (const file of sourceFiles) {
      validateImageFile(file, { maxImageBytes });
    }
    const maskFile = formData.get("mask");
    if (maskFile !== null && !(maskFile instanceof File)) {
      return errorResponse("Mask must be a PNG file.");
    }
    if (maskFile instanceof File) {
      validateImageFile(maskFile, { mask: true, maxImageBytes });
    }
    if (
      getTotalUploadSize(
        sourceFiles,
        maskFile instanceof File ? maskFile : undefined
      ) > maxRequestBytes
    ) {
      return errorResponse(
        `Total upload size must be no more than ${formatMegabytes(maxRequestBytes)}.`,
        413
      );
    }

    const batchId = randomUUID();
    const sourceImageUrls = await uploadTemporaryImageUrls(
      session.user.id,
      batchId,
      sourceFiles,
      { scope: "requests" }
    );
    const maskImageUrls =
      maskFile instanceof File
        ? await uploadTemporaryImageUrls(
            session.user.id,
            `${batchId}-mask`,
            [maskFile],
            {
              scope: "requests",
            }
          )
        : undefined;
    const useStreamResponse = wantsStreamResponse(request, formData);

    const runEdit = async (
      generationId: string,
      onPartialImage?: Parameters<typeof runImageGenerationForUser>[1]
    ) =>
      await runImageGenerationForUser(
        {
          mode: "edit",
          userId: session.user.id,
          generationId,
          backendRequestKind: "image_edit" as const,
          prompt,
          apiPrompt,
          promptOptimization,
          size: displaySize || size,
          model,
          gptModel,
          thinking,
          quality,
          moderation,
          outputFormat,
          outputCompression,
          background,
          transparentMatte,
          hdRepair,
          n: 1,
          mixWebFirst: requiresResponsesBackend ? false : mixWebFirst,
          requiresResponsesBackend,
          images: await filesToImageInputs(sourceFiles, sourceImageUrls),
          mask:
            maskFile instanceof File
              ? (await filesToImageInputs([maskFile], maskImageUrls))[0]
              : undefined,
        },
        onPartialImage
      );

    try {
      if (useStreamResponse) {
        return createImageStreamResponse(async (emit) => {
          try {
            await runBatchImageGeneration({
              count,
              concurrency: planLimits.imageGenerationConcurrency,
              generationIds:
                requestedGenerationIds ||
                (count === 1 && requestedGenerationId
                  ? [requestedGenerationId]
                  : undefined),
              run: runEdit,
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
            });

            return null;
          } finally {
            await deleteTemporaryImages(maskImageUrls);
          }
        });
      }

      if (count === 1) {
        const result = await runEdit(requestedGenerationId || randomUUID());
        return NextResponse.json(result);
      }

      const results = await runBatchImageGeneration({
        count,
        concurrency: planLimits.imageGenerationConcurrency,
        generationIds:
          requestedGenerationIds ||
          (count === 1 && requestedGenerationId
            ? [requestedGenerationId]
            : undefined),
        run: runEdit,
      });

      return NextResponse.json({
        results,
        error: firstBatchError(results)?.error,
      });
    } finally {
      if (!useStreamResponse) {
        await deleteTemporaryImages(maskImageUrls);
      }
    }
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : "Failed to edit image."
    );
  }
});
