/** 浏览器端以有界流导入本站作品；转为内嵌文件后不依赖一小时签名的有效期。 */
import {
  fitCanvasImage,
  MAX_CANVAS_IMAGE_BYTES,
  validateCanvasImageUrl,
} from "./scene-tools";

/** 限制下载大小并保留取消语义，错误或超限时中止剩余响应。 */
export async function fetchCanvasImage(url: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const response = await fetch(validateCanvasImageUrl(url), {
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) {
    void response.body?.cancel();
    throw new Error(`图片读取失败（${response.status}），请刷新作品列表`);
  }
  if (Number(response.headers.get("content-length")) > MAX_CANVAS_IMAGE_BYTES) {
    void response.body?.cancel();
    throw new Error("单张图片不能超过 16 MiB");
  }
  const type =
    response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() ?? "";
  if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(type)) {
    void response.body?.cancel();
    throw new Error("只支持 PNG、JPEG、WebP 和 GIF 图片");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("图片响应为空");
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_CANVAS_IMAGE_BYTES)
        throw new Error("单张图片不能超过 16 MiB");
      chunks.push(new Uint8Array(value));
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const blob = new Blob(chunks, { type });
  const bitmap = await createImageBitmap(blob);
  try {
    const dimensions = fitCanvasImage(bitmap.width, bitmap.height);
    const dataURL = await new Promise<string>((resolve, reject) => {
      const fileReader = new FileReader();
      fileReader.onerror = () => reject(new Error("图片读取失败"));
      fileReader.onload = () =>
        typeof fileReader.result === "string"
          ? resolve(fileReader.result)
          : reject(new Error("图片格式无效"));
      fileReader.readAsDataURL(blob);
    });
    signal.throwIfAborted();
    return { ...dimensions, dataURL, mimeType: type };
  } finally {
    bitmap.close();
  }
}
