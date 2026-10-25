/** R11：真实入口及 SQL 驱动验证持久意图、重放和失败恢复；不连接数据库。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ControlledLedger } from "./credits/test-support/generation-refund-db";

const runtime = vi.hoisted(() => ({
  database: {} as object,
  logWarn: vi.fn(),
}));
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
vi.mock("./system-settings", () => ({
  getRuntimeSettingNumber: vi.fn(async () => 0),
}));
vi.mock("./logger", () => ({ logError: vi.fn(), logWarn: runtime.logWarn }));
vi.mock("./logger/index", () => ({
  logEvent: vi.fn(),
  logError: vi.fn(),
  logWarn: runtime.logWarn,
}));
vi.mock("./storage/providers", () => ({ getStorageProvider: vi.fn() }));

import {
  expireStalePendingGenerations,
  FAILED_GENERATION_RECOVERY_SINCE,
  recoverFailedGenerationRefunds,
  refundGenerationCredits,
} from "./generation-maintenance";
import {
  enqueueGenerationRefund,
  processGenerationRefundOutbox,
} from "./generation-refund-outbox";

let ledger: ControlledLedger;
const request = {
  generationId: "g1",
  userId: "u1",
  amount: 10,
  sourceRef: "g1:failure",
  description: "私密 prompt 和图片 URL",
  metadata: {
    prompt: "私密内容",
    imageUrl: "https://private/image",
    error: "secret",
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  ledger = new ControlledLedger();
  runtime.database = ledger.database();
});

describe("R11 持久退款", () => {
  it("退款失败意图仍持久，下一轮重启可恢复", async () => {
    ledger.debit(10, "key");
    ledger.keys.set("key", { id: "key", user_id: "u1", credits_used: 10 });
    ledger.failWalletUpdate = true;
    await expect(refundGenerationCredits(request)).rejects.toThrow();
    expect(ledger.wallet).toBe(100);
    expect(ledger.keys.get("key")?.credits_used).toBe(10);
    expect(ledger.outbox).toHaveLength(1);
    expect(ledger.outbox[0]?.state).toBe("pending");
    expect(JSON.stringify(ledger.outbox)).not.toMatch(
      /私密|private|secret|prompt|imageUrl/
    );
    ledger.failWalletUpdate = false;
    runtime.database = ledger.database();
    const result = await processGenerationRefundOutbox({
      now: new Date(Date.now() + 3600000),
    });
    expect(result).toMatchObject({ settled: 1, failed: 0 });
    expect(ledger.wallet).toBe(110);
    expect(ledger.keys.get("key")?.credits_used).toBe(0);
    expect(ledger.outbox[0]?.state).toBe("settled");
  });
  it("意图落盘后退出且尚未调用财务，worker 可接手", async () => {
    ledger.debit(10);
    await enqueueGenerationRefund(request);
    expect(ledger.wallet).toBe(100);
    runtime.database = ledger.database();
    await processGenerationRefundOutbox();
    expect(ledger.wallet).toBe(110);
    expect(ledger.outbox[0]?.state).toBe("settled");
  });
  it("同意图并发及不同 phase 不重复，目标净扣费保留 4", async () => {
    ledger.debit(10);
    await refundGenerationCredits({ ...request, amount: 3 });
    await Promise.all(
      [1, 2].map(() =>
        refundGenerationCredits({
          ...request,
          amount: 6,
          targetCredits: 4,
          sourceRef: "g1:timeout",
        })
      )
    );
    expect(ledger.wallet).toBe(106);
    expect(ledger.rows.filter((row) => row.type === "refund")).toHaveLength(2);
  });
  it("意图入库失败必须阻止退款执行", async () => {
    ledger.debit(10);
    ledger.failOutboxInsert = true;
    await expect(refundGenerationCredits(request)).rejects.toThrow();
    expect(ledger.wallet).toBe(100);
    expect(ledger.rows.filter((row) => row.type === "refund")).toHaveLength(0);
  });
  it("确认写失败且财务已提交，重放只确认不二退", async () => {
    ledger.debit(10, "key");
    ledger.keys.set("key", { id: "key", user_id: "u1", credits_used: 20 });
    ledger.failOutboxAck = true;
    await expect(refundGenerationCredits(request)).rejects.toThrow();
    expect(ledger.wallet).toBe(110);
    ledger.failOutboxAck = false;
    runtime.database = ledger.database();
    await processGenerationRefundOutbox({
      now: new Date(Date.now() + 3600000),
    });
    expect(ledger.wallet).toBe(110);
    expect(ledger.keys.get("key")?.credits_used).toBe(10);
    expect(ledger.outbox[0]?.state).toBe("settled");
  });
  it("纯中转无需 generation 行，私密内容不进入持久意图或退款流水", async () => {
    ledger.debit(10);
    await refundGenerationCredits(request);
    expect(ledger.generations).toHaveLength(0);
    expect(JSON.stringify([...ledger.outbox, ...ledger.rows])).not.toMatch(
      /私密|private|secret|prompt|imageUrl/
    );
  });
  it("同用户同 sourceRef 不得切换任务或退款参数", async () => {
    await enqueueGenerationRefund(request);
    await expect(
      enqueueGenerationRefund({ ...request, generationId: "g2" })
    ).rejects.toThrow(/conflict/i);
    await expect(
      enqueueGenerationRefund({ ...request, amount: 30 })
    ).rejects.toThrow(/conflict/i);
  });
});

describe("R11 崩溃和存量恢复", () => {
  it("资金提交响应丢失也不重复退款或 Key 退额", async () => {
    ledger.debit(10, "key");
    ledger.keys.set("key", { id: "key", user_id: "u1", credits_used: 15 });
    ledger.failCommitResponse = true;
    await expect(refundGenerationCredits(request)).rejects.toThrow();
    expect(ledger.wallet).toBe(110);
    runtime.database = ledger.database();
    await processGenerationRefundOutbox({
      now: new Date(Date.now() + 3600000),
    });
    expect(ledger.wallet).toBe(110);
    expect(ledger.keys.get("key")?.credits_used).toBe(5);
    expect(ledger.outbox[0]?.state).toBe("settled");
  });
  it("Key 写入失败同事务回滚，修复后 worker 继续处理", async () => {
    ledger.debit(10, "key");
    ledger.keys.set("key", { id: "key", user_id: "u1", credits_used: 15 });
    ledger.failKeyUpdate = true;
    await expect(refundGenerationCredits(request)).rejects.toThrow();
    expect(ledger.wallet).toBe(100);
    expect(ledger.keys.get("key")?.credits_used).toBe(15);
    ledger.failKeyUpdate = false;
    await processGenerationRefundOutbox({
      now: new Date(Date.now() + 3600000),
    });
    expect(ledger.wallet).toBe(110);
    expect(ledger.keys.get("key")?.credits_used).toBe(5);
  });
  it("领取后退出的租期到期可恢复，租期内不重复领取", async () => {
    ledger.debit(10);
    await enqueueGenerationRefund(request);
    const intent = ledger.outbox[0];
    if (!intent) throw new Error("No intent");
    const now = new Date();
    intent.attempts = 1;
    intent.next_attempt_at = new Date(now.getTime() + 60000).toISOString();
    runtime.database = ledger.database();
    expect(await processGenerationRefundOutbox({ now })).toMatchObject({
      attempted: 0,
    });
    expect(
      await processGenerationRefundOutbox({
        now: new Date(now.getTime() + 60001),
      })
    ).toMatchObject({ settled: 1 });
    expect(ledger.wallet).toBe(110);
  });
  it("failed 无 outbox 按持久目标补偿，已有部分退款不会侵占保留额", async () => {
    ledger.debit(10);
    await refundGenerationCredits({ ...request, amount: 3 });
    ledger.outbox = [];
    ledger.generations.push({
      id: "g1",
      user_id: "u1",
      status: "failed",
      credits_consumed: 10,
      created_at: "2026-10-26 00:00:00",
      metadata: { timeout: { targetCredits: 4 }, prompt: "secret" },
    });
    expect(await recoverFailedGenerationRefunds()).toMatchObject({
      enqueued: 1,
      recoveryFailed: 0,
    });
    await processGenerationRefundOutbox();
    expect(ledger.wallet).toBe(106);
    expect(ledger.generations[0]?.credits_consumed).toBe(4);
    expect(await recoverFailedGenerationRefunds()).toMatchObject({
      enqueued: 0,
      recoveryFailed: 0,
    });
    expect(JSON.stringify(ledger.outbox)).not.toMatch(/secret|prompt/);
    const scan = ledger.queries.find((query) =>
      query.text.includes("NOT EXISTS")
    );
    expect(scan?.text).not.toContain('"prompt"');
    expect(scan?.text).toContain('"user_id" = "generation"."user_id"');
  });
  it("timeout 终态提交后 enqueue 失败，下一轮从 failed 回填恢复", async () => {
    ledger.debit(10);
    ledger.generations.push({
      id: "g1",
      user_id: "u1",
      status: "pending",
      credits_consumed: 10,
      created_at: "2026-10-26 00:00:00",
      metadata: { creditCost: { moderationOnlyCredits: 2 } },
    });
    ledger.failOutboxInsert = true;
    const result = await expireStalePendingGenerations();
    expect(result[0]?.refundGranted).toBe(false);
    expect(ledger.generations[0]?.status).toBe("failed");
    expect(ledger.wallet).toBe(100);
    ledger.failOutboxInsert = false;
    expect(await expireStalePendingGenerations()).toEqual([]);
    await recoverFailedGenerationRefunds();
    await processGenerationRefundOutbox();
    expect(ledger.wallet).toBe(108);
    expect(ledger.generations[0]?.credits_consumed).toBe(2);
  });
  it("首笔扣费未确认的 pending 超时按目标 0 全额退款，不保留审核费", async () => {
    ledger.debit(10);
    ledger.generations.push({
      id: "g1",
      user_id: "u1",
      status: "pending",
      credits_consumed: 10,
      created_at: "2026-10-26 00:00:00",
      // 对照上一用例：同样的审核费配置，只多了首笔未确认标记。
      metadata: {
        creditCost: { moderationOnlyCredits: 2 },
        initialCharge: { outcome: "unconfirmed" },
      },
    });
    const result = await expireStalePendingGenerations();
    expect(result[0]?.refundGranted).toBe(true);
    expect(ledger.generations[0]?.status).toBe("failed");
    expect(ledger.wallet).toBe(110);
    expect(ledger.generations[0]?.credits_consumed).toBe(0);
  });
  it("过期多 worker 竞争只领取一次；常规 metadata 目标按白名单复用", async () => {
    ledger.debit(10);
    await refundGenerationCredits({ ...request, amount: 3 });
    await enqueueGenerationRefund({
      ...request,
      sourceRef: "g1:target",
      amount: 6,
      targetCredits: 4,
    });
    await Promise.all([
      processGenerationRefundOutbox(),
      processGenerationRefundOutbox(),
    ]);
    expect(ledger.wallet).toBe(106);
    expect(ledger.outbox[1]?.attempts).toBe(1);
    expect(
      await refundGenerationCredits({
        ...request,
        sourceRef: "g1:target",
        amount: 6,
        metadata: { targetCredits: 4, prompt: "secret" },
      })
    ).toMatchObject({ amount: 0, remainingDebited: 4 });
    expect(JSON.stringify(ledger.rows)).not.toMatch(/secret|prompt/);
  });
  it("零额也持久核对，金额非法时不触发任何数据库写入", async () => {
    ledger.debit(10);
    expect(
      await refundGenerationCredits({ ...request, amount: 0 })
    ).toMatchObject({ amount: 0, remainingDebited: 10 });
    expect(ledger.outbox).toHaveLength(1);
    ledger.queries = [];
    await expect(
      enqueueGenerationRefund({ ...request, amount: Number.NaN })
    ).rejects.toThrow();
    expect(ledger.queries).toHaveLength(0);
  });
});

it("新退款路径上线前创建的失败任务不回填：旧退款流水不带 generationId，账本净额不可信", async () => {
  // 生产实测形状：旧版扣 10.27，以只带 sourceRef 的流水退回 10，行内保留审核费 0.27。
  // 按任务 ID 汇总的账本只看到 10.27 的消费；若回填，会再把 0.27 退掉。
  ledger.debit(10.27);
  const walletBefore = ledger.wallet;
  ledger.generations.push({
    id: "g1",
    user_id: "u1",
    status: "failed",
    credits_consumed: 0.27,
    created_at: "2026-05-17 17:52:27",
    metadata: {
      moderationFailureCredits: 0.27,
      creditCost: { moderationOnlyCredits: 0.27 },
    },
  });
  expect(await recoverFailedGenerationRefunds()).toEqual({
    enqueued: 0,
    recoveryFailed: 0,
  });
  await processGenerationRefundOutbox();
  expect(ledger.outbox).toHaveLength(0);
  expect(ledger.wallet).toBe(walletBefore);
  // 失败回填扫描（排除异步完成行）；异步完成恢复只扫新版写入的行，不受此限。
  const scan = ledger.queries.find(
    (query) =>
      query.text.includes("NOT EXISTS") &&
      query.text.includes("'moderationFailureCredits'")
  );
  expect(scan?.text).toContain('"generation"."created_at" >= $');
  expect(scan?.values).toContain(
    FAILED_GENERATION_RECOVERY_SINCE.toISOString()
  );
});

it("恢复旧快照投影已降低时复用原意图，其他 generation 仍收敛", async () => {
  ledger.debit(10);
  ledger.generations.push({
    id: "g1",
    user_id: "u1",
    status: "failed",
    credits_consumed: 10,
    metadata: { timeout: { targetCredits: 4 } },
    created_at: "2026-10-26 00:00:00",
  });
  await recoverFailedGenerationRefunds();
  await processGenerationRefundOutbox();
  expect(ledger.generations[0]?.credits_consumed).toBe(4);
  ledger.debit(7, undefined, "g2");
  ledger.generations.push({
    id: "g2",
    user_id: "u1",
    status: "failed",
    credits_consumed: 7,
    metadata: { timeout: { targetCredits: 2 } },
    created_at: "2026-10-26 00:00:00",
  });
  ledger.failedScanSnapshot = ledger.generations;
  expect(await recoverFailedGenerationRefunds()).toMatchObject({
    enqueued: 2,
    recoveryFailed: 0,
  });
  await processGenerationRefundOutbox();
  expect(ledger.wallet).toBe(111);
  expect(ledger.outbox).toHaveLength(2);
  expect(Number(ledger.outbox[0]?.requested_amount)).toBe(10);
  expect(Number(ledger.outbox[0]?.target_credits)).toBe(4);
  expect(ledger.generations[1]?.credits_consumed).toBe(2);
});
it("旧 failed 的审核保留费高于生成失败费时不把审核费用扫退", async () => {
  ledger.debit(10);
  ledger.generations.push({
    id: "g1",
    user_id: "u1",
    status: "failed",
    credits_consumed: 10,
    metadata: {
      moderationFailureCredits: 4,
      creditCost: { moderationOnlyCredits: 1 },
    },
    created_at: "2026-10-26 00:00:00",
  });
  await recoverFailedGenerationRefunds();
  await processGenerationRefundOutbox();
  expect(ledger.wallet).toBe(106);
  expect(ledger.generations[0]?.credits_consumed).toBe(4);
});
it("一个旧行意图冲突不阻断其他退款，错误按安全类别记日志", async () => {
  ledger.debit(10);
  ledger.debit(7, undefined, "g2");
  await enqueueGenerationRefund({
    ...request,
    sourceRef: "g1:failed-recovery-refund",
    targetCredits: 4,
  });
  ledger.failedScanSnapshot = [
    {
      id: "g1",
      user_id: "u1",
      status: "failed",
      credits_consumed: 10,
      metadata: { timeout: { targetCredits: 3 } },
    },
    {
      id: "g2",
      user_id: "u1",
      status: "failed",
      credits_consumed: 7,
      metadata: { timeout: { targetCredits: 2 } },
    },
  ];
  expect(await recoverFailedGenerationRefunds()).toEqual({
    enqueued: 1,
    recoveryFailed: 1,
  });
  expect(await processGenerationRefundOutbox()).toMatchObject({ settled: 2 });
  expect(ledger.wallet).toBe(111);
  expect(runtime.logWarn).toHaveBeenCalled();
});

it("已确认的零退款意图不会在同任务后续补扣后重新支付", async () => {
  expect(await refundGenerationCredits(request)).toMatchObject({
    amount: 0,
    remainingDebited: 0,
  });
  ledger.debit(10);
  expect(await refundGenerationCredits(request)).toMatchObject({
    amount: 0,
    remainingDebited: 10,
  });
  expect(ledger.wallet).toBe(100);
});
