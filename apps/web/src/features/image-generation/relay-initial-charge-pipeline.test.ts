/** 真实纯中转管线接线候选；上游与套餐为合成夹具，财务函数不替换。 */

import { recoverRelayInitialCharges } from "@repo/shared/relay-initial-charge";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { processGenerationRefundOutbox } from "../../../../../packages/shared/src/generation-refund-outbox";
import {
  RelayCaptureDatabase,
  refundDatabaseFromCapture,
} from "../../../../../packages/shared/src/test-support/relay-initial-charge-db";

const control = vi.hoisted(() => ({
  db: {} as object,
  upstreamCalls: 0,
  useCredits: true,
  moderationCalls: 0,
  enableModeration: false,
}));
vi.mock("@repo/database", () => ({
  db: new Proxy(
    {},
    {
      get: (_t, k) => {
        const value = Reflect.get(control.db, k);
        return typeof value === "function" ? value.bind(control.db) : value;
      },
    }
  ),
}));
vi.mock("@repo/shared/logger", () => ({
  logEvent: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("@repo/shared/moderation", () => ({
  isContentModerationEnabled: async () => control.enableModeration,
  moderateContent: async () => {
    control.moderationCalls++;
    return { decision: "allow" };
  },
}));
vi.mock("@repo/shared/storage/providers", () => ({
  getStorageProvider: async () => {
    throw new Error("Storage forbidden");
  },
}));
vi.mock("@repo/shared/subscription/services/user-plan", () => ({
  getUserPlan: async () => ({ plan: "pro" }),
}));
vi.mock("@repo/shared/subscription/services/plan-capabilities", () => ({
  getPlanCapabilitySnapshot: async () => ({
    features: new Proxy({}, { get: () => true }),
    limits: { maxBatchCount: 10, maxChatContextChars: 10000 },
    billing: { chatRoundCredits: 1, agentRoundCredits: 2 },
  }),
  getPlanQueueSettings: async () => ({
    priority: "normal",
    userConcurrency: 10,
  }),
  normalizePlanModerationBlockRiskLevel: async () => "low",
}));
vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingBoolean: async () => false,
  getRuntimeSettingNumber: async (_key: string, fallback: number) => fallback,
  getRuntimeSettingString: async () => "",
}));
vi.mock("@/features/image-backend-pool/service", () => ({
  ImageBackendPoolUnavailableError: class extends Error {},
  releaseImageBackendInflightLease: vi.fn(),
}));
vi.mock("@/features/image-generation/queue", () => ({
  estimateImageGenerationQueueBytes: () => 0,
  withImageGenerationQueue: async (_: unknown, run: () => Promise<unknown>) =>
    run(),
}));
vi.mock("@/features/image-generation/service", () => ({
  getUserApiConfig: async () => null,
  getEffectiveConfig: async () => ({
    useCredits: control.useCredits,
    config: {
      baseUrl: "https://offline.invalid",
      apiKey: "synthetic",
      backend: { type: "pool-api", id: "test-backend", billingMultiplier: 1 },
    },
  }),
  getResponsesModel: () => "gpt-image-2",
  poolBackendMemberType: () => "responses",
  generateImage: async () => {
    control.upstreamCalls++;

    return {
      imageBase64: "c3ludGhldGlj",
      imageOutputs: [{ imageBase64: "c3ludGhldGlj" }],
    };
  },
}));
vi.mock("@/features/image-generation/generated-image", () => ({
  readGeneratedImage: async () => {
    const buffer = Buffer.alloc(24);
    buffer.writeUInt32BE(0x89504e47, 0);
    buffer.writeUInt32BE(0x0d0a1a0a, 4);
    buffer.writeUInt32BE(1024, 16);
    buffer.writeUInt32BE(1024, 20);
    return buffer;
  },
}));
vi.mock("@/features/image-generation/image-restoration", () => ({}));
vi.mock("@/features/image-generation/resolution-calibration", () => ({}));
vi.mock("@/features/image-generation/transparent-fallback", () => ({
  isTransparentUnsupportedError: () => false,
}));

import { runImageGenerationForUser } from "@/features/image-generation/operations";

