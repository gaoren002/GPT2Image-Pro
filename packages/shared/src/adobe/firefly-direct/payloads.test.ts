import { describe, expect, it } from "vitest";
import {
  buildFireflyImagePayloadCandidates,
  gptImageDetailLevelFromQuality,
  gptImagePixelsFromRatio,
  sizeFromRatio,
} from "./payloads";

describe("sizeFromRatio", () => {
  it("2K 默认表", () => {
    expect(sizeFromRatio("16:9")).toEqual({ width: 2752, height: 1536 });
    expect(sizeFromRatio("1:1")).toEqual({ width: 2048, height: 2048 });
  });
  it("1K / 4K", () => {
    expect(sizeFromRatio("1:1", "1K")).toEqual({ width: 1024, height: 1024 });
    expect(sizeFromRatio("1:1", "4K")).toEqual({ width: 4096, height: 4096 });
  });
  it("未知比例回退 16:9", () => {
    expect(sizeFromRatio("7:3")).toEqual(sizeFromRatio("16:9"));
  });
});

describe("gptImagePixelsFromRatio", () => {
  it("已知比例", () => {
    expect(gptImagePixelsFromRatio("16:9")).toEqual({
      width: 2560,
      height: 1440,
    });
  });
  it("未支持比例返回 null", () => {
    expect(gptImagePixelsFromRatio("1:8")).toBeNull();
  });
});

describe("gptImageDetailLevelFromQuality", () => {
  it("low/medium/high", () => {
    expect(gptImageDetailLevelFromQuality("low")).toBe(1);
    expect(gptImageDetailLevelFromQuality("medium")).toBe(3);
    expect(gptImageDetailLevelFromQuality("high")).toBe(5);
    expect(gptImageDetailLevelFromQuality(null)).toBe(1);
  });

  it("gpt-image-2.5 新档位 xhigh/max 取最高 detailLevel", () => {
    expect(gptImageDetailLevelFromQuality("xhigh")).toBe(5);
    expect(gptImageDetailLevelFromQuality("max")).toBe(5);
  });
});

describe("buildFireflyImagePayloadCandidates", () => {
  it("gpt-image 文生图：单候选，含 modelSpecificPayload.size + detailLevel", () => {
    const candidates = buildFireflyImagePayloadCandidates({
      prompt: "a cat",
      aspectRatio: "16:9",
      outputResolution: "2K",
      upstreamModelId: "gpt-image",
      upstreamModelVersion: "2",
      qualityLevel: "high",
    });
    expect(candidates).toHaveLength(1);
    const p = candidates[0] as Record<string, unknown>;
    expect(p.modelId).toBe("gpt-image");
    expect((p.modelSpecificPayload as Record<string, unknown>).size).toBe(
      "2560x1440"
    );
    expect((p.generationSettings as Record<string, unknown>).detailLevel).toBe(
      5
    );
    expect(p.size).toEqual({ width: 2560, height: 1440 });
  });

  it("gpt-image 图生图：单候选,image2image + referenceBlobs usage=subject", () => {
    const candidates = buildFireflyImagePayloadCandidates({
      prompt: "edit",
      aspectRatio: "1:1",
      outputResolution: "2K",
      upstreamModelId: "gpt-image",
      upstreamModelVersion: "2",
      sourceImageIds: ["img1"],
    });
    expect(candidates).toHaveLength(1);
    const [c0] = candidates as Record<string, unknown>[];
    // 实证(scripts/probe-adobe-edit.ts)：gpt-image edit 必须 usage=subject，
    // 否则 Adobe 400 "Image edit use case requires a reference image"。
    expect(c0?.referenceBlobs).toEqual([{ id: "img1", usage: "subject" }]);
    // Adobe 新 API 拒收 referenceImages,确保不再出现该字段。
    expect(c0?.referenceImages).toBeUndefined();
    expect((c0?.generationMetadata as Record<string, unknown>).module).toBe(
      "image2image"
    );
  });

  it("gpt-image 不支持比例抛错", () => {
    expect(() =>
      buildFireflyImagePayloadCandidates({
        prompt: "x",
        aspectRatio: "1:8",
        outputResolution: "2K",
        upstreamModelId: "gpt-image",
        upstreamModelVersion: "2",
      })
    ).toThrow(/unsupported gpt-image ratio/);
  });

  it("nano-banana 文生图：单候选，含 aspectRatio + addWatermark false", () => {
    const candidates = buildFireflyImagePayloadCandidates({
      prompt: "a dog",
      aspectRatio: "9:16",
      outputResolution: "2K",
      upstreamModelId: "gemini-flash",
      upstreamModelVersion: "nano-banana-2",
    });
    expect(candidates).toHaveLength(1);
    const p = candidates[0] as Record<string, unknown>;
    expect(p.size).toEqual({ width: 1536, height: 2752 });
    const msp = p.modelSpecificPayload as Record<string, unknown>;
    expect(msp.aspectRatio).toBe("9:16");
    expect((msp.parameters as Record<string, unknown>).addWatermark).toBe(
      false
    );
    expect(p.referenceBlobs).toEqual([]);
  });

  it("nano-banana 图生图：image2image + referenceBlobs general", () => {
    const candidates = buildFireflyImagePayloadCandidates({
      prompt: "edit",
      aspectRatio: "1:1",
      outputResolution: "2K",
      upstreamModelId: "gemini-flash",
      upstreamModelVersion: "nano-banana-2",
      sourceImageIds: ["a", "b"],
    });
    expect(candidates).toHaveLength(1);
    const p = candidates[0] as Record<string, unknown>;
    expect((p.generationMetadata as Record<string, unknown>).module).toBe(
      "image2image"
    );
    expect(p.referenceBlobs).toEqual([
      { id: "a", usage: "general" },
      { id: "b", usage: "general" },
    ]);
  });
});
