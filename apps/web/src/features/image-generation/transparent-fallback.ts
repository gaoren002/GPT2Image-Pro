/**
 * 透明背景回退:后端不支持 background=transparent 时,改为不透明生成 + 服务端 ISNet 抠图。
 *
 * 背景:实测 gpt-image-2 对 background=transparent 返回 400
 * "Transparent background is not supported for this model"。为让"透明背景"在不支持的后端
 * 也能用,管线在该错误时不透明重试,再用 matte.ts 把背景抠掉,得到透明结果。
 *
 * 使用方:image-generation/operations.ts 的 runGenerationAttempt。纯逻辑(抠图本身无 DB),
 * isTransparentUnsupportedError 可单测。
 */
import { MAX_INPUT_BYTES } from "../../../worker/inference-protocol.mjs";
import { removeBackground } from "../psd-export/matte";
import {
  type InferenceOptions,
  InferenceWorkerError,
} from "./inference-worker";
import type { GenerateImageResult } from "./types";

/** 判断错误是否为"后端不支持透明背景"(用于触发回退)。 */
export function isTransparentUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /transparent background is not supported/i.test(message);
}

/**
 * 有界解码一张 base64，不接受路径/URL。拒绝非法编码，避免 Buffer 静默截断。
 * 仅转发独立 worker；不落盘、不加载 ONNX。
 */
async function matteBase64(
  base64: string,
  options: InferenceOptions
): Promise<string> {
  const comma = base64.indexOf(",");
  const raw =
    base64.startsWith("data:") && comma >= 0 ? base64.slice(comma + 1) : base64;
  if (
    !raw.length ||
    raw.length > Math.ceil(MAX_INPUT_BYTES / 3) * 4 ||
    raw.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)
  ) {
    throw new InferenceWorkerError("input_base64");
  }
  const input = Buffer.from(raw, "base64");
  if (input.toString("base64") !== raw)
    throw new InferenceWorkerError("input_base64");
  const out = await removeBackground(input, options);
  return out.toString("base64");
}

/**
 * 逐张处理透明回退，最多四张；相同 legacy 首图复用数组结果，避免重复推理。
 * URL-only 仍保留既有契约；worker 故障显式上抛，不伪装为透明成功。
 */
export async function applyTransparentMatte(
  result: GenerateImageResult,
  options: InferenceOptions = {}
): Promise<GenerateImageResult> {
  options.signal?.throwIfAborted();
  const outputs = result.imageOutputs;
  const mirrored = result.imageBase64
    ? (outputs?.findIndex(
        (output) => output.imageBase64 === result.imageBase64
      ) ?? -1)
    : -1;
  const count =
    (outputs?.length ?? 0) + (result.imageBase64 && mirrored < 0 ? 1 : 0);
  if (count > 4) throw new InferenceWorkerError("output_count");
  const next: GenerateImageResult = { ...result };
  if (outputs) {
    next.imageOutputs = [];
    for (const output of outputs) {
      options.signal?.throwIfAborted();
      next.imageOutputs.push(
        output.imageBase64
          ? {
              ...output,
              imageBase64: await matteBase64(output.imageBase64, options),
            }
          : output
      );
    }
  }
  if (result.imageBase64) {
    next.imageBase64 =
      mirrored >= 0
        ? next.imageOutputs?.[mirrored]?.imageBase64
        : await matteBase64(result.imageBase64, options);
  }
  return next;
}
