/** R10：真实 Drizzle 构造 SQL/事务，受控驱动模拟提交、回滚和事务锁；不连接数据库。 */
import { drizzle, type NodePgClient } from "drizzle-orm/node-postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ database: {} as object }));
vi.mock("@repo/database", () => ({
  db: new Proxy(
    {},
    {
      get: (_target, key) => {
        const value: unknown = Reflect.get(runtime.database, key);
        return typeof value === "function"
          ? value.bind(runtime.database)
          : value;
      },
    }
  ),
}));
const settings = vi.hoisted(() => ({ read: vi.fn(async () => 0) }));
vi.mock("../system-settings", () => ({
  getRuntimeSettingNumber: settings.read,
}));
vi.mock("../logger/index", () => ({
  logEvent: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("../storage/providers", () => ({ getStorageProvider: vi.fn() }));

import { grantCredits } from "./core";
import {
  refundGenerationCredits,
  expireStalePendingGenerations,
} from "../generation-maintenance";

type Row = Record<string, unknown>;
type Query = { text: string; rowMode?: string };

/** 无定时器的可控调度门。 */
function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** 内存提交日志：所有 SQL 来自真实 Drizzle，未知 SQL 必须失败，不能默默返回空行。 */
class ControlledLedger {
  rows: Row[] = [];
  generations: Row[] = [];
  keys = new Map<string, Row>();
  wallet = 100;
  pool = 100;
  queries: Array<{ client: number; text: string; values: unknown[] }> = [];
  held = new Map<string, { owner: number; done: ReturnType<typeof gate> }>();
  nextClient = 0;
  inTransactions = 0;
  failWalletUpdate = false;

  /** 使用独立驱动会话运行真实 Drizzle transaction，禁止嵌套。 */
  database() {
    const global = drizzle(this.client(0) as unknown as NodePgClient);
    return new Proxy(global, {
      get: (target, key) => {
        if (key === "transaction")
          return async (
            run: Parameters<typeof global.transaction>[0],
            config?: Parameters<typeof global.transaction>[1]
          ) => {
            const adapter = drizzle(
              this.client(++this.nextClient) as unknown as NodePgClient
            );
            return adapter.transaction(run, config);
          };
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  /** 预置权威消费/退款流水，调用方 metadata 不参与这部分数据。 */
  debit(amount: number, keyId?: string, generationId = "g1", userId = "u1") {
    this.rows.push({
      id: `debit-${this.rows.length}`,
      user_id: userId,
      type: "consumption",
      amount,
      source_ref: `${generationId}:charge-${this.rows.length}`,
      metadata: { generationId, ...(keyId ? { externalApiKeyId: keyId } : {}) },
    });
  }

  /** 模拟 PostgreSQL 两位 numeric。 */
  numeric(value: number) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  /** 列投影由 Drizzle 生成的 SELECT/RETURNING 决定，保留驱动的 array rowMode 契约。 */
  response(text: string, config: Query, rows: Row[], values: unknown[]) {
    const projection =
      /^select (.*?) from /i.exec(text)?.[1] ??
      / returning (.*)$/i.exec(text)?.[1];
    if (config.rowMode !== "array" || !projection)
      return { rows, rowCount: rows.length };
    const columns = projection.split(", ").map((part) => {
      const field = /"([a-z_]+)"$/.exec(part)?.[1];
      if (!field)
        throw new Error(
          `Unsupported projection: ${part}; params=${values.length}`
        );
      return field;
    });
    return {
      rows: rows.map((row) => columns.map((field) => row[field] ?? null)),
      rowCount: rows.length,
    };
  }

  /** 每个会话的写入仅在 COMMIT 时发布，ROLLBACK 完整丢弃；锁持有到事务结束。 */
  client(id: number) {
    let active = false;
    let walletDelta = 0;
    let poolDelta = 0;
    const added: Row[] = [];
    const keyChanges = new Map<string, number>();
    const releaseLocks = () => {
      for (const [key, lock] of this.held)
        if (lock.owner === id) {
          this.held.delete(key);
          lock.done.release();
        }
    };
    const lock = async (key: string) => {
      if (!active) throw new Error("Lock outside transaction");
      while (this.held.has(key) && this.held.get(key)?.owner !== id)
        await this.held.get(key)?.done.promise;
      if (!this.held.has(key)) this.held.set(key, { owner: id, done: gate() });
    };
    return {
      query: async (config: Query, values: unknown[] = []) => {
        const text = config.text;
        this.queries.push({ client: id, text, values });
        if (text.startsWith("begin")) {
          if (active) throw new Error("Nested transaction");
          active = true;
          this.inTransactions += 1;
          return { rows: [] };
        }
        if (text === "commit" || text === "rollback") {
          if (!active) throw new Error("No transaction");
          if (text === "commit") {
            this.rows.push(...added);
            this.wallet = this.numeric(this.wallet + walletDelta);
            this.pool = this.numeric(this.pool + poolDelta);
            for (const [key, delta] of keyChanges) {
              const row = this.keys.get(key);
              if (row)
                row.credits_used = this.numeric(
                  Number(row.credits_used) + delta
                );
            }
          }
          active = false;
          this.inTransactions -= 1;
          releaseLocks();
          return { rows: [] };
        }
        if (text.includes("pg_advisory_xact_lock")) {
          await lock(`generation:${String(values[0])}`);
          return { rows: [] };
        }
        if (text.startsWith("select ") && text.includes('from "generation"')) {
          return this.response(
            text,
            config,
            this.generations.filter((row) => row.status === "pending"),
            values
          );
        }
        if (text.startsWith('update "generation"')) {
          const where = text.split(" where ")[1] ?? "";
          const idParameter = /"id" = \$(\d+)/.exec(where)?.[1];
          const row = this.generations.find(
            (item) => item.id === values[Number(idParameter) - 1]
          );
          if (!row || (where.includes('"status"') && row.status !== "pending"))
            return this.response(text, config, [], values);
          for (const field of ["status", "credits_consumed"]) {
            const parameter = new RegExp(`"${field}" = \\$(\\d+)`).exec(
              text
            )?.[1];
            if (parameter)
              row[field] =
                field === "credits_consumed"
                  ? Number(values[Number(parameter) - 1])
                  : values[Number(parameter) - 1];
          }
          const metadata = values.find(
            (value) =>
              typeof value === "string" &&
              value.startsWith("{") &&
              value.includes("timeout")
          );
          if (typeof metadata === "string")
            row.metadata = {
              ...(row.metadata as Row),
              ...JSON.parse(metadata),
            };
          return this.response(text, config, [row], values);
        }
        if (
          text.startsWith("select ") &&
          text.includes('from "credits_transaction"')
        ) {
          const userId = values[0];
          let rows = this.rows.filter((row) => row.user_id === userId);
          if (text.includes("->> 'generationId'")) {
            const generationParameter = /->> 'generationId' = \$(\d+)/.exec(
              text
            )?.[1];
            const generationId = values[Number(generationParameter) - 1];
            const sourceRef = values.find(
              (value) => typeof value === "string" && value.includes(":")
            );
            rows = rows.filter(
              (row) =>
                (row.metadata as Row)?.generationId === generationId ||
                (row.type === "refund" && row.source_ref === sourceRef)
            );
          } else {
            rows = rows.filter(
              (row) => row.type === values[1] && row.source_ref === values[2]
            );
          }
          return this.response(text, config, rows, values);
        }
        if (
          text.startsWith("select ") &&
          text.includes('from "credits_balance"')
        ) {
          return this.response(
            text,
            config,
            [
              {
                id: "wallet",
                user_id: "u1",
                balance: this.wallet,
                total_earned: 100,
                total_spent: 0,
                status: "active",
                created_at: "2026-10-24",
                updated_at: "2026-10-24",
              },
            ],
            values
          );
        }
        if (
          text.startsWith("select ") &&
          text.includes('from "credits_batch"')
        ) {
          if (text.endsWith("for update")) await lock("pool:u1");
          return this.response(text, config, [{ id: "refund-pool" }], values);
        }
        if (
          text.startsWith("select ") &&
          text.includes('from "external_api_key"')
        ) {
          const keyId = String(values[0]);
          if (text.endsWith("for update")) await lock(`key:${keyId}`);
          const row = this.keys.get(keyId);
          return this.response(
            text,
            config,
            row && row.user_id === values[1] ? [row] : [],
            values
          );
        }
        if (text.startsWith('insert into "credits_transaction"')) {
          const match = /\((.*?)\) values \((.*?)\)/.exec(text);
          if (!match?.[1] || !match[2])
            throw new Error("Unrecognized transaction insert");
          const columns = match[1]
            .split(", ")
            .map((column) => column.replaceAll('"', ""));
          const fields = match[2].split(", ");
          const row = Object.fromEntries(
            columns.map((column, index) => {
              const token = fields[index] ?? "default";
              const value = token.startsWith("$")
                ? values[Number(token.slice(1)) - 1]
                : null;
              return [
                column,
                column === "metadata" && typeof value === "string"
                  ? JSON.parse(value)
                  : value,
              ];
            })
          );
          if (
            this.rows.some(
              (existing) =>
                existing.user_id === row.user_id &&
                existing.type === row.type &&
                existing.source_ref === row.source_ref
            )
          )
            throw new Error("unique constraint violation");
          added.push(row);
          return this.response(text, config, [row], values);
        }
        if (text.startsWith('update "credits_batch"')) {
          poolDelta += Number(values[0]);
          return { rows: [] };
        }
        if (text.startsWith('update "external_api_key"')) {
          const parameter = /"id" = \$(\d+)/.exec(text)?.[1];
          const keyId = String(values[Number(parameter) - 1]);
          keyChanges.set(
            keyId,
            (keyChanges.get(keyId) ?? 0) - Number(values[0])
          );
          return { rows: [] };
        }
        if (text.startsWith('update "credits_balance"')) {
          if (this.failWalletUpdate)
            throw new Error("Injected wallet update failure");
          walletDelta += Number(values[0]);
          return { rows: [] };
        }
        throw new Error(`Unhandled SQL: ${text}`);
      },
    };
  }
}

const request = {
  generationId: "g1",
  userId: "u1",
  amount: 10,
  sourceRef: "g1:refund",
  description: "test",
};
let ledger: ControlledLedger;
beforeEach(() => {
  vi.clearAllMocks();
  ledger = new ControlledLedger();
  runtime.database = ledger.database();
  settings.read.mockImplementation(async () => {
    expect(ledger.inTransactions).toBe(0);
    return 0;
  });
});

describe("generation 退款净扣费封顶", () => {
  it("别处已退 8 后本次只退 2，回放时仍报告权威剩余净额 0", async () => {
    ledger.debit(10, "key-origin");
    ledger.rows.push({
      user_id: "u1",
      type: "refund",
      amount: 8,
      source_ref: "g1:other",
      metadata: { generationId: "g1" },
    });
    ledger.keys.set("key-origin", {
      id: "key-origin",
      user_id: "u1",
      credits_used: 12,
    });
    ledger.keys.set("key-new", {
      id: "key-new",
      user_id: "u1",
      credits_used: 9,
    });
    expect(
      await refundGenerationCredits({
        ...request,
        metadata: { externalApiKeyId: "key-new" },
      })
    ).toMatchObject({ refunded: true, amount: 2, remainingDebited: 0 });
    expect(await refundGenerationCredits(request)).toMatchObject({
      refunded: false,
      amount: 0,
      remainingDebited: 0,
    });
    expect(ledger.keys.get("key-origin")?.credits_used).toBe(10);
    expect(ledger.keys.get("key-new")?.credits_used).toBe(9);
  });
  it("部分退款同 sourceRef 重放返回仍未退掉的净额", async () => {
    ledger.debit(10);
    expect(
      await refundGenerationCredits({ ...request, amount: 3 })
    ).toMatchObject({ amount: 3, remainingDebited: 7 });
    expect(
      await refundGenerationCredits({ ...request, amount: 3 })
    ).toMatchObject({ amount: 0, remainingDebited: 7 });
  });
  it("零请求只核对净额，不发钱、不退 Key、不创建退款流水", async () => {
    ledger.debit(10, "key-origin");
    expect(
      await refundGenerationCredits({ ...request, amount: 0 })
    ).toMatchObject({ refunded: false, amount: 0, remainingDebited: 10 });
    expect(ledger.wallet).toBe(100);
    expect(ledger.rows.filter((row) => row.type === "refund")).toHaveLength(0);
    expect(
      ledger.queries.some((query) =>
        query.text.startsWith('update "external_api_key"')
      )
    ).toBe(false);
  });
  it("超时维护即使拟退零，也核对其他路径退款后的净额", async () => {
    ledger.debit(10);
    ledger.rows.push({
      user_id: "u1",
      type: "refund",
      amount: 8,
      source_ref: "g1:other",
      metadata: { generationId: "g1" },
    });
    ledger.generations.push({
      id: "g1",
      user_id: "u1",
      prompt: "circle",
      status: "pending",
      credits_consumed: 10,
      metadata: { creditCost: { moderationOnlyCredits: 10 } },
      created_at: "2020-01-01 00:00:00",
    });
    expect(await expireStalePendingGenerations()).toMatchObject([
      { creditsRefunded: 0, remainingDebited: 2 },
    ]);
    expect(ledger.generations[0]?.credits_consumed).toBe(2);
    expect(ledger.wallet).toBe(100);
  });
  it.each([
    8, 10,
  ])("超时维护在既有退款 %s 后按本次实际退额记录明细及汇总，generation 对齐净额", async (previousRefund) => {
    ledger.debit(10);
    ledger.rows.push({
      user_id: "u1",
      type: "refund",
      amount: previousRefund,
      source_ref: "g1:other",
      metadata: { generationId: "g1" },
    });
    ledger.generations.push({
      id: "g1",
      user_id: "u1",
      prompt: "circle",
      status: "pending",
      credits_consumed: 10,
      metadata: { creditCost: { moderationOnlyCredits: 0 } },
      created_at: "2020-01-01 00:00:00",
    });
    const results = await expireStalePendingGenerations();
    expect(results).toMatchObject([
      {
        creditsRefunded: 10 - previousRefund,
        refundGranted: previousRefund < 10,
      },
    ]);
    expect(ledger.generations[0]?.credits_consumed).toBe(0);
    expect(ledger.generations[0]?.metadata).toMatchObject({
      timeoutRefund: {
        creditsRefunded: 10 - previousRefund,
        remainingDebited: 0,
      },
    });
  });
  it("没有真实扣费时零退款，不修改钱包或批次", async () => {
    expect(await refundGenerationCredits(request)).toMatchObject({
      refunded: false,
      amount: 0,
    });
    expect(ledger.wallet).toBe(100);
    expect(ledger.rows).toHaveLength(0);
  });
  it("按多笔消费减去既有退款后的净额封顶", async () => {
    ledger.debit(4);
    ledger.debit(3);
    ledger.rows.push({
      user_id: "u1",
      type: "refund",
      amount: 2,
      source_ref: "g1:previous",
      metadata: { generationId: "g1" },
    });
    expect(await refundGenerationCredits(request)).toMatchObject({
      refunded: true,
      amount: 5,
    });
    expect(ledger.wallet).toBe(105);
    expect(ledger.pool).toBe(105);
  });
  it("同 sourceRef 重放报告实际零退款", async () => {
    ledger.debit(10);
    await refundGenerationCredits({ ...request, amount: 3 });
    expect(
      await refundGenerationCredits({ ...request, amount: 3 })
    ).toMatchObject({ refunded: false, amount: 0 });
    expect(ledger.wallet).toBe(103);
  });
  it("不同 sourceRef 并发总退款不超过净扣费", async () => {
    ledger.debit(10);
    const results = await Promise.all(
      ["failure", "timeout", "retry"].map((suffix) =>
        refundGenerationCredits({
          ...request,
          amount: 7,
          sourceRef: `g1:${suffix}`,
        })
      )
    );
    expect(results.reduce((sum, result) => sum + result.amount, 0)).toBe(10);
    expect(ledger.wallet).toBe(110);
    expect(
      ledger.queries.filter((query) =>
        query.text.includes("pg_advisory_xact_lock")
      )
    ).toHaveLength(3);
    expect(
      ledger.queries
        .filter((query) => query.text.startsWith("begin"))
        .every((query) => query.text.includes("isolation level read committed"))
    ).toBe(true);
    expect(ledger.rows.filter((row) => row.type === "refund")).toHaveLength(2);
  });
  it("不同用户和不同 generation 的消费不能退款", async () => {
    ledger.debit(50, undefined, "g2");
    ledger.debit(50, undefined, "g1", "u2");
    expect(await refundGenerationCredits(request)).toMatchObject({
      refunded: false,
      amount: 0,
    });
  });
  it("调用方 metadata 不能覆盖 generation 或 Key 归属", async () => {
    ledger.debit(10, "key-real");
    ledger.keys.set("key-real", {
      id: "key-real",
      user_id: "u1",
      credits_used: 10,
    });
    ledger.keys.set("key-other", {
      id: "key-other",
      user_id: "u1",
      credits_used: 99,
    });
    await refundGenerationCredits({
      ...request,
      metadata: {
        generationId: "g2",
        externalApiKeyId: "key-other",
        generationRefund: { fake: true },
      },
    });
    expect(ledger.keys.get("key-real")?.credits_used).toBe(0);
    expect(ledger.keys.get("key-other")?.credits_used).toBe(99);
    const refund = ledger.rows.find((row) => row.type === "refund");
    expect(refund?.metadata).toMatchObject({
      generationId: "g1",
      generationRefund: { version: 1 },
    });
    expect((refund?.metadata as Row).generationRefund).not.toHaveProperty(
      "fake"
    );
    expect(refund?.metadata).not.toHaveProperty("externalApiKeyId");
  });
  it("钱包、退款流水和可确认 Key 在同一事务提交，重复退款不再退 Key", async () => {
    ledger.debit(10, "key-1");
    ledger.keys.set("key-1", { id: "key-1", user_id: "u1", credits_used: 20 });
    const first = await refundGenerationCredits({ ...request, amount: 6 });
    const second = await refundGenerationCredits({
      ...request,
      sourceRef: "g1:timeout",
    });
    expect([first.amount, second.amount]).toEqual([6, 4]);
    expect(ledger.keys.get("key-1")?.credits_used).toBe(10);
    expect(ledger.wallet).toBe(110);
    const updates = ledger.queries.filter((query) =>
      query.text.startsWith('update "external_api_key"')
    );
    expect(updates).toHaveLength(2);
    expect(updates.every((query) => query.client > 0)).toBe(true);
  });
  it("Key 退额后钱包失败必须整体回滚", async () => {
    ledger.debit(10, "key-1");
    ledger.keys.set("key-1", { id: "key-1", user_id: "u1", credits_used: 10 });
    ledger.failWalletUpdate = true;
    await expect(refundGenerationCredits(request)).rejects.toThrow();
    expect(ledger.keys.get("key-1")?.credits_used).toBe(10);
    expect(ledger.wallet).toBe(100);
    expect(ledger.pool).toBe(100);
    expect(ledger.rows.filter((row) => row.type === "refund")).toHaveLength(0);
    expect(
      ledger.queries.some((query) =>
        query.text.startsWith('update "external_api_key"')
      )
    ).toBe(true);
    expect(
      ledger.queries.some((query) =>
        query.text.startsWith('update "credits_balance"')
      )
    ).toBe(true);
    expect(ledger.queries.at(-1)?.text).toBe("rollback");
  });
  it("历史消费缺 Key 字段时仍按净额退钱包并留下未归属审计", async () => {
    ledger.debit(5);
    expect(await refundGenerationCredits(request)).toMatchObject({
      amount: 5,
      refunded: true,
    });
    const refund = ledger.rows.find((row) => row.type === "refund");
    expect(refund?.metadata).toMatchObject({
      generationRefund: { apiKeyUnattributedCredits: 5 },
    });
    expect(
      ledger.queries.some((query) =>
        query.text.startsWith('update "external_api_key"')
      )
    ).toBe(false);
  });
  it("Key 用户归属不符时不退他人额度", async () => {
    ledger.debit(5, "key-other");
    ledger.keys.set("key-other", {
      id: "key-other",
      user_id: "u2",
      credits_used: 99,
    });
    await refundGenerationCredits(request);
    expect(ledger.keys.get("key-other")?.credits_used).toBe(99);
    expect(
      ledger.rows.find((row) => row.type === "refund")?.metadata
    ).toMatchObject({ generationRefund: { apiKeyUnattributedCredits: 5 } });
  });
  it("小数消费汇总与剩余退款按两位 numeric 计算", async () => {
    ledger.debit(0.1);
    ledger.debit(0.2);
    expect(
      await refundGenerationCredits({ ...request, amount: 0.4 })
    ).toMatchObject({ amount: 0.3 });
  });
  it("普通管理员和支付 grant 不受 generation 封顶影响", async () => {
    const result = await grantCredits({
      userId: "u1",
      amount: 6,
      sourceType: "refund",
      transactionType: "refund",
      debitAccount: "SYSTEM:admin",
      sourceRef: "admin-refund",
    });
    expect(result.amount).toBe(6);
    expect(ledger.wallet).toBe(106);
    expect(
      ledger.queries.some((query) =>
        query.text.includes("pg_advisory_xact_lock")
      )
    ).toBe(false);
  });
  it("同 sourceRef 并发只发放一次", async () => {
    ledger.debit(10);
    const results = await Promise.all([
      refundGenerationCredits({ ...request, amount: 4 }),
      refundGenerationCredits({ ...request, amount: 4 }),
    ]);
    expect(results.map((result) => result.amount).sort()).toEqual([0, 4]);
    expect(ledger.wallet).toBe(104);
  });
  it("多 Key 消费按确定顺序退额，后续退款使用已记录分摊", async () => {
    ledger.debit(4, "key-a");
    ledger.debit(6, "key-b");
    ledger.keys.set("key-a", { id: "key-a", user_id: "u1", credits_used: 10 });
    ledger.keys.set("key-b", { id: "key-b", user_id: "u1", credits_used: 10 });
    await refundGenerationCredits({ ...request, amount: 7 });
    await refundGenerationCredits({ ...request, sourceRef: "g1:remaining" });
    expect(ledger.wallet).toBe(110);
    expect(ledger.keys.get("key-a")?.credits_used).toBe(6);
    expect(ledger.keys.get("key-b")?.credits_used).toBe(4);
  });
  it("历史退款没有 Key 分摊明细时不再重复退回那部分额度", async () => {
    ledger.debit(10, "key-a");
    ledger.keys.set("key-a", { id: "key-a", user_id: "u1", credits_used: 18 });
    ledger.rows.push({
      user_id: "u1",
      type: "refund",
      amount: 2,
      source_ref: "g1:old",
      metadata: { generationId: "g1" },
    });
    expect(await refundGenerationCredits(request)).toMatchObject({ amount: 8 });
    expect(ledger.keys.get("key-a")?.credits_used).toBe(10);
  });
  it("Key 当前用量不足时不产生负额度，未归属部分保留审计", async () => {
    ledger.debit(10, "key-a");
    ledger.keys.set("key-a", { id: "key-a", user_id: "u1", credits_used: 2 });
    await refundGenerationCredits(request);
    expect(ledger.keys.get("key-a")?.credits_used).toBe(0);
    expect(
      ledger.rows.find((row) => row.type === "refund")?.metadata
    ).toMatchObject({
      generationRefund: {
        apiKeyRefunds: [{ apiKeyId: "key-a", amount: 2 }],
        apiKeyUnattributedCredits: 8,
      },
    });
  });
  it("任务 ID 精确匹配，缺 generationId 的历史流水不能凭 sourceRef 猜测退款", async () => {
    ledger.debit(10, undefined, "g_1");
    ledger.debit(20, undefined, "gX1");
    ledger.rows.push({
      user_id: "u1",
      type: "consumption",
      amount: 50,
      source_ref: "g1:charge",
      metadata: {},
    });
    expect(
      await refundGenerationCredits({
        ...request,
        generationId: "g_1",
        sourceRef: "g_1:refund",
        amount: 30,
      })
    ).toMatchObject({ amount: 10 });
    expect(await refundGenerationCredits(request)).toMatchObject({ amount: 0 });
  });
  it("其他任务已占用同一退款幂等键时也零发放", async () => {
    ledger.debit(10);
    ledger.rows.push({
      user_id: "u1",
      type: "refund",
      amount: 2,
      source_ref: request.sourceRef,
      metadata: { generationId: "g2" },
    });
    expect(await refundGenerationCredits(request)).toMatchObject({
      amount: 0,
      refunded: false,
    });
    expect(ledger.wallet).toBe(100);
  });
  it("内部 context 不能误用于管理员或支付发放", async () => {
    await expect(
      grantCredits({
        userId: "u1",
        amount: 10,
        sourceType: "purchase",
        transactionType: "purchase",
        debitAccount: "SYSTEM:payment",
        sourceRef: "order",
        generationRefund: { generationId: "g1" },
      })
    ).rejects.toThrow(/generationRefund/);
    expect(ledger.queries).toHaveLength(0);
  });
});
