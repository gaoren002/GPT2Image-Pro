/** R24 回归：真实 SafeAction/schema，替换数据库边界以核对账本、事务回滚和重复审计。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  actorId: "admin-1",
  role: "admin",
  selfGrant: true,
  failAudit: false,
  failWallet: false,
  failTransaction: false,
  conflictBatch: false,
  failRevalidate: false,
  locks: [] as Array<{ sql: string; params: unknown[] }>,
  isolation: [] as unknown[],
  tail: Promise.resolve(),
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({
  revalidatePath: () => {
    if (state.failRevalidate) throw new Error("cache unavailable");
  },
}));
vi.mock("../../auth/index", () => ({
  auth: {
    api: {
      getSession: async () => ({
        session: { id: "session-1", userId: state.actorId },
        user: { id: state.actorId, banned: false },
      }),
    },
  },
}));
vi.mock("../../auth/role-server", () => ({
  getUserRoleById: async () => state.role,
}));
vi.mock("../../logger/index", () => ({
  logError: vi.fn(),
  logger: { info: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../monitoring/index", () => ({ captureError: vi.fn() }));
vi.mock("../../system-settings", () => ({
  getRuntimeSettingBoolean: async () => state.selfGrant,
}));
vi.mock("../../generation-maintenance", () => ({
  expireStalePendingGenerations: vi.fn(),
}));
vi.mock("../../subscription/services/user-plan", () => ({
  getUserPlan: vi.fn(),
}));
vi.mock("../../auth/registration-identity", () => ({
  isRegistrationEmailTaken: vi.fn(),
  recordRegistrationIdentity: vi.fn(),
}));
vi.mock("../services/admin-users-list", async () => ({
  getAdminUsersListSnapshot: vi.fn(),
  listUsersSchema: (await import("zod")).z.object({}),
}));

vi.mock("@repo/database", async () => {
  const { getTableName, SQL } = await import("drizzle-orm");
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const dialect = new PgDialect();
  /** 使用真实 WHERE 的参数筛行，避免驱动替实现补上缺失的归属条件。 */
  function matches(row: Row, predicate: unknown) {
    const query = dialect.sqlToQuery(predicate as InstanceType<typeof SQL>);
    return [...query.sql.matchAll(/"[a-z_]+"\."([a-z_]+)" = \$(\d+)/g)].every(
      ([, column, parameter]) => {
        const key =
          column?.replace(/_([a-z])/g, (_, letter: string) =>
            letter.toUpperCase()
          ) ?? "";
        return row[key] === query.params[Number(parameter) - 1];
      }
    );
  }
  /** 链式查询模拟器；事务使用隔离副本，只有成功返回才发布写集。 */
  function database(tables: () => Record<string, Row[]>) {
    const rows = (table: unknown) =>
      (tables()[getTableName(table as never)] ??= []);
    return {
      execute: async (statement: unknown) => {
        const query = dialect.sqlToQuery(statement as InstanceType<typeof SQL>);
        state.locks.push(query);
      },
      select: () => ({
        from: (table: unknown) => ({
          where: (predicate: unknown) => ({
            limit: (limit: number) => {
              const found = rows(table)
                .filter((row) => matches(row, predicate))
                .slice(0, limit);
              return Object.assign(Promise.resolve(found), {
                for: async () => found,
              });
            },
          }),
        }),
      }),
      insert: (table: unknown) => ({
        values: (values: Row) => {
          let ignoreConflict = false;
          /** 只在 await/returning 时写入，模拟唯一约束和可注入的审计故障。 */
          const insert = async () => {
            const name = getTableName(table as never);
            if (name === "admin_audit_log" && state.failAudit)
              throw new Error("audit failed");
            if (name === "credits_transaction" && state.failTransaction)
              throw new Error("transaction unique violation");
            const conflict = rows(table).some((row) =>
              name === "credits_balance"
                ? row.userId === values.userId
                : name === "credits_batch"
                  ? row.sourceType === values.sourceType &&
                    row.sourceRef === values.sourceRef
                  : name === "credits_transaction"
                    ? row.userId === values.userId &&
                      row.type === values.type &&
                      row.sourceRef === values.sourceRef
                    : row.id === values.id
            );
            if (conflict || (name === "credits_batch" && state.conflictBatch)) {
              if (ignoreConflict) return [];
              throw new Error("unique violation");
            }
            rows(table).push(values);
            return [values];
          };
          const result = {
            // biome-ignore lint/suspicious/noThenProperty: 模拟 Drizzle 延迟执行的可等待查询，先完成链式冲突配置。
            then: <T>(
              resolve: (value: Row[]) => T,
              reject: (error: unknown) => T
            ) => insert().then(resolve, reject),
            returning: insert,
            onConflictDoNothing: () => {
              ignoreConflict = true;
              return result;
            },
          };
          return result;
        },
      }),
      update: (table: unknown) => ({
        set: (values: Row) => ({
          where: (predicate: unknown) => {
            /** SQL 加法按真实参数求值，保留钱包更新失败后的整笔回滚。 */
            const update = async () => {
              if (state.failWallet) throw new Error("wallet failed");
              const found = rows(table).filter((row) =>
                matches(row, predicate)
              );
              for (const row of found)
                for (const [key, value] of Object.entries(values)) {
                  row[key] =
                    value instanceof SQL
                      ? Number(row[key]) +
                        Number(dialect.sqlToQuery(value).params[0])
                      : value;
                }
              return found;
            };
            return {
              // biome-ignore lint/suspicious/noThenProperty: 模拟 Drizzle 查询的 await 和 returning 两种执行入口。
              then: <T>(
                resolve: (value: Row[]) => T,
                reject: (error: unknown) => T
              ) => update().then(resolve, reject),
              returning: update,
            };
          },
        }),
      }),
    };
  }
  const db = {
    ...database(() => state.tables),
    // 该 DB-free 驱动串行化事务；真实 PG 的锁调度仍需父代理集成验收。
    transaction: async (
      run: (tx: ReturnType<typeof database>) => Promise<unknown>,
      config: unknown
    ) => {
      const previous = state.tail;
      let release = () => {};
      state.tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      state.isolation.push(config);
      const local = structuredClone(state.tables);
      try {
        const result = await run(database(() => local));
        state.tables = local;
        return result;
      } finally {
        release();
      }
    },
  };
  return { db };
});

