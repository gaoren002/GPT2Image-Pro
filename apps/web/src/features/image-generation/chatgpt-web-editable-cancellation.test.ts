/** 文件 adapter 父取消回归：运行真实入口与直连/代理传输，fetch 隔离且不访问真实账号。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateFileWithChatGptWeb } from "./chatgpt-web";

vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingString: async () => undefined,
}));
vi.mock("@repo/shared/logger", () => ({ logError: vi.fn() }));

/** 可控网络起点；测试在 fetch 真正挂起后才触发父取消，避免依赖定时等待。 */
function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** 仅提供无凭据 fixture 的入口参数；信号来自真实调用方 controller。 */
function request(signal?: AbortSignal) {
  return {
    config: { baseUrl: "https://chatgpt.com", apiKey: "test-fixture", signal },
    kind: "ppt" as const,
    prompt: "fixture slides",
    images: [],
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("文件生成父取消信号", () => {
  it("已取消的父信号在任何网络调用前退出", async () => {
    vi.stubEnv("CHATGPT_WEB_PROXY_URL", "");
    const parent = new AbortController();
    const reason = new DOMException("caller cancelled", "AbortError");
    parent.abort(reason);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected network"));
    await expect(
      generateFileWithChatGptWeb(request(parent.signal))
    ).rejects.toBe(reason);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "",
    "https://proxy.invalid",
  ])("运行中取消会中止实际 fetch（proxy=%s）", async (proxy) => {
    vi.useFakeTimers();
    vi.stubEnv("CHATGPT_WEB_PROXY_URL", proxy);
    const parent = new AbortController();
    const started = gate();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((_url, init) => {
        const signal = init?.signal;
        if (!signal) return Promise.reject(new Error("missing fetch signal"));
        const response = new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
        started.release();
        return response;
      });
    const outcome = generateFileWithChatGptWeb(request(parent.signal)).then(
      () => null,
      (error: unknown) => error
    );
    await started.promise;
    try {
      const signal = fetchMock.mock.calls[0]?.[1]?.signal;
      expect(signal?.aborted).toBe(false);
      parent.abort(new DOMException("caller cancelled", "AbortError"));
      expect(signal?.aborted).toBe(true);
      expect(await outcome).toMatchObject({ name: "AbortError" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      // 旧实现不接父信号，先红时用原超时收尾，避免测试留下永不结算的 Promise。
      await vi.runAllTimersAsync();
      await outcome;
    }
  });

  it("异常退出解绑父监听器，避免长寿命调用方保留已完成任务", async () => {
    vi.stubEnv("CHATGPT_WEB_PROXY_URL", "");
    const parent = new AbortController();
    const add = vi.spyOn(parent.signal, "addEventListener");
    const remove = vi.spyOn(parent.signal, "removeEventListener");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("fixture upstream failure")
    );
    await expect(
      generateFileWithChatGptWeb(request(parent.signal))
    ).rejects.toThrow("fixture upstream failure");
    const registration = add.mock.calls.find(([event]) => event === "abort");
    expect(registration).toBeDefined();
    expect(remove).toHaveBeenCalledWith("abort", registration?.[1]);
  });
});
