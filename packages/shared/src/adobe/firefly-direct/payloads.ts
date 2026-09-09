/**
 * Adobe Firefly 直连 payload 构造（移植自 adobe2api core/models/payloads.py）。
 *
 * 把 prompt + 宽高比 + 分辨率 + 上游模型，构造成 firefly-3p `generate-async` 的请求
 * 体候选列表（candidates）。Firefly 对不同子模块/图生图形态接受的 payload 形状不同，
 * 上游用"多候选依次尝试，命中 200 即停"的策略——这里如实保留。
 * 纯函数，DB-free，可单测。
 */

export type FireflySize = { width: number; height: number };

function ratioMap1K(): Record<string, FireflySize> {
  return {
    "1:1": { width: 1024, height: 1024 },
    "1:8": { width: 384, height: 3072 },
    "1:4": { width: 512, height: 2048 },
    "16:9": { width: 1360, height: 768 },
    "9:16": { width: 768, height: 1360 },
    "4:1": { width: 2048, height: 512 },
    "4:3": { width: 1152, height: 864 },
    "3:4": { width: 864, height: 1152 },
    "8:1": { width: 3072, height: 384 },
  };
}

function ratioMap4K(): Record<string, FireflySize> {
  return {
    "1:1": { width: 4096, height: 4096 },
    "1:8": { width: 1536, height: 12288 },
    "1:4": { width: 2048, height: 8192 },
    "16:9": { width: 5504, height: 3072 },
    "9:16": { width: 3072, height: 5504 },
    "4:1": { width: 8192, height: 2048 },
    "4:3": { width: 4096, height: 3072 },
    "3:4": { width: 3072, height: 4096 },
    "8:1": { width: 12288, height: 1536 },
  };
}

function ratioMap2K(): Record<string, FireflySize> {
  return {
    "1:1": { width: 2048, height: 2048 },
    "1:8": { width: 768, height: 6144 },
    "1:4": { width: 1024, height: 4096 },
    "16:9": { width: 2752, height: 1536 },
    "9:16": { width: 1536, height: 2752 },
    "4:1": { width: 4096, height: 1024 },
    "4:3": { width: 2048, height: 1536 },
    "3:4": { width: 1536, height: 2048 },
    "8:1": { width: 6144, height: 768 },
  };
}

/** 移植 payloads.size_from_ratio：非 gpt-image 家族的像素尺寸。 */
export function sizeFromRatio(
  ratio: string,
  outputResolution = "2K"
): FireflySize {
  const level = (outputResolution || "2K").toUpperCase();
  const map =
    level === "1K"
      ? ratioMap1K()
      : level === "4K"
        ? ratioMap4K()
        : ratioMap2K();
  return map[ratio] ?? map["16:9"] ?? { width: 2752, height: 1536 };
}

function gptRatioMap1K(): Record<string, FireflySize> {
  return {
    "1:1": { width: 1024, height: 1024 },
    "5:4": { width: 1120, height: 896 },
    "9:16": { width: 720, height: 1280 },
    "21:9": { width: 1456, height: 624 },
    "16:9": { width: 1280, height: 720 },
    "4:3": { width: 1152, height: 864 },
    "3:2": { width: 1248, height: 832 },
    "4:5": { width: 896, height: 1120 },
    "3:4": { width: 864, height: 1152 },
    "2:3": { width: 832, height: 1248 },
  };
}

function gptRatioMap4K(): Record<string, FireflySize> {
  return {
    "1:1": { width: 2880, height: 2880 },
    "5:4": { width: 3200, height: 2560 },
    "9:16": { width: 2160, height: 3840 },
    "21:9": { width: 3696, height: 1584 },
    "16:9": { width: 3840, height: 2160 },
    "4:3": { width: 3264, height: 2448 },
    "3:2": { width: 3504, height: 2336 },
    "4:5": { width: 2560, height: 3200 },
    "3:4": { width: 2448, height: 3264 },
    "2:3": { width: 2336, height: 3504 },
  };
}

function gptRatioMap2K(): Record<string, FireflySize> {
  return {
    "1:1": { width: 2048, height: 2048 },
    "5:4": { width: 2240, height: 1792 },
    "9:16": { width: 1440, height: 2560 },
    "21:9": { width: 3024, height: 1296 },
    "16:9": { width: 2560, height: 1440 },
    "4:3": { width: 2304, height: 1728 },
    "3:2": { width: 2496, height: 1664 },
    "4:5": { width: 1792, height: 2240 },
    "3:4": { width: 1728, height: 2304 },
    "2:3": { width: 1664, height: 2496 },
  };
}

/** 移植 payloads.gpt_image_pixels_from_ratio：gpt-image 家族像素尺寸；不支持的比例返回 null。 */
export function gptImagePixelsFromRatio(
  ratio: string,
  outputResolution = "2K"
): FireflySize | null {
  const level = (outputResolution || "2K").toUpperCase();
  const map =
    level === "1K"
      ? gptRatioMap1K()
      : level === "4K"
        ? gptRatioMap4K()
        : gptRatioMap2K();
  return map[ratio] ?? null;
}