vi.mock("../../credits/core", () => ({
  // 旧实现的真实边界：grant 自行提交，之后的审计失败不会回滚资金。
  grantCredits: async (input: Row) => {
    state.tables.credits_transaction ??= [];
    const entries = state.tables.credits_transaction;
    const duplicate = entries.some(
      (entry) => entry.sourceRef === input.sourceRef
    );
    if (!duplicate) entries.push({ ...input, id: `legacy-${entries.length}` });
    return {
      batchId: "legacy",
      transactionId: "legacy",
      amount: duplicate ? 0 : input.amount,
      alreadyGranted: duplicate,
    };
  },
  consumeCredits: vi.fn(),
  ensureCreditsBalance: vi.fn(),
  freezeCreditsAccount: vi.fn(),
  getCreditsBalance: vi.fn(),
  unfreezeCreditsAccount: vi.fn(),
}));

import { adminGrantCreditsAction } from "./admin-users";
import { invokeOperation } from "../../uol/invoke";
import { adminGrant } from "../../uol/operations/credits";
import type { Principal } from "../../uol/principal";

const input = {
  userId: "target-1",
  amount: 25.5,
  reason: "客服补偿",
  requestId: "4c5e41f0-f022-47ce-a24c-81a507428df4",
};
/** 保留缺键等不合法运行时输入，以验证真实 schema 而非 TS 类型。 */
const grant = (value: unknown = input) =>
  adminGrantCreditsAction(value as typeof input);
const entries = () => state.tables.credits_transaction ?? [];
const audits = () => state.tables.admin_audit_log ?? [];

