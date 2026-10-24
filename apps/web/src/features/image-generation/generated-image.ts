/**
 * 生成结果的统一读取边界，供保存管线与外接 API 转 base64 使用。
 * 上游 URL 同样是不可信输入：站内对象必须有访问凭证，外部地址逐跳公网校验与 DNS pin。
 * 下载受取消、时限和字节预算约束，格式检查发生在写存储或返回图片之前。
 */
import { assertStorageImageUrlAccess } from "@repo/shared/storage/signed-url";
import sharp from "sharp";
import {
  discardResponseBody,
  fetchPublicImage,
  readResponseBytesWithLimit,
} from "@/features/external-api/safe-image-fetch";
import { detectImageOutputFormatFromBuffer } from "./output-format";

export const MAX_GENERATED_IMAGE_BYTES = 32 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;

/** 只接收实际 PNG/JPEG/WebP，并限制解码像素，避免把非图片正文伪装为 PNG 存储。 */
async function validateImage(buffer: Buffer, maxBytes: number) {
  if (buffer.length > maxBytes)
    throw new Error("Generated image exceeds the byte limit.");
  if (!detectImageOutputFormatFromBuffer(buffer)) {
    throw new Error("Generated output is not a supported image.");
  }
  const metadata = await sharp(buffer, {
    limitInputPixels: 64 * 1024 * 1024,
  }).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("Generated output has no valid image dimensions.");
  }
  return buffer;
}

/**
 * 读取一个上游图片结果；无客户端 Cookie/Bearer 转发，不重签输入链接，也不写任何对象。
 * publicBaseUrl 仅用于辨认本站存储路径，不能把任意相对地址当作可信内部请求。
 */
export async function readGeneratedImage(
  result: { imageBase64?: string; imageUrl?: string },
  options: {
    publicBaseUrl?: string;
    signal?: AbortSignal;
    maxBytes?: number;
  } = {}
): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? MAX_GENERATED_IMAGE_BYTES;
  const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  signal.throwIfAborted();
  const inline =
    result.imageBase64 ||
    (result.imageUrl?.startsWith("data:image/") ? result.imageUrl : undefined);
  if (inline) {
    const raw = inline.replace(/^data:image\/(?:png|jpeg|webp);base64,/, "");
    if (
      raw.length > Math.ceil(maxBytes / 3) * 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)
    ) {
      throw new Error("Generated image has invalid or oversized base64 data.");
    }
    return validateImage(Buffer.from(raw, "base64"), maxBytes);
  }
  if (!result.imageUrl) throw new Error("Missing image data");
  const reference = assertStorageImageUrlAccess(
    result.imageUrl,
    options.publicBaseUrl
  );
  if (reference) {
    const { getStorageProvider } = await import(
      "@repo/shared/storage/providers"
    );
    const storage = await getStorageProvider();
    const buffer = await storage.getObject(reference.key, reference.bucket, {
      signal,
      maxBytes,
    });
    signal.throwIfAborted();
    return validateImage(buffer, maxBytes);
  }
  const response = await fetchPublicImage(result.imageUrl, {
    signal,
    maxBytes,
  });
  if (!response.ok) {
    discardResponseBody(response);
    throw new Error(`Failed to download generated image: ${response.status}`);
  }
  const buffer = await readResponseBytesWithLimit(response, maxBytes, () => {
    throw new Error("Generated image exceeds the byte limit.");
  });
  signal.throwIfAborted();
  return validateImage(buffer, maxBytes);
}
