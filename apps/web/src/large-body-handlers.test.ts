/** 大入口回归：真实路由、日志包装器与限流器；仅隔离身份、配置、存储和生图服务。 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  signedIn: true,
  hasApiKey: true,
  canUse: true,
  run: vi.fn(),
}));

vi.mock("@repo/shared/auth", () => ({
  auth: {
    api: {
      getSession: async () =>
        state.signedIn ? { user: { id: "user-a" } } : null,
    },
  },
}));
vi.mock("@/features/external-api/auth", () => ({
  authenticateExternalApiRequest: async () =>
    state.hasApiKey
      ? { userId: "user-a", apiKeyId: "key-a", plan: "pro" }
      : null,
}));
vi.mock("@repo/shared/subscription/services/user-plan", () => ({
  getUserPlan: async () => ({ plan: "pro" }),
}));
vi.mock("@repo/shared/subscription/services/plan-capabilities", () => ({
  canUsePlanCapability: async () => state.canUse,
  getPlanBillingConfig: async () => ({ chatRoundCredits: 0 }),
  getPlanLimits: async () => ({
    maxChatImages: 8,
    maxChatContextChars: 32000,
    maxBatchCount: 3,
  }),
}));
vi.mock("@repo/shared/subscription/services/upload-limits", () => ({
  getPlanUploadLimits: async () => ({
    maxFileSizeBytes: 25 * 1024 * 1024,
    maxUploadBytes: 50 * 1024 * 1024,
  }),
}));
vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingString: async () => "",
  getRuntimeSettingBoolean: async () => true,
}));
vi.mock("@repo/shared/logger", () => ({
  logApiResponse: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("@repo/shared/credits/core", () => ({ consumeCredits: vi.fn() }));
vi.mock("@repo/shared/storage/providers", () => ({
  getStorageProvider: vi.fn(),
}));
vi.mock("@repo/shared/storage/signed-url", () => ({
  buildPublicImageUrl: vi.fn(),
  buildSignedStorageImageUrl: vi.fn(),
  StorageImageAccessError: class extends Error {},
}));
vi.mock("@/features/image-generation/operations", () => ({
  runImageGenerationForUser: state.run,
}));
vi.mock("@/features/image-generation/editable-file-operations", () => ({
  runEditableFileForUser: state.run,
}));
vi.mock("@/features/external-api/async-image-result", () => ({
  toAsyncImageResultPayload: vi.fn(),
  runAsyncImageGeneration: vi.fn(),
}));
vi.mock("@/features/external-api/async-image-tasks", () => ({
  AsyncImageTaskCapacityError: class extends Error {},
  completeAsyncImageTask: vi.fn(),
  createAsyncImageTask: vi.fn(),
  postAsyncImageCallback: vi.fn(),
  toAsyncImageTaskResponse: vi.fn(),
  toAsyncImageTaskCapacityResponse: vi.fn(),
  validateCallbackUrl: vi.fn(),
}));

import { withApiLogging } from "@repo/shared/api-logger";
import { RateLimitConfig } from "@repo/shared/rate-limit";
import { POST as editable } from "./app/api/editable-file/generate/route";
import { POST as chat } from "./app/api/images/chat/route";
import { POST as edit } from "./app/api/images/edit/route";
import { POST as generate } from "./app/api/images/generate/route";
import { POST as apiV1Edit } from "./app/api/v1/images/edits/route";
import { POST as v1Edit } from "./app/v1/images/edits/route";
import { middleware } from "./middleware";

let ipCounter = 0;

/** 每个用例有独立真实限流桶，不用修改生产限流器或等待窗口。 */
function nextIp() {
  return `198.51.100.${++ipCounter}`;
}

