/** R14 真实 POST/UOL/状态 SQL/财务编排；真实 HMAC，SQL 替身，不访问网关或生产。 */
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  creemTestRows,
  creemTestState,
  isCreemTestTransaction,
  resetCreemTestDb,
} from "../../../../../../../packages/shared/src/payment/test-support/creem-db";
import fixtures from "../../../../../../../packages/shared/src/payment/test-support/creem-official-payloads.json";

const mocks = vi.hoisted(() => ({
  extend: vi.fn(),
  grant: vi.fn(),
  setting: vi.fn(async () => true),
}));
vi.mock("@repo/database", async () => {
  const { creemTestDb } = await import(
    "../../../../../../../packages/shared/src/payment/test-support/creem-db"
  );
  return { db: creemTestDb };
});
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
  getSubscriptionMonthlyCredits: async () => {
    const { isCreemTestTransaction } = await import(
      "../../../../../../../packages/shared/src/payment/test-support/creem-db"
    );
    expect(isCreemTestTransaction()).toBe(false);
    return { pro: 100 };
  },
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
  getRuntimeSettingString: async () => "r14-test-secret",
}));

import { POST } from "./route";
import { invokeOperation } from "@repo/shared/uol";
const T = 1792882800000;
const sub = {
  id: "sub_test",
  product: "pro_monthly",
  customer: "cust_test",
  current_period_start_date: "2026-10-01T00:00:00Z",
  current_period_end_date: "2099-11-01T00:00:00Z",
  cancel_at_period_end: false,
  metadata: { userId: "u" },
};
/** 保留 wire timestamp，构造已签名事件；ID 可独立于时间设定。 */
function event(
  type: string,
  time: number,
  data: Record<string, unknown> = {},
  id = `evt_${type}_${time}`
) {
  return {
    id,
    eventType: `subscription.${type}`,
    created_at: time,
    object: {
      ...sub,
      status: type === "paid" || type === "renewed" ? "active" : type,
      ...data,
    },
  };
}
/** 使用生产验签；错误签名同样调用真实 route。 */
function post(payload: unknown, invalid = false) {
  const body = JSON.stringify(payload);
  return POST(
    new Request("https://test/api/webhooks/creem", {
      method: "POST",
      body,
      headers: {
        "creem-signature": invalid
          ? "invalid"
          : createHmac("sha256", "r14-test-secret").update(body).digest("hex"),
      },
    })
  );
}
const row = () => {
  const value = creemTestRows("subscription")[0];
  if (!value) throw new Error("Expected subscription row");
  return value;
};
beforeEach(() => {
  vi.clearAllMocks();
  resetCreemTestDb({
    user: [{ id: "u" }],
    subscription: [
      {
        id: "s",
        userId: "u",
        subscriptionId: sub.id,
        priceId: sub.product,
        status: "active",
        currentPeriodStart: new Date(sub.current_period_start_date),
        currentPeriodEnd: new Date(sub.current_period_end_date),
        cancelAtPeriodEnd: false,
        creemEventCreatedAt: null,
        updatedAt: new Date(T - 1000),
      },
    ],
  });
  mocks.setting.mockImplementation(async () => {
    expect(isCreemTestTransaction()).toBe(false);
    return true;
  });
  mocks.extend.mockReset().mockResolvedValue(1);
  mocks.grant
    .mockReset()
    .mockImplementation(async (input: Record<string, unknown>) => {
      expect(isCreemTestTransaction()).toBe(false);
      const old = creemTestRows("credits_batch").find(
        (batch) => batch.sourceRef === input.sourceRef
      );
      if (old) return { batchId: old.id };
      const id = `batch_${creemTestRows("credits_batch").length}`;
      creemTestRows("credits_batch").push({
        id,
        userId: input.userId,
        sourceRef: input.sourceRef,
        sourceType: input.sourceType,
      });
      creemTestRows("credits_transaction").push({
        userId: input.userId,
        type: "monthly_grant",
        metadata: { ...(input.metadata as object), batchId: id },
      });
      return { batchId: id };
    });
});

