/** 验证 Web 分组固定图片模型和实际失败回退；隔离数据库、账号池及网络副作用。 */
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
  chatWithChatGptWeb: vi.fn(async () => ({ responseText: "回复" })),
}));

describe("image service Web-first fallback", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("uses Responses for prompt repair when a compatible backend is available", async () => {
    process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";
    const { getModerationPromptRepairConfig } = await import("./service");
    backendPoolMock.resolveImageBackendPoolConfig.mockResolvedValueOnce({
      config: {
        baseUrl: "https://api.example.test/v1",
        apiKey: "codex-key",
        backend: {
          type: "pool-account",
          id: "codex-1",
          accountBackend: "responses",
        },
      },
    });

    const result = await getModerationPromptRepairConfig({
      userId: "user-1",
      apiKeyId: "key-1",
    });

    expect(result.config.backend?.accountBackend).toBe("responses");
    expect(
      backendPoolMock.resolveImageBackendPoolConfig
    ).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        userId: "user-1",
        apiKeyId: "key-1",
        requestKind: "responses",
        accountBackendPreference: "responses",
        allowAnyResponsesBackend: true,
      })
    );
  });

  it("falls back to a cross-group Web text account only when Responses is unavailable", async () => {
    process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";
    const { getModerationPromptRepairConfig } = await import("./service");
    backendPoolMock.resolveImageBackendPoolConfig
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        config: {
          baseUrl: "https://chatgpt.com",
          apiKey: "web-key",
          backend: {
            type: "pool-account",
            id: "web-1",
            accountBackend: "web",
          },
        },
      });

    const result = await getModerationPromptRepairConfig({
      userId: "user-1",
      apiKeyId: "key-1",
    });

    expect(result.config.backend?.accountBackend).toBe("web");
    expect(
      backendPoolMock.resolveImageBackendPoolConfig
    ).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        requestKind: "chat",
        accountBackendPreference: "web",
        spanGroupsForWeb: true,
        webRequestMode: "text",
      })
    );
  });

  it("falls back to Web when selected Responses backends fail at runtime", async () => {
    process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";
    const { repairModerationBlockedPromptWithFallback } = await import(
      "./service"
    );
    const { chatWithChatGptWeb } = await import("./chatgpt-web");
    vi.mocked(chatWithChatGptWeb).mockResolvedValueOnce({
      responseText: "safe Web rewrite",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      })
    );
    backendPoolMock.resolveImageBackendPoolConfig
      .mockResolvedValueOnce({
        config: {
          baseUrl: "https://api.example.test/v1",
          apiKey: "stale-codex-key",
          backend: {
            type: "pool-account",
            id: "codex-stale",
            groupId: "codex-group",
            userId: "user-1",
            requestKind: "responses",
            accountBackend: "responses",
            reportResult: true,
            inflightLease: true,
          },
        },
      })
      // Responses 池已重试耗尽。
      .mockResolvedValueOnce(null)
      // 编排层随后跨组选择 Web。
      .mockResolvedValueOnce({
        config: {
          baseUrl: "https://chatgpt.com",
          apiKey: "web-key",
          backend: {
            type: "pool-account",
            id: "web-fallback",
            groupId: "web-group",
            userId: "user-1",
            requestKind: "chat",
            accountBackend: "web",
            reportResult: true,
            inflightLease: true,
          },
        },
      });

    const result = await repairModerationBlockedPromptWithFallback({
      userId: "user-1",
      apiKeyId: "key-1",
      prompt: "blocked prompt",
      failureReason: "Content failed moderation",
      mode: "generate",
    });

    expect(result.prompt).toBe("safe Web rewrite");
    expect(chatWithChatGptWeb).toHaveBeenCalledOnce();
    expect(
      backendPoolMock.resolveImageBackendPoolConfig
    ).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        requestKind: "chat",
        accountBackendPreference: "web",
        spanGroupsForWeb: true,
        webRequestMode: "text",
      })
    );
  });

  it("repairs a prompt through a low-thinking GPT-5.5 Web text turn", async () => {
    process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";
    const { repairModerationBlockedPrompt } = await import("./service");
    const { chatWithChatGptWeb } = await import("./chatgpt-web");
    vi.mocked(chatWithChatGptWeb).mockResolvedValueOnce({
      responseText: '```text\n优化后的提示词："一幅安全的电影感人物肖像"\n```',
    });

    const result = await repairModerationBlockedPrompt(
      {
        baseUrl: "https://chatgpt.com",
        apiKey: "web-key",
        backend: {
          type: "pool-account",
          id: "web-1",
          accountBackend: "web",
          reportResult: false,
        },
      },
      {
        prompt: "被拦截的人物提示词",
        failureReason: "Content failed moderation",
        mode: "generate",
        size: "1024x1024",
      }
    );

    expect(result.prompt).toBe("一幅安全的电影感人物肖像");
    expect(chatWithChatGptWeb).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        gptModel: "gpt-5.5",
        thinking: "low",
        promptOptimization: false,
        failFastConversationPolling: true,
        prompt: expect.stringMatching(
          /Do not use tools or generate an image[\s\S]*被拦截的人物提示词/
        ),
      }),
      []
    );
  });

  it("does not penalize or switch Web accounts after the local repair timeout", async () => {
    process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";
    const { repairModerationBlockedPrompt } = await import("./service");
    const { chatWithChatGptWeb } = await import("./chatgpt-web");
    const controller = new AbortController();
    vi.mocked(chatWithChatGptWeb).mockImplementationOnce(async () => {
      controller.abort();
      return { error: "Image generation timed out after 20 minutes" };
    });

    const result = await repairModerationBlockedPrompt(
      {
        baseUrl: "https://chatgpt.com",
        apiKey: "web-key",
        backend: {
          type: "pool-account",
          id: "web-timeout",
          groupId: "web-group",
          userId: "user-1",
          requestKind: "chat",
          accountBackend: "web",
          reportResult: true,
          inflightLease: true,
        },
      },
      {
        prompt: "blocked prompt",
        failureReason: "Content failed moderation",
        mode: "generate",
        signal: controller.signal,
      }
    );

    expect(result.error).toBe("The operation was aborted due to timeout");
    expect(backendPoolMock.reportImageBackendResult).not.toHaveBeenCalled();
    expect(
      backendPoolMock.resolveImageBackendPoolConfig
    ).not.toHaveBeenCalled();
  });

  it("switches Web text accounts and does not consume image quota for prompt repair", async () => {
    process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";
    const { repairModerationBlockedPrompt } = await import("./service");
    const { chatWithChatGptWeb } = await import("./chatgpt-web");
    vi.mocked(chatWithChatGptWeb)
      .mockResolvedValueOnce({ error: "terminated" })
      .mockResolvedValueOnce({ responseText: "safe rewritten prompt" });
    backendPoolMock.resolveImageBackendPoolConfig.mockResolvedValueOnce({
      config: {
        baseUrl: "https://chatgpt.com",
        apiKey: "web-key-2",
        backend: {
          type: "pool-account",
          id: "web-2",
          groupId: "web-group-2",
          userId: "user-1",
          requestKind: "chat",
          accountBackend: "web",
          reportResult: true,
          inflightLease: true,
        },
      },
    });

    const result = await repairModerationBlockedPrompt(
      {
        baseUrl: "https://chatgpt.com",
        apiKey: "web-key-1",
        backend: {
          type: "pool-account",
          id: "web-1",
          groupId: "web-group-1",
          userId: "user-1",
          requestKind: "chat",
          accountBackend: "web",
          reportResult: true,
          inflightLease: true,
        },
      },
      {
        prompt: "blocked prompt",
        failureReason: "Content failed moderation",
        mode: "generate",
      }
    );

    expect(result).toMatchObject({
      prompt: "safe rewritten prompt",
      backendMember: { id: "web-2", accountBackend: "web" },
    });
    expect(backendPoolMock.resolveImageBackendPoolConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        spanGroupsForWeb: true,
        webRequestMode: "text",
        excludedMemberKeys: ["account:web-1"],
      })
    );
    expect(backendPoolMock.reportImageBackendResult).toHaveBeenLastCalledWith(
      expect.objectContaining({
        memberId: "web-2",
        success: true,
        consumeWebImageQuota: false,
      })
    );
  });

  it.each([
    "gpt-image-2",
    "gpt-image-2.5-flare",
    "firefly-nano-banana",
    "arbitrary-model",
  ])("纯 Web 的生成、编辑和聊天图片字段 %s 统一为 2.5", async (model) => {
    process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";
    const { generateImage, editImage, generateChatImage } = await import(
      "./service"
    );
    const {
      generateImageWithChatGptWeb,
      editImageWithChatGptWeb,
      chatWithChatGptWeb,
    } = await import("./chatgpt-web");
    const config = {
      baseUrl: "https://chatgpt.com",
      apiKey: "test-key",
      backend: {
        type: "pool-account" as const,
        id: "web-1",
        groupBackendType: "web" as const,
        accountBackend: "web" as const,
      },
    };
    const imageBase64 = Buffer.from("web-default").toString("base64");
    vi.mocked(generateImageWithChatGptWeb).mockResolvedValueOnce({
      imageBase64,
    });
    vi.mocked(editImageWithChatGptWeb).mockResolvedValueOnce({ imageBase64 });
    expect(
      (await generateImage(config, { prompt: "draw", model })).imageBase64
    ).toBe(imageBase64);
    expect(
      (await editImage(config, { prompt: "edit", model, images: [] }))
        .imageBase64
    ).toBe(imageBase64);
    for (const mock of [generateImageWithChatGptWeb, editImageWithChatGptWeb]) {
      expect(mock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ model: "gpt-image-2.5-sunburst" })
      );
    }
    const result = await generateChatImage(config, {
      prompt: "hello",
      model: "gpt-5.5",
      imageModel: model,
      webChat: true,
    });
    expect(result.responseText).toBe("回复");
    expect(chatWithChatGptWeb).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ gptModel: "gpt-5.5", model: "gpt-image-2.5" }),
      []
    );
  });

  it.each([
    "mixed",
    "web",
  ] as const)("dispatches GPT Image 2.5 to Web normally in a %s group", async (groupBackendType) => {
    process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";
    const { generateImage } = await import("./service");
    const { generateImageWithChatGptWeb } = await import("./chatgpt-web");
    const imageBase64 = Buffer.from("web-default-image").toString("base64");
    vi.mocked(generateImageWithChatGptWeb).mockResolvedValueOnce({
      imageBase64,
    });
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
    expect(result.imageBase64).toBe(imageBase64);
    expect(generateImageWithChatGptWeb).toHaveBeenCalledTimes(1);
    expect(
      backendPoolMock.releaseImageBackendInflightLease
    ).toHaveBeenCalledTimes(1);
    expect(
      backendPoolMock.releaseImageBackendInflightLease
    ).toHaveBeenCalledWith(expect.objectContaining({ memberId: "web-1" }));
    expect(backendPoolMock.reportImageBackendResult).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: "web-1", success: true })
    );
    expect(
      backendPoolMock.resolveImageBackendPoolConfig
    ).not.toHaveBeenCalled();
  });

  it("falls back to Responses only after GPT Image 2.5 Web requests fail and exhaust Web candidates", async () => {
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
        model: "gpt-image-2.5",
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
        model: "gpt-image-2.5",
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
