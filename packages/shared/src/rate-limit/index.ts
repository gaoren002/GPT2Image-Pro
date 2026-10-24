/**
 * Rate Limiting 模块
 *
 * 使用 Upstash Redis 实现分布式 API 限流。
 * 未配置 Upstash 时回退到单实例内存兜底限流（不 fail-open），
 * 多实例部署应配置 Upstash 获得跨实例共享的分布式限流。
 *
 * 环境变量:
 * - UPSTASH_REDIS_REST_URL: Upstash Redis REST URL
 * - UPSTASH_REDIS_REST_TOKEN: Upstash Redis REST Token
 * - RATE_LIMIT_*_REQUESTS_PER_MINUTE: 各类限流阈值
 */

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import type { NextRequest } from "next/server";

// ============================================
// 配置检查
// ============================================

/**
 * 检查 Upstash 是否已配置
 */
export function isRateLimitEnabled(): boolean {
  return !!(
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  );
}

// ============================================
// Redis 客户端（懒加载）
// ============================================

let redis: Redis | null = null;

function getRedis(): Redis | null {
  if (!isRateLimitEnabled()) {
    return null;
  }

  if (!redis) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    });
  }

  return redis;
}

// ============================================
// 限流器配置
// ============================================

/**
 * 限流器缓存（避免重复创建）
 */
const limiters = new Map<string, Ratelimit>();

/**
 * 预定义的限流配置
 */
function getPositiveIntegerEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.trunc(value);
}

export const RateLimitConfig = {
  /** 全局 API 限流 */
  global: {
    requests: getPositiveIntegerEnv(
      "RATE_LIMIT_GLOBAL_REQUESTS_PER_MINUTE",
      100
    ),
    window: "1m" as const,
  },
  /** 认证 API 限流（防暴力破解）*/
  auth: {
    requests: getPositiveIntegerEnv(
      "RATE_LIMIT_AUTH_REQUESTS_PER_MINUTE",
      5
    ),
    window: "1m" as const,
  },
  /** AI / 生图 API 限流 */
  ai: {
    requests: getPositiveIntegerEnv("RATE_LIMIT_AI_REQUESTS_PER_MINUTE", 20),
    window: "1m" as const,
  },
  /** 支付 API 限流 */
  payment: {
    requests: getPositiveIntegerEnv(
      "RATE_LIMIT_PAYMENT_REQUESTS_PER_MINUTE",
      10
    ),
    window: "1m" as const,
  },
  /** 上传 API 限流 */
  upload: {
    requests: getPositiveIntegerEnv(
      "RATE_LIMIT_UPLOAD_REQUESTS_PER_MINUTE",
      30
    ),
    window: "1m" as const,
  },
  /** 严格限流（用于敏感操作）*/
  strict: {
    requests: getPositiveIntegerEnv(
      "RATE_LIMIT_STRICT_REQUESTS_PER_MINUTE",
      3
    ),
    window: "1m" as const,
  },
} as const;

export type RateLimitType = keyof typeof RateLimitConfig;

/**
 * 获取或创建限流器
 */
function getLimiter(type: RateLimitType): Ratelimit | null {
  const redisClient = getRedis();
  if (!redisClient) {
    return null;
  }

  const cached = limiters.get(type);
  if (cached) {
    return cached;
  }

  const config = RateLimitConfig[type];
  const limiter = new Ratelimit({
    redis: redisClient,
    limiter: Ratelimit.slidingWindow(config.requests, config.window),
    prefix: `ratelimit:${type}`,
    analytics: true,
  });

  limiters.set(type, limiter);
  return limiter;
}

// ============================================
// 限流检查函数
// ============================================

/**
 * 限流检查结果
 */
export interface RateLimitResult {
  /** 是否允许请求 */
  success: boolean;
  /** 剩余请求数 */
  remaining: number;
  /** 重置时间（毫秒时间戳）*/
  reset: number;
  /** 限制数 */
  limit: number;
  /** 是否跳过了限流检查（未配置时）*/
  skipped: boolean;
}

