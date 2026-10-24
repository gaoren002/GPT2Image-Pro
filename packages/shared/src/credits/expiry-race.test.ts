/**
 * R13/R38：真实积分函数与 Drizzle 谓词的离线受控调度回归。
 * 替身只实现本文件需要的行锁、提交/回滚和 numeric(18,2)；消费、退款和
 * hold 的竞争写入由等价状态变更模拟，不替代真实 PostgreSQL 并发验收。
 */
import {
  creditsBalance,
  creditsBatch,
  creditsTransaction,
} from "@repo/database/schema";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  select: vi.fn(),
  update: vi.fn(),
  transaction: vi.fn(),
}));
const events = vi.hoisted(() => vi.fn());
vi.mock("@repo/database", () => ({ db: database }));
vi.mock("../system-settings", () => ({
  getRuntimeSettingNumber: async (_key: string, fallback: number) => fallback,
}));
vi.mock("../logger/index", () => ({ logEvent: events }));

import {
  ensureRegistrationBonusExpiry,
  extendActiveSubscriptionBatchesExpiry,
  processExpiredBatches,
} from "./core";

const now = new Date("2026-10-25T12:00:00Z");
const past = new Date(now.getTime() - 1);
const future = new Date("2026-11-25T12:00:00Z");
const dialect = new PgDialect();

type Batch = {
  id: string;
  userId: string;
  amount: number;
  remaining: number;
  status: string;
  sourceType: string;
  sourceRef: string | null;
  issuedAt: Date;
  expiresAt: Date | null;
};
type Transaction = {
  owner: symbol;
  batches: Map<string, Batch>;
  wallet: Map<string, number>;
  entries: Record<string, unknown>[];
};

/** 显式调度门，不使用定时等待。 */
function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** 暂停一个步骤，允许调用方先完成竞争事务。 */
function pause() {
  const reached = gate();
  const resume = gate();
  return {
    reached: reached.promise,
    release: resume.release,
    run: async () => {
      reached.release();
      await resume.promise;
    },
  };
}

