/** R05：真实 lifecycle/guard/consume 与 SQL驱动的确定性交错测试；真实PG另行验收。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditableTaskDatabase } from "./test-support/editable-task-db";
import { consumptionGate } from "./credits/test-support/consumption-db";
const state = vi.hoisted(() => ({
  db: undefined as unknown,
  refund: vi.fn(),
  sign: vi.fn(),
}));
vi.mock("@repo/database", () => ({
  get db() {
    return state.db;
  },
}));
vi.mock("./system-settings", () => ({
  getRuntimeSettingNumber: async (_key: string, fallback: number) => fallback,
}));
vi.mock("./logger", () => ({
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("./generation-refund-outbox", () => ({
  submitGenerationRefund: state.refund,
}));
vi.mock("./storage/signed-url", () => ({
  buildSignedStorageImageUrl: state.sign,
}));
import {
  captureEditableTask,
  prepareEditableTask,
  completeEditableTask,
  failEditableTask,
  getEditableTask,
  recoverEditableTasks,
  deliverEditableTask,
  getEditableTaskByPublicId,
  getSessionEditableTask,
  assertEditableTaskExecutable,
  editableExecutionSignal,
} from "./editable-task-lifecycle";
import {
  editableRequestFingerprint,
  editableTaskId,
} from "./editable-task-contract";

import { consumeCredits } from "./credits/core";

let fixture: EditableTaskDatabase;
const input = {
  userId: "u1",
  apiKeyId: "k1",
  kind: "ppt" as const,
  taskId: "client-1",
  requestFingerprint: "a".repeat(64),
};
const refs = {
  conversationId: "conversation",
  primary: { key: "u1/result.pptx", bucket: "generations" },
  zip: null,
};
/** 模拟 R11 的外部调用边界；资金幂等/Key归属自身已有独立真实PG，测试保留真实 task/outbox SQL。 */
function refund() {
  const id = editableTaskId(input.userId, input.kind, input.taskId);
  const entries = fixture.entries.filter(
    (r) => (r.metadata as Record<string, unknown>)?.generationId === id
  );
  const amount = entries.reduce(
    (sum, r) => sum + (r.type === "consumption" ? 1 : -1) * Number(r.amount),
    0
  );
  if (amount > 0) {
    fixture.entries.push({
      user_id: "u1",
      type: "refund",
      amount,
      source_ref: `${id}:lifecycle-refund`,
      metadata: { generationId: id },
    });
    const wallet = fixture.wallets.get("u1");
    const key = fixture.keys.get("k1");
    if (wallet) wallet.balance = Number(wallet.balance) + amount;
    if (key) key.credits_used = Number(key.credits_used) - amount;
  }
  return { amount, remainingDebited: 0 };
}
/** 认领准备必须返回本次 owner，已完成重放不用此 helper。 */
async function prepared(amount = 25) {
  const value = await prepareEditableTask(input, amount);
  if (!value.claim) throw new Error("Expected fresh task");
  return { ...value, claim: value.claim };
}
beforeEach(() => {
  vi.resetAllMocks();
  fixture = new EditableTaskDatabase();
  state.db = fixture.database();
  state.refund.mockImplementation(async () => refund());
  state.sign.mockImplementation(
    (key: string) => `https://storage.invalid/${key}?new=1`
  );
});

afterEach(() => vi.restoreAllMocks());

/** 保留真实SELECT结果，只延迟返回ACK，验证本地预算不能忽略查询传输耗时。 */
class DelayedExecutionCheckDatabase extends EditableTaskDatabase {
  entered = consumptionGate();
  releaseAck = consumptionGate();
  override client(id: number) {
    const original = super.client(id);
    return {
      query: async (
        config: { text: string; rowMode?: string },
        values: unknown[] = []
      ) => {
        const result = await original.query(config, values);
        if (config.text.includes('as "remaining_ms"')) {
          this.entered.release();
          await this.releaseAck.promise;
        }
        return result;
      },
    };
  }
}

