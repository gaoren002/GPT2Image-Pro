/** 验证图片型号、分组归一、尺寸和积分纯函数，无网络及数据库依赖。 */
import { describe, expect, it } from "vitest";

import {
  alignImageSizeToStep,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_UPSTREAM_IMAGE_MODEL,
  fitImageDimensionsToValidSize,
  getImageBaseCredits,
  getImageCreditCostBreakdown,
  getImageModel,
  getImageModelForGroup,
  getQualityMultiplier,
  getThinkingMultiplier,
  GPT_IMAGE_25_FLARE_MODEL,
  GPT_IMAGE_25_MODELS,
  GPT_IMAGE_25_SUNBURST_MODEL,
  getUpstreamImageModel,
  IMAGE_1024_BASE_PIXELS,
  IMAGE_DIMENSION_STEP,
  isImageModel,
  isImageSizeWithinPixelRange,
  isValidImageDimension,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
  MIN_IMAGE_DIMENSION,
  MIN_IMAGE_PIXELS,
  normalizeImageModel,
  parseImageSize,
  QUALITY_MULTIPLIER,
  roundUpCreditAmount,
  THINKING_MULTIPLIER,
  validateImageSize,
} from "./resolution";

describe("纯 Web 分组图片模型", () => {
  it.each([
    undefined,
    "",
    "gpt-image-2",
    "gpt-image-2.5-flare",
    "firefly-nano-banana",
    "custom-image-model",
  ])("将 %s 统一为 2.5，不采用后端默认型号", (model) => {
    expect(getImageModelForGroup(model, "gpt-image-2", "web")).toBe(
      "gpt-image-2.5"
    );
  });

  it.each([
    undefined,
    "mixed",
    "responses",
  ] as const)("其他分组 %s 保留型号与校验", (group) => {
    expect(getImageModelForGroup("gpt-image-2", undefined, group)).toBe(
      "gpt-image-2"
    );
    expect(getImageModelForGroup("firefly-nano-banana", undefined, group)).toBe(
      "firefly-nano-banana"
    );
    expect(
      getImageModelForGroup("custom-image-model", undefined, group)
    ).toBeNull();
  });
});

