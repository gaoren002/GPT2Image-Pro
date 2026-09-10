/**
 * Web 模型目录和请求映射回归测试；以脱敏 HAR 模型字段验证 Work/Images 协议边界。
 * 无数据库、网络或真实会话依赖。
 */
import { describe, expect, it } from "vitest";
import type { ThinkingLevel } from "./types";
import {
  IMAGES_WEB_MODEL_CATALOG,
  resolveImagesWebModel,
  resolveWorkWebModel,
  WORK_WEB_MODEL_CATALOG,
} from "./web-model-catalog";

const WORK_CASES = [
  [
    "gpt-5.5",
    "gpt-5.5-wm",
    "standard",
    ["min", "standard", "extended", "xhigh"],
  ],
  [
    "gpt-5.6-sol",
    "gpt-5.6-sol-wm",
    "min",
    ["min", "standard", "extended", "xhigh", "max", "ultra"],
  ],
  [
    "gpt-5.6-terra",
    "gpt-5.6-terra-wm",
    "standard",
    ["min", "standard", "extended", "xhigh", "max", "ultra"],
  ],
  [
    "gpt-5.6-luna",
    "gpt-5.6-luna-wm",
    "standard",
    ["min", "standard", "extended", "xhigh", "max"],
  ],
  [
    "gpt-6-astra",
    "gpt-6-astra-wm",
    "standard",
    ["min", "standard", "extended", "xhigh", "max", "ultra"],
  ],
] as const;

const THINKING_CASES: Array<[ThinkingLevel, string]> = [
  ["none", "min"],
  ["minimal", "min"],
  ["low", "min"],
  ["medium", "standard"],
  ["high", "extended"],
  ["xhigh", "xhigh"],
];

describe("verified Work Web models", () => {
  it.each(
    WORK_CASES
  )("preserves %s catalog efforts and defaults", (apiModel, modelSlug, defaultThinkingEffort, thinkingEfforts) => {
    expect(
      WORK_WEB_MODEL_CATALOG.find((model) => model.apiModel === apiModel)
    ).toEqual({ apiModel, modelSlug, defaultThinkingEffort, thinkingEfforts });
    expect(resolveWorkWebModel({ gptModel: apiModel })).toEqual({
      model: modelSlug,
      thinking_effort: defaultThinkingEffort,
      conversation_origin: "tpp",
      service_tier: "standard",
    });
  });

  it.each(
    THINKING_CASES
  )("maps %s to the verified Work effort %s", (thinking, effort) => {
    for (const [apiModel, modelSlug] of WORK_CASES) {
      expect(resolveWorkWebModel({ gptModel: apiModel, thinking })).toEqual({
        model: modelSlug,
        thinking_effort: effort,
        conversation_origin: "tpp",
        service_tier: "standard",
      });
    }
  });

  it("keeps GPT-5.5 as the default and trims known identifiers", () => {
    expect(resolveWorkWebModel({})).toEqual({
      model: "gpt-5.5-wm",
      thinking_effort: "standard",
      conversation_origin: "tpp",
      service_tier: "standard",
    });
    expect(resolveWorkWebModel({ gptModel: "  gpt-6-astra  " })?.model).toBe(
      "gpt-6-astra-wm"
    );
  });

  it("uses min when prompt optimization is disabled without changing models", () => {
    expect(
      resolveWorkWebModel({
        gptModel: "gpt-6-astra",
        thinking: "xhigh",
        promptOptimization: false,
      })
    ).toEqual({
      model: "gpt-6-astra-wm",
      thinking_effort: "min",
      conversation_origin: "tpp",
      service_tier: "standard",
    });
  });

  it.each([
    "custom-web-model",
    "gpt-6-pro",
    "gpt-5-5-thinking",
    "gpt-image-2.5",
  ])("leaves unrecognized %s to the caller's legacy route", (gptModel) => {
    expect(resolveWorkWebModel({ gptModel })).toBeNull();
  });
});

