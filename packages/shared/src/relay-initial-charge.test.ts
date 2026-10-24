/** pureRelay 初始财务恢复：真实 core/CAS/outbox，受控 Drizzle 事务，不访问网络。 */
import { beforeEach, expect, it, vi } from "vitest";
import {
  RelayCaptureDatabase,
  refundDatabaseFromCapture,
} from "./test-support/relay-initial-charge-db";

const runtime = vi.hoisted(() => ({ database: {} as object }));
vi.mock("@repo/database", () => ({
  db: new Proxy(
    {},
    {
      get: (_target, key) => {
        const value = Reflect.get(runtime.database, key);
        return typeof value === "function"
          ? value.bind(runtime.database)
          : value;
      },
    }
  ),
}));
vi.mock("./logger", () => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
  logEvent: vi.fn(),
}));
vi.mock("./system-settings", () => ({
  getRuntimeSettingNumber: async () => 0,
}));

import { consumeCredits } from "./credits/core";
import { processGenerationRefundOutbox } from "./generation-refund-outbox";
import {
  dispatchRelayInitialCharge,
  recoverRelayInitialCharges,
} from "./relay-initial-charge";
import { isDefinitiveChargeRejection } from "./credits/charge-outcome";
import {
  createRelayInitialCapture,
  PURE_RELAY_CREDIT_DESCRIPTION,
  relayInitialCaptureMetadata,
} from "./relay-initial-charge-contract";
import { invokeOperation } from "./uol/invoke";
import { recoverRelayInitialChargesOperation } from "./uol/operations/relay-initial-charge";

let ledger: RelayCaptureDatabase;
const userId = "u1";
beforeEach(() => {
  ledger = new RelayCaptureDatabase();
  runtime.database = ledger.database();
});

/** 财务标量与合成私密内容混放，确保初始新路径确实剔除根/嵌套私密字段。 */
function payment(generationId = "g1") {
  return {
    userId,
    amount: 10,
    serviceName: "image-generation",
    sourceRef: `${generationId}:charge`,
    externalApiKeyId: "k1",
    description: "SYNTHETIC_PRIVATE_PROMPT",
    metadata: {
      generationId,
      prompt: "SYNTHETIC_PRIVATE_PROMPT",
      error: "SYNTHETIC_PRIVATE_ERROR",
      initialBilling: {
        billingMultiplier: 2,
        prompt: "SYNTHETIC_NESTED_PROMPT",
      },
    },
    relayInitialCapture: createRelayInitialCapture(
      generationId,
      new Date(ledger.store.now + 1_200_000)
    ),
  };
}
/** 仅切换已提交快照；新数据库连接不继承任何执行中的任务闭包。 */
function restartForRefund() {
  const refund = refundDatabaseFromCapture(ledger);
  runtime.database = refund.database();
  return refund;
}

it("初始消费、原Key、钱包、captured标记同事务提交，账本只留财务白名单", async () => {
  const p = payment();
  await consumeCredits(p);
  expect(ledger.entries).toHaveLength(1);
  expect(ledger.store.rows.size).toBe(1);
  const intent = ledger.store.rows.get(p.relayInitialCapture.captureId);
  expect(intent).toMatchObject({
    state: "captured",
    user_id: userId,
    api_key_id: "k1",
    amount: "10",
  });
  expect(intent?.consumption_transaction_id).toBe(ledger.entries[0]?.id);
  expect(
    (ledger.entries[0]?.metadata as Record<string, unknown>).relayInitialCapture
  ).toMatchObject({
    version: 1,
    state: "captured",
    captureId: p.relayInitialCapture.captureId,
  });
  expect(ledger.entries[0]?.description).toBe(PURE_RELAY_CREDIT_DESCRIPTION);
  expect(
    JSON.stringify([ledger.entries, [...ledger.store.rows.values()]])
  ).not.toContain("SYNTHETIC_");
  expect(ledger.keys.get("k1")?.credits_used).toBe(10);
  expect(ledger.wallets.get(userId)?.balance).toBe(990);
});

