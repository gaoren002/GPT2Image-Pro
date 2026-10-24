/** Key capture：真实消费入口与真实 Drizzle 谓词，受控双会话提交/回滚，不访问真实数据库。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConsumptionDatabase,
  consumptionGate,
} from "./test-support/consumption-db";

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
vi.mock("../system-settings", () => ({
  getRuntimeSettingNumber: async () => 0,
}));
vi.mock("../logger/index", () => ({ logEvent: vi.fn() }));

import { consumeCredits } from "./core";

let ledger: ConsumptionDatabase;
const request = {
  userId: "u1",
  amount: 25,
  externalApiKeyId: "k1",
  serviceName: "editable_file_ppt",
  sourceRef: "file:task-1",
  metadata: { generationId: "file:task-1" },
};

beforeEach(() => {
  ledger = new ConsumptionDatabase();
  runtime.database = ledger.database();
});

/** 检查失败没有留下部分消费，包含已执行的批次 UPDATE 和流水 INSERT。 */
function expectUnchanged() {
  expect(ledger.wallets.get("u1")?.balance).toBe(1000);
  expect(ledger.batches.get("b1")?.remaining).toBe(1000);
  expect(ledger.keys.get("k1")?.credits_used).toBe(0);
  expect(ledger.entries).toHaveLength(0);
  expect(ledger.activeTransactions).toBe(0);
  expect(ledger.locks.size).toBe(0);
}

