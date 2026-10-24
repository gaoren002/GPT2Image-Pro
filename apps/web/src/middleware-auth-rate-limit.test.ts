/**
 * 中间件认证限流顺序测试（DB-free）。
 *
 * 约束：rate-limit-routing 中归为 "auth" 的认证路由必须真正执行限流，且认证路径的
 * 响应（含 429）都带 private/no-store。此前认证路径的 no-store 放行分支位于限流之前，
 * 认证限流从未执行。
 * 替换边界：@repo/shared/rate-limit 由测试控制是否超限；next-intl 中间件替换为直接放行
 * （本测试只覆盖 /api 分支，不涉及页面国际化）。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const limiter = vi.hoisted(() => ({
  exceeded: true,
  calls: [] as Array<{ identifier: string; type: string }>,
}));

vi.mock("@repo/shared/rate-limit", () => ({
  checkRateLimit: vi.fn(async (identifier: string, type: string) => {
    limiter.calls.push({ identifier, type });
    return {
      success: !limiter.exceeded,
      remaining: limiter.exceeded ? 0 : 4,
      reset: Date.now() + 60_000,
      limit: 5,
      skipped: false,
    };
  }),
  createRateLimitResponse: () =>
    new Response(JSON.stringify({ error: "Too Many Requests" }), {
      status: 429,
    }),
  getClientIp: () => "198.51.100.7",
  getRateLimitHeaders: () => ({ "X-RateLimit-Limit": "5" }),
}));

vi.mock("next-intl/middleware", async () => {
  const { NextResponse } = await import("next/server");
  return { default: () => () => NextResponse.next() };
});

vi.mock("@/i18n/routing", () => ({
  routing: { locales: ["zh", "en"], defaultLocale: "zh" },
}));

import { NextRequest } from "next/server";
import { middleware } from "./middleware";

const AUTH_PATHS = [
  "/api/auth/sign-in/email",
  "/api/auth/sign-up/email",
  "/api/auth/registration-verification",
  "/api/auth/request-password-reset",
  "/api/auth/reset-password",
];

function post(path: string) {
  return new NextRequest(`https://app.example.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

describe("middleware 认证限流", () => {
  beforeEach(() => {
    limiter.calls.length = 0;
    limiter.exceeded = true;
  });

  it("认证路由超限时返回 429 并带 no-store", async () => {
    for (const path of AUTH_PATHS) {
      const response = await middleware(post(path));
      expect(response.status, path).toBe(429);
      expect(response.headers.get("cache-control"), path).toContain(
        "no-store"
      );
    }
    expect(limiter.calls).toHaveLength(AUTH_PATHS.length);
    expect(limiter.calls.every((call) => call.type === "auth")).toBe(true);
  });

  it("认证路由未超限时放行并带限流头与 no-store", async () => {
    limiter.exceeded = false;
    const response = await middleware(post("/api/auth/sign-in/email"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratelimit-limit")).toBe("5");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("不在限流名单的认证路径不计数，但仍带 no-store", async () => {
    for (const path of ["/api/auth/get-session", "/api/session/current"]) {
      const response = await middleware(
        new NextRequest(`https://app.example.test${path}`)
      );
      expect(response.status, path).toBe(200);
      expect(response.headers.get("cache-control"), path).toContain(
        "no-store"
      );
    }
    expect(limiter.calls).toHaveLength(0);
  });
});
