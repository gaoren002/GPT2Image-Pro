/**
 * 客户端 i18n 命名空间裁剪(根布局按白名单下发)。
 *
 * 职责:根 layout 把整份 messages(zh 约 36KB)传给 NextIntlClientProvider,
 * 每个路由的 RSC payload 都携带全部命名空间。营销专属命名空间只被
 * (marketing) 路由消费,由营销布局经 MarketingIntlMessages 二次供给;
 * 根布局只下发应用区(dashboard/auth/docs/legal)需要的部分,每页省约
 * 8KB(gzip 前)。
 *
 * 维护:新增客户端 useTranslations/getTranslations 命名空间时,把顶层
 * key 加进对应白名单,否则翻译静默缺失(渲染 key 路径)。
 */

/** 应用区(非营销)客户端会消费的顶层命名空间。 */
export const APP_INTL_NAMESPACES = [
  "Admin",
  "Auth",
  "Common",
  "Cookie",
  "CreditTransactions",
  "Dashboard",
  "DashboardPages",
  "Gallery",
  "Header",
  "HomePage",
  "ImageGeneration",
  "Navigation",
  "Pricing",
  "Settings",
  "Subscription",
  "Support",
  "Toggle",
] as const;

/** 营销区额外需要的顶层命名空间。 */
export const MARKETING_INTL_NAMESPACES = [
  "AnonymousGenerate",
  "CTA",
  "Cinema",
  "FAQ",
  "Features",
  "Hero",
  "HowItWorks",
  "Solutions",
  "Testimonials",
  "UseCases",
] as const;

/** 从全量 messages 中挑选命名空间白名单内的子树;未知 key 忽略。 */
export function pickIntlNamespaces(
  messages: Record<string, unknown>,
  namespaces: readonly string[]
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const namespace of namespaces) {
    if (namespace in messages) {
      picked[namespace] = messages[namespace];
    }
  }
  return picked;
}
