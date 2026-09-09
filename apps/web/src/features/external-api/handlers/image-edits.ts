/** 外部图片编辑请求适配：统一 JSON/表单输入，图片型号语义由统一操作按分组处理。 */
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { withApiLogging } from "@repo/shared/api-logger";
import {
  canUsePlanCapability,
  getPlanLimits,
} from "@repo/shared/subscription/services/plan-capabilities";
import { getPlanUploadLimits } from "@repo/shared/subscription/services/upload-limits";
import { getUserPlan } from "@repo/shared/subscription/services/user-plan";
import type { NextRequest } from "next/server";

import {
  completeAsyncImageTask,
  createAsyncImageTask,
  postAsyncImageCallback,
  toAsyncImageTaskResponse,
  validateCallbackUrl,
} from "@/features/external-api/async-image-tasks";
import { authenticateExternalApiRequest } from "@/features/external-api/auth";
import { normalizeExternalImageModelInput } from "@/features/external-api/image-model-input";
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
import {
  fetchPublicImage,
  readResponseBytesWithLimit,
} from "@/features/external-api/safe-image-fetch";
import { runBatchImageGeneration } from "@/features/image-generation/batch-runner";
import { runImageGenerationForUser } from "@/features/image-generation/operations";
import {
  normalizeImageBackground,
  normalizeOutputCompression,
  normalizeOutputFormat,
  VALID_OUTPUT_FORMATS,
} from "@/features/image-generation/output-format";
import {
  DEFAULT_MAX_IMAGE_BYTES,
  filesToImageInputs,
  formatMegabytes,
  getTotalUploadSize,
  uploadModerationImages,
  validateImageFile,
} from "@/features/image-generation/request-utils";
import {
  alignImageSizeToStep,
  IMAGE_PROMPT_MAX_CHARACTERS,
  IMAGE_PROMPT_TOO_LONG_MESSAGE,
  validateImageSize,
} from "@/features/image-generation/resolution";
import type {
  ImageModeration,
  ImageOutputFormat,
  ImageQuality,
  PartialImageResult,
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
  "minimal",
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
]);

const JSON_SCALAR_FIELDS = [
  "prompt",
  "promptOptimization",
  "prompt_optimization",
  "promptRepair",
  "prompt_repair",
  "size",
  "quality",
  "moderation",
  "output_format",
  "output_compression",
  "background",
  "transparentMatte",
  "transparent_matte",
  "n",
  "response_format",
  "model",
  "gptModel",
  "gpt_model",
  "thinking",
  "force_web",
  "forceWeb",
  "web_first",
  "webFirst",
  "force_firefly",
  "forceFirefly",
  "stream",
  "async",
  "callback_url",
] as const;

type ImageReference =
  | { type: "file"; file: File }
  | { type: "url"; url: string };
type JsonRecord = Record<string, unknown>;

class ImageReferenceError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

function isPrivateIpAddress(address: string) {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  if (normalized === "::" || normalized.startsWith("fe80:")) return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("::ffff:")) {
    return isPrivateIpAddress(normalized.replace(/^::ffff:/, ""));
  }

  const parts = normalized.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) {
    return false;
  }

  const [a = 0, b = 0] = parts.map(Number);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