it("财务标记写入失败完整回滚Key/钱包/消费", async () => {
  ledger.store.failInsert = true;
  await expect(consumeCredits(payment())).rejects.toThrow();
  expect(ledger.entries).toHaveLength(0);
  expect(ledger.store.rows.size).toBe(0);
  expect(ledger.wallets.get(userId)?.balance).toBe(1000);
  expect(ledger.keys.get("k1")?.credits_used).toBe(0);
  expect(ledger.batches.get("b1")?.remaining).toBe(1000);
});

it.each(["wallet", "key"])("%s失败不留下captured孤儿", async (failure) => {
  if (failure === "wallet") ledger.failWallet = true;
  else ledger.keys.get("k1")!.credit_limit = 1;
  await expect(consumeCredits(payment())).rejects.toThrow();
  expect(ledger.entries).toHaveLength(0);
  expect(ledger.store.rows.size).toBe(0);
  expect(ledger.keys.get("k1")?.credits_used).toBe(0);
});

it.each([
  "editableTaskClaim",
  "generationSettlement",
] as const)("relay意图与%s互斥且不进入资金事务", async (field) => {
  await expect(
    consumeCredits({
      ...payment(),
      [field]:
        field === "editableTaskClaim"
          ? { taskId: "g1", claimToken: "claim" }
          : { generationId: "g1" },
    })
  ).rejects.toThrow("mutually exclusive");
  expect(ledger.queries).toHaveLength(0);
});

it.each([
  "auto",
  "AUTO",
  "3:2",
  "16 : 9",
  "1024x1024",
  "1536x1024",
])("初始账本白名单接受合法尺寸写法 %s", (size) => {
  const intent = payment().relayInitialCapture;
  expect(relayInitialCaptureMetadata({ size }, intent).size).toBe(size);
});

it.each([
  "a cat sitting on the moon",
  "1024x1024; drop",
  "x".repeat(40),
])("初始账本白名单拒绝非尺寸文本 %j", (size) => {
  const intent = payment().relayInitialCapture;
  expect(() => relayInitialCaptureMetadata({ size }, intent)).toThrow();
});

it("事务前的契约校验失败标记为确定未扣，不访问数据库", async () => {
  const request = payment();
  const failure = await consumeCredits({
    ...request,
    metadata: { ...request.metadata, size: "a cat sitting on the moon" },
  }).catch((error: unknown) => error);
  expect(failure).toMatchObject({ code: "invalid_charge_request" });
  expect(isDefinitiveChargeRejection(failure)).toBe(true);
  expect(ledger.entries).toHaveLength(0);
  expect(ledger.store.rows.size).toBe(0);
});

it("零金额拒绝消费，不伪造ledger或intent", async () => {
  await expect(consumeCredits({ ...payment(), amount: 0 })).rejects.toThrow();
  expect(ledger.entries).toHaveLength(0);
  expect(ledger.store.rows.size).toBe(0);
});

it("幂等命中不创建第二个可恢复意图，也不重新扣原Key", async () => {
  await consumeCredits(payment());
  const duplicate = payment();
  expect(await consumeCredits(duplicate)).toMatchObject({
    alreadyConsumed: true,
  });
  expect(ledger.store.rows.size).toBe(1);
  expect(ledger.keys.get("k1")?.credits_used).toBe(10);
  await expect(
    dispatchRelayInitialCharge(userId, duplicate.relayInitialCapture)
  ).rejects.toThrow();
});

it("旧无标记消费不补captured，恢复不猜测应退", async () => {
  const { relayInitialCapture: _unused, ...legacy } = payment();
  await consumeCredits(legacy);
  await consumeCredits(payment());
  const refund = restartForRefund();
  refund.store.now += 1_200_001;
  expect(await recoverRelayInitialCharges()).toEqual({
    scanned: 0,
    enqueued: 0,
    failed: 0,
  });
  expect(refund.wallet).toBe(990);
  expect(refund.outbox).toHaveLength(0);
});

