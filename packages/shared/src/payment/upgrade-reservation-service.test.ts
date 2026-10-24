/** R08 生命周期回归。事务 store 模拟原子提交/回滚，批次条件与 PostgreSQL adapter 一致。 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  createUpgradeReservationService,
  type ReservedBatch,
  type UpgradeOrder,
  type UpgradeReservation,
  type UpgradeStore,
  type UpgradeSubscription,
  type UpgradeTransaction,
} from "./upgrade-reservation-service";

type Batch = ReservedBatch & {
  remaining: number;
  status: string;
  source: string;
};
type Ledger = { amount: number; debit: string; credit: string; ref: string };
type State = {
  balance: number;
  earned: number;
  frozen: boolean;
  subscription: UpgradeSubscription;
  requests: { requestId: string; userId: string; outTradeNo: string }[];
  batches: Batch[];
  reservations: UpgradeReservation[];
  orders: UpgradeOrder[];
  ledger: Ledger[];
};
const START = new Date("2026-01-01T00:00:00Z");
const END = new Date("2026-02-01T00:00:00Z");
const initial = (): State => ({
  balance: 5010,
  earned: 5010,
  frozen: false,
  subscription: {
    id: "sub",
    userId: "u",
    subscriptionId: "old-sub",
    priceId: "starter_monthly",
    status: "active",
    cancelAtPeriodEnd: false,
    currentPeriodStart: START,
    currentPeriodEnd: END,
  },
  batches: [
    {
      id: "old",
      amount: 5000,
      remaining: 5000,
      issuedAt: START.toISOString(),
      expiresAt: END.toISOString(),
      status: "active",
      source: "subscription",
    },
    {
      id: "bonus",
      amount: 10,
      remaining: 10,
      issuedAt: START.toISOString(),
      expiresAt: null,
      status: "active",
      source: "bonus",
    },
  ],
  requests: [],
  reservations: [],
  orders: [],
  ledger: [],
});

/** 序列化事务与异常回滚；不把该测试替代真实 PG 锁/约束测试。 */
function memoryStore() {
  let state = initial();
  let queue = Promise.resolve();
  let failure: string | null = null;
  const store: UpgradeStore = {
    findOrder: async (id) =>
      structuredClone(
        state.orders.find((order) => order.outTradeNo === id) ?? null
      ),
    expired: async (now, limit) =>
      state.reservations
        .filter((r) => r.state === "held" && r.expiresAt <= now)
        .slice(0, limit)
        .map((r) => r.outTradeNo),
    async transaction(userId, run) {
      let unlock = () => {};
      const prior = queue;
      queue = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      await prior;
      const draft = structuredClone(state);
      const fail = (step: string) => {
        if (failure === step) throw new Error(`injected:${step}`);
      };
      const tx: UpgradeTransaction = {
        getReservation: async (id) =>
          draft.reservations.find(
            (r) => r.outTradeNo === id && r.userId === userId
          ) ?? null,
        getRequest: async (id) =>
          draft.reservations.find((r) =>
            draft.requests.some(
              (request) =>
                request.requestId === id &&
                request.userId === userId &&
                request.outTradeNo === r.outTradeNo
            )
          ) ?? null,
        async linkRequest(requestId, r) {
          draft.requests.push({ requestId, userId, outTradeNo: r.outTradeNo });
        },
        getHeld: async () =>
          draft.reservations.find(
            (r) =>
              r.userId === userId &&
              (r.state === "held" ||
                (r.state === "refund_pending" && r.settledAt !== null))
          ) ?? null,
        getOrder: async (id) =>
          draft.orders.find(
            (o) => o.outTradeNo === id && o.userId === userId
          ) ?? null,
        async saveOrder(order) {
          fail("order");
          const i = draft.orders.findIndex(
            (o) => o.outTradeNo === order.outTradeNo
          );
          if (i < 0) draft.orders.push(structuredClone(order));
          else draft.orders[i] = structuredClone(order);
        },
        async saveReservation(r) {
          fail("reservation");
          const i = draft.reservations.findIndex(
            (old) => old.outTradeNo === r.outTradeNo
          );
          if (i < 0) draft.reservations.push(structuredClone(r));
          else draft.reservations[i] = structuredClone(r);
        },
        getSubscription: async () =>
          draft.subscription.userId === userId
            ? structuredClone(draft.subscription)
            : null,
        async saveSubscription(sub) {
          fail("subscription");
          draft.subscription = structuredClone(sub);
        },
        async takeBatches(now) {
          return draft.batches
            .filter(
              (b) =>
                b.source === "subscription" &&
                b.status === "active" &&
                b.remaining > 0 &&
                (!b.expiresAt || new Date(b.expiresAt) > now)
            )
            .map((b) => {
              const result = {
                id: b.id,
                amount: b.remaining,
                issuedAt: b.issuedAt,
                expiresAt: b.expiresAt,
              };
              b.remaining = 0;
              b.status = "consumed";
              return result;
            });
        },
        async restoreBatches(batches, now) {
          fail("restore");
          let restored = 0;
          for (const b of batches) {
            const current = draft.batches.find((row) => row.id === b.id);
            if (current?.status !== "consumed" || current.remaining !== 0)
              throw new Error("changed batch");
            const valid = !b.expiresAt || new Date(b.expiresAt) > now;
            current.remaining = valid ? b.amount : 0;
            current.status = valid ? "active" : "expired";
            if (valid) restored += b.amount;
          }
          return restored;
        },
        async freezeGrant(r, now) {
          const batch = draft.batches.find(
            (b) => b.id === `grant:${r.outTradeNo}`
          );
          if (
            !batch ||
            batch.remaining !== r.snapshot.targetCredits ||
            batch.status !== "active" ||
            !batch.expiresAt ||
            new Date(batch.expiresAt) <= now
          )
            throw new Error("新权益已使用或到期");
          batch.remaining = 0;
          batch.status = "consumed";
        },
        async grant(r, periodEnd, now) {
          fail("grant");
          if (draft.batches.some((b) => b.id === `grant:${r.outTradeNo}`))
            throw new Error("duplicate grant");
          draft.batches.push({
            id: `grant:${r.outTradeNo}`,
            amount: r.snapshot.targetCredits,
            remaining: r.snapshot.targetCredits,
            source: "subscription",
            status: "active",
            issuedAt: now.toISOString(),
            expiresAt: periodEnd.toISOString(),
          });
          draft.balance += r.snapshot.targetCredits;
          draft.earned += r.snapshot.targetCredits;
        },
        async moveBalance(amount) {
          fail("balance");
          if (draft.balance + amount < 0 || (amount < 0 && draft.frozen))
            throw new Error("账户冻结或余额不足");
          draft.balance = Math.round((draft.balance + amount) * 100) / 100;
        },
        async ledger(amount, _type, debit, credit, ref) {
          fail("ledger");
          if (amount <= 0) return;
          if (draft.ledger.some((entry) => entry.ref === ref))
            throw new Error("duplicate ledger");
          draft.ledger.push({ amount, debit, credit, ref });
        },
      };
      try {
        const result = await run(tx);
        state = draft;
        return result;
      } finally {
        unlock();
      }
    },
  };
  return {
    store,
    read: () => structuredClone(state),
    edit: (run: (value: State) => void) => run(state),
    fail: (step: string | null) => {
      failure = step;
    },
  };
}
let memory: ReturnType<typeof memoryStore>;
let now: Date;
let service: ReturnType<typeof createUpgradeReservationService>;
const request = {
  userId: "u",
  targetPriceId: "pro_monthly",
  clientRequestId: "request",
};
/** 固定费率，旧权益每 250 积分抵一元；状态机不重复读取数据库报价。 */
async function reserve() {
  return (await service.reserve(request)).reservation;
}
function payment(outTradeNo: string, money = "30.00") {
  return {
    outTradeNo,
    tradeNo: `trade:${outTradeNo}`,
    money,
    verifyStatus: true,
    tradeStatus: "TRADE_SUCCESS",
  };
}
/** 模拟普通消费读取旧快照后执行的原子 UPDATE 条件。 */
function consume(amount: number, id = "old") {
  memory.edit((state) => {
    const b = state.batches.find((batch) => batch.id === id);
    if (
      b?.status !== "active" ||
      b.remaining < amount ||
      (b.expiresAt && new Date(b.expiresAt) <= now)
    )
      throw new Error("积分不足");
    b.remaining -= amount;
    state.balance -= amount;
    if (b.remaining === 0) b.status = "consumed";
  });
}
beforeEach(() => {
  memory = memoryStore();
  now = new Date(START);
  service = createUpgradeReservationService(
    memory.store,
    async () => (_sub, remaining) => ({
      amountDue: 50 - Math.min(20, remaining / 250),
      originalAmount: 50,
      prorationCredit: Math.min(20, remaining / 250),
      remainingDays: 31,
      periodDays: 31,
      targetCredits: 20000,
      yearly: false,
    }),
    () => new Date(now)
  );
});
describe("R08 upgrade reservation", () => {
  it.each([
    "29.999",
    "3e1",
    "0x1e",
    "",
    "30.000",
    "-30",
  ])("rejects non-canonical payment money %s", async (money) => {
    const r = await reserve();
    const before = memory.read();
    await expect(service.settle(payment(r.outTradeNo, money))).rejects.toThrow(
      "金额"
    );
    expect(memory.read()).toEqual(before);
  });
  it("does not replay or refund historical already successful upgrades without reservations", async () => {
    memory.edit((s) => {
      s.orders.push({
        outTradeNo: "legacy",
        userId: "u",
        amount: 30,
        status: "success",
        metadata: { checkoutMode: "upgrade" },
        paymentTradeNo: null,
        paidAmount: null,
      });
    });
    const before = memory.read();
    expect((await service.settle(payment("legacy"))).state).toBe("success");
    expect(memory.read()).toEqual(before);
  });

  it("holds old credits at checkout and blocks stale concurrent consumption", async () => {
    const r = await reserve();
    const s = memory.read();
    expect(s.balance).toBe(10);
    expect(s.batches[0]?.remaining).toBe(0);
    expect(s.batches[0]?.status).toBe("consumed");
    expect(r.snapshot.quote.amountDue).toBe(30);
    expect(() => consume(5000)).toThrow("积分不足");
    await service.settle(payment(r.outTradeNo));
    expect(memory.read().balance).toBe(20010);
  });
  it("prices against actual credits if a concurrent spend wins first", async () => {
    consume(5000);
    const r = await reserve();
    expect(r.snapshot.quote.amountDue).toBe(50);
    await expect(service.settle(payment(r.outTradeNo))).rejects.toThrow("金额");
    await service.settle(payment(r.outTradeNo, "50"));
    expect(memory.read().balance).toBe(20010);
  });
  it("coalesces twenty duplicate checkout requests into one hold", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        service.reserve({ ...request, clientRequestId: `r:${i}` })
      )
    );
    expect(new Set(results.map((r) => r.reservation.outTradeNo)).size).toBe(1);
    expect(memory.read().reservations).toHaveLength(1);
    expect(memory.read().ledger).toHaveLength(1);
  });
  it("keeps coalesced request aliases bound to the cancelled order", async () => {
    const r = await reserve();
    await service.reserve({ ...request, clientRequestId: "alias" });
    await service.cancel("u", r.outTradeNo);
    expect(
      (await service.reserve({ ...request, clientRequestId: "alias" })).payable
    ).toBe(false);
    expect(memory.read().balance).toBe(5010);
    expect(memory.read().reservations).toHaveLength(1);
  });
  it("rejects another target and key reuse with changed input", async () => {
    await reserve();
    await expect(
      service.reserve({ ...request, targetPriceId: "ultra_monthly" })
    ).rejects.toThrow("幂等键");
    await expect(
      service.reserve({
        ...request,
        targetPriceId: "ultra_monthly",
        clientRequestId: "other",
      })
    ).rejects.toThrow("取消");
  });
  it("settles twenty callbacks once, with frozen quote and grant", async () => {
    const r = await reserve();
    await Promise.all(
      Array.from({ length: 20 }, () => service.settle(payment(r.outTradeNo)))
    );
    const s = memory.read();
    expect(s.balance).toBe(20010);
    expect(s.orders[0]?.status).toBe("success");
    expect(s.batches.filter((b) => b.id.startsWith("grant:"))).toHaveLength(1);
    expect(
      s.ledger.filter((entry) => entry.ref.endsWith(":settle"))
    ).toHaveLength(1);
  });
  it.each([
    "grant",
    "subscription",
    "reservation",
    "order",
    "ledger",
  ])("rolls back payment failure at %s and retries", async (step) => {
    const r = await reserve();
    const before = memory.read();
    memory.fail(step);
    await expect(service.settle(payment(r.outTradeNo))).rejects.toThrow(
      "injected"
    );
    expect(memory.read()).toEqual(before);
    memory.fail(null);
    await service.settle(payment(r.outTradeNo));
    expect(memory.read().balance).toBe(20010);
  });
  it.each([
    "balance",
    "order",
    "reservation",
    "ledger",
  ])("rolls back checkout failure at %s", async (step) => {
    const before = memory.read();
    memory.fail(step);
    await expect(reserve()).rejects.toThrow("injected");
    expect(memory.read()).toEqual(before);
  });
  it("releases cancellation once and preserves original batch dates", async () => {
    const r = await reserve();
    await service.cancel("u", r.outTradeNo);
    await service.cancel("u", r.outTradeNo);
    const s = memory.read();
    expect(s.balance).toBe(5010);
    expect(s.batches[0]?.expiresAt).toBe(END.toISOString());
    expect(
      s.ledger.filter((entry) => entry.ref.endsWith(":release"))
    ).toHaveLength(1);
    expect((await service.reserve(request)).payable).toBe(false);
  });
  it("does not allow another user to cancel a reservation", async () => {
    const r = await reserve();
    await expect(service.cancel("attacker", r.outTradeNo)).rejects.toThrow(
      "不存在"
    );
    expect(memory.read().balance).toBe(10);
  });
  it("late payment after cancellation is recorded for refund without a grant", async () => {
    const r = await reserve();
    await service.cancel("u", r.outTradeNo);
    await service.settle(payment(r.outTradeNo));
    expect(memory.read().orders[0]?.status).toBe("refund_pending");
    expect(memory.read().balance).toBe(5010);
    await service.prepareRefund(r.outTradeNo);
    await service.confirmRefund(r.outTradeNo, "refund", 30);
    await service.confirmRefund(r.outTradeNo, "refund", 30);
    expect(memory.read().balance).toBe(5010);
  });
  it("treats exact TTL boundary as expired even without a cleanup job", async () => {
    const r = await reserve();
    now = new Date(r.expiresAt);
    await service.settle(payment(r.outTradeNo));
    expect(memory.read().balance).toBe(5010);
    expect(memory.read().orders[0]?.status).toBe("refund_pending");
  });
  it("does not resurrect credits when original expiry equals release time", async () => {
    const r = await reserve();
    now = new Date(END);
    await service.cancel("u", r.outTradeNo);
    const s = memory.read();
    expect(s.balance).toBe(10);
    expect(s.batches[0]?.status).toBe("expired");
    expect(
      s.ledger.find((entry) => entry.ref.endsWith(":release-expired"))?.amount
    ).toBe(5000);
  });
  it("keeps bonus credits out of the reservation", async () => {
    await reserve();
    consume(10, "bonus");
    expect(memory.read().balance).toBe(0);
  });
  it("rejects underpayment, invalid signatures, changed trade identity and non-success", async () => {
    const r = await reserve();
    await expect(
      service.settle(payment(r.outTradeNo, "29.99"))
    ).rejects.toThrow("金额");
    await expect(
      service.settle({ ...payment(r.outTradeNo), verifyStatus: false })
    ).rejects.toThrow("无效");
    await expect(
      service.settle({ ...payment(r.outTradeNo), tradeStatus: "PENDING" })
    ).rejects.toThrow("无效");
    await service.settle(payment(r.outTradeNo));
    await expect(
      service.settle({ ...payment(r.outTradeNo), tradeNo: "other" })
    ).rejects.toThrow("凭据冲突");
  });
  it("releases and refunds if the subscription cycle changed", async () => {
    const r = await reserve();
    memory.edit((s) => {
      s.subscription.subscriptionId = "renewed";
    });
    await service.settle(payment(r.outTradeNo));
    expect(memory.read().balance).toBe(5010);
    expect(memory.read().reservations[0]?.releaseReason).toBe(
      "subscription_changed"
    );
  });
  it("serializes cleanup against payment and does not touch settled credits", async () => {
    const r = await reserve();
    await Promise.all([
      service.settle(payment(r.outTradeNo)),
      service.expire(),
    ]);
    now = new Date(END);
    expect(await service.expire()).toEqual({ released: 0 });
    expect(memory.read().balance).toBe(20010);
  });
  it("performs bounded, idempotent expiry and keeps tombstones", async () => {
    await reserve();
    now = new Date(START.getTime() + 15 * 60_000);
    expect(await service.expire(1)).toEqual({ released: 1 });
    expect(await service.expire()).toEqual({ released: 0 });
    expect(memory.read().reservations).toHaveLength(1);
    expect(memory.read().orders).toHaveLength(1);
  });
  it("freezes unspent upgrade rights before refund, then restores old rights only once", async () => {
    const r = await reserve();
    await service.settle(payment(r.outTradeNo));
    expect(await service.prepareRefund(r.outTradeNo)).toEqual({
      amount: 30,
      state: "refund_pending",
    });
    expect(memory.read().balance).toBe(10);
    expect(memory.read().subscription.status).toBe("unpaid");
    await service.prepareRefund(r.outTradeNo);
    await service.confirmRefund(r.outTradeNo, "ref", 30);
    await service.confirmRefund(r.outTradeNo, "ref", 30);
    expect(memory.read().balance).toBe(5010);
    expect(memory.read().subscription.subscriptionId).toBe("old-sub");
  });
  it("rejects a refund after new credits have been consumed", async () => {
    const r = await reserve();
    await service.settle(payment(r.outTradeNo));
    consume(1, `grant:${r.outTradeNo}`);
    const before = memory.read();
    await expect(service.prepareRefund(r.outTradeNo)).rejects.toThrow("已使用");
    expect(memory.read()).toEqual(before);
  });
  it("rejects confirm-before-prepare and changed refund amount/reference", async () => {
    const r = await reserve();
    await service.settle(payment(r.outTradeNo));
    await expect(
      service.confirmRefund(r.outTradeNo, "ref", 30)
    ).rejects.toThrow("先冻结");
    await service.prepareRefund(r.outTradeNo);
    await expect(
      service.confirmRefund(r.outTradeNo, "ref", 29)
    ).rejects.toThrow("金额");
    await service.confirmRefund(r.outTradeNo, "ref", 30);
    await expect(
      service.confirmRefund(r.outTradeNo, "other", 30)
    ).rejects.toThrow("凭据冲突");
  });
  it("does not restore expired old credits on a later full refund", async () => {
    const r = await reserve();
    now = new Date("2026-01-02T00:00:00Z");
    // 延迟一日已超 TTL，先重新建单以得到跨越旧周期末的新周期。
    await service.expire();
    const next = (
      await service.reserve({ ...request, clientRequestId: "second" })
    ).reservation;
    await service.settle(payment(next.outTradeNo));
    now = new Date(END);
    await service.prepareRefund(next.outTradeNo);
    await service.confirmRefund(next.outTradeNo, "ref", 30);
    expect(memory.read().balance).toBe(10);
    expect(memory.read().subscription.currentPeriodEnd).toEqual(END);
    expect(r.outTradeNo).not.toBe(next.outTradeNo);
  });
  it("blocks new upgrades while a settled refund is pending", async () => {
    const r = await reserve();
    await service.settle(payment(r.outTradeNo));
    await service.prepareRefund(r.outTradeNo);
    await expect(
      service.reserve({ ...request, clientRequestId: "second" })
    ).rejects.toThrow("退款");
  });
  it("refuses checkout for frozen accounts and rolls back captured batches", async () => {
    memory.edit((s) => {
      s.frozen = true;
    });
    const before = memory.read();
    await expect(reserve()).rejects.toThrow("冻结");
    expect(memory.read()).toEqual(before);
  });
  it("uses decimal quantities without leaving an unusable positive remainder", async () => {
    memory.edit((s) => {
      s.balance = 10.4;
      if (s.batches[0]) s.batches[0].remaining = 0.4;
    });
    const r = await reserve();
    expect(memory.read().balance).toBe(10);
    await service.cancel("u", r.outTradeNo);
    expect(memory.read().balance).toBe(10.4);
  });
});