describe("R05 原子生命周期", () => {
  it("同请求已完成但重签暂不可用也能恢复原poll ID，跨Key不返回ID", async () => {
    const p = await prepared();
    await captureEditableTask(p.task, p.claim);
    await completeEditableTask(p.claim, refs);
    state.sign.mockReturnValue(null);
    await expect(getEditableTask(input)).rejects.toMatchObject({
      code: "editable_file_delivery_pending",
      publicTaskId: p.task.publicId,
    });
    expect(await getEditableTask({ ...input, apiKeyId: "k2" })).toBeNull();
    expect(
      await getEditableTask({ ...input, requestFingerprint: "b".repeat(64) })
    ).toBeNull();
  });
  it("captureACK后的执行预算只取数据库原期限剩余时间，不重启30分钟", async () => {
    const p = await prepared();
    await captureEditableTask(p.task, p.claim);
    fixture.now += 29 * 60_000;
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(new AbortController().signal);
    await editableExecutionSignal(p.claim);
    const budget = timeout.mock.calls[0]?.[0];
    expect(budget).toBeGreaterThan(59_000);
    expect(budget).toBeLessThanOrEqual(60_000);
    const query = fixture.queries.findLast((row) =>
      row.text.includes('as "remaining_ms"')
    );
    expect(query?.text).toContain('"claim_token"');
    expect(query?.text).toContain('"state"');
    expect(query?.text).toContain("clock_timestamp()");
    expect(query?.values).toContain(p.claim.claimToken);
    expect(query?.values).toContain("running");
  });
  it("DB期限已过即使尚未扫描退款也不再允许开工", async () => {
    const p = await prepared();
    await captureEditableTask(p.task, p.claim);
    fixture.now += 31 * 60_000;
    await expect(assertEditableTaskExecutable(p.claim)).rejects.toMatchObject({
      code: "editable_file_task_already_consumed",
    });
    expect(fixture.tasks.get(p.task.id)?.state).toBe("running");
    expect(state.refund).not.toHaveBeenCalled();
  });
  it("其他token或退款终态拒绝开工，检查本身不改变结算", async () => {
    const p = await prepared();
    await captureEditableTask(p.task, p.claim);
    await expect(
      assertEditableTaskExecutable({ ...p.claim, claimToken: "other" })
    ).rejects.toThrow();
    await failEditableTask(p.task.id, p.claim.claimToken);
    await expect(assertEditableTaskExecutable(p.claim)).rejects.toThrow();
    expect(fixture.tasks.get(p.task.id)?.state).toBe("refunded");
    expect(state.refund).toHaveBeenCalledTimes(1);
  });
  it("开工SELECT的ACK也迟到时扣除查询全部耗时，不从旧DB剩余数重开预算", async () => {
    const database = new DelayedExecutionCheckDatabase();
    fixture = database;
    state.db = database.database();
    const p = await prepared();
    await captureEditableTask(p.task, p.claim);
    const row = fixture.tasks.get(p.task.id);
    if (!row) throw new Error("missing fixture");
    row.expires_at = new Date(fixture.now + 500).toISOString();
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const checking = editableExecutionSignal(p.claim).then(
      () => null,
      (error: unknown) => error
    );
    await database.entered.promise;
    elapsed = 501;
    database.releaseAck.release();
    expect(await checking).toMatchObject({
      code: "editable_file_task_already_consumed",
    });
    expect(timeout).not.toHaveBeenCalled();
  });
  it("调用者在开工检查await期间取消，返回后不创建新的执行信号", async () => {
    const database = new DelayedExecutionCheckDatabase();
    fixture = database;
    state.db = database.database();
    const p = await prepared();
    await captureEditableTask(p.task, p.claim);
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const checking = editableExecutionSignal(p.claim, controller.signal).then(
      () => null,
      (error: unknown) => error
    );
    await database.entered.promise;
    controller.abort();
    database.releaseAck.release();
    expect(await checking).toMatchObject({ name: "AbortError" });
    expect(timeout).not.toHaveBeenCalled();
  });
  it.each([
    "editable-file:client-1",
    editableTaskId("u1", "ppt", "client-1"),
  ])("旧版无task记录消费 %s 只拒绝，不重新捕获或生成", async (sourceRef) => {
    fixture.entries.push({
      user_id: "u1",
      type: "consumption",
      source_ref: sourceRef,
      amount: 25,
    });
    await expect(prepareEditableTask(input, 25)).rejects.toThrow();
    expect(fixture.tasks.size).toBe(0);
  });
  it("同用户新taskId不误命中旧任务账本", async () => {
    const p = await prepared();
    await captureEditableTask(p.task, p.claim);
    const next = await prepareEditableTask({ ...input, taskId: "next" }, 25);
    expect(next.claim).toBeTruthy();
    expect(next.task.id).not.toBe(p.task.id);
  });
  it("opaque轮询ID跨进程按原user+Key查询，prepared可见；POST仍校验指纹", async () => {
    const p = await prepared();
    expect(
      (
        await getEditableTaskByPublicId({
          userId: "u1",
          apiKeyId: "k1",
          publicId: p.task.publicId,
        })
      )?.status
    ).toBe("prepared");
    expect(
      await getEditableTaskByPublicId({
        userId: "u1",
        apiKeyId: "k2",
        publicId: p.task.publicId,
      })
    ).toBeNull();
    expect(
      await getEditableTaskByPublicId({
        userId: "u2",
        apiKeyId: "k1",
        publicId: p.task.publicId,
      })
    ).toBeNull();
    expect(
      await getSessionEditableTask({
        userId: "u1",
        taskId: input.taskId,
        kind: "ppt",
      })
    ).toBeNull();
    await captureEditableTask(p.task, p.claim);
    await completeEditableTask(p.claim, refs);
    expect(
      (
        await getEditableTaskByPublicId({
          userId: "u1",
          apiKeyId: "k1",
          publicId: p.task.publicId,
        })
      )?.result?.primaryUrl
    ).toBeTruthy();
    await expect(
      prepareEditableTask({ ...input, requestFingerprint: "b".repeat(64) }, 25)
    ).rejects.toThrow();
  });
  it("图像按统一解码字节哈希，dataURL/持久引用解码后的base64不改变指纹", () => {
    const request = {
      kind: "ppt" as const,
      prompt: "same",
      base64Images: ["data:image/png;base64,aW1hZ2U="],
    };
    const fingerprint = editableRequestFingerprint(request);
    expect(
      editableRequestFingerprint({ ...request, base64Images: [" aW1h\nZ2U= "] })
    ).toBe(fingerprint);
    expect(
      editableRequestFingerprint({ ...request, base64Images: ["b3RoZXI="] })
    ).not.toBe(fingerprint);
    expect(
      editableRequestFingerprint({ ...request, prompt: "changed" })
    ).not.toBe(fingerprint);
  });
  it("generationSettlement 与 editableTaskClaim 互斥，拒绝前不借事务或写资金", async () => {
    const p = await prepared();
    fixture.queries.length = 0;
    const payment = {
      userId: "u1",
      amount: 25,
      serviceName: "editable",
      sourceRef: p.task.id,
      generationSettlement: { generationId: "other" },
      editableTaskClaim: p.claim,
      metadata: { generationId: p.task.id },
    };
    await expect(consumeCredits(payment)).rejects.toThrow("mutually exclusive");
    expect(fixture.queries).toHaveLength(0);
    expect(fixture.entries).toHaveLength(0);
  });
  it("扣费/Key/claim 同事务，按 ledger 交付，重放重签", async () => {
    const p = await prepared();
    await captureEditableTask(p.task, p.claim);
    expect(fixture.tasks.get(p.task.id)?.state).toBe("running");
    expect(fixture.wallets.get("u1")?.balance).toBe(975);
    expect(fixture.keys.get("k1")?.credits_used).toBe(25);
    const completed = await completeEditableTask(p.claim, refs);
    expect((await deliverEditableTask(completed)).creditsCharged).toBe(25);
    state.sign.mockReturnValue("fresh-url");
    expect((await getEditableTask(input))?.result?.primaryUrl).toBe(
      "fresh-url"
    );
    expect((await prepareEditableTask(input, 50)).claim).toBeNull();
    expect(
      fixture.entries.filter((r) => r.type === "consumption")
    ).toHaveLength(1);
  });
  it("钱包失败回滚 Key、流水与 running，不留下半个 capture", async () => {
    const p = await prepared();
    fixture.failWallet = true;
    await expect(captureEditableTask(p.task, p.claim)).rejects.toThrow();
    expect(fixture.tasks.get(p.task.id)?.state).toBe("prepared");
    expect(fixture.entries).toHaveLength(0);
    expect(fixture.keys.get("k1")?.credits_used).toBe(0);
    expect(fixture.batches.get("b1")?.remaining).toBe(1000);
  });
  it("零价仍持久认领、并发只成功一次，账本不造零流水", async () => {
    const p = await prepared(0);
    const attempts = await Promise.allSettled([
      captureEditableTask(p.task, p.claim),
      captureEditableTask(p.task, p.claim),
    ]);
    expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await completeEditableTask(p.claim, refs);
    expect((await getEditableTask(input))?.creditsCharged).toBe(0);
    expect(fixture.entries).toHaveLength(0);
  });
  it("并发准备同ID只得到一个持久owner", async () => {
    const attempts = await Promise.allSettled([prepared(), prepared()]);
    expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
  it.each([
    { apiKeyId: "k2" },
    { apiKeyId: undefined },
    { requestFingerprint: "b".repeat(64) },
    { userId: "u2" },
  ])("重取必须原身份/指纹 %j", async (change) => {
    const p = await prepared();
    await captureEditableTask(p.task, p.claim);
    await completeEditableTask(p.claim, refs);
    state.sign.mockClear();
    expect(await getEditableTask({ ...input, ...change })).toBeNull();
    expect(state.sign).not.toHaveBeenCalled();
  });
  it("capture后进程丢失：过期扫描持久outbox并退款，不能重做", async () => {
    const p = await prepared();
    await captureEditableTask(p.task, p.claim);
    fixture.now += 31 * 60_000;
    expect(await recoverEditableTasks()).toEqual({ scanned: 1, recovered: 1 });
    expect(fixture.outbox.size).toBe(1);
    expect(fixture.tasks.get(p.task.id)?.state).toBe("refunded");
    expect(fixture.wallets.get("u1")?.balance).toBe(1000);
    await expect(captureEditableTask(p.task, p.claim)).rejects.toThrow();
    await expect(prepareEditableTask(input, 25)).rejects.toThrow();
  });
  it("prepared过期先终态，晚capture不得扣费", async () => {
    const p = await prepared();
    fixture.now += 31 * 60_000;
    await recoverEditableTasks();
    await expect(captureEditableTask(p.task, p.claim)).rejects.toThrow();
    expect(fixture.wallets.get("u1")?.balance).toBe(1000);
    expect(fixture.entries).toHaveLength(0);
    expect(fixture.tasks.get(p.task.id)?.state).toBe("failed");
  });
  it("退款等待未提交capture任务锁，晚COMMIT后准确退全，不提前零额settled", async () => {
    const p = await prepared();
    const entered = consumptionGate();
    const release = consumptionGate();
    fixture.beforeCaptureCommit = async () => {
      entered.release();
      await release.promise;
    };
    const capture = captureEditableTask(p.task, p.claim).then(
      () => null,
      (error: unknown) => {
        entered.release();
        return error;
      }
    );
    await entered.promise;
    fixture.now += 31 * 60_000;
    const recovery = recoverEditableTasks();
    await Promise.resolve();
    await Promise.resolve();
    expect(state.refund).not.toHaveBeenCalled();
    release.release();
    const captureError = await capture;
    await recovery;
    if (captureError) throw captureError;
    expect(fixture.tasks.get(p.task.id)?.state).toBe("refunded");
    expect(fixture.wallets.get("u1")?.balance).toBe(1000);
    expect(fixture.keys.get("k1")?.credits_used).toBe(0);
  });
  it("资金COMMIT响应丢失仍能按任务恢复，不把任务当未付费", async () => {
    const p = await prepared();
    fixture.loseCaptureAck = true;
    await expect(captureEditableTask(p.task, p.claim)).rejects.toThrow();
    fixture.loseCaptureAck = false;
    expect(fixture.tasks.get(p.task.id)?.state).toBe("running");
    await failEditableTask(p.task.id, p.claim.claimToken);
    expect(fixture.wallets.get("u1")?.balance).toBe(1000);
  });
  it("结果COMMIT响应丢失：失败处理发现completed，保留付费产物", async () => {
    const p = await prepared();
    await captureEditableTask(p.task, p.claim);
    fixture.loseCompletionAck = true;
    await expect(completeEditableTask(p.claim, refs)).rejects.toThrow();
    const result = await failEditableTask(p.task.id, p.claim.claimToken);
    expect(result.state).toBe("completed");
    expect((await getEditableTask(input))?.result?.primaryUrl).toBeTruthy();
    expect(state.refund).not.toHaveBeenCalled();
    expect(fixture.wallets.get("u1")?.balance).toBe(975);
  });
  it("完成态签名失败保留结果，恢复签名后可以重取", async () => {
    const p = await prepared();
    await captureEditableTask(p.task, p.claim);
    const completed = await completeEditableTask(p.claim, refs);
    state.sign.mockReturnValue(null);
    await expect(deliverEditableTask(completed)).rejects.toMatchObject({
      code: "editable_file_delivery_pending",
    });
    expect((await failEditableTask(p.task.id, p.claim.claimToken)).state).toBe(
      "completed"
    );
    expect(state.refund).not.toHaveBeenCalled();
    state.sign.mockReturnValue("fresh-url");
    expect((await getEditableTask(input))?.result?.primaryUrl).toBe(
      "fresh-url"
    );
  });
  it("R11失败留下持久意图，禁止已失败owner完成或重扣；重试后按ledger确认", async () => {
    const p = await prepared();
    await captureEditableTask(p.task, p.claim);
    state.refund.mockRejectedValueOnce(new Error("offline"));
    await expect(
      failEditableTask(p.task.id, p.claim.claimToken)
    ).rejects.toMatchObject({ code: "editable_file_refund_pending" });
    expect(fixture.outbox.size).toBe(1);
    expect(fixture.tasks.get(p.task.id)?.state).toBe("refund_pending");
    await expect(completeEditableTask(p.claim, refs)).rejects.toThrow();
    await expect(captureEditableTask(p.task, p.claim)).rejects.toThrow();
    await failEditableTask(p.task.id, p.claim.claimToken);
    expect(fixture.tasks.get(p.task.id)?.state).toBe("refunded");
  });
  it("退款假报remaining0也不能将真实净扣标为refunded", async () => {
    const p = await prepared();
    await captureEditableTask(p.task, p.claim);
    state.refund.mockResolvedValue({ remainingDebited: 0 });
    await expect(
      failEditableTask(p.task.id, p.claim.claimToken)
    ).rejects.toThrow();
    expect(fixture.tasks.get(p.task.id)?.state).toBe("refund_pending");
    expect((await getEditableTask(input))?.creditsCharged).toBe(25);
  });
  it("成功持久引用前UPDATE失败按账本退款，迟到结果不得覆盖", async () => {
    const p = await prepared();
    await captureEditableTask(p.task, p.claim);
    fixture.failCompletion = true;
    await expect(completeEditableTask(p.claim, refs)).rejects.toThrow();
    await failEditableTask(p.task.id, p.claim.claimToken);
    fixture.failCompletion = false;
    await expect(completeEditableTask(p.claim, refs)).rejects.toThrow();
    expect(fixture.wallets.get("u1")?.balance).toBe(1000);
  });
  it("快照价格不能伪装财务真相，报价与实际净扣不等拒绝完成", async () => {
    const p = await prepared();
    await captureEditableTask(p.task, p.claim);
    fixture.entries.push({
      user_id: "u1",
      type: "refund",
      amount: 4,
      metadata: { generationId: p.task.id },
    });
    await expect(completeEditableTask(p.claim, refs)).rejects.toThrow(
      "not settled"
    );
  });
  it("不持久原始prompt、图片、URL和凭据，仅指纹/引用/财务字段", async () => {
    const request = {
      kind: "ppt" as const,
      prompt: "private prompt",
      base64Images: ["private image"],
    };
    const fingerprint = editableRequestFingerprint(request);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(
      editableRequestFingerprint({ ...request, chatRound: true })
    ).not.toBe(fingerprint);
    const p = await prepareEditableTask(
      { ...input, requestFingerprint: fingerprint },
      0
    );
    expect(JSON.stringify([...fixture.tasks.values()])).not.toMatch(
      /private prompt|private image|https:/
    );
    expect(p.task.requestFingerprint).toBe(fingerprint);
  });
});
