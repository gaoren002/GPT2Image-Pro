/** 真实统一编排的任务认领回归：数据库/账本/上游为替身，不执行外呼。 */
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  failInsert: false,
  ledger: new Map<string, number>(),
  upstream: vi.fn(),
  debit: vi.fn(),
  updates: [] as Array<{ values: Record<string, unknown>; condition: unknown }>,
}));
vi.mock("@repo/database", () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [] }) }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        const insert = (ignoreConflict: boolean) => {
          if (state.failInsert)
            throw Object.assign(new Error("database unavailable"), {
              code: "08006",
            });
          const id = String(values.id);
          if (state.rows.has(id)) {
            if (ignoreConflict) return [];
            throw Object.assign(new Error("duplicate primary key"), {
              code: "23505",
            });
          }
          state.rows.set(id, { ...values });
          return [{ id }];
        };
        return {
          // biome-ignore lint/suspicious/noThenProperty: 真实Drizzle查询可await，复现旧实现的插入错误必须保留该契约。
          then: (
            resolve: (value: unknown) => void,
            reject: (error: unknown) => void
          ) => {
            try {
              resolve(insert(false));
            } catch (error) {
              reject(error);
            }
          },
          onConflictDoNothing: () => ({ returning: async () => insert(true) }),
        };
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (condition: unknown) => {
          state.updates.push({ values, condition });
          const statement = new PgDialect().sqlToQuery(condition as SQL);
          const id = statement.params.find(
            (param) => typeof param === "string" && state.rows.has(param)
          ) as string | undefined;
          const row = id ? state.rows.get(id) : undefined;
          if (row) Object.assign(row, values);
          const result = Promise.resolve(row ? [{ id }] : []);
          return Object.assign(result, {
            returning: async () => (row ? [{ id }] : []),
          });
        },
      }),
    }),
  },
}));
vi.mock("@repo/shared/logger", () => ({ logWarn: vi.fn(), logError: vi.fn() }));
vi.mock("@repo/shared/credits/core", () => ({ consumeCredits: state.debit }));
vi.mock("@repo/shared/generation-maintenance", () => ({
  IMAGE_GENERATION_PENDING_TIMEOUT_MS: 1_200_000,
  refundGenerationCredits: vi.fn(async () => undefined),
  resolveImageGenerationTimeoutError: () => "timeout",
}));
vi.mock("@repo/shared/moderation", () => ({
  isContentModerationEnabled: async () => false,
}));
vi.mock("@repo/shared/storage/providers", () => ({
  getStorageProvider: async () => ({ putObject: vi.fn(async () => undefined) }),
}));
vi.mock("@repo/shared/subscription/services/user-plan", () => ({
  getUserPlan: async () => ({ plan: "pro" }),
}));
vi.mock("@repo/shared/subscription/services/plan-capabilities", () => ({
  getPlanCapabilitySnapshot: async () => ({
    features: new Proxy({}, { get: () => true }),
    limits: { maxBatchCount: 10, maxChatContextChars: 10000 },
    billing: { chatRoundCredits: 1, agentRoundCredits: 1 },
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
  releaseImageBackendInflightLease: vi.fn(async () => undefined),
}));
vi.mock("@/features/external-api/quota", () => ({
  reserveExternalApiKeyCredits: vi.fn(async () => undefined),
  refundExternalApiKeyCredits: vi.fn(async () => undefined),
}));
vi.mock("./queue", () => ({
  estimateImageGenerationQueueBytes: () => 65536,
  withImageGenerationQueue: async (
    _options: unknown,
    run: () => Promise<unknown>
  ) => run(),
}));
vi.mock("./service", () => ({
  getUserApiConfig: async () => null,
  getEffectiveConfig: async () => ({
    config: {
      baseUrl: "https://upstream.example/v1",
      apiKey: "fake-key",
      backend: { type: "pool-api" },
    },
    useCredits: true,
  }),
  getResponsesModel: async () => undefined,
  poolBackendMemberType: () => "api",
  generateImage: state.upstream,
}));
vi.mock("./generated-image", () => ({
  readGeneratedImage: async () => {
    const buffer = Buffer.alloc(24);
    buffer.writeUInt32BE(0x89504e47, 0);
    buffer.writeUInt32BE(0x0d0a1a0a, 4);
    buffer.writeUInt32BE(1024, 16);
    buffer.writeUInt32BE(1024, 20);
    return buffer;
  },
}));
vi.mock("./image-restoration", () => ({}));
vi.mock("./resolution-calibration", () => ({}));
vi.mock("./transparent-fallback", () => ({
  isTransparentUnsupportedError: () => false,
}));

import { runImageGenerationForUser } from "./operations";

const input = {
  mode: "generate" as const,
  userId: "owner",
  generationId: "client-task",
  prompt: "circle",
  size: "1024x1024",
};
beforeEach(() => {
  state.rows.clear();
  state.updates.length = 0;
  state.failInsert = false;
  state.upstream.mockReset().mockResolvedValue({ imageBase64: "aW1hZ2U=" });
  state.ledger.clear();
  state.debit
    .mockReset()
    .mockImplementation(
      async (params: { userId: string; sourceRef: string; amount: number }) => {
        const key = `${params.userId}:${params.sourceRef}`;
        if (state.ledger.has(key))
          return {
            success: true,
            consumedAmount: state.ledger.get(key),
            alreadyConsumed: true,
          };
        state.ledger.set(key, params.amount);
        return { success: true, consumedAmount: params.amount };
      }
    );
  vi.stubEnv("BETTER_AUTH_SECRET", "admission-test-secret");
});

describe("统一生成任务原子认领", () => {
  it("重复ID第二次在扣费和上游调用前被拒绝", async () => {
    expect((await runImageGenerationForUser(input)).error).toBeUndefined();
    const debitCalls = state.debit.mock.calls.length;
    const replay = await runImageGenerationForUser({
      ...input,
      prompt: "square",
    });
    expect(replay.error).toMatch(/already|conflict|in use/i);
    expect(state.upstream).toHaveBeenCalledTimes(1);
    expect(state.debit).toHaveBeenCalledTimes(debitCalls);
  });

  it("历史已删除仍不能把旧账本扣费当作本次扣费继续执行", async () => {
    expect((await runImageGenerationForUser(input)).error).toBeUndefined();
    state.rows.delete(input.generationId);
    const result = await runImageGenerationForUser(input);
    expect(result.error).toMatch(/already|conflict|in use/i);
    expect(state.upstream).toHaveBeenCalledTimes(1);
  });

  it("客户端ID不能占用结算键的冒号命名空间", async () => {
    const result = await runImageGenerationForUser({
      ...input,
      generationId: "fresh:image-actual-size",
    });
    expect(result.error).toMatch(/invalid|task id/i);
    expect(state.upstream).not.toHaveBeenCalled();
    expect(state.debit).not.toHaveBeenCalled();
  });

  it("同ID并发至多一次调用上游", async () => {
    const results = await Promise.all([
      runImageGenerationForUser(input),
      runImageGenerationForUser(input),
    ]);
    expect(results.filter((result) => !result.error)).toHaveLength(1);
    expect(state.upstream).toHaveBeenCalledTimes(1);
  });

  it("他人的pending记录不能被覆盖，不产生扣费", async () => {
    const victim = {
      id: input.generationId,
      userId: "victim",
      status: "pending",
      prompt: "private",
    };
    state.rows.set(input.generationId, { ...victim });
    expect((await runImageGenerationForUser(input)).error).toMatch(
      /already|conflict|in use/i
    );
    expect(state.rows.get(input.generationId)).toEqual(victim);
    expect(state.updates).toHaveLength(0);
    expect(state.upstream).not.toHaveBeenCalled();
    expect(state.debit).not.toHaveBeenCalled();
  });

  it("记录写入不可用时失败关闭，不能无记录调用收费上游", async () => {
    state.failInsert = true;
    expect((await runImageGenerationForUser(input)).error).toBeTruthy();
    expect(state.upstream).not.toHaveBeenCalled();
    expect(state.debit).not.toHaveBeenCalled();
  });
});