async function assertPublicImageUrl(url: URL) {
  const hostname = url.hostname.toLowerCase();
  if (url.username || url.password) {
    throw new ImageReferenceError("Image URL must not include credentials.");
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new ImageReferenceError("Image URL must be publicly reachable.");
  }
  if (
    hostname === "metadata.google.internal" ||
    hostname.endsWith(".internal")
  ) {
    throw new ImageReferenceError("Image URL must be publicly reachable.");
  }

  const strippedHostname = hostname.replace(/^\[|\]$/g, "");
  const literalIp = isIP(strippedHostname);
  if (literalIp) {
    if (isPrivateIpAddress(strippedHostname)) {
      throw new ImageReferenceError("Image URL must be publicly reachable.");
    }
    return;
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (
    addresses.length === 0 ||
    addresses.some((entry) => isPrivateIpAddress(entry.address))
  ) {
    throw new ImageReferenceError("Image URL must be publicly reachable.");
  }
}

function getText(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getCount(formData: FormData, maxBatchCount: number) {
  const value = getText(formData, "n");
  if (!value) return 1;
  if (!/^\d+$/.test(value)) {
    throw new Error("n must be an integer.");
  }
  const count = Number(value);
  if (count < 1 || count > maxBatchCount) {
    throw new Error(`n must be between 1 and ${maxBatchCount}.`);
  }
  return count;
}

function getBoolean(formData: FormData, key: string) {
  const value = getText(formData, key).toLowerCase();
  return value === "true" || value === "1";
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

function isPlainRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isScalarJsonValue(value: unknown) {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function formDataFromJson(body: JsonRecord) {
  const formData = new FormData();
  for (const key of JSON_SCALAR_FIELDS) {
    const value = body[key];
    if (isScalarJsonValue(value)) {
      formData.append(key, String(value));
    }
  }
  return formData;
}

function splitUrlList(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean);
      }
    } catch {
      /* fall through to delimiter parsing */
    }
  }
  return trimmed
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function addUrlReference(
  references: ImageReference[],
  seenUrls: Set<string>,
  value: string
) {
  const url = value.trim();
  if (!url || seenUrls.has(url)) return;
  seenUrls.add(url);
  references.push({ type: "url", url });
}

function getFormImageReferences(formData: FormData) {
  const images: ImageReference[] = [];
  const seenUrls = new Set<string>();

  for (const [key, value] of formData.entries()) {
    if (
      value instanceof File &&
      (key === "image" || key === "image[]" || key.startsWith("image_"))
    ) {
      images.push({ type: "file", file: value });
      continue;
    }

    if (
      typeof value === "string" &&
      (key === "image" ||
        key === "images" ||
        key === "image_url" ||
        key === "image_url[]" ||
        key === "image_urls")
    ) {
      for (const url of splitUrlList(value)) {
        addUrlReference(images, seenUrls, url);
      }
    }
  }

  return images;
}

function jsonReferenceToUrl(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!isPlainRecord(value)) return null;

  const imageUrl = value.image_url ?? value.url;
  if (typeof imageUrl === "string" && imageUrl.trim()) {
    return imageUrl.trim();
  }

  if (typeof value.file_id === "string" && value.file_id.trim()) {
    throw new ImageReferenceError(
      "file_id image references are not supported. Use image_url or multipart image uploads."
    );
  }

  return null;
}

function getJsonImageReferences(body: JsonRecord) {
  const references: ImageReference[] = [];
  const seenUrls = new Set<string>();
  const images = body.images;
  if (Array.isArray(images)) {
    for (const item of images) {
      const url = jsonReferenceToUrl(item);
      if (url) addUrlReference(references, seenUrls, url);
    }
  } else {
    const url = jsonReferenceToUrl(images);
    if (url) addUrlReference(references, seenUrls, url);
  }

  const imageUrl = jsonReferenceToUrl(body.image_url ?? body.image);
  if (imageUrl) addUrlReference(references, seenUrls, imageUrl);

  const imageUrls = body.image_urls;
  if (Array.isArray(imageUrls)) {
    for (const item of imageUrls) {
      const url = jsonReferenceToUrl(item);
      if (url) addUrlReference(references, seenUrls, url);
    }
  } else if (typeof imageUrls === "string") {
    for (const url of splitUrlList(imageUrls)) {
      addUrlReference(references, seenUrls, url);
    }
  }

  return references;
}

function getFormMaskReference(formData: FormData) {
  const mask = formData.get("mask");
  if (mask instanceof File) {
    return { type: "file", file: mask } satisfies ImageReference;
  }
  if (typeof mask === "string" && mask.trim()) {
    return { type: "url", url: mask.trim() } satisfies ImageReference;
  }

  const maskUrl =
    getText(formData, "mask_url") || getText(formData, "mask_image_url");
  if (maskUrl) return { type: "url", url: maskUrl } satisfies ImageReference;
  return undefined;
}

function getJsonMaskReference(body: JsonRecord) {
  const url = jsonReferenceToUrl(
    body.mask ?? body.mask_url ?? body.mask_image_url
  );
  if (!url) return undefined;
  return { type: "url", url } satisfies ImageReference;
}

function getFileExtension(contentType: string) {
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  if (contentType.includes("webp")) return "webp";
  return "png";
}