/** 模拟两位 numeric，不把浮点噪声作为数据库原始值。 */
function numeric(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** 构造批次；默认已到期，可覆盖用户、来源和 hold 状态。 */
function batch(
  id: string,
  remaining = 0.1,
  overrides: Partial<Batch> = {}
): Batch {
  return {
    id,
    userId: "u1",
    amount: remaining,
    remaining,
    status: "active",
    sourceType: "subscription",
    sourceRef: null,
    issuedAt: new Date("2026-10-01T12:00:00Z"),
    expiresAt: past,
    ...overrides,
  };
}

/**
 * 按生产 Drizzle 编译出的 WHERE 判断行，绝不替调用方补缺失谓词。
 * 仅覆盖这三个入口当前使用的谓词，不作为通用 SQL 执行器。
 */
function matches(row: Batch, condition: SQL) {
  const compiled = dialect.sqlToQuery(condition);
  const fields = {
    id: "id",
    user_id: "userId",
    status: "status",
    source_type: "sourceType",
  } as const;
  for (const [column, field] of Object.entries(fields)) {
    const index = new RegExp(`"${column}" = \\$(\\d+)`).exec(compiled.sql)?.[1];
    if (index && row[field] !== compiled.params[Number(index) - 1])
      return false;
  }
  const remaining = /"remaining" > \$(\d+)/.exec(compiled.sql)?.[1];
  if (
    remaining &&
    row.remaining <= Number(compiled.params[Number(remaining) - 1])
  )
    return false;
  const source = /"source_ref" = \$(\d+)/.exec(compiled.sql)?.[1];
  if (
    source &&
    row.sourceRef !== null &&
    row.sourceRef !== compiled.params[Number(source) - 1]
  )
    return false;
  if (compiled.sql.includes('"expires_at" is not null') && !row.expiresAt)
    return false;
  const dates = [...compiled.sql.matchAll(/"expires_at" ([<>]) \$(\d+)/g)];
  for (const [, operator, index] of dates) {
    const value = compiled.params[Number(index) - 1];
    if (typeof value !== "string") throw new Error("不支持的到期日参数");
    const threshold = new Date(value).getTime();
    if (!Number.isFinite(threshold)) throw new Error("无效到期日");
    if (!row.expiresAt) return false;
    if (
      operator === "<"
        ? row.expiresAt.getTime() >= threshold
        : row.expiresAt.getTime() <= threshold
    )
      return false;
  }
  // 注册奖励的 interval 条件与 SET 共用公式，空到期日也需要补齐。
  if (compiled.sql.includes("interval '1 day'") && row.expiresAt) {
    const days = compiled.params.find(
      (value) => typeof value === "number" && value > 0
    );
    if (typeof days !== "number") throw new Error("缺少有效期天数");
    if (row.expiresAt.getTime() <= row.issuedAt.getTime() + days * 86_400_000)
      return false;
  }
  return true;
}

/** 延迟执行，兼容 UPDATE 的 await 与 returning；同一查询只执行一次。 */
function query(run: () => Promise<Record<string, unknown>[]>) {
  let pending: ReturnType<typeof run> | undefined;
  const result = {
    returning: (_fields?: unknown) => result,
    // biome-ignore lint/suspicious/noThenProperty: 模拟 Drizzle await 时执行的查询。
    then: <TResult1 = Record<string, unknown>[], TResult2 = never>(
      fulfilled?:
        | ((
            rows: Record<string, unknown>[]
          ) => TResult1 | PromiseLike<TResult1>)
        | null,
      rejected?: ((error: unknown) => TResult2 | PromiseLike<TResult2>) | null
    ) => {
      pending ??= run();
      return pending.then(fulfilled, rejected);
    },
  };
  return result;
}

/** 批次先锁、钱包后写；提交才公开变更，失败完整回滚，不允许嵌套事务。 */
class ExpiryLedger {
  batches = new Map<string, Batch>();
  wallet = new Map<string, number>();
  entries: Record<string, unknown>[] = [];
  updates: Array<{ table: unknown; condition: SQL }> = [];
  locks = new Map<string, { owner: symbol; done: ReturnType<typeof gate> }>();
  beforeUpdate: (() => Promise<void>) | undefined;
  afterUpdate: (() => Promise<void>) | undefined;
  failWallet = false;

  constructor(rows: Batch[]) {
    for (const row of rows) {
      this.batches.set(row.id, row);
      this.wallet.set(
        row.userId,
        numeric(
          (this.wallet.get(row.userId) ?? 0) +
            (row.status === "active" ? row.remaining : 0)
        )
      );
    }
    database.select.mockImplementation(() => ({
      from: (table: unknown) => ({
        where: async (condition: SQL) => {
          if (table !== creditsBatch) throw new Error("意外的扫描表");
          return [...this.batches.values()]
            .filter((row) => matches(row, condition))
            .map((row) => ({ id: row.id }));
        },
      }),
    }));
    database.update.mockImplementation((table: unknown) => this.update(table));
    database.transaction.mockImplementation(
      async (run: (tx: unknown) => Promise<unknown>) => {
        const tx = this.newTransaction();
        try {
          const result = await run({
            update: (table: unknown) => this.update(table, tx),
            insert: (table: unknown) => ({
              values: async (values: Record<string, unknown>) => {
                if (table !== creditsTransaction)
                  throw new Error("意外的插入表");
                tx.entries.push(values);
              },
            }),
            transaction: () => {
              throw new Error("禁止嵌套事务");
            },
          });
          this.commit(tx);
          return result;
        } finally {
          this.unlock(tx);
        }
      }
    );
  }

  /** 每个顶层事务独占写集。 */
  newTransaction(): Transaction {
    return {
      owner: Symbol("transaction"),
      batches: new Map(),
      wallet: new Map(),
      entries: [],
    };
  }

  /** 行锁等待后重新读取已提交版本；模拟 PostgreSQL UPDATE 的谓词复查。 */
  async lock(id: string, tx: Transaction) {
    while (this.locks.has(id) && this.locks.get(id)?.owner !== tx.owner)
      await this.locks.get(id)?.done.promise;
    if (!this.locks.has(id))
      this.locks.set(id, { owner: tx.owner, done: gate() });
  }

  /** 仅发布已成功完成的写集，钱包使用加法以保留其他事务的增减。 */
  commit(tx: Transaction) {
    for (const [id, row] of tx.batches) this.batches.set(id, row);
    for (const [userId, delta] of tx.wallet)
      this.wallet.set(userId, numeric((this.wallet.get(userId) ?? 0) + delta));
    this.entries.push(...tx.entries);
  }

  /** 成功和失败都释放锁，失败写集直接丢弃。 */
  unlock(tx: Transaction) {
    for (const [id, lock] of this.locks) {
      if (lock.owner !== tx.owner) continue;
      this.locks.delete(id);
      lock.done.release();
    }
  }

  /** 竞争消费/退款/hold：拿同一批次锁，返回实际能否提交。 */
  async compete(id: string, values: Partial<Batch>, walletDelta = 0) {
    const tx = this.newTransaction();
    try {
      await this.lock(id, tx);
      const row = this.batches.get(id);
      if (row?.status !== "active") return false;
      tx.batches.set(id, { ...row, ...values });
      tx.wallet.set(row.userId, walletDelta);
      this.commit(tx);
      return true;
    } finally {
      this.unlock(tx);
    }
  }

  /** 只执行本测试所需的真实 SET 表达式，未知表/字段报错。 */
  update(table: unknown, transaction?: Transaction) {
    return {
      set: (values: Record<string, unknown>) => ({
        where: (condition: SQL) =>
          query(async () => {
            this.updates.push({ table, condition });
            if (table === creditsBalance) {
              if (!transaction) throw new Error("钱包必须位于事务内");
              if (this.failWallet) throw new Error("wallet update failed");
              const userId = dialect.sqlToQuery(condition).params[0];
              const amount = dialect.sqlToQuery(values.balance as SQL)
                .params[0];
              if (typeof userId !== "string" || typeof amount !== "number")
                throw new Error("意外的钱包表达式");
              transaction.wallet.set(userId, -amount);
              return [];
            }
            if (table !== creditsBatch) throw new Error("意外的更新表");
            const hook =
              values.status === "expired" ? this.beforeUpdate : undefined;
            if (hook) {
              this.beforeUpdate = undefined;
              await hook();
            }
            const tx = transaction ?? this.newTransaction();
            const rows: Batch[] = [];
            try {
              for (const candidate of this.batches.values()) {
                if (!matches(candidate, condition)) continue;
                await this.lock(candidate.id, tx);
                const current = this.batches.get(candidate.id);
                if (!current || !matches(current, condition)) continue;
                const row = { ...current };
                if (typeof values.status === "string")
                  row.status = values.status;
                if (values.expiresAt instanceof Date)
                  row.expiresAt = values.expiresAt;
                else if (values.expiresAt) {
                  const days = dialect.sqlToQuery(values.expiresAt as SQL)
                    .params[0];
                  if (typeof days !== "number")
                    throw new Error("意外的有效期表达式");
                  row.expiresAt = new Date(
                    row.issuedAt.getTime() + days * 86_400_000
                  );
                }
                tx.batches.set(row.id, row);
                rows.push(row);
              }
              const after =
                values.status === "expired" ? this.afterUpdate : undefined;
              if (after) {
                this.afterUpdate = undefined;
                await after();
              }
              if (!transaction) this.commit(tx);
              return rows;
            } finally {
              if (!transaction) this.unlock(tx);
            }
          }),
      }),
    };
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());

describe("R13 过期提交条件与真实余额", () => {
  it("续费在扫描后先提交，过期任务不能作废已延长的批次", async () => {
    const ledger = new ExpiryLedger([batch("b", 10, { expiresAt: now })]);
    const renewalPause = pause();
    const originalUpdate = database.update.getMockImplementation();
    if (!originalUpdate) throw new Error("缺少更新实现");
    database.update.mockImplementation((table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: (condition: SQL) =>
          query(async () => {
            await renewalPause.run();
            return await originalUpdate(table)
              .set(values)
              .where(condition)
              .returning();
          }),
      }),
    }));
    vi.setSystemTime(new Date(now.getTime() - 1));
    const renewal = extendActiveSubscriptionBatchesExpiry({
      userId: "u1",
      subscriptionId: "s",
      newExpiresAt: future,
    });
    await renewalPause.reached;
    vi.setSystemTime(new Date(now.getTime() + 1));
    const expiryPause = pause();
    ledger.beforeUpdate = expiryPause.run;
    const expiry = processExpiredBatches({ userId: "u1" });
    await expiryPause.reached;
    renewalPause.release();
    expect(await renewal).toBe(1);
    expiryPause.release();
    expect(await expiry).toEqual([]);
    expect(ledger.batches.get("b")?.expiresAt).toEqual(future);
    expect(ledger.batches.get("b")?.status).toBe("active");
    expect(ledger.wallet.get("u1")).toBe(10);
    expect(ledger.entries).toEqual([]);
  });

  it("扫描后改为永不过期也不能再扣钱包", async () => {
    const ledger = new ExpiryLedger([batch("b", 10)]);
    const paused = pause();
    ledger.beforeUpdate = paused.run;
    const expiry = processExpiredBatches();
    await paused.reached;
    await ledger.compete("b", { expiresAt: null });
    paused.release();
    expect(await expiry).toEqual([]);
    expect(ledger.wallet.get("u1")).toBe(10);
    expect(ledger.entries).toEqual([]);
  });

  it.each([
    ["消费先提交", 3.33, -6.67, "active", 3.33],
    ["退款先提交", 12.34, 2.34, "active", 12.34],
    ["全部消费先提交", 0, -10, "consumed", 0],
    ["hold 先提交", 0, -10, "consumed", 0],
    ["零剩余先提交", 0, -10, "active", 0],
  ])("%s 后只按真实 remaining 记账", async (_name, remaining, delta, status, expected) => {
    const ledger = new ExpiryLedger([
      batch("b", 10),
      batch("valid-wallet", 20, { expiresAt: future }),
    ]);
    const paused = pause();
    ledger.beforeUpdate = paused.run;
    const expiry = processExpiredBatches();
    await paused.reached;
    await ledger.compete("b", { remaining, status }, delta);
    paused.release();
    const results = await expiry;
    expect(results).toEqual(
      expected ? [{ batchId: "b", userId: "u1", expiredAmount: expected }] : []
    );
    expect(ledger.entries.map((entry) => entry.amount)).toEqual(
      expected ? [expected] : []
    );
    expect(ledger.wallet.get("u1")).toBe(20);
    expect(ledger.batches.get("b")?.status).toBe(expected ? "expired" : status);
  });

  it("过期先持锁，等待中的 hold 不能恢复/再次扣除该批次", async () => {
    const ledger = new ExpiryLedger([batch("b", 10)]);
    const paused = pause();
    ledger.afterUpdate = paused.run;
    const expiry = processExpiredBatches();
    await paused.reached;
    const hold = ledger.compete("b", { remaining: 0, status: "consumed" }, -10);
    paused.release();
    expect(await expiry).toEqual([
      { batchId: "b", userId: "u1", expiredAmount: 10 },
    ]);
    expect(await hold).toBe(false);
    expect(ledger.wallet.get("u1")).toBe(0);
    expect(ledger.entries).toHaveLength(1);
  });

  it("并发扫描同一候选只记一笔，重复执行也不再扣余额", async () => {
    const ledger = new ExpiryLedger([batch("b", 0.29)]);
    const paused = pause();
    ledger.afterUpdate = paused.run;
    const first = processExpiredBatches();
    await paused.reached;
    const second = processExpiredBatches();
    paused.release();
    const results = (await Promise.all([first, second])).flat();
    expect(results).toEqual([
      { batchId: "b", userId: "u1", expiredAmount: 0.29 },
    ]);
    expect(await processExpiredBatches()).toEqual([]);
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.wallet.get("u1")).toBe(0);
  });

  it("钱包失败回滚批次和账本，重试恰好成功一次", async () => {
    const ledger = new ExpiryLedger([batch("b", 0.29)]);
    ledger.failWallet = true;
    await expect(processExpiredBatches()).rejects.toThrow(
      "wallet update failed"
    );
    expect(ledger.batches.get("b")?.status).toBe("active");
    expect(ledger.entries).toEqual([]);
    expect(ledger.wallet.get("u1")).toBe(0.29);
    expect(events).not.toHaveBeenCalled();
    ledger.failWallet = false;
    expect(await processExpiredBatches()).toEqual([
      { batchId: "b", userId: "u1", expiredAmount: 0.29 },
    ]);
    expect(ledger.entries).toHaveLength(1);
  });

  it("两位小数累计日志与账本一致，并限定用户和有效批次", async () => {
    const ledger = new ExpiryLedger([
      batch("b1", 0.1),
      batch("b2", 0.2),
      batch("other", 8, { userId: "u2" }),
      batch("future", 5, { expiresAt: future }),
      batch("forever", 7, { expiresAt: null }),
      batch("held", 0, { status: "consumed" }),
    ]);
    expect(await processExpiredBatches({ userId: "u1" })).toEqual([
      { batchId: "b1", userId: "u1", expiredAmount: 0.1 },
      { batchId: "b2", userId: "u1", expiredAmount: 0.2 },
    ]);
    expect(events).toHaveBeenCalledWith("credits.expired", {
      count: 2,
      totalExpired: 0.3,
    });
    expect(ledger.entries.map((entry) => entry.amount)).toEqual([0.1, 0.2]);
    expect(ledger.wallet.get("u1")).toBe(12);
    expect(ledger.wallet.get("u2")).toBe(8);
  });
});

