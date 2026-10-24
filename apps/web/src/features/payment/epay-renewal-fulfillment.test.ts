/** 普通订单多阶段恢复；service 使用持久化替身，实际执行履约编排与订阅投影。 */

import type {
  EpayFulfillmentPlan,
  EpayMetadata,
  EpayVerifyResult,
} from "@repo/shared/payment/epay";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  paidAt: new Date("2026-08-02T12:00:00Z"),
  plan: null as EpayFulfillmentPlan | null,
  batch: null as Record<string, unknown> | null,
  receipt: null as Record<string, unknown> | null,
  sub: null as Record<string, unknown> | null,
  metadata: {} as EpayMetadata,
  done: false,
  busy: false,
  token: "",
  claims: 0,
  failGrantResponse: false,
  failProjection: false,
  failFinalize: false,
  failFinalizeResponse: false,
  events: [] as string[],
}));
const mocks = vi.hoisted(() => ({
  grant: vi.fn(async (input: Record<string, unknown>) => {
    state.events.push("grant");
    state.batch ??= {
      id: "batch",
      amount: input.amount,
      issuedAt: state.paidAt,
      expiresAt: input.expiresAt,
      metadata: input.metadata,
    };
    if (state.failGrantResponse) {
      state.failGrantResponse = false;
      throw new Error("grant response lost");
    }
    return { batchId: "batch" };
  }),
  extend: vi.fn(async () => {
    state.events.push("extend");
    return 2;
  }),
  settle: vi.fn(async () => ({ metadata: state.metadata })),
  setting: vi.fn(async () => true),
  list: vi.fn(async () => [] as EpayVerifyResult[]),
  claim: vi.fn(async () => {
    if (state.done) return { state: "fulfilled" as const };
    if (state.busy) return { state: "busy" as const };
    state.token = `lease-${++state.claims}`;
    return {
      state: "claimed" as const,
      lease: { token: state.token, paidAt: state.paidAt, plan: state.plan },
    };
  }),
  finalize: vi.fn(async () => {
    state.events.push("finalize");
    if (state.failFinalize) {
      state.failFinalize = false;
      throw new Error("finalize failed");
    }
    state.done = true;
    if (state.failFinalizeResponse) {
      state.failFinalizeResponse = false;
      throw new Error("finalize response lost");
    }
  }),
  release: vi.fn(async () => {}),
}));
vi.mock("@repo/database/schema", () => ({
  creditsTransaction: {
    table: "ledger",
    metadata: "metadata",
    userId: "userId",
    type: "type",
    sourceRef: "sourceRef",
  },
  creditsBatch: {
    table: "batch",
    id: "id",
    sourceRef: "ref",
    sourceType: "type",
  },
  subscription: {
    table: "subscription",
    id: "id",
    userId: "user",
    subscriptionId: "subscriptionId",
  },
  epayOrder: {},
}));
vi.mock("@repo/database", () => {
  const db = {
    execute: vi.fn(async () => {}),
    select: () => {
      let table = "";
      const result = () =>
        table === "ledger"
          ? state.receipt
            ? [state.receipt]
            : state.batch
              ? [
                  {
                    metadata: state.batch.metadata,
                    amount: state.batch.amount,
                    createdAt: state.batch.issuedAt,
                  },
                ]
              : []
          : table === "batch"
            ? state.batch
              ? [state.batch]
              : []
            : state.sub
              ? [state.sub]
              : [];
      const q = {
        from: (value: { table: string }) => {
          table = value.table;
          return q;
        },
        where: () => q,
        limit: () =>
          Object.assign(Promise.resolve(result()), {
            for: async () => result(),
          }),
      };
      return q;
    },
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          state.events.push("projection");
          if (state.failProjection) {
            state.failProjection = false;
            throw new Error("projection failed");
          }
          state.sub = { ...state.sub, ...values };
        },
      }),
    }),
    insert: () => ({
      values: async (values: Record<string, unknown>) => {
        state.events.push("projection");
        if (state.failProjection) {
          state.failProjection = false;
          throw new Error("projection failed");
        }
        state.sub = values;
      },
    }),
  };
  return {
    db: {
      ...db,
      transaction: async (run: (tx: typeof db) => Promise<void>) => run(db),
    },
  };
});
vi.mock("@repo/shared/config/payment-runtime", () => ({
  findRuntimePlanByPriceId: vi.fn(async () => ({
    plan: { id: "pro" },
    price: { amount: 60, interval: "monthly" },
  })),
  getSubscriptionMonthlyCredits: vi.fn(async () => ({ pro: 17_143 })),
}));
vi.mock("@repo/shared/config/subscription-plan", () => ({
  getPlanFromPriceId: () => "pro",
  isPlanAtLeast: () => true,
  isSubscriptionPlan: () => true,
}));
vi.mock("@repo/shared/credits/core", () => ({
  grantCredits: mocks.grant,
  extendActiveSubscriptionBatchesExpiry: mocks.extend,
}));
vi.mock("@repo/shared/credits/packages", () => ({
  getRuntimeCreditPackageById: async () => ({
    id: "pack",
    credits: 100,
    price: 60,
  }),
  getCreditPackagePriceForPlan: () => 60,
}));
vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingNumber: async () => 30,
  getRuntimeSettingBoolean: mocks.setting,
}));
vi.mock("@repo/shared/subscription/services/user-plan", () => ({
  getUserPlanType: async () => "pro",
}));
vi.mock("@repo/shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
  logEvent: vi.fn(),
}));
vi.mock("@repo/shared/payment/upgrade-reservation", () => ({
  settleUpgradePayment: mocks.settle,
}));
vi.mock("@repo/shared/payment/epay", async (original) => ({
  ...(await original<typeof import("@repo/shared/payment/epay")>()),
  getEpayOrderMetadata: async () => state.metadata,
  updateEpayOrderStatus: vi.fn(),
  claimEpayOrderForFulfillment: mocks.claim,
  listRecoverableEpayPayments: mocks.list,
  saveEpayFulfillmentPlan: async (
    _id: string,
    _token: string,
    plan: EpayFulfillmentPlan
  ) => {
    state.plan ??= structuredClone(plan);
    return state.plan;
  },
  renewEpayFulfillmentLease: vi.fn(async () => {}),
  finalizeEpayOrderFulfillment: mocks.finalize,
  releaseEpayFulfillmentLease: mocks.release,
}));

