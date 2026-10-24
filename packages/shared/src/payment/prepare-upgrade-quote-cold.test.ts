/** 真实配置读取链路的冷缓存回归；仅替换 settings I/O，保留价格/能力矩阵和预留服务源码。 */
import { AsyncLocalStorage } from "node:async_hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createUpgradeReservationService,
  type UpgradeStore,
  type UpgradeTransaction,
} from "./upgrade-reservation-service";

const state = vi.hoisted(() => ({
  assertOutsideTransaction: () => {},
  reads: [] as string[],
  values: {} as Record<string, number>,
}));
vi.mock("../system-settings", () => {
  /** 每次调用都模拟一次冷读取；事务上下文内访问立即失败，不提供缓存绕路。 */
  async function read(key: string) {
    state.assertOutsideTransaction();
    state.reads.push(key);
    await Promise.resolve();
    state.assertOutsideTransaction();
  }
  return {
    getRuntimeSettingNumber: async (key: string, fallback: number) => {
      await read(key);
      return state.values[key] ?? fallback;
    },
    getRuntimeSettingString: async (key: string) => {
      await read(key);
      return "";
    },
    getRuntimeSettingSelect: async (
      key: string,
      _options: string[],
      fallback: string
    ) => {
      await read(key);
      return fallback;
    },
    getRuntimeSettingBoolean: async (key: string, fallback: boolean) => {
      await read(key);
      return fallback;
    },
    getRuntimeSettingJson: async (key: string) => {
      await read(key);
      return undefined;
    },
  };
});

import { prepareUpgradeQuote } from "./prepare-upgrade-quote";

const transactionContext = new AsyncLocalStorage<boolean>();
const now = new Date("2026-01-01T00:00:00Z");
const end = new Date("2026-02-01T00:00:00Z");
/** 没有命中的未用 store 方法应明确失败，防止测试意外偏离预留下单路径。 */
async function unused(): Promise<never> {
  throw new Error("unexpected transaction method");
}
/** 仅模拟事务上下文；本文件验证的是 I/O 所在上下文，不替代父代理的 PG 并发验收。 */
function contextStore(): UpgradeStore {
  return {
    findOrder: unused,
    expired: unused,
    transaction: (userId, run) =>
      transactionContext.run(true, async () => {
        const tx: UpgradeTransaction = {
          getRequest: async () => null,
          getHeld: async () => null,
          getSubscription: async () => ({
            id: userId,
            userId,
            subscriptionId: `old:${userId}`,
            priceId: "starter_monthly",
            status: "active",
            cancelAtPeriodEnd: false,
            currentPeriodStart: now,
            currentPeriodEnd: end,
          }),
          takeBatches: async () => [
            {
              id: userId,
              amount: 5000,
              issuedAt: now.toISOString(),
              expiresAt: end.toISOString(),
            },
          ],
          moveBalance: async () => {},
          saveOrder: async () => {},
          saveReservation: async () => {},
          linkRequest: async () => {},
          ledger: async () => {},
          getReservation: unused,
          getOrder: unused,
          saveSubscription: unused,
          restoreBatches: unused,
          freezeGrant: unused,
          grant: unused,
        };
        return run(tx);
      }),
  };
}
beforeEach(() => {
  state.reads = [];
  state.values = {
    PLAN_PRO_MONTHLY_AMOUNT: 50,
    PLAN_PRO_MONTHLY_CREDITS: 20000,
  };
  state.assertOutsideTransaction = () => {
    if (transactionContext.getStore())
      throw new Error("global settings I/O inside transaction");
  };
});
describe("real runtime pricing cold configuration", () => {
  it("runs the actual runtime price and capability reads before the reservation transaction", async () => {
    const service = createUpgradeReservationService(
      contextStore(),
      prepareUpgradeQuote,
      () => now
    );
    const { reservation } = await service.reserve({
      userId: "u",
      targetPriceId: "pro_monthly",
      clientRequestId: "r",
    });
    expect(reservation.snapshot.quote.amountDue).toBe(30);
    expect(reservation.snapshot.targetCredits).toBe(20000);
    expect(state.reads).toContain("PLAN_STARTER_MONTHLY_AMOUNT");
    expect(state.reads).toContain("PLAN_PRO_MONTHLY_AMOUNT");
    expect(state.reads).toContain("PLAN_PRO_MONTHLY_CREDITS");
  });
  it("handles twelve concurrent uncached preparations with no settings I/O in any transaction context", async () => {
    const service = createUpgradeReservationService(
      contextStore(),
      prepareUpgradeQuote,
      () => now
    );
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        service.reserve({
          userId: `user:${index}`,
          targetPriceId: "pro_monthly",
          clientRequestId: `r:${index}`,
        })
      )
    );
    expect(
      results.map((result) => result.reservation.snapshot.quote.amountDue)
    ).toEqual(Array(12).fill(30));
    expect(
      state.reads.filter((key) => key === "PLAN_PRO_MONTHLY_AMOUNT")
    ).toHaveLength(12);
  });
  it("honors the prepared value snapshot if settings change before the lock is acquired", async () => {
    const calculate = await prepareUpgradeQuote("pro_monthly");
    const before = state.reads.length;
    state.values.PLAN_PRO_MONTHLY_AMOUNT = 800;
    state.values.PLAN_PRO_MONTHLY_CREDITS = 99999;
    const quote = transactionContext.run(true, () =>
      calculate(
        {
          id: "u",
          userId: "u",
          subscriptionId: "old",
          priceId: "starter_monthly",
          status: "active",
          cancelAtPeriodEnd: false,
          currentPeriodStart: now,
          currentPeriodEnd: end,
        },
        5000,
        now
      )
    );
    expect(quote).not.toBeInstanceOf(Promise);
    expect(quote.amountDue).toBe(30);
    expect(quote.targetCredits).toBe(20000);
    expect(state.reads).toHaveLength(before);
  });
});
