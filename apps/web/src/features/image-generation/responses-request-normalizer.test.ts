/** 验证原样 Responses 请求仍遵守管线解析的模型与正式图像模型 ID，不访问上游。 */
import { describe, expect, it } from "vitest";
import { normalizeResponsesImageRequestBody } from "./responses-request-normalizer";

const options = {
  model: "gpt-5.5",
  fallbackTool: { type: "image_generation", model: "gpt-image-2.5-sunburst" },
  instructions: "generate an image",
  stream: false,
};

describe("原样 Responses 请求的模型一致性", () => {
  it("写入已校验模型，覆盖原始字段并补全未指定模型的请求", () => {
    for (const raw of [
      { input: "draw" },
      { model: "gpt-6-astra", input: "draw" },
    ]) {
      const body = normalizeResponsesImageRequestBody(raw, options);
      expect(body.model).toBe("gpt-5.5");
      expect(body.input).toBe("draw");
    }
  });

  it.each([
    "none",
    "minimal",
  ])("Astra 的原始 %s 推理强度归一为 low，保留其他推理配置", (effort) => {
    const body = normalizeResponsesImageRequestBody(
      { input: "draw", reasoning: { effort, summary: "concise" } },
      { ...options, model: "gpt-6-astra" }
    );
    expect(body.reasoning).toEqual({ effort: "low", summary: "concise" });
  });

  it("保留其他模型的推理强度", () => {
    const body = normalizeResponsesImageRequestBody(
      { input: "draw", reasoning: { effort: "none", summary: "auto" } },
      { ...options, model: "gpt-5.6-sol" }
    );
    expect(body.reasoning).toEqual({ effort: "none", summary: "auto" });
  });

  it("映射所有图像工具的 2.5 简称，保留显式 Flare、旧版和其他工具", () => {
    const tools = [
      { type: "web_search" },
      { type: "image_generation", model: "gpt-image-2.5", quality: "max" },
      { type: "image_generation", model: "gpt-image-2.5-flare" },
      { type: "image_generation", model: "gpt-image-2" },
      { type: "image_generation", model: "gpt-image-2.5" },
    ];
    const body = normalizeResponsesImageRequestBody(
      { input: "draw", tools },
      options
    );
    expect(body.tools).toEqual([
      tools[0],
      {
        type: "image_generation",
        model: "gpt-image-2.5-sunburst",
        quality: "max",
      },
      tools[2],
      tools[3],
      { type: "image_generation", model: "gpt-image-2.5-sunburst" },
    ]);
    expect(tools[1]?.model).toBe("gpt-image-2.5");
  });
});
