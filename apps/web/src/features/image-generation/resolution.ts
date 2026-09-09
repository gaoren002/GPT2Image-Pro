/**
 * 图像模型解析、尺寸约束与积分换算，供创作页和统一图像管线共用。
 * 站内 2.5 简称在出站时解析为正式模型 ID，历史模型保持原样。
 */
export const DEFAULT_IMAGE_MODEL = "gpt-image-2.5";
export const GPT_IMAGE_25_SUNBURST_MODEL = "gpt-image-2.5-sunburst";
export const GPT_IMAGE_25_FLARE_MODEL = "gpt-image-2.5-flare";
export const GPT_IMAGE_25_MODELS = [
  GPT_IMAGE_25_SUNBURST_MODEL,
  GPT_IMAGE_25_FLARE_MODEL,
] as const;
export const DEFAULT_UPSTREAM_IMAGE_MODEL = GPT_IMAGE_25_SUNBURST_MODEL;
export const IMAGE_MODEL_IDS = [
  DEFAULT_IMAGE_MODEL,
  ...GPT_IMAGE_25_MODELS,
  "gpt-image-2",
] as const;
export const LEGACY_IMAGE_MODEL = "gpt-image-1";
export const IMAGE_MODEL_PREFIX = "gpt-image-";
// Adobe Firefly（直连/网关）图像模型统一前缀；按模型前缀自动路由到 adobe 后端。
export const FIREFLY_MODEL_PREFIX = "firefly-";
export const IMAGE_PROMPT_MAX_CHARACTERS = 32_000;
export const IMAGE_PROMPT_TOO_LONG_MESSAGE = `Prompt exceeds the ${IMAGE_PROMPT_MAX_CHARACTERS} character limit.`;
export const AUTO_IMAGE_SIZE = "auto";
export const IMAGE_1K_BASE_EDGE = 1248;
export const IMAGE_1K_BASE_SIZE = `${IMAGE_1K_BASE_EDGE}x${IMAGE_1K_BASE_EDGE}`;
export const DEFAULT_IMAGE_SIZE = "1024x1024";
export const IMAGE_DIMENSION_STEP = 16;
export const MIN_IMAGE_DIMENSION = 256;
export const MAX_IMAGE_DIMENSION = 3840;
export const MAX_IMAGE_ASPECT_RATIO = 3;
export const MIN_IMAGE_PIXELS = 655360;
export const MAX_IMAGE_PIXELS = 3840 * 2160;
export const IMAGE_1024_BASE_PIXELS = 1024 * 1024;
export const DEFAULT_IMAGE_1024_BASE_CREDIT_COST = 1.27;
export const DEFAULT_IMAGE_4K_BASE_CREDIT_COST = 10;
export const IMAGE_4K_BASE_CREDIT_COST = DEFAULT_IMAGE_4K_BASE_CREDIT_COST;
export const REFERENCE_CREDIT_PRICE_CNY = 0.05;
export const TEXT_MODERATION_PRICE_CNY = 0.002;
export const IMAGE_MODERATION_PRICE_CNY = 0.003;
const CREDIT_DECIMAL_PLACES = 2;
const CREDIT_DECIMAL_FACTOR = 10 ** CREDIT_DECIMAL_PLACES;
const CREDIT_ROUNDING_EPSILON = 1e-9;

export type ImageDimensions = {
  width: number;
  height: number;
};

export function normalizeImageModel(model?: string | null) {
  const requested = model?.trim();
  if (!requested || requested === LEGACY_IMAGE_MODEL) return undefined;
  return requested;
}

export function isImageModel(model?: string | null) {
  const normalizedModel = normalizeImageModel(model)?.toLowerCase();
  return Boolean(
    normalizedModel?.startsWith(IMAGE_MODEL_PREFIX) ||
      normalizedModel?.startsWith(FIREFLY_MODEL_PREFIX)
  );
}

