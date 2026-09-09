import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingBoolean: vi.fn(async () => false),
  getRuntimeSettingNumber: vi.fn(
    async (_key: string, fallback: number) => fallback
  ),
  getRuntimeSettingString: vi.fn(async () => ""),
}));

vi.mock("@repo/shared/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

const backendPoolMock = vi.hoisted(() => {
  class ImageBackendPoolUnavailableError extends Error {}
  return {
    ImageBackendPoolUnavailableError,
    acquireImageBackendInflight: vi.fn(),
    bindImageBackendStickyMember: vi.fn(async () => undefined),
    releaseImageBackendInflight: vi.fn(),
    releaseImageBackendInflightLease: vi.fn(async () => undefined),
    recordImageBackendSchedulerSwitch: vi.fn(async () => undefined),
    isImageBackendSwitchableError: vi.fn((error?: string | null) =>
      (error || "").includes("terminated")
    ),
    // 本测试只关注可切换错误的回退路径，未知错误兜底固定不触发。
    isUnclassifiedBackendError: vi.fn(() => false),
    reportImageBackendResult: vi.fn(async (input: { success: boolean }) => ({
      success: input.success,
      retryable: !input.success,
      switchable: !input.success,
    })),
    resolveImageBackendPoolConfig: vi.fn(),
  };
});

vi.mock("@/features/image-backend-pool/service", () => backendPoolMock);

vi.mock("./chatgpt-web", () => ({
  generateImageWithChatGptWeb: vi.fn(async () => ({ error: "terminated" })),
  editImageWithChatGptWeb: vi.fn(async () => ({ error: "terminated" })),
}));

describe("image service Web-first fallback", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it.each([
    "mixed",
    "web",
  ] as const)("does not report a Web account failure for unsupported 2.5 in a %s group", async (groupBackendType) => {
    process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";
    const { generateImage } = await import("./service");
    const { generateImageWithChatGptWeb } = await import("./chatgpt-web");
    const imageBase64 = Buffer.from("new-model-image").toString("base64");
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ data: [{ b64_json: imageBase64 }] }), {
          headers: { "Content-Type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    if (groupBackendType === "mixed") {
      backendPoolMock.resolveImageBackendPoolConfig.mockResolvedValueOnce({
        config: {
          baseUrl: "https://api.example.test/v1",
          apiKey: "codex-key",
          backend: {
            type: "pool-account",
            id: "codex-1",
            groupId: "group-1",
            userId: "user-1",
            requestKind: "image_generation",
            accountBackend: "responses",
            reportResult: true,
          },
        },
      });
    }
    const result = await generateImage(
      {
        baseUrl: "https://chatgpt.com",
        apiKey: "web-key",
        backend: {
          type: "pool-account",
          id: "web-1",
          groupId: "group-1",
          userId: "user-1",
          requestKind: "image_generation",
          accountBackend: "web",
          groupBackendType,
          inflightLease: true,
          reportResult: true,
        },
      },
      { prompt: "draw", model: "gpt-image-2.5", mixWebFirst: true }
    );
    expect(generateImageWithChatGptWeb).not.toHaveBeenCalled();
    expect(
      backendPoolMock.releaseImageBackendInflightLease
    ).toHaveBeenCalledWith(expect.objectContaining({ memberId: "web-1" }));
    expect(backendPoolMock.reportImageBackendResult).not.toHaveBeenCalledWith(
      expect.objectContaining({ memberId: "web-1" })
    );
    if (groupBackendType === "mixed") {
      expect(result.imageBase64).toBe(imageBase64);
      expect(
        backendPoolMock.resolveImageBackendPoolConfig
      ).toHaveBeenCalledWith(
        expect.objectContaining({ accountBackendPreference: "responses" })
      );
      const requestBody = JSON.parse(
        String(fetchMock.mock.calls[0]?.[1]?.body)
      );
      expect(requestBody.model).toBe("gpt-image-2.5-sunburst");
    } else {
      expect(result.error).toContain("WEB_IMAGE_MODEL_UNAVAILABLE");
      expect(
        backendPoolMock.resolveImageBackendPoolConfig
      ).not.toHaveBeenCalled();
    }
  });

  it("falls back to Responses when force Web exhausts Web candidates", async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";
    const { generateImage } = await import("./service");
    const imageBase64 = Buffer.from("codex-fallback-image").toString("base64");
    // codex(responses 账号)的普通生成现在直连 /images/generations(size 走顶层),
    // 不再走 /responses 工具路径;mock 返回标准 images JSON。
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({ data: [{ b64_json: imageBase64 }] }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    backendPoolMock.resolveImageBackendPoolConfig
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        config: {
          baseUrl: "https://api.example.test/v1",
          apiKey: "codex-key",
          model: "gpt-5.5",
          backend: {
            type: "pool-account",
            id: "codex-1",
            groupId: "group-1",
            userId: "user-1",
            requestKind: "image_generation",
            accountBackend: "responses",
            reportResult: true,
          },
        },
      });

    const result = await generateImage(
      {
        baseUrl: "https://chatgpt.com",
        apiKey: "web-key",
        backend: {
          type: "pool-account",
          id: "web-1",
          groupId: "group-1",
          // 混合分组:web 先行,轮询完才回退 codex(回退仅 mixed 生效)。
          groupBackendType: "mixed",
          userId: "user-1",
          requestKind: "image_generation",
          accountBackend: "web",
          reportResult: true,
        },
      },
      {
        prompt: "make an icon",
        model: "gpt-image-2",
        size: "1024x1024",
        forceWebBackend: true,
      }
    );

    expect(result.imageBase64).toBe(imageBase64);
    expect(
      backendPoolMock.resolveImageBackendPoolConfig
    ).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        accountBackendPreference: "web",
        accountBackendPreferenceMode: "mixed-only",
      })
    );
    expect(
      backendPoolMock.resolveImageBackendPoolConfig
    ).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        accountBackendPreference: "responses",
        accountBackendPreferenceMode: "mixed-only",
      })
    );
    // 回退到的 codex 账号在普通生成下命中直连 images 端点,而非 /responses。
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/v1/images/generations",
      expect.anything()
    );
  });

  it("非混合分组:Web 耗尽不回退 Codex(回退仅 mixed 生效)", async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";
    const { generateImage } = await import("./service");
    // 纯 web 分组的 web 成员撞可切换错误 → 换号 re-resolve 返回 null(web 已轮询完)。
    // 因目标分组非 mixed,不应触发 web→codex 回退,直接返回失败结果。
    backendPoolMock.resolveImageBackendPoolConfig.mockResolvedValueOnce(null);

    const result = await generateImage(
      {
        baseUrl: "https://chatgpt.com",
        apiKey: "web-key",
        backend: {
          type: "pool-account",
          id: "web-1",
          groupId: "group-web",
          // 纯 web 分组:闭环,web 耗尽即止,不跨车道回退 codex。
          groupBackendType: "web",
          userId: "user-1",
          requestKind: "image_generation",
          accountBackend: "web",
          reportResult: true,
        },
      },
      {
        prompt: "make an icon",
        model: "gpt-image-2",
        size: "1024x1024",
        forceWebBackend: true,
      }
    );

    // 返回失败结果(未回退到 codex,无图)。
    expect(result.imageBase64).toBeUndefined();
    expect(result.error).toContain("terminated");
    // 只发生一次 web 侧 re-resolve;绝不应再以 responses 偏好回退。
    expect(backendPoolMock.resolveImageBackendPoolConfig).toHaveBeenCalledTimes(
      1
    );
    expect(
      backendPoolMock.resolveImageBackendPoolConfig
    ).not.toHaveBeenCalledWith(
      expect.objectContaining({ accountBackendPreference: "responses" })
    );
  });

  it("retries another pool member when an account returns no image", async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";
    const { generateImage } = await import("./service");
    const imageBase64 = Buffer.from("second-member-image").toString("base64");
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length === 1) {
        // 首个 codex 成员的 /images/generations 返回无图,触发切换到下一个成员。
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ data: [{ b64_json: imageBase64 }] }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    backendPoolMock.resolveImageBackendPoolConfig.mockResolvedValueOnce({
      config: {
        baseUrl: "https://api.example.test/v1",
        apiKey: "codex-key-2",
        model: "gpt-5.5",
        backend: {
          type: "pool-account",
          id: "codex-2",
          groupId: "group-1",
          userId: "user-1",
          requestKind: "image_generation",
          accountBackend: "responses",
          reportResult: true,
        },
      },
    });

    const result = await generateImage(
      {
        baseUrl: "https://api.example.test/v1",
        apiKey: "codex-key-1",
        model: "gpt-5.5",
        backend: {
          type: "pool-account",
          id: "codex-1",
          groupId: "group-1",
          userId: "user-1",
          requestKind: "image_generation",
          accountBackend: "responses",
          reportResult: true,
        },
      },
      {
        prompt: "make an icon",
        model: "gpt-image-2",
        size: "1024x1024",
      }
    );

    expect(result.imageBase64).toBe(imageBase64);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(backendPoolMock.reportImageBackendResult).toHaveBeenCalledWith(
      expect.objectContaining({
        memberId: "codex-1",
        success: false,
        error: expect.stringContaining("API returned no image data"),
      })
    );
    expect(backendPoolMock.resolveImageBackendPoolConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        excludedMemberKeys: ["account:codex-1"],
      })
    );
    expect(result.backendAttempts).toEqual([
      expect.objectContaining({
        attempt: 1,
        backendId: "codex-1",
        error: expect.stringContaining("API returned no image data"),
      }),
      expect.objectContaining({
        attempt: 2,
        backendId: "codex-2",
      }),
    ]);
  });

  it("stops switching after three consecutive no-image results", async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";
    const { generateImage } = await import("./service");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
      )
    );

    backendPoolMock.resolveImageBackendPoolConfig.mockImplementation(
      async () => {
        const index =
          backendPoolMock.resolveImageBackendPoolConfig.mock.calls.length;
        return {
          config: {
            baseUrl: "https://api.example.test/v1",
            apiKey: `codex-key-${index + 1}`,
            model: "gpt-5.5",
            backend: {
              type: "pool-account",
              id: `codex-${index + 1}`,
              groupId: "group-1",
              userId: "user-1",
              requestKind: "image_generation",
              accountBackend: "responses",
              reportResult: true,
            },
          },
        };
      }
    );

    const result = await generateImage(
      {
        baseUrl: "https://api.example.test/v1",
        apiKey: "codex-key-1",
        model: "gpt-5.5",
        backend: {
          type: "pool-account",
          id: "codex-1",
          groupId: "group-1",
          userId: "user-1",
          requestKind: "image_generation",
          accountBackend: "responses",
          reportResult: true,
        },
      },
      {
        prompt: "make an icon",
        model: "gpt-image-2",
        size: "1024x1024",
      }
    );

    expect(result.error).toContain("API returned no image data");
    expect(result.backendAttempts).toHaveLength(3);
    expect(backendPoolMock.resolveImageBackendPoolConfig).toHaveBeenCalledTimes(
      2
    );
  });

  it("caps general switchable backend failures at eight attempts", async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";
    const { generateImage } = await import("./service");

    backendPoolMock.resolveImageBackendPoolConfig.mockImplementation(
      async () => {
        const index =
          backendPoolMock.resolveImageBackendPoolConfig.mock.calls.length;
        return {
          config: {
            baseUrl: "https://chatgpt.com",
            apiKey: `web-key-${index + 1}`,
            backend: {
              type: "pool-account",
              id: `web-${index + 1}`,
              groupId: "group-web",
              groupBackendType: "web",
              userId: "user-1",
              requestKind: "image_generation",
              accountBackend: "web",
              reportResult: true,
            },
          },
        };
      }
    );

    const result = await generateImage(
      {
        baseUrl: "https://chatgpt.com",
        apiKey: "web-key-1",
        backend: {
          type: "pool-account",
          id: "web-1",
          groupId: "group-web",
          groupBackendType: "web",
          userId: "user-1",
          requestKind: "image_generation",
          accountBackend: "web",
          reportResult: true,
        },
      },
      {
        prompt: "make an icon",
        model: "gpt-image-2",
        size: "1024x1024",
        forceWebBackend: true,
      }
    );

    expect(result.error).toBe("terminated");
    expect(result.backendAttempts).toHaveLength(8);
    expect(backendPoolMock.resolveImageBackendPoolConfig).toHaveBeenCalledTimes(
      7
    );
  });
});
