/** 池重试行为回归：真实生成入口与错误分类，隔离数据库租约和 Web 上游副作用。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiConfig } from "./types";

vi.mock("@repo/database", () => ({ db: {} }));
vi.mock("@repo/shared/logger", () => ({ logError: vi.fn(), logWarn: vi.fn() }));
vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingBoolean: async () => false,
  getRuntimeSettingNumber: async (_key: string, fallback: number) => fallback,
  getRuntimeSettingString: async () => "",
}));

const pool = vi.hoisted(() => ({
  reportImageBackendResult: vi.fn(async () => ({ switchable: true })),
  resolveImageBackendPoolConfig: vi.fn(),
  releaseImageBackendInflightLease: vi.fn(async () => undefined),
  recordImageBackendSchedulerSwitch: vi.fn(async () => undefined),
  acquireImageBackendInflight: vi.fn(),
}));
vi.mock("@/features/image-backend-pool/service", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...pool,
}));

const web = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("./chatgpt-web", () => ({
  generateImageWithChatGptWeb: web.run,
  editImageWithChatGptWeb: web.run,
  chatWithChatGptWeb: web.run,
}));

import { CLIENT_CLOSED_REQUEST_ERROR } from "./abort-reason";
import { editImage, generateChatImage, generateImage } from "./service";

/** 与 Next 在连接先于响应结束关闭时给 request.signal 的 reason 同形：name 为 ResponseAborted 的 Error。 */
function responseAborted() {
  const error = new Error();
  error.name = "ResponseAborted";
  return error;
}