/** 使用真实 Request body；spy 只观察读取，不替代解析器。 */
function request(path: string, ip: string, json?: unknown) {
  return new NextRequest(`https://app.example.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": ip },
    body: JSON.stringify(json ?? {}),
  });
}

const PAGE_HANDLERS = [
  { path: "/api/images/chat", handler: chat },
  { path: "/api/images/edit", handler: edit },
  { path: "/api/editable-file/generate", handler: editable },
];

beforeEach(() => {
  state.signedIn = true;
  state.hasApiKey = true;
  state.canUse = true;
  state.run.mockReset();
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  vi.stubEnv("RATE_LIMIT_TRUSTED_PROXY", "true");
});

describe.each(PAGE_HANDLERS)("$path 真实入口限流", ({ path, handler }) => {
  it("用原 AI 限额在读取 body 前拒绝，并返回完整 429/no-store", async () => {
    const ip = nextIp();
    state.signedIn = false;
    for (let i = 0; i < RateLimitConfig.ai.requests; i++) {
      expect((await handler(request(path, ip))).status).toBe(401);
    }
    state.signedIn = true;
    const req = request(`${path}/`, ip);
    const jsonRead = vi.spyOn(req, "json");
    const formRead = vi.spyOn(req, "formData");
    const clone = vi.spyOn(req, "clone");
    const response = await handler(req);
    expect(response.status).toBe(429);
    expect(response.headers.get("x-ratelimit-limit")).toBe(
      String(RateLimitConfig.ai.requests)
    );
    expect(response.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(jsonRead).not.toHaveBeenCalled();
    expect(formRead).not.toHaveBeenCalled();
    expect(clone).not.toHaveBeenCalled();
    expect(req.bodyUsed).toBe(false);
    expect(state.run).not.toHaveBeenCalled();
  });

  it("未登录仍在 body 读取前返回 401", async () => {
    state.signedIn = false;
    const req = request(path, nextIp());
    const response = await handler(req);
    expect(response.status).toBe(401);
    expect(req.bodyUsed).toBe(false);
  });
});

it.each([
  "/api/auth/sign-in/email",
  "/api/auth/sign-up/email",
  "/api/auth/registration-verification",
  "/api/auth/request-password-reset",
  "/api/auth/forget-password",
  "/api/auth/forgot-password",
  "/api/auth/reset-password",
])("%s 保留真实 5/min 认证桶和 no-store", async (path) => {
  expect(RateLimitConfig.auth.requests).toBe(5);
  const ip = nextIp();
  for (let i = 0; i < RateLimitConfig.auth.requests; i++) {
    const response = await middleware(request(path, ip));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-ratelimit-limit")).toBe("5");
  }
  const response = await middleware(request(path, ip));
  expect(response.status).toBe(429);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("x-ratelimit-limit")).toBe("5");
});

it.each([
  "/api/auth/get-session",
  "/api/session/current",
])("%s 多次读取仍 no-store 且不占登录桶", async (path) => {
  const ip = nextIp();
  for (let i = 0; i < RateLimitConfig.auth.requests + 2; i++) {
    const response = await middleware(request(path, ip));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-ratelimit-limit")).toBeNull();
  }
});

it.each(PAGE_HANDLERS)("$path 已登录仍经过真实 body 解析与输入校验", async ({
  path,
  handler,
}) => {
  const req = request(path, nextIp());
  const response = await handler(req);
  // multipart 入口拒绝 JSON，JSON 入口拒绝不满足 schema 的空对象。
  expect([400, 413]).toContain(response.status);
  expect(response.headers.get("x-ratelimit-limit")).toBe(
    String(RateLimitConfig.ai.requests)
  );
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(state.run).not.toHaveBeenCalled();
});

it("聊天与编辑共用原 ai/IP 桶，不能轮换路径绕过", async () => {
  const ip = nextIp();
  state.signedIn = false;
  for (let i = 0; i < RateLimitConfig.ai.requests; i++) {
    await chat(request("/api/images/chat", ip));
  }
  expect((await edit(request("/api/images/edit", ip))).status).toBe(429);
});

it("小 AI POST 仍匹配 middleware，但计数也在 handler 统一执行一次", async () => {
  const ip = nextIp();
  state.signedIn = false;
  for (let i = 0; i < RateLimitConfig.ai.requests - 1; i++) {
    await chat(request("/api/images/chat", ip));
  }
  const req = request("/api/images/generate", ip);
  const passed = await middleware(req);
  expect(passed.status).toBe(200);
  expect(passed.headers.get("x-ratelimit-limit")).toBeNull();
  const response = await generate(req);
  expect(response.status).toBe(401);
  expect(response.headers.get("x-ratelimit-remaining")).toBe("0");
  state.signedIn = true;
  const denied = request("/api/images/generate", ip);
  expect((await generate(denied)).status).toBe(429);
  expect(denied.bodyUsed).toBe(false);
});

it("限流薄封装保留流式 no-transform、原响应与动态路由 context", async () => {
  const response = new Response("data: test\n\n", {
    headers: { "Cache-Control": "no-cache, no-transform" },
  });
  const context = { params: Promise.resolve({ id: "item-1" }) };
  const handler = vi.fn(
    async (_req: NextRequest, _context: typeof context) => response
  );
  const wrapped = withApiLogging(handler);
  const req = request("/api/images/chat", nextIp());
  expect(await wrapped(req, context)).toBe(response);
  expect(handler).toHaveBeenCalledWith(req, context);
  expect(response.headers.get("cache-control")).toContain("no-transform");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(req.bodyUsed).toBe(false);
});

it("editable 能力校验保留，成功通过限流的拒绝响应也带限流头/no-store", async () => {
  state.canUse = false;
  const response = await editable(
    request("/api/editable-file/generate", nextIp(), {
      kind: "psd",
      prompt: "test",
      base64Images: ["aW1hZ2U="],
    })
  );
  expect(response.status).toBe(403);
  expect(response.headers.get("x-ratelimit-limit")).toBe(
    String(RateLimitConfig.ai.requests)
  );
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(state.run).not.toHaveBeenCalled();
});

describe.each([
  { path: "/v1/images/edits", handler: v1Edit },
  { path: "/api/v1/images/edits", handler: apiV1Edit },
])("$path 产品规则", ({ path, handler }) => {
  it("超过通用 AI 每分钟次数仍先校验 API key，不新增分钟限流", async () => {
    state.hasApiKey = false;
    const ip = nextIp();
    for (let i = 0; i < RateLimitConfig.ai.requests + 2; i++) {
      const req = request(path, ip);
      const response = await handler(req);
      expect(response.status).toBe(401);
      expect(req.bodyUsed).toBe(false);
      expect(response.headers.get("x-ratelimit-limit")).toBeNull();
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    }
  });

  it("有效 API key 仍进入真实输入校验", async () => {
    const req = request(path, nextIp());
    const response = await handler(req);
    expect(response.status).toBe(400);
    expect(req.bodyUsed).toBe(true);
    expect(state.run).not.toHaveBeenCalled();
  });
});
