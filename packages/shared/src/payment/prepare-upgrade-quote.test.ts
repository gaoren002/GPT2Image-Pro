/** 冷配置读取与事务连接隔离回归：禁止事务内 global DB/settings I/O。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createUpgradeReservationService,
  type UpgradeStore,
} from "./upgrade-reservation-service";

const state = vi.hoisted(() => ({
  inTransaction: false,
  reads: 0,
  concurrentReads: 0,
}));
const config = vi.hoisted(() => ({
  plans: {
    starter: {
      prices: [{ priceId: "starter_monthly", amount: 20, interval: "monthly" }],
    },
    pro: {
      prices: [{ priceId: "pro_monthly", amount: 50, interval: "monthly" }],
    },
  },
}));
vi.mock("../config/payment-runtime", () => ({
  getRuntimePaymentConfig: async () => {
    if (state.inTransaction) throw new Error("global DB read in transaction");
    state.reads++;
    state.concurrentReads++;
    await Promise.resolve();
    state.concurrentReads--;
    return structuredClone(config);
  },
  getSubscriptionMonthlyCredits: async () => {
    if (state.inTransaction) throw new Error("global DB read in transaction");
    state.reads++;
    await Promise.resolve();
    return { starter: 5000, pro: 20000, ultra: 80000, enterprise: 320000 };
  },
}));

import { prepareUpgradeQuote } from "./prepare-upgrade-quote";

const now = new Date("2026-01-01T00:00:00Z");
const current = {
  id: "sub",
  userId: "u",
  subscriptionId: "sub",
  priceId: "starter_monthly",
  status: "active",
  cancelAtPeriodEnd: false,
  currentPeriodStart: now,
  currentPeriodEnd: new Date("2026-02-01T00:00:00Z"),
};
beforeEach(() => {
  state.inTransaction = false;
  state.reads = 0;
  state.concurrentReads = 0;
});
describe("prepared upgrade pricing", () => {
  it("performs cold configuration reads before acquiring a transaction connection", async () => {
    const store: UpgradeStore = {
      findOrder: async () => null,
      expired: async () => [],
      transaction: async () => {
        state.inTransaction = true;
        expect(state.reads).toBe(2);
        expect(state.concurrentReads).toBe(0);
        throw new Error("transaction reached");
      },
    };
    const service = createUpgradeReservationService(store, prepareUpgradeQuote);
    await expect(
      service.reserve({
        userId: "u",
        targetPriceId: "pro_monthly",
        clientRequestId: "r",
      })
    ).rejects.toThrow("transaction reached");
  });
  it("calculates synchronously inside a transaction without any configuration access", async () => {
    const calculate = await prepareUpgradeQuote("pro_monthly");
    state.inTransaction = true;
    const quote = calculate(current, 5000, now);
    expect(quote).not.toBeInstanceOf(Promise);
    expect(quote.amountDue).toBe(30);
    expect(quote.targetCredits).toBe(20000);
    expect(state.reads).toBe(2);
  });
  it("prepares twenty cold requests without holding a connection during global reads", async () => {
    const calculators = await Promise.all(
      Array.from({ length: 20 }, () => prepareUpgradeQuote("pro_monthly"))
    );
    state.inTransaction = true;
    expect(
      calculators.map((calculate) => calculate(current, 500, now).amountDue)
    ).toEqual(Array(20).fill(48));
    expect(state.reads).toBe(40);
    expect(state.concurrentReads).toBe(0);
  });
  it("freezes configuration values before the lock and uses the locked current subscription", async () => {
    const calculate = await prepareUpgradeQuote("pro_monthly");
    state.inTransaction = true;
    expect(calculate(current, 0, now).amountDue).toBe(50);
    expect(() =>
      calculate({ ...current, priceId: "pro_monthly" }, 5000, now)
    ).toThrow("只能升级");
  });
});
