import { describe, expect, it } from "vitest";

import {
  normalizeModelBillingForStorage,
  parseModelBilling,
  resolveModelBilling,
  resolveModelBillingMultiplier,
} from "./model-billing";

describe("parseModelBilling", () => {
  it("keeps valid entries and drops invalid ones", () => {
    const parsed = parseModelBilling({
      "gpt-image-2.5-sunburst-gzs": 1.4,
      "gpt-image-2": "2",
      "  ": 3,
      bad: -1,
      nan: "abc",
    });
    expect(parsed).toEqual({
      "gpt-image-2.5-sunburst-gzs": 1.4,
      "gpt-image-2": 2,
    });
  });

  it("accepts per-quality tables and drops illegal levels", () => {
    const parsed = parseModelBilling({
      "model-a": { high: 1.4, max: 1.8, ultra: 2 },
    });
    expect(parsed["model-a"]).toEqual({ high: 1.4, max: 1.8 });
  });

  it("clamps multipliers into [0.01, 100] with two decimals", () => {
    const parsed = parseModelBilling({
      tiny: 0.0001,
      huge: 1000,
      round: 1.006,
    });
    expect(parsed.tiny).toBe(0.01);
    expect(parsed.huge).toBe(100);
    expect(parsed.round).toBe(1.01);
  });

  it("returns empty config for non-object input", () => {
    expect(parseModelBilling(null)).toEqual({});
    expect(parseModelBilling("x")).toEqual({});
    expect(parseModelBilling([1])).toEqual({});
  });
});

describe("normalizeModelBillingForStorage", () => {
  it("returns null for empty or all-invalid input", () => {
    expect(normalizeModelBillingForStorage({})).toBeNull();
    expect(normalizeModelBillingForStorage({ a: -1 })).toBeNull();
    expect(normalizeModelBillingForStorage({ a: {} })).toBeNull();
  });

  it("keeps explicit 1 multipliers", () => {
    expect(normalizeModelBillingForStorage({ "gpt-image-2": 1 })).toEqual({
      "gpt-image-2": 1,
    });
  });
});

describe("resolveModelBilling", () => {
  const config = {
    "gpt-image-2": 2,
    "gpt-image-2.5-sunburst": 1.5,
    "gpt-image-2.5-flare-gzs": { low: 1, high: 1.4, max: 1.8 },
  };

  it("matches model ids exactly and multiplies flat entries", () => {
    expect(resolveModelBilling(config, "gpt-image-2", "high")).toEqual({
      multiplier: 2,
      replacesQualityBilling: false,
    });
    expect(
      resolveModelBilling(config, "gpt-image-2.5-sunburst", "low")
    ).toEqual({ multiplier: 1.5, replacesQualityBilling: false });
  });

  it("does not prefix-match sibling models", () => {
    // 精确命中规则:gpt-image-2 的配置不得命中 gpt-image-2.5 / 带后缀变体
    expect(resolveModelBilling(config, "gpt-image-2.5", "high").multiplier).toBe(
      1
    );
    expect(
      resolveModelBilling(config, "gpt-image-2-high", "high").multiplier
    ).toBe(1);
    expect(
      resolveModelBilling(config, "GPT-IMAGE-2", "high").multiplier
    ).toBe(1);
  });

  it("resolves per-quality tables by requested quality and replaces member-level table", () => {
    const high = resolveModelBilling(
      config,
      "gpt-image-2.5-flare-gzs",
      "high"
    );
    expect(high).toEqual({ multiplier: 1.4, replacesQualityBilling: true });
    const low = resolveModelBilling(config, "gpt-image-2.5-flare-gzs", "low");
    expect(low).toEqual({ multiplier: 1, replacesQualityBilling: true });
    // 未配置的档位(如 medium)回退 1,但仍取代成员级质量表
    const medium = resolveModelBilling(
      config,
      "gpt-image-2.5-flare-gzs",
      "medium"
    );
    expect(medium).toEqual({ multiplier: 1, replacesQualityBilling: true });
  });

  it("falls back xhigh/max to high in per-quality tables", () => {
    const xhigh = resolveModelBilling(
      config,
      "gpt-image-2.5-flare-gzs",
      "xhigh"
    );
    expect(xhigh).toEqual({ multiplier: 1.4, replacesQualityBilling: true });
    const max = resolveModelBilling(config, "gpt-image-2.5-flare-gzs", "max");
    expect(max).toEqual({ multiplier: 1.8, replacesQualityBilling: true });
  });

  it("returns 1 for missing model or config", () => {
    expect(resolveModelBilling(config, undefined, "high")).toEqual({
      multiplier: 1,
      replacesQualityBilling: false,
    });
    expect(resolveModelBilling(config, "   ", "high").multiplier).toBe(1);
    expect(resolveModelBilling(null, "gpt-image-2", "high").multiplier).toBe(1);
    expect(resolveModelBilling({}, "gpt-image-2", "high").multiplier).toBe(1);
    // 未带 quality 的分档模型:无法定档,回退 1(不再叠成员级表)
    expect(
      resolveModelBilling(config, "gpt-image-2.5-flare-gzs", undefined)
    ).toEqual({ multiplier: 1, replacesQualityBilling: true });
  });
});

describe("resolveModelBillingMultiplier (legacy signature)", () => {
  it("returns just the multiplier number", () => {
    expect(
      resolveModelBillingMultiplier(
        { "gpt-image-2": 2 },
        "gpt-image-2",
        "high"
      )
    ).toBe(2);
  });
});