// 是否 Adobe Firefly 模型（按前缀）。用于创作页/接口在 firefly 模型时切换到 adobe 专属
// 参数（宽高比/分辨率），并隐藏 gpt 专属选项。
export function isFireflyModel(model?: string | null) {
  return Boolean(
    normalizeImageModel(model)?.toLowerCase().startsWith(FIREFLY_MODEL_PREFIX)
  );
}

export function getImageModel(model?: string | null, fallback?: string | null) {
  const requested = normalizeImageModel(model);
  if (requested) {
    return isImageModel(requested) ? requested : null;
  }

  const fallbackModel = normalizeImageModel(fallback);
  if (fallbackModel && isImageModel(fallbackModel)) return fallbackModel;

  return DEFAULT_IMAGE_MODEL;
}

/** 将站内默认简称解析为上游正式 ID；显式模型和后端自定义名称不变。 */
export function getUpstreamImageModel(model: string): string {
  const requested = model.trim();
  return requested.toLowerCase() === DEFAULT_IMAGE_MODEL
    ? DEFAULT_UPSTREAM_IMAGE_MODEL
    : requested;
}

export const IMAGE_RESOLUTION_PRESETS = [
  { value: AUTO_IMAGE_SIZE, label: "Auto", detail: "Backend decides" },
  { value: IMAGE_1K_BASE_SIZE, label: "1K Square", detail: "1248 × 1248" },
  { value: "1536x1024", label: "Landscape", detail: "1536 × 1024" },
  { value: "1024x1536", label: "Portrait", detail: "1024 × 1536" },
  { value: "2048x2048", label: "2K Square", detail: "2048 × 2048" },
  { value: "2048x1152", label: "2K Wide", detail: "2048 × 1152" },
  { value: "3840x2160", label: "4K Wide", detail: "3840 × 2160" },
  { value: "2160x3840", label: "4K Tall", detail: "2160 × 3840" },
] as const;

/**
 * 质量等级仅作为上游请求参数，不参与本站积分计费。
 */
export const QUALITY_MULTIPLIER: Record<string, number> = {
  low: 1.0,
  medium: 1.0,
  high: 1.0,
  auto: 1.0,
  // gpt-image-2.5（sunburst/flare）新增档位；质量不参与本站计费，维持 1.0。
  xhigh: 1.0,
  max: 1.0,
} as const;

/**
 * 思考/推理等级仅作为上游请求参数，不参与本站积分计费。
 */
export const THINKING_MULTIPLIER: Record<string, number> = {
  none: 1.0,
  minimal: 1.0,
  low: 1.0,
  medium: 1.0,
  high: 1.0,
  xhigh: 1.0,
} as const;

export type ImageQualityLevel =
  | "low"
  | "medium"
  | "high"
  | "auto"
  | "xhigh"
  | "max";
export type ImageThinkingLevel =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export type ImageCreditCostOptions = {
  textModerationCount?: number;
  imageModerationCount?: number;
  basePricing?: ImageBaseCreditPricing;
  /** 图像质量等级，仅用于保留计价明细兼容字段，不影响积分。 */
  quality?: ImageQualityLevel | null;
  /** 思考/推理等级，仅用于保留计价明细兼容字段，不影响积分。 */
  thinking?: ImageThinkingLevel | null;
};

export type ImageBaseCreditPricing = {
  base1024Credits?: number;
  base4kCredits?: number;
};

export function roundCreditAmount(value: number) {
  return (
    Math.round((value + Number.EPSILON) * CREDIT_DECIMAL_FACTOR) /
    CREDIT_DECIMAL_FACTOR
  );
}

export function roundUpCreditAmount(value: number) {
  return (
    Math.ceil((value - CREDIT_ROUNDING_EPSILON) * CREDIT_DECIMAL_FACTOR) /
    CREDIT_DECIMAL_FACTOR
  );
}

