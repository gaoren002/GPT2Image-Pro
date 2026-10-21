/**
 * API 模型映射：键展开、质量分档、渠道预设。
 */
import { describe, expect, it } from "vitest";

import {
  applyApiModelMapping,
  collectApiModelMappingKeys,
  parseApiModelMapping,
  PRESET_GEMINI_IMAGE_MAPPING,
  PRESET_GPT_IMAGE_ADOBE_MAPPING,
} from "./api-model-mapping";

describe("collectApiModelMappingKeys", () => {
  it("展开 2.5 变体与 firefly 前缀", () => {
    expect(collectApiModelMappingKeys("gpt-image-2.5-sunburst")).toEqual([
      "gpt-image-2.5-sunburst",
      "gpt-image-2.5",
    ]);
    expect(collectApiModelMappingKeys("firefly-gpt-image-2")).toEqual([
      "firefly-gpt-image-2",
      "gpt-image-2",
    ]);
  });
});

describe("parseApiModelMapping", () => {
  it("丢弃非法项并截断", () => {
    expect(
      parseApiModelMapping([
        { from: "gpt-image-2", to: "gpt-image-2-ad" },
        { from: "", to: "x" },
        { from: "a", to: "b", whenQuality: "high", setQuality: "high" },
        { from: "c", to: "d", whenQuality: "nope" },
      ])
    ).toEqual([
      { from: "gpt-image-2", to: "gpt-image-2-ad" },
      {
        from: "a",
        to: "b",
        whenQuality: "high",
        setQuality: "high",
      },
      { from: "c", to: "d" },
    ]);
    expect(parseApiModelMapping(null)).toEqual([]);
  });
});

describe("applyApiModelMapping", () => {
  it("无规则时保持原型号", () => {
    expect(
      applyApiModelMapping({
        resolvedModel: "gpt-image-2.5-sunburst",
        requestedModel: "gpt-image-2.5",
        quality: "high",
      })
    ).toEqual({ model: "gpt-image-2.5-sunburst", quality: "high" });
  });

  it("GPT Image -ad 预设：普通档与高清档分流", () => {
    expect(
      applyApiModelMapping({
        resolvedModel: "gpt-image-2.5-sunburst",
        requestedModel: "gpt-image-2.5",
        quality: "medium",
        mapping: PRESET_GPT_IMAGE_ADOBE_MAPPING,
      })
    ).toEqual({ model: "gpt-image-2-ad", quality: "medium" });

    expect(
      applyApiModelMapping({
        resolvedModel: "gpt-image-2.5-sunburst",
        requestedModel: "gpt-image-2.5",
        quality: "high",
        mapping: PRESET_GPT_IMAGE_ADOBE_MAPPING,
      })
    ).toEqual({ model: "gpt-image-2-high", quality: "high" });

    expect(
      applyApiModelMapping({
        resolvedModel: "gpt-image-2.5-flare",
        quality: "xhigh",
        mapping: PRESET_GPT_IMAGE_ADOBE_MAPPING,
      })
    ).toEqual({ model: "gpt-image-2-high", quality: "high" });
  });

  it("Gemini 预设：nano-banana 家族改写", () => {
    expect(
      applyApiModelMapping({
        resolvedModel: "nano-banana-pro",
        mapping: PRESET_GEMINI_IMAGE_MAPPING,
      })
    ).toEqual({
      model: "gemini-3-pro-image-preview-ad",
      quality: undefined,
    });

    expect(
      applyApiModelMapping({
        resolvedModel: "nano-banana2",
        mapping: PRESET_GEMINI_IMAGE_MAPPING,
      })
    ).toEqual({
      model: "gemini-3.1-flash-image-preview-ad",
      quality: undefined,
    });
  });

  it("质量条件不匹配时回落到无条件规则", () => {
    expect(
      applyApiModelMapping({
        resolvedModel: "gpt-image-2",
        quality: "low",
        mapping: PRESET_GPT_IMAGE_ADOBE_MAPPING,
      })
    ).toEqual({ model: "gpt-image-2-ad", quality: "low" });
  });
});
