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
// 已下线的 Adobe Firefly 图像模型统一前缀；仅用于防御性拒收判定，不再参与路由。
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
  return Boolean(normalizedModel?.startsWith(IMAGE_MODEL_PREFIX));
}

// 是否已下线的 Adobe Firefly 模型（按前缀）。Firefly 通道移除后仅作防御性拒收判定
// （如 /api/images/chat 对旧客户端仍发 firefly-* 的兜底），不再参与模型列表与路由。
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

/**
 * 按已选主分组解析实际图片型号，供生成记录、计费和出站共用；不改变文本模型。
 * 纯 Web 忽略任意输入和后端默认值，统一为 2.5；其他分组仍校验图片型号，无副作用。
 */
export function getImageModelForGroup(
  model?: string | null,
  fallback?: string | null,
  groupBackendType?: "web" | "mixed" | "responses"
) {
  return groupBackendType === "web"
    ? DEFAULT_IMAGE_MODEL
    : getImageModel(model, fallback);
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

// ============================================
// 精确比例预设（基准分辨率 x 宽高比 档位）
// ============================================
// 部分上游（如 suduma）会拒绝"约等于"预设比例的尺寸（如 3:2 档出 3520x2352，
// 2352*1.5=3528≠3520），只接受能整除出精确比例的 WIDTHxHEIGHT。这里改为在
// "双边均为 16 步进"的栅格上挑选数学上精确的预设值，避免上游 400/502。
// 无法精确表达的档位（像素上限内无解）回退到旧的四舍五入路径。

/** 计算精确比例栅格尺寸：短边为 16 步进且为比例分母（约分后）的倍数，
 * 长边随之精确导出且同样落在 16 步进上。返回 null 表示该比例在本站
 * 尺寸/像素约束下无精确解（如 4K 1:1 会超出像素上限）。 */
export function getExactRatioImageSize(
  ratioWidth: number,
  ratioHeight: number,
  longEdgeTarget: number
): ImageDimensions | null {
  if (
    !Number.isFinite(ratioWidth) ||
    !Number.isFinite(ratioHeight) ||
    ratioWidth <= 0 ||
    ratioHeight <= 0
  ) {
    return null;
  }
  const gcd = (a: number, b: number): number =>
    b === 0 ? a : gcd(b, a % b);
  const divisor = gcd(Math.round(ratioWidth), Math.round(ratioHeight)) || 1;
  const unitWidth = Math.round(ratioWidth) / divisor;
  const unitHeight = Math.round(ratioHeight) / divisor;
  const landscape = unitWidth >= unitHeight;
  // 短边的比例单元；短边必须是它的倍数，长边才能整数导出
  const shortUnit = landscape ? unitHeight : unitWidth;
  const longUnit = landscape ? unitWidth : unitHeight;
  const targetShort =
    (longEdgeTarget * Math.min(unitWidth, unitHeight)) /
    Math.max(unitWidth, unitHeight);
  const baseStep = Math.round(targetShort / IMAGE_DIMENSION_STEP);
  // 双向搜索离目标短边最近的合法精确栅格。窗口给足：像素上限可能要求
  // 大幅缩档（如 4K 3:2 的精确解在 3504x2336，距目标短边 14 步），
  // 240 步已覆盖整个尺寸区间，实际合法解远在此之前出现。
  for (let delta = 0; delta <= 240; delta++) {
    for (const sign of delta === 0 ? [1] : [1, -1]) {
      const shortEdge = (baseStep + sign * delta) * IMAGE_DIMENSION_STEP;
      if (
        shortEdge < MIN_IMAGE_DIMENSION ||
        shortEdge > MAX_IMAGE_DIMENSION
      ) {
        continue;
      }
      if (shortEdge % shortUnit !== 0) continue;
      const longEdge = (shortEdge / shortUnit) * longUnit;
      if (
        longEdge % IMAGE_DIMENSION_STEP !== 0 ||
        longEdge < MIN_IMAGE_DIMENSION ||
        longEdge > MAX_IMAGE_DIMENSION
      ) {
        continue;
      }
      const width = landscape ? longEdge : shortEdge;
      const height = landscape ? shortEdge : longEdge;
      const pixels = width * height;
      if (pixels < MIN_IMAGE_PIXELS || pixels > MAX_IMAGE_PIXELS) continue;
      return { width, height };
    }
  }
  return null;
}

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

  const ratio = parseImageSizeRatio(normalized);
  if (ratio) return normalized; // 合法比例串原样放行，由尺寸校验/上游侧处理

  const dimensions = parseImageSize(normalized);
  if (!dimensions) return normalized;

  return normalizeImageSize(
    roundToImageStep(dimensions.width),
    roundToImageStep(dimensions.height)
  );
}