describe("image resolution credit pricing", () => {
  it("keeps legacy default anchor prices for 1024 square and 4K", () => {
    expect(
      getImageCreditCostBreakdown("1024x1024", {
        textModerationCount: 0,
      }).baseCredits
    ).toBe(1.27);
    expect(
      getImageCreditCostBreakdown("3840x2160", {
        textModerationCount: 0,
      }).baseCredits
    ).toBe(10);
  });

  it("linearly interpolates between configured 1024 square and 4K prices", () => {
    const pricing = { base1024Credits: 2, base4kCredits: 20 };
    const halfwayPixels = (IMAGE_1024_BASE_PIXELS + MAX_IMAGE_PIXELS) / 2;

    expect(getImageBaseCredits(IMAGE_1024_BASE_PIXELS, pricing)).toBe(2);
    expect(getImageBaseCredits(MAX_IMAGE_PIXELS, pricing)).toBe(20);
    expect(getImageBaseCredits(halfwayPixels, pricing)).toBe(11);
  });

  it("clamps outside the configured anchor range", () => {
    const pricing = { base1024Credits: 2, base4kCredits: 20 };

    expect(getImageBaseCredits(512 * 512, pricing)).toBe(2);
    expect(getImageBaseCredits(MAX_IMAGE_PIXELS * 2, pricing)).toBe(20);
  });

  it("charges the 1024 base price for the legal lower-bound size", () => {
    const pricing = { base1024Credits: 2, base4kCredits: 20 };
    const lowerBoundSize = "1024x640";

    expect(validateImageSize(lowerBoundSize)).toMatchObject({
      valid: true,
      dimensions: { width: 1024, height: 640 },
    });
    expect(1024 * 640).toBe(MIN_IMAGE_PIXELS);
    expect(
      getImageCreditCostBreakdown(lowerBoundSize, {
        basePricing: pricing,
        textModerationCount: 0,
      }).baseCredits
    ).toBe(2);
  });

  it("defaults to multiplier 1.0 when quality/thinking not specified", () => {
    const withoutOptions = getImageCreditCostBreakdown("1024x1024", {
      textModerationCount: 0,
    });
    const withNullOptions = getImageCreditCostBreakdown("1024x1024", {
      textModerationCount: 0,
      quality: null,
      thinking: null,
    });

    expect(withoutOptions.qualityMultiplier).toBe(1.0);
    expect(withoutOptions.thinkingMultiplier).toBe(1.0);
    expect(withoutOptions.totalCredits).toBe(withNullOptions.totalCredits);
  });

  it("quality does not change image credits", () => {
    const base = getImageCreditCostBreakdown("1024x1024", {
      textModerationCount: 0,
    });
    const highQuality = getImageCreditCostBreakdown("1024x1024", {
      textModerationCount: 0,
      quality: "high",
    });
    const lowQuality = getImageCreditCostBreakdown("1024x1024", {
      textModerationCount: 0,
      quality: "low",
    });

    expect(highQuality.qualityMultiplier).toBe(1.0);
    expect(lowQuality.qualityMultiplier).toBe(1.0);
    expect(highQuality.totalCredits).toBe(base.totalCredits);
    expect(lowQuality.totalCredits).toBe(base.totalCredits);
  });

  it("thinking does not change image credits", () => {
    const base = getImageCreditCostBreakdown("1024x1024", {
      textModerationCount: 0,
    });
    const mediumThinking = getImageCreditCostBreakdown("1024x1024", {
      textModerationCount: 0,
      thinking: "medium",
    });
    const highThinking = getImageCreditCostBreakdown("1024x1024", {
      textModerationCount: 0,
      thinking: "high",
    });

    expect(mediumThinking.thinkingMultiplier).toBe(1.0);
    expect(highThinking.thinkingMultiplier).toBe(1.0);
    expect(mediumThinking.totalCredits).toBe(base.totalCredits);
    expect(highThinking.totalCredits).toBe(base.totalCredits);
  });

  it("combined quality and thinking do not change image credits", () => {
    const base = getImageCreditCostBreakdown("1024x1024", {
      textModerationCount: 0,
    });
    const combined = getImageCreditCostBreakdown("1024x1024", {
      textModerationCount: 0,
      quality: "high",
      thinking: "high",
    });

    expect(combined.qualityMultiplier).toBe(1.0);
    expect(combined.thinkingMultiplier).toBe(1.0);
    expect(combined.totalCredits).toBe(base.totalCredits);
  });

  it("moderation cost is unchanged by quality/thinking", () => {
    const baseWithMod = getImageCreditCostBreakdown("1024x1024", {
      textModerationCount: 1,
      imageModerationCount: 1,
    });
    const highWithMod = getImageCreditCostBreakdown("1024x1024", {
      textModerationCount: 1,
      imageModerationCount: 1,
      quality: "high",
      thinking: "high",
    });

    expect(highWithMod.moderationCredits).toBe(baseWithMod.moderationCredits);
    expect(highWithMod.moderationOnlyCredits).toBe(
      baseWithMod.moderationOnlyCredits
    );
    expect(highWithMod.totalCredits).toBe(baseWithMod.totalCredits);
  });

  it("quality=auto uses multiplier 1.0 (same as medium/default)", () => {
    const auto = getImageCreditCostBreakdown("1024x1024", {
      textModerationCount: 0,
      quality: "auto",
    });
    const medium = getImageCreditCostBreakdown("1024x1024", {
      textModerationCount: 0,
      quality: "medium",
    });

    expect(auto.qualityMultiplier).toBe(1.0);
    expect(auto.totalCredits).toBe(medium.totalCredits);
  });

  it("exposes correct multiplier constants", () => {
    expect(QUALITY_MULTIPLIER.low).toBe(1.0);
    expect(QUALITY_MULTIPLIER.medium).toBe(1.0);
    expect(QUALITY_MULTIPLIER.high).toBe(1.0);
    expect(QUALITY_MULTIPLIER.auto).toBe(1.0);
    expect(QUALITY_MULTIPLIER.xhigh).toBe(1.0);
    expect(QUALITY_MULTIPLIER.max).toBe(1.0);

    expect(THINKING_MULTIPLIER.none).toBe(1.0);
    expect(THINKING_MULTIPLIER.minimal).toBe(1.0);
    expect(THINKING_MULTIPLIER.low).toBe(1.0);
    expect(THINKING_MULTIPLIER.medium).toBe(1.0);
    expect(THINKING_MULTIPLIER.high).toBe(1.0);
    expect(THINKING_MULTIPLIER.xhigh).toBe(1.0);
  });

  it("getQualityMultiplier returns 1.0 for unknown/null values", () => {
    expect(getQualityMultiplier(null)).toBe(1.0);
    expect(getQualityMultiplier(undefined)).toBe(1.0);
  });

  it("getThinkingMultiplier returns 1.0 for unknown/null values", () => {
    expect(getThinkingMultiplier(null)).toBe(1.0);
    expect(getThinkingMultiplier(undefined)).toBe(1.0);
  });

  it("checks force web eligibility by configured pixel range", () => {
    const minPixels = 660_000;
    const maxPixels = 2_000_000;

    expect(isImageSizeWithinPixelRange("1024x1024", minPixels, maxPixels)).toBe(
      true
    );
    expect(isImageSizeWithinPixelRange("2000x1000", minPixels, maxPixels)).toBe(
      true
    );
    expect(isImageSizeWithinPixelRange("3840x2160", minPixels, maxPixels)).toBe(
      false
    );
    expect(isImageSizeWithinPixelRange("512x512", minPixels, maxPixels)).toBe(
      false
    );
    expect(isImageSizeWithinPixelRange("auto", minPixels, maxPixels)).toBe(
      false
    );
  });
});

