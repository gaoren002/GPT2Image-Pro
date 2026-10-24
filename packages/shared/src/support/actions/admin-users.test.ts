/** 用户管理集成回归：真实 SafeAction 鉴权链；仅替换数据库、会话和外部服务边界。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  writes: [] as Array<{ op: string; table: string; values?: unknown }>,
  freeze: [] as string[],
  unfreeze: [] as string[],
  actorRole: "admin",
  concurrentRevocation: false,
  predicates: [] as string[],
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

vi.mock("../../auth/index", () => ({
  auth: {
    api: {
      getSession: async () => ({
        session: { id: "s1", userId: "admin-1" },
        user: {
          id: "admin-1",
          name: "Admin",
          email: "admin@example.com",
          banned: false,
        },
      }),
    },
  },
}));
vi.mock("../../auth/role-server", () => ({
  getUserRoleById: async (userId: string) =>
    userId === "admin-1" ? state.actorRole : "user",
}));

vi.mock("@repo/database", async () => {
  const schema = await vi.importActual<Record<string, unknown>>(
    "@repo/database/schema"
  );
  const { getTableName } =
    await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  const { PgDialect } = await vi.importActual<
    typeof import("drizzle-orm/pg-core")
  >("drizzle-orm/pg-core");
  /** 从真实 Drizzle schema 提取表名，用于核对写入目标。 */
  const name = (table: unknown) => getTableName(table as never);
  /** 模拟查询链，按顺序返回测试行，不连接数据库。 */
  const query = () => {
    const q: Record<string, unknown> = {};
    q.from = () => q;
    q.where = () => q;
    q.orderBy = () => q;
    q.limit = async () => state.selectQueue.shift() ?? [];
    return q;
  };
  const db = {
    select: query,
    update: (table: unknown) => ({
      set: (values: unknown) => ({
        where: (predicate: unknown) => {
          state.predicates.push(
            new PgDialect().sqlToQuery(predicate as never).sql
          );
          state.writes.push({ op: "update", table: name(table), values });
          const result = Promise.resolve();
          return Object.assign(result, {
            returning: async () =>
              state.concurrentRevocation ? [] : [{ id: "key-1" }],
          });
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: unknown) => {
        state.writes.push({ op: "insert", table: name(table), values });
      },
    }),
    delete: (table: unknown) => ({
      where: async () => {
        state.writes.push({ op: "delete", table: name(table) });
      },
    }),
  };
  return { ...schema, db };
});

vi.mock("../../credits/core", () => ({
  consumeCredits: async () => ({}),
  ensureCreditsBalance: async () => undefined,
  freezeCreditsAccount: async (userId: string) => {
    state.freeze.push(userId);
  },
  getCreditsBalance: async () => ({ balance: 0, status: "active" }),
  grantCredits: async () => ({}),
  unfreezeCreditsAccount: async (userId: string) => {
    state.unfreeze.push(userId);
  },
}));
vi.mock("../../generation-maintenance", () => ({
  expireStalePendingGenerations: async () => undefined,
}));
vi.mock("../../system-settings", () => ({
  getRuntimeSettingBoolean: async () => true,
}));
vi.mock("../../subscription/services/user-plan", () => ({
  getUserPlan: async () => ({ plan: "free" }),
}));
vi.mock("../services/admin-users-list", async () => ({
  getAdminUsersListSnapshot: async () => ({}),
  listUsersSchema: (
    await vi.importActual<typeof import("zod")>("zod")
  ).z.object({}),
}));
vi.mock("../../auth/registration-identity", () => ({
  isRegistrationEmailTaken: async () => false,
  recordRegistrationIdentity: async () => undefined,
}));

import {
  setExternalApiKeyStatusAction,
  setUserCreditsStatusAction,
} from "./admin-users";

const telemetry = vi.hoisted(() => ({
  logError: vi.fn(),
  captureError: vi.fn(),
}));
vi.mock("../../logger/index", () => ({
  logError: telemetry.logError,
  logger: { info: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../monitoring/index", () => ({
  captureError: telemetry.captureError,
}));

const targetUser = {
  id: "target-1",
  name: "Target",
  email: "target@example.com",
  role: "user",
  banned: false,
  bannedReason: null,
  emailVerified: true,
};
const apiKey = {
  id: "key-1",
  userId: targetUser.id,
  name: "Target key",
  keyPrefix: "g2i_test",
  lastFour: "last",
  isActive: true,
  revokedAt: null,
};

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  state.actorRole = "admin";
  state.concurrentRevocation = false;
  state.predicates.length = 0;
  state.selectQueue.length = 0;
  state.writes.length = 0;
  state.freeze.length = 0;
  state.unfreeze.length = 0;
  vi.clearAllMocks();
});

