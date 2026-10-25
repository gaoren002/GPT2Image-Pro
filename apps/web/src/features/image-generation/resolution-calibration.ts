/**
 * 出图分辨率校准。
 *
 * 职责：上游（尤其 Web / codex）常返回分辨率低于请求的图。明显偏小时先用
 *   Real-ESRGAN 放大并增强细节；接近目标时用 sharp 轻量缩放。两条路径最后都按比例
 *   对齐到目标边界（不裁剪、不改宽高比，保全画面内容）。
 *
 * 使用方：image-generation/operations.ts 存图函数，落库前。
 * 关键依赖：super-resolution.ts（独立 Real-ESRGAN Worker 客户端）、worker 协议的
 *   输入上限（inference-protocol.mjs 的 LIMITS）、sharp。
 *
 * 设计：校准模式由纯函数 getResolutionCalibrationMode 决定，便于 DB-free 单测；实际
 *   放大/缩放有副作用（CPU + IO），由 calibrateImageResolution 编排。非取消失败回退原图。
 */

import { logWarn } from "@repo/shared/logger";
import sharp, { type Sharp } from "sharp";

import { LIMITS } from "../../../worker/inference-protocol.mjs";
import type { InferenceOptions } from "./inference-worker";
import { parseImageSize } from "./resolution";
import { superResolve } from "./super-resolution";

// 触发阈值：明显偏小时走 Real-ESRGAN；其余不足目标的图只做轻量缩放。
export const SUPER_RESOLUTION_TRIGGER_RATIO = 2 / 3;

export type ResolutionCalibrationMode = "none" | "resize" | "super-resolution";

/**
 * 纯决策：给定实际与目标尺寸，是否需要超分放大。
 *
 * 判据：实际较长边 < 目标较长边 × 比例（默认 2/3）。两者任一不可用时返回 false。
 */
export function shouldSuperResolve(
  actual: { width: number; height: number } | null | undefined,
  target: { width: number; height: number } | null | undefined,
  ratio: number = SUPER_RESOLUTION_TRIGGER_RATIO
): boolean {
  if (!actual || !target) return false;
  const actualEdge = Math.max(actual.width, actual.height);
  const targetEdge = Math.max(target.width, target.height);
  if (actualEdge <= 0 || targetEdge <= 0) return false;
  return actualEdge < targetEdge * ratio;
}

export function getResolutionCalibrationMode(
  actual: { width: number; height: number } | null | undefined,
  target: { width: number; height: number } | null | undefined
): ResolutionCalibrationMode {
  if (!actual || !target) return "none";
  const actualEdge = Math.max(actual.width, actual.height);
  const targetEdge = Math.max(target.width, target.height);
  if (actualEdge <= 0 || targetEdge <= 0 || actualEdge >= targetEdge) {
    return "none";
  }
  return shouldSuperResolve(actual, target) ? "super-resolution" : "resize";
}

/**
 * 按需超分校准分辨率。
 *
 * @param image 上游返回的图片字节
 * @param requestedSize 请求尺寸字符串（如 "1024x1024"，"auto" 等无法解析时不校准）
 * @param options 可选 caller signal，贯通 SR 请求；本地轻量缩放在异步边界检查取消
 * @returns { buffer, applied }：applied=true 表示做了超分或轻量缩放；失败/不需要时返回原图
 *
 * 边界：明显偏小时先超分，轻微不足时直接缩放；最终都按比例（fit:inside，不裁剪）
 *   对齐目标边界并保留原图格式。非取消异常回退原图；显式取消上抛，不能报告 applied 成功。
 */
export async function calibrateImageResolution(
  image: Buffer,
  requestedSize: string,
  options: InferenceOptions = {}
): Promise<{ buffer: Buffer; applied: boolean }> {
  options.signal?.throwIfAborted();
  const target = parseImageSize(requestedSize);
  if (!target) return { buffer: image, applied: false };

  try {
    const meta = await sharp(image).metadata();
    options.signal?.throwIfAborted();
    if (!meta.width || !meta.height) return { buffer: image, applied: false };
    const actual = { width: meta.width, height: meta.height };
    const mode = getResolutionCalibrationMode(actual, target);
    if (mode === "none") {
      return { buffer: image, applied: false };
    }

    const source =
      mode === "super-resolution"
        ? await superResolve(
            await fitSuperResolutionInput(image, actual),
            options
          )
        : image;
    options.signal?.throwIfAborted();
    const format = meta.format;
    const pipeline = sharp(source).resize(target.width, target.height, {
      fit: "inside",
      withoutEnlargement: false,
    });
    // 保留原图格式，避免改变后续 resolveStoredImageFormat 的判定。
    const calibrated = await encodeAs(pipeline, format).toBuffer();
    options.signal?.throwIfAborted();
    return { buffer: calibrated, applied: true };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    logWarn("分辨率超分校准失败，回退原图", {
      error: error instanceof Error ? error.message : String(error),
      requestedSize,
    });
    return { buffer: image, applied: false };
  }
}

/**
 * 把超分输入等比缩到 worker 的像素与边长上限之内。
 *
 * worker 只接受不超过 LIMITS["super-resolution"] 的输入（4 倍输出不超过 1600 万像素），
 * 上游常见的 1536x1024 等底图会超出该上限，直接发送会被拒绝并整体回退原图，
 * 导致大尺寸请求拿不到目标分辨率。先缩到上限内再超分，调用方随后仍缩放到目标边界。
 *
 * @param image 待超分的原图字节
 * @param size 原图尺寸（已由调用方读取）
 * @returns 已在上限内时返回原字节（不重新编码）；否则返回缩小后的 PNG
 */
async function fitSuperResolutionInput(
  image: Buffer,
  size: { width: number; height: number }
): Promise<Buffer> {
  const { maxPixels, maxEdge } = LIMITS["super-resolution"];
  const pixels = size.width * size.height;
  const edge = Math.max(size.width, size.height);
  if (pixels <= maxPixels && edge <= maxEdge) return image;
  const scale = Math.min(Math.sqrt(maxPixels / pixels), maxEdge / edge);
  return sharp(image)
    .resize(
      Math.max(1, Math.floor(size.width * scale)),
      Math.max(1, Math.floor(size.height * scale)),
      { fit: "inside" }
    )
    .png()
    .toBuffer();
}

/** 按原图格式编码，未知格式回退 png。 */
function encodeAs(pipeline: Sharp, format: string | undefined): Sharp {
  switch (format) {
    case "jpeg":
    case "jpg":
      return pipeline.jpeg();
    case "webp":
      return pipeline.webp();
    case "avif":
      return pipeline.avif();
    default:
      return pipeline.png();
  }
}