async function fetchImageReference(
  reference: ImageReference,
  index: number,
  options?: { mask?: boolean; maxImageBytes?: number }
) {
  if (reference.type === "file") return reference.file;

  let url: URL;
  try {
    url = new URL(reference.url);
  } catch {
    throw new ImageReferenceError("Image URL is invalid.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ImageReferenceError("Image URL must use http or https.");
  }
  await assertPublicImageUrl(url);

  const response = await fetchPublicImage(url.toString(), {
    headers: {
      Accept: options?.mask ? "image/png" : "image/png,image/jpeg,image/webp",
    },
  });
  if (!response.ok) {
    throw new ImageReferenceError(
      `Failed to fetch image URL: HTTP ${response.status}`,
      response.status >= 500 ? 502 : 400
    );
  }

  const contentType = (
    (response.headers.get("content-type") || "").split(";")[0] || ""
  ).trim();
  const type = contentType || (options?.mask ? "image/png" : "image/png");
  const maxImageBytes = options?.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  // 流式读取并在累计超限时主动 abort：content-length 头可伪造，不能据其预判大小，
  // 也不能先把整段正文缓冲进内存（否则可被巨大响应逼近 OOM）。
  const buffer = await readResponseBytesWithLimit(
    response,
    maxImageBytes,
    () => {
      throw new ImageReferenceError(
        `${options?.mask ? "Mask" : "Image URL"} exceeds the ${formatMegabytes(maxImageBytes)} limit.`,
        413
      );
    }
  );

  return new File(
    [buffer],
    `${options?.mask ? "mask" : `image-${index + 1}`}.${getFileExtension(
      type
    )}`,
    { type }
  );
}

async function resolveImageReferences(
  references: ImageReference[],
  maxImageBytes: number
) {
  return await Promise.all(
    references.map((reference, index) =>
      fetchImageReference(reference, index, { maxImageBytes })
    )
  );
}

async function resolveMaskReference(
  reference: ImageReference | undefined,
  maxImageBytes: number
) {
  if (!reference) return undefined;
  return await fetchImageReference(reference, 0, {
    mask: true,
    maxImageBytes,
  });
}

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
    type: "image_edit.completed",
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
    type: "image_edit.partial_image",
    index,
    partial_image_index: image.partialImageIndex,
    b64_json: image.imageBase64,
    url: image.imageUrl,
  };
}