describe("image model resolution", () => {
  it("defaults generation and edits to the 2.5 alias while preserving explicit models", () => {
    expect(DEFAULT_IMAGE_MODEL).toBe("gpt-image-2.5");
    expect(getImageModel()).toBe("gpt-image-2.5");
    expect(getImageModel("gpt-image-2")).toBe("gpt-image-2");
    expect(getImageModel(undefined, "gpt-image-2")).toBe("gpt-image-2");
    expect(getImageModel("gpt-image-2.5", "gpt-image-2")).toBe("gpt-image-2.5");
    expect(getUpstreamImageModel(getImageModel() ?? DEFAULT_IMAGE_MODEL)).toBe(
      DEFAULT_UPSTREAM_IMAGE_MODEL
    );
  });

  it("resolves only the exact 2.5 alias to Sunburst for upstream requests", () => {
    expect(getUpstreamImageModel("gpt-image-2.5")).toBe(
      "gpt-image-2.5-sunburst"
    );
    for (const model of [
      "gpt-image-2.5-sunburst",
      "gpt-image-2.5-flare",
      "gpt-image-2.5-flare-2026-09-08",
      "gpt-image-2",
      "firefly-gpt-image-2",
    ]) {
      expect(getUpstreamImageModel(model)).toBe(model);
    }
  });

  it("normalizes legacy / blank models away", () => {
    expect(normalizeImageModel(undefined)).toBeUndefined();
    expect(normalizeImageModel("  ")).toBeUndefined();
    expect(normalizeImageModel("gpt-image-1")).toBeUndefined();
    expect(normalizeImageModel(" gpt-image-2 ")).toBe("gpt-image-2");
  });

  it("identifies image models by prefix", () => {
    expect(isImageModel("gpt-image-2")).toBe(true);
    expect(isImageModel("gpt-image-1")).toBe(false); // 经 normalize 视为 legacy
    expect(isImageModel("gpt-4o")).toBe(false);
  });

  it("getImageModel passes through image models, defaults for legacy/blank, null for non-image", () => {
    expect(getImageModel("gpt-image-2")).toBe("gpt-image-2");
    expect(getImageModel(undefined)).toBe(DEFAULT_IMAGE_MODEL);
    expect(getImageModel("gpt-image-1")).toBe(DEFAULT_IMAGE_MODEL);
    expect(getImageModel("gpt-4o")).toBeNull();
    expect(getImageModel(undefined, "gpt-image-3")).toBe("gpt-image-3");
  });

  it("recognizes the gpt-image-2.5 flagship duo as image models", () => {
    expect(GPT_IMAGE_25_MODELS).toEqual([
      "gpt-image-2.5-sunburst",
      "gpt-image-2.5-flare",
    ]);
    expect(GPT_IMAGE_25_SUNBURST_MODEL).toBe("gpt-image-2.5-sunburst");
    expect(GPT_IMAGE_25_FLARE_MODEL).toBe("gpt-image-2.5-flare");
    // 2.5 双档天然命中 gpt-image- 前缀,服务端模型白名单无需单独登记。
    expect(isImageModel(GPT_IMAGE_25_SUNBURST_MODEL)).toBe(true);
    expect(isImageModel(GPT_IMAGE_25_FLARE_MODEL)).toBe(true);
    expect(getImageModel(GPT_IMAGE_25_SUNBURST_MODEL)).toBe(
      GPT_IMAGE_25_SUNBURST_MODEL
    );
    expect(getImageModel(` ${GPT_IMAGE_25_FLARE_MODEL} `)).toBe(
      GPT_IMAGE_25_FLARE_MODEL
    );
    // 大小写不敏感(内部 toLowerCase 后再按前缀匹配)。
    expect(isImageModel("GPT-IMAGE-2.5-FLARE")).toBe(true);
    // 2.5 兜底不变:显式传 2.5 不会被 DEFAULT 覆盖。
    expect(getImageModel(GPT_IMAGE_25_SUNBURST_MODEL)).not.toBe(
      DEFAULT_IMAGE_MODEL
    );
  });
});