function gptImageSizeString(size: FireflySize | null): string {
  if (!size) throw new Error("gpt-image size is required");
  const width = Number(size.width) || 0;
  const height = Number(size.height) || 0;
  if (width <= 0 || height <= 0)
    throw new Error("gpt-image size must be positive");
  return `${width}x${height}`;
}

/** 移植 payloads.gpt_image_detail_level_from_quality。 */
export function gptImageDetailLevelFromQuality(
  qualityLevel?: string | null
): number {
  const quality = String(qualityLevel || "low")
    .trim()
    .toLowerCase();
  // xhigh/max 是 gpt-image-2.5 新增档位；Firefly 上游只理解 1-5，取最高档。
  if (quality === "high" || quality === "xhigh" || quality === "max") return 5;
  if (quality === "medium") return 3;
  return 1;
}

function seedNow(): number {
  return Math.floor(Date.now() / 1000) % 999999;
}

export type FireflyImagePayload = Record<string, unknown>;

/**
 * 移植 payloads.build_image_payload_candidates。
 * 返回按尝试顺序排列的 payload 列表；调用方逐个 POST 直到 200。
 */
export function buildFireflyImagePayloadCandidates(params: {
  prompt: string;
  aspectRatio: string;
  outputResolution: string;
  upstreamModelId: string;
  upstreamModelVersion: string;
  qualityLevel?: string | null | undefined;
  detailLevel?: number | null | undefined;
  sourceImageIds?: string[] | null | undefined;
}): FireflyImagePayload[] {
  const normalizedRatio = String(params.aspectRatio || "")
    .trim()
    .toLowerCase();
  const effectiveRatio = normalizedRatio || "1:1";
  const sourceImageIds = params.sourceImageIds ?? null;

  if (
    String(params.upstreamModelId || "")
      .trim()
      .toLowerCase() === "gpt-image"
  ) {
    let effectiveDetailLevel = params.detailLevel;
    if (effectiveDetailLevel === null || effectiveDetailLevel === undefined) {
      effectiveDetailLevel = gptImageDetailLevelFromQuality(
        params.qualityLevel
      );
    }
    const pixelSize = gptImagePixelsFromRatio(
      effectiveRatio,
      params.outputResolution
    );
    if (!pixelSize) {
      throw new Error(`unsupported gpt-image ratio: ${effectiveRatio}`);
    }
    const basePayload: FireflyImagePayload = {
      modelId: params.upstreamModelId,
      modelVersion: params.upstreamModelVersion,
      n: 1,
      prompt: params.prompt,
      seeds: [seedNow()],
      output: { storeInputs: true },
      referenceBlobs: [],
      generationMetadata: {
        module: "text2image",
        submodule: "ff-image-generate",
      },
      modelSpecificPayload: {
        size: gptImageSizeString(pixelSize),
      },
      outputResolution: String(params.outputResolution || "2K").toUpperCase(),
      generationSettings: {
        detailLevel: Math.trunc(effectiveDetailLevel),
      },
      size: pixelSize,
    };
    if (!sourceImageIds || sourceImageIds.length === 0) {
      return [basePayload];
    }

    // gpt-image 图生图:参考媒体必须走 referenceBlobs（每项 {id, usage}），
    // Adobe 新 API 已拒收 referenceImages/referenceVideos（422 validation_error）。
    // usage 必须是 "subject":经对真实 Adobe API 实证（scripts/probe-adobe-edit.ts），
    // module=image2image + usage=subject 才返回 200；usage=general 会 400
    // "Image edit use case requires a reference image"（Adobe 不把 general blob 当 edit 源图）。
    // 早期提交曾误判 "subject 无效",实为当时 module 仍是 text2image（漏改），导致退化成文生图。
    const edited: FireflyImagePayload = {
      ...basePayload,
      generationMetadata: {
        module: "image2image",
        submodule: "ff-image-generate",
      },
      referenceBlobs: sourceImageIds.map((imgId) => ({
        id: imgId,
        usage: "subject",
      })),
    };

    return [edited];
  }

  const basePayload: FireflyImagePayload = {
    modelId: params.upstreamModelId,
    modelVersion: params.upstreamModelVersion,
    n: 1,
    prompt: params.prompt,
    size: sizeFromRatio(effectiveRatio, params.outputResolution),
    seeds: [seedNow()],
    groundSearch: false,
    skipCai: false,
    output: { storeInputs: true },
    generationMetadata: {
      module: "text2image",
      submodule: "ff-image-generate",
    },
    modelSpecificPayload: {
      parameters: { addWatermark: false },
    },
  };
  if (normalizedRatio && normalizedRatio !== "auto") {
    (basePayload.modelSpecificPayload as Record<string, unknown>).aspectRatio =
      normalizedRatio;
  }

  if (!sourceImageIds || sourceImageIds.length === 0) {
    basePayload.referenceBlobs = [];
    return [basePayload];
  }

  // nano-banana(Google) 图生图:usage 必须是 "general"——经实证
  // （scripts/probe-adobe-edit.ts）,nano-banana 用 "subject" 会 400
  // "Only general reference images are supported for Google Nano-Banana"；
  // 与 gpt-image 恰好相反（gpt-image 要 "subject"），故两族不可共用同一 usage。
  const edited: FireflyImagePayload = {
    ...basePayload,
    generationMetadata: {
      module: "image2image",
      submodule: "ff-image-generate",
    },
    referenceBlobs: sourceImageIds.map((imgId) => ({
      id: imgId,
      usage: "general",
    })),
  };
  return [edited];
}