function normalizeBaseCreditPrice(value: unknown, fallback: number) {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function getImageBaseCreditPricing(
  pricing?: ImageBaseCreditPricing | null
) {
  return {
    base1024Credits: normalizeBaseCreditPrice(
      pricing?.base1024Credits,
      DEFAULT_IMAGE_1024_BASE_CREDIT_COST
    ),
    base4kCredits: normalizeBaseCreditPrice(
      pricing?.base4kCredits,
      DEFAULT_IMAGE_4K_BASE_CREDIT_COST
    ),
  };
}

export function getImageBaseCredits(
  pixels: number,
  pricing?: ImageBaseCreditPricing | null
) {
  const safePixels =
    Number.isFinite(pixels) && pixels > 0 ? pixels : MAX_IMAGE_PIXELS;
  const { base1024Credits, base4kCredits } = getImageBaseCreditPricing(pricing);
  if (safePixels <= IMAGE_1024_BASE_PIXELS) return base1024Credits;
  if (safePixels >= MAX_IMAGE_PIXELS) return base4kCredits;

  const progress =
    (safePixels - IMAGE_1024_BASE_PIXELS) /
    (MAX_IMAGE_PIXELS - IMAGE_1024_BASE_PIXELS);
  return base1024Credits + (base4kCredits - base1024Credits) * progress;
}

/**
 * 质量不再影响积分；保留函数用于历史明细和调用方兼容。
 */
export function getQualityMultiplier(
  _quality?: ImageQualityLevel | null
): number {
  return 1.0;
}

/**
 * 思考强度不再影响积分；保留函数用于历史明细和调用方兼容。
 */
export function getThinkingMultiplier(
  _thinking?: ImageThinkingLevel | null
): number {
  return 1.0;
}

export function getImageCreditCostBreakdown(
  size?: string | null,
  options: ImageCreditCostOptions = {}
) {
  const normalizedSize = size || DEFAULT_IMAGE_SIZE;
  const dimensions =
    parseImageSize(normalizedSize) || parseImageSize(DEFAULT_IMAGE_SIZE);
  const pixels = dimensions
    ? dimensions.width * dimensions.height
    : MAX_IMAGE_PIXELS;
  const baseCredits = getImageBaseCredits(pixels, options.basePricing);

  // 质量和思考强度仅影响上游请求，不再影响本站积分。
  const qualityMultiplier = getQualityMultiplier(options.quality);
  const thinkingMultiplier = getThinkingMultiplier(options.thinking);
  const effectiveBaseCredits = baseCredits * qualityMultiplier * thinkingMultiplier;

  const textModerationCount = options.textModerationCount ?? 1;
  const imageModerationCount = options.imageModerationCount ?? 0;
  const moderationCny =
    textModerationCount * TEXT_MODERATION_PRICE_CNY +
    imageModerationCount * IMAGE_MODERATION_PRICE_CNY;
  const moderationCredits = moderationCny / REFERENCE_CREDIT_PRICE_CNY;
  const totalCredits = roundUpCreditAmount(
    effectiveBaseCredits + moderationCredits
  );
  const moderationOnlyCredits =
    moderationCny > 0 ? roundUpCreditAmount(moderationCredits) : 0;

  return {
    baseCredits: roundUpCreditAmount(effectiveBaseCredits),
    effectiveBaseCredits: roundUpCreditAmount(effectiveBaseCredits),
    imageModerationCount,
    moderationCny,
    moderationCredits: roundCreditAmount(moderationCredits),
    moderationOnlyCredits,
    pixels,
    qualityMultiplier,
    textModerationCount,
    thinkingMultiplier,
    totalCredits,
  };
}

export function getImageCreditCost(
  size?: string | null,
  options: ImageCreditCostOptions = {}
) {
  return getImageCreditCostBreakdown(size, options).totalCredits;
}

export function parseImageSize(size: string): ImageDimensions | null {
  const match = size
    .trim()
    .toLowerCase()
    .match(/^(\d{2,5})x(\d{2,5})$/);
  if (!match) return null;

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;

  return { width, height };
}

export function isOneKImageSize(size?: string | null) {
  if (!size || size.trim().toLowerCase() === AUTO_IMAGE_SIZE) return false;
  const dimensions = parseImageSize(size);
  if (!dimensions) return false;
  return Math.max(dimensions.width, dimensions.height) <= IMAGE_1K_BASE_EDGE;
}

export function getImageSizePixels(size?: string | null) {
  if (!size || size.trim().toLowerCase() === AUTO_IMAGE_SIZE) return null;
  const dimensions = parseImageSize(size);
  if (!dimensions) return null;
  return dimensions.width * dimensions.height;
}

export function isImageSizeWithinPixelRange(
  size: string | null | undefined,
  minPixels: number,
  maxPixels: number
) {
  const pixels = getImageSizePixels(size);
  if (pixels === null) return false;
  const lower = Math.min(minPixels, maxPixels);
  const upper = Math.max(minPixels, maxPixels);
  return pixels >= lower && pixels <= upper;
}

export function normalizeImageSize(width: number, height: number) {
  return `${width}x${height}`;
}

function clampDimension(value: number) {
  return Math.min(MAX_IMAGE_DIMENSION, Math.max(MIN_IMAGE_DIMENSION, value));
}

function roundToImageStep(value: number) {
  return Math.round(value / IMAGE_DIMENSION_STEP) * IMAGE_DIMENSION_STEP;
}

export function alignImageSizeToStep(size: string) {
  const normalized = size.trim().toLowerCase();
  if (normalized === AUTO_IMAGE_SIZE) return AUTO_IMAGE_SIZE;

  const dimensions = parseImageSize(normalized);
  if (!dimensions) return normalized;

  return normalizeImageSize(
    roundToImageStep(dimensions.width),
    roundToImageStep(dimensions.height)
  );
}

function ceilToImageStep(value: number) {
  return Math.ceil(value / IMAGE_DIMENSION_STEP) * IMAGE_DIMENSION_STEP;
}

function floorToImageStep(value: number) {
  return Math.floor(value / IMAGE_DIMENSION_STEP) * IMAGE_DIMENSION_STEP;
}

function enforceMaxAspectRatio(dimensions: ImageDimensions): ImageDimensions {
  let width = dimensions.width;
  let height = dimensions.height;

  if (width > height * MAX_IMAGE_ASPECT_RATIO) {
    height = ceilToImageStep(width / MAX_IMAGE_ASPECT_RATIO);
  } else if (height > width * MAX_IMAGE_ASPECT_RATIO) {
    width = ceilToImageStep(height / MAX_IMAGE_ASPECT_RATIO);
  }

  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    const scale = Math.min(
      MAX_IMAGE_DIMENSION / width,
      MAX_IMAGE_DIMENSION / height
    );
    width = floorToImageStep(width * scale);
    height = floorToImageStep(height * scale);
  }

  return {
    width: clampDimension(width),
    height: clampDimension(height),
  };
}

