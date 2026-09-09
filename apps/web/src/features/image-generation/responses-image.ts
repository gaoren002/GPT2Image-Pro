import {
  normalizeImageBackground,
  normalizeOutputCompression,
  normalizeOutputFormat,
} from "./output-format";
import {
  buildOpenAIPromptCacheKey,
  buildPromptCacheSalt,
} from "./openai-prompt-cache";
import {
  AUTO_IMAGE_SIZE,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_SIZE,
  getImageModel,
} from "./resolution";
import {
  resolvePromptImageReferences,
  withResponsesImageReferenceInstructions,
} from "./responses-native-state";
import { getInputImageUrl } from "./input-image-url";
import type {
  ApiConfig,
  EditImageParams,
  GenerateImageParams,
  ImageBackground,
  ImageInputFile,
  ImageModeration,
  ImageOutputFormat,
  ImageQuality,
  ThinkingLevel,
} from "./types";

type ResponsesImageRequest = {
  model: string;
  input: Array<{
    type: "message";
    role: "user";
    content: Array<
      | { type: "input_text"; text: string }
      | { type: "input_image"; image_url: string }
      | { type: "input_image"; file_id: string }
    >;
  }>;
  tools: Array<{
    type: "image_generation";
    action: "generate" | "edit";
    model: string;
    partial_images?: number;
    size?: string;
    quality?: ImageQuality;
    moderation?: ImageModeration;
    output_format?: ImageOutputFormat;
    output_compression?: number;
    background?: ImageBackground;
    input_image_mask?: { image_url: string };
  }>;
  tool_choice: { type: "image_generation" };
  stream: boolean;
  store: boolean;
  parallel_tool_calls: boolean;
  reasoning: {
    effort: ThinkingLevel;
    summary: "auto";
  };
  include: string[];
  instructions?: string;
  prompt_cache_key?: string;
};

const RESPONSES_IMAGE_INSTRUCTIONS =
  "You are an image generation assistant. Use the image_generation tool to satisfy the user's request and return the generated image.";

const RESPONSES_IMAGE_ORIGINAL_PROMPT_INSTRUCTIONS =
  "Use the user's original image prompt exactly as written for image generation. Do not rewrite, expand, translate, polish, or optimize the prompt before calling the image_generation tool.";

function getInputImageContent(image: ImageInputFile, forceBase64?: boolean) {
  if (image.imageFileId?.trim()) {
    return { type: "input_image" as const, file_id: image.imageFileId.trim() };
  }
  return {
    type: "input_image" as const,
    image_url: getInputImageUrl(image, { forceBase64 }),
  };
}

function referenceTag(refId: string, prompt?: string) {
  const safePrompt = prompt
    ?.slice(0, 500)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return safePrompt
    ? `<ref id="${refId}" prompt="${safePrompt}" />`
    : `<ref id="${refId}" />`;
}

function getEditReferenceLabel(
  refId: string,
  imageNumber: number,
  prompt?: string
) {
  return `@图${imageNumber} / ${referenceTag(refId, prompt)}`;
}

function getEditImageContent(images: ImageInputFile[], forceBase64?: boolean) {
  return images.flatMap((image, index) => {
    const imageNumber = index + 1;
    const refId = `edit-reference-${imageNumber}`;
    const label = getEditReferenceLabel(refId, imageNumber, image.name);
    return [
      {
        type: "input_text" as const,
        text: `The next source image is labeled ${label}. Use this label when the user refers to this exact source image.`,
      },
      getInputImageContent(image, forceBase64),
      {
        type: "input_text" as const,
        text: `The source image above is ${label}.`,
      },
    ];
  });
}

function getResponsesModel(config: ApiConfig, model?: string) {
  const requested = model?.trim();
  if (requested && !requested.startsWith("gpt-image-")) {
    return requested;
  }
  const configured = config.model?.trim();
  if (configured && !configured.startsWith("gpt-image-")) {
    return configured;
  }
  return "gpt-5.4-mini";
}

function getToolModel(config: ApiConfig, model?: string) {
  return getImageModel(model, config.model) || DEFAULT_IMAGE_MODEL;
}

function getPrompt(params: GenerateImageParams | EditImageParams) {
  if (params.promptOptimization === false) {
    return params.prompt;
  }
  return params.apiPrompt || params.prompt;
}

function getInstructions(params: GenerateImageParams | EditImageParams) {
  if (params.promptOptimization !== false) return undefined;
  return RESPONSES_IMAGE_ORIGINAL_PROMPT_INSTRUCTIONS;
}