it("capture COMMIT ACK丢失仍保留同事务标记，恢复只退一次并保持无关Key", async () => {
  ledger.keys.set("k2", { id: "k2", user_id: userId, credits_used: 9 });
  ledger.store.loseCaptureAck = true;
  await expect(consumeCredits(payment())).rejects.toThrow();
  const refund = restartForRefund();
  refund.store.now += 1_200_001;
  expect(await recoverRelayInitialCharges()).toMatchObject({
    enqueued: 1,
    failed: 0,
  });
  await processGenerationRefundOutbox({
    now: new Date(Date.now() + 3_600_000),
  });
  await recoverRelayInitialCharges();
  const repeat = await processGenerationRefundOutbox({
    now: new Date(Date.now() + 7_200_000),
  });
  expect(refund.wallet).toBe(1000);
  expect(refund.keys.get("k1")?.credits_used).toBe(0);
  expect(refund.keys.get("k2")?.credits_used).toBe(9);
  expect(repeat.creditsRefunded).toBe(0);
});

it("未到期不恢复；到期captured持久认领后拒绝旧worker dispatch", async () => {
  const p = payment();
  await consumeCredits(p);
  const refund = restartForRefund();
  expect(await recoverRelayInitialCharges()).toMatchObject({ scanned: 0 });
  refund.store.now += 1_200_001;
  expect(await recoverRelayInitialCharges()).toMatchObject({ enqueued: 1 });
  await expect(
    dispatchRelayInitialCharge(userId, p.relayInitialCapture)
  ).rejects.toThrow();
  expect(refund.outbox[0]).toMatchObject({
    target_credits: "0",
    generation_id: "g1",
  });
});

it("dispatched永不被到期扫描退款，重复dispatch也拒绝", async () => {
  const p = payment();
  await consumeCredits(p);
  await dispatchRelayInitialCharge(userId, p.relayInitialCapture);
  await expect(
    dispatchRelayInitialCharge(userId, p.relayInitialCapture)
  ).rejects.toThrow();
  const refund = restartForRefund();
  refund.store.now += 86_400_000;
  expect(await recoverRelayInitialCharges()).toMatchObject({ scanned: 0 });
  expect(refund.outbox).toHaveLength(0);
  expect(refund.wallet).toBe(990);
});

it("dispatch已提交但ACK丢失：调用方失败关闭，后台仍不自动退dispatched", async () => {
  const p = payment();
  await consumeCredits(p);
  ledger.store.loseDispatchAck = true;
  await expect(
    dispatchRelayInitialCharge(userId, p.relayInitialCapture)
  ).rejects.toThrow();
  const refund = restartForRefund();
  refund.store.now += 86_400_000;
  expect(await recoverRelayInitialCharges()).toMatchObject({ scanned: 0 });
  expect(refund.outbox).toHaveLength(0);
});

it("过期或错误归属不能dispatch", async () => {
  const p = payment();
  await consumeCredits(p);
  await expect(
    dispatchRelayInitialCharge("other", p.relayInitialCapture)
  ).rejects.toThrow();
  ledger.store.now += 1_200_001;
  await expect(
    dispatchRelayInitialCharge(userId, p.relayInitialCapture)
  ).rejects.toThrow();
});

it("CAS后outbox插入失败留下refund_pending，新进程仍可投递", async () => {
  await consumeCredits(payment());
  const refund = restartForRefund();
  refund.store.now += 1_200_001;
  refund.failOutboxInsert = true;
  expect(await recoverRelayInitialCharges()).toMatchObject({ failed: 1 });
  expect([...refund.store.rows.values()][0]?.state).toBe("refund_pending");
  refund.failOutboxInsert = false;
  expect(await recoverRelayInitialCharges()).toMatchObject({ enqueued: 1 });
  expect(refund.outbox).toHaveLength(1);
});

it("outbox提交后状态确认失败可重复投递，不制造第二意图", async () => {
  await consumeCredits(payment());
  const refund = restartForRefund();
  refund.store.now += 1_200_001;
  refund.store.failEnqueued = true;
  await recoverRelayInitialCharges();
  expect(refund.outbox).toHaveLength(1);
  refund.store.failEnqueued = false;
  await recoverRelayInitialCharges();
  expect(refund.outbox).toHaveLength(1);
  expect([...refund.store.rows.values()][0]?.state).toBe("refund_enqueued");
});

