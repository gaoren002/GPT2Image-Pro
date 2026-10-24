// @vitest-environment jsdom

/** 当前会话真实路由回归：数据库与认证替身；保留客户端投影、失效清 cookie 和禁缓存契约。 */
import {
  type CurrentSession,
  useCurrentSession,
} from "@/features/auth/hooks/use-current-session";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  getSession: vi.fn(),
  select: vi.fn(),
  rows: [] as unknown[],
  cookies: [
    { name: "better-auth.session_token", value: "cookie-secret" },
    { name: "__Secure-better-auth.session_data.0", value: "chunk-secret" },
    { name: "theme", value: "dark" },
  ],
}));
vi.mock("@repo/shared/auth", () => ({
  auth: { api: { getSession: boundary.getSession } },
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/zh/dashboard" }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ cookie: "session-cookie" }),
  cookies: async () => ({ getAll: () => boundary.cookies }),
}));
vi.mock("@repo/database", async () => {
  const { user } = await import("@repo/database/schema");
  return {
    user,
    db: {
      select: boundary.select.mockImplementation(() => ({
        from: () => ({ where: () => ({ limit: async () => boundary.rows }) }),
      })),
    },
  };
});

import { GET, POST } from "./route";

const userRow = {
  id: "user-1",
  name: "当前用户",
  email: "current@example.com",
  image: null,
  role: "observer_admin",
  banned: false,
  bannedReason: null,
};
const sessionMetadata = {
  id: "session-1",
  userId: "user-1",
  expiresAt: "2026-10-30T00:00:00.000Z",
  createdAt: "2026-10-23T00:00:00.000Z",
  updatedAt: "2026-10-24T00:00:00.000Z",
};

/** 所有返回分支都应禁止浏览器及 CDN 缓存，且按 Cookie 区分响应。 */
function expectNoStore(response: Response) {
  expect(response.headers.get("Cache-Control")).toContain("private, no-store");
  expect(response.headers.get("CDN-Cache-Control")).toBe("no-store");
  expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBe("no-store");
  expect(response.headers.get("Vary")).toBe("Cookie");
}

beforeEach(() => {
  vi.clearAllMocks();
  boundary.rows = [userRow];
  boundary.getSession.mockResolvedValue({
    session: { ...sessionMetadata, token: "session-token-secret" },
    user: { ...userRow, name: "旧会话姓名" },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe.each([GET, POST])("会话路由 %s", (handler) => {
  it("剔除 token，保留会话元数据和当前用户供客户端消费", async () => {
    const response = await handler();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({ session: sessionMetadata, user: userRow });
    expect(body.session).not.toHaveProperty("token");
    expect(JSON.stringify(body)).not.toContain("session-token-secret");
    const clientSession: CurrentSession = body;
    expect(clientSession?.user?.id).toBe("user-1");
    expect(clientSession?.user?.name).toBe("当前用户");
    expect(clientSession?.user?.role).toBe("observer_admin");
    expect(boundary.getSession).toHaveBeenCalledWith({
      headers: expect.any(Headers),
    });
    expect(response.cookies.getAll()).toEqual([]);
    expectNoStore(response);
  });

  it.each([
    "撤销",
    "删号",
  ])("%s 后返回 null 并清理认证 cookie", async (state) => {
    if (state === "撤销") boundary.getSession.mockResolvedValue(null);
    else boundary.rows = [];
    const response = await handler();
    expect(await response.json()).toBeNull();
    expectNoStore(response);
    expect(response.cookies.getAll()).toEqual([
      expect.objectContaining({
        name: "better-auth.session_token",
        value: "",
        maxAge: 0,
        httpOnly: true,
      }),
      expect.objectContaining({
        name: "__Secure-better-auth.session_data.0",
        value: "",
        maxAge: 0,
        secure: true,
      }),
    ]);
    if (state === "撤销") expect(boundary.select).not.toHaveBeenCalled();
  });

  it("保留被封禁用户的最新状态", async () => {
    boundary.rows = [{ ...userRow, banned: true, bannedReason: "违规" }];
    const body = await (await handler()).json();
    expect(body.user).toMatchObject({ banned: true, bannedReason: "违规" });
    expect(body.session).not.toHaveProperty("token");
  });
});

it("客户端会话 hook 直接消费真实 POST 响应，刷新后仍有用户且不依赖 token", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const fetchSession = vi.fn<typeof fetch>(async () => POST());
  vi.stubGlobal("fetch", fetchSession);
  let current: ReturnType<typeof useCurrentSession> | undefined;
  /** 实际挂载客户端消费者，让 React 执行 fetch、JSON 解析和状态提交。 */
  function SessionConsumer() {
    current = useCurrentSession();
    return createElement("span", null, current.data?.user?.name ?? "anonymous");
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(SessionConsumer)));
    expect(fetchSession).toHaveBeenCalledTimes(1);
    expect(fetchSession.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      credentials: "include",
      cache: "no-store",
    });
    expect(current?.isPending).toBe(false);
    expect(current?.data).toEqual({ session: sessionMetadata, user: userRow });
    expect(JSON.stringify(current?.data)).not.toContain("session-token-secret");
    expect(container.textContent).toBe("当前用户");
  } finally {
    await act(async () => root.unmount());
  }
});
