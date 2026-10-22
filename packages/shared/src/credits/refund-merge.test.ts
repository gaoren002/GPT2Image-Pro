/**
 * refund 批次合并策略测试(DB-free,vi.mock 掉 @repo/database)。
 *
 * 背景:退款按 generation 逐条发放,单用户可积累数万条 active refund 批次
 * (2026-10 生产实测 42615 条/用户),扣费查询与余额列举成本随批次数线性
 * 放大。策略:grantCredits 对 sourceType="refund" 不再插新批次,而是把
 * 金额并入该用户的"退款池批次"(source_ref IS NULL 的单条 active refund
 * 批次,首次退款时创建)。
 *
 * 幂等语义变更:refundAlreadyGranted 原按 credits_batch(source_ref) 查重;
 * 合并后新退款不再有自己的批次行,查重改按 credits_transaction
 * (type='refund', source_ref) —— 双重记账的真相表,语义更准。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * drizzle 表对象 String() 为 "[object Object]";vi.resetModules 后 schema
 * 模块会被重新加载,引用比对也失效。按列名集合识别表(签名在 schema 中
 * 唯一即可靠)。
 */
function tableKeys(t: unknown): string[] {
  return t && typeof t === "object" ? Object.keys(t) : [];
}

function isSystemSettingTable(t: unknown): boolean {
  const keys = tableKeys(t);
  return keys.includes("key") && keys.includes("isSecret");
}

/** credits_transaction 签名:debitAccount/creditAccount 唯一。 */
function isTransactionTable(t: unknown): boolean {
  return tableKeys(t).includes("debitAccount");
}

/** credits_batch 签名:remaining/issuedAt 并存。 */
function isBatchTable(t: unknown): boolean {
  const keys = tableKeys(t);
  return keys.includes("remaining") && keys.includes("issuedAt");
}

process.env.DATABASE_URL ||=
  "postgres://test:test@127.0.0.1:5432/gpt2image_test";

type TxChain = {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  rollback?: () => never;
};

/**
 * 构造最小 drizzle 链式 mock:只覆盖 grantCredits/refundGenerationCredits
 * 实际用到的调用形状(select().from().where().limit()、insert().values()
 * .onConflictDoNothing().returning()、update().set().where().returning())。
 */
