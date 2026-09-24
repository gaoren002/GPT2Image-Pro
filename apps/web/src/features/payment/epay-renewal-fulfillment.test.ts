import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  selectResults: [] as unknown[][],
  updatedSubscription: null as Record<string, unknown> | null,
}));
const claimOrder = vi.hoisted(() => vi.fn());
const grantCredits = vi.hoisted(() => vi.fn());
const voidSubscriptionCredits = vi.hoisted(() => vi.fn());

const dbMock = vi.hoisted(() => ({
  select: vi.fn(() => {
    const result = state.selectResults.shift() ?? [];
    const builder = {
      from: vi.fn(),
      where: vi.fn(),
      limit: vi.fn(async () => result),
    };
    builder.from.mockReturnValue(builder);
    builder.where.mockReturnValue(builder);
    return builder;
  }),
  update: vi.fn(() => ({
    set: vi.fn((values: Record<string, unknown>) => {
      state.updatedSubscription = values;
      return { where: vi.fn(async () => []) };
    }),
  })),
  insert: vi.fn(),
}));

vi.mock("@repo/database", () => ({ db: dbMock }));
vi.mock("@repo/database/schema", () => ({
  creditsBatch: {
    id: "credits_batch.id",
    issuedAt: "credits_batch.issued_at",
    sourceRef: "credits_batch.source_ref",
    sourceType: "credits_batch.source_type",
  },
  subscription: {
    id: "subscription.id",
    userId: "subscription.user_id",
    subscriptionId: "subscription.subscription_id",
  },
  epayOrder: {},
}));
vi.mock("@repo/shared/config/payment-runtime", () => ({
  findRuntimePlanByPriceId: vi.fn(async () => ({
    plan: { id: "pro" },
    price: { amount: 60, interval: "monthly" },
  })),
  getSubscriptionMonthlyCredits: vi.fn(async () => ({
    starter: 5_000,
    pro: 17_143,
    ultra: 66_666,
    enterprise: 266_666,
  })),
}));
vi.mock("@repo/shared/config/subscription-plan", () => ({
  getPlanFromPriceId: vi.fn(() => "pro"),
  isPlanAtLeast: vi.fn(),
  isSubscriptionPlan: vi.fn(),
}));
vi.mock("@repo/shared/credits/core", () => ({
  grantCredits,
  voidActiveSubscriptionCreditsForUpgrade: voidSubscriptionCredits,
  extendActiveSubscriptionBatchesExpiry: vi
    .fn()
    .mockResolvedValue(0),
}));
vi.mock("@repo/shared/credits/packages", () => ({
  getCreditPackagePriceForPlan: vi.fn(),
  getRuntimeCreditPackageById: vi.fn(),
}));
vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingNumber: vi.fn(),
  // 续费顺延默认关闭；需要开启的用例在自身内覆写返回值。
  getRuntimeSettingBoolean: vi.fn().mockResolvedValue(false),
}));
vi.mock("@repo/shared/subscription/services/user-plan", () => ({
  getUserPlanType: vi.fn(),
}));
vi.mock("@repo/shared/logger", () => ({
  logger: { info: vi.fn() },
  logEvent: vi.fn(),
}));
vi.mock("@repo/shared/payment/epay", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@repo/shared/payment/epay")>();
  return {
    ...actual,
    claimEpayOrderForFulfillment: claimOrder,
    getEpayOrderMetadata: vi.fn(),
    updateEpayOrderStatus: vi.fn(),
  };
});

import {
  type EpayVerifyResult,
  encodeEpayMetadata,
} from "@repo/shared/payment/epay";

import { fulfillSuccessfulEpayPayment } from "./epay-fulfillment";
import { extendActiveSubscriptionBatchesExpiry } from "@repo/shared/credits/core";
import { getRuntimeSettingBoolean } from "@repo/shared/system-settings";

const NOW = new Date("2026-08-02T12:00:00.000Z");

function renewalPayment(): EpayVerifyResult {
  return {
    verifyStatus: true,
    type: "alipay",
    tradeNo: "gateway-1",
    outTradeNo: "renewal-1",
    name: "GPT2IMAGE renew Pro monthly",
    money: "60.00",
    tradeStatus: "TRADE_SUCCESS",
    param: encodeEpayMetadata({
      type: "subscription",
      userId: "user-1",
      outTradeNo: "renewal-1",
      priceId: "pro_monthly",
      planId: "pro",
      checkoutMode: "renewal",
      expectedAmount: 60,
      originalAmount: 60,
    }),
    raw: {},
  };
}

describe("Epay current-plan renewal fulfillment", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    state.updatedSubscription = null;
    state.selectResults = [[], [{ id: "existing-subscription-row" }], []];
    claimOrder.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    grantCredits.mockResolvedValue({ batchId: "renewal-batch" });
  });

  it("restarts the period, grants a full credit batch, and remains idempotent", async () => {
    const payment = renewalPayment();

    await fulfillSuccessfulEpayPayment(payment, "epay-webhook");
    await fulfillSuccessfulEpayPayment(payment, "epay-return");

    const periodEnd = new Date("2026-09-02T12:00:00.000Z");
    expect(state.updatedSubscription).toMatchObject({
      subscriptionId: "epay_renewal-1",
      priceId: "pro_monthly",
      currentPeriodStart: NOW,
      currentPeriodEnd: periodEnd,
    });
    expect(grantCredits).toHaveBeenCalledTimes(1);
    expect(grantCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        amount: 17_143,
        sourceType: "subscription",
        expiresAt: periodEnd,
        sourceRef: "epay_subscription:renewal-1",
        metadata: expect.objectContaining({
          checkoutMode: "renewal",
          periodStart: NOW.toISOString(),
          periodEnd: periodEnd.toISOString(),
        }),
      })
    );
    expect(voidSubscriptionCredits).not.toHaveBeenCalled();
    expect(claimOrder).toHaveBeenCalledTimes(2);
    // 默认（设置关闭）不触发续费顺延
    expect(extendActiveSubscriptionBatchesExpiry).not.toHaveBeenCalled();
  });

  it("extends existing subscription batches expiry when the setting is enabled", async () => {
    vi.mocked(getRuntimeSettingBoolean).mockResolvedValue(true);
    vi.mocked(extendActiveSubscriptionBatchesExpiry).mockResolvedValue(2);

    await fulfillSuccessfulEpayPayment(renewalPayment(), "epay-webhook");

    const periodEnd = new Date("2026-09-02T12:00:00.000Z");
    expect(extendActiveSubscriptionBatchesExpiry).toHaveBeenCalledWith({
      userId: "user-1",
      subscriptionId: "epay_renewal-1",
      newExpiresAt: periodEnd,
    });
  });
});
