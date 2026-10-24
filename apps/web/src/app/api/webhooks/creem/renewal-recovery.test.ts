/** R12 实际 Creem POST 恢复回归；边界替换签名与 DB，不访问网关。 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  batch: null as Record<string, unknown> | null,
  periodEnd: "2026-09-02T12:00:00.000Z",
}));
const mocks = vi.hoisted(() => ({
  extend: vi.fn(),
  grant: vi.fn(async (input: Record<string, unknown>) => {
    state.batch = { id: "batch", metadata: input.metadata };
    return { batchId: "batch" };
  }),
  setting: vi.fn(async () => true),
}));
vi.mock("../../../../../../../packages/shared/src/payment/creem-state", () => ({
  projectCreemSubscription: async () => ({ userId: "u", projected: false }),
}));
vi.mock("@repo/database", () => ({
  db: {
    select: () => {
      let table = "";
      const q = {
        from: (value: { table: string }) => {
          table = value.table;
          return q;
        },
        where: () => q,
        limit: async () =>
          table === "ledger"
            ? state.batch
              ? [{ metadata: state.batch.metadata }]
              : []
            : table === "batch"
              ? state.batch
                ? [state.batch]
                : []
              : [{ userId: "u" }],
      };
      return q;
    },
    update: () => ({ set: () => ({ where: async () => {} }) }),
  },
}));
vi.mock("@repo/database/schema", () => ({
  creditsTransaction: {
    table: "ledger",
    metadata: "metadata",
    userId: "userId",
    type: "type",
  },
  creditsBatch: {
    table: "batch",
    id: "id",
    metadata: "metadata",
    sourceType: "sourceType",
    sourceRef: "sourceRef",
  },
  subscription: {
    table: "subscription",
    userId: "userId",
    subscriptionId: "subscriptionId",
  },
  user: { id: "id" },
}));
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({ "creem-signature": "verified-at-boundary" }),
}));
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  },
}));
vi.mock("@repo/shared/api-logger", () => ({
  withApiLogging: (handler: unknown) => handler,
}));
vi.mock("@repo/shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logError: vi.fn(),
  logEvent: vi.fn(),
}));
vi.mock("@repo/shared/config/payment-runtime", () => ({
  getSubscriptionMonthlyCredits: async () => ({ pro: 100 }),
  findRuntimePlanByPriceId: async () => ({ price: { amount: 60 } }),
}));
vi.mock("@repo/shared/config/subscription-plan", () => ({
  getPlanFromPriceId: () => "pro",
  isSubscriptionPlan: () => true,
}));
vi.mock("@repo/shared/credits/core", () => ({
  grantCredits: mocks.grant,
  extendActiveSubscriptionBatchesExpiry: mocks.extend,
}));
vi.mock("@repo/shared/credits/packages", () => ({
  getRuntimeCreditPackageById: vi.fn(),
  getCreditPackagePriceForPlan: vi.fn(),
}));
vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingBoolean: mocks.setting,
  getRuntimeSettingNumber: async () => 30,
}));
vi.mock("@repo/shared/payment/creem", async (original) => ({
  ...(await original<typeof import("@repo/shared/payment/creem")>()),
  constructRuntimeCreemEvent: async () => ({
    id: "event",
    created_at: 1792882800100,
    eventType: "subscription.renewed",
    object: {
      id: "sub",
      product: "pro_monthly",
      customer: "cust",
      current_period_start_date: "2026-08-02T12:00:00.000Z",
      current_period_end_date: state.periodEnd,
      status: "active",
      cancel_at_period_end: false,
    },
  }),
}));
// 红测使用原路由的隔离副本，不临时回退共享工作树中的 route.ts。
const target =
  process.env.R12_CREEM_BASELINE === "1" ? "./route-r12-baseline" : "./route";
const { POST } = (await import(target)) as typeof import("./route");
/** 真实 POST 返回值决定 provider 是否重投。 */
const post = () =>
  POST(
    new Request("https://test/api/webhooks/creem", {
      method: "POST",
      body: "signed",
      headers: { "creem-signature": "verified-at-boundary" },
    })
  );
beforeEach(() => {
  vi.clearAllMocks();
  state.batch = null;
  state.periodEnd = "2026-09-02T12:00:00.000Z";
  mocks.setting.mockResolvedValue(true);
  mocks.extend.mockReset().mockResolvedValue(2);
});
describe("Creem 续费 grant/顺延恢复", () => {
  it("grant 成功而顺延失败返回500；重投补顺延不双发", async () => {
    mocks.extend.mockRejectedValueOnce(new Error("extension unavailable"));
    expect((await post()).status).toBe(500);
    expect((await post()).status).toBe(200);
    expect(mocks.grant).toHaveBeenCalledTimes(1);
    expect(mocks.extend).toHaveBeenCalledTimes(2);
  });
  it("已有批次按首个 periodEnd 补顺延，不被重投数据推迟到期日", async () => {
    state.batch = {
      id: "batch",
      metadata: { periodEnd: "2026-09-02T12:00:00.000Z" },
    };
    state.periodEnd = "2026-09-09T12:00:00.000Z";
    expect((await post()).status).toBe(200);
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(mocks.extend).toHaveBeenCalledWith({
      userId: "u",
      subscriptionId: "sub",
      newExpiresAt: new Date("2026-09-02T12:00:00.000Z"),
    });
  });
  it("首个 grant 冻结顺延开关，失败后配置改关仍补承诺顺延", async () => {
    mocks.extend.mockRejectedValueOnce(new Error("temporary"));
    expect((await post()).status).toBe(500);
    mocks.setting.mockResolvedValue(false);
    expect((await post()).status).toBe(200);
    expect(mocks.extend).toHaveBeenCalledTimes(2);
    expect(mocks.grant).toHaveBeenCalledTimes(1);
  });
  it("开关关闭时已有批次不顺延", async () => {
    state.batch = { id: "batch" };
    mocks.setting.mockResolvedValue(false);
    expect((await post()).status).toBe(200);
    expect(mocks.extend).not.toHaveBeenCalled();
    expect(mocks.grant).not.toHaveBeenCalled();
  });
});