describe("用户撤销的 Key 不可由管理端复活", () => {
  it("即使超管也不得重新启用已撤销的 Key", async () => {
    state.actorRole = "super_admin";
    state.selectQueue.push(
      [{ ...apiKey, isActive: false, revokedAt: new Date() }],
      [targetUser]
    );
    const result = await setExternalApiKeyStatusAction({
      keyId: apiKey.id,
      isActive: true,
      reason: "test revoke",
    });
    expect(result?.serverError).toContain("已被用户撤销");
    expect(state.writes).toEqual([]);
  });
  it("读取后发生撤销时，启用条件不匹配也不得写成功审计", async () => {
    state.concurrentRevocation = true;
    state.selectQueue.push([{ ...apiKey, isActive: false }], [targetUser]);
    const result = await setExternalApiKeyStatusAction({
      keyId: apiKey.id,
      isActive: true,
      reason: "test concurrent",
    });
    expect(result?.serverError).toContain("状态已变化");
    expect(state.predicates.at(-1)).toContain('"revoked_at" is null');
    expect(
      state.writes.filter((write) => write.table === "admin_audit_log")
    ).toEqual([]);
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("管理员目标角色护栏", () => {
  describe.each(["admin", "super_admin"])("目标 %s", (role) => {
    it.each([
      "frozen",
      "active",
    ] as const)("普通 admin 不得设置积分状态 %s", async (status) => {
      state.selectQueue.push([{ ...targetUser, role }]);
      const result = await setUserCreditsStatusAction({
        userId: targetUser.id,
        status,
        reason: "regression",
      });
      expect(result?.serverError).toContain("无权对该账户执行");
      expect(state.freeze).toEqual([]);
      expect(state.unfreeze).toEqual([]);
      expect(state.writes).toEqual([]);
    });
    it.each([
      true,
      false,
    ])("普通 admin 不得设置 Key 启用状态 %s", async (isActive) => {
      state.selectQueue.push([apiKey], [{ ...targetUser, role }]);
      const result = await setExternalApiKeyStatusAction({
        keyId: apiKey.id,
        isActive,
        reason: "regression",
      });
      expect(result?.serverError).toContain("无权对该账户执行");
      expect(state.writes).toEqual([]);
    });
  });

  it.each([
    ["admin", "user"],
    ["admin", "observer_admin"],
    ["super_admin", "admin"],
    ["super_admin", "super_admin"],
  ])("%s 可冻结并解冻允许的目标 %s，保留审计", async (actorRole, role) => {
    state.actorRole = actorRole;
    for (const status of ["frozen", "active"] as const) {
      state.selectQueue.push(
        [{ ...targetUser, role }],
        [{ status: "active", balance: 10 }],
        [{ status, balance: 10 }]
      );
      const result = await setUserCreditsStatusAction({
        userId: targetUser.id,
        status,
        reason: "regression",
      });
      expect(result?.serverError).toBeUndefined();
      expect(result?.data?.message).toBe(
        status === "frozen" ? "积分账户已冻结" : "积分账户已解冻"
      );
    }
    expect(state.freeze).toEqual([targetUser.id]);
    expect(state.unfreeze).toEqual([targetUser.id]);
    expect(state.writes).toEqual([
      expect.objectContaining({
        table: "admin_audit_log",
        values: expect.objectContaining({
          targetUserId: targetUser.id,
          action: "credits.freeze",
        }),
      }),
      expect.objectContaining({
        table: "admin_audit_log",
        values: expect.objectContaining({
          targetUserId: targetUser.id,
          action: "credits.unfreeze",
        }),
      }),
    ]);
  });

  it.each([
    ["admin", "user"],
    ["super_admin", "super_admin"],
  ])("%s 可按既有语义启停允许目标 %s 的 Key", async (actorRole, role) => {
    state.actorRole = actorRole;
    for (const isActive of [false, true]) {
      state.selectQueue.push(
        [{ ...apiKey, isActive: !isActive }],
        [{ ...targetUser, role }]
      );
      const result = await setExternalApiKeyStatusAction({
        keyId: apiKey.id,
        isActive,
        reason: "regression",
      });
      expect(result?.serverError).toBeUndefined();
      expect(result?.data?.message).toBe(
        isActive ? "API Key 已启用" : "API Key 已禁用"
      );
    }
    expect(state.writes).toHaveLength(4);
    expect(state.writes[0]).toMatchObject({
      table: "external_api_key",
      values: { isActive: false },
    });
    expect(state.writes[1]).toMatchObject({
      table: "admin_audit_log",
      values: {
        targetUserId: targetUser.id,
        action: "external_api_key.disable",
      },
    });
    expect(state.writes[2]).toMatchObject({
      table: "external_api_key",
      values: { isActive: true },
    });
    expect(state.writes[3]).toMatchObject({
      table: "admin_audit_log",
      values: { action: "external_api_key.enable" },
    });
  });

  it("Key 所有者不存在时失败关闭且不写入", async () => {
    state.selectQueue.push([apiKey], []);
    const result = await setExternalApiKeyStatusAction({
      keyId: apiKey.id,
      isActive: false,
      reason: "regression",
    });
    expect(result?.serverError).toBe("用户不存在");
    expect(state.writes).toEqual([]);
  });

  it.each([
    "user",
    "observer_admin",
  ])("%s 不能通过真实管理员中间件", async (role) => {
    state.actorRole = role;
    const result = await setUserCreditsStatusAction({
      userId: targetUser.id,
      status: "frozen",
      reason: "regression",
    });
    expect(result?.serverError).toBeDefined();
    expect(state.freeze).toEqual([]);
    expect(state.writes).toEqual([]);
  });
});