function toolCacheSignature(tool: ResponsesImageRequest["tools"][number]) {
  return [
    tool.action,
    tool.model,
    tool.size,
    tool.quality,
    tool.moderation,
    tool.output_format,
    tool.output_compression,
    tool.background,
    tool.input_image_mask ? "mask" : "",
  ]
    .filter((value) => value !== undefined && value !== "")
    .join(":");
}

function normalizeQuality(quality?: string): ImageQuality | undefined {
  if (
    quality === "low" ||
    quality === "medium" ||
    quality === "high" ||
    quality === "auto" ||
    // gpt-image-2.5（sunburst/flare）新增档位。
    quality === "xhigh" ||
    quality === "max"
  ) {
    return quality;
  }
  return undefined;
}

function normalizeModeration(moderation?: string): ImageModeration | undefined {
  if (moderation === "auto" || moderation === "low") return moderation;
  return undefined;
}

function normalizeThinking(thinking?: string): ThinkingLevel {
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
  return "medium";
}

/**
 * 构造 Responses 生图请求。生图无输入图，forceBase64 仅为与 edit 路径签名对齐，
 * 当前无实际作用（保留以便调用方统一传参）。
 */
export function buildResponsesImageGenerationRequest(
  config: ApiConfig,
  params: GenerateImageParams,
  _forceBase64?: boolean
): ResponsesImageRequest {
  const prompt = getPrompt(params);
  const size = params.size || DEFAULT_IMAGE_SIZE;
  const tool: ResponsesImageRequest["tools"][number] = {
    type: "image_generation",
    action: "generate",
    model: getToolModel(config, params.model),
    partial_images: 2,
  };

  if (size && size !== AUTO_IMAGE_SIZE) tool.size = size;
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

  const instructions = getInstructions(params) || RESPONSES_IMAGE_INSTRUCTIONS;
  const responseModel = getResponsesModel(config, params.gptModel);

  const input: ResponsesImageRequest["input"] = [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: prompt }],
    },
  ];
  return {
    model: responseModel,
    input,
    tools: [tool],
    tool_choice: { type: "image_generation" },
    stream: true,
    store: false,
    parallel_tool_calls: true,
    reasoning: { effort: normalizeThinking(params.thinking), summary: "auto" },
    include: ["reasoning.encrypted_content"],
    instructions,
    prompt_cache_key: buildOpenAIPromptCacheKey(config, {
      scope: "responses-image-generation",
      model: responseModel,
      imageModel: tool.model,
      promptOptimization: params.promptOptimization,
      toolSignature: toolCacheSignature(tool),
      inputSignature: buildPromptCacheSalt(),
    }),
  };
}

/**
 * 构造 Responses 改图请求。forceBase64=true 时把输入图与 mask 强制内联为 base64
 * （上游下载我方 URL 失败时的一次性兜底，详见 input-image-url.ts）。
 */
export function buildResponsesImageEditRequest(
  config: ApiConfig,
  params: EditImageParams,
  forceBase64?: boolean
): ResponsesImageRequest {
  const prompt = resolvePromptImageReferences({
    prompt: getPrompt(params),
    images: params.images,
  }).prompt.replace(/current-reference-/g, "edit-reference-");
  const size = params.size || DEFAULT_IMAGE_SIZE;
  const tool: ResponsesImageRequest["tools"][number] = {
    type: "image_generation",
    action: "edit",
    model: getToolModel(config, params.model),
    partial_images: 2,
  };

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
  if (params.mask) {
    tool.input_image_mask = {
      image_url: getInputImageUrl(params.mask, { forceBase64 }),
    };
  }

  const instructions = withResponsesImageReferenceInstructions(
    getInstructions(params) || RESPONSES_IMAGE_INSTRUCTIONS
  );
  const responseModel = getResponsesModel(config, params.gptModel);

  const input: ResponsesImageRequest["input"] = [
    {
      type: "message",
      role: "user",
      content: [
        ...getEditImageContent(params.images, forceBase64),
        { type: "input_text", text: `User edit request: ${prompt}` },
      ],
    },
  ];
  return {
    model: responseModel,
    input,
    tools: [tool],
    tool_choice: { type: "image_generation" },
    stream: true,
    store: false,
    parallel_tool_calls: true,
    reasoning: { effort: normalizeThinking(params.thinking), summary: "auto" },
    include: ["reasoning.encrypted_content"],
    instructions,
    prompt_cache_key: buildOpenAIPromptCacheKey(config, {
      scope: "responses-image-edit",
      model: responseModel,
      imageModel: tool.model,
      promptOptimization: params.promptOptimization,
      toolSignature: toolCacheSignature(tool),
      // 每请求唯一盐 → key 每请求唯一:不同参考图不串图,同一张参考图也能要不同结果。
      inputSignature: buildPromptCacheSalt(),
    }),
  };
}
