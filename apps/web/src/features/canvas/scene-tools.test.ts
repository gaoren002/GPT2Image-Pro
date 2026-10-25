/** 画布图片边界与选择导出的回归测试，不启动浏览器或编辑器。 */
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { describe, expect, it } from "vitest";
import {
  fitCanvasImage,
  getCanvasExportElements,
  validateCanvasImageUrl,
} from "./scene-tools";

/** 只构造选择逻辑读取的字段，不以整个 SDK 创建场景掩盖被测行为。 */
function element(id: string, isDeleted = false) {
  return { id, isDeleted } as ExcalidrawElement;
}

describe("画布图片边界", () => {
  it("按比例缩小且不放大小图", () => {
    expect(fitCanvasImage(1920, 1080)).toEqual({ width: 480, height: 270 });
    expect(fitCanvasImage(120, 240)).toEqual({ width: 120, height: 240 });
  });
  it.each([
    [0, 1],
    [-1, 100],
    [NaN, 1],
    [Infinity, 1],
    [10000, 10000],
  ])("拒绝非法尺寸 %s × %s", (w, h) => {
    expect(() => fitCanvasImage(w, h)).toThrow();
  });
  it.each([
    "https://evil.example/api/storage/generations/a.png",
    "//evil.example/a.png",
    "data:image/png;base64,a",
    "blob:a",
    "/api/storage\\evil/a.png",
    "/other/image.png",
    "/api/storage/generations/../../auth/sign-out",
    "/api/storage/generations/%2e%2e/%2e%2e/other.png",
    "/api/storage/generations/a%2fb.png",
    "/api/storage/generations/%0a.png",
  ])("不下载任意外域或非存储地址 %s", (url) => {
    expect(() => validateCanvasImageUrl(url)).toThrow();
  });
  it("保留本站签名地址", () => {
    const url =
      "/api/storage/generations/user/image.png?sig=valid&exp=2000000000";
    expect(validateCanvasImageUrl(url)).toBe(url);
  });
});

describe("画布导出选择", () => {
  it("只导出选中且未删除的元素", () => {
    const elements = [element("a"), element("b"), element("c", true)];
    expect(getCanvasExportElements(elements, { b: true, c: true })).toEqual([
      elements[1],
    ]);
  });
  it("没有选择时导出全部存活元素", () => {
    const elements = [element("a"), element("b", true)];
    expect(getCanvasExportElements(elements, {})).toEqual([elements[0]]);
  });
  it("空画布明确报错", () => {
    expect(() => getCanvasExportElements([element("a", true)], {})).toThrow(
      "画布还是空的"
    );
  });
});
