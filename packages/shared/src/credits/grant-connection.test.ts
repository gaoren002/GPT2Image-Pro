/**
 * grantCredits 连接使用约束测试（DB-free，vi.mock 掉 @repo/database）。
 *
 * 背景：事务回调内若再经全局 db 查询（如缓存过期时读取 system_setting），
 * 会在持有一条池连接的同时再借一条；并发发放占满连接池时所有事务互相等待，
 * 全站数据库访问永久挂起（2026-10-24 审查以真实 pg-pool 复现）。
 * 约束：到期日等设置必须在开启事务前读取，事务回调内不得触达全局 db。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL ||=
  "postgres://test:test@127.0.0.1:5432/gpt2image_test";

function tableKeys(t: unknown): string[] {
  return t && typeof t === "object" ? Object.keys(t) : [];
}

function isSystemSettingTable(t: unknown): boolean {
  const keys = tableKeys(t);
  return keys.includes("key") && keys.includes("isSecret");
}

/** 事务内链式调用的最小 mock：余额行存在，批次插入成功，其余写入直接完成。 */
function makeTx() {
  const finalRows = (rows: Array<Record<string, unknown>>) =>
    Object.assign(Promise.resolve(rows), {
      returning: () => Promise.resolve(rows),
      for: () => Promise.resolve(rows),
    });
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => finalRows([{ balance: 10, status: "active" }]),
          orderBy: () => ({ limit: () => finalRows([]) }),
        }),
      }),
    }),
    insert: () => ({
      values: () =>
        Object.assign(Promise.resolve(undefined), {
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve([{ id: "batch-1" }]),
          }),
          returning: () => Promise.resolve([{ id: "tx-1" }]),
        }),
    }),
    update: () => ({
      set: () => ({
        where: () =>
          Object.assign(Promise.resolve([]), {
            returning: () => Promise.resolve([]),
          }),
      }),
    }),
  };
}

describe("grantCredits 不在事务内借用第二条连接", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function runGrant(params: {
    sourceType: "purchase" | "bonus" | "refund";
    expiresAt?: Date | null;
  }) {
    const state = { inTransaction: false, settingReads: [] as boolean[] };
    vi.doMock("@repo/database", () => ({
      db: {
        select: () => ({
          from: (table: unknown) => {
            if (isSystemSettingTable(table)) {
              state.settingReads.push(state.inTransaction);
              return Promise.resolve([]);
            }
            throw new Error("事务外不应查询其他表");
          },
        }),
        transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
          state.inTransaction = true;
          try {
            return await fn(makeTx());
          } finally {
            state.inTransaction = false;
          }
        },
      },
    }));
    const { grantCredits } = await import("./core");
    const result = await grantCredits({
      userId: "u1",
      amount: 5,
      sourceType: params.sourceType,
      sourceRef: `${params.sourceType}-ref`,
      debitAccount: "SYSTEM:test",
      transactionType: "refund",
      description: "test",
      ...(params.expiresAt === undefined ? {} : { expiresAt: params.expiresAt }),
    });
    return { state, result };
  }

  it("默认到期日（退款）在开启事务前读取设置", async () => {
    const { state, result } = await runGrant({ sourceType: "refund" });
    expect(result.alreadyGranted).toBe(false);
    expect(state.settingReads.length).toBeGreaterThan(0);
    expect(state.settingReads.every((inTx) => inTx === false)).toBe(true);
  });

  it("免费积分到期日同样在事务前读取", async () => {
    const { state } = await runGrant({ sourceType: "bonus" });
    expect(state.settingReads.length).toBeGreaterThan(0);
    expect(state.settingReads.every((inTx) => inTx === false)).toBe(true);
  });

  it("调用方显式给出到期日时不读取设置", async () => {
    const { state } = await runGrant({
      sourceType: "purchase",
      expiresAt: null,
    });
    expect(state.settingReads).toEqual([]);
  });
});
