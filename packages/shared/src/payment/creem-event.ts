/** Creem wire payload 校验与保守状态合并；供验签入口、UOL 和投影共用，不读取配置/数据库。 */
import { z } from "zod";
import type { CreemSubscription, CreemWebhookEvent } from "./creem";

export const creemEventTypes = [
  "checkout.completed",
  "subscription.active",
  "subscription.paid",
  "subscription.renewed",
  "subscription.canceled",
  "subscription.paused",
  "subscription.past_due",
  "subscription.expired",
  "subscription.unpaid",
  "subscription.scheduled_cancel",
  "subscription.update",
  "subscription.trialing",
] as const;

export const creemEventEnvelopeSchema = z
  .object({
    id: z.string().trim().min(1),
    eventType: z.enum(creemEventTypes),
    // 官方 wire 示例是 epoch 毫秒；不猜测秒值，也不使用接收时间补缺。
    created_at: z
      .number()
      .int()
      .min(1_000_000_000_000)
      .max(8_640_000_000_000_000),
    object: z.object({}).passthrough(),
  })
  .passthrough();

const date = z.string().datetime({ offset: true });
// 历史 payload 可省略 discriminator；一旦显式携带，就必须与实体匹配。
const customerSchema = z
  .object({
    id: z.string().min(1),
    object: z.literal("customer").optional(),
  })
  .passthrough();
const productSchema = z
  .object({
    id: z.string().min(1),
    object: z.literal("product").optional(),
  })
  .passthrough();
const checkoutSchema = z
  .object({
    id: z.string().min(1),
    object: z.literal("checkout").optional(),
    customer: customerSchema,
    product: productSchema.optional(),
    order: z
      .object({ object: z.literal("order").optional() })
      .passthrough()
      .optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
const subscriptionSchema = z
  .object({
    id: z.string().min(1),
    object: z.literal("subscription").optional(),
    status: z.enum([
      "active",
      "trialing",
      "scheduled_cancel",
      "canceled",
      "paused",
      "past_due",
      "unpaid",
      "expired",
    ]),
    product: z.union([z.string().min(1), productSchema]),
    customer: z.union([z.string().min(1), customerSchema]),
    current_period_start_date: date.optional(),
    current_period_end_date: date.optional(),
    cancel_at_period_end: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

/** 结构校验在任何落库之前完成；扩展 metadata 允许非字符串，但使用到的归属字段须为字符串。 */
export const creemWebhookInputSchema = creemEventEnvelopeSchema
  .superRefine((event, ctx) => {
    const checkout = event.eventType === "checkout.completed";
    const object = event.object;
    const sub = checkout ? object.subscription : object;
    const parsedCheckout = checkout
      ? checkoutSchema.safeParse(object)
      : undefined;
    const parsedSubscription =
      sub === undefined ? undefined : subscriptionSchema.safeParse(sub);
    if (parsedCheckout && !parsedCheckout.success) {
      ctx.addIssue({
        code: "custom",
        message: "Invalid checkout",
        path: ["object"],
      });
    }
    if (parsedSubscription && !parsedSubscription.success) {
      ctx.addIssue({
        code: "custom",
        message: "Invalid subscription",
        path: ["object"],
      });
    }
    if (parsedSubscription?.success) {
      const { current_period_start_date: start, current_period_end_date: end } =
        parsedSubscription.data;
      // 官方 expired 样例起止相同；它不授予权益。其他显式双边界必须构成非空区间。
      if (
        start &&
        end &&
        (Date.parse(start) > Date.parse(end) ||
          (Date.parse(start) === Date.parse(end) &&
            event.eventType !== "subscription.expired"))
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Invalid subscription period",
          path: ["object", "current_period_end_date"],
        });
      }
      if (parsedCheckout?.success) {
        const customer = parsedSubscription.data.customer;
        const subscriptionCustomerId =
          typeof customer === "string" ? customer : customer.id;
        if (parsedCheckout.data.customer.id !== subscriptionCustomerId) {
          ctx.addIssue({
            code: "custom",
            message: "Checkout and subscription customer mismatch",
            path: ["object", "subscription", "customer"],
          });
        }
      }
    }
    if (
      ["subscription.paid", "subscription.renewed"].includes(event.eventType) &&
      !hasCreemPaidPeriod(sub as CreemSubscription)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Paid subscription requires a valid period",
        path: ["object"],
      });
    }
    for (const metadata of [
      object.metadata,
      typeof sub === "object" && sub !== null && "metadata" in sub
        ? sub.metadata
        : undefined,
    ]) {
      if (
        metadata &&
        typeof metadata === "object" &&
        "userId" in metadata &&
        (typeof metadata.userId !== "string" || !metadata.userId.trim())
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Invalid userId",
          path: ["object", "metadata"],
        });
      }
    }
  })
  .transform((event) => event as unknown as CreemWebhookEvent);

