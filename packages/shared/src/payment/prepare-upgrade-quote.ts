/** 事务外加载升级费率；返回只捕获数值快照的同步纯 calculator，禁止锁内借用全局连接池。 */
import {
  getRuntimePaymentConfig,
  getSubscriptionMonthlyCredits,
  type PaidPlanId,
} from "../config/payment-runtime";
import {
  calculateSubscriptionUpgradeQuote,
  type PreparedUpgradePrice,
} from "../subscription/services/upgrade-quote-calculator";
import type { UpgradeQuoteCalculator } from "./upgrade-reservation-service";

/** 冷缓存 I/O 全部在这里完成；同次下单的旧价、目标价和月积分来自同一份冻结快照。 */
export async function prepareUpgradeQuote(
  targetPriceId: string
): Promise<UpgradeQuoteCalculator> {
  const [config, monthly] = await Promise.all([
    getRuntimePaymentConfig(),
    getSubscriptionMonthlyCredits(),
  ]);
  const prices: PreparedUpgradePrice[] = [];
  for (const plan of [
    "starter",
    "pro",
    "ultra",
    "enterprise",
  ] as const satisfies readonly PaidPlanId[]) {
    for (const price of config.plans[plan]?.prices ?? []) {
      prices.push(
        Object.freeze({
          priceId: price.priceId,
          plan,
          amount: price.amount,
          interval: price.interval,
          monthlyCredits: monthly[plan],
        })
      );
    }
  }
  const snapshot = Object.freeze(prices);
  const target = snapshot.find((price) => price.priceId === targetPriceId);
  if (!target) throw new Error("无效的目标套餐");
  return (current, remaining, now) => ({
    ...calculateSubscriptionUpgradeQuote(
      current,
      targetPriceId,
      now,
      remaining,
      snapshot
    ),
    yearly: target.interval === "yearly",
    targetCredits:
      target.monthlyCredits * (target.interval === "yearly" ? 12 : 1),
  });
}