describe("Creem 状态时间与财务重放独立", () => {
  it("新 paused 后旧 active 不得恢复状态", async () => {
    expect((await post(event("paused", T + 200))).status).toBe(200);
    expect((await post(event("active", T + 100))).status).toBe(200);
    expect(row().status).toBe("paused");
    expect(row().creemEventCreatedAt).toBe(T + 200);
    expect(creemTestRows("credits_batch")).toHaveLength(1);
  });
  it("新 canceled 后旧 active 不得清除期末取消", async () => {
    await post(event("canceled", T + 200));
    await post(event("active", T + 100));
    expect(row().cancelAtPeriodEnd).toBe(true);
    expect(row().status).toBe("canceled");
  });
  it.each([
    ["paused", "active"],
    ["active", "paused"],
  ])("同毫秒 %s/%s 均保持 paused", async (first, second) => {
    expect((await post(event(first, T))).status).toBe(200);
    expect((await post(event(second, T))).status).toBe(200);
    expect(row().status).toBe("paused");
  });
  it("同秒不同毫秒仍按时间，新 active 可恢复旧 paused", async () => {
    await post(event("paused", T + 100));
    await post(event("active", T + 900));
    expect(row().status).toBe("active");
    expect(row().creemEventCreatedAt).toBe(T + 900);
  });
  it("旧 paid 不回退新周期，仍补真实已付周期", async () => {
    await post(
      event("paused", T + 200, {
        current_period_start_date: "2026-11-01T00:00:00Z",
      })
    );
    expect((await post(event("paid", T + 100))).status).toBe(200);
    expect(row().status).toBe("paused");
    expect(row().currentPeriodStart).toEqual(new Date("2026-11-01T00:00:00Z"));
    expect(creemTestRows("credits_batch")).toHaveLength(1);
    expect(mocks.extend).toHaveBeenCalledTimes(1);
  });
  it("重复同 ID 在顺延失败后补顺延，不双发、不因 inbox 短路", async () => {
    const payload = event("paid", T);
    mocks.extend.mockRejectedValueOnce(new Error("extension unavailable"));
    expect((await post(payload)).status).toBe(500);
    expect((await post(payload)).status).toBe(200);
    expect(creemTestRows("creem_webhook_event")).toHaveLength(1);
    expect(creemTestRows("credits_batch")).toHaveLength(1);
    expect(mocks.grant).toHaveBeenCalledTimes(1);
    expect(mocks.extend).toHaveBeenCalledTimes(2);
  });
  it("不同 event ID 的同周期 paid 重复只发一批次", async () => {
    await post(event("paid", T, {}, "evt_a"));
    await post(event("paid", T, {}, "evt_b"));
    expect(creemTestRows("credits_batch")).toHaveLength(1);
    expect(mocks.extend).toHaveBeenCalledTimes(2);
  });
  it("同 ID 内容冲突回滚状态，不进入财务", async () => {
    await post(event("paused", T, {}, "evt_conflict"));
    expect(
      (await post(event("active", T + 1, {}, "evt_conflict"))).status
    ).toBe(500);
    expect(row().status).toBe("paused");
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it("paused 先于 checkout 且无映射，迟到 checkout 关联后仍 paused", async () => {
    creemTestRows("subscription").splice(0);
    await post(event("paused", T + 200, { metadata: {} }));
    expect(creemTestRows("subscription")).toHaveLength(0);
    const payload = {
      id: "evt_checkout",
      eventType: "checkout.completed",
      created_at: T + 100,
      object: {
        id: "ch_1",
        object: "checkout",
        customer: { id: "cust_test" },
        metadata: { userId: "u" },
        subscription: { ...sub, status: "active", metadata: {} },
      },
    };
    expect((await post(payload)).status).toBe(200);
    expect(row().status).toBe("paused");
    expect(row().userId).toBe("u");
    expect(creemTestRows("credits_batch")).toHaveLength(1);
  });
  it("并发乱序与同 ID 重投保持最新限制，状态短锁/CAS均使用数据库 SQL", async () => {
    const responses = await Promise.all([
      post(event("active", T)),
      post(event("paused", T + 200)),
      post(event("active", T)),
      post(event("paid", T + 100)),
    ]);
    expect(responses.map((res) => res.status)).toEqual([200, 200, 200, 200]);
    expect(row().status).toBe("paused");
    expect(creemTestRows("credits_batch")).toHaveLength(1);
    expect(
      creemTestState.statements.some((sql) =>
        sql.includes("pg_advisory_xact_lock")
      )
    ).toBe(true);
    expect(
      creemTestState.statements.some(
        (sql) =>
          sql.includes('"creem_event_created_at" <=') && sql.includes("is null")
      )
    ).toBe(true);
  });
  it("缺映射 paid 返回500，checkout 补映射后可重投入账", async () => {
    creemTestRows("subscription").splice(0);
    const paid = event("paid", T + 200, { metadata: {} });
    expect((await post(paid)).status).toBe(500);
    await post(event("active", T + 100));
    expect((await post(paid)).status).toBe(200);
    expect(creemTestRows("credits_batch")).toHaveLength(1);
  });
  it("同时间产品冲突收紧为未识别套餐，较新明确快照才恢复", async () => {
    await post(event("active", T, { product: "pro" }, "evt_pro"));
    await post(event("active", T, { product: "enterprise" }, "evt_enterprise"));
    expect(row().priceId).toBe("");
    await post(event("active", T + 1, { product: "pro" }, "evt_later"));
    expect(row().priceId).toBe("pro");
  });
  it("首次无水位旧 paused 不被 active 解限；严格更新的已知事件才能恢复", async () => {
    row().status = "paused";
    await post(event("active", T));
    expect(row().status).toBe("paused");
    await post(event("active", T + 1));
    expect(row().status).toBe("active");
  });
  it("旧通知不得覆盖同用户较新 Creem 订阅，或改写其他支付渠道", async () => {
    row().subscriptionId = "sub_new";
    row().creemEventCreatedAt = T + 1000;
    await post(event("active", T));
    expect(row().subscriptionId).toBe("sub_new");
    row().subscriptionId = "epay_order";
    // Epay 改同一行可能遗留旧 Creem 水位，不能只看水位非空便认作 Creem。
    row().creemEventCreatedAt = T;
    await post(event("active", T + 2000));
    expect(row().subscriptionId).toBe("epay_order");
  });
  it("关联归属冲突拒绝并回滚收件凭证，不给其他用户入账", async () => {
    expect(
      (await post(event("paid", T, { metadata: { userId: "other" } }))).status
    ).toBe(500);
    expect(creemTestRows("creem_webhook_event")).toHaveLength(0);
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it("官方 checkout/active 无周期只同步，paid 提供周期后发放", async () => {
    creemTestRows("subscription").splice(0);
    const checkout = fixtures["checkout.completed"];
    const payload = {
      ...checkout,
      created_at: T,
      object: { ...checkout.object, metadata: { userId: "u" } },
    };
    expect((await post(payload)).status).toBe(200);
    expect(row().status).toBe("incomplete");
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(
      (
        await post(
          event("paid", T + 1, { id: checkout.object.subscription.id })
        )
      ).status
    ).toBe(200);
    expect(row().status).toBe("active");
    expect(creemTestRows("credits_batch")).toHaveLength(1);
  });
  it("对象 updated_at 再新也不能让旧顶层事件时间越过暂停水位", async () => {
    await post(event("paused", T + 200));
    await post(event("active", T, { updated_at: "2099-01-01T00:00:00Z" }));
    expect(row().status).toBe("paused");
  });
  it("并发同毫秒冲突不会因 ID 排序重新激活", async () => {
    const responses = await Promise.all([
      post(event("paused", T, {}, "evt_z")),
      post(event("active", T, {}, "evt_a")),
      post(event("paused", T, {}, "evt_z")),
    ]);
    expect(responses.map((res) => res.status)).toEqual([200, 200, 200]);
    expect(row().status).toBe("paused");
  });
  it.each([
    "scheduled_cancel",
    "canceled",
  ])("Locke B1：同毫秒 %s 仅收紧 status，不能扩大产品和周期", async (status) => {
    row().priceId = "pro";
    await post(
      event(
        "active",
        T,
        { product: "pro", current_period_end_date: "2098-01-01T00:00:00Z" },
        "evt_b1_active"
      )
    );
    expect(
      (
        await post(
          event(status, T, { product: "enterprise" }, "evt_b1_restricted")
        )
      ).status
    ).toBe(200);
    expect(row().priceId).toBe("");
    expect(row().currentPeriodEnd).toEqual(new Date("2098-01-01T00:00:00Z"));
    expect(row().cancelAtPeriodEnd).toBe(true);
  });
  it.each([
    "active",
    "trialing",
    "canceled",
  ])("Locke B2：%s 空交集无权益，保留水位和原周期发放", async (status) => {
    const first = {
      current_period_start_date: "2098-01-01T00:00:00Z",
      current_period_end_date: "2098-02-01T00:00:00Z",
    };
    const second = {
      current_period_start_date: "2099-01-01T00:00:00Z",
      current_period_end_date: "2099-02-01T00:00:00Z",
    };
    expect((await post(event(status, T, first, "evt_b2_first"))).status).toBe(
      200
    );
    expect((await post(event(status, T, second, "evt_b2_second"))).status).toBe(
      200
    );
    expect(row().status).toBe("incomplete");
    expect(row().creemEventCreatedAt).toBe(T);
    expect(
      (await post(event("paid", T - 1, first, "evt_b2_old_paid"))).status
    ).toBe(200);
    expect(row().status).toBe("incomplete");
    expect(
      creemTestRows("credits_batch").some(
        (batch) =>
          batch.sourceRef === `${sub.id}:${first.current_period_start_date}`
      )
    ).toBe(true);
    expect(
      (await post(event("active", T + 1, second, "evt_b2_newer"))).status
    ).toBe(200);
    expect(row().status).toBe("active");
  });
  it("Locke B2：边界相接也是空交集，同时间重投不能恢复", async () => {
    await post(
      event(
        "active",
        T,
        {
          current_period_start_date: "2098-01-01T00:00:00Z",
          current_period_end_date: "2098-02-01T00:00:00Z",
        },
        "evt_b2_left"
      )
    );
    const right = event(
      "active",
      T,
      {
        current_period_start_date: "2098-02-01T00:00:00Z",
        current_period_end_date: "2098-03-01T00:00:00Z",
      },
      "evt_b2_right"
    );
    await post(right);
    expect(row().status).toBe("incomplete");
    await post(right);
    expect(row().status).toBe("incomplete");
  });
  it.each([
    { object: "checkout" },
    { product: { id: "pro_monthly", object: "customer" } },
    { customer: { id: "cust_test", object: "product" } },
  ])("Locke B3：显式错误实体 %j 落库前拒绝", async (data) => {
    const before = structuredClone(creemTestRows("user"));
    expect((await post(event("paid", T, data))).status).toBe(400);
    expect(creemTestRows("creem_webhook_event")).toHaveLength(0);
    expect(creemTestRows("creem_subscription_state")).toHaveLength(0);
    expect(creemTestRows("user")).toEqual(before);
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it.each([
    "cust_wrong",
    { id: "cust_wrong", object: "customer" },
  ])("Locke B3：checkout/subscription customer冲突 %j 不绑定或入账", async (customer) => {
    const before = structuredClone(creemTestRows("user"));
    const payload = {
      id: "evt_b3_customer",
      eventType: "checkout.completed",
      created_at: T,
      object: {
        id: "ch_test",
        object: "checkout",
        customer: { id: "cust_test", object: "customer" },
        metadata: { userId: "u" },
        subscription: { ...sub, status: "active", customer },
      },
    };
    expect((await post(payload)).status).toBe(400);
    expect(creemTestRows("creem_webhook_event")).toHaveLength(0);
    expect(creemTestRows("creem_subscription_state")).toHaveLength(0);
    expect(creemTestRows("user")).toEqual(before);
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it("Locke B3：显式错误checkout实体不能作为一次性支付通知入账", async () => {
    const payload = {
      id: "evt_b3_entity",
      eventType: "checkout.completed",
      created_at: T,
      object: {
        id: "ch_test",
        object: "subscription",
        customer: { id: "cust_test" },
        metadata: { userId: "u", type: "credit_purchase" },
      },
    };
    expect((await post(payload)).status).toBe(400);
    expect(creemTestRows("creem_webhook_event")).toHaveLength(0);
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it.each([
    { subscription: { ...sub, status: "active", object: "checkout" } },
    { customer: { id: "cust_test", object: "subscription" } },
    { product: { id: "pro_monthly", object: "customer" } },
    { order: { id: "order_test", object: "checkout" } },
  ])("Locke B3：checkout嵌套显式实体冲突 %j 不触发任何业务写入", async (changes) => {
    const payload = {
      id: "evt_b3_nested",
      eventType: "checkout.completed",
      created_at: T,
      object: {
        id: "ch_test",
        object: "checkout",
        customer: { id: "cust_test", object: "customer" },
        metadata: { userId: "u" },
        subscription: { ...sub, status: "active", object: "subscription" },
        ...changes,
      },
    };
    const before = structuredClone(creemTestRows("user"));
    expect((await post(payload)).status).toBe(400);
    expect(creemTestRows("creem_webhook_event")).toHaveLength(0);
    expect(creemTestRows("creem_subscription_state")).toHaveLength(0);
    expect(creemTestRows("user")).toEqual(before);
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it.each([
    "cust_test",
    { id: "cust_test", object: "customer" },
  ])("Locke B3：合法匹配customer %j 及历史缺discriminator仍可履约", async (customer) => {
    const payload = {
      id: "evt_b3_matching",
      eventType: "checkout.completed",
      created_at: T,
      object: {
        id: "ch_test",
        customer: { id: "cust_test" },
        metadata: { userId: "u" },
        subscription: { ...sub, status: "active", customer },
      },
    };
    expect((await post(payload)).status).toBe(200);
    expect(creemTestRows("creem_webhook_event")).toHaveLength(1);
    expect(creemTestRows("credits_batch")).toHaveLength(1);
    expect(creemTestRows("user")[0]?.customerId).toBe("cust_test");
  });
  it.each([
    "2026-10-01T00:00:00Z",
    "2026-09-01T00:00:00Z",
  ])("Locke B2：输入自身非正周期 %s 在收件前拒绝", async (end) => {
    expect(
      (
        await post(
          event("active", T, {
            current_period_start_date: "2026-10-01T00:00:00Z",
            current_period_end_date: end,
          })
        )
      ).status
    ).toBe(400);
    expect(creemTestRows("creem_webhook_event")).toHaveLength(0);
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it("未验签请求不写收件箱/状态/财务", async () => {
    expect((await post(event("paid", T), true)).status).toBe(400);
    expect(creemTestRows("creem_webhook_event")).toHaveLength(0);
    expect(creemTestRows("creem_subscription_state")).toHaveLength(0);
    expect(creemTestRows("credits_batch")).toHaveLength(0);
  });
  it.each([
    T / 1000,
    undefined,
    -1,
    T + 0.5,
  ])("拒绝不可靠事件时间 %s，不落财务/状态表", async (time) => {
    expect((await post({ ...event("paid", T), created_at: time })).status).toBe(
      400
    );
    expect(creemTestRows("creem_webhook_event")).toHaveLength(0);
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it("非 Creem Principal 不可调用 webhook 契约", async () => {
    await expect(
      invokeOperation("subscription.creemWebhook", event("paid", T), {
        type: "webhook",
        provider: "epay",
      })
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      invokeOperation("subscription.creemWebhook", event("paid", T), {
        type: "user",
        userId: "u",
        role: "super_admin",
      })
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(creemTestRows("creem_webhook_event")).toHaveLength(0);
  });
  it.each(
    Object.entries(fixtures).filter(([type]) => type !== "checkout.completed")
  )("官方真实 wire %s（无 cancel_at_period_end）经真实验签/UOL", async (type, payload) => {
    creemTestRows("subscription").splice(0);
    const object = { ...payload.object, metadata: { userId: "u" } };
    expect((await post({ ...payload, object })).status).toBe(200);
    expect(row().status).toBe(
      type === "subscription.active"
        ? "incomplete"
        : type === "subscription.scheduled_cancel"
          ? "active"
          : type === "subscription.expired"
            ? "expired"
            : object.status
    );
    expect(row().creemEventCreatedAt).toBe(payload.created_at);
  });
});
