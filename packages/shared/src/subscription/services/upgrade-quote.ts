/** Web 报价预览读取器；预留事务使用 prepare-upgrade-quote 加载后的纯 calculator。 */
import { db } from "@repo/database";
import { creditsBatch } from "@repo/database/schema";
import { and, eq, gt, gte, isNull, lt, or, sql } from "drizzle-orm";
import {
  findRuntimePlanByPriceId,
  getSubscriptionMonthlyCredits,
} from "../../config/payment-runtime";
import { getPlanFromPriceId } from "../../config/subscription-plan";
import {
  calculateSubscriptionUpgradeQuote,
  type PreparedUpgradePrice,
  type ProratedSubscription,
  type SubscriptionCheckoutQuote,
} from "./upgrade-quote-calculator";

export type {
  ProratedSubscription,
  SubscriptionCheckoutQuote,
} from "./upgrade-quote-calculator";
/** 同价格仅在易支付渠道视为续费。 */
export function isEpayCurrentPlanRenewal(
  currentPriceId: string | null | undefined,
  targetPriceId: string,
  useEpay: boolean
) {
  return Boolean(useEpay && currentPriceId && currentPriceId === targetPriceId);
}
/** 报价预览使用真实时间，非法日期回退为空。 */
function toValidDate(value: Date | null) {
  return value && !Number.isNaN(value.getTime()) ? value : null;
}

async function getRemainingSubscriptionCredits(
  current: ProratedSubscription,
  now: Date
) {
  const start = toValidDate(current.currentPeriodStart);
  const end = toValidDate(current.currentPeriodEnd);
  const filters = [
    eq(creditsBatch.userId, current.userId),
    eq(creditsBatch.sourceType, "subscription"),
    eq(creditsBatch.status, "active"),
    gt(creditsBatch.remaining, 0),
    or(isNull(creditsBatch.expiresAt), gt(creditsBatch.expiresAt, now)),
    start ? gte(creditsBatch.issuedAt, start) : sql`true`,
    end ? lt(creditsBatch.issuedAt, end) : sql`true`,
  ];

  const [result] = await db
    .select({
      remaining:
        sql<number>`coalesce(sum(${creditsBatch.remaining}), 0)`.mapWith(
          Number
        ),
    })
    .from(creditsBatch)
    .where(and(...filters));

  return Math.max(0, result?.remaining ?? 0);
}

/** 读取当前报价预览；不在任何财务事务中调用。 */
export async function createSubscriptionCheckoutQuote(
  current: ProratedSubscription,
  targetPriceId: string,
  now = new Date()
): Promise<SubscriptionCheckoutQuote> {
  const targetPlan = getPlanFromPriceId(targetPriceId);
  const { price: targetPrice } = await findRuntimePlanByPriceId(targetPriceId);
  if (!targetPlan || targetPlan === "free" || !targetPrice)
    throw new Error("无效的目标套餐");
  if (!current.priceId) throw new Error("找不到当前订阅套餐");
  const currentPlan = getPlanFromPriceId(current.priceId);
  const { price: currentPrice } = await findRuntimePlanByPriceId(
    current.priceId
  );
  if (!currentPlan || currentPlan === "free" || !currentPrice)
    throw new Error("找不到当前订阅套餐");
  const monthly = await getSubscriptionMonthlyCredits();
  const remaining = await getRemainingSubscriptionCredits(current, now);
  const prices: PreparedUpgradePrice[] = [
    {
      ...currentPrice,
      priceId: current.priceId,
      plan: currentPlan,
      monthlyCredits: monthly[currentPlan],
    },
    {
      ...targetPrice,
      priceId: targetPriceId,
      plan: targetPlan,
      monthlyCredits: monthly[targetPlan],
    },
  ];
  return calculateSubscriptionUpgradeQuote(
    current,
    targetPriceId,
    now,
    remaining,
    prices
  );
}