function makeTx(tableRows: {
  balance?: Array<Record<string, unknown>>;
  transactions?: Array<Record<string, unknown>>;
}) {
  const calls = {
    inserts: [] as Array<{ table: string; values: unknown }>,
    updates: [] as Array<{ table: string; values: unknown }>,
    selects: [] as Array<string>,
  };
  const returningRows: Record<string, Array<Record<string, unknown>>> = {};

  const chainFinal = (rows: Array<Record<string, unknown>> = []) => {
    const fn = () => Promise.resolve(rows);
    return Object.assign(fn, {
      returning: () => Promise.resolve(rows),
      then: (onFulfilled: (v: unknown) => unknown) =>
        Promise.resolve(rows).then(onFulfilled),
      catch: () => Promise.resolve(rows),
    });
  };

  const tx: TxChain = {
    select: vi.fn(() => {
      const api = {
        from: (t: unknown) => {
          calls.selects.push(String(t));
          if (isSystemSettingTable(t)) {
            // 查询失败 → loadSystemSettingsMap 的 catch 按空设置负缓存,
            // getRuntimeSetting* 落代码默认值(与空库行为一致)。
            return Promise.reject(new Error("mock: no db"));
          }
          return {
            where: () => ({
              limit: () => chainFinal(tableRows.balance || []),
              orderBy: () => ({
                limit: () => chainFinal(tableRows.balance || []),
              }),
            }),
            orderBy: () => ({
              limit: () => chainFinal(tableRows.balance || []),
            }),
          };
        },
      };
      return api;
    }),
    insert: vi.fn((t: unknown) => {
      calls.selects.push(`insert:${String(t)}`);
      return {
        values: (
          v: Record<string, unknown> | Array<Record<string, unknown>>
        ) => {
          const list = Array.isArray(v) ? v : [v];
          const tableKind = isTransactionTable(t)
            ? "transaction"
            : isBatchTable(t)
              ? "batch"
              : "other";
          calls.inserts.push({ table: tableKind, values: list });
          return {
            onConflictDoNothing: () => ({
              returning: () =>
                Promise.resolve(returningRows.insert || [{ id: "batch-1" }]),
            }),
            returning: () =>
              Promise.resolve(returningRows.insert || [{ id: "tx-1" }]),
          };
        },
      };
    }),
    update: vi.fn((t: unknown) => ({
      set: (v: Record<string, unknown>) => {
        const tableKind = isTransactionTable(t)
          ? "transaction"
          : isBatchTable(t)
            ? "batch"
            : "other";
        calls.updates.push({ table: tableKind, values: v });
        return {
          where: () => ({
            returning: () => Promise.resolve([{ id: "updated" }]),
            then: (onFulfilled: (v: unknown) => unknown) =>
              Promise.resolve([{ id: "updated" }]).then(onFulfilled),
          }),
        };
      },
    })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as unknown as TxChain;
  return { tx, calls, returningRows };
}

describe("refundGenerationCredits 幂等查重改走交易表", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  // settingsCache 是模块级单例:resetModules 后重新加载 system-settings,
  // 否则首用例已用真实 db 触发的负缓存会泄漏到后续用例。
  async function loadMaintenance() {
    return await import("./../generation-maintenance");
  }

  it("同一 sourceRef 已有 refund 交易时不重复发放", async () => {
    const dbSelect = () => ({
      from: (table: unknown) => {
        if (isSystemSettingTable(table)) {
          return Promise.reject(new Error("mock: no db"));
        }
        return {
          where: () => ({
            limit: () => Promise.resolve([{ id: "existing-tx" }]),
          }),
        };
      },
    });
    vi.doMock("@repo/database", () => ({
      db: {
        select: dbSelect,
        transaction: async () => {
          throw new Error("不应触达发放路径");
        },
      },
    }));
    const mod = await loadMaintenance();
    const result = await mod.refundGenerationCredits({
      generationId: "g1",
      userId: "u1",
      amount: 5,
      sourceRef: "g1:timeout-refund",
      description: "test",
    });
    expect(result.refunded).toBe(false);
  });

  it("无既有交易时经 grantCredits 合并发放", async () => {
    // makeTx 的事务内 select(余额/退款池)统一返回 balance 行;
    // 退款池查询 select({id}).from(creditsBatch).where(...).limit(1)
    // 也命中同一 mock,返回首行 → 走"并入已有池"路径(update 而非 insert 批次)。
    const { tx, calls } = makeTx({
      balance: [{ balance: 10, status: "active" }],
    });
    const dbSelect = () => ({
      from: (table: unknown) => {
        if (isSystemSettingTable(table)) {
          return Promise.reject(new Error("mock: no db"));
        }
        return {
          where: () => ({
            limit: () => Promise.resolve([]),
          }),
        };
      },
    });
    vi.doMock("@repo/database", () => ({
      db: {
        select: dbSelect,
        transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
      },
    }));
    const mod = await loadMaintenance();
    const result = await mod.refundGenerationCredits({
      generationId: "g2",
      userId: "u1",
      amount: 5,
      sourceRef: "g2:timeout-refund",
      description: "test",
    });
    expect(result.refunded).toBe(true);
    // 记账必须落交易表(credits_transaction,双重记账真相)
    const txInsert = calls.inserts.find((i) => i.table === "transaction");
    expect(txInsert).toBeTruthy();
    // 幂等键必须写进 source_ref 列(查重按列判断;历史上只写 metadata
    // 导致列全 NULL、查重对存量 miss —— 2026-10 已回填并双写)
    const txValues = txInsert?.values as Array<Record<string, unknown>>;
    expect(txValues[0]?.sourceRef).toBe("g2:timeout-refund");
    // 退款池已存在时:批次走 update(amount/remaining 累加),不再插新批次行
    const batchInsert = calls.inserts.find((i) => i.table === "batch");
    expect(batchInsert).toBeUndefined();
    const poolUpdate = calls.updates.find((i) => i.table === "batch");
    expect(poolUpdate).toBeTruthy();
  });
});
