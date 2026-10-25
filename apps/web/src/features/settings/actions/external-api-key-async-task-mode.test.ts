/** 异步任务模式开关：只更新本人的 Key，无外接 API 权限的套餐拒绝且不写库；新建 Key 默认关闭。 */
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createExternalApiKey,
  updateExternalApiKeyAsyncTaskMode,
} from "./external-api-key";

const state = vi.hoisted(() => ({
  updates: [] as { values: Record<string, unknown>; where: SQL }[],
  inserts: [] as Record<string, unknown>[],
  allowed: true,
}));
vi.mock("@repo/database", () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async (where: SQL) => {
          state.updates.push({ values, where });
        },
      }),
    }),
    insert: () => ({
      values: async (values: Record<string, unknown>) => {
        state.inserts.push(values);
      },
    }),
  },
}));
vi.mock("@repo/shared/safe-action", () => ({
  protectedAction: {
    metadata: () => {
      const action =
        (run: (value: unknown) => Promise<unknown>) => (parsedInput: unknown) =>
          run({ parsedInput, ctx: { userId: "owner-1" } });
      return { action, schema: () => ({ action }) };
    },
  },
}));
vi.mock("@/features/image-backend-pool/service", () => ({
  listImageBackendGroupOptions: vi.fn(),
}));
vi.mock("@repo/shared/subscription/services/user-plan", () => ({
  getUserPlan: vi.fn(async () => ({ plan: "starter" })),
}));
vi.mock("@repo/shared/subscription/services/plan-capabilities", () => ({
  canUsePlanCapability: vi.fn(
    async (_plan: string, capability: string) =>
      capability === "externalApi.keys.manage" && state.allowed
  ),
  normalizePlanModerationBlockRiskLevel: vi.fn(async () => "low"),
}));

beforeEach(() => {
  state.updates.length = 0;
  state.inserts.length = 0;
  state.allowed = true;
});

describe("updateExternalApiKeyAsyncTaskMode", () => {
  it("开启与关闭都按 id 加 userId 定位，只改本人的 Key", async () => {
    await expect(
      updateExternalApiKeyAsyncTaskMode({
        id: "key-1",
        asyncTaskMode: true,
      })
    ).resolves.toEqual({ success: true, asyncTaskMode: true });
    await updateExternalApiKeyAsyncTaskMode({
      id: "key-1",
      asyncTaskMode: false,
    });

    expect(state.updates.map((update) => update.values.asyncTaskMode)).toEqual([
      true,
      false,
    ]);
    expect(state.updates[0]?.values.updatedAt).toBeInstanceOf(Date);
    const where = new PgDialect().sqlToQuery(state.updates[0]?.where as SQL);
    expect(where.sql).toContain('"external_api_key"."id" = $1');
    expect(where.sql).toContain('"external_api_key"."user_id" = $2');
    expect(where.params).toEqual(["key-1", "owner-1"]);
  });

  it("套餐不可管理外接 API Key 时拒绝，且不写库", async () => {
    state.allowed = false;
    await expect(
      updateExternalApiKeyAsyncTaskMode({
        id: "key-1",
        asyncTaskMode: true,
      })
    ).rejects.toThrow("External API access requires Starter plan or higher.");
    expect(state.updates).toHaveLength(0);
  });
});

describe("createExternalApiKey", () => {
  it("未传 asyncTaskMode 时默认关闭，显式 true 时开启", async () => {
    await createExternalApiKey({});
    await createExternalApiKey({ asyncTaskMode: true });
    expect(state.inserts.map((row) => row.asyncTaskMode)).toEqual([
      false,
      true,
    ]);
    expect(state.inserts[1]?.userId).toBe("owner-1");
  });
});
