/** 画布薄 Action 回归；保留真实 protectedAction，只替换会话依赖及服务边界。 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  authenticated: true,
  banned: false,
  list: vi.fn(async (_userId: string) => []),
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@repo/shared/auth", () => ({
  auth: {
    api: {
      getSession: async () =>
        state.authenticated
          ? { user: { id: "session-owner", banned: state.banned } }
          : null,
    },
  },
}));
vi.mock("@repo/shared/auth/role-server", () => ({ getUserRoleById: vi.fn() }));
vi.mock("@repo/shared/logger", () => ({
  logError: vi.fn(),
  logger: { info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@repo/shared/monitoring", () => ({ captureError: vi.fn() }));
vi.mock("./server", () => ({ listCanvasImagesForUser: state.list }));

import { getCanvasImagesAction } from "./actions";

beforeEach(() => {
  state.authenticated = true;
  state.banned = false;
  state.list.mockClear();
});

describe("getCanvasImagesAction", () => {
  it("无需客户端参数，只把会话身份交给服务并返回列表", async () => {
    await expect(getCanvasImagesAction()).resolves.toMatchObject({ data: [] });
    expect(state.list).toHaveBeenCalledExactlyOnceWith("session-owner");
  });

  it("运行时额外传入他人 userId 不能覆盖会话身份", async () => {
    const result: unknown = await Reflect.apply(
      getCanvasImagesAction,
      undefined,
      [
        {
          userId: "victim",
          limit: 1000,
        },
      ]
    );
    expect(result).toMatchObject({ data: [] });
    expect(state.list).toHaveBeenCalledExactlyOnceWith("session-owner");
  });

  it("真实认证中间件拒绝未登录请求，服务调用为零", async () => {
    state.authenticated = false;
    await expect(getCanvasImagesAction()).resolves.toMatchObject({
      serverError: "登录已失效，请重新登录",
    });
    expect(state.list).not.toHaveBeenCalled();
  });

  it("真实认证中间件拒绝已封禁账号，服务调用为零", async () => {
    state.banned = true;
    await expect(getCanvasImagesAction()).resolves.toMatchObject({
      serverError: "账号已被封禁",
    });
    expect(state.list).not.toHaveBeenCalled();
  });
});
