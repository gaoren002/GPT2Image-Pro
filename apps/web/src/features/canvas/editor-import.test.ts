// @vitest-environment jsdom
/** 画布导入副作用回归：只有真正写入场景后才消费图库交接，失败保留链接供刷新重试。 */
import { act, createElement, type ReactNode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasEditor } from "./editor";

const state = vi.hoisted(() => ({
  fetch: vi.fn(),
  consumed: vi.fn(),
  error: vi.fn(),
  api: {
    getAppState: () => ({
      scrollX: 0,
      scrollY: 0,
      zoom: { value: 1 },
      width: 800,
      height: 600,
    }),
    getSceneElements: () => [],
    addFiles: vi.fn(),
    updateScene: vi.fn(),
  },
}));
vi.mock("./image-import", () => ({ fetchCanvasImage: state.fetch }));
vi.mock("./use-canvas-document", () => ({
  useCanvasDocument: () => ({
    ready: true,
    initialData: null,
    saveState: "saved",
    error: "",
    onChange: vi.fn(),
    save: vi.fn(),
  }),
}));
vi.mock("next-intl", () => ({ useLocale: () => "zh" }));
vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("sonner", () => ({ toast: { error: state.error } }));
vi.mock("@excalidraw/excalidraw", () => {
  const Item = () => null;
  return {
    CaptureUpdateAction: { IMMEDIATELY: "IMMEDIATELY" },
    convertToExcalidrawElements: () => [{ id: "new-image" }],
    exportToBlob: vi.fn(),
    MainMenu: Object.assign(
      ({ children }: { children: ReactNode }) => children,
      {
        DefaultItems: {
          LoadScene: Item,
          SaveToActiveFile: Item,
          Export: Item,
          SaveAsImage: Item,
          ClearCanvas: Item,
          ChangeCanvasBackground: Item,
        },
      }
    ),
    Excalidraw: ({
      excalidrawAPI,
    }: {
      excalidrawAPI: (api: typeof state.api) => void;
    }) => {
      useEffect(() => excalidrawAPI(state.api), [excalidrawAPI]);
      return createElement("div");
    },
  };
});
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  state.fetch.mockReset();
  state.consumed.mockClear();
  state.error.mockClear();
  state.api.updateScene.mockClear();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

/** 使用真实组件的 effect 和导入流程，仅替换 SDK 画布及网络解码。 */
async function render() {
  await act(async () =>
    root.render(
      createElement(CanvasEditor, {
        userId: "owner",
        workspace: "images",
        images: [],
        onRefreshImages: async () => undefined,
        onContinueEditing: async () => undefined,
        incomingImage: {
          id: "image",
          prompt: "test",
          url: "/api/storage/generations/owner/a.png",
          thumbnailUrl: "/api/storage/generations/owner/a.png",
        },
        onIncomingImageConsumed: state.consumed,
      })
    )
  );
}
describe("画布图库交接", () => {
  it("导入失败时保留交接，不清除 URL 参数", async () => {
    state.fetch.mockRejectedValue(new Error("network unavailable"));
    await render();
    expect(state.error).toHaveBeenCalledWith("network unavailable");
    expect(state.api.updateScene).not.toHaveBeenCalled();
    expect(state.consumed).not.toHaveBeenCalled();
  });
  it("成功写入场景后才消费一次交接", async () => {
    state.fetch.mockResolvedValue({
      width: 480,
      height: 320,
      mimeType: "image/png",
      dataURL: "data:image/png;base64,fixture",
    });
    await render();
    expect(state.api.updateScene).toHaveBeenCalledOnce();
    expect(state.consumed).toHaveBeenCalledOnce();
  });
});