describe("R38 热查询复用 0050 部分索引条件", () => {
  it("注册奖励只修正 active 且 remaining > 0 的本人批次", async () => {
    const ledger = new ExpiryLedger([
      batch("zero", 0, { sourceType: "bonus", expiresAt: null }),
      batch("valid", 0.1, {
        sourceType: "bonus",
        expiresAt: null,
        issuedAt: now,
      }),
      batch("other", 0.1, {
        userId: "u2",
        sourceType: "bonus",
        expiresAt: null,
      }),
    ]);
    await ensureRegistrationBonusExpiry("u1");
    expect(ledger.batches.get("zero")?.expiresAt).toBeNull();
    expect(ledger.batches.get("valid")?.expiresAt).toEqual(
      new Date(now.getTime() + 7 * 86_400_000)
    );
    expect(ledger.batches.get("other")?.expiresAt).toBeNull();
    const condition = ledger.updates[0]?.condition;
    if (!condition) throw new Error("未执行注册奖励条件更新");
    expect(dialect.sqlToQuery(condition).sql).toContain('"remaining" >');
  });

  it("续费跳过零剩余/hold，不缩短或复活批次，重复顺延返回零", async () => {
    const ledger = new ExpiryLedger([
      batch("zero", 0, { expiresAt: future }),
      batch("held", 0, { expiresAt: future, status: "consumed" }),
      batch("valid", 0.1, { expiresAt: future }),
      batch("past"),
      batch("bonus", 0.1, { sourceType: "bonus", expiresAt: future }),
      batch("forever", 0.1, { expiresAt: null }),
    ]);
    const newExpiresAt = new Date("2026-12-25T12:00:00Z");
    const request = { userId: "u1", subscriptionId: "s", newExpiresAt };
    expect(await extendActiveSubscriptionBatchesExpiry(request)).toBe(1);
    expect(await extendActiveSubscriptionBatchesExpiry(request)).toBe(0);
    expect(ledger.batches.get("zero")?.expiresAt).toEqual(future);
    expect(ledger.batches.get("held")?.expiresAt).toEqual(future);
    expect(ledger.batches.get("valid")?.expiresAt).toEqual(newExpiresAt);
    const condition = ledger.updates[0]?.condition;
    if (!condition) throw new Error("未执行续费条件更新");
    expect(dialect.sqlToQuery(condition).sql).toContain('"remaining" >');
  });
});
