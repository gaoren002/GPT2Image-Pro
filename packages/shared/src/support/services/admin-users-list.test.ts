/** 管理员列表共享服务回归：权限在查询前检查，SSR/action 共用原安全投影与筛选。 */
import {
  creditsBalance,
  externalApiKey,
  generation,
  subscription,
} from "@repo/database/schema";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAdminUsersListSnapshot } from "./admin-users-list";

const database = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock("@repo/database", () => ({ db: database }));

type RecordedQuery = {
  projection: Record<string, unknown>;
  table?: unknown;
  condition?: SQL;
  limit?: number;
  offset?: number;
};
let queries: RecordedQuery[];
let rows: Record<string, unknown>[];

/** 查询替身按实际投影返回列；不导入数据库连接、不模拟权限或筛选业务判断。 */
function select(projection: Record<string, unknown>) {
  const recorded: RecordedQuery = { projection };
  queries.push(recorded);
  const query = {
    from: (table: unknown) => {
      recorded.table = table;
      return query;
    },
    leftJoin: () => query,
    where: (condition: SQL) => {
      recorded.condition = condition;
      return query;
    },
    orderBy: () => query,
    limit: (limit: number) => {
      recorded.limit = limit;
      return query;
    },
    offset: (offset: number) => {
      recorded.offset = offset;
      return query;
    },
    groupBy: () => query,
    // biome-ignore lint/suspicious/noThenProperty: Drizzle 查询构建器需要支持 await，替身保留相同调用链。
    then: (resolve: (value: Record<string, unknown>[]) => unknown) => {
      if ("count" in projection)
        return Promise.resolve([{ count: 1 }]).then(resolve);
      if (recorded.table === generation || recorded.table === externalApiKey) {
        return Promise.resolve([
          { userId: "user-1", total: 2, failed: 1, active: 1 },
        ]).then(resolve);
      }
      return Promise.resolve(
        rows.map((row) =>
          Object.fromEntries(
            Object.keys(projection).map((key) => [key, row[key]])
          )
        )
      ).then(resolve);
    },
  };
  return query;
}

beforeEach(() => {
  queries = [];
  rows = [];
  database.select.mockReset().mockImplementation(select);
});

describe("getAdminUsersListSnapshot", () => {
  it.each([
    "observer_admin",
    "user",
    "unknown",
    null,
    undefined,
  ])("拒绝角色 %s，且不读取任何用户数据", async (role) => {
    await expect(getAdminUsersListSnapshot(undefined, role)).rejects.toThrow(
      "管理员权限"
    );
    expect(database.select).not.toHaveBeenCalled();
  });

  it.each(["admin", "super_admin"])("%s 可查询默认第一页", async (role) => {
    const result = await getAdminUsersListSnapshot(undefined, role);
    expect(result.pagination).toEqual({ page: 1, pageSize: 20, total: 1 });
    expect(queries.find((query) => "email" in query.projection)).toMatchObject({
      limit: 20,
      offset: 0,
    });
  });

  it("保留筛选和分页语义，非法页大小在查询前拒绝", async () => {
    await getAdminUsersListSnapshot(
      {
        query: " Alice ",
        page: 3,
        pageSize: 50,
        status: "banned",
        subscriptionStatus: "active",
        creditsStatus: "frozen",
        plan: "free",
      },
      "admin"
    );
    const listQuery = queries.find((query) => "email" in query.projection);
    expect(listQuery).toMatchObject({ limit: 50, offset: 100 });
    if (!listQuery?.condition) throw new Error("缺少筛选条件");
    expect(new PgDialect().sqlToQuery(listQuery.condition).params).toEqual(
      expect.arrayContaining(["%Alice%", true, "frozen", "active"])
    );
    database.select.mockClear();
    await expect(
      getAdminUsersListSnapshot({ pageSize: 1 }, "admin")
    ).rejects.toThrow();
    expect(database.select).not.toHaveBeenCalled();
  });

  it("用户列表仅返回原有字段和计数，不返回密码、会话或 API Key 内容", async () => {
    rows = [
      {
        id: "user-1",
        name: "Alice",
        email: "alice@example.com",
        image: null,
        role: "user",
        banned: false,
        bannedReason: null,
        emailVerified: true,
        createdAt: new Date("2026-10-22"),
        updatedAt: new Date("2026-10-22"),
        creditsBalance: 10,
        creditsTotalEarned: 12,
        creditsTotalSpent: 2,
        creditsStatus: null,
        subscriptionStatus: null,
        subscriptionPriceId: null,
        subscriptionCurrentPeriodEnd: null,
        password: "must-not-return",
        session: "must-not-return",
        token: "must-not-return",
      },
    ];
    const result = await getAdminUsersListSnapshot(undefined, "admin");
    const projection = queries.find(
      (query) => "email" in query.projection
    )?.projection;
    expect(Object.keys(projection ?? {}).sort()).toEqual(
      [
        "id",
        "name",
        "email",
        "image",
        "role",
        "banned",
        "bannedReason",
        "emailVerified",
        "createdAt",
        "updatedAt",
        "creditsBalance",
        "creditsTotalEarned",
        "creditsTotalSpent",
        "creditsStatus",
        "subscriptionStatus",
        "subscriptionPriceId",
        "subscriptionCurrentPeriodEnd",
      ].sort()
    );
    expect(result.users[0]).toMatchObject({
      plan: "free",
      creditsStatus: "active",
      generationCount: 2,
      failedGenerationCount: 1,
      apiKeyCount: 2,
      activeApiKeyCount: 1,
    });
    expect(JSON.stringify(result)).not.toContain("must-not-return");
    expect(
      queries.some(
        (query) =>
          query.table === creditsBalance || query.table === subscription
      )
    ).toBe(true);
  });
});