describe("同事务消费与 Key capture", () => {
  it("batch→key→wallet 顺序并核对真实 user/active/限额 SQL 谓词", async () => {
    await consumeCredits(request);
    expect(ledger.wallets.get("u1")?.balance).toBe(975);
    expect(ledger.batches.get("b1")?.remaining).toBe(975);
    expect(ledger.keys.get("k1")?.credits_used).toBe(25);
    const updates = ledger.queries.filter(({ text }) =>
      text.startsWith("update ")
    );
    expect(
      updates.map(({ text }) => /^update "([a-z_]+)"/.exec(text)?.[1])
    ).toEqual(["credits_batch", "external_api_key", "credits_balance"]);
    const capture = updates.find(({ text }) =>
      text.startsWith('update "external_api_key"')
    );
    expect(capture?.text).toContain('"user_id" =');
    expect(capture?.text).toContain('"is_active" =');
    expect(capture?.text).toContain('"credit_limit" is null');
    expect(capture?.text).toMatch(/"credit_limit" - .*"credits_used".*>=/);
    expect(capture?.values).toEqual(
      expect.arrayContaining(["k1", "u1", true, 25])
    );
    expect(ledger.queries.some(({ text }) => text.includes("savepoint"))).toBe(
      false
    );
  });

  it("显式参数覆盖伪造 metadata Key，R10 只认本次实际 capture 归属", async () => {
    const metadata = {
      generationId: "file:task-1",
      externalApiKeyId: "forged",
      custom: "kept",
    };
    await consumeCredits({ ...request, metadata });
    expect(ledger.entries[0]?.metadata).toMatchObject({
      generationId: "file:task-1",
      externalApiKeyId: "k1",
      custom: "kept",
    });
    expect(metadata.externalApiKeyId).toBe("forged");
  });

  it.each([
    0, 24,
  ])("Key 剩余额度 %s 不足时回滚已扣批次，不写钱包或消费流水", async (limit) => {
    const key = ledger.keys.get("k1");
    if (key) key.credit_limit = limit;
    await expect(consumeCredits(request)).rejects.toThrow(
      "API key quota exceeded"
    );
    expectUnchanged();
    expect(
      ledger.queries.some(({ text }) =>
        text.startsWith('update "credits_batch"')
      )
    ).toBe(true);
    expect(ledger.queries.some(({ text }) => text === "rollback")).toBe(true);
  });

  it.each([
    "inactive",
    "wrong-user",
    "missing",
  ])("%s Key 不能 capture，全部消费回滚", async (kind) => {
    const key = ledger.keys.get("k1");
    if (kind === "missing") ledger.keys.delete("k1");
    else if (key) {
      if (kind === "inactive") key.is_active = false;
      else key.user_id = "u2";
    }
    await expect(consumeCredits(request)).rejects.toThrow("API key");
    expect(ledger.wallets.get("u1")?.balance).toBe(1000);
    expect(ledger.batches.get("b1")?.remaining).toBe(1000);
    expect(ledger.entries).toHaveLength(0);
  });

  it("无限额 Key 仍记实际 creditsUsed", async () => {
    const key = ledger.keys.get("k1");
    if (key) key.credit_limit = null;
    await consumeCredits(request);
    expect(ledger.keys.get("k1")?.credits_used).toBe(25);
  });

  it("相同 sourceRef 回放即使 Key 已满额或禁用也不再次 capture", async () => {
    await consumeCredits(request);
    const key = ledger.keys.get("k1");
    if (key) {
      key.credit_limit = 25;
      key.is_active = false;
    }
    const firstQueries = ledger.queries.length;
    expect(await consumeCredits(request)).toMatchObject({
      alreadyConsumed: true,
      consumedAmount: 25,
    });
    expect(
      ledger.queries
        .slice(firstQueries)
        .some(({ text }) => text.startsWith('update "external_api_key"'))
    ).toBe(false);
    expect(ledger.keys.get("k1")?.credits_used).toBe(25);
    expect(ledger.wallets.get("u1")?.balance).toBe(975);
    expect(ledger.entries).toHaveLength(1);
  });

  it("并发独立任务竞争最后25额度只提交一笔，失败批次扣减回滚", async () => {
    const key = ledger.keys.get("k1");
    if (key) key.credit_limit = 25;
    const results = await Promise.allSettled([
      consumeCredits(request),
      consumeCredits({ ...request, sourceRef: "file:task-2" }),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1
    );
    expect(ledger.peakTransactions).toBe(2);
    expect(ledger.keys.get("k1")?.credits_used).toBe(25);
    expect(ledger.wallets.get("u1")?.balance).toBe(975);
    expect(ledger.batches.get("b1")?.remaining).toBe(975);
    expect(ledger.entries).toHaveLength(1);
  });

  it("并发同 sourceRef 唯一冲突回滚第二笔事务，不再 capture 并回放首次结果", async () => {
    const key = ledger.keys.get("k1");
    if (key) key.credit_limit = 25;
    const results = await Promise.all([
      consumeCredits(request),
      consumeCredits(request),
    ]);
    expect(
      results.filter(({ alreadyConsumed }) => alreadyConsumed)
    ).toHaveLength(1);
    expect(ledger.keys.get("k1")?.credits_used).toBe(25);
    expect(ledger.wallets.get("u1")?.balance).toBe(975);
    expect(ledger.batches.get("b1")?.remaining).toBe(975);
    expect(ledger.entries).toHaveLength(1);
    expect(
      ledger.queries.filter(({ text }) =>
        text.startsWith('update "external_api_key"')
      )
    ).toHaveLength(1);
  });

  it.each([
    "failWallet",
    "rejectWallet",
  ] as const)("Key 已更新后 %s 失败，Key/批次/流水/钱包共同回滚", async (failure) => {
    ledger[failure] = true;
    await expect(consumeCredits(request)).rejects.toThrow();
    expectUnchanged();
    expect(
      ledger.queries.some(({ text }) =>
        text.startsWith('update "external_api_key"')
      )
    ).toBe(true);
  });

  it("流水写入失败时整笔回滚，Key 与钱包不留消费", async () => {
    ledger.failInsert = true;
    await expect(consumeCredits(request)).rejects.toThrow();
    expectUnchanged();
  });

  it("等候 capture 前 Key 被禁用，UPDATE 复核新状态并回滚批次", async () => {
    const reached = consumptionGate();
    const resume = consumptionGate();
    ledger.beforeKeyUpdate = async () => {
      reached.release();
      await resume.promise;
    };
    const result = consumeCredits(request).then(
      () => null,
      (error: unknown) => error
    );
    await Promise.race([reached.promise, result]);
    const key = ledger.keys.get("k1");
    if (key) key.is_active = false;
    resume.release();
    expect(await result).toBeInstanceOf(Error);
    expectUnchanged();
  });

  it("未传可选参数保留旧 metadata 归属但不额外 capture，避免旧调用双扣", async () => {
    await consumeCredits({
      userId: request.userId,
      amount: request.amount,
      serviceName: request.serviceName,
      sourceRef: request.sourceRef,
      metadata: { externalApiKeyId: "legacy-reserved-key" },
    });
    expect(ledger.keys.get("k1")?.credits_used).toBe(0);
    expect(ledger.entries[0]?.metadata).toMatchObject({
      externalApiKeyId: "legacy-reserved-key",
    });
  });
});
