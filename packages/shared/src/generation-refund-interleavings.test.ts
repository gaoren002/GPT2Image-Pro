/**
 * R11 独立 review 两条时序：执行源码中的 runtime timeout 闭包及真实 outbox/core。
 * 只替换外围定价配置/遥测，不改写退款调用；Drizzle 驱动受控，无 PG/网络外呼。
 */
import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ControlledLedger } from "./credits/test-support/generation-refund-db";

const state = vi.hoisted(() => ({ database: {} as object }));
vi.mock("@repo/database", () => ({
  db: new Proxy(
    {},
    {
      get: (_target, key) => {
        const value: unknown = Reflect.get(state.database, key);
        return typeof value === "function" ? value.bind(state.database) : value;
      },
    }
  ),
}));
vi.mock("./system-settings", () => ({
  getRuntimeSettingNumber: vi.fn(async () => 0),
}));
vi.mock("./logger/index", () => ({
  logEvent: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("./storage/providers", () => ({ getStorageProvider: vi.fn() }));

import { generation } from "@repo/database/schema";
import { planChargeSettlement } from "./credits/charge-outcome";
import {
  IMAGE_GENERATION_PENDING_TIMEOUT_MS,
  processGenerationRefundOutbox,
  recoverFailedGenerationRefunds,
  refundGenerationCredits,
  resolveImageGenerationTimeoutError,
} from "./generation-maintenance";
import { getFailedGenerationTargetCredits } from "./generation-settlement";

type RefundParams = Parameters<typeof refundGenerationCredits>[0];
type TimeoutRuntime = { timeout: () => Promise<{ creditsConsumed: number }> };
let ledger: ControlledLedger;
beforeEach(() => {
  vi.clearAllMocks();
  ledger = new ControlledLedger();
  state.database = ledger.database();
});

/** 从受审的 operations 实时提取原闭包，避免测试伪造一个已传对参数的 timeout 实现。 */
function loadRuntimeTimeout(
  refund: (params: RefundParams) => ReturnType<typeof refundGenerationCredits>
): TimeoutRuntime {
  const path = new URL(
    "../../../apps/web/src/features/image-generation/operations.ts",
    import.meta.url
  );
  const source = ts.createSourceFile(
    path.pathname,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const declarations = new Map<string, string>();
  const names = ["refundChargedCredits", "failTimedOutGeneration"];
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      names.includes(node.name.text)
    ) {
      if (declarations.has(node.name.text))
        throw new Error("Ambiguous runtime declaration");
      declarations.set(node.name.text, `const ${node.getText(source)};`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (declarations.size !== names.length)
    throw new Error("Runtime timeout source unavailable");
  const bindings = {
    db: ledger.database(),
    generation,
    and,
    eq,
    sql,
    generationId: "g1",
    input: { userId: "u1", prompt: "private-prompt" },
    billingPolicy: { chargesCredits: true },
    config: { backend: undefined },
    moderationFailureCredits: 4,
    creditCost: { moderationOnlyCredits: 4 },
    startedAt: Date.now() - IMAGE_GENERATION_PENDING_TIMEOUT_MS - 1,
    IMAGE_GENERATION_PENDING_TIMEOUT_MS,
    getFailedGenerationTargetCredits,
    resolveImageGenerationTimeoutError,
    relayOnly: false,
    repairAttempts: [],
    backendAttemptsForTimeout: undefined,
    roundCreditAmount: (amount: number) => Math.round(amount * 100) / 100,
    buildStreamTelemetryMetadata: () => ({}),
    withPromptRepairMetadata: (metadata: Record<string, unknown>) => metadata,
    isPendingGeneration: (id: string, userId: string) =>
      and(
        eq(generation.id, id),
        eq(generation.userId, userId),
        eq(generation.status, "pending")
      ),
    refundGenerationCredits: refund,
    planChargeSettlement,
  };
  const code = ts.transpileModule(
    `
    return (() => {
      let chargedCredits = 10;
      let unconfirmedCredits = 0;
      ${names.map((name) => declarations.get(name)).join("\n")}
      return { timeout: failTimedOutGeneration };
    })();
  `,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.None,
      },
    }
  ).outputText;
  // 仅运行本仓库以上两个可信闭包，不接受外部输入作为代码。
  return new Function(...Object.keys(bindings), code)(
    ...Object.values(bindings)
  ) as TimeoutRuntime;
}

/** 同一任务真实消费 10，原 Key 也被占用 10，另建历史投影以供终态恢复扫描。 */
function seedGeneration() {
  ledger.debit(10, "original-key");
  ledger.keys.set("original-key", {
    id: "original-key",
    user_id: "u1",
    credits_used: 10,
  });
  ledger.generations.push({
    id: "g1",
    user_id: "u1",
    status: "pending",
    credits_consumed: 10,
    created_at: "2020-01-01 00:00:00",
    metadata: {
      moderationFailureCredits: 4,
      creditCost: { moderationOnlyCredits: 4 },
    },
  });
}

/** 核对财务真相、Key 与失败历史投影均保留同一审核费，不能只检查单次退款额。 */
function expectRetainedFour() {
  expect(ledger.wallet).toBe(106);
  expect(ledger.keys.get("original-key")?.credits_used).toBe(4);
  expect(
    ledger.rows
      .filter((row) => row.type === "refund")
      .reduce((total, row) => total + Number(row.amount), 0)
  ).toBe(6);
  expect(ledger.generations[0]?.credits_consumed).toBe(4);
}

describe("R11 独立 review 阻断时序", () => {
  it("runtime timeout failed 提交后，恢复先退 6，runtime 随后不能把保留的 4 再退掉", async () => {
    seedGeneration();
    const runtimeRefund = vi.fn(async (params: RefundParams) => {
      expect(await recoverFailedGenerationRefunds()).toMatchObject({
        enqueued: 1,
        recoveryFailed: 0,
      });
      await processGenerationRefundOutbox();
      expect(ledger.wallet).toBe(106);
      return refundGenerationCredits(params);
    });
    const runtime = loadRuntimeTimeout(runtimeRefund);
    const result = await runtime.timeout();
    expectRetainedFour();
    expect(result.creditsConsumed).toBe(4);
    expect(runtimeRefund).toHaveBeenCalledWith(
      expect.objectContaining({ targetCredits: 4 })
    );
    expect(ledger.outbox.map((row) => Number(row.target_credits))).toEqual([
      4, 4,
    ]);
  });

  it.each([
    "settled",
    "pending",
  ])("旧 phase %s 已退 3 后，failed 新意图入库失败仍可补退 3", async (oldState) => {
    seedGeneration();
    ledger.failOutboxAck = oldState === "pending";
    const oldRefund = refundGenerationCredits({
      userId: "u1",
      generationId: "g1",
      sourceRef: "g1:old-phase",
      amount: 3,
      targetCredits: 7,
      description: "Old phase refund",
    });
    if (oldState === "pending") await expect(oldRefund).rejects.toThrow();
    else await oldRefund;
    ledger.failOutboxAck = false;
    expect(ledger.wallet).toBe(103);
    const row = ledger.generations[0];
    if (!row) throw new Error("Missing generation");
    row.status = "failed";
    row.credits_consumed = 7;
    row.metadata = {
      settlement: { targetCredits: 4 },
      moderationFailureCredits: 4,
      creditCost: { moderationOnlyCredits: 4 },
    };
    ledger.failOutboxInsert = true;
    await expect(
      refundGenerationCredits({
        userId: "u1",
        generationId: "g1",
        sourceRef: "g1:generation-error",
        amount: 3,
        targetCredits: 4,
        description: "Final failed phase refund",
      })
    ).rejects.toThrow();
    ledger.failOutboxInsert = false;
    const recovery = await recoverFailedGenerationRefunds();
    await processGenerationRefundOutbox({
      now: new Date(Date.now() + 3600000),
    });
    expectRetainedFour();
    expect(recovery).toEqual({ enqueued: 1, recoveryFailed: 0 });
    expect(await recoverFailedGenerationRefunds()).toEqual({
      enqueued: 0,
      recoveryFailed: 0,
    });
    expect(ledger.outbox.map((intent) => intent.source_ref).sort()).toEqual([
      "g1:failed-recovery-refund",
      "g1:old-phase",
    ]);
  });
});