export type FireflyVideoPayload = Record<string, unknown>;

/**
 * 构造 Firefly 视频提交体（/v2/3p-videos/generate-async），依据视频协议规格
 * （docs/plan/2026-06-20-adobe-firefly-video-spec.md）。
 *
 * 不同供应商的视频协议并不共用同一种 payload，按上游实现分别构造。
 */
export function buildFireflyVideoPayload(params: {
  prompt: string;
  upstreamModel: string;
  upstreamModelId: string;
  upstreamModelVersion: string;
  engine: string;
  duration: number;
  aspectRatio: string;
  size: FireflySize;
  generateAudio: boolean;
  referenceMode?: "image";
  negativePrompt?: string | null;
  sourceImageIds?: string[] | null;
}): FireflyVideoPayload {
  const seed = seedNow();
  const ids = (params.sourceImageIds ?? []).filter(Boolean);
  const hasFrames = ids.length > 0;
  const size = { width: params.size.width, height: params.size.height };

  if (params.engine === "veo31-fast" || params.engine === "veo31-standard") {
    const payload: FireflyVideoPayload = {
      n: 1,
      seeds: [seed],
      modelId: "veo",
      modelVersion:
        params.engine === "veo31-fast" ? "3.1-fast-generate" : "3.1-generate",
      output: { storeInputs: true },
      prompt: params.prompt,
      size,
      generateAudio: params.generateAudio,
      referenceBlobs: [],
      generationMetadata: { module: "text2video" },
      modelSpecificPayload: {
        parameters: {
          durationSeconds: params.duration,
          aspectRatio: params.aspectRatio,
          addWaterMark: false,
        },
      },
    };
    payload.referenceBlobs =
      params.engine === "veo31-standard" && params.referenceMode === "image"
        ? ids.slice(0, 3).map((id) => ({ id, usage: "asset" }))
        : ids.slice(0, 2).map((id, index) => ({
            id,
            usage: "general",
            promptReference: index + 1,
          }));
    return payload;
  }

  if (params.engine === "kling-o3" || params.engine === "kling3") {
    return {
      n: 1,
      seeds: [seed],
      modelId: "kling",
      modelVersion:
        params.engine === "kling-o3"
          ? "kling_o3_pro_reference_to_video"
          : "kling_v3_standard_i2v",
      output: { storeInputs: true },
      prompt: params.prompt,
      size,
      generateAudio: params.generateAudio,
      generationMetadata: {
        module: hasFrames ? "image2video" : "text2video",
      },
      duration: params.duration,
      generationSettings: { aspectRatio: params.aspectRatio },
      referenceBlobs: ids.slice(0, 2).map((id, index) => ({
        id,
        usage: "frame",
        order: index + 1,
      })),
    };
  }

  const promptPayload: Record<string, unknown> = {
    id: 1,
    duration_sec: params.duration,
    prompt_text: params.prompt,
  };
  if (params.negativePrompt) {
    promptPayload.negative_prompt = params.negativePrompt;
  }
  const firstId = ids[0];
  return {
    n: 1,
    seeds: [seed],
    modelId: "sora",
    modelVersion: "sora-2",
    size,
    duration: params.duration,
    fps: 24,
    prompt: JSON.stringify(promptPayload),
    generationMetadata: { module: "text2video" },
    model: params.upstreamModel,
    generateAudio: params.generateAudio,
    generateLoop: false,
    transparentBackground: false,
    seed: String(seed),
    locale: "en-US",
    camera: {
      angle: "none",
      shotSize: "none",
      motion: null,
      promptStyle: null,
    },
    negativePrompt: params.negativePrompt || "",
    jobMode: "standard",
    debugGenerationEndpoint: "",
    referenceBlobs: firstId
      ? [{ id: firstId, usage: "general", promptReference: 1 }]
      : [],
    referenceFrames: firstId ? [{ localBlobRef: firstId }, null] : [],
    referenceVideo: null,
    cameraMotionReferenceVideo: null,
    characterReference: null,
    editReferenceVideo: null,
    output: { storeInputs: true },
  };
}
