/** 外接 Key 鉴权的使用时间记录只作遥测；节流写入且失败不阻断已验证身份。 */
import { beforeEach, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
const state = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  updates: [] as SQL[],
  failUpdate: false,
  plan: vi.fn(async () => ({ plan: "pro" })),
}));
vi.mock("@repo/database", () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({ limit: async () => [{ ...state.row }] }),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: async (condition: SQL) => {
          state.updates.push(condition);
          if (state.failUpdate) throw new Error("fixture database unavailable");
        },
      }),
    }),
  },
}));
vi.mock("@repo/shared/subscription/services/user-plan", () => ({
  getUserPlan: state.plan,
}));
vi.mock("@repo/shared/subscription/services/plan-capabilities", () => ({
  canUsePlanCapability: async () => true,
}));
vi.mock("@repo/shared/logger", () => ({ logWarn: vi.fn() }));
import { authenticateExternalApiRequest } from "./auth";
import { hashApiKey } from "./auth-token";
const token = "g2i_fixture_auth_test";
const request = () =>
  new Request("https://fixture.invalid/v1/images", {
    headers: { authorization: `Bearer ${token}` },
  });
beforeEach(() => {
  state.row = {
    id: "fixture-key",
    userId: "fixture-user",
    keyHash: hashApiKey(token),
    lastUsedAt: null,
    userBanned: false,
    creditLimit: 10,
    creditsUsed: 2,
  };
  state.updates.length = 0;
  state.failUpdate = false;
  state.plan.mockClear();
});
it("一分钟内的轮询不再写 Key", async () => {
  state.row.lastUsedAt = new Date(Date.now() - 1000);
  expect(await authenticateExternalApiRequest(request())).toMatchObject({
    apiKeyId: "fixture-key",
  });
  expect(state.updates).toHaveLength(0);
});
it("过期遥测用 SQL 再查截止时间，避免并发旧快照重复写", async () => {
  state.row.lastUsedAt = new Date(Date.now() - 120000);
  await authenticateExternalApiRequest(request());
  expect(state.updates).toHaveLength(1);
  const condition = state.updates[0];
  if (!condition) throw new Error("missing usage update condition");
  const query = new PgDialect().sqlToQuery(condition);
  expect(query.sql).toMatch(/"last_used_at".*(?:is null|<)/);
  expect(query.sql).toContain('"is_active"');
});
it("遥测写失败不阻断合法 Key 的认证", async () => {
  state.failUpdate = true;
  await expect(
    authenticateExternalApiRequest(request())
  ).resolves.toMatchObject({ userId: "fixture-user" });
});
it("封禁检查和每次套餐复查保留，不被遥测优化缓存", async () => {
  state.row.lastUsedAt = new Date();
  await authenticateExternalApiRequest(request());
  await authenticateExternalApiRequest(request());
  expect(state.plan).toHaveBeenCalledTimes(2);
  state.row.userBanned = true;
  expect(await authenticateExternalApiRequest(request())).toBeNull();
  expect(state.updates).toHaveLength(0);
});
