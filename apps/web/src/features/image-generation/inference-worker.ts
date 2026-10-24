/**
 * Web 侧有界推理 relay：restoration 与 PSD/透明抠图共用。
 * 仅传内存字节；不加载 ONNX、不持久化内容、错误不携带地址/认证头/上游正文。
 */
import sharp from "sharp";
import {
  INPUT_FORMATS,
  type InferenceOperation,
  LIMITS,
  MAX_INPUT_BYTES,
  MAX_OUTPUT_BYTES,
  validDimensions,
} from "../../../worker/inference-protocol.mjs";

export type InferenceOptions = { signal?: AbortSignal };

/** 可控失败类型，调用方可区分取消与允许的原图降级。 */
export class InferenceWorkerError extends Error {
  constructor(public readonly code: string) {
    super(`图像处理服务失败 (${code})`);
    this.name = "InferenceWorkerError";
  }
}

// 不在 Web 内等待：繁忙即失败，避免积累持有输入 Buffer 的 Promise 链。
let inFlight = 0;
const MAX_IN_FLIGHT = 4;

/** 只允许服务器配置的 HTTP(S) origin；非 loopback 必须配置认证。 */
function endpoint(operation: InferenceOperation): { url: URL; secret: string } {
  try {
    const url = new URL(
      process.env.SUPER_RESOLUTION_WORKER_URL?.trim() || "http://127.0.0.1:3310"
    );
    const secret = process.env.SUPER_RESOLUTION_WORKER_SECRET?.trim() || "";
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      (!local && !secret)
    )
      throw new Error("config");
    url.pathname = `/v1/${operation}`;
    return { url, secret };
  } catch {
    throw new InferenceWorkerError("configuration");
  }
}

/** 读取有限 PNG；在读取过程中拒绝超界，不先 arrayBuffer 再检查。 */
async function readOutput(response: Response): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (
    response.headers.get("content-type")?.split(";")[0] !== "image/png" ||
    (declared !== null &&
      (!/^\d+$/.test(declared) ||
        Number(declared) > MAX_OUTPUT_BYTES ||
        Number(declared) < 1))
  ) {
    await response.body?.cancel();
    throw new InferenceWorkerError("invalid_output");
  }
  if (!response.body) throw new InferenceWorkerError("empty_output");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_OUTPUT_BYTES)
        throw new InferenceWorkerError("output_limit");
      chunks.push(value);
    }
    if (!size || (declared !== null && size !== Number(declared))) {
      throw new InferenceWorkerError("invalid_output");
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * 在有界 Web relay 槽内检查图像、调用既有 worker 并验证返回尺寸。
 * 关闭、队满、取消、超时和 worker 故障均抛固定错误；不会进行本地推理。
 */
export async function invokeInferenceWorker(
  operation: InferenceOperation,
  image: Buffer,
  options: InferenceOptions = {}
): Promise<Buffer> {
  options.signal?.throwIfAborted();
  if (
    process.env.INFERENCE_WORKER_ENABLED === "false" ||
    (operation === "restoration" &&
      process.env.RESTORATION_WORKER_ENABLED === "false") ||
    (operation === "matte" && process.env.MATTE_WORKER_ENABLED === "false")
  ) {
    throw new InferenceWorkerError("disabled");
  }
  if (inFlight >= MAX_IN_FLIGHT) throw new InferenceWorkerError("busy");
  if (!image.length || image.length > MAX_INPUT_BYTES) {
    throw new InferenceWorkerError("input_limit");
  }
  const { url, secret } = endpoint(operation);
  const configured = Number(process.env.SUPER_RESOLUTION_WORKER_TIMEOUT_MS);
  const timeoutMs =
    Number.isSafeInteger(configured) && configured > 0
      ? Math.min(configured, 300_000)
      : 300_000;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  inFlight++;
  try {
    const input = await sharp(image, {
      limitInputPixels: LIMITS[operation].maxPixels,
    }).metadata();
    if (
      !INPUT_FORMATS.includes(input.format ?? "") ||
      !validDimensions(operation, input)
    )
      throw new InferenceWorkerError("input_dimensions");
    signal.throwIfAborted();
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(image.byteLength),
        ...(secret ? { "x-super-resolution-secret": secret } : {}),
      },
      body: new Uint8Array(image),
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new InferenceWorkerError(`http_${response.status}`);
    }
    const output = await readOutput(response);
    const metadata = await sharp(output, {
      limitInputPixels: 16_777_216,
    }).metadata();
    if (
      metadata.format !== "png" ||
      (metadata.pages ?? 1) !== 1 ||
      metadata.width !== (input.width ?? 0) * LIMITS[operation].scale ||
      metadata.height !== (input.height ?? 0) * LIMITS[operation].scale ||
      (operation === "matte" && !metadata.hasAlpha)
    )
      throw new InferenceWorkerError("output_dimensions");
    signal.throwIfAborted();
    return output;
  } catch (error) {
    if (options.signal?.aborted) throw new InferenceWorkerError("cancelled");
    if (timeout.aborted) throw new InferenceWorkerError("timeout");
    if (error instanceof InferenceWorkerError) throw error;
    throw new InferenceWorkerError("unavailable");
  } finally {
    inFlight--;
  }
}