import {
  fulfillSuccessfulEpayPayment,
  recoverEpayFulfillments,
} from "./epay-fulfillment";

const NOW = new Date("2026-08-02T12:00:00.000Z");
const END = new Date("2026-09-02T12:00:00.000Z");
/** 相同网关事实可从异步通知或回跳重放。 */
function payment(): EpayVerifyResult {
  return {
    verifyStatus: true,
    type: "alipay",
    tradeNo: "gateway",
    outTradeNo: "order",
    name: "",
    money: "60.00",
    tradeStatus: "TRADE_SUCCESS",
    raw: {},
  };
}
/** 失败重投延后一周，验证不会重算周期。 */
async function replay() {
  vi.setSystemTime(new Date("2026-08-09T12:00:00Z"));
  await fulfillSuccessfulEpayPayment(payment(), "epay-webhook");
}
describe("普通 Epay 恢复", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    Object.assign(state, {
      paidAt: NOW,
      plan: null,
      batch: null,
      receipt: null,
      sub: { id: "sub-row", subscriptionId: "old" },
      done: false,
      busy: false,
      claims: 0,
      failGrantResponse: false,
      failProjection: false,
      failFinalize: false,
      failFinalizeResponse: false,
      events: [],
    });
    state.metadata = {
      type: "subscription",
      userId: "u",
      outTradeNo: "order",
      priceId: "pro_monthly",
      checkoutMode: "renewal",
      expectedAmount: 60,
    };
    mocks.setting.mockResolvedValue(true);
    mocks.extend.mockReset().mockImplementation(async () => {
      state.events.push("extend");
      return 2;
    });
  });
  afterEach(() => vi.useRealTimers());
  it("新周期 grant/顺延/订阅全部完成才 finalize，同单不双发", async () => {
    await fulfillSuccessfulEpayPayment(payment(), "epay-webhook");
    await fulfillSuccessfulEpayPayment(payment(), "epay-return");
    expect(state.events).toEqual(["grant", "extend", "projection", "finalize"]);
    expect(state.sub).toMatchObject({
      subscriptionId: "epay_order",
      currentPeriodStart: NOW,
      currentPeriodEnd: END,
    });
    expect(mocks.grant).toHaveBeenCalledTimes(1);
    expect(state.done).toBe(true);
  });
  it("R12 grant 提交后顺延失败，重投仍补顺延并保持首周期", async () => {
    mocks.extend.mockRejectedValueOnce(new Error("extension unavailable"));
    await expect(
      fulfillSuccessfulEpayPayment(payment(), "epay-webhook")
    ).rejects.toThrow("extension unavailable");
    expect(state.done).toBe(false);
    await replay();
    expect(mocks.grant).toHaveBeenCalledTimes(1);
    expect(mocks.extend).toHaveBeenCalledTimes(2);
    expect(mocks.extend).toHaveBeenLastCalledWith({
      userId: "u",
      subscriptionId: "epay_order",
      newExpiresAt: END,
    });
    expect(state.sub).toMatchObject({
      currentPeriodStart: NOW,
      currentPeriodEnd: END,
    });
  });
  it.each([
    "failGrantResponse",
    "failProjection",
    "failFinalize",
  ] as const)("%s 后重投收敛且不双 grant", async (failure) => {
    state[failure] = true;
    await expect(
      fulfillSuccessfulEpayPayment(payment(), "epay-webhook")
    ).rejects.toThrow();
    await replay();
    expect(state.done).toBe(true);
    expect(mocks.grant).toHaveBeenCalledTimes(1);
    expect(state.plan?.periodEnd).toBe(END.toISOString());
  });
  it("finalize 提交响应丢失，重投不重做任何副作用", async () => {
    state.failFinalizeResponse = true;
    await expect(
      fulfillSuccessfulEpayPayment(payment(), "epay-webhook")
    ).rejects.toThrow("finalize response lost");
    const events = [...state.events];
    await replay();
    expect(state.events).toEqual(events);
  });
  it("进程在 plan 提交之后丢失，接管复用计划与首次收款时间", async () => {
    state.plan = {
      credits: 17_143,
      monthlyCredits: 17_143,
      periodStart: NOW.toISOString(),
      periodEnd: END.toISOString(),
      expiresAt: END.toISOString(),
      extendExpiry: true,
    };
    await replay();
    expect(state.sub).toMatchObject({
      currentPeriodStart: NOW,
      currentPeriodEnd: END,
    });
    expect(mocks.grant).toHaveBeenCalledTimes(1);
  });
  it("旧 success 已有 grant 无 receipt/plan，仅补顺延与订阅不重发", async () => {
    state.batch = {
      id: "legacy-batch",
      amount: 17_143,
      issuedAt: NOW,
      expiresAt: new Date("2026-12-01Z"),
      metadata: {
        periodStart: NOW.toISOString(),
        periodEnd: END.toISOString(),
      },
    };
    await replay();
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(mocks.extend).toHaveBeenCalledWith({
      userId: "u",
      subscriptionId: "epay_order",
      newExpiresAt: END,
    });
    expect(state.sub?.currentPeriodEnd).toEqual(END);
  });
  it("旧 success 批次已清理但账本仍证明 grant，不再发放", async () => {
    state.receipt = {
      amount: 17_143,
      createdAt: NOW,
      metadata: {
        periodStart: NOW.toISOString(),
        periodEnd: END.toISOString(),
        sourceRef: "epay_subscription:order",
      },
    };
    await replay();
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(state.done).toBe(true);
  });
  it("旧积分包仅剩发放账本也不重新 grant", async () => {
    state.metadata = {
      type: "credit_purchase",
      userId: "u",
      outTradeNo: "order",
      packageId: "pack",
    };
    state.receipt = { amount: 100, metadata: { sourceRef: "epay:order" } };
    await replay();
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(state.done).toBe(true);
  });
  it("旧 success 没有 grant 才补发，周期从旧 claim 时点起算", async () => {
    await replay();
    expect(mocks.grant).toHaveBeenCalledOnce();
    expect(state.plan?.periodStart).toBe(NOW.toISOString());
  });
  it("旧订单恢复不能覆盖更晚的订阅", async () => {
    state.sub = {
      id: "sub-row",
      subscriptionId: "newer",
      currentPeriodStart: new Date("2026-08-05Z"),
      currentPeriodEnd: new Date("2026-09-05Z"),
    };
    await replay();
    expect(state.sub.subscriptionId).toBe("newer");
    expect(state.done).toBe(true);
  });
  it("忙 lease 返回可重试失败，不向网关假报已履约", async () => {
    state.busy = true;
    await expect(
      fulfillSuccessfulEpayPayment(payment(), "epay-webhook")
    ).rejects.toThrow("in progress");
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(mocks.finalize).not.toHaveBeenCalled();
  });
  it("新购订阅与续费使用同一恢复路径", async () => {
    state.metadata.checkoutMode = "new_subscription";
    state.sub = null;
    await replay();
    expect(state.sub).toMatchObject({
      subscriptionId: "epay_order",
      currentPeriodStart: NOW,
    });
  });
  it("普通积分包在 grant 响应丢失后不双发或重新延长到期日", async () => {
    state.metadata = {
      type: "credit_purchase",
      userId: "u",
      outTradeNo: "order",
      packageId: "pack",
    };
    state.failGrantResponse = true;
    await expect(
      fulfillSuccessfulEpayPayment(payment(), "epay-webhook")
    ).rejects.toThrow();
    const expiry = state.plan?.expiresAt;
    await replay();
    expect(mocks.grant).toHaveBeenCalledTimes(1);
    expect(state.plan?.expiresAt).toBe(expiry);
    expect(state.done).toBe(true);
  });
  it("旧积分包 success 已有批次，只 finalize 不重新发放", async () => {
    state.metadata = {
      type: "credit_purchase",
      userId: "u",
      outTradeNo: "order",
      packageId: "pack",
    };
    state.batch = { id: "old-pack" };
    await replay();
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(state.done).toBe(true);
  });
  it("冻结顺延开关，关闭时不顺延", async () => {
    mocks.setting.mockResolvedValue(false);
    await replay();
    expect(mocks.extend).not.toHaveBeenCalled();
  });
  it("后台扫描失败单不阻断其余单，成功 finalize 后可收敛", async () => {
    mocks.list.mockResolvedValueOnce([
      { ...payment(), outTradeNo: "bad-order" },
      payment(),
    ]);
    expect(await recoverEpayFulfillments(10)).toEqual({
      scanned: 2,
      fulfilled: 1,
      failed: 1,
    });
    expect(mocks.list).toHaveBeenCalledWith(10);
    expect(state.done).toBe(true);
  });
  it("R08 upgrade 原样由专用 settle 处理，普通 claim 不介入", async () => {
    state.metadata.checkoutMode = "upgrade";
    await replay();
    expect(mocks.settle).toHaveBeenCalledWith(payment());
    expect(mocks.claim).not.toHaveBeenCalled();
  });
});
