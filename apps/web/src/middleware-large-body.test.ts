/** 大请求 matcher 回归：使用当前 Next 的静态提取、编译和真实请求匹配器。 */
import { resolve } from "node:path";
import { getLargeBodyRoutePolicy } from "@repo/shared/rate-limit/large-body-routes";
import { getPagesPageStaticInfo } from "next/dist/build/analysis/get-page-static-info";
import { loadBindings } from "next/dist/build/swc";
import type { PAGE_TYPES } from "next/dist/lib/page-types";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/shared/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  createRateLimitResponse: vi.fn(),
  getClientIp: vi.fn(),
  getRateLimitHeaders: vi.fn(),
}));

import { config, middleware } from "./middleware";

const LARGE_PATHS = [
  "/api/images/chat",
  "/api/images/edit",
  "/api/editable-file/generate",
  ...["/v1", "/api/v1"].flatMap((prefix) =>
    [
      "/images/edits",
      "/agents/images",
      "/chat/completions",
      "/responses",
      "/ppts",
      "/psds",
    ].map((path) => `${prefix}${path}`)
  ),
];

/** 先鉴权再在 handler 内限长读取的入口，同样不经 middleware。 */
const SELF_AUTHENTICATED_PATHS = [
  "/moderate",
  "/api/mcp/user",
  "/api/mcp/admin",
];

/** 调用 Next 自己的匹配器，不能用手写正则替代部署时的语义。 */
function matches(path: string, headers?: Record<string, string>) {
  return unstable_doesMiddlewareMatch({ config, url: path, headers });
}

describe("大请求 middleware 边界", () => {
  it.each(LARGE_PATHS)("%s 绕过 body clone，包含尾斜线", (path) => {
    expect(matches(path)).toBe(false);
    expect(matches(`${path}/?async=true`)).toBe(false);
    expect(getLargeBodyRoutePolicy(path)).toBe(
      path.startsWith("/api/") && !path.startsWith("/api/v1/")
        ? "page-ai"
        : "external"
    );
    expect(getLargeBodyRoutePolicy(`${path}/`)).toBe(
      getLargeBodyRoutePolicy(path)
    );
  });

  it.each(
    SELF_AUTHENTICATED_PATHS
  )("%s 绕过 body clone，由 handler 限长读取", (path) => {
    expect(matches(path)).toBe(false);
    expect(matches(`${path}/`)).toBe(false);
    expect(getLargeBodyRoutePolicy(path)).toBe("self-authenticated");
    expect(getLargeBodyRoutePolicy(`${path}/`)).toBe("self-authenticated");
  });

  it.each([
    "/moderate-extra",
    "/api/mcp/users",
    "/api/mcp/user/extra",
    "/api/mcp",
  ])("相似路径 %s 仍受原 middleware 保护", (path) => {
    expect(matches(path)).toBe(true);
    expect(getLargeBodyRoutePolicy(path)).toBeNull();
  });

  it.each([
    "/api/auth/sign-in/email",
    "/api/auth/get-session",
    "/api/session/current",
    "/api/upload/presigned",
    "/api/images/generate",
    "/api/images/chat/web-select",
    "/api/images/chat-extra",
    "/api/images/edit/unknown",
    "/api/editable-file/generate-extra",
    "/v1/images/edits-extra",
    "/v1/models",
    "/api/v1/credits",
  ])("%s 仍受原 middleware 保护", (path) => {
    expect(matches(path)).toBe(true);
    expect(getLargeBodyRoutePolicy(path)).toBeNull();
  });

  it("Next 静态分析能提取字面量 matcher，且与运行时配置一致", async () => {
    await loadBindings();
    const info = await getPagesPageStaticInfo({
      pageFilePath: resolve("src/middleware.ts"),
      nextConfig: {},
      isDev: false,
      page: "/middleware",
      pageType: "pages" as PAGE_TYPES.PAGES,
    });
    expect(info.hadUnsupportedValue).toBe(false);
    expect(info.middleware?.matchers).toHaveLength(config.matcher.length);
    expect(info.middleware?.matchers?.[0]?.originalSource).toBe(
      config.matcher[0]
    );
  });

  it.each([
    "en",
    "zh",
  ])("%s 页面的 Server Action 仍匹配且认证重定向 no-store", async (locale) => {
    const path = `/${locale}/dashboard/create`;
    const headers = {
      "Next-Action": "test-action",
      "Content-Type": "multipart/form-data; boundary=test",
      Origin: "https://app.example.test",
    };
    expect(matches(path, headers)).toBe(true);
    const response = await middleware(
      new NextRequest(`https://app.example.test${path}`, {
        method: "POST",
        headers,
      })
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain(`/${locale}/sign-in`);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it.each([
    "en",
    "zh",
  ])("%s 已登录页面仍执行 locale 处理并禁止缓存", async (locale) => {
    const response = await middleware(
      new NextRequest(`https://app.example.test/${locale}/dashboard/create`, {
        headers: { Cookie: "better-auth.session_token=test-session" },
      })
    );
    expect(response.status).toBe(200);
    expect(
      response.headers.get("x-middleware-request-x-next-intl-locale")
    ).toBe(locale);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
});