/**
 * 解析 "W:H" 比例串（如 "3:2"、"21:9"，1-21 的正整数，比例不超过 3:1）。
 * 下游 API（v1/images/*）接受比例串作为 size，交给上游按自家方言处理；
 * 返回 null 表示不是合法比例串。
 */
export function parseImageSizeRatio(size: string): {
  width: number;
  height: number;
} | null {
  const match = size.trim().match(/^([1-9]\d?)\s*:\s*([1-9]\d?)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width > 21 || height > 21) return null; // 常规宽高比不会超过 21
  if (width / height > MAX_IMAGE_ASPECT_RATIO) return null;
  if (height / width > MAX_IMAGE_ASPECT_RATIO) return null;
  return { width, height };
}

/**
 * 把任意 WxH 吸附到「数学上精确比例 + 双边 16 步进」的最近栅格尺寸。
 * 用于 exact-ratio 方言上游（如 suduma gzs：只接受能整除出精确比例的 WxH，
 * 约等于比例的尺寸一律 400/502）。吸附在全部标准比例（1:1..3:1，含 4:5/5:4
 * 竖横镜像）中找比例最接近者，再取该比例下离原尺寸最近的合法精确栅格；
 * 偏差始终小于一个比例档位间距（视觉无感）。找不到任何合法栅格时原样返回
 * （由上游按自家规则兜底）。
 */
export function snapImageSizeToExactRatio(size: string): string {
  const dimensions = parseImageSize(size);
  if (!dimensions) return size;
  const ratio = dimensions.width / dimensions.height;
  // 标准比例全集（suduma 报错信息列出的清单 + 常见档位，横竖镜像都含）
  const STANDARD_RATIOS: Array<[number, number]> = [
    [1, 1], [4, 5], [5, 4], [3, 4], [4, 3], [2, 3], [3, 2],
    [1, 2], [2, 1], [9, 16], [16, 9], [9, 21], [21, 9],
    [1, 3], [3, 1],
  ];
  let best: { width: number; height: number; diff: number } | null = null;
  for (const [rw, rh] of STANDARD_RATIOS) {
    const diff = Math.abs(rw / rh - ratio);
    if (best && diff >= best.diff) continue;
    // 用原尺寸长边作为目标，吸附到该比例的最近精确栅格。getExactRatioImageSize
    // 的像素下限可能拒绝小尺寸的最近栅格（如 9:16 的 576x1024 < 65 万像素），
    // 此时放宽为「该比例下像素上限内最大的精确栅格」兜底——白名单上游
    // （suduma）收到非精确比例 100% 拒，宁可尺寸略偏也不能原样发。
    const longEdge = Math.max(dimensions.width, dimensions.height);
    const snapped =
      getExactRatioImageSize(rw, rh, longEdge) ??
      getExactRatioImageSize(rw, rh, MAX_IMAGE_DIMENSION);
    if (!snapped) continue;
    best = { ...snapped, diff };
  }
  if (!best) return size;
  return normalizeImageSize(best.width, best.height);
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
  // 比例串（"3:2" 等）：合法即放行，dimensions 为空、auto 为 false——
  // 具体尺寸由上游决定；本站像素计价按兜底（详见调用方）。
  if (parseImageSizeRatio(size)) {
    return { valid: true, dimensions: null, auto: false };
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