export interface CreemStateSnapshot {
  status: string;
  priceId: string;
  periodStart: string | null;
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

/** 官方 active/checkout 样例可无周期；只有有效已知周期才沿原周期键 grant，不猜到期日。 */
export function hasCreemPaidPeriod(
  sub: CreemSubscription | undefined
): sub is CreemSubscription & {
  current_period_start_date: string;
  current_period_end_date: string;
} {
  return (
    typeof sub?.current_period_start_date === "string" &&
    typeof sub.current_period_end_date === "string" &&
    Number.isFinite(Date.parse(sub.current_period_start_date)) &&
    Date.parse(sub.current_period_end_date) >
      Date.parse(sub.current_period_start_date)
  );
}

/** 提取订阅快照；取消保留当前周期权益，真正暂停/欠费状态优先于取消宽限。 */
export function getCreemStateSnapshot(
  event: CreemWebhookEvent,
  sub: CreemSubscription
): CreemStateSnapshot {
  const statusByEvent: Record<string, string> = {
    "subscription.canceled": "canceled",
    "subscription.paused": "paused",
    "subscription.past_due": "past_due",
    "subscription.expired": "expired",
    "subscription.unpaid": "unpaid",
    "subscription.scheduled_cancel": "scheduled_cancel",
  };
  const status = statusByEvent[event.eventType] ?? sub.status;
  return {
    status: status === "scheduled_cancel" ? "active" : status,
    priceId: typeof sub.product === "string" ? sub.product : sub.product.id,
    periodStart: sub.current_period_start_date
      ? new Date(sub.current_period_start_date).toISOString()
      : null,
    periodEnd: sub.current_period_end_date
      ? new Date(sub.current_period_end_date).toISOString()
      : null,
    cancelAtPeriodEnd:
      status === "scheduled_cancel" ||
      status === "canceled" ||
      sub.cancel_at_period_end === true,
  };
}

/** rank 只选择状态；产品、周期和取消标记须独立收紧，不能随整条状态赢家扩大。 */
export function creemStateRank(state: CreemStateSnapshot): number {
  const ranks: Record<string, number> = {
    trialing: 0,
    active: 10,
    canceled: 20,
    past_due: 30,
    paused: 40,
    unpaid: 50,
    expired: 60,
  };
  return ranks[state.status] ?? 60;
}

/** 同水位的全部快照都取权益交集；跨状态也不能绕过产品冲突和周期边界收紧。 */
export function mergeCreemState(
  current: CreemStateSnapshot,
  incoming: CreemStateSnapshot
): CreemStateSnapshot {
  return {
    ...current,
    status:
      creemStateRank(current) >= creemStateRank(incoming)
        ? current.status
        : incoming.status,
    priceId: current.priceId === incoming.priceId ? current.priceId : "",
    periodStart:
      current.periodStart && incoming.periodStart
        ? current.periodStart > incoming.periodStart
          ? current.periodStart
          : incoming.periodStart
        : (current.periodStart ?? incoming.periodStart),
    periodEnd:
      current.periodEnd && incoming.periodEnd
        ? current.periodEnd < incoming.periodEnd
          ? current.periodEnd
          : incoming.periodEnd
        : (current.periodEnd ?? incoming.periodEnd),
    cancelAtPeriodEnd: current.cancelAtPeriodEnd || incoming.cancelAtPeriodEnd,
  };
}
