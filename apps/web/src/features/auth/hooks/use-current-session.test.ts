// @vitest-environment jsdom

/** 会话 hook 回归：SSR 初值、软导航、回前台失效检查及异步响应归属。 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CurrentSession, useCurrentSession } from "./use-current-session";

const route = vi.hoisted(() => ({ pathname: "/zh/dashboard" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }));

const firstSession: CurrentSession = {
  user: { id: "user-a", name: "First", email: "first@example.com" },
};
const secondSession: CurrentSession = {
  user: { id: "user-b", name: "Second", email: "second@example.com" },
};

const fetchSession = vi.fn<typeof fetch>();
let root: Root;
let container: HTMLDivElement;
let current: ReturnType<typeof useCurrentSession>;

/** 用实际组件消费 hook，让路由重渲、effect 清理与状态提交都由 React 执行。 */
function SessionProbe({ initialData }: { initialData?: CurrentSession }) {
  current = useCurrentSession(initialData);
  return createElement("span", null, current.data?.user?.id ?? "anonymous");
}

/** 模拟会话端点返回，保持撤销时返回 null 的现有约定。 */
function sessionResponse(session: CurrentSession) {
  return new Response(JSON.stringify(session), {
    headers: { "Content-Type": "application/json" },
  });
}

/** 渲染同一个 hook 实例；重复调用可模拟软导航而不重新挂载侧栏。 */
async function renderSession(initialData?: CurrentSession) {
  await act(async () => {
    root.render(createElement(SessionProbe, { initialData }));
  });
}

/** 推进浏览器定时器，并等待相应的异步会话状态提交。 */
async function advanceTime(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

/** 回前台可在不同事件任务中触发多个信号；这里保留每个事件的独立提交。 */
async function focusWindow() {
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchSession);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  fetchSession.mockReset();
  fetchSession.mockImplementation(async () => sessionResponse(firstSession));
  route.pathname = "/zh/dashboard";
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useCurrentSession", () => {
  it("有 SSR 初值时回前台验一次会话，之后三次软导航不再额外请求", async () => {
    await renderSession(firstSession);
    expect(fetchSession).not.toHaveBeenCalled();
    await focusWindow();
    await advanceTime(100);
    expect(fetchSession).toHaveBeenCalledTimes(1);
    expect(fetchSession.mock.calls[0]?.[1]).toMatchObject({
      cache: "no-store",
      credentials: "include",
      method: "POST",
      headers: { "Cache-Control": "no-store" },
    });

    for (const pathname of [
      "/zh/dashboard/history",
      "/zh/dashboard/gallery",
      "/zh/dashboard/settings",
    ]) {
      route.pathname = pathname;
      await renderSession(firstSession);
    }
    expect(fetchSession).toHaveBeenCalledTimes(1);
    expect(current.data).toEqual(firstSession);
  });

  it("合并同一轮回前台的 focus、visibility 和 bfcache 事件", async () => {
    await renderSession(firstSession);
    await focusWindow();
    await advanceTime(10);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await advanceTime(10);
    await act(async () => {
      const event = new Event("pageshow");
      Object.defineProperty(event, "persisted", { value: true });
      window.dispatchEvent(event);
    });
    await advanceTime(100);
    expect(fetchSession).toHaveBeenCalledTimes(1);
  });

  it("没有 SSR 初值的调用者仍在首次挂载和每次路径变化时更新会话", async () => {
    await renderSession();
    expect(fetchSession).toHaveBeenCalledTimes(1);
    route.pathname = "/zh/dashboard/history";
    await renderSession();
    expect(fetchSession).toHaveBeenCalledTimes(2);
  });

  it("有 SSR 初值时切页不打断尚未返回的显式刷新", async () => {
    let resolveRequest: (response: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    });
    fetchSession.mockReturnValueOnce(pending);
    await renderSession(firstSession);
    await focusWindow();
    await advanceTime(100);
    const signal = fetchSession.mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    route.pathname = "/zh/dashboard/history";
    await renderSession(firstSession);
    expect(fetchSession).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(false);
    await act(async () => resolveRequest(sessionResponse(null)));
    expect(current.data).toBeNull();
    expect(current.isPending).toBe(false);
  });

  it.each([
    "focus",
    "visibilitychange",
    "pageshow",
  ] as const)("%s 后仍会校验撤销及切换后的账号，不复用旧初值", async (eventType) => {
    fetchSession
      .mockResolvedValueOnce(sessionResponse(null))
      .mockResolvedValueOnce(sessionResponse(secondSession));
    await renderSession(firstSession);
    for (const expectedSession of [null, secondSession]) {
      await act(async () => {
        const event = new Event(eventType);
        if (eventType === "pageshow") {
          Object.defineProperty(event, "persisted", { value: true });
        }
        const target = eventType === "visibilitychange" ? document : window;
        target.dispatchEvent(event);
      });
      await advanceTime(100);
      expect(current.data).toEqual(expectedSession);
    }
    expect(fetchSession).toHaveBeenCalledTimes(2);
  });

  it("被取消的旧请求晚返回时不能覆盖新账号", async () => {
    let resolveOldRequest: (response: Response) => void = () => {};
    const oldRequest = new Promise<Response>((resolve) => {
      resolveOldRequest = resolve;
    });
    fetchSession
      .mockReturnValueOnce(oldRequest)
      .mockResolvedValueOnce(sessionResponse(secondSession));
    await renderSession(firstSession);
    await act(async () => current.reload());
    await act(async () => current.reload());
    expect(current.data).toEqual(secondSession);
    expect(fetchSession.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await act(async () => resolveOldRequest(sessionResponse(firstSession)));
    expect(current.data).toEqual(secondSession);
  });

  it("卸载时取消尚未发出的回前台校验", async () => {
    await renderSession(firstSession);
    await focusWindow();
    await act(async () => root.unmount());
    await advanceTime(100);
    expect(fetchSession).not.toHaveBeenCalled();
  });
});
