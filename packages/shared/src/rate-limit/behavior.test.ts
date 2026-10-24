/**
 * rate-limit 行为单测（DB-free）
 *
 * 覆盖审计报告中的覆盖率缺口：
 * - checkRateLimit 在未配置 Upstash 时对所有类型走内存兜底（C-H15 / S-M5）
 * - checkRateLimit 在 Upstash 不可达时回落内存限流而非抛错（限流在认证中间件里同步
 *   执行，抛错会把登录/注册整体变成 500）
 * - checkMemoryRateLimit 的窗口滚动 / 命中上限边界 / remaining 钳制（C-H17）
 * - getClientIp 的头优先级与可信代理门控（C-L22 / S-M1）
 * - withRateLimit 的 429 短路与限流头注入（C-L23）
 *
 * 本测试不 import @repo/database，仅依赖 process.env 与构造的请求桩，
 * 故可在 packages/shared 的 DB-free vitest 中运行。
 */

import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const UPSTASH_ENV_KEYS = [
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
] as const;

const THRESHOLD_ENV_KEYS = [
  "RATE_LIMIT_GLOBAL_REQUESTS_PER_MINUTE",
  "RATE_LIMIT_AUTH_REQUESTS_PER_MINUTE",
  "RATE_LIMIT_AI_REQUESTS_PER_MINUTE",
  "RATE_LIMIT_PAYMENT_REQUESTS_PER_MINUTE",
  "RATE_LIMIT_UPLOAD_REQUESTS_PER_MINUTE",
  "RATE_LIMIT_STRICT_REQUESTS_PER_MINUTE",
] as const;

/**
 * 构造仅含指定请求头的 NextRequest 桩。
 * getClientIp / withRateLimit 只读 headers.get，故无需完整实现。
 */
function makeRequest(headers: Record<string, string> = {}): NextRequest {
  const lower = new Map<string, string>();
  for (const [k, v] of Object.entries(headers)) {
    lower.set(k.toLowerCase(), v);
  }
  return {
    headers: {
      get(name: string): string | null {
        return lower.get(name.toLowerCase()) ?? null;
      },
    },
  } as unknown as NextRequest;
}

/**
 * 重置模块（清空内存桶与限流器缓存）并在干净环境下重新导入。
 * 每个用例独立的 memoryBuckets 单例，避免跨用例计数串扰。
 */
async function importFreshModule() {
  vi.resetModules();
  return import("./index");
}

describe("checkRateLimit fail-closed routing without Upstash", () => {
  beforeEach(() => {
    for (const key of UPSTASH_ENV_KEYS) delete process.env[key];
    for (const key of THRESHOLD_ENV_KEYS) delete process.env[key];
  });

  it("falls back to memory limiting (not fail-open) for every type", async () => {
    const { checkRateLimit } = await importFreshModule();

    const types = ["auth", "strict", "ai", "upload", "payment", "global"] as const;
    for (const type of types) {
      const result = await checkRateLimit(`id-${type}`, type);
      // 不再对成本敏感类型 fail-open：skipped 必须为 false，且首次放行。
      expect(result.skipped).toBe(false);
      expect(result.success).toBe(true);
    }
  });
});

describe("checkMemoryRateLimit boundary logic", () => {
  beforeEach(() => {
    for (const key of UPSTASH_ENV_KEYS) delete process.env[key];
    for (const key of THRESHOLD_ENV_KEYS) delete process.env[key];
    // strict 默认 3 次/分钟，便于在小窗口断言边界。
    process.env.RATE_LIMIT_STRICT_REQUESTS_PER_MINUTE = "3";
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows up to the limit then blocks, and resets after the window", async () => {
    const { checkRateLimit } = await importFreshModule();
    const id = "boundary-id";

    // 前 3 次放行，remaining 递减到 0。
    const first = await checkRateLimit(id, "strict");
    expect(first.success).toBe(true);
    expect(first.remaining).toBe(2);

    const second = await checkRateLimit(id, "strict");
    expect(second.success).toBe(true);
    expect(second.remaining).toBe(1);

    const third = await checkRateLimit(id, "strict");
    expect(third.success).toBe(true);
    expect(third.remaining).toBe(0);

    // 第 4 次命中上限被拦截，remaining 被钳制为 0（不为负）。
    const fourth = await checkRateLimit(id, "strict");
    expect(fourth.success).toBe(false);
    expect(fourth.remaining).toBe(0);

    // 跨过窗口后桶重置，再次放行。
    vi.advanceTimersByTime(60_000);
    const afterReset = await checkRateLimit(id, "strict");
    expect(afterReset.success).toBe(true);
    expect(afterReset.remaining).toBe(2);
  });

  it("keeps independent buckets per identifier", async () => {
    const { checkRateLimit } = await importFreshModule();

    await checkRateLimit("user-a", "strict");
    await checkRateLimit("user-a", "strict");
    await checkRateLimit("user-a", "strict");
    const aBlocked = await checkRateLimit("user-a", "strict");
    expect(aBlocked.success).toBe(false);

    // 另一标识不受影响。
    const bFirst = await checkRateLimit("user-b", "strict");
    expect(bFirst.success).toBe(true);
  });
});

