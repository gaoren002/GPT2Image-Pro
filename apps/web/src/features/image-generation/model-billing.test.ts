import { describe, expect, it } from "vitest";

import {
  normalizeModelBillingForStorage,
  parseModelBilling,
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
  });

  it("keeps explicit 1 multipliers", () => {
    expect(normalizeModelBillingForStorage({ "gpt-image-2": 1 })).toEqual({
      "gpt-image-2": 1,
    });
  });
});

describe("resolveModelBillingMultiplier", () => {
  const config = {
    "gpt-image-2": 2,
    "gpt-image-2.5-sunburst": 1.5,
  };

  it("matches model ids exactly (case-sensitive, no prefix)", () => {
    expect(resolveModelBillingMultiplier(config, "gpt-image-2")).toBe(2);
    expect(resolveModelBillingMultiplier(config, "gpt-image-2.5-sunburst")).toBe(
      1.5
    );
  });

  it("does not prefix-match sibling models", () => {
    // 精确命中规则:gpt-image-2 的配置不得命中 gpt-image-2.5 / 带后缀变体
    expect(resolveModelBillingMultiplier(config, "gpt-image-2.5")).toBe(1);
    expect(
      resolveModelBillingMultiplier(config, "gpt-image-2-high")
    ).toBe(1);
    expect(resolveModelBillingMultiplier(config, "GPT-IMAGE-2")).toBe(1);
  });

  it("returns 1 for missing model or config", () => {
    expect(resolveModelBillingMultiplier(config, undefined)).toBe(1);
    expect(resolveModelBillingMultiplier(config, "   ")).toBe(1);
    expect(resolveModelBillingMultiplier(null, "gpt-image-2")).toBe(1);
    expect(resolveModelBillingMultiplier({}, "gpt-image-2")).toBe(1);
  });
});
