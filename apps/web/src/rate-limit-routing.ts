import type { RateLimitType } from "@repo/shared/rate-limit";
import { getHandlerRateLimitType } from "@repo/shared/rate-limit/large-body-routes";

/**
 * API 路由限流配置（白名单模式）
 *
 * 外接 /v1 生图接口不在这里做每分钟请求限流；它们已经进入套餐并发队列，
 * 超出并发的请求应排队，而不是被通用 20/min AI 限流提前拒绝。
 */
const API_RATE_LIMITS: Array<{ pattern: RegExp; type: RateLimitType }> = [
  // 认证相关 - 严格限流防暴力破解
  { pattern: /^\/api\/auth\/sign-in/, type: "auth" },
  { pattern: /^\/api\/auth\/sign-up/, type: "auth" },
  { pattern: /^\/api\/auth\/registration-verification/, type: "auth" },
  { pattern: /^\/api\/auth\/request-password-reset/, type: "auth" },
  { pattern: /^\/api\/auth\/forget-password/, type: "auth" },
  { pattern: /^\/api\/auth\/forgot-password/, type: "auth" },
  { pattern: /^\/api\/auth\/reset-password/, type: "auth" },
  // 上传相关
  { pattern: /^\/api\/upload/, type: "upload" },
  // 页面生图相关
  { pattern: /^\/api\/images\/generate/, type: "ai" },
  { pattern: /^\/api\/images\/edit/, type: "ai" },
  { pattern: /^\/api\/images\/chat(?:\/|$)/, type: "ai" },
];

/**
 * 获取 API 路由的限流类型
 *
 * @returns 限流类型，未匹配返回 null（不限流）
 */
export function getApiRateLimitType(pathname: string): RateLimitType | null {
  const handlerType = getHandlerRateLimitType(pathname);
  if (handlerType) return handlerType;
  for (const { pattern, type } of API_RATE_LIMITS) {
    if (pattern.test(pathname)) {
      return type;
    }
  }
  return null;
}
