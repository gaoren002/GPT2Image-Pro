/** 侧栏客户端模块预热回归：注入 loader，不导入页面或执行任何真实数据请求。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSidebarPageModulePreloader } from "./sidebar-page-module-preload";

/** 可控制模块加载何时完成，验证导航不需要等待预热以及并发去重。 */
function pendingModule() {
  let resolve: (module: unknown) => void = () => undefined;
  const promise = new Promise<unknown>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 每个测试独立模拟三个客户端模块，不触及真实 dynamic import。 */
function setup() {
  const loaders = {
    users: vi.fn<() => Promise<unknown>>(async () => ({})),
    externalApi: vi.fn<() => Promise<unknown>>(async () => ({})),
    history: vi.fn<() => Promise<unknown>>(async () => ({})),
  };
  return { loaders, preload: createSidebarPageModulePreloader(loaders) };
}

describe("侧栏页面客户端模块预热", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["/zh/dashboard/admin/users", "users"],
    ["/en/dashboard/admin/users/", "users"],
    ["/zh/dashboard/external-api?tab=keys", "externalApi"],
    ["/en/dashboard/external-api#keys", "externalApi"],
    ["/zh/dashboard/history?page=2#records", "history"],
    ["/en/dashboard/history", "history"],
  ] as const)("只预热白名单 %s 对应的模块", async (href, route) => {
    const { loaders, preload } = setup();
    await expect(preload(href)).resolves.toEqual({ status: "loaded", route });
    expect(loaders[route]).toHaveBeenCalledTimes(1);
    expect(
      Object.values(loaders).reduce(
        (sum, load) => sum + load.mock.calls.length,
        0
      )
    ).toBe(1);
  });

  it.each([
    "https://other.example/zh/dashboard/history",
    "https://gpt2image.superapi.buzz/zh/dashboard/history",
    "//other.example/zh/dashboard/history",
    "javascript:alert(1)",
    "data:text/html,test",
    "#history",
    "/dashboard/history",
    "/fr/dashboard/history",
    "/ZH/dashboard/history",
    "/zh/dashboard/settings",
    "/zh/dashboard/admin/users/other",
    "/zh/dashboard/history-other",
    "/zh//dashboard/history",
    "/zh/dashboard/../dashboard/history",
    "/zh/dashboard/%68istory",
    "/zh\\dashboard\\history",
    " /zh/dashboard/history",
    "",
  ])("忽略外部或未知 href：%s", async (href) => {
    const { loaders, preload } = setup();
    await expect(preload(href)).resolves.toEqual({ status: "ignored" });
    for (const load of Object.values(loaders))
      expect(load).not.toHaveBeenCalled();
  });

  it("点击时立即启动模块导入，并返回未完成的 Promise，不要求导航等待", async () => {
    const { loaders, preload } = setup();
    const pending = pendingModule();
    loaders.history.mockReturnValueOnce(pending.promise);
    const result = preload("/zh/dashboard/history");

    expect(loaders.history).toHaveBeenCalledTimes(1);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    pending.resolve({});
    await expect(result).resolves.toEqual({
      status: "loaded",
      route: "history",
    });
  });

  it("同模块跨 locale/query 的并发与后续成功调用均去重", async () => {
    const { loaders, preload } = setup();
    const pending = pendingModule();
    loaders.history.mockReturnValueOnce(pending.promise);
    const first = preload("/zh/dashboard/history");
    const second = preload("/en/dashboard/history?page=2");
    expect(second).toBe(first);
    expect(loaders.history).toHaveBeenCalledTimes(1);
    pending.resolve({});
    await first;
    expect(preload("/zh/dashboard/history#top")).toBe(first);
    expect(loaders.history).toHaveBeenCalledTimes(1);
  });

  it("不同页面各自加载，不互相占用同一去重项", async () => {
    const { loaders, preload } = setup();
    await Promise.all([
      preload("/zh/dashboard/admin/users"),
      preload("/zh/dashboard/external-api"),
      preload("/zh/dashboard/history"),
    ]);
    for (const load of Object.values(loaders))
      expect(load).toHaveBeenCalledTimes(1);
  });

  it("异步加载失败不外抛，显式报告并释放去重项以便重试", async () => {
    const { loaders, preload } = setup();
    const error = new Error("chunk unavailable");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    loaders.users.mockRejectedValueOnce(error);

    const first = preload("/zh/dashboard/admin/users");
    const second = preload("/en/dashboard/admin/users?query=test");
    expect(second).toBe(first);
    await expect(first).resolves.toEqual({
      status: "failed",
      route: "users",
      error,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    await expect(preload("/zh/dashboard/admin/users")).resolves.toEqual({
      status: "loaded",
      route: "users",
    });
    expect(loaders.users).toHaveBeenCalledTimes(2);
  });

  it("同步 loader 异常也被转为失败结果，之后可重试", async () => {
    const { loaders, preload } = setup();
    const error = new Error("sync loader failed");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    loaders.externalApi.mockImplementationOnce(() => {
      throw error;
    });
    const result = preload("/zh/dashboard/external-api");
    await expect(result).resolves.toEqual({
      status: "failed",
      route: "externalApi",
      error,
    });
    await expect(preload("/zh/dashboard/external-api")).resolves.toEqual({
      status: "loaded",
      route: "externalApi",
    });
  });
});
