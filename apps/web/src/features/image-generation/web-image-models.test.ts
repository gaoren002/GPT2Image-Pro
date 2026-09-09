/**
 * 验证 Web 图像协议的模型边界，供后端调度和发送前校验共用；不访问数据库或网络。
 */
import { describe, expect, it } from "vitest";
import {
  supportsWebImageModel,
  unsupportedWebImageModelError,
} from "./web-image-models";

describe("ChatGPT Web 图像模型能力", () => {
  it.each([
    "gpt-image-2",
    "gpt-image-2.web",
    " GPT-IMAGE-2.WEB ",
    "gpt-image-1.5",
    "gpt-image-1-mini",
  ])("保留现有 Web 图像入口 %s", (model) => {
    expect(supportsWebImageModel(model)).toBe(true);
    expect(unsupportedWebImageModelError(model)).toBeNull();
  });

  it.each([
    "gpt-image-2.5",
    "gpt-image-2.5.web",
    "gpt-image-2.5-flare",
    "gpt-image-2.5-flare.web",
    "gpt-image-2.5-sunburst",
    " GPT-IMAGE-2.5-SUNBURST.WEB ",
    "gpt-image-2.5-sunburst-2026-09-08",
  ])("无法指定图像版本时拒绝 %s，不降级为 picture_v2", (model) => {
    expect(supportsWebImageModel(model)).toBe(false);
    expect(unsupportedWebImageModelError(model)).toContain(
      "WEB_IMAGE_MODEL_UNAVAILABLE"
    );
    expect(unsupportedWebImageModelError(model)).toContain("API / Codex");
  });
});
