/** 普通 Epay 领取/fencing 契约：执行真实持久化函数并编译 Drizzle 谓词，无数据库连接。 */
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  writes: [] as Record<string, unknown>[],
  predicates: [] as unknown[],
  results: [] as unknown[][],
  rows: [] as unknown[],
}));
vi.mock("@repo/database", () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        state.writes.push(values);
        return {
          where: (where: unknown) => {
            state.predicates.push(where);
            const rows = state.results.shift() ?? [];
            return Object.assign(Promise.resolve(rows), {
              returning: async () => rows,
            });
          },
        };
      },
    }),
    select: () => {
      const q = {
        from: () => q,
        where: (where: unknown) => {
          state.predicates.push(where);
          return q;
        },
        orderBy: () => q,
        limit: async () => state.rows,
      };
      return q;
    },
  },
}));

import {
  claimEpayOrderForFulfillment,
  type EpayVerifyResult,
  finalizeEpayOrderFulfillment,
  listRecoverableEpayPayments,
  releaseEpayFulfillmentLease,
  renewEpayFulfillmentLease,
  saveEpayFulfillmentPlan,
} from "./epay";

const paidAt = new Date("2026-08-02T12:00:00Z");
const payment: EpayVerifyResult = {
  outTradeNo: "order",
  tradeNo: "gateway",
  verifyStatus: true,
  tradeStatus: "TRADE_SUCCESS",
  money: "60.00",
  type: "alipay",
  name: "",
  raw: {},
};
const plan = {
  credits: 10,
  monthlyCredits: 10,
  periodStart: paidAt.toISOString(),
  periodEnd: "2026-09-02T12:00:00.000Z",
  expiresAt: "2026-09-02T12:00:00.000Z",
  extendExpiry: true,
};
/** 编译生产使用的 WHERE，确保 OR、归属和 lease 条件未被替身吞掉。 */
function query(index: number) {
  return new PgDialect().sqlToQuery(state.predicates[index] as SQL);
}
beforeEach(() => {
  state.writes = [];
  state.predicates = [];
  state.results = [[{ state: "pending" }], [{ paidAt, plan: null }]];
  state.rows = [];
});
describe("普通 Epay 持久收款和 lease", () => {
  it("领取只记录收款和 lease，不提前标 success，并保留首次时点", async () => {
    const claim = await claimEpayOrderForFulfillment("order", payment);
    expect(claim.state).toBe("claimed");
    if (claim.state !== "claimed") throw new Error("not claimed");
    expect(claim.lease.paidAt).toEqual(paidAt);
    expect(state.writes.some((write) => write.status === "success")).toBe(
      false
    );
    const first = state.writes[0]?.paidAt as SQL;
    expect(new PgDialect().sqlToQuery(first).sql).toContain(
      'COALESCE("epay_order"."paid_at", CURRENT_TIMESTAMP)'
    );
    expect(state.writes[1]?.fulfillmentLeaseToken).toBe(claim.lease.token);
    expect(query(1).sql).toContain(
      '"fulfillment_lease_expires_at" <= CURRENT_TIMESTAMP'
    );
  });
  it("旧无流水后台重放不捏造 paidAmount，真实回调仍可补充实付事实", async () => {
    await claimEpayOrderForFulfillment("order", {
      ...payment,
      tradeNo: "",
      type: "",
    });
    const paid = new PgDialect().sqlToQuery(state.writes[0]?.paidAmount as SQL);
    expect(paid.sql).toContain('THEN "epay_order"."paid_amount"');
    expect(paid.params).toEqual(["", 60]);
    const method = new PgDialect().sqlToQuery(
      state.writes[0]?.paymentMethod as SQL
    );
    expect(method.sql).toContain("NULLIF");
  });
  it("先收款已持久化但另一 worker 已占 lease 时返回 busy", async () => {
    state.results = [[{ state: "processing" }], []];
    expect(await claimEpayOrderForFulfillment("order", payment)).toEqual({
      state: "busy",
    });
    expect(state.writes).toHaveLength(2);
  });
  it("finalize 已提交的重投直接识别 fulfilled，不再领取", async () => {
    state.results = [[{ state: "fulfilled" }]];
    expect(await claimEpayOrderForFulfillment("order", payment)).toEqual({
      state: "fulfilled",
    });
    expect(state.writes).toHaveLength(1);
  });
  it("receipt 金额、流水、upgrade guard 均在同一个持久事实 UPDATE 内校验", async () => {
    await claimEpayOrderForFulfillment("order", payment);
    const receipt = query(0);
    expect(receipt.sql).toContain("BETWEEN ROUND(");
    expect(receipt.sql).toContain("payment_trade_no");
    expect(receipt.sql).toContain("paid_amount");
    expect(receipt.sql).toContain(
      "NOT EXISTS (SELECT 1 FROM upgrade_reservation"
    );
    expect(receipt.sql).toContain("checkoutMode");
    expect(receipt.params).toContain("gateway");
    expect(receipt.params).toContain(6000);
  });
  it.each([
    { ...payment, verifyStatus: false },
    { ...payment, tradeStatus: "WAIT" },
    { ...payment, money: "NaN" },
  ])("拒绝非法支付事实不写库", async (bad) => {
    await expect(claimEpayOrderForFulfillment("order", bad)).rejects.toThrow(
      "Invalid"
    );
    expect(state.writes).toEqual([]);
  });
  it("流水或订单不匹配不能领取", async () => {
    state.results = [[]];
    await expect(
      claimEpayOrderForFulfillment("order", payment)
    ).rejects.toThrow("mismatch");
    expect(state.writes).toHaveLength(1);
  });
  it("冻结计划只允许当前未过期 token，并 COALESCE 保留首计划", async () => {
    state.results = [[{ plan }]];
    expect(await saveEpayFulfillmentPlan("order", "current", plan)).toEqual(
      plan
    );
    expect(query(0).sql).toContain(
      '"fulfillment_lease_expires_at" > CURRENT_TIMESTAMP'
    );
    expect(query(0).params).toContain("current");
    expect(
      new PgDialect().sqlToQuery(state.writes[0]?.fulfillmentPlan as SQL).sql
    ).toContain("COALESCE");
  });
  it("过期 token 不能续租、写计划或 finalize", async () => {
    state.results = [[], [], []];
    await expect(renewEpayFulfillmentLease("order", "old")).rejects.toThrow(
      "lease lost"
    );
    await expect(saveEpayFulfillmentPlan("order", "old", plan)).rejects.toThrow(
      "lease lost"
    );
    await expect(finalizeEpayOrderFulfillment("order", "old")).rejects.toThrow(
      "lease lost"
    );
    for (let i = 0; i < 3; i++) {
      expect(query(i).params).toContain("old");
      expect(query(i).sql).toContain("fulfillment_lease_token");
    }
  });
  it("仅 finalize 才设置 success/fulfilled，旧 release 也带 token fence", async () => {
    state.results = [[{ outTradeNo: "order" }], []];
    await finalizeEpayOrderFulfillment("order", "current");
    await releaseEpayFulfillmentLease("order", "old");
    expect(state.writes[0]).toMatchObject({
      status: "success",
      fulfillmentState: "fulfilled",
      fulfillmentLeaseToken: null,
    });
    expect(query(1).params).toContain("old");
    expect(state.writes[1]?.status).toBeUndefined();
  });
  it("恢复扫描只选已收款且未完成的到期 lease，旧无流水不编造 gateway receipt", async () => {
    state.rows = [
      {
        outTradeNo: "legacy",
        amount: 60,
        paidAmount: 60,
        paymentTradeNo: null,
        paymentMethod: null,
      },
    ];
    const payments = await listRecoverableEpayPayments();
    expect(payments[0]).toMatchObject({
      outTradeNo: "legacy",
      tradeNo: "",
      money: "60",
    });
    expect(query(0).sql).toContain('"paid_at" IS NOT NULL');
    expect(query(0).sql).toContain("refund_pending");
    expect(query(0).sql).toContain("<> 'fulfilled'");
    expect(query(0).sql).toContain("upgrade_reservation");
  });
});
