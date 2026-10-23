/** 图库实际渲染回归：空子项父记录不能把剩余页的导航入口隐藏。 */
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  GalleryBatchDeleteButton,
  GalleryClient,
  type GalleryClientProps,
} from "./gallery-client";

vi.mock("next-intl", () => ({ useLocale: () => "zh" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));
vi.mock("@/features/image-generation/actions", () => ({
  batchDeleteGenerationAction: vi.fn(),
}));
vi.mock("./image-card", () => ({ ImageCard: () => null }));

const props: GalleryClientProps = {
  initialGenerations: [],
  hasMore: true,
  finalCount: 0,
  draftCount: 0,
  uploadCount: 21,
  activeTab: "uploads",
  page: 1,
  timeZone: "Asia/Shanghai",
  searchQuery: "cat",
  searchModel: "gpt-image-2.5",
  searchFrom: "2026-10-01",
  searchTo: "2026-10-22",
  modelOptions: ["gpt-image-2.5"],
};

describe("GalleryClient 加载更多", () => {
  it("没有有效子图但后面还有父记录时保留下一页和筛选参数", () => {
    const markup = renderToStaticMarkup(createElement(GalleryClient, props));
    expect(markup).toContain("加载更多");
    expect(markup).toContain(
      'href="/zh/dashboard/gallery?tab=uploads&amp;page=2&amp;q=cat&amp;model=gpt-image-2.5&amp;from=2026-10-01&amp;to=2026-10-22"'
    );
  });

  it("全部父记录读取完毕且没有有效子图时不显示下一页", () => {
    const markup = renderToStaticMarkup(
      createElement(GalleryClient, { ...props, hasMore: false })
    );
    expect(markup).not.toContain("加载更多");
  });

  it("有图片时也使用服务端按展开数量判定的下一页状态", () => {
    const markup = renderToStaticMarkup(
      createElement(GalleryClient, {
        ...props,
        initialGenerations: [
          {
            id: "upload-1",
            prompt: "cat",
            revisedPrompt: null,
            model: "gpt-image-2.5",
            size: "1024x1024",
            creditsConsumed: 0,
            status: "completed",
            createdAt: "2026-10-22T00:00:00Z",
            storageKey: null,
            storageBucket: null,
            imageUrl: null,
            outputRole: "upload",
          },
        ],
      })
    );
    expect(markup).toContain("加载更多");
  });
});

describe("GalleryBatchDeleteButton", () => {
  it.each(["agent-drafts", "uploads"] as const)(
    "%s 派生图片不提供删除生成记录的入口",
    (activeTab) => {
      const markup = renderToStaticMarkup(
        createElement(GalleryBatchDeleteButton, {
          activeTab,
          confirmed: false,
          deleting: false,
          selectedCount: 2,
          onDelete: vi.fn(),
        })
      );
      expect(markup).toBe("");
    }
  );

  it("成品保留删除数量确认和提交期间的禁用状态", () => {
    const markup = renderToStaticMarkup(
      createElement(GalleryBatchDeleteButton, {
        activeTab: "final",
        confirmed: true,
        deleting: true,
        selectedCount: 2,
        onDelete: vi.fn(),
      })
    );
    expect(markup).toContain("确认删除 2 项");
    expect(markup).toContain('disabled=""');
  });
});
