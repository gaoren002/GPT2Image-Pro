/** 仅由 inference-child 导入的 ONNX 算法；Web/HTTP 父进程不得导入。
 * Real-ESRGAN 与 SCUNet: Apache-2.0；ISNet: MIT。保留既有模型预后处理。 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-node";
import sharp from "sharp";
import { checkTensor } from "./inference-protocol.mjs";

const SCALE = 4;
const TILE = 256;
const PAD = 16;
const intraOpThreads = Math.min(
  32,
  Math.max(1, Number(process.env.SUPER_RESOLUTION_INTRA_OP_THREADS) || 4)
);
const workerDir = path.dirname(fileURLToPath(import.meta.url));
const modelFile =
  process.env.REALESR_MODEL_PATH?.trim() ||
  path.resolve(workerDir, "../models/realesr-general-x4v3.onnx");
let sessionPromise = null;
/** 仅在当前单任务子进程内复用超分 session，避免每个 tile 重载。 */
function getSession() {
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(modelFile, {
      executionMode: "sequential",
      intraOpNumThreads: intraOpThreads,
      interOpNumThreads: 1,
    });
  }
  return sessionPromise;
}

/** 将已验证的有限模型值裁剪为 RGB 字节。 */
function clamp255(value) {
  if (value <= 0) return 0;
  if (value >= 255) return 255;
  return Math.round(value);
}

/** 对有界 tile 执行 4x 超分；shape/长度不符即失败，不猜测输出尺寸。 */
async function runTile(session, hwc, width, height) {
  const area = width * height;
  const chw = new Float32Array(3 * area);
  for (let index = 0; index < area; index++) {
    chw[index] = (hwc[index * 3] ?? 0) / 255;
    chw[area + index] = (hwc[index * 3 + 1] ?? 0) / 255;
    chw[2 * area + index] = (hwc[index * 3 + 2] ?? 0) / 255;
  }

  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  if (!inputName || !outputName) {
    throw new Error("model has no input or output name");
  }
  const result = await session.run({
    [inputName]: new ort.Tensor("float32", chw, [1, 3, height, width]),
  });
  const tensor = result[outputName];
  if (!tensor) throw new Error("model output is missing");

  checkTensor(tensor, [1, 3, height * SCALE, width * SCALE]);
  const outputHeight = tensor.dims[2];
  const outputWidth = tensor.dims[3];
  const tensorData = tensor.data;
  const outputArea = outputWidth * outputHeight;
  const data = Buffer.allocUnsafe(outputArea * 3);
  for (let index = 0; index < outputArea; index++) {
    data[index * 3] = clamp255((tensorData[index] ?? 0) * 255);
    data[index * 3 + 1] = clamp255((tensorData[outputArea + index] ?? 0) * 255);
    data[index * 3 + 2] = clamp255(
      (tensorData[2 * outputArea + index] ?? 0) * 255
    );
  }
  return { data, width: outputWidth, height: outputHeight };
}

/** 保留既有分块与 alpha 合成，入口像素预算由子进程协议先行检查。 */
export async function superResolve(image) {
  const session = await getSession();
  const metadata = await sharp(image).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("cannot determine image dimensions");
  }

  const width = metadata.width;
  const height = metadata.height;
  const outputWidth = width * SCALE;
  const outputHeight = height * SCALE;
  const output = Buffer.allocUnsafe(outputWidth * outputHeight * 3);

  // 保护 alpha：先提取原图 alpha 通道（若有），超分后再放大合成回去。
  // 之前直接 removeAlpha() 会把透明像素固化为黑底（RGB 0,0,0 是 PNG 编码器
  // 对全透明像素的常见底层值），用户选 background=transparent 的输出经超分
  // 后透明区域全部变黑。修复：RGB 走超分，alpha 单独双三次放大后合成。
  const hasAlpha = metadata.hasAlpha === true;
  const rgbBuffer = await sharp(image)
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer();
  let alphaBuffer = null;
  if (hasAlpha) {
    alphaBuffer = await sharp(image)
      .ensureAlpha()
      .extractChannel("alpha")
      .raw()
      .toBuffer();
  }

  const source = rgbBuffer;

  for (let tileY = 0; tileY < height; tileY += TILE) {
    for (let tileX = 0; tileX < width; tileX += TILE) {
      const x1 = Math.min(tileX + TILE, width);
      const y1 = Math.min(tileY + TILE, height);
      const paddedX0 = Math.max(0, tileX - PAD);
      const paddedY0 = Math.max(0, tileY - PAD);
      const paddedX1 = Math.min(width, x1 + PAD);
      const paddedY1 = Math.min(height, y1 + PAD);
      const paddedWidth = paddedX1 - paddedX0;
      const paddedHeight = paddedY1 - paddedY0;

      const tile = Buffer.allocUnsafe(paddedWidth * paddedHeight * 3);
      for (let row = 0; row < paddedHeight; row++) {
        const sourceOffset = ((paddedY0 + row) * width + paddedX0) * 3;
        source.copy(
          tile,
          row * paddedWidth * 3,
          sourceOffset,
          sourceOffset + paddedWidth * 3
        );
      }

      const upscaled = await runTile(session, tile, paddedWidth, paddedHeight);
      const offsetX = (tileX - paddedX0) * SCALE;
      const offsetY = (tileY - paddedY0) * SCALE;
      const validWidth = (x1 - tileX) * SCALE;
      const validHeight = (y1 - tileY) * SCALE;
      const destinationX = tileX * SCALE;
      const destinationY = tileY * SCALE;
      for (let row = 0; row < validHeight; row++) {
        const sourceOffset = ((offsetY + row) * upscaled.width + offsetX) * 3;
        const destinationOffset =
          ((destinationY + row) * outputWidth + destinationX) * 3;
        upscaled.data.copy(
          output,
          destinationOffset,
          sourceOffset,
          sourceOffset + validWidth * 3
        );
      }
    }
  }

  // 超分完的 RGB 图：若有原 alpha，双三次放大后合成回去，恢复透明区域。
  if (hasAlpha && alphaBuffer) {
    const upscaledAlpha = await sharp(alphaBuffer, {
      raw: { width, height, channels: 1 },
    })
      .resize(outputWidth, outputHeight, { kernel: "bicubic" })
      .raw()
      .toBuffer();
    const rgbWithAlpha = Buffer.allocUnsafe(outputWidth * outputHeight * 4);
    for (let i = 0; i < outputWidth * outputHeight; i++) {
      rgbWithAlpha[i * 4] = output[i * 3];
      rgbWithAlpha[i * 4 + 1] = output[i * 3 + 1];
      rgbWithAlpha[i * 4 + 2] = output[i * 3 + 2];
      rgbWithAlpha[i * 4 + 3] = upscaledAlpha[i] ?? 255;
    }
    return sharp(rgbWithAlpha, {
      raw: { width: outputWidth, height: outputHeight, channels: 4 },
    })
      .png()
      .toBuffer();
  }

  return sharp(output, {
    raw: { width: outputWidth, height: outputHeight, channels: 3 },
  })
    .png()
    .toBuffer();
}