export const postExternalImageEdits = withApiLogging(
  async (request: NextRequest) => {
    const auth = await authenticateExternalApiRequest(request);
    if (!auth) {
      return openAIImageError(
        "Invalid or missing API key",
        401,
        "invalid_api_key"
      );
    }
    if (!(await canUsePlanCapability(auth.plan, "externalApi.images.edit"))) {
      return openAIImageError(
        "External image editing is not enabled for this plan.",
        403,
        "insufficient_plan"
      );
    }

    const plan = await getUserPlan(auth.userId);
    const planLimits = await getPlanLimits(plan.plan);
    const uploadLimits = await getPlanUploadLimits(plan.plan);
    const maxImageBytes = uploadLimits.maxFileSizeBytes;
    const maxRequestBytes = uploadLimits.maxUploadBytes;

    let formData: FormData;
    let imageReferences: ImageReference[];
    let maskReference: ImageReference | undefined;
    try {
      const contentType = request.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const body = (await request.json()) as unknown;
        if (!isPlainRecord(body)) {
          return openAIImageError("Request body must be a JSON object.");
        }
        // 避免数字/布尔值被 FormData 转为可放行的任意别名，其余非法类型也不能静默丢弃。
        if (body.model !== undefined && typeof body.model !== "string") {
          return openAIImageError("model must be a string.");
        }
        formData = formDataFromJson(body);
        imageReferences = getJsonImageReferences(body);
        maskReference = getJsonMaskReference(body);
      } else {
        formData = await request.formData();
        if (formData.getAll("model").some((value) => typeof value !== "string")) {
          return openAIImageError("model must be a string.");
        }
        imageReferences = getFormImageReferences(formData);
        maskReference = getFormMaskReference(formData);
      }
    } catch (error) {
      if (error instanceof ImageReferenceError) {
        return openAIImageError(error.message, error.status);
      }
      return openAIImageError(
        `Upload is too large or incomplete. Each source image must be ${formatMegabytes(maxImageBytes)} or smaller, and the total upload must be ${formatMegabytes(maxRequestBytes)} or smaller.`,
        413
      );
    }

    const prompt = getText(formData, "prompt");
    if (!prompt) {
      return openAIImageError("Prompt is required.");
    }
    if (prompt.length > IMAGE_PROMPT_MAX_CHARACTERS) {
      return openAIImageError(IMAGE_PROMPT_TOO_LONG_MESSAGE);
    }
    const promptOptimization = getOptionalBoolean(
      formData,
      "promptOptimization",
      "prompt_optimization"
    );
    // 审核改写重试开关(issue #24):传 false 时,审核拦截后不自动改写提示词重试,直接返回真实错误。
    const moderationPromptRepair = getOptionalBoolean(
      formData,
      "promptRepair",
      "prompt_repair"
    );

    const requestedSize = getText(formData, "size") || undefined;
    const size = requestedSize ? alignImageSizeToStep(requestedSize) : undefined;
    if (size) {
      const sizeCheck = validateImageSize(size);
      if (!sizeCheck.valid) {
        return openAIImageError(sizeCheck.message);
      }
    }

    const qualityValue = getText(formData, "quality") || "auto";
    if (!VALID_QUALITIES.has(qualityValue as ImageQuality)) {
      return openAIImageError("Invalid quality.");
    }
    const quality = qualityValue as ImageQuality;
    const moderationValue = getText(formData, "moderation") || "auto";
    if (!VALID_MODERATION.has(moderationValue as ImageModeration)) {
      return openAIImageError("Invalid moderation.");
    }
    const moderation = moderationValue as ImageModeration;
    const outputFormatValue = getText(formData, "output_format");
    const outputFormat = normalizeOutputFormat(outputFormatValue);
    if (
      outputFormatValue &&
      !VALID_OUTPUT_FORMATS.has(outputFormat as ImageOutputFormat)
    ) {
      return openAIImageError("Invalid output_format.");
    }
    const outputCompression = normalizeOutputCompression(
      getText(formData, "output_compression")
    );
    const backgroundValue = getText(formData, "background");
    const background = normalizeImageBackground(backgroundValue);
    if (backgroundValue && !background) {
      return openAIImageError("Invalid background.");
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
      count = getCount(formData, planLimits.maxBatchCount);
    } catch (error) {
      return openAIImageError(
        error instanceof Error ? error.message : "Invalid n."
      );
    }
    if (
      count > 1 &&
      !(await canUsePlanCapability(plan.plan, "imageGeneration.batch"))
    ) {
      return openAIImageError(
        "Batch image editing is not enabled for this plan.",
        403,
        "insufficient_plan"
      );
    }
    if (count > planLimits.maxBatchCount) {
      return openAIImageError(
        `n must be between 1 and ${planLimits.maxBatchCount}.`
      );
    }

    const responseFormat =
      getText(formData, "response_format") === "url" ? "url" : "b64_json";
    const model = normalizeExternalImageModelInput(
      getText(formData, "model") || undefined
    );
    const gptModel =
      getText(formData, "gptModel") ||
      getText(formData, "gpt_model") ||
      undefined;
    const thinkingValue = getText(formData, "thinking") || undefined;
    if (thinkingValue && !VALID_THINKING.has(thinkingValue as ThinkingLevel)) {
      return openAIImageError("Invalid thinking level.");
    }
    const thinking = thinkingValue as ThinkingLevel | undefined;
    const forceWebBackend = getOptionalBoolean(
      formData,
      "web_first",
      "webFirst",
      "force_web",
      "forceWeb"
    );
    // force_firefly：强制把本次编辑请求路由到 adobe（firefly）后端，对任意模型生效。
    const forceFirefly = getOptionalBoolean(
      formData,
      "force_firefly",
      "forceFirefly"
    );
    if (imageReferences.length === 0) {
      return openAIImageError("At least one source image is required.");
    }
    if (imageReferences.length > planLimits.maxEditImages) {
      return openAIImageError(
        `No more than ${planLimits.maxEditImages} images are allowed.`
      );
    }
    if (
      wantsImageStreamResponse(
        request,
        getOptionalBoolean(formData, "stream")
      ) &&
      !(await canUsePlanCapability(plan.plan, "externalApi.streaming"))
    ) {
      return openAIImageError(
        "External API streaming is not enabled for this plan.",
        403,
        "insufficient_plan"
      );
    }
    const useStreamResponse = wantsImageStreamResponse(
      request,
      getBoolean(formData, "stream")
    );
    const useAsync =
      getOptionalBoolean(formData, "async") === true ||
      request.nextUrl.searchParams.get("async") === "true";
    if (useAsync && useStreamResponse) {
      return openAIImageError("async cannot be used with stream.");
    }
    let callbackUrl: string | undefined;
    const callbackUrlValue = getText(formData, "callback_url");
    if (callbackUrlValue) {
      try {
        callbackUrl = await validateCallbackUrl(callbackUrlValue);
      } catch (error) {
        return openAIImageError(
          error instanceof Error ? error.message : "Invalid callback_url."
        );
      }
    }

    try {
      const sourceFiles = await resolveImageReferences(
        imageReferences,
        maxImageBytes
      );
      for (const file of sourceFiles) {
        validateImageFile(file, { maxImageBytes });
      }

      const maskFile = await resolveMaskReference(maskReference, maxImageBytes);
      if (maskFile) {
        validateImageFile(maskFile, { mask: true, maxImageBytes });
      }

      if (getTotalUploadSize(sourceFiles, maskFile) > maxRequestBytes) {
        return openAIImageError(
          `Total upload size must be no more than ${formatMegabytes(maxRequestBytes)}.`,
          413
        );
      }

      const batchId = randomUUID();
      const moderationImages = await uploadModerationImages(
        auth.userId,
        batchId,
        sourceFiles
      );

      const buildImages = async () =>
        await filesToImageInputs(sourceFiles, moderationImages);

      const buildMask = async () =>
        maskFile ? (await filesToImageInputs([maskFile]))[0] : undefined;

      const runEdit = async (
        generationId: string,
        onPartialImage?: Parameters<typeof runImageGenerationForUser>[1]
      ) =>
        await runImageGenerationForUser(
          {
            mode: "edit",
            userId: auth.userId,
            generationId,
            apiKeyId: auth.apiKeyId,
            relayOnly: auth.relayOnly,
            backendRequestKind: "image_edit" as const,
            prompt,
            promptOptimization,
            moderationPromptRepair,
            moderationBlockRiskLevel: auth.moderationBlockRiskLevel,
            size,
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
            forceWebBackend,
            forceFirefly,
            images: await buildImages(),
            mask: await buildMask(),
          },
          onPartialImage
        );

      if (useStreamResponse) {
        return createExternalImageStreamResponse(async (emit) => {
          await runBatchImageGeneration({
            count,
            concurrency: planLimits.imageGenerationConcurrency,
            run: runEdit,
            callbacks: (index) => ({
              onPartialImage: async (image) => {
                await emit({
                  event: "image_edit.partial_image",
                  data: toPartialPayload(image, index),
                });
              },
            }),
            onResult: async (result, index) => {
              if (result.error) {
                const errorPayload = toLoggedOpenAIErrorPayload(
                  result.error,
                  {
                    route: "/v1/images/edits",
                    stream: true,
                    index,
                    model,
                    size,
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
                event: "image_edit.completed",
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
          model,
          generationIds,
        });

        void (async () => {
          const results = await runBatchImageGeneration({
            count,
            concurrency: planLimits.imageGenerationConcurrency,
            generationIds,
            run: runEdit,
          });
          const resultPayload = await toOpenAIImagesResponse(
            request,
            results,
            responseFormat,
            created,
            {
              route: "/v1/images/edits",
              async: true,
              model,
              size,
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
            error instanceof Error ? error.message : "Async image edit failed"
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
            concurrency: planLimits.imageGenerationConcurrency,
            run: runEdit,
          });
          return await toOpenAIImagesResponse(
            request,
            results,
            responseFormat,
            created,
            {
              route: "/v1/images/edits",
              stream: false,
              model,
              size,
            }
          );
        },
        { initialWaitMs: IMAGE_JSON_KEEP_ALIVE_INITIAL_WAIT_MS }
      );
    } catch (error) {
      if (error instanceof ImageReferenceError) {
        return openAIImageError(error.message, error.status);
      }
      return openAIImageError(
        error instanceof Error ? error.message : "Failed to edit image."
      );
    }
  }
);
