/** 历史/图库日期回归：调用真实服务端页面并检查 Drizzle 参数，隔离数据库和鉴权。 */
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { Children, isValidElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GalleryPage from "@/app/[locale]/(dashboard)/dashboard/gallery/page";
import HistoryPage from "@/app/[locale]/(dashboard)/dashboard/history/page";
import {
  GalleryClient,
  type GalleryClientProps,
} from "./components/gallery-client";
import {
  HistoryClient,
  type HistoryClientProps,
} from "./components/history-client";
import type { GenerationListSearchParams } from "./generation-list-filters";

type QueryRecord = {
  kind: "rows" | "count" | "models";
  where?: SQL;
  limit?: number;
  offset?: number;
};
type Query = Promise<unknown[]> & {
  from: () => Query;
  where: (where?: SQL) => Query;
  orderBy: () => Query;
  limit: (limit: number) => Query;
  offset: (offset: number) => Query;
};

const state = vi.hoisted(() => ({
  timeZone: "Asia/Shanghai",
  queries: [] as QueryRecord[],
}));
vi.mock("@repo/database", () => ({
  db: {
    select: (projection?: unknown) => query(projection ? "count" : "rows"),
    selectDistinct: () => query("models"),
  },
}));
vi.mock("@repo/shared/auth/server", () => ({
  getCurrentUser: async () => ({ id: "user-1" }),
}));
// 保留真实 getAppTimeZone，证明页面从 APP_TIME_ZONE 配置取得查询时区。
vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingString: async (key: string) => {
    if (key !== "APP_TIME_ZONE") throw new Error(`未预期的设置读取：${key}`);
    return state.timeZone;
  },
}));
vi.mock("@repo/shared/storage/signed-url", () => ({
  buildSignedStorageImageUrl: () => null,
}));
vi.mock("next-intl/server", () => ({ getLocale: async () => "zh" }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("./components/gallery-client", () => ({ GalleryClient: () => null }));
vi.mock("./components/history-client", () => ({ HistoryClient: () => null }));

/** 查询替身仅捕获真实页面传来的条件和分页参数，不改写 SQL 或日期参数。 */
function query(kind: QueryRecord["kind"]): Query {
  const record: QueryRecord = { kind };
  state.queries.push(record);
  const result: Query = Object.assign(
    Promise.resolve(kind === "count" ? [{ count: 0 }] : []),
    {
      from: () => result,
      where: (where?: SQL) => {
        record.where = where;
        return result;
      },
      orderBy: () => result,
      limit: (limit: number) => {
        record.limit = limit;
        return result;
      },
      offset: (offset: number) => {
        record.offset = offset;
        return result;
      },
    }
  );
  return result;
}

/** 从真实 SQL 中取出日期绑定值；不执行数据库查询或依赖源码文本匹配。 */
function dateParams(record: QueryRecord) {
  if (!record.where) throw new Error("列表查询缺少 WHERE 条件");
  const compiled = new PgDialect().sqlToQuery(record.where);
  return compiled.params.filter(
    (value: unknown): value is string =>
      typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)
  );
}

/** 图库的主体草稿计数复用两次公共筛选；保持现有查询结构，核验每次绑定。 */
function expectedDateParams(
  entry: "history" | "final" | "agent-drafts" | "uploads",
  queryIndex: number,
  dates: string[]
) {
  const draftPrimaryIndex = entry === "final" ? 2 : 1;
  return entry !== "history" && queryIndex === draftPrimaryIndex
    ? [...dates, ...dates]
    : dates;
}

/** 渲染真实页面并取出传给客户端的规范化筛选，客户端组件本身不执行。 */
async function renderList(
  entry: "history" | "final" | "agent-drafts" | "uploads",
  params: GenerationListSearchParams
) {
  const page =
    entry === "history"
      ? await HistoryPage({ searchParams: Promise.resolve(params) })
      : await GalleryPage({
          searchParams: Promise.resolve({ tab: entry, ...params }),
        });
  const client = Children.toArray(page.props.children).find(
    (child) =>
      isValidElement(child) &&
      (child.type === HistoryClient || child.type === GalleryClient)
  );
  if (!isValidElement<HistoryClientProps | GalleryClientProps>(client)) {
    throw new Error("页面未返回列表客户端组件");
  }
  return client.props;
}

beforeEach(() => {
  vi.stubEnv("TZ", "UTC");
  state.queries = [];
  state.timeZone = "Asia/Shanghai";
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each([
  "history",
  "final",
  "agent-drafts",
  "uploads",
] as const)("%s 按应用时区筛选日期", (entry) => {
  it.each([
    {
      zone: "Asia/Shanghai",
      date: "2026-10-24",
      hours: 24,
      from: "2026-10-23T16:00:00.000Z",
      to: "2026-10-24T15:59:59.999Z",
    },
    {
      zone: "America/Los_Angeles",
      date: "2026-03-08",
      hours: 23,
      from: "2026-03-08T08:00:00.000Z",
      to: "2026-03-09T06:59:59.999Z",
    },
    {
      zone: "America/Los_Angeles",
      date: "2026-11-01",
      hours: 25,
      from: "2026-11-01T07:00:00.000Z",
      to: "2026-11-02T07:59:59.999Z",
    },
  ])("UTC 进程、$zone 的 $date 为 $hours 小时", async (expected) => {
    expect(new Date(2026, 9, 24).toISOString()).toBe(
      "2026-10-24T00:00:00.000Z"
    );
    state.timeZone = expected.zone;
    const props = await renderList(entry, {
      page: "2",
      from: ` ${expected.date} `,
      to: expected.date,
    });
    expect(props).toMatchObject({
      timeZone: expected.zone,
      searchFrom: expected.date,
      searchTo: expected.date,
      page: 2,
    });
    const filtered = state.queries.filter((record) => record.kind !== "models");
    expect(filtered).toHaveLength(entry === "history" ? 2 : 5);
    for (const [index, record] of filtered.entries()) {
      const dates = dateParams(record);
      expect(dates).toEqual(
        expectedDateParams(entry, index, [expected.from, expected.to])
      );
      expect(
        (Date.parse(dates[1] ?? "") - Date.parse(dates[0] ?? "") + 1) /
          3_600_000
      ).toBe(expected.hours);
    }
    expect(
      state.queries.find((record) => record.kind === "rows")
    ).toMatchObject(
      entry === "history" ? { limit: 20, offset: 20 } : { limit: 40 }
    );
    // 模型选项仍按用户全量查询，不受日期范围影响。
    expect(
      state.queries.filter((record) => record.kind === "models").map(dateParams)
    ).toEqual([[]]);
  });

  it.each([
    { from: "2026-02-30", to: "2026-13-01" },
    { from: ["2026-10-23", "2026-10-24"], to: ["2026-10-24"] },
  ])("非法或歧义日期不被滚动到其他日历日：%j", async (params) => {
    const props = await renderList(entry, params);
    expect(props).toMatchObject({ searchFrom: "", searchTo: "" });
    for (const record of state.queries) expect(dateParams(record)).toEqual([]);
  });

  it("闰日合法输入归一化，单边范围保留", async () => {
    const props = await renderList(entry, {
      from: " 2024-02-29 ",
      to: "invalid",
    });
    expect(props).toMatchObject({ searchFrom: "2024-02-29", searchTo: "" });
    const filtered = state.queries.filter((item) => item.kind !== "models");
    for (const [index, record] of filtered.entries()) {
      expect(dateParams(record)).toEqual(
        expectedDateParams(entry, index, ["2024-02-28T16:00:00.000Z"])
      );
    }
  });
});
