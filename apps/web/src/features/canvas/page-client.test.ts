// @vitest-environment jsdom
/** 真实 React 重渲染与异步完成顺序，验证账号切换不会残留或回灌旧素材。 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasPageClient } from "./page-client";
import type { CanvasEditorProps, CanvasImageSource } from "./types";

const state = vi.hoisted(() => ({
  owner: "a",
  latest: null as CanvasEditorProps | null,
  refresh: vi.fn(),
  router: { push: vi.fn(), replace: vi.fn() },
}));
vi.mock("next/dynamic", () => ({
  default: () => (props: CanvasEditorProps) => {
    state.latest = props;
    return createElement(
      "div",
      null,
      props.images.map((image) => image.id).join(",")
    );
  },
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/i18n/routing", () => ({ useRouter: () => state.router }));
vi.mock("@/features/image-generation/create-runtime-store", () => ({
  useCreateRuntimeState: () => [state.owner],
}));
vi.mock("./actions", () => ({ getCanvasImagesAction: state.refresh }));

/** 不携带真实图片或签名的账号分离夹具。 */
function images(owner: string): CanvasImageSource[] {
  return [
    {
      id: `${owner}-image`,
      prompt: owner,
      url: `/api/storage/generations/${owner}/image.png`,
      thumbnailUrl: `/api/storage/generations/${owner}/image.png`,
    },
  ];
}
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  state.owner = "a";
  state.latest = null;
  state.refresh.mockReset();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

/** 模拟 App Router 保留客户端实例、更新服务端身份 props 的软刷新。 */
async function render(owner: string) {
  await act(async () =>
    root.render(
      createElement(CanvasPageClient, {
        userId: owner,
        initialImages: images(owner),
      })
    )
  );
}

describe("画布账号生命周期", () => {
  it("A 到 B 的软刷新必须使用 B 的新素材列表", async () => {
    await render("a");
    expect(host.textContent).toContain("a-image");
    state.owner = "b";
    await render("b");
    expect(host.textContent).toContain("b-image");
    expect(host.textContent).not.toContain("a-image");
  });
  it("A 的迟到刷新不能覆盖 B 的素材", async () => {
    let resolveRefresh: (result: { data: CanvasImageSource[] }) => void = () =>
      undefined;
    state.refresh.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        })
    );
    await render("a");
    const editor = state.latest;
    if (!editor) throw new Error("未加载编辑器");
    let request: Promise<void> = Promise.resolve();
    await act(async () => {
      request = editor.onRefreshImages();
    });
    state.owner = "b";
    await render("b");
    await act(async () => {
      resolveRefresh({ data: images("a") });
      await request;
    });
    expect(host.textContent).toContain("b-image");
    expect(host.textContent).not.toContain("a-image");
  });
  it("同一页面账号切出再切回，也不能接收上一代请求", async () => {
    let resolveRefresh: (result: { data: CanvasImageSource[] }) => void = () =>
      undefined;
    state.refresh.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        })
    );
    await render("a");
    const editor = state.latest;
    if (!editor) throw new Error("未加载编辑器");
    let request: Promise<void> = Promise.resolve();
    await act(async () => {
      request = editor.onRefreshImages();
    });
    state.owner = "b";
    await render("a");
    state.owner = "a";
    await render("a");
    await act(async () => {
      resolveRefresh({ data: images("b") });
      await request;
    });
    expect(host.textContent).toContain("a-image");
    expect(host.textContent).not.toContain("b-image");
  });
});
