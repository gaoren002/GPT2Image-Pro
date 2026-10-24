/** 同用户年/月普通订单交错履约：执行真实编排，持久化替身只提供故障与重投边界；不模拟 PG 调度。 */
import type {
  EpayFulfillmentPlan,
  EpayMetadata,
  EpayVerifyResult,
} from "@repo/shared/payment/epay";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type OrderState = {
  metadata: EpayMetadata;
  paidAt: Date | null;
  plan: EpayFulfillmentPlan | null;
  batch: Record<string, unknown> | null;
  receipt: Record<string, unknown> | null;
  done: boolean;
};
const state = vi.hoisted(() => ({
  orders: new Map<string, OrderState>(),
  activeId: "",
  sub: null as Record<string, unknown> | null,
  failExtendFor: "",
  failFinalizeFor: "",
  projectionWrites: 0,
  inTransaction: false,
}));
const mocks = vi.hoisted(() => ({
  lock: vi.fn(async (_query: unknown) => {}),
  grant: vi.fn(async (input: Record<string, unknown>) => {
    expect(state.inTransaction).toBe(false);
    const sourceRef = String(input.sourceRef);
    const order = state.orders.get(sourceRef.replace("epay_subscription:", ""));
    if (!order) throw new Error("unknown grant order");
    if (!order.batch) {
      order.batch = {
        id: sourceRef,
        amount: input.amount,
        issuedAt: order.paidAt,
        expiresAt: input.expiresAt,
      };
      order.receipt = {
        amount: input.amount,
        metadata: input.metadata,
        createdAt: order.paidAt,
      };
    }
    return { batchId: sourceRef };
  }),
  extend: vi.fn(async (input: { subscriptionId: string }) => {
    expect(state.inTransaction).toBe(false);
    if (input.subscriptionId === `epay_${state.failExtendFor}`) {
      state.failExtendFor = "";
      throw new Error("extension unavailable");
    }
    return 1;
  }),
}));
vi.mock("@repo/database/schema", () => ({
  creditsBatch: {
    table: "batch",
    id: "id",
    sourceRef: "sourceRef",
    sourceType: "sourceType",
  },
  creditsTransaction: {
    table: "ledger",
    metadata: "metadata",
    userId: "userId",
    type: "type",
    sourceRef: "sourceRef",
  },
  subscription: { table: "subscription", id: "id", userId: "userId" },
  epayOrder: {},
}));
vi.mock("@repo/database", () => {
  const db = {
    execute: mocks.lock,
    select: () => {
      let table = "";
      const rows = () => {
        const order = state.orders.get(state.activeId);
        if (table === "batch") return order?.batch ? [order.batch] : [];
        if (table === "ledger") return order?.receipt ? [order.receipt] : [];
        return state.sub ? [state.sub] : [];
      };
      const query = {
        from: (value: { table: string }) => {
          table = value.table;
          return query;
        },
        where: () => query,
        limit: () =>
          Object.assign(Promise.resolve(rows()), { for: async () => rows() }),
      };
      return query;
    },
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          state.projectionWrites++;
          state.sub = { ...state.sub, ...values };
        },
      }),
    }),
    insert: () => ({
      values: async (values: Record<string, unknown>) => {
        state.projectionWrites++;
        state.sub = values;
      },
    }),
  };
  return {
    db: {
      ...db,
      transaction: async (run: (tx: typeof db) => Promise<void>) => {
        state.inTransaction = true;
        try {
          await run(db);
        } finally {
          state.inTransaction = false;
        }
      },
    },
  };
});
vi.mock("@repo/shared/config/payment-runtime", () => ({
  findRuntimePlanByPriceId: async (priceId: string) => ({
    plan: { id: "pro" },
    price: {
      amount: priceId.endsWith("yearly") ? 600 : 60,
      interval: priceId.endsWith("yearly") ? "yearly" : "monthly",
    },
  }),
  getSubscriptionMonthlyCredits: async () => ({ pro: 17_143 }),
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
  getRuntimeSettingNumber: async () => 30,
  getRuntimeSettingBoolean: async () => true,
}));
vi.mock("@repo/shared/subscription/services/user-plan", () => ({
  getUserPlanType: async () => "pro",
}));
vi.mock("@repo/shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
  logEvent: vi.fn(),
}));
vi.mock("@repo/shared/payment/upgrade-reservation", () => ({
  settleUpgradePayment: vi.fn(),
}));
vi.mock("@repo/shared/payment/epay", async (original) => ({
  ...(await original<typeof import("@repo/shared/payment/epay")>()),
  getEpayOrderMetadata: async (id: string) => {
    state.activeId = id;
    return state.orders.get(id)?.metadata ?? null;
  },
  updateEpayOrderStatus: vi.fn(),
  claimEpayOrderForFulfillment: async (id: string) => {
    const order = state.orders.get(id);
    if (!order) throw new Error("unknown order");
    if (order.done) return { state: "fulfilled" };
    order.paidAt ??= new Date();
    return {
      state: "claimed",
      lease: { token: id, paidAt: order.paidAt, plan: order.plan },
    };
  },
  saveEpayFulfillmentPlan: async (
    id: string,
    _token: string,
    plan: EpayFulfillmentPlan
  ) => {
    const order = state.orders.get(id);
    if (!order) throw new Error("unknown order");
    order.plan ??= structuredClone(plan);
    return order.plan;
  },
  renewEpayFulfillmentLease: vi.fn(async () => {}),
  finalizeEpayOrderFulfillment: async (id: string) => {
    if (id === state.failFinalizeFor) {
      state.failFinalizeFor = "";
      throw new Error("finalize unavailable");
    }
    const order = state.orders.get(id);
    if (!order) throw new Error("unknown order");
    order.done = true;
  },
  releaseEpayFulfillmentLease: vi.fn(async () => {}),
}));

