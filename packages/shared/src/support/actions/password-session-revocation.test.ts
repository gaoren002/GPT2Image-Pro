/**
 * 管理员重设密码吊销会话测试（DB-free）。
 *
 * 约束：超管重设用户密码后必须删除该用户全部会话，否则旧会话（默认 7 天）继续有效，
 * 账号被盗场景下重设密码踢不掉占用者；审计日志记录吊销数量，且不含明文或哈希密码。
 * 被测：真实 setUserPasswordAction，经真实 superAdminAction 链执行。
 * 替换边界：会话与角色查询、数据库（记录写入）、仅在 import 时需要数据库的服务。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL ||=
  "postgres://test:test@127.0.0.1:5432/gpt2image_test";

const state = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  writes: [] as Array<{ op: string; table: string; values?: unknown }>,
  sessionRows: [] as Array<{ id: string }>,
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

vi.mock("../../auth/index", () => ({
  auth: {
    api: {
      getSession: async () => ({
        session: { id: "s1", userId: "super-1" },
        user: {
          id: "super-1",
          name: "Owner",
          email: "owner@example.com",
          banned: false,
        },
      }),
    },
  },
}));
vi.mock("../../auth/role-server", () => ({
  getUserRoleById: async () => "super_admin",
}));

vi.mock("@repo/database", async () => {
  const schema = await vi.importActual<Record<string, unknown>>(
    "@repo/database/schema"
  );
  const { getTableName } = await vi.importActual<typeof import("drizzle-orm")>(
    "drizzle-orm"
  );
  const name = (table: unknown) => getTableName(table as never);
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
        where: async () => {
          state.writes.push({ op: "update", table: name(table), values });
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: unknown) => {
        state.writes.push({ op: "insert", table: name(table), values });
      },
    }),
    delete: (table: unknown) => ({
      // 记在 where：直接 await 与 .returning() 两种写法都只计一次。
      where: () => {
        state.writes.push({ op: "delete", table: name(table) });
        return Object.assign(Promise.resolve(state.sessionRows), {
          returning: async () => state.sessionRows,
        });
      },
    }),
  };
  return { ...schema, db };
});

vi.mock("../../credits/core", () => ({
  consumeCredits: async () => ({}),
  ensureCreditsBalance: async () => undefined,
  freezeCreditsAccount: async () => undefined,
  getCreditsBalance: async () => ({ balance: 0, status: "active" }),
  grantCredits: async () => ({}),
  unfreezeCreditsAccount: async () => undefined,
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

import { setUserPasswordAction } from "./admin-users";

const TARGET = {
  id: "member-1",
  name: "Member",
  email: "member@example.com",
  role: "user",
  banned: false,
  bannedReason: null,
  emailVerified: true,
};

describe("setUserPasswordAction 吊销目标用户会话", () => {
  beforeEach(() => {
    state.selectQueue.length = 0;
    state.writes.length = 0;
    state.sessionRows = [{ id: "sess-1" }, { id: "sess-2" }];
  });

  it("覆盖既有凭据密码后删除该用户全部会话，并记入审计", async () => {
    state.selectQueue.push([TARGET], [{ id: "cred-1" }]);

    const result = await setUserPasswordAction({
      userId: "member-1",
      password: "Brand-New-Pass1",
      reason: "用户申诉找回账号",
    });

    expect(result?.data?.message).toBe("用户密码已重设");
    expect(state.writes.map((write) => `${write.op}:${write.table}`)).toEqual([
      "update:account",
      "delete:session",
      "insert:admin_audit_log",
    ]);

    const audit = state.writes.at(-1)?.values as {
      metadata?: Record<string, unknown>;
    };
    expect(audit.metadata).toEqual({
      credentialCreated: false,
      sessionsRevoked: 2,
    });
    expect(JSON.stringify(state.writes)).not.toContain("Brand-New-Pass1");
  });

  it("纯 OAuth 用户新建凭据后同样吊销会话", async () => {
    state.selectQueue.push([TARGET], []);
    state.sessionRows = [{ id: "sess-1" }];

    await setUserPasswordAction({
      userId: "member-1",
      password: "Brand-New-Pass1",
      reason: "用户申诉找回账号",
    });

    expect(state.writes.map((write) => `${write.op}:${write.table}`)).toEqual([
      "insert:account",
      "delete:session",
      "insert:admin_audit_log",
    ]);
    const audit = state.writes.at(-1)?.values as {
      metadata?: Record<string, unknown>;
    };
    expect(audit.metadata).toEqual({
      credentialCreated: true,
      sessionsRevoked: 1,
    });
  });
});