/** 子进程内创建单次 session；退出即释放，不在 HTTP/Web 缓存。 */
async function sessionFor(envName, filename) {
  return ort.InferenceSession.create(
    process.env[envName]?.trim() ||
      path.resolve(workerDir, "../models", filename),
    {
      executionMode: "sequential",
      intraOpNumThreads: intraOpThreads,
      interOpNumThreads: 1,
    }
  );
}
/** 原分辨率 SCUNet；输入在子进程入口已经过尺寸预算检查。 */
export async function restoreImage(image) {
  const { width, height } = await sharp(image).metadata();
  const session = await sessionFor(
    "SCUNET_MODEL_PATH",
    "scunet-color-real-gan.onnx"
  );
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  if (!inputName || !outputName) throw new Error("invalid model");
  const src = await sharp(image)
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer();
  const area = width * height;
  const chw = new Float32Array(3 * area);
  for (let i = 0; i < area; i++) {
    chw[i] = src[i * 3] / 255;
    chw[area + i] = src[i * 3 + 1] / 255;
    chw[2 * area + i] = src[i * 3 + 2] / 255;
  }
  const result = await session.run({
    [inputName]: new ort.Tensor("float32", chw, [1, 3, height, width]),
  });
  const out = result[outputName];
  if (!out) throw new Error("missing tensor");
  checkTensor(out, [1, 3, height, width]);
  const rgb = Buffer.allocUnsafe(area * 3);
  for (let i = 0; i < area; i++) {
    rgb[i * 3] = clamp255(out.data[i] * 255);
    rgb[i * 3 + 1] = clamp255(out.data[area + i] * 255);
    rgb[i * 3 + 2] = clamp255(out.data[2 * area + i] * 255);
  }
  return sharp(rgb, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}
/** ISNet 标准 1024 输入；输出 mask min-max 后合成原尺寸透明 PNG。 */
export async function removeBackground(image) {
  const size = 1024;
  const { width, height } = await sharp(image).metadata();
  const session = await sessionFor("ISNET_MODEL_PATH", "isnet.onnx");
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  if (!inputName || !outputName) throw new Error("invalid model");
  const hwc = await sharp(image)
    .removeAlpha()
    .toColourspace("srgb")
    .resize(size, size, { fit: "fill" })
    .raw()
    .toBuffer();
  const area = size * size;
  const chw = new Float32Array(3 * area);
  for (let i = 0; i < area; i++) {
    chw[i] = hwc[i * 3] / 255 - 0.5;
    chw[area + i] = hwc[i * 3 + 1] / 255 - 0.5;
    chw[2 * area + i] = hwc[i * 3 + 2] / 255 - 0.5;
  }
  const result = await session.run({
    [inputName]: new ort.Tensor("float32", chw, [1, 3, size, size]),
  });
  const out = result[outputName];
  if (!out) throw new Error("missing tensor");
  checkTensor(out, [1, 1, size, size]);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of out.data) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  const range = max - min || 1;
  const mask = Buffer.allocUnsafe(area);
  for (let i = 0; i < area; i++)
    mask[i] = Math.round(((out.data[i] - min) / range) * 255);
  const alpha = await sharp(mask, {
    raw: { width: size, height: size, channels: 1 },
  })
    .resize(width, height, { fit: "fill" })
    .toColourspace("b-w")
    .raw()
    .toBuffer();
  const rgb = await sharp(image)
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer();
  return sharp(rgb, { raw: { width, height, channels: 3 } })
    .joinChannel(alpha, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
}