import { fulfillSuccessfulEpayPayment } from "./epay-fulfillment";

/** 预先创建两张订单；尚无订阅，因此都属于普通新购，不走 upgrade。 */
function prepareOrders() {
  for (const interval of ["yearly", "monthly"]) {
    const id = `${interval}-order`;
    state.orders.set(id, {
      metadata: {
        type: "subscription",
        userId: "same-user",
        outTradeNo: id,
        priceId: `pro_${interval}`,
        checkoutMode: "new_subscription",
        expectedAmount: interval === "yearly" ? 600 : 60,
      },
      paidAt: null,
      plan: null,
      batch: null,
      receipt: null,
      done: false,
    });
  }
}
/** 可信通知在给定时间首次接收，之后重投沿用原 paidAt/plan。 */
async function deliver(interval: "yearly" | "monthly", time: string) {
  vi.setSystemTime(new Date(time));
  await deliverOrder(`${interval}-order`, time);
}
/** 按订单保存的金额重投，支持相同套餐/期末的稳定裁决回归。 */
async function deliverOrder(id: string, time: string) {
  vi.setSystemTime(new Date(time));
  const payment: EpayVerifyResult = {
    outTradeNo: id,
    tradeNo: `gateway:${id}`,
    verifyStatus: true,
    tradeStatus: "TRADE_SUCCESS",
    money: String(state.orders.get(id)?.metadata.expectedAmount),
    type: "alipay",
    name: "",
    raw: {},
  };
  await fulfillSuccessfulEpayPayment(payment, "epay-webhook");
}
/** 确认两笔收款各自履约一次，不能以保护投影为由丢掉 grant。 */
function expectBothFulfilled() {
  expect(state.orders.get("yearly-order")?.done).toBe(true);
  expect(state.orders.get("monthly-order")?.done).toBe(true);
  expect(mocks.grant).toHaveBeenCalledTimes(2);
  expect(
    mocks.grant.mock.calls.map(([input]) => input.sourceRef).sort()
  ).toEqual([
    "epay_subscription:monthly-order",
    "epay_subscription:yearly-order",
  ]);
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  state.orders.clear();
  state.sub = null;
  state.activeId = "";
  state.failExtendFor = "";
  state.failFinalizeFor = "";
  state.projectionWrites = 0;
  state.inTransaction = false;
  prepareOrders();
});
afterEach(() => vi.useRealTimers());
describe("同用户年/月普通订单周期不缩短", () => {
  it("年付先履约，较晚月付不能把2027-08-01缩到2026-09-02，正反重投均保持", async () => {
    await deliver("yearly", "2026-08-01T12:00:00Z");
    const annual = structuredClone(state.sub);
    await deliver("monthly", "2026-08-02T12:00:00Z");
    expect(state.sub).toEqual(annual);
    expect(state.sub?.currentPeriodEnd).toEqual(
      new Date("2027-08-01T12:00:00Z")
    );
    await deliver("monthly", "2026-08-09T12:00:00Z");
    await deliver("yearly", "2026-08-10T12:00:00Z");
    expect(state.sub).toEqual(annual);
    expectBothFulfilled();
    expect(state.orders.get("monthly-order")?.plan?.periodEnd).toBe(
      "2026-09-02T12:00:00.000Z"
    );
    expect(state.projectionWrites).toBe(1);
  });
  it("月付先履约，较晚年付可延长；之后月付重投不改回短周期", async () => {
    await deliver("monthly", "2026-08-01T12:00:00Z");
    await deliver("yearly", "2026-08-02T12:00:00Z");
    const annual = structuredClone(state.sub);
    expect(state.sub).toMatchObject({
      subscriptionId: "epay_yearly-order",
      priceId: "pro_yearly",
      currentPeriodEnd: new Date("2027-08-02T12:00:00Z"),
    });
    await deliver("yearly", "2026-08-09T12:00:00Z");
    await deliver("monthly", "2026-08-10T12:00:00Z");
    expect(state.sub).toEqual(annual);
    expectBothFulfilled();
  });
  it("年付已生效，月付grant后顺延失败；跨周恢复不缩短且不双发", async () => {
    await deliver("yearly", "2026-08-01T12:00:00Z");
    const annual = structuredClone(state.sub);
    state.failExtendFor = "monthly-order";
    await expect(deliver("monthly", "2026-08-02T12:00:00Z")).rejects.toThrow(
      "extension unavailable"
    );
    const monthlyPlan = structuredClone(
      state.orders.get("monthly-order")?.plan
    );
    await deliver("yearly", "2026-08-03T12:00:00Z");
    await deliver("monthly", "2026-08-09T12:00:00Z");
    expect(state.sub).toEqual(annual);
    expectBothFulfilled();
    expect(state.orders.get("monthly-order")?.plan).toEqual(monthlyPlan);
    expect(state.orders.get("monthly-order")?.paidAt).toEqual(
      new Date("2026-08-02T12:00:00Z")
    );
    expect(mocks.extend).toHaveBeenLastCalledWith(
      expect.objectContaining({
        newExpiresAt: new Date("2026-09-02T12:00:00Z"),
      })
    );
  });
  it("月付已生效，年付grant后失败再恢复，沿首paidAt延长而非重投now", async () => {
    await deliver("monthly", "2026-08-01T12:00:00Z");
    state.failExtendFor = "yearly-order";
    await expect(deliver("yearly", "2026-08-02T12:00:00Z")).rejects.toThrow(
      "extension unavailable"
    );
    await deliver("monthly", "2026-08-03T12:00:00Z");
    await deliver("yearly", "2026-08-09T12:00:00Z");
    expect(state.sub).toMatchObject({
      subscriptionId: "epay_yearly-order",
      currentPeriodStart: new Date("2026-08-02T12:00:00Z"),
      currentPeriodEnd: new Date("2027-08-02T12:00:00Z"),
    });
    expectBothFulfilled();
  });
  it("年付投影已提交而finalize失败，月付插入后年付重投仍保留长周期", async () => {
    state.failFinalizeFor = "yearly-order";
    await expect(deliver("yearly", "2026-08-01T12:00:00Z")).rejects.toThrow(
      "finalize unavailable"
    );
    const annual = structuredClone(state.sub);
    await deliver("monthly", "2026-08-02T12:00:00Z");
    await deliver("yearly", "2026-08-09T12:00:00Z");
    expect(state.sub).toEqual(annual);
    expectBothFulfilled();
  });
  it("保护已结算R08长周期仍持相同用户锁，不让普通较晚起点缩短", async () => {
    state.sub = {
      id: "upgrade-row",
      userId: "same-user",
      subscriptionId: "epay_upgrade",
      priceId: "enterprise_yearly",
      currentPeriodStart: new Date("2026-08-01T12:00:00Z"),
      currentPeriodEnd: new Date("2027-08-01T12:00:00Z"),
    };
    const upgraded = structuredClone(state.sub);
    await deliver("monthly", "2026-08-02T12:00:00Z");
    expect(state.sub).toEqual(upgraded);
    const query = new PgDialect().sqlToQuery(
      mocks.lock.mock.calls[0]?.[0] as SQL
    );
    expect(query.sql).toContain("pg_advisory_xact_lock(20261025, hashtext(");
    expect(query.params).toEqual(["same-user"]);
  });
  it("independent recovery interleaving: earlier paid annual fails before projection, later monthly completes, annual recovers", async () => {
    state.failExtendFor = "yearly-order";
    await expect(deliver("yearly", "2026-08-01T12:00:00Z")).rejects.toThrow(
      "extension unavailable"
    );
    const frozenAnnual = structuredClone(
      state.orders.get("yearly-order")?.plan
    );
    await deliver("monthly", "2026-08-02T12:00:00Z");
    await deliver("yearly", "2026-08-09T12:00:00Z");
    expectBothFulfilled();
    expect(state.orders.get("yearly-order")?.plan).toEqual(frozenAnnual);
    expect(state.orders.get("yearly-order")?.paidAt).toEqual(
      new Date("2026-08-01T12:00:00Z")
    );
    console.log(
      "EARLIER_ANNUAL_RECOVERY",
      JSON.stringify({
        projection: state.sub,
        annualPlan: frozenAnnual,
        bothFulfilled: true,
        grants: mocks.grant.mock.calls.length,
      })
    );
    expect(state.sub?.currentPeriodEnd).toEqual(
      new Date("2027-08-01T12:00:00Z")
    );
  });

  it("independent dual order: earlier monthly fails before projection, later annual completes, monthly recovers", async () => {
    state.failExtendFor = "monthly-order";
    await expect(deliver("monthly", "2026-08-01T12:00:00Z")).rejects.toThrow(
      "extension unavailable"
    );
    const frozenMonth = structuredClone(
      state.orders.get("monthly-order")?.plan
    );
    await deliver("yearly", "2026-08-02T12:00:00Z");
    const annual = structuredClone(state.sub);
    await deliver("monthly", "2026-08-09T12:00:00Z");
    expectBothFulfilled();
    expect(state.sub).toEqual(annual);
    expect(state.sub?.currentPeriodEnd).toEqual(
      new Date("2027-08-02T12:00:00Z")
    );
    expect(state.orders.get("monthly-order")?.plan).toEqual(frozenMonth);
    expect(state.orders.get("monthly-order")?.paidAt).toEqual(
      new Date("2026-08-01T12:00:00Z")
    );
    await deliver("yearly", "2026-08-10T12:00:00Z");
    await deliver("monthly", "2026-08-11T12:00:00Z");
    expect(state.sub).toEqual(annual);
    expectBothFulfilled();
  });
  it("independent equal anchor: same paidAt cannot reject the farther annual end after recovery", async () => {
    state.failExtendFor = "yearly-order";
    await expect(deliver("yearly", "2026-08-01T12:00:00Z")).rejects.toThrow(
      "extension unavailable"
    );
    const frozenAnnual = structuredClone(
      state.orders.get("yearly-order")?.plan
    );
    await deliver("monthly", "2026-08-01T12:00:00Z");
    await deliver("yearly", "2026-08-09T12:00:00Z");
    expectBothFulfilled();
    expect(state.sub?.currentPeriodEnd).toEqual(
      new Date("2027-08-01T12:00:00Z")
    );
    expect(state.orders.get("yearly-order")?.plan).toEqual(frozenAnnual);
    expect(state.orders.get("yearly-order")?.paidAt).toEqual(
      new Date("2026-08-01T12:00:00Z")
    );
  });
  it("不同tier较低长单不能延长高级套餐，也不能假标fulfilled", async () => {
    state.sub = {
      id: "upgrade-row",
      userId: "same-user",
      subscriptionId: "epay_upgrade",
      priceId: "enterprise_monthly",
      currentPeriodStart: new Date("2026-08-02T12:00:00Z"),
      currentPeriodEnd: new Date("2026-09-02T12:00:00Z"),
    };
    const upgraded = structuredClone(state.sub);
    await expect(deliver("yearly", "2026-08-01T12:00:00Z")).rejects.toThrow(
      "subscription tier/period conflict"
    );
    const frozen = structuredClone(state.orders.get("yearly-order")?.plan);
    await expect(deliver("yearly", "2026-08-09T12:00:00Z")).rejects.toThrow(
      "subscription tier/period conflict"
    );
    expect(state.sub).toEqual(upgraded);
    expect(state.orders.get("yearly-order")?.done).toBe(false);
    expect(state.orders.get("yearly-order")?.plan).toEqual(frozen);
    expect(mocks.grant).toHaveBeenCalledTimes(1);
  });
  it("同end按较晚start裁决，较早年付恢复不改变已覆盖的同tier投影", async () => {
    state.failExtendFor = "yearly-order";
    await expect(deliver("yearly", "2025-08-02T12:00:00Z")).rejects.toThrow(
      "extension unavailable"
    );
    await deliver("monthly", "2026-07-02T12:00:00Z");
    const current = structuredClone(state.sub);
    await deliver("yearly", "2026-07-09T12:00:00Z");
    expect(state.sub).toEqual(current);
    expect(state.sub?.currentPeriodEnd).toEqual(
      new Date("2026-08-02T12:00:00Z")
    );
    expectBothFulfilled();
  });
  it.each([
    ["a-order", "z-order"],
    ["z-order", "a-order"],
  ])("同end同paidAt使用订单ID稳定裁决：%s→%s", async (first, second) => {
    for (const id of [first, second]) {
      state.orders.set(id, {
        metadata: {
          type: "subscription",
          userId: "same-user",
          outTradeNo: id,
          priceId: "pro_monthly",
          checkoutMode: "new_subscription",
          expectedAmount: 60,
        },
        paidAt: null,
        plan: null,
        batch: null,
        receipt: null,
        done: false,
      });
    }
    await deliverOrder(first, "2026-08-01T12:00:00Z");
    await deliverOrder(second, "2026-08-01T12:00:00Z");
    expect(state.sub?.subscriptionId).toBe("epay_z-order");
    expect(state.sub?.currentPeriodEnd).toEqual(
      new Date("2026-09-01T12:00:00Z")
    );
    expect(mocks.grant).toHaveBeenCalledTimes(2);
  });
});
