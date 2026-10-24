/** 纯升级报价计算：无数据库、设置、缓存或异步调用，供预留事务和报价预览共用。 */
import type { PaidPlanId } from "../../config/payment-runtime";
import {
  PLAN_RANK,
  type SubscriptionPlan,
} from "../../config/subscription-plan";

export type PreparedUpgradePrice = {
  priceId: string;
  plan: PaidPlanId;
  amount: number;
  interval?: string | undefined;
  monthlyCredits: number;
};
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_UPGRADE_PAYMENT_CENTS = 1;

export type ProratedSubscription = {
  userId: string;
  priceId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
};

export type SubscriptionCheckoutQuote = {
  isUpgrade: boolean;
  amountDue: number;
  originalAmount: number;
  prorationCredit: number;
  dayProrationCredit: number;
  creditUsageProrationCredit: number;
  remainingSubscriptionCredits: number;
  subscriptionCredits: number;
  remainingDays: number;
  periodDays: number;
  targetPlan: SubscriptionPlan;
  upgradeFromPriceId?: string;
};

function toCents(amount: number) {
  return Math.round(amount * 100);
}

function fromCents(cents: number) {
  return cents / 100;
}

function toValidDate(value: Date | null) {
  if (!value) return null;
  return Number.isNaN(value.getTime()) ? null : value;
}

function fallbackPeriodDays(interval?: string) {
  return interval === "yearly" ? 365 : 30;
}

function getCycleSubscriptionCredits(
  monthlyCredits: number,
  interval?: string
) {
  return interval === "yearly" ? monthlyCredits * 12 : monthlyCredits;
}

function getPeriodDayCounts(
  current: ProratedSubscription,
  fallbackDays: number,
  now: Date
) {
  const start = toValidDate(current.currentPeriodStart);
  const end = toValidDate(current.currentPeriodEnd);
  const periodDays =
    start && end && end > start
      ? Math.max(1, Math.ceil((end.getTime() - start.getTime()) / DAY_MS))
      : fallbackDays;
  const remainingDays =
    end && end > now
      ? Math.min(
          periodDays,
          Math.max(0, Math.ceil((end.getTime() - now.getTime()) / DAY_MS))
        )
      : 0;

  return { periodDays, remainingDays };
}

/** 根据锁内订阅与实际余额、事务外冻结的费率同步计算；无效/降级/跨周期均拒绝。 */
export function calculateSubscriptionUpgradeQuote(
  current: ProratedSubscription,
  targetPriceId: string,
  now: Date,
  remainingSubscriptionCredits: number,
  prices: readonly PreparedUpgradePrice[]
): SubscriptionCheckoutQuote {
  const targetPrice = prices.find((price) => price.priceId === targetPriceId);
  if (!targetPrice) throw new Error("无效的目标套餐");
  const targetPlan = targetPrice.plan;
  if (!current.priceId) throw new Error("找不到当前订阅套餐");
  const currentPrice = prices.find(
    (price) => price.priceId === current.priceId
  );
  if (!currentPrice) throw new Error("找不到当前订阅套餐");
  const currentPlan = currentPrice.plan;
  if (PLAN_RANK[targetPlan] <= PLAN_RANK[currentPlan])
    throw new Error("只能升级到更高级套餐");
  if (currentPrice.interval !== targetPrice.interval)
    throw new Error("升级套餐需要选择与当前订阅相同的计费周期");
  const { periodDays, remainingDays } = getPeriodDayCounts(
    current,
    fallbackPeriodDays(currentPrice.interval),
    now
  );
  const currentAmountCents = toCents(currentPrice.amount);
  const targetAmountCents = toCents(targetPrice.amount);
  const dayProrationCreditCents = Math.min(
    currentAmountCents,
    Math.floor((currentAmountCents * remainingDays) / periodDays)
  );
  const subscriptionCredits = getCycleSubscriptionCredits(
    currentPrice.monthlyCredits,
    currentPrice.interval
  );
  const cappedRemainingSubscriptionCredits = Math.min(
    remainingSubscriptionCredits,
    subscriptionCredits
  );
  const creditUsageProrationCreditCents =
    subscriptionCredits > 0
      ? Math.min(
          currentAmountCents,
          Math.floor(
            (currentAmountCents * cappedRemainingSubscriptionCredits) /
              subscriptionCredits
          )
        )
      : 0;
  const prorationCreditCents = Math.min(
    dayProrationCreditCents,
    creditUsageProrationCreditCents
  );
  const amountDueCents = Math.max(
    MIN_UPGRADE_PAYMENT_CENTS,
    targetAmountCents - prorationCreditCents
  );

  return {
    isUpgrade: true,
    amountDue: fromCents(amountDueCents),
    originalAmount: fromCents(targetAmountCents),
    prorationCredit: fromCents(prorationCreditCents),
    dayProrationCredit: fromCents(dayProrationCreditCents),
    creditUsageProrationCredit: fromCents(creditUsageProrationCreditCents),
    remainingSubscriptionCredits,
    subscriptionCredits,
    remainingDays,
    periodDays,
    targetPlan,
    upgradeFromPriceId: current.priceId,
  };
}