/** 直走真实 UOL 网关，绕过 ServerAction 以验证服务自身的安全边界。 */
const invokeGrant = (
  value: unknown = input,
  principal: Principal = { type: "user", userId: "admin-1", role: "admin" }
) =>
  invokeOperation<{
    amount: number;
    alreadyGranted: boolean;
    batchId: string;
    transactionId: string;
  }>("credits.adminGrant", value, principal);

beforeEach(() => {
  state.tables = {
    user: [
      { id: "target-1", role: "user" },
      { id: "target-2", role: "user" },
      { id: "admin-1", role: "admin" },
      { id: "admin-2", role: "admin" },
    ],
    credits_balance: [
      {
        id: "wallet-1",
        userId: "target-1",
        status: "active",
        balance: 10,
        totalEarned: 10,
      },
    ],
  };
  state.actorId = "admin-1";
  state.role = "admin";
  state.selfGrant = true;
  state.failAudit = false;
  state.failWallet = false;
  state.failTransaction = false;
  state.conflictBatch = false;
  state.failRevalidate = false;
  state.locks = [];
  state.isolation = [];
  state.tail = Promise.resolve();
  let now = 100;
  vi.spyOn(Date, "now").mockImplementation(() => ++now);
});
afterEach(() => vi.restoreAllMocks());