it("并发恢复重放同一R11意图且不重退", async () => {
  await consumeCredits(payment());
  const refund = restartForRefund();
  refund.store.now += 1_200_001;
  await Promise.all([
    recoverRelayInitialCharges(),
    recoverRelayInitialCharges(),
  ]);
  expect(refund.outbox).toHaveLength(1);
  await processGenerationRefundOutbox({
    now: new Date(Date.now() + 3_600_000),
  });
  expect(refund.wallet).toBe(1000);
});

it("UOL仅cron/system且不接受调用者伪造提前到期时间", () => {
  expect(recoverRelayInitialChargesOperation.access).toEqual({
    kind: "cron",
  });
  expect(recoverRelayInitialChargesOperation.idempotency).toEqual({
    kind: "natural",
  });
  expect(
    recoverRelayInitialChargesOperation.input.safeParse({ now: "2099-01-01" })
      .success
  ).toBe(false);
});

it("实际UOL网关拒绝用户/Key，cron有界恢复", async () => {
  const name = recoverRelayInitialChargesOperation.name;
  await expect(
    invokeOperation(name, {}, { type: "user", userId, role: "admin" })
  ).rejects.toMatchObject({ code: "forbidden" });
  await expect(
    invokeOperation(
      name,
      {},
      { type: "apiKey", userId, apiKeyId: "k1", plan: "pro", relayOnly: true }
    )
  ).rejects.toMatchObject({ code: "forbidden" });
  expect(
    await invokeOperation(
      name,
      { limit: 1 },
      { type: "cron", job: "images-maintenance" }
    )
  ).toEqual({ scanned: 0, enqueued: 0, failed: 0 });
});

it("错误sourceRef或任务ID不能把补扣当初始capture", async () => {
  await expect(
    consumeCredits({ ...payment(), sourceRef: "g1:image-actual-size:charge" })
  ).rejects.toThrow("identity");
  await expect(
    consumeCredits({ ...payment(), metadata: { generationId: "other" } })
  ).rejects.toThrow("identity");
  expect(ledger.queries).toHaveLength(0);
});

it("恢复SELECT后看到的captured若已由dispatch提交，UPDATE重查不得入outbox", async () => {
  await consumeCredits(payment());
  const refund = restartForRefund();
  refund.store.now += 1_200_001;
  // 模拟另一事务在SELECT之后提交先前已获准的dispatch；真实争锁由PG fixture覆盖。
  refund.store.afterSelect = async () => {
    for (const row of refund.store.rows.values()) row.state = "dispatched";
  };
  expect(await recoverRelayInitialCharges()).toMatchObject({
    scanned: 1,
    enqueued: 0,
  });
  expect(refund.outbox).toHaveLength(0);
});

it.each([
  "relay-editable",
  "relay-generation",
  "editable-generation",
  "all-three",
] as const)("三guard互斥早于expiry与资金副作用：%s", async (combination) => {
  const batch = ledger.batches.get("b1");
  if (!batch) throw new Error("Missing fixture batch");
  batch.expires_at = "2000-01-01T00:00:00.000Z";
  const before = structuredClone({
    batches: ledger.batches,
    wallets: ledger.wallets,
    keys: ledger.keys,
  });
  const { relayInitialCapture, ...base } = payment();
  const conflicting = {
    ...base,
    ...(combination !== "editable-generation" ? { relayInitialCapture } : {}),
    ...(combination !== "relay-generation"
      ? { editableTaskClaim: { taskId: "g1", claimToken: "fixture" } }
      : {}),
    ...(combination !== "relay-editable"
      ? { generationSettlement: { generationId: "g1" } }
      : {}),
  };
  await expect(consumeCredits(conflicting)).rejects.toThrow(
    "mutually exclusive"
  );
  expect(ledger.queries).toHaveLength(0);
  expect(ledger.store.queries).toHaveLength(0);
  expect({
    batches: ledger.batches,
    wallets: ledger.wallets,
    keys: ledger.keys,
  }).toEqual(before);
  expect(ledger.entries).toHaveLength(0);
});