describe("getClientIp header priority and trusted-proxy gating", () => {
  beforeEach(() => {
    delete process.env.RATE_LIMIT_TRUSTED_PROXY;
  });

  it("prefers cf-connecting-ip over other forwarded headers", async () => {
    const { getClientIp } = await importFreshModule();
    const ip = getClientIp(
      makeRequest({
        "cf-connecting-ip": "1.1.1.1",
        "x-real-ip": "2.2.2.2",
        "x-forwarded-for": "3.3.3.3, 4.4.4.4",
      })
    );
    expect(ip).toBe("1.1.1.1");
  });

  it("uses x-real-ip when cf-connecting-ip is absent", async () => {
    const { getClientIp } = await importFreshModule();
    const ip = getClientIp(
      makeRequest({ "x-real-ip": "2.2.2.2", "x-forwarded-for": "3.3.3.3" })
    );
    expect(ip).toBe("2.2.2.2");
  });

  it("takes the leftmost trimmed x-forwarded-for as fallback", async () => {
    const { getClientIp } = await importFreshModule();
    const ip = getClientIp(
      makeRequest({ "x-forwarded-for": " 1.1.1.1 , 2.2.2.2 " })
    );
    expect(ip).toBe("1.1.1.1");
  });

  it("returns unknown when no forwarded headers are present", async () => {
    const { getClientIp } = await importFreshModule();
    expect(getClientIp(makeRequest())).toBe("unknown");
  });

  it("ignores all spoofable headers when trusted proxy is disabled", async () => {
    process.env.RATE_LIMIT_TRUSTED_PROXY = "false";
    const { getClientIp } = await importFreshModule();
    const ip = getClientIp(
      makeRequest({
        "cf-connecting-ip": "1.1.1.1",
        "x-real-ip": "2.2.2.2",
        "x-forwarded-for": "3.3.3.3",
      })
    );
    expect(ip).toBe("untrusted-proxy");
  });

  it("still trusts proxy headers by default for backward compatibility", async () => {
    const { getClientIp } = await importFreshModule();
    const ip = getClientIp(makeRequest({ "cf-connecting-ip": "9.9.9.9" }));
    expect(ip).toBe("9.9.9.9");
  });
});

describe("withRateLimit middleware wrapper", () => {
  beforeEach(() => {
    for (const key of UPSTASH_ENV_KEYS) delete process.env[key];
    for (const key of THRESHOLD_ENV_KEYS) delete process.env[key];
    // strict 设为 1 次/分钟，便于第二次请求触发 429。
    process.env.RATE_LIMIT_STRICT_REQUESTS_PER_MINUTE = "1";
    // 关闭可信代理使两次请求归并同一标识，确保命中限流。
    process.env.RATE_LIMIT_TRUSTED_PROXY = "false";
  });

  it("returns 429 and skips the handler when rate limited", async () => {
    const { withRateLimit } = await importFreshModule();
    const handler = vi.fn(async () => new Response("ok", { status: 200 }));
    const request = makeRequest();

    // 第一次放行。
    const first = await withRateLimit(request, { type: "strict" }, handler);
    expect(first.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);

    // 第二次超限：返回 429 且不再执行 handler。
    const second = await withRateLimit(request, { type: "strict" }, handler);
    expect(second.status).toBe(429);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("runs the handler and sets rate-limit headers when allowed", async () => {
    const { withRateLimit } = await importFreshModule();
    const handler = vi.fn(async () => new Response("ok", { status: 200 }));

    const response = await withRateLimit(
      makeRequest(),
      { type: "strict" },
      handler
    );

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(response.headers.get("X-RateLimit-Limit")).toBe("1");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(response.headers.get("X-RateLimit-Reset")).not.toBeNull();
  });
});

describe("checkRateLimit 在限流存储故障时回落", () => {
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of UPSTASH_ENV_KEYS) {
      original[key] = process.env[key];
    }
    process.env.UPSTASH_REDIS_REST_URL = "https://stub.upstash.invalid";
    process.env.UPSTASH_REDIS_REST_TOKEN = "stub-token";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const key of UPSTASH_ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    vi.restoreAllMocks();
  });

  it("Upstash 抛错时按内存限额放行而不是抛出", async () => {
    vi.doMock("@upstash/ratelimit", () => {
      class Ratelimit {
        static slidingWindow = () => ({});
        limit() {
          return Promise.reject(new Error("upstash unreachable"));
        }
      }
      return { Ratelimit };
    });
    // 仅用于构造限流器，不发起请求。
    vi.doMock("@upstash/redis", () => ({ Redis: class {} }));

    vi.resetModules();
    const { checkRateLimit } = await import("./index");

    const first = await checkRateLimit("fallback-id", "auth");
    expect(first.success).toBe(true);
    expect(first.skipped).toBe(false);
    expect(first.limit).toBeGreaterThan(0);

    vi.doUnmock("@upstash/ratelimit");
    vi.doUnmock("@upstash/redis");
  });
});