describe("R24 UOL 管理员充值", () => {
  it("声明管理员权限和 actor 范围的必填请求键", () => {
    expect(adminGrant.access).toEqual({ kind: "admin" });
    expect(adminGrant.idempotency).toEqual({
      kind: "required",
      keyField: "requestId",
      scope: "per-user",
    });
    expect(adminGrant.readOnly).toBe(false);
    expect(adminGrant.sideEffects).toEqual(["billing", "audit"]);
  });
  it.each([
    "admin",
    "super_admin",
  ] as const)("%s 可直调，资金与审计仅提交一次", async (role) => {
    const principal: Principal = { type: "user", userId: "admin-2", role };
    const results = await Promise.all([
      invokeGrant(input, principal),
      invokeGrant(input, principal),
    ]);
    expect(results.map((result) => result.amount)).toEqual([25.5, 0]);
    expect(entries()).toHaveLength(1);
    expect(audits()).toHaveLength(1);
    expect(entries()[0]?.debitAccount).toBe("ADMIN:admin-2");
    expect(entries()[0]?.sourceRef).toBe(
      `admin_grant:admin-2:${input.requestId}`
    );
    expect(audits()[0]?.adminUserId).toBe("admin-2");
    expect(results[1]?.transactionId).toBe(results[0]?.transactionId);
  });
  it.each([
    { type: "user", userId: "observer-1", role: "observer_admin" },
    { type: "user", userId: "ordinary-1", role: "user" },
    { type: "user", userId: "__mcp_admin__", role: "super_admin" },
    { type: "system", reason: "test" },
    { type: "cron", job: "test" },
    {
      type: "apiKey",
      userId: "admin-1",
      apiKeyId: "key-1",
      plan: "pro",
      relayOnly: false,
    },
  ] satisfies Principal[])("拒绝非管理员身份 %j", async (principal) => {
    await expect(invokeGrant(input, principal)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(entries()).toHaveLength(0);
    expect(audits()).toHaveLength(0);
    expect(state.isolation).toHaveLength(0);
  });
  it.each([
    "admin",
    "super_admin",
  ])("直调不能绕过目标角色护栏 %s", async (role) => {
    const target = state.tables.user?.[0];
    if (target) target.role = role;
    await expect(invokeGrant()).rejects.toMatchObject({
      code: "forbidden",
      message: expect.stringContaining("无权对该账户执行"),
    });
    expect(entries()).toHaveLength(0);
  });
  it("超管仍能向管理员目标发放", async () => {
    await expect(
      invokeGrant(
        { ...input, userId: "admin-2" },
        { type: "user", userId: "admin-1", role: "super_admin" }
      )
    ).resolves.toMatchObject({ amount: 25.5 });
  });
  it("直调仍检查自充值关闭开关，保留超管豁免", async () => {
    state.selfGrant = false;
    const selfInput = { ...input, userId: "admin-1" };
    await expect(invokeGrant(selfInput)).rejects.toMatchObject({
      code: "forbidden",
      message: expect.stringContaining("不能为自己发放积分"),
    });
    await expect(
      invokeGrant(selfInput, {
        type: "user",
        userId: "admin-1",
        role: "super_admin",
      })
    ).resolves.toMatchObject({ amount: 25.5 });
  });
  it("自充值开启也不扩大原目标角色权限", async () => {
    await expect(
      invokeGrant({ ...input, userId: "admin-1" })
    ).rejects.toMatchObject({
      code: "forbidden",
      message: expect.stringContaining("无权对该账户执行"),
    });
  });
  it("拒绝 input 伪造 actor、角色或过期参数", async () => {
    await expect(
      invokeGrant({
        ...input,
        actorId: "forged",
        adminUserId: "forged",
        role: "super_admin",
        expiresAt: "2099-01-01",
      })
    ).rejects.toMatchObject({ code: "validation_error" });
    expect(entries()).toHaveLength(0);
  });
  it("直调相同请求改金额返回冲突，审计失败也整笔回滚", async () => {
    state.failAudit = true;
    await expect(invokeGrant()).rejects.toMatchObject({
      code: "internal_error",
    });
    expect(entries()).toHaveLength(0);
    expect(state.tables.credits_batch ?? []).toHaveLength(0);
    state.failAudit = false;
    await invokeGrant();
    await expect(invokeGrant({ ...input, amount: 26 })).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    expect(entries()).toHaveLength(1);
    expect(audits()).toHaveLength(1);
  });
  it.each([
    { type: "user", userId: "observer-1", role: "observer_admin" },
    { type: "system", reason: "test" },
    { type: "user", userId: "", role: "super_admin" },
  ] satisfies Principal[])("直接调用服务仍拒绝无效操作者 %j", async (principal) => {
    const { grantAdminCredits } = await import(
      "../services/admin-credit-grant"
    );
    await expect(grantAdminCredits(input, principal)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(entries()).toHaveLength(0);
    expect(state.isolation).toHaveLength(0);
  });
  it("直接服务入口同样复核目标与自充值开关", async () => {
    const { grantAdminCredits } = await import(
      "../services/admin-credit-grant"
    );
    const principal: Principal = {
      type: "user",
      userId: "admin-1",
      role: "admin",
    };
    await expect(
      grantAdminCredits({ ...input, userId: "admin-2" }, principal)
    ).rejects.toMatchObject({ code: "forbidden" });
    state.selfGrant = false;
    await expect(
      grantAdminCredits({ ...input, userId: "admin-1" }, principal)
    ).rejects.toMatchObject({
      code: "forbidden",
      message: expect.stringContaining("不能为自己发放积分"),
    });
    expect(entries()).toHaveLength(0);
  });
});

describe("R24 管理员充值幂等", () => {
  it.each([
    undefined,
    "",
    "not-a-uuid",
  ])("拒绝缺失/非法 UUID %s", async (requestId) => {
    expect(
      (await grant({ ...input, requestId }))?.validationErrors
    ).toBeDefined();
    expect(entries()).toHaveLength(0);
    expect(audits()).toHaveLength(0);
  });
  it.each([
    0,
    -1,
    0.001,
    1.234,
    100000.01,
    Number.POSITIVE_INFINITY,
  ])("拒绝非法积分 %s", async (amount) => {
    expect((await grant({ ...input, amount }))?.validationErrors).toBeDefined();
    expect(entries()).toHaveLength(0);
  });
  it("重试和并发双击只记一笔资金、一条审计，重放发放量为零", async () => {
    const results = await Promise.all([grant(), grant(), grant()]);
    expect(results.every((result) => result?.data)).toBe(true);
    expect(results.map((result) => result?.data?.amount)).toEqual([25.5, 0, 0]);
    expect(results.map((result) => result?.data?.alreadyGranted)).toEqual([
      false,
      true,
      true,
    ]);
    expect(entries()).toHaveLength(1);
    expect(audits()).toHaveLength(1);
    expect(state.tables.credits_batch).toHaveLength(1);
    expect(state.tables.credits_balance?.[0]?.balance).toBe(35.5);
    expect(results[1]?.data?.message).not.toContain("已为用户充值");
    expect(state.locks).toHaveLength(3);
    expect(
      state.locks.every((lock) => lock.sql.includes("pg_advisory_xact_lock"))
    ).toBe(true);
    expect(state.locks[0]?.params).toEqual([
      `admin_grant:admin-1:${input.requestId}`,
    ]);
    expect(
      state.isolation.every(
        (config) =>
          JSON.stringify(config) === '{"isolationLevel":"read committed"}'
      )
    ).toBe(true);
  });
  it.each([
    { amount: 26 },
    { userId: "target-2" },
    { reason: "活动奖励" },
  ])("同 key 改参数必须拒绝 %j", async (changed) => {
    await grant();
    expect((await grant({ ...input, ...changed }))?.serverError).toContain(
      "请求标识已用于不同的充值参数"
    );
    expect(entries()).toHaveLength(1);
    expect(audits()).toHaveLength(1);
  });
  it("UUID 大小写和原因空白归一化后仍为同一请求", async () => {
    await grant();
    expect(
      (
        await grant({
          ...input,
          requestId: input.requestId.toUpperCase(),
          reason: ` ${input.reason} `,
        })
      )?.data?.alreadyGranted
    ).toBe(true);
    expect(entries()).toHaveLength(1);
  });
  it("同 UUID 按 actor 隔离，新 UUID 也是新意图", async () => {
    await grant();
    state.actorId = "admin-2";
    await grant();
    await grant({
      ...input,
      requestId: "d37a4a45-02df-4098-b208-a597b8a85b9c",
    });
    expect(entries()).toHaveLength(3);
    expect(audits()).toHaveLength(3);
    expect(state.tables.credits_balance?.[0]?.balance).toBe(86.5);
  });
  it.each([
    "failAudit",
    "failWallet",
    "failTransaction",
    "conflictBatch",
  ] as const)("%s 失败整笔回滚，同 key 可重试", async (fault) => {
    state[fault] = true;
    expect((await grant())?.serverError).toBeDefined();
    expect(entries()).toHaveLength(0);
    expect(audits()).toHaveLength(0);
    expect(state.tables.credits_batch ?? []).toHaveLength(0);
    expect(state.tables.credits_balance?.[0]?.balance).toBe(10);
    state[fault] = false;
    expect((await grant())?.data?.amount).toBe(25.5);
  });
  it("提交后缓存刷新失败，使用同 key 重试也不再发放或审计", async () => {
    state.failRevalidate = true;
    await grant();
    state.failRevalidate = false;
    expect((await grant())?.data?.amount).toBe(0);
    expect(entries()).toHaveLength(1);
    expect(audits()).toHaveLength(1);
  });
  it("缺失钱包可创建；冻结钱包拒绝资金和审计", async () => {
    state.tables.credits_balance = [];
    expect((await grant())?.data?.newBalance).toBe(25.5);
    state.tables.credits_balance = [
      { id: "wallet-2", userId: "target-2", balance: 0, status: "frozen" },
    ];
    expect(
      (
        await grant({
          ...input,
          userId: "target-2",
          requestId: "d37a4a45-02df-4098-b208-a597b8a85b9c",
        })
      )?.serverError
    ).toContain("冻结");
    expect(entries()).toHaveLength(1);
  });
  it.each(["admin", "super_admin"])("保留目标角色护栏 %s", async (role) => {
    const target = state.tables.user?.[0];
    if (target) target.role = role;
    expect((await grant())?.serverError).toContain("无权对该账户执行");
    expect(entries()).toHaveLength(0);
  });
  it("保留普通 admin 自充值关闭开关和超管豁免", async () => {
    state.selfGrant = false;
    expect(
      (await grant({ ...input, userId: state.actorId }))?.serverError
    ).toContain("不能为自己发放积分");
    state.role = "super_admin";
    expect(
      (await grant({ ...input, userId: state.actorId }))?.data?.amount
    ).toBe(25.5);
  });
});
