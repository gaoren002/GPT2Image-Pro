/**
 * 积分核心行为回归：用内存账本复现 FIFO 小数和退款/消费的事务交错。
 * mock 仅实现本文件用到的 PostgreSQL 行锁、条件更新与两位 numeric 行为，
 * 不替代真实数据库的事务隔离验收。
 */

import {
  creditsBalance,
  creditsBatch,
  creditsTransaction,
} from "@repo/database/schema";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  select: vi.fn(),
  update: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@repo/database", () => ({ db: database }));
vi.mock("../system-settings", () => ({
  getRuntimeSettingNumber: vi.fn(
    async (_key: string, fallback: number) => fallback
  ),
}));
vi.mock("../logger/index", () => ({ logEvent: vi.fn() }));

import {
  consumeCredits,
  ensureRegistrationBonusExpiry,
  grantCredits,
} from "./core";

/** 创建一次性调度门，等待方与释放方均不依赖定时器。 */
function createGate() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Batch = {
  id: string;
  amount: number;
  remaining: number;
  status: string;
  expiresAt: Date | null;
};

/** 按 PostgreSQL numeric(18, 2) 存储两位小数。 */
function numeric(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** 延迟执行查询，兼容 Drizzle 查询构建器的 await/returning/for 链。 */
function query(
  read: (locked: boolean, condition?: SQL) => Promise<Record<string, unknown>[]>
) {
  let locked = false;
  let condition: SQL | undefined;
  const result = {
    where: (nextCondition: SQL | undefined) => {
      condition = nextCondition;
      return result;
    },
    orderBy: (..._ordering: unknown[]) => result,
    limit: (_limit: number) => result,
    for: (_mode: string) => {
      locked = true;
      return result;
    },
    returning: (_selection?: unknown) => result,
    // biome-ignore lint/suspicious/noThenProperty: Drizzle 查询须在 await 时才执行，供行锁交错调度使用。
    then: <TResult1 = Record<string, unknown>[], TResult2 = never>(
      fulfilled?:
        | ((
            rows: Record<string, unknown>[]
          ) => TResult1 | PromiseLike<TResult1>)
        | null,
      rejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
    ) => read(locked, condition).then(fulfilled, rejected),
  };
  return result;
}

/**
 * 创建受控事务账本。行锁持有到事务回调结束；消费条件在获得锁后按新行重查。
 * pauseRefund 开启时，在退款读池后启动消费：无锁则消费先提交，有锁则消费等待。
 */
function createLedger(
  amounts: number[],
  pauseRefund = false,
  expiresAt: Date | null = null
) {
  const batches: Batch[] = amounts.map((amount, index) => ({
    id: `batch-${index}`,
    amount,
    remaining: amount,
    status: "active",
    expiresAt,
  }));
  const wallet = {
    balance: numeric(amounts.reduce((total, amount) => total + amount, 0)),
    status: "active",
  };
  const transactions: Record<string, unknown>[] = [];
  const refundSelected = createGate();
  const resumeRefund = createGate();
  const consumerFinishedOrBlocked = createGate();
  const holders = new Map<string, symbol>();
  const releases = new Map<string, ReturnType<typeof createGate>>();
  const dialect = new PgDialect();

  /** 从 SQL 算术表达式取绑定金额，保留生产代码的实际计算结果。 */
  const sqlAmount = (value: unknown) => {
    const compiled = dialect.sqlToQuery(value as SQL);
    const amount = compiled.params.find((param) => typeof param === "number");
    if (typeof amount !== "number") throw new Error("缺少 SQL 金额参数");
    return amount;
  };

  database.select.mockImplementation(() => ({
    // 这些测试没有过期批次；processExpiredBatches 在进入扣费事务前空返回。
    from: () => query(async () => []),
  }));
  database.transaction.mockImplementation(
    async (run: (tx: unknown) => Promise<unknown>) => {
      const owner = Symbol("transaction");
      let consuming = false;

      /** 模拟 PostgreSQL 互斥行锁；同一事务重复锁行可重入。 */
      const acquire = async (id: string) => {
        while (holders.has(id) && holders.get(id) !== owner) {
          if (consuming) consumerFinishedOrBlocked.resolve();
          await releases.get(id)?.promise;
        }
        if (!holders.has(id)) {
          holders.set(id, owner);
          releases.set(id, createGate());
        }
      };

      const tx = {
        select: (selection?: unknown) => ({
          from: (table: unknown) =>
            query(async (locked, condition) => {
              if (table === creditsBalance) return [{ ...wallet }];
              if (table !== creditsBatch) throw new Error("意外的查询表");
              const checksExpiry =
                condition &&
                dialect.sqlToQuery(condition).sql.includes('"expires_at"');
              const batch = batches.find(
                (candidate) =>
                  candidate.status === "active" &&
                  candidate.remaining > 0 &&
                  (!checksExpiry ||
                    !candidate.expiresAt ||
                    candidate.expiresAt > new Date())
              );
              if (!batch) return [];
              if (locked) await acquire(batch.id);
              // FOR UPDATE 等待结束后，PostgreSQL 会重查 WHERE，不回放已消费的行。
              if (batch.status !== "active" || batch.remaining <= 0) return [];
              const row = { ...batch };
              if (selection && pauseRefund) {
                refundSelected.resolve();
                await resumeRefund.promise;
              }
              return [row];
            }),
        }),
        update: (table: unknown) => ({
          set: (values: Record<string, unknown>) => ({
            where: (condition: SQL) =>
              query(async () => {
                if (table === creditsBalance) {
                  const amount = sqlAmount(values.balance);
                  wallet.balance = numeric(
                    wallet.balance + (consuming ? -amount : amount)
                  );
                  return [{ newBalance: wallet.balance }];
                }
                if (table !== creditsBatch) throw new Error("意外的更新表");
                const id = dialect
                  .sqlToQuery(condition)
                  .params.find((param) => typeof param === "string");
                const batch = batches.find((candidate) => candidate.id === id);
                if (!batch) return [];
                consuming = values.amount === undefined;
                await acquire(batch.id);
                const amount = sqlAmount(values.remaining);
                if (consuming) {
                  if (batch.status !== "active" || batch.remaining < amount)
                    return [];
                  batch.remaining = numeric(batch.remaining - amount);
                  batch.status = batch.remaining <= 0 ? "consumed" : "active";
                } else {
                  batch.amount = numeric(batch.amount + amount);
                  batch.remaining = numeric(batch.remaining + amount);
                }
                return [{ id: batch.id }];
              }),
          }),
        }),
        insert: (table: unknown) => ({
          values: (values: Record<string, unknown>) =>
            query(async () => {
              if (table === creditsTransaction) transactions.push(values);
              else if (table === creditsBatch) batches.push(values as Batch);
              else throw new Error("意外的插入表");
              return [{ id: values.id }];
            }),
        }),
      };

      try {
        return await run(tx);
      } finally {
        for (const [id, holder] of holders) {
          if (holder !== owner) continue;
          holders.delete(id);
          releases.get(id)?.resolve();
          releases.delete(id);
        }
        if (consuming) consumerFinishedOrBlocked.resolve();
      }
    }
  );

  return {
    batches,
    wallet,
    transactions,
    refundSelected,
    resumeRefund,
    consumerFinishedOrBlocked,
  };
}

describe("积分批次与余额一致性", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("恰好消费多个小数批次时不会因浮点余数误报余额不足", async () => {
    const ledger = createLedger([0.1, 0.1, 0.1, 0.1]);
    const result = await consumeCredits({
      userId: "u1",
      amount: 0.4,
      serviceName: "test",
    });

    expect(result.consumedAmount).toBe(0.4);
    expect(result.remainingBalance).toBe(0);
    expect(result.consumedBatches).toHaveLength(4);
    expect(ledger.batches.every((batch) => batch.remaining === 0)).toBe(true);
    expect(ledger.transactions).toHaveLength(1);
  });

  it("退款与消费交错时，退款仍留在可消费批次中", async () => {
    const ledger = createLedger([0.4], true);
    const refund = grantCredits({
      userId: "u1",
      amount: 0.2,
      sourceType: "refund",
      debitAccount: "SYSTEM:generation_refund",
      transactionType: "refund",
      sourceRef: "generation-1:refund",
      expiresAt: null,
    });
    await ledger.refundSelected.promise;

    const consumption = consumeCredits({
      userId: "u1",
      amount: 0.4,
      serviceName: "test",
    });
    await ledger.consumerFinishedOrBlocked.promise;
    ledger.resumeRefund.resolve();
    await Promise.all([refund, consumption]);

    const spendable = numeric(
      ledger.batches.reduce(
        (total, batch) =>
          total + (batch.status === "active" ? batch.remaining : 0),
        0
      )
    );
    expect(ledger.wallet.balance).toBe(0.2);
    expect(spendable).toBe(ledger.wallet.balance);
    expect(ledger.transactions).toHaveLength(2);
  });

  it("新退款不会并入尚未清理的过期池", async () => {
    const ledger = createLedger(
      [0.4],
      false,
      new Date("2020-01-01T00:00:00.000Z")
    );
    const result = await grantCredits({
      userId: "u1",
      amount: 0.2,
      sourceType: "refund",
      debitAccount: "SYSTEM:generation_refund",
      transactionType: "refund",
      sourceRef: "generation-2:refund",
      expiresAt: null,
    });

    expect(result.batchId).not.toBe("batch-0");
    expect(ledger.batches[0]?.remaining).toBe(0.4);
    expect(
      ledger.batches.find((batch) => batch.id === result.batchId)
    ).toMatchObject({
      status: "active",
      remaining: 0.2,
      expiresAt: null,
    });
  });

  it("修复本人注册奖励期限时，不作废其他用户的过期积分", async () => {
    const dialect = new PgDialect();
    const batches = [
      {
        id: "expired-u1",
        userId: "u1",
        amount: 5,
        remaining: 5,
        status: "active",
        expiresAt: new Date("2020-01-01"),
      },
      {
        id: "expired-u2",
        userId: "u2",
        amount: 5,
        remaining: 5,
        status: "active",
        expiresAt: new Date("2020-01-01"),
      },
    ];
    const balances = new Map([
      ["u1", 5],
      ["u2", 5],
    ]);
    const expiredUsers: string[] = [];
    database.update.mockImplementation(() => ({
      set: () => query(async () => [{ id: "registration-bonus-u1" }]),
    }));
    database.select.mockImplementation(() => ({
      from: () =>
        query(async (_locked, condition) => {
          const params = condition ? dialect.sqlToQuery(condition).params : [];
          const userId = params.find(
            (param) => param === "u1" || param === "u2"
          );
          return batches.filter(
            (batch) =>
              batch.status === "active" && (!userId || batch.userId === userId)
          );
        }),
    }));
    database.transaction.mockImplementation(
      async (run: (tx: unknown) => Promise<unknown>) =>
        run({
          update: (table: unknown) => ({
            set: () =>
              query(async (_locked, condition) => {
                const params = condition
                  ? dialect.sqlToQuery(condition).params
                  : [];
                if (table === creditsBatch) {
                  const batch = batches.find((candidate) =>
                    params.includes(candidate.id)
                  );
                  if (batch?.status !== "active") return [];
                  batch.status = "expired";
                  return [{ ...batch }];
                }
                const userId = params.find(
                  (param) => typeof param === "string" && balances.has(param)
                );
                if (typeof userId !== "string") throw new Error("缺少积分账户");
                balances.set(userId, 0);
                return [];
              }),
          }),
          insert: () => ({
            values: (values: { userId: string }) =>
              query(async () => {
                expiredUsers.push(values.userId);
                return [];
              }),
          }),
        })
    );

    await ensureRegistrationBonusExpiry("u1");

    expect(expiredUsers).toEqual(["u1"]);
    expect(balances.get("u1")).toBe(0);
    expect(balances.get("u2")).toBe(5);
    expect(batches[1]?.status).toBe("active");
  });
});
