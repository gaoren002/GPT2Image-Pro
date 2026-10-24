/** R14 官方 payload 与同时间保守合并；纯 schema/函数，无数据库/配置读取。 */
import { describe, expect, it } from "vitest";
import {
  creemWebhookInputSchema,
  getCreemStateSnapshot,
  mergeCreemState,
  type CreemStateSnapshot,
} from "./creem-event";
import fixtures from "./test-support/creem-official-payloads.json";
import type { CreemSubscription } from "./creem";

const state = (
  status: string,
  changes: Partial<CreemStateSnapshot> = {}
): CreemStateSnapshot => ({
  status,
  priceId: "pro",
  periodStart: "2026-10-01T00:00:00.000Z",
  periodEnd: "2026-11-01T00:00:00.000Z",
  cancelAtPeriodEnd: status === "canceled",
  ...changes,
});
describe("Creem 官方 wire 契约", () => {
  it.each(
    Object.entries(fixtures)
  )("接受官方原样 %s，不补造 cancel_at_period_end/周期/version", (_name, payload) => {
    expect(creemWebhookInputSchema.safeParse(payload).success).toBe(true);
  });
  it("对象 created_at/updated_at 不覆盖顶层毫秒事件时间", () => {
    const payload = {
      ...fixtures["subscription.paid"],
      created_at: 1792882800123,
      object: {
        ...fixtures["subscription.paid"].object,
        created_at: "2000-01-01T00:00:00Z",
        updated_at: "2099-01-01T00:00:00Z",
      },
    };
    expect(creemWebhookInputSchema.parse(payload).created_at).toBe(
      1792882800123
    );
  });
  it("paid 缺周期拒绝，不能把对象创建日期/本机时间当作付费周期", () => {
    const payload = structuredClone(fixtures["subscription.active"]);
    expect(
      creemWebhookInputSchema.safeParse({
        ...payload,
        eventType: "subscription.paid",
      }).success
    ).toBe(false);
  });
  it("expired 事件优先于样例内嵌 active，不产生权益", () => {
    const payload = creemWebhookInputSchema.parse(
      fixtures["subscription.expired"]
    );
    expect(
      getCreemStateSnapshot(payload, payload.object as CreemSubscription).status
    ).toBe("expired");
  });
});
describe("同毫秒冲突的保守规则", () => {
  const states = [
    "active",
    "trialing",
    "canceled",
    "past_due",
    "paused",
    "unpaid",
    "expired",
  ].map((status) => state(status));
  it("任意状态对交换次序结果相同且重复合并不变", () => {
    for (const a of states)
      for (const b of states) {
        expect(mergeCreemState(a, b)).toEqual(mergeCreemState(b, a));
        expect(mergeCreemState(a, a)).toEqual(a);
      }
  });
  it("取消宽限不得覆盖暂停/欠费，过期最保守", () => {
    expect(mergeCreemState(state("canceled"), state("paused")).status).toBe(
      "paused"
    );
    expect(mergeCreemState(state("active"), state("expired")).status).toBe(
      "expired"
    );
  });
  it("同状态不同产品不按随机 ID 选套餐，周期取交集", () => {
    const a = state("active");
    const b = state("active", {
      priceId: "enterprise",
      periodStart: "2026-10-03T00:00:00.000Z",
      periodEnd: "2026-10-30T00:00:00.000Z",
    });
    expect(mergeCreemState(a, b)).toEqual(
      state("active", {
        priceId: "",
        periodStart: b.periodStart,
        periodEnd: b.periodEnd,
      })
    );
    expect(mergeCreemState(b, a)).toEqual(mergeCreemState(a, b));
  });
  it("同状态三事件合并满足结合律，产品冲突不能被第三条回填", () => {
    const a = state("active");
    const b = state("active", { priceId: "enterprise" });
    const c = state("active", { periodEnd: "2026-10-20T00:00:00.000Z" });
    expect(mergeCreemState(mergeCreemState(a, b), c)).toEqual(
      mergeCreemState(a, mergeCreemState(b, c))
    );
    expect(mergeCreemState(mergeCreemState(a, b), c).priceId).toBe("");
  });
});

/** 跨状态也必须合并全部权益维度，避免 rank 的快照短路。 */
it("Locke B1：任意跨状态组合独立交集产品、周期和取消标记", () => {
  const statuses = [
    "active",
    "trialing",
    "canceled",
    "past_due",
    "paused",
    "unpaid",
    "expired",
  ];
  for (const left of statuses)
    for (const right of statuses) {
      const a = state(left);
      const b = state(right, {
        priceId: "enterprise",
        periodStart: "2026-10-03T00:00:00.000Z",
        periodEnd: "2026-10-20T00:00:00.000Z",
        cancelAtPeriodEnd: true,
      });
      const result = mergeCreemState(a, b);
      expect(result.priceId).toBe("");
      expect(result.periodStart).toBe(b.periodStart);
      expect(result.periodEnd).toBe(b.periodEnd);
      expect(result.cancelAtPeriodEnd).toBe(true);
      expect(result).toEqual(mergeCreemState(b, a));
    }
});

/** 独立维度的交集必须满足结合律，跨 rank 的第三条事件不能恢复已丢弃的权益。 */
it("Locke B1：跨状态三事件合并保持结合律和冲突吸收", () => {
  const statuses = [
    "active",
    "trialing",
    "canceled",
    "past_due",
    "paused",
    "unpaid",
    "expired",
  ];
  for (const left of statuses)
    for (const middle of statuses)
      for (const right of statuses) {
        const a = state(left);
        const b = state(middle, {
          priceId: "enterprise",
          periodStart: "2026-10-03T00:00:00.000Z",
        });
        const c = state(right, { periodEnd: "2026-10-20T00:00:00.000Z" });
        const merged = mergeCreemState(mergeCreemState(a, b), c);
        expect(merged).toEqual(mergeCreemState(a, mergeCreemState(b, c)));
        expect(merged.priceId).toBe("");
      }
});
