import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as ort from "onnxruntime-node";
import sharp from "sharp";

const SCALE = 4;
const TILE = 256;
const PAD = 16;

const bind = process.env.SUPER_RESOLUTION_WORKER_BIND?.trim() || "127.0.0.1";
const port = integerEnv("SUPER_RESOLUTION_WORKER_PORT", 3310, 1, 65_535);
const concurrency = integerEnv("SUPER_RESOLUTION_WORKER_CONCURRENCY", 1, 1, 8);
const maxQueue = integerEnv(
  "SUPER_RESOLUTION_WORKER_MAX_QUEUE",
  100,
  1,
  10_000
);
const maxBodyBytes =
  integerEnv("SUPER_RESOLUTION_WORKER_MAX_BODY_MB", 64, 1, 512) * 1024 * 1024;
const intraOpThreads = integerEnv(
  "SUPER_RESOLUTION_INTRA_OP_THREADS",
  24,
  1,
  32
);
const sharpThreads = integerEnv("SUPER_RESOLUTION_SHARP_CONCURRENCY", 2, 1, 16);
const workerSecret = process.env.SUPER_RESOLUTION_WORKER_SECRET?.trim() || "";

sharp.concurrency(sharpThreads);

const workerDir = path.dirname(fileURLToPath(import.meta.url));
const modelFile =
  process.env.REALESR_MODEL_PATH?.trim() ||
  path.resolve(workerDir, "../models/realesr-general-x4v3.onnx");

let sessionPromise = null;
let active = 0;
let shuttingDown = false;
const queue = [];

function integerEnv(name, fallback, min, max) {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

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

function clamp255(value) {
  if (value <= 0) return 0;
  if (value >= 255) return 255;
  return Math.round(value);
}

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

  const outputHeight = tensor.dims[2] ?? height * SCALE;
  const outputWidth = tensor.dims[3] ?? width * SCALE;
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

async function superResolve(image) {
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
  const rgbBuffer = await sharp(image).removeAlpha().raw().toBuffer();
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
    const rgbWithAlpha = Buffer.allocUnsafe(
      outputWidth * outputHeight * 4
    );
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

function isAuthorized(request) {
  if (!workerSecret) return true;
  const supplied = request.headers["x-super-resolution-secret"];
  if (typeof supplied !== "string") return false;
  const expectedBuffer = Buffer.from(workerSecret);
  const suppliedBuffer = Buffer.from(supplied);
  return (
    expectedBuffer.length === suppliedBuffer.length &&
    timingSafeEqual(expectedBuffer, suppliedBuffer)
  );
}

function sendJson(response, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(data.byteLength),
  });
  response.end(data);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > maxBodyBytes) {
      throw new Error("request body is too large");
    }
    chunks.push(chunk);
  }
  if (size === 0) throw new Error("request body is empty");
  return Buffer.concat(chunks, size);
}

function enqueue(image, response) {
  const task = { image, response, abandoned: false };
  response.on("close", () => {
    if (!response.writableEnded) task.abandoned = true;
  });
  queue.push(task);
  drainQueue();
}

function drainQueue() {
  while (active < concurrency && queue.length > 0) {
    const task = queue.shift();
    if (!task || task.abandoned) continue;
    active++;
    const startedAt = Date.now();
    void superResolve(task.image)
      .then((output) => {
        if (task.abandoned) return;
        task.response.writeHead(200, {
          "content-type": "image/png",
          "content-length": String(output.byteLength),
        });
        task.response.end(output);
        console.info(
          `super-resolution completed duration_ms=${Date.now() - startedAt} queue=${queue.length}`
        );
      })
      .catch((error) => {
        console.error("super-resolution failed", error);
        if (!task.abandoned) {
          sendJson(task.response, 500, { error: "super-resolution failed" });
        }
      })
      .finally(() => {
        active--;
        drainQueue();
      });
  }
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/healthz") {
    sendJson(response, 200, {
      ok: true,
      active,
      queued: queue.length,
      concurrency,
    });
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/super-resolution") {
    sendJson(response, 404, { error: "not found" });
    return;
  }
  if (shuttingDown) {
    sendJson(response, 503, { error: "worker is shutting down" });
    return;
  }
  if (!isAuthorized(request)) {
    sendJson(response, 401, { error: "unauthorized" });
    return;
  }
  if (queue.length >= maxQueue) {
    sendJson(response, 503, { error: "worker queue is full" });
    return;
  }

  const contentLength = Number.parseInt(
    request.headers["content-length"] ?? "0",
    10
  );
  if (contentLength > maxBodyBytes) {
    sendJson(response, 413, { error: "request body is too large" });
    return;
  }

  try {
    enqueue(await readBody(request), response);
  } catch (error) {
    sendJson(response, 400, {
      error: error instanceof Error ? error.message : "invalid request body",
    });
  }
});

server.requestTimeout = 0;
server.headersTimeout = 15_000;

try {
  await getSession();
  server.listen(port, bind, () => {
    console.info(
      `super-resolution worker listening on http://${bind}:${port} concurrency=${concurrency} onnx_threads=${intraOpThreads} sharp_threads=${sharpThreads}`
    );
  });
} catch (error) {
  console.error("failed to initialize super-resolution model", error);
  process.exit(1);
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`received ${signal}; stopping super-resolution worker`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 30_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
