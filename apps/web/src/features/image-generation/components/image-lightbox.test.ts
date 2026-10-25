// @vitest-environment jsdom

/** 灯箱画布入口回归：点击只导航，按当前预览图传参并拒绝非本站存储地址。 */
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ImageLightbox,
  type ImageLightboxProps,
  type LightboxGeneration,
} from "./image-lightbox";

const state = vi.hoisted(() => ({
  locale: "zh",
  push: vi.fn<(href: string) => void>(),
  close: vi.fn(),
  execute: vi.fn(),
  handoff: vi.fn(),
}));

vi.mock("next-intl", () => ({ useLocale: () => state.locale }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: state.push }),
}));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("next-safe-action/hooks", () => ({
  useAction: () => ({ execute: state.execute, isExecuting: false }),
}));
vi.mock("@/features/image-generation/actions", () => ({
  deleteGenerationAction: vi.fn(),
}));
vi.mock("@/features/image-generation/reference-handoff", () => ({
  writePendingReferenceHandoff: state.handoff,
}));
vi.mock("@/features/psd-export/components/export-psd-dialog", () => ({
  ExportPsdDialog: () => null,
}));
vi.mock("@repo/ui/components/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? children : null,
  DialogContent: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DialogTitle: ({ children }: { children: ReactNode }) =>
    createElement("h2", null, children),
}));

const outputUrl =
  "/api/storage/generations/user-a/output.png?sig=abc&exp=1800000000";
const referenceUrl =
  "/api/storage/generations/user-a/reference.png?sig=def&exp=1800000000";
const generation: LightboxGeneration = {
  id: "output-1",
  prompt: "test image",
  revisedPrompt: null,
  model: "gpt-image-2.5",
  size: "1024x1024",
  creditsConsumed: 1,
  status: "completed",
  createdAt: "2026-10-25T00:00:00Z",
};

let root: Root;
let container: HTMLDivElement;

/** 挂载真实灯箱与动作按钮，仅替换导航、弹窗外壳和服务端依赖。 */
async function renderLightbox(overrides: Partial<ImageLightboxProps> = {}) {
  await act(async () => {
    root.render(
      createElement(ImageLightbox, {
        generation,
        imageUrl: outputUrl,
        open: true,
        onClose: state.close,
        ...overrides,
      })
    );
  });
}

/** 使用可见文案定位入口，兼容两个语言环境。 */
function canvasButton() {
  return Array.from(container.querySelectorAll("button")).find((button) =>
    ["加入画布", "Add to canvas"].includes(button.textContent || "")
  );
}

/** 通过真实点击验证跳转目标，不主动触发生成或网络请求。 */
async function openCanvas() {
  const button = canvasButton();
  if (!button) throw new Error("Missing canvas button");
  await act(async () => button.click());
  expect(state.push).toHaveBeenCalledTimes(1);
  const href = state.push.mock.calls[0]?.[0];
  if (!href) throw new Error("Missing canvas navigation target");
  return new URL(href, "https://app.test");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn());
  state.locale = "zh";
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("灯箱加入画布", () => {
  it.each([
    ["zh", "加入画布"],
    ["en", "Add to canvas"],
  ])("%s 文案、语言路由与完整签名参数正确", async (locale, label) => {
    state.locale = locale;
    await renderLightbox();
    expect(canvasButton()?.textContent).toBe(label);
    const target = await openCanvas();
    expect(target.pathname).toBe(`/${locale}/dashboard/canvas`);
    expect(target.searchParams.get("ref")).toBe(outputUrl);
    expect(target.searchParams.get("sourceId")).toBe(generation.id);
    expect([...target.searchParams.keys()]).toEqual(["ref", "sourceId"]);
    expect(state.close).toHaveBeenCalledTimes(1);
  });

  it("选择参考图后发送该图及其具体 ID，而非成品或父记录", async () => {
    const referenceId = "input-2/参考图&";
    await renderLightbox({
      generation: {
        ...generation,
        referenceImages: [
          { id: referenceId, imageUrl: referenceUrl, name: "参考图 A" },
        ],
      },
    });
    const referenceButton = container.querySelector<HTMLButtonElement>(
      'button[title="参考图 A"]'
    );
    if (!referenceButton) throw new Error("Missing reference thumbnail");
    await act(async () => referenceButton.click());
    const target = await openCanvas();
    expect(target.searchParams.get("ref")).toBe(referenceUrl);
    expect(target.searchParams.get("sourceId")).toBe(referenceId);
  });

  it("只有参考图时使用初始选中的参考图", async () => {
    await renderLightbox({
      imageUrl: null,
      generation: {
        ...generation,
        referenceImages: [{ id: "input-1", imageUrl: referenceUrl }],
      },
    });
    const target = await openCanvas();
    expect(target.searchParams.get("ref")).toBe(referenceUrl);
    expect(target.searchParams.get("sourceId")).toBe("input-1");
  });

  it.each(["pending", "failed"] as const)(
    "%s 记录即使携带图片也不显示入口",
    async (status) => {
      await renderLightbox({ generation: { ...generation, status } });
      expect(canvasButton()).toBeUndefined();
    }
  );

  it.each([
    null,
    "",
    "https://third-party.test/image.png",
    "https://app.test/api/storage/generations/user-a/image.png",
    "//third-party.test/api/storage/image.png",
    "data:image/png;base64,AAAA",
    "blob:https://app.test/image",
    "/api/storage-other/image.png",
    "/api/storage",
  ])("不接受非本站相对存储地址：%s", async (imageUrl) => {
    await renderLightbox({ imageUrl });
    expect(canvasButton()).toBeUndefined();
    expect(state.push).not.toHaveBeenCalled();
  });

  it("第三方参考图隐藏入口，切回本站成品后恢复并使用成品 ID", async () => {
    await renderLightbox({
      generation: {
        ...generation,
        referenceImages: [
          {
            id: "external-1",
            imageUrl: "https://third-party.test/reference.png",
            name: "外部参考图",
          },
        ],
      },
    });
    expect(canvasButton()).toBeDefined();
    const referenceButton = container.querySelector<HTMLButtonElement>(
      'button[title="外部参考图"]'
    );
    if (!referenceButton) throw new Error("Missing reference thumbnail");
    await act(async () => referenceButton.click());
    expect(canvasButton()).toBeUndefined();
    expect(state.push).not.toHaveBeenCalled();
    const outputButton = container.querySelector<HTMLButtonElement>(
      'button[title="成品"]'
    );
    if (!outputButton) throw new Error("Missing output thumbnail");
    await act(async () => outputButton.click());
    const target = await openCanvas();
    expect(target.searchParams.get("ref")).toBe(outputUrl);
    expect(target.searchParams.get("sourceId")).toBe(generation.id);
  });

  it("渲染和点击均不发请求、写交接存储或执行生成动作", async () => {
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    await renderLightbox();
    expect(state.push).not.toHaveBeenCalled();
    await openCanvas();
    expect(fetch).not.toHaveBeenCalled();
    expect(state.execute).not.toHaveBeenCalled();
    expect(state.handoff).not.toHaveBeenCalled();
    expect(storageWrite).not.toHaveBeenCalled();
  });
});