/** 构造已由池调度持久预留的配置；复用时其 inflightLease 会被真实入口消费。 */
function config(id = "web-1"): ApiConfig {
  return {
    baseUrl: "https://chatgpt.com",
    apiKey: "test-key",
    backend: {
      type: "pool-account",
      id,
      groupId: "g1",
      groupBackendType: "web",
      userId: "user-1",
      apiKeyId: "key-1",
      requestKind: "image_generation",
      accountBackend: "web",
      priority: 50,
      reportResult: true,
      inflightLease: true,
      inflightLeaseId: `lease-${id}`,
      inflightLeasePersisted: true,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  pool.resolveImageBackendPoolConfig.mockReset();
  web.run.mockReset();
});

describe("池租约、取消和二次生成", () => {
  const entries = [
    (candidate: ApiConfig, signal: AbortSignal) =>
      generateImage(candidate, { prompt: "cat", signal }),
    (candidate: ApiConfig, signal: AbortSignal) =>
      editImage(candidate, { prompt: "cat", images: [], signal }),
    (candidate: ApiConfig, signal: AbortSignal) =>
      generateChatImage(candidate, { prompt: "cat", webChat: true, signal }),
  ];

  it.each(entries)("生成入口本地中止后不上报或换号 %#", async (entry) => {
    const controller = new AbortController();
    web.run.mockImplementationOnce(async () => {
      controller.abort();
      return { error: "The operation was aborted due to timeout" };
    });
    const result = await entry(config(), controller.signal);
    expect(result.error).toContain("aborted");
    expect(pool.reportImageBackendResult).not.toHaveBeenCalled();
    expect(pool.resolveImageBackendPoolConfig).not.toHaveBeenCalled();
    expect(pool.releaseImageBackendInflightLease).toHaveBeenCalledTimes(1);
  });

  it("已中止请求归还预留，不启动上游", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await generateImage(config(), {
      prompt: "cat",
      signal: controller.signal,
    });
    expect(result.error).toContain("aborted");
    expect(web.run).not.toHaveBeenCalled();
    expect(pool.reportImageBackendResult).not.toHaveBeenCalled();
    expect(pool.releaseImageBackendInflightLease).toHaveBeenCalledTimes(1);
  });

  it.each(entries)(
    "客户端断开导致的中止使用客户端取消文案，不记成超时 %#",
    async (entry) => {
      const controller = new AbortController();
      web.run.mockImplementationOnce(async () => {
        controller.abort(responseAborted());
        return { error: "This operation was aborted" };
      });
      const result = await entry(config(), controller.signal);
      expect(result.error).toBe(CLIENT_CLOSED_REQUEST_ERROR);
      expect(pool.reportImageBackendResult).not.toHaveBeenCalled();
      expect(pool.resolveImageBackendPoolConfig).not.toHaveBeenCalled();
      expect(pool.releaseImageBackendInflightLease).toHaveBeenCalledTimes(1);
    }
  );

  it("进入前客户端已断开：归还预留、不启动上游，并使用客户端取消文案", async () => {
    const controller = new AbortController();
    controller.abort(responseAborted());
    const result = await generateImage(config(), {
      prompt: "cat",
      signal: controller.signal,
    });
    expect(result.error).toBe(CLIENT_CLOSED_REQUEST_ERROR);
    expect(web.run).not.toHaveBeenCalled();
    expect(pool.reportImageBackendResult).not.toHaveBeenCalled();
    expect(pool.releaseImageBackendInflightLease).toHaveBeenCalledTimes(1);
  });

  it.each([
    "fetch failed",
    "ChatGPT Web proxy failed: HTTP 502 connection refused",
    "This operation was aborted",
  ])("基础设施故障不逐号上报或换号：%s", async (error) => {
    web.run.mockResolvedValueOnce({ error });
    const result = await generateImage(config(), { prompt: "cat" });
    expect(result.error).toBe(error);
    expect(pool.reportImageBackendResult).not.toHaveBeenCalled();
    expect(pool.resolveImageBackendPoolConfig).not.toHaveBeenCalled();
    expect(pool.releaseImageBackendInflightLease).toHaveBeenCalledTimes(1);
  });

  it("先提交成员失败，再释放名额", async () => {
    web.run.mockResolvedValueOnce({ error: "HTTP 401: token_invalidated" });
    pool.resolveImageBackendPoolConfig.mockResolvedValueOnce(null);
    await generateImage(config(), { prompt: "cat" });
    expect(
      pool.reportImageBackendResult.mock.invocationCallOrder[0]
    ).toBeLessThan(
      pool.releaseImageBackendInflightLease.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY
    );
  });

  it.each(["审核改写", "透明回退"])("%s 的下一轮重新取租约", async () => {
    const original = config();
    web.run.mockResolvedValueOnce({ error: "content_policy_violation" });
    pool.reportImageBackendResult.mockResolvedValueOnce({ switchable: false });
    await generateImage(original, { prompt: "blocked" });
    expect(original.backend?.inflightLease).toBe(false);

    const next = config("web-2");
    pool.resolveImageBackendPoolConfig.mockResolvedValueOnce({ config: next });
    web.run.mockResolvedValueOnce({ imageBase64: "aW1hZ2U=" });
    const result = await generateImage(original, { prompt: "repaired" });
    expect(result.backendMember?.id).toBe("web-2");
    expect(pool.resolveImageBackendPoolConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        apiKeyId: "key-1",
        requestKind: "image_generation",
        preferredMemberId: "web-1",
        preferredMemberType: "account",
      })
    );
    expect((web.run.mock.calls[1]?.[0] as ApiConfig).backend?.id).toBe("web-2");
    expect(pool.acquireImageBackendInflight).not.toHaveBeenCalled();
    expect(pool.releaseImageBackendInflightLease).toHaveBeenLastCalledWith(
      expect.objectContaining({ leaseId: "lease-web-2", leasePersisted: true })
    );
  });

  it("二次生成池满时不调用旧成员", async () => {
    const original = config();
    if (original.backend) original.backend.inflightLease = false;
    pool.resolveImageBackendPoolConfig.mockResolvedValueOnce(null);
    const result = await generateImage(original, { prompt: "repaired" });
    expect(result.error).toBeTruthy();
    expect(web.run).not.toHaveBeenCalled();
    expect(pool.acquireImageBackendInflight).not.toHaveBeenCalled();
  });

  it("换号等待期间取消后归还新租约，不再启动上游", async () => {
    const controller = new AbortController();
    web.run.mockResolvedValueOnce({ error: "HTTP 429: usage_limit_reached" });
    pool.resolveImageBackendPoolConfig.mockImplementationOnce(async () => {
      controller.abort();
      return { config: config("web-2") };
    });
    const result = await generateImage(config(), {
      prompt: "cat",
      signal: controller.signal,
    });
    expect(result.error).toContain("aborted");
    expect(web.run).toHaveBeenCalledTimes(1);
    expect(pool.reportImageBackendResult).toHaveBeenCalledTimes(1);
    expect(pool.releaseImageBackendInflightLease).toHaveBeenCalledTimes(2);
  });
});
