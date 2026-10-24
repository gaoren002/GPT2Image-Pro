/** Key 撤销动作写入永久撤销标记，防止临时禁用/重新启用路径将泄露凭据复活。 */
import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
const state = vi.hoisted(() => ({ updates: [] as Record<string, unknown>[] }));
vi.mock("@repo/database", () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [{ id: "key-1" }] }) }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          state.updates.push(values);
        },
      }),
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
  getUserPlan: vi.fn(),
}));
vi.mock("@repo/shared/subscription/services/plan-capabilities", () => ({
  canUsePlanCapability: vi.fn(),
  normalizePlanModerationBlockRiskLevel: vi.fn(),
}));
import { revokeExternalApiKey } from "./external-api-key";
describe("永久撤销", () => {
  it("与停用在同一条 UPDATE 写入撤销时间，重放保留最早的撤销时间", async () => {
    await revokeExternalApiKey({ id: "key-1" });
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]?.isActive).toBe(false);
    const marker = state.updates[0]?.revokedAt;
    expect(marker).toBeDefined();
    expect(new PgDialect().sqlToQuery(marker as SQL).sql).toMatch(
      /COALESCE\(.+"revoked_at", now\(\)\)/
    );
  });
});
