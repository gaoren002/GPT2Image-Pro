/** Web 升级报价兼容入口，与事务预留共用实现。 */

export type {
  ProratedSubscription,
  SubscriptionCheckoutQuote,
} from "@repo/shared/subscription/services/upgrade-quote";
export {
  createSubscriptionCheckoutQuote,
  isEpayCurrentPlanRenewal,
} from "@repo/shared/subscription/services/upgrade-quote";