describe("verified Images Web presets", () => {
  it.each([
    ["latest", "gpt-5-6-instant", "gpt-5-6", "gpt-5-6-thinking", "gpt-6-pro"],
    ["5.6", "gpt-5-6-instant", "gpt-5-6", "gpt-5-6-thinking", "gpt-5-6-pro"],
    [
      "5.5",
      "gpt-5-5-instant",
      "gpt-5-5-instant",
      "gpt-5-5-thinking",
      "gpt-5-5-pro",
    ],
  ])("keeps all five %s presets and the instant request alias", (version, instantCatalog, instantRequest, thinkingModel, proModel) => {
    expect(
      IMAGES_WEB_MODEL_CATALOG.find((entry) => entry.version === version)
        ?.presets
    ).toEqual([
      {
        preset: "instant",
        catalogModelSlug: instantCatalog,
        requestModelSlug: instantRequest,
      },
      {
        preset: "medium",
        catalogModelSlug: thinkingModel,
        requestModelSlug: thinkingModel,
        thinkingEffort: "standard",
      },
      {
        preset: "high",
        catalogModelSlug: thinkingModel,
        requestModelSlug: thinkingModel,
        thinkingEffort: "extended",
      },
      {
        preset: "xhigh",
        catalogModelSlug: thinkingModel,
        requestModelSlug: thinkingModel,
        thinkingEffort: "max",
      },
      {
        preset: "pro",
        catalogModelSlug: proModel,
        requestModelSlug: proModel,
        thinkingEffort: "standard",
      },
    ]);
  });

  it.each([
    "none",
    "minimal",
  ] as const)("uses the observed instant request for %s", (thinking) => {
    expect(
      resolveImagesWebModel({ gptModel: "gpt-5.6-sol", thinking })
    ).toEqual({ model: "gpt-5-6" });
    expect(resolveImagesWebModel({ gptModel: "gpt-5.5", thinking })).toEqual({
      model: "gpt-5-5-instant",
    });
  });

  it.each([
    [undefined, "standard"],
    ["low", "standard"],
    ["medium", "standard"],
    ["high", "extended"],
    ["xhigh", "max"],
  ] as const)("uses verified Images thinking for %s", (thinking, effort) => {
    expect(
      resolveImagesWebModel({ gptModel: "gpt-5.6-sol", thinking })
    ).toEqual({ model: "gpt-5-6-thinking", thinking_effort: effort });
    expect(resolveImagesWebModel({ gptModel: "gpt-5.5", thinking })).toEqual({
      model: "gpt-5-5-thinking",
      thinking_effort: effort,
    });
  });

  it("keeps GPT-5.5 default and selects instant when optimization is disabled", () => {
    expect(resolveImagesWebModel({})).toEqual({
      model: "gpt-5-5-thinking",
      thinking_effort: "standard",
    });
    expect(
      resolveImagesWebModel({
        gptModel: "gpt-5.6-sol",
        thinking: "xhigh",
        promptOptimization: false,
      })
    ).toEqual({ model: "gpt-5-6" });
  });

  it.each([
    ["gpt-6-astra", "gpt-6-astra-wm"],
    ["gpt-5.6-terra", "gpt-5.6-terra-wm"],
    ["gpt-5.6-luna", "gpt-5.6-luna-wm"],
  ])("uses the verified Work main-model slug for %s", (gptModel, model) => {
    expect(resolveImagesWebModel({ gptModel, thinking: "high" })).toEqual({
      model,
      thinking_effort: "extended",
      conversation_origin: "tpp",
      service_tier: "standard",
    });
  });

  it.each([
    "custom-web-model",
    "gpt-6-pro",
  ])("does not fabricate an Images alias for %s", (gptModel) => {
    expect(resolveImagesWebModel({ gptModel })).toBeNull();
  });
});