function growToMinPixels(dimensions: ImageDimensions): ImageDimensions {
  let width = dimensions.width;
  let height = dimensions.height;

  if (width * height < MIN_IMAGE_PIXELS) {
    const scale = Math.sqrt(MIN_IMAGE_PIXELS / (width * height));
    width = clampDimension(ceilToImageStep(width * scale));
    height = clampDimension(ceilToImageStep(height * scale));
  }

  ({ width, height } = enforceMaxAspectRatio({ width, height }));

  while (width * height < MIN_IMAGE_PIXELS) {
    const canGrowWidth =
      width < MAX_IMAGE_DIMENSION &&
      (width + IMAGE_DIMENSION_STEP) / height <= MAX_IMAGE_ASPECT_RATIO;
    const canGrowHeight =
      height < MAX_IMAGE_DIMENSION &&
      (height + IMAGE_DIMENSION_STEP) / width <= MAX_IMAGE_ASPECT_RATIO;

    if (!canGrowWidth && !canGrowHeight) break;

    if ((width <= height && canGrowWidth) || !canGrowHeight) {
      width += IMAGE_DIMENSION_STEP;
    } else {
      height += IMAGE_DIMENSION_STEP;
    }
  }

  return { width, height };
}

export function fitImageDimensionsToValidSize(
  dimensions: ImageDimensions
): ImageDimensions {
  const originalWidth = Math.max(1, dimensions.width);
  const originalHeight = Math.max(1, dimensions.height);
  const pixelScale = Math.min(
    1,
    Math.sqrt(MAX_IMAGE_PIXELS / (originalWidth * originalHeight))
  );
  const maxScale = Math.min(
    MAX_IMAGE_DIMENSION / originalWidth,
    MAX_IMAGE_DIMENSION / originalHeight,
    pixelScale
  );
  const scaledWidth = originalWidth * maxScale;
  const scaledHeight = originalHeight * maxScale;
  let width = clampDimension(roundToImageStep(scaledWidth));
  let height = clampDimension(roundToImageStep(scaledHeight));

  ({ width, height } = enforceMaxAspectRatio({ width, height }));

  while (width * height > MAX_IMAGE_PIXELS) {
    const widthOverflow = width / scaledWidth;
    const heightOverflow = height / scaledHeight;
    if (widthOverflow >= heightOverflow && width > MIN_IMAGE_DIMENSION) {
      width -= IMAGE_DIMENSION_STEP;
    } else if (height > MIN_IMAGE_DIMENSION) {
      height -= IMAGE_DIMENSION_STEP;
    } else {
      break;
    }
  }

  ({ width, height } = growToMinPixels({ width, height }));

  return {
    width: floorToImageStep(width),
    height: floorToImageStep(height),
  };
}