describe("parseImageSize", () => {
  it("parses WIDTHxHEIGHT and rejects malformed strings", () => {
    expect(parseImageSize("1024x768")).toEqual({ width: 1024, height: 768 });
    expect(parseImageSize(" 1024X768 ")).toEqual({ width: 1024, height: 768 });
    expect(parseImageSize("auto")).toBeNull();
    expect(parseImageSize("1024")).toBeNull();
    expect(parseImageSize("12x34x56")).toBeNull();
  });
});

describe("alignImageSizeToStep", () => {
  it("rounds requested output dimensions to the nearest multiple of 16", () => {
    expect(alignImageSizeToStep("1025x1025")).toBe("1024x1024");
    expect(alignImageSizeToStep("1031x769")).toBe("1024x768");
    expect(alignImageSizeToStep("1032x776")).toBe("1040x784");
  });

  it("preserves aligned, auto, and malformed values for normal validation", () => {
    expect(alignImageSizeToStep("1536x1024")).toBe("1536x1024");
    expect(alignImageSizeToStep(" AUTO ")).toBe("auto");
    expect(alignImageSizeToStep("not-a-size")).toBe("not-a-size");
  });
});

describe("fitImageDimensionsToValidSize", () => {
  it("snaps results to the dimension step and stays within bounds", () => {
    for (const dimensions of [
      { width: 100, height: 100 }, // 远低于最小像素，需生长
      { width: 8000, height: 4000 }, // 超过最大像素与最大边，需收缩
      { width: 4000, height: 256 }, // 超出 3:1 宽高比，需收敛
    ]) {
      const fitted = fitImageDimensionsToValidSize(dimensions);
      expect(fitted.width % IMAGE_DIMENSION_STEP).toBe(0);
      expect(fitted.height % IMAGE_DIMENSION_STEP).toBe(0);
      expect(fitted.width).toBeGreaterThanOrEqual(MIN_IMAGE_DIMENSION);
      expect(fitted.height).toBeGreaterThanOrEqual(MIN_IMAGE_DIMENSION);
      expect(fitted.width).toBeLessThanOrEqual(MAX_IMAGE_DIMENSION);
      expect(fitted.height).toBeLessThanOrEqual(MAX_IMAGE_DIMENSION);
      expect(fitted.width * fitted.height).toBeLessThanOrEqual(
        MAX_IMAGE_PIXELS
      );
      expect(isValidImageDimension(fitted.width)).toBe(true);
      expect(isValidImageDimension(fitted.height)).toBe(true);
    }
  });

  it("grows an undersized square up to the minimum pixel budget", () => {
    const fitted = fitImageDimensionsToValidSize({ width: 100, height: 100 });
    expect(fitted.width * fitted.height).toBeGreaterThanOrEqual(
      MIN_IMAGE_PIXELS
    );
  });
});

describe("roundUpCreditAmount", () => {
  it("ceils to two decimals without float drift", () => {
    expect(roundUpCreditAmount(1.271)).toBe(1.28);
    expect(roundUpCreditAmount(1.27)).toBe(1.27);
    expect(roundUpCreditAmount(0.1 + 0.2)).toBe(0.3);
  });
});