/**
 * 检查限流
 *
 * @param identifier - 唯一标识符（如 IP 或 userId）
 * @param type - 限流类型
 * @returns 限流检查结果
 *
 * @example
 * ```ts
 * const result = await checkRateLimit(ip, "auth");
 * if (!result.success) {
 *   return new Response("Too Many Requests", { status: 429 });
 * }
 * ```
 */
// ============================================
// 内存兜底限流（未配置 Upstash 时，对敏感类型生效）
// ============================================

interface MemoryRateBucket {
  count: number;
  reset: number;
}

const memoryBuckets = new Map<string, MemoryRateBucket>();
const MEMORY_WINDOW_MS = 60_000;

/**
 * 单实例内存限流。用于未配置 Upstash 时所有限流类型的兜底，
 * 避免认证 / 验证码 / 注册等敏感端点以及生图 / 上传 / 支付等成本敏感端点
 * 完全 fail-open 被暴力破解、刷量或高频打满上游配额。
 * 窗口内放行不超过配置阈值的请求，故正常流量不受影响，仅拦截异常高频。
 * 多实例部署下不跨实例共享——生产应配置 Upstash 获得分布式限流。
 */
function checkMemoryRateLimit(
  identifier: string,
  type: RateLimitType
): RateLimitResult {
  const config = RateLimitConfig[type];
  const now = Date.now();
  const key = `${type}:${identifier}`;
  const bucket = memoryBuckets.get(key);

  if (!bucket || bucket.reset <= now) {
    if (memoryBuckets.size > 10000) {
      for (const [k, v] of memoryBuckets) {
        if (v.reset <= now) memoryBuckets.delete(k);
      }
    }
    memoryBuckets.set(key, { count: 1, reset: now + MEMORY_WINDOW_MS });
    return {
      success: true,
      remaining: config.requests - 1,
      reset: now + MEMORY_WINDOW_MS,
      limit: config.requests,
      skipped: false,
    };
  }

  bucket.count += 1;
  return {
    success: bucket.count <= config.requests,
    remaining: Math.max(0, config.requests - bucket.count),
    reset: bucket.reset,
    limit: config.requests,
    skipped: false,
  };
}

export async function checkRateLimit(
  identifier: string,
  type: RateLimitType = "global"
): Promise<RateLimitResult> {
  const limiter = getLimiter(type);

  // 未配置 Upstash：所有类型走单实例内存兜底限流，不再对成本敏感类型
  // （ai/upload/payment/global）fail-open。窗口内放行不超过阈值的请求，
  // 正常流量无感，仅拦截单 IP / 单 key 的异常高频，防止默认部署下零限流被
  // 无限刷量打满上游配额或暴力破解。生产应配置 Upstash 获得分布式限流。
  if (!limiter) {
    return checkMemoryRateLimit(identifier, type);
  }

  // Upstash 不可达时回落到单实例内存限流，而不是让异常冒到调用方。
  // WHY：限流在中间件里对认证路由同步执行，抛错会把登录/注册/找回密码整体变成 500；
  // 回落后仍有每进程的限额，比既不限流也不可用更好。
  let result: Awaited<ReturnType<Ratelimit["limit"]>>;
  try {
    result = await limiter.limit(identifier);
  } catch (error) {
    console.error(
      "[rate-limit] 限流存储不可用，回落到单实例内存限流",
      error
    );
    return checkMemoryRateLimit(identifier, type);
  }

  return {
    success: result.success,
    remaining: result.remaining,
    reset: result.reset,
    limit: result.limit,
    skipped: false,
  };
}

// ============================================
// 辅助函数
// ============================================

