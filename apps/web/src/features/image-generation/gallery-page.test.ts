/** 图库服务端页面回归：只加载当前标签，且按展开图片而非父行徽章判定下一页。 */
import type { generation } from "@repo/database/schema";
import { Children, isValidElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import GalleryPage from "@/app/[locale]/(dashboard)/dashboard/gallery/page";
import { GalleryClient, type GalleryClientProps } from "./components/gallery-client";

type GenerationRow = typeof generation.$inferSelect;
type QueryResult = Promise<unknown[]> & {
  from: () => QueryResult;
  where: () => QueryResult;
  orderBy: () => QueryResult;
  limit: () => QueryResult;
};

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  selectDistinct: vi.fn(),
}));

vi.mock("@repo/database", () => ({ db: mocks }));
vi.mock("@repo/shared/auth/server", () => ({
  getCurrentUser: async () => ({ id: "user-1" }),
}));
vi.mock("@repo/shared/time-zone/server", () => ({
  getAppTimeZone: async () => "Asia/Shanghai",
}));
vi.mock("next-intl/server", () => ({ getLocale: async () => "zh" }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("./components/gallery-client", () => ({ GalleryClient: () => null }));

/** 用可等待的查询替身保留页面自身的查询分支和元数据展开流程。 */
function queryResult(rows: unknown[]): QueryResult {
  const result = Promise.resolve(rows);
  const query: QueryResult = Object.assign(result, {
    from: () => query,
    where: () => query,
    orderBy: () => query,
    limit: () => query,
  });
  return query;
}

beforeEach(() => {
  mocks.select.mockReset();
  mocks.selectDistinct.mockReset();
  mocks.select.mockImplementation((projection?: unknown) =>
    queryResult(projection ? [{ count: 0 }] : [])
  );
  mocks.selectDistinct.mockImplementation(() => queryResult([]));
});

describe("GalleryPage", () => {
  it("重复的单值筛选不崩溃，使用默认标签、页码和空筛选", async () => {
    const page = await GalleryPage({
      searchParams: Promise.resolve({
        page: ["2", "3"],
        tab: ["uploads", "agent-drafts"],
        q: ["cat", "dog"],
        model: ["gpt-image-2.5", "other"],
        from: ["2026-10-01", "2026-10-02"],
        to: ["2026-10-21", "2026-10-22"],
      }),
    });
    const gallery = Children.toArray(page.props.children).find(
      (child) => isValidElement(child) && child.type === GalleryClient
    );
    if (!isValidElement<GalleryClientProps>(gallery)) {
      throw new Error("GalleryPage did not render GalleryClient");
    }
    expect(gallery.props).toMatchObject({
      activeTab: "final",
      page: 1,
      searchQuery: "",
      searchModel: "",
      searchFrom: "",
      searchTo: "",
    });
  });

  it.each(["final", "agent-drafts", "uploads"])(
    "%s 标签只加载一组实体行，保留四次徽章计数和模型选项",
    async (tab) => {
      await GalleryPage({ searchParams: Promise.resolve({ tab }) });
      const entityQueries = mocks.select.mock.calls.filter(
        ([projection]) => projection === undefined
      );
      const countQueries = mocks.select.mock.calls.filter(
        ([projection]) => projection !== undefined
      );
      expect(entityQueries).toHaveLength(1);
      expect(countQueries).toHaveLength(4);
      expect(mocks.selectDistinct).toHaveBeenCalledTimes(1);
    }
  );

  it("一条父记录含二十五张上传图时，第二页展示全部图片后结束", async () => {
    const parent: GenerationRow = {
      id: "generation-1",
      userId: "user-1",
      prompt: "cat",
      revisedPrompt: null,
      model: "gpt-image-2.5",
      size: "1024x1024",
      status: "completed",
      storageKey: null,
      storageBucket: null,
      fileSize: null,
      creditsConsumed: 0,
      error: null,
      metadata: {
        inputImages: {
          images: Array.from({ length: 25 }, (_, index) => ({
            id: `input-${index}`,
            imageUrl: `https://example.com/image-${index}.png`,
          })),
        },
      },
      createdAt: new Date("2026-10-22T00:00:00Z"),
      completedAt: null,
    };
    mocks.select.mockImplementation((projection?: unknown) =>
      queryResult(projection ? [{ count: 1 }] : [parent])
    );
    for (const expected of [
      { page: "1", itemCount: 20, hasMore: true },
      { page: "2", itemCount: 25, hasMore: false },
    ]) {
      const page = await GalleryPage({
        searchParams: Promise.resolve({ tab: "uploads", page: expected.page }),
      });
      const gallery = Children.toArray(page.props.children).find(
        (child) => isValidElement(child) && child.type === GalleryClient
      );
      if (!isValidElement<GalleryClientProps>(gallery)) {
        throw new Error("GalleryPage did not render GalleryClient");
      }
      expect(gallery.props.initialGenerations).toHaveLength(expected.itemCount);
      expect(gallery.props.uploadCount).toBe(1);
      expect(gallery.props.hasMore).toBe(expected.hasMore);
    }
  });
});