export function normalizeValidImageSize(dimensions: ImageDimensions) {
  const valid = fitImageDimensionsToValidSize(dimensions);
  return normalizeImageSize(valid.width, valid.height);
}

export function isValidImageDimension(value: number) {
  return (
    Number.isInteger(value) &&
    value >= MIN_IMAGE_DIMENSION &&
    value <= MAX_IMAGE_DIMENSION &&
    value % IMAGE_DIMENSION_STEP === 0
  );
}

export function validateImageSize(
  size: string
):
  | { valid: true; dimensions: ImageDimensions | null; auto: boolean }
  | { valid: false; message: string } {
  if (size.trim().toLowerCase() === AUTO_IMAGE_SIZE) {
    return { valid: true, dimensions: null, auto: true };
  }

  const dimensions = parseImageSize(size);
  if (!dimensions) {
    return { valid: false, message: "Use WIDTHxHEIGHT format." };
  }

  if (
    !isValidImageDimension(dimensions.width) ||
    !isValidImageDimension(dimensions.height)
  ) {
    return {
      valid: false,
      message: `Width and height must be between ${MIN_IMAGE_DIMENSION} and ${MAX_IMAGE_DIMENSION}px and divisible by ${IMAGE_DIMENSION_STEP}.`,
    };
  }

  if (dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) {
    return {
      valid: false,
      message: `Total pixels must be no more than ${MAX_IMAGE_PIXELS.toLocaleString()}.`,
    };
  }

  if (dimensions.width * dimensions.height < MIN_IMAGE_PIXELS) {
    return {
      valid: false,
      message: `Total pixels must be at least ${MIN_IMAGE_PIXELS.toLocaleString()}.`,
    };
  }

  const longEdge = Math.max(dimensions.width, dimensions.height);
  const shortEdge = Math.min(dimensions.width, dimensions.height);
  if (longEdge / shortEdge > MAX_IMAGE_ASPECT_RATIO) {
    return {
      valid: false,
      message: `Aspect ratio must be no more than ${MAX_IMAGE_ASPECT_RATIO}:1.`,
    };
  }

  return { valid: true, dimensions, auto: false };
}