let ledger: RelayCaptureDatabase;
beforeEach(() => {
  ledger = new RelayCaptureDatabase();
  control.db = ledger.database();
  control.upstreamCalls = 0;
  control.useCredits = true;
  control.moderationCalls = 0;
  control.enableModeration = false;
  vi.stubGlobal("fetch", () => {
    throw new Error("Network forbidden");
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});
const input = {
  mode: "generate" as const,
  userId: "u1",
  apiKeyId: "k1",
  generationId: "pipeline-task",
  relayOnly: true,
  asyncDelivery: true,
  prompt: "SYNTHETIC_PRIVATE_PROMPT",
  model: "gpt-image-2",
  size: "1024x1024",
  quality: "high" as const,
};
it("初始Key只随consume扣一次，dispatcher成功才调用上游，成功账本无prompt", async () => {
  const result = await runImageGenerationForUser(input);
  expect(result.error).toBeUndefined();
  expect(control.upstreamCalls).toBe(1);
  expect([...ledger.store.rows.values()][0]?.state).toBe("dispatched");
  expect(ledger.keys.get("k1")?.credits_used).toBe(result.creditsConsumed);
  expect(
    ledger.queries.filter((q) => q.text.startsWith('update "external_api_key"'))
  ).toHaveLength(1);
  expect(JSON.stringify(ledger.entries)).not.toContain(
    "SYNTHETIC_PRIVATE_PROMPT"
  );
});
it("零扣费沿既有政策执行，不创建消费或财务意图", async () => {
  control.useCredits = false;
  const result = await runImageGenerationForUser(input);
  expect(result.error).toBeUndefined();
  expect(control.upstreamCalls).toBe(1);
  expect(ledger.entries).toHaveLength(0);
  expect(ledger.store.rows.size).toBe(0);
});
it("dispatch过期拒绝时上游0次，保留captured给恢复，不独立释放已扣Key", async () => {
  ledger.store.now += 86_400_000;
  const result = await runImageGenerationForUser(input);
  expect(result.error).toContain("dispatch unavailable");
  expect(control.upstreamCalls).toBe(0);
  expect([...ledger.store.rows.values()][0]?.state).toBe("captured");
  expect(ledger.keys.get("k1")?.credits_used).toBe(result.creditsConsumed);
});
it("capture真实提交ACK丢失时上游0次，Key/钱包/intent一致持久", async () => {
  ledger.store.loseCaptureAck = true;
  const result = await runImageGenerationForUser(input);
  expect(result.error).toBeDefined();
  expect(control.upstreamCalls).toBe(0);
  expect([...ledger.store.rows.values()][0]?.state).toBe("captured");
  expect(ledger.keys.get("k1")?.credits_used).toBe(1.27);
  expect(ledger.wallets.get("u1")?.balance).toBe(998.73);
});
it("dispatch ACK丢失时上游0次且不把dispatched改回captured", async () => {
  ledger.store.loseDispatchAck = true;
  const result = await runImageGenerationForUser(input);
  expect(result.error).toContain("dispatch unavailable");
  expect(control.upstreamCalls).toBe(0);
  expect([...ledger.store.rows.values()][0]?.state).toBe("dispatched");
});

/** 在真实COMMIT完成之后暂停ACK；此时资金/marker已可被另一数据库会话读取。 */
function holdCaptureAck() {
  let committed = () => {};
  let release = () => {};
  const reached = new Promise<void>((resolve) => {
    committed = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    release = resolve;
  });
  ledger.store.afterCaptureCommit = async () => {
    committed();
    await resumed;
  };
  return { reached, release };
}

it("capture成功ACK迟到：期间过期退款，await返回后审核/上游均0次", async () => {
  control.enableModeration = true;
  const gate = holdCaptureAck();
  const running = runImageGenerationForUser(input);
  await gate.reached;
  expect(ledger.activeTransactions).toBe(0);
  expect(ledger.entries).toHaveLength(1);
  expect(
    (ledger.entries[0]?.metadata as Record<string, unknown>)
      .chargeModerationCredits
  ).toBe(true);
  const intent = [...ledger.store.rows.values()][0];
  expect(intent?.state).toBe("captured");
  const refund = refundDatabaseFromCapture(ledger);
  control.db = refund.database();
  // 仅推进DB时钟，原worker本地时间保持未到期，确保判定依赖DB而非本地timeout。
  refund.store.now = new Date(String(intent?.expires_at)).getTime() + 1;
  try {
    expect(await recoverRelayInitialCharges()).toMatchObject({
      enqueued: 1,
      failed: 0,
    });
    await processGenerationRefundOutbox({
      now: new Date(Date.now() + 3_600_000),
    });
    expect(refund.wallet).toBe(1000);
    expect(refund.keys.get("k1")?.credits_used).toBe(0);
    expect(refund.outbox[0]?.state).toBe("settled");
  } finally {
    gate.release();
  }
  const result = await running;
  expect(control.upstreamCalls).toBe(0);
  expect(control.moderationCalls).toBe(0);
  expect(result.error).toContain("dispatch unavailable");
  expect(refund.store.rows.get(String(intent?.id))?.state).toBe(
    "refund_enqueued"
  );
  expect(refund.outbox).toHaveLength(1);
  expect(refund.wallet).toBe(1000);
});

it("capture成功ACK迟到：DB已到期但未扫描，captured也不能开始工作", async () => {
  control.enableModeration = true;
  const gate = holdCaptureAck();
  const running = runImageGenerationForUser(input);
  await gate.reached;
  const intent = [...ledger.store.rows.values()][0];
  ledger.store.now = new Date(String(intent?.expires_at)).getTime();
  gate.release();
  const result = await running;
  expect(control.upstreamCalls).toBe(0);
  expect(control.moderationCalls).toBe(0);
  expect(result.error).toContain("dispatch unavailable");
  expect(intent?.state).toBe("captured");
});

it("capture ACK晚19分钟：expiresAt不变，signal仅剩原20分钟预算的1分钟", async () => {
  const startedAt = Date.now();
  let now = startedAt;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockImplementation(() => new AbortController().signal);
  const gate = holdCaptureAck();
  const running = runImageGenerationForUser(input);
  await gate.reached;
  const intent = [...ledger.store.rows.values()][0];
  expect(new Date(String(intent?.expires_at)).getTime()).toBe(
    startedAt + 1_200_000
  );
  now += 1_140_000;
  ledger.store.now = now;
  gate.release();
  const result = await running;
  expect(result.error).toBeUndefined();
  expect(control.upstreamCalls).toBe(1);
  expect(intent?.state).toBe("dispatched");
  expect(new Date(String(intent?.expires_at)).getTime()).toBe(
    startedAt + 1_200_000
  );
  expect(timeout).toHaveBeenCalledWith(60_000);
  expect(timeout).not.toHaveBeenCalledWith(1_200_000);
});
