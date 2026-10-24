/** async 交付检查：在统一管线成功结算前调用；纯中转只读图片到内存，绝不保存内容。 */
import {
  ASYNC_IMAGE_MAX_BYTES,
  ASYNC_IMAGE_MAX_RELAY_OUTPUTS,
  ASYNC_IMAGE_MAX_STORAGE_OUTPUTS,
  ASYNC_IMAGE_METADATA_BYTES,
} from "./async-image-limits";
import { readGeneratedImage } from "./generated-image";
import type { GeneratedImageOutput } from "./types";
import {
  detectImageOutputFormatFromBuffer,
  getOutputFormatContentType,
} from "./output-format";

/** 对交付用元数据和数量设置有限上界；异常在原管线失败结算分支处理，不截断已付费成品。 */
export function assertAsyncImageOutputs(
  result: { revisedPrompt?: string },
  outputs: GeneratedImageOutput[],
  relayOnly: boolean
) {
  const maxOutputs = relayOnly
    ? ASYNC_IMAGE_MAX_RELAY_OUTPUTS
    : ASYNC_IMAGE_MAX_STORAGE_OUTPUTS;
  if (outputs.length > maxOutputs) {
    throw new Error("Async image output count exceeds the delivery limit.");
  }
  const metadata = {
    revisedPrompt: result.revisedPrompt,
    outputs: outputs.map((output) => ({
      imageUrl: output.imageUrl?.startsWith("data:")
        ? undefined
        : output.imageUrl,
      revisedPrompt: output.revisedPrompt || result.revisedPrompt,
      upstreamRevisedPrompt: output.upstreamRevisedPrompt,
    })),
  };
  if (
    Buffer.byteLength(JSON.stringify(metadata)) > ASYNC_IMAGE_METADATA_BYTES
  ) {
    throw new Error("Async image metadata exceeds the delivery limit.");
  }
}

/** URL 也须执行期读取并验证；后续 b64 交付不依赖可能过期/变化的上游 URL。 */
export async function prepareAsyncRelayOutput<T extends GeneratedImageOutput>(
  output: T,
  signal?: AbortSignal
) {
  const buffer = await readGeneratedImage(output, {
    signal,
    publicBaseUrl:
      process.env.NEXT_PUBLIC_APP_URL || process.env.BETTER_AUTH_URL,
    maxBytes: ASYNC_IMAGE_MAX_BYTES,
  });
  const imageBase64 = buffer.toString("base64");
  const contentType = getOutputFormatContentType(
    detectImageOutputFormatFromBuffer(buffer) || "png"
  );
  // URL 模式复用既有 data URI 回退，不能把已付费交付依赖绑在上游短时 URL 上。
  return {
    ...output,
    imageUrl: `data:${contentType};base64,${imageBase64}`,
    imageBase64,
  };
}

/** 变换后再限字节；防超分/格式转换把已验证输入放大为不可交付结果。 */
export function assertAsyncStoredImageBytes(buffer: Buffer) {
  if (buffer.length > ASYNC_IMAGE_MAX_BYTES) {
    throw new Error("Async generated image exceeds the 32 MiB delivery limit.");
  }
}
