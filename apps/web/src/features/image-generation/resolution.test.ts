/** 验证图片型号、分组归一、尺寸和积分纯函数，无网络及数据库依赖。 */
import { describe, expect, it } from "vitest";

import {
  alignImageSizeToStep,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_UPSTREAM_IMAGE_MODEL,
  fitImageDimensionsToValidSize,
  getExactRatioImageSize,
  getImageBaseCredits,
  parseImageSizeRatio,
  snapImageSizeToExactRatio,
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

describe("getExactRatioImageSize", () => {
  it("returns mathematically exact ratio sizes on the 16px grid", () => {
    // 3:2 档位 1K：1248x832 恰好精确（1248/832=1.5）
    const three2 = getExactRatioImageSize(3, 2, 1248);
    expect(three2).toEqual({ width: 1248, height: 832 });
    // 16:9 档位 1K：旧预设 1248x704 非精确，新算法取 1280x720
    const wide = getExactRatioImageSize(16, 9, 1248);
    expect(wide).toEqual({ width: 1280, height: 720 });
    // 竖版镜像
    const tall = getExactRatioImageSize(9, 16, 1248);
    expect(tall).toEqual({ width: 720, height: 1280 });
    // 4:3 档位 1K：旧预设 1248x928 非精确，新算法取 1280x960
    const four3 = getExactRatioImageSize(4, 3, 1248);
    expect(four3).toEqual({ width: 1280, height: 960 });
  });

  it("keeps every result an exact ratio, 16px grid, within pixel bounds", () => {
    const ratios: Array<[number, number]> = [
      [1, 1], [3, 2], [2, 3], [16, 9], [9, 16], [4, 3], [3, 4],
      [21, 9], [9, 21], [1, 2], [2, 1], [1, 3], [3, 1],
    ];
    for (const [rw, rh] of ratios) {
      for (const edge of [1248, 2048, 3840]) {
        const result = getExactRatioImageSize(rw, rh, edge);
        if (!result) continue; // 无精确解（如 4K 1:1 超像素上限）回退旧路径
        expect(result.width % IMAGE_DIMENSION_STEP).toBe(0);
        expect(result.height % IMAGE_DIMENSION_STEP).toBe(0);
        expect(result.width / result.height).toBeCloseTo(rw / rh, 10);
        expect(result.width * result.height).toBeLessThanOrEqual(
          MAX_IMAGE_PIXELS
        );
        expect(result.width * result.height).toBeGreaterThanOrEqual(
          MIN_IMAGE_PIXELS
        );
        expect(result.width).toBeGreaterThanOrEqual(MIN_IMAGE_DIMENSION);
        expect(result.width).toBeLessThanOrEqual(MAX_IMAGE_DIMENSION);
        expect(result.height).toBeGreaterThanOrEqual(MIN_IMAGE_DIMENSION);
        expect(result.height).toBeLessThanOrEqual(MAX_IMAGE_DIMENSION);
      }
    }
  });

  it("caps at the pixel budget by shrinking to the largest exact grid", () => {
    // 4K 1:1（3840x3840 = 14.7M 像素超上限）：缩到 2880x2880（恰好卡在 8.29M 上限且精确）
    expect(getExactRatioImageSize(1, 1, 3840)).toEqual({
      width: 2880,
      height: 2880,
    });
    // 4K 3:2：3520x2352 非精确且超限，取像素内最大精确栅格 3504x2336
    const big = getExactRatioImageSize(3, 2, 3840);
    expect(big).toEqual({ width: 3504, height: 2336 });
    // 4K 21:9：3808x1632 精确且在像素预算内
    const ultrawide = getExactRatioImageSize(21, 9, 3840);
    expect(ultrawide).toEqual({ width: 3808, height: 1632 });
  });

  it("returns null for degenerate ratio inputs", () => {
    expect(getExactRatioImageSize(0, 1, 1248)).toBeNull();
    expect(getExactRatioImageSize(1, Number.NaN, 1248)).toBeNull();
  });
});

describe("parseImageSizeRatio", () => {
  it("accepts standard ratio strings", () => {
    expect(parseImageSizeRatio("3:2")).toEqual({ width: 3, height: 2 });
    expect(parseImageSizeRatio("21:9")).toEqual({ width: 21, height: 9 });
    expect(parseImageSizeRatio("1:1")).toEqual({ width: 1, height: 1 });
    expect(parseImageSizeRatio(" 9:16 ")).toEqual({ width: 9, height: 16 });
  });

  it("rejects non-ratio or out-of-range strings", () => {
    expect(parseImageSizeRatio("1024x1024")).toBeNull();
    expect(parseImageSizeRatio("auto")).toBeNull();
    expect(parseImageSizeRatio("0:1")).toBeNull();
    expect(parseImageSizeRatio("4:1")).toBeNull(); // 超 3:1 比例上限
    expect(parseImageSizeRatio("99:1")).toBeNull();
  });

  it("passes through ratio strings in alignImageSizeToStep and validateImageSize", () => {
    expect(alignImageSizeToStep("3:2")).toBe("3:2");
    const check = validateImageSize("16:9");
    expect(check.valid).toBe(true);
  });
});

describe("snapImageSizeToExactRatio", () => {
  it("snaps near-ratio sizes to the nearest exact grid", () => {
    // suduma 实测案例：3520x2352（约 3:2）→ 3504x2336
    expect(snapImageSizeToExactRatio("3520x2352")).toBe("3504x2336");
    // 16:9 家族：1248x704 → 1280x720
    expect(snapImageSizeToExactRatio("1248x704")).toBe("1280x720");
    // 4:3 家族：1248x928 → 1280x960
    expect(snapImageSizeToExactRatio("1248x928")).toBe("1280x960");
  });

  it("keeps already-exact and non-size inputs unchanged", () => {
    expect(snapImageSizeToExactRatio("3840x2160")).toBe("3840x2160");
    expect(snapImageSizeToExactRatio("3504x2336")).toBe("3504x2336");
    expect(snapImageSizeToExactRatio("auto")).toBe("auto");
    expect(snapImageSizeToExactRatio("3:2")).toBe("3:2");
  });
});

describe("snapImageSizeToExactRatio small custom sizes", () => {
  it("snaps small custom sizes past the pixel minimum (suduma whitelist case)", () => {
    // 624x1072(用户自定义小尺寸):最近比例 9:16,最近栅格 576x1024 低于
    // 像素下限,兜底取该比例最大合法栅格 720x1280——不再原样发(必死)。
    expect(snapImageSizeToExactRatio("624x1072")).toBe("720x1280");
  });

  it("keeps behavior for sizes whose nearest grid is legal", () => {
    expect(snapImageSizeToExactRatio("3520x2352")).toBe("3504x2336");
    expect(snapImageSizeToExactRatio("1248x704")).toBe("1280x720");
  });
});