/**
 * 是否存在可信前置代理。
 *
 * WHY：cf-connecting-ip / x-real-ip / x-forwarded-for 这些头全部由 HTTP 客户端
 * 可写，只有当一个可信反代（Cloudflare / Nginx 等）覆盖写并清空伪造值时才可信。
 * 默认部署（docker-compose 直接暴露 web 端口、无反代）下三者均客户端可控，
 * 攻击者每次带随机 cf-connecting-ip 即可获得全新限流桶绕过 per-IP 限流。
 *
 * 为不破坏 Cloudflare / Nginx 既有部署（依赖这些头做真实 IP 归因），默认信任
 * 这些头；直接对公网暴露的部署应显式设置 RATE_LIMIT_TRUSTED_PROXY=false，
 * 关闭信任后所有请求归并到同一兜底标识，使 per-IP 限流退化为整体限流而非被旁路。
 */
function isTrustedProxyEnabled(): boolean {
  const value = process.env.RATE_LIMIT_TRUSTED_PROXY?.trim().toLowerCase();
  // 仅 "false" / "0" / "no" 显式关闭；未配置时保持向后兼容（默认信任）。
  return value !== "false" && value !== "0" && value !== "no";
}

/**
 * 从 NextRequest 获取客户端 IP，用作 per-IP 限流标识。
 *
 * @param request - 入站请求
 * @returns 客户端 IP 字符串；无可信来源时返回固定兜底标识
 *
 * 取值优先级：cf-connecting-ip → x-real-ip → x-forwarded-for 最左字段。
 * 前两者为受信反代设置的单值头；x-forwarded-for 最左字段由客户端可控，
 * 故放在最后兜底。这些头都不是天然防伪造的——仅在前置可信反代覆盖写时可信
 * （见 isTrustedProxyEnabled）。未声明可信代理时全部忽略，回退固定兜底标识，
 * 避免攻击者伪造头轮换 IP 旁路限流。
 */
export function getClientIp(request: NextRequest): string {
  if (!isTrustedProxyEnabled()) {
    // 无可信前置代理：所有转发头均不可信，统一归并到固定标识。
    // per-IP 限流在此降级为整体限流，宁可误伤共享出口也不被伪造头旁路。
    return "untrusted-proxy";
  }

  const cfIp = request.headers.get("cf-connecting-ip");
  if (cfIp) {
    return cfIp;
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp) {
    return realIp;
  }

  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() ?? "unknown";
  }

  return "unknown";
}

/**
 * 生成限流响应头
 */
export function getRateLimitHeaders(result: RateLimitResult): HeadersInit {
  if (result.skipped) {
    return {};
  }

  return {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(result.reset),
  };
}

/**
 * 创建 429 Too Many Requests 响应
 */
export function createRateLimitResponse(result: RateLimitResult): Response {
  const retryAfter = Math.ceil((result.reset - Date.now()) / 1000);

  return new Response(
    JSON.stringify({
      error: "Too Many Requests",
      message: "请求过于频繁，请稍后再试",
      retryAfter,
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfter),
        ...getRateLimitHeaders(result),
      },
    }
  );
}

// ============================================
// 高级 API：带限流的请求处理
// ============================================

/**
 * 限流包装器选项
 */
export interface WithRateLimitOptions {
  /** 限流类型 */
  type?: RateLimitType;
  /** 自定义标识符获取函数 */
  getIdentifier?: (request: NextRequest) => string | Promise<string>;
}

/**
 * 限流中间件包装器
 *
 * @example
 * ```ts
 * export async function POST(request: NextRequest) {
 *   return withRateLimit(request, { type: "auth" }, async () => {
 *     // 你的业务逻辑
 *     return NextResponse.json({ success: true });
 *   });
 * }
 * ```
 */
export async function withRateLimit<T extends Response>(
  request: NextRequest,
  options: WithRateLimitOptions,
  handler: () => Promise<T>
): Promise<T | Response> {
  const { type = "global", getIdentifier = getClientIp } = options;

  const identifier = await getIdentifier(request);
  const result = await checkRateLimit(identifier, type);

  if (!result.success) {
    return createRateLimitResponse(result);
  }

  const response = await handler();

  // 添加限流头到响应
  const headers = getRateLimitHeaders(result);
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }

  return response;
}
