/** 首屏快照契约：成功结果字段白名单、失败回退及 next-safe-action 的服务端直接调用。 */
import { createSafeActionClient } from "next-safe-action";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  getPlanCapabilitySnapshot,
  type PlanCapabilitySnapshot,
} from "@repo/shared/subscription/services/plan-capabilities";
import { buildExternalApiKeyInitialSnapshot } from "./external-api-key-snapshot";

vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingJson: async () => undefined,
  getRuntimeSettingNumber: async (_key: string, fallback: number) => fallback,
}));

let capabilities: PlanCapabilitySnapshot;
beforeAll(async () => {
  capabilities = await getPlanCapabilitySnapshot("pro");
});

const key = {
  id: "key-1",
  name: "Primary",
  keyPrefix: "g2i_prefix",
  lastFour: "1234",
  moderationBlockRiskLevel: "high" as const,
  generationGroupId: null,
  creditLimit: 100,
  creditsUsed: 20,
  relayOnly: true,
  asyncTaskMode: true,
  lastUsedAt: new Date("2026-10-23T00:00:00Z"),
  isActive: true,
  createdAt: new Date("2026-10-22T00:00:00Z"),
};

/** 与现有套餐 action 相同的数据形状，能力对象由真实默认矩阵构造。 */
function planResult() {
  return {
    data: {
      plan: "pro" as const,
      planName: "Pro",
      capabilities,
      hasActiveSubscription: true,
      currentPeriodEnd: null,
      priceId: null,
      cancelAtPeriodEnd: false,
    },
  };
}

describe("buildExternalApiKeyInitialSnapshot", () => {
  it("只序列化 Key 摘要和原套餐能力，Date 转 ISO，丢弃额外秘密字段", () => {
    const unsafeKey = { ...key, apiKey: "RAW_SECRET", keyHash: "HASH_SECRET" };
    const snapshot = buildExternalApiKeyInitialSnapshot(
      { data: { keys: [unsafeKey], groups: [], canUseRelay: true } },
      planResult()
    );
    expect(snapshot?.keys[0]).toMatchObject({
      keyPrefix: "g2i_prefix",
      lastFour: "1234",
      asyncTaskMode: true,
      lastUsedAt: "2026-10-23T00:00:00.000Z",
      createdAt: "2026-10-22T00:00:00.000Z",
    });
    expect(snapshot?.capabilities).toEqual(capabilities);
    expect(JSON.stringify(snapshot)).not.toMatch(/RAW_SECRET|HASH_SECRET/);
  });

  it("任一受保护查询失败时不生成快照，让原客户端查询处理错误与重试", () => {
    expect(
      buildExternalApiKeyInitialSnapshot(
        { serverError: "access denied" },
        planResult()
      )
    ).toBeUndefined();
    expect(
      buildExternalApiKeyInitialSnapshot(
        { data: { keys: [key], groups: [], canUseRelay: true } },
        { serverError: "session expired" }
      )
    ).toBeUndefined();
  });
});

describe("next-safe-action 8.5.5 服务端调用契约", () => {
  it("直接调用仍执行中间件，返回 data/Date，鉴权失败返回 serverError", async () => {
    let userId: string | null = "user-1";
    const client = createSafeActionClient({
      handleServerError: (error) => error.message,
    }).use(async ({ next }) => {
      if (!userId) throw new Error("session expired");
      return next({ ctx: { userId } });
    });
    const action = client.action(async ({ ctx }) => ({
      userId: ctx.userId,
      createdAt: key.createdAt,
    }));
    const success = await action();
    expect(success?.data?.userId).toBe("user-1");
    expect(success?.data?.createdAt).toBeInstanceOf(Date);
    userId = null;
    const failure = await action();
    expect(failure?.serverError).toBe("session expired");
    expect(failure?.data).toBeUndefined();
  });
});
