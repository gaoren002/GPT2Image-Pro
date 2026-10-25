/** 画布图片边界与导出选区的纯函数，供 UI 与 DB-free 回归测试复用。 */
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

export const MAX_CANVAS_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_CANVAS_EXPORT_EDGE = 2048;

/** 图片按最长边收敛到工作台尺寸；拒绝无效或解码后过大的图片。 */
export function fitCanvasImage(width: number, height: number) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    width * height > 40_000_000
  ) {
    throw new Error("图片尺寸无效或超过 4000 万像素");
  }
  const scale = Math.min(1, 480 / Math.max(width, height));
  return { width: width * scale, height: height * scale };
}

/** 只拉取本站存储图片，避免把 Cookie 或画布内容转发给任意第三方。 */
export function validateCanvasImageUrl(url: string) {
  const invalid = () => new Error("只能导入本站图片");
  if (
    url.length > 4096 ||
    !url.startsWith("/api/storage/") ||
    /[\\\s#]/.test(url)
  ) {
    throw invalid();
  }
  try {
    const parsed = new URL(url, "https://canvas.invalid");
    if (
      parsed.origin !== "https://canvas.invalid" ||
      parsed.pathname !== url.split("?", 1)[0]
    )
      throw invalid();
    const segments = parsed.pathname.slice("/api/storage/".length).split("/");
    if (
      segments.length < 2 ||
      segments.some((segment) => {
        const decoded = decodeURIComponent(segment);
        return (
          !decoded ||
          decoded === "." ||
          decoded === ".." ||
          /[\\/%]/.test(decoded) ||
          [...decoded].some(
            (character) =>
              character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
          )
        );
      })
    )
      throw invalid();
  } catch {
    throw invalid();
  }
  return url;
}

/** 选择非删除元素；没有选择时导出全图，避免空选择生成空白参考图。 */
export function getCanvasExportElements(
  elements: readonly ExcalidrawElement[],
  selectedIds: Readonly<Record<string, boolean>>
) {
  const visible = elements.filter((element) => !element.isDeleted);
  const selected = visible.filter((element) => selectedIds[element.id]);
  const result = selected.length ? selected : visible;
  if (!result.length) throw new Error("画布还是空的，请先添加图片或绘制内容");
  return result;
}
