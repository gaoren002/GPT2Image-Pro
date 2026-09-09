import { afterEach, describe, expect, it, vi } from "vitest";
import { getInputImageUrl } from "./input-image-url";
import {
  buildResponsesImageEditRequest,
  buildResponsesImageGenerationRequest,
} from "./responses-image";
import {
  buildAgentContinuationInput,
  buildContinueGenerationFunctionCallItems,
  buildCurrentResponsesContent,
  buildGeneratedImageReferenceInstruction,
  buildPreviousResponseFallbackRequestBody,
  buildResponsesInput,
  buildResponsesStoreFalseFallbackRequestBody,
  getContinueGenerationFunctionCalls,
  isPreviousResponseStateError,
  isResponsesStoreUnsupportedError,
  RESPONSES_IMAGE_REFERENCE_INSTRUCTIONS,
  resolvePromptImageReferences,
  resolveResponsesNativeState,
  shouldEnableResponsesPreviousResponse,
  withResponsesImageReferenceInstructions,
} from "./responses-native-state";
import { extractResponsesImageCallBase64 } from "./responses-output";
import { normalizeResponsesImageRequestBody } from "./responses-request-normalizer";
import { extractResponsesTokenUsage } from "./responses-usage";
import type {
  ApiConfig,
  ChatHistoryMessage,
  ImageInputFile,
  StickyBackendMemberState,
} from "./types";

vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingBoolean: vi.fn(async (key: string, fallback = false) =>
    key === "IMAGE_RESPONSES_PREVIOUS_RESPONSE_ENABLED" ? true : fallback
  ),
  getRuntimeSettingNumber: vi.fn(
    async (_key: string, fallback: number) => fallback
  ),
  getRuntimeSettingString: vi.fn(async () => ""),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const accountA: StickyBackendMemberState = {
  type: "account",
  id: "acct-a",
  groupId: "group-a",
  accountBackend: "responses",
};

const accountB: StickyBackendMemberState = {
  type: "account",
  id: "acct-b",
  groupId: "group-a",
  accountBackend: "responses",
};

const webAccount: StickyBackendMemberState = {
  type: "account",
  id: "web-a",
  groupId: "group-web",
  accountBackend: "web",
};

const assistantWithNativeState: ChatHistoryMessage = {
  role: "assistant",
  variants: [
    {
      text: "done",
      responsesPreviousResponse: {
        responseId: "resp_previous",
        backendMember: accountA,
        store: true,
      },
    },
  ],
  activeVariant: 0,
};

const testImage: ImageInputFile = {
  data: Buffer.from("image-bytes"),
  name: "reference.png",
  type: "image/png",
};

describe("getInputImageUrl", () => {
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  const originalBetterAuthUrl = process.env.BETTER_AUTH_URL;
  const originalSecret = process.env.BETTER_AUTH_SECRET;

  afterEach(() => {
    if (originalAppUrl === undefined) {
      delete process.env.NEXT_PUBLIC_APP_URL;
    } else {
      process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
    }
    if (originalBetterAuthUrl === undefined) {
      delete process.env.BETTER_AUTH_URL;
    } else {
      process.env.BETTER_AUTH_URL = originalBetterAuthUrl;
    }
    if (originalSecret === undefined) {
      delete process.env.BETTER_AUTH_SECRET;
    } else {
      process.env.BETTER_AUTH_SECRET = originalSecret;
    }
  });

  it("builds absolute signed storage URLs for upstream image inputs", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test";
    process.env.BETTER_AUTH_SECRET = "test-secret";

    const url = getInputImageUrl({
      ...testImage,
      url: "/api/storage/generations/user/requests/ref.png",
      storageBucket: "generations",
      storageKey: "user/requests/ref.png",
    });

    expect(url).toMatch(
      /^https:\/\/app\.example\.test\/api\/storage\/generations\/user\/requests\/ref\.png\?sig=/
    );
    expect(url).toContain("&exp=");
  });

  it("does not send relative storage URLs to upstreams without a public base URL", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.BETTER_AUTH_URL;
    process.env.BETTER_AUTH_SECRET = "test-secret";

    expect(
      getInputImageUrl({
        ...testImage,
        url: "/api/storage/generations/user/requests/ref.png",
        storageBucket: "generations",
        storageKey: "user/requests/ref.png",
      })
    ).toBe("data:image/png;base64,aW1hZ2UtYnl0ZXM=");
  });

  it("inlines external input URLs as base64 when bytes are available", () => {
    // 第三方外链不再透传给上游（上游下载外链会被图床限流 429）；有字节即内联。
    expect(
      getInputImageUrl({
        ...testImage,
        url: "https://cdn.example.com/source.png",
      })
    ).toBe("data:image/png;base64,aW1hZ2UtYnl0ZXM=");
  });

  it("passes through first-party storage URLs without storageKey", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test";
    process.env.BETTER_AUTH_SECRET = "test-secret";

    const firstParty =
      "https://app.example.test/api/storage/generations/user/requests/ref.png?sig=a&exp=1";
    expect(
      getInputImageUrl({
        ...testImage,
        url: firstParty,
      })
    ).toBe(firstParty);
  });

  it("falls back to the external URL when no bytes are available", () => {
    // 历史图等无字节场景：无法 base64，best-effort 透传原外链。
    expect(
      getInputImageUrl({
        data: Buffer.alloc(0),
        name: "history.png",
        type: "image/png",
        url: "https://cdn.example.com/history.png",
      })
    ).toBe("https://cdn.example.com/history.png");
  });
});

function responsesConfig(): ApiConfig {
  return {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "test",
    backend: {
      type: "pool-account",
      id: "acct-a",
      groupId: "group-a",
      accountBackend: "responses",
    },
  };
}

describe("Responses native state request planning", () => {
  it("uses previous_response_id for the same Responses account", () => {
    const state = resolveResponsesNativeState({
      enabled: true,
      currentBackendMember: accountA,
      history: [assistantWithNativeState],
    });

    expect(state.canUsePreviousResponseId).toBe(true);
    expect(state.previousResponseId).toBe("resp_previous");
  });

  it("does not skip a newer assistant turn without native state", () => {
    const state = resolveResponsesNativeState({
      enabled: true,
      currentBackendMember: accountA,
      history: [
        assistantWithNativeState,
        {
          role: "assistant",
          variants: [{ text: "PDF turn used store:false" }],
          activeVariant: 0,
        },
      ],
    });

    expect(state.canUsePreviousResponseId).toBe(false);
    expect(state.previousResponseId).toBeUndefined();
  });

  it("does not reuse previous_response_id after account pool rotation", () => {
    const state = resolveResponsesNativeState({
      enabled: true,
      currentBackendMember: accountB,
      history: [assistantWithNativeState],
    });

    expect(state.canUsePreviousResponseId).toBe(false);
    expect(state.previousResponseId).toBeUndefined();
  });

  it("recognizes invalid previous response errors for manual-history fallback", () => {
    expect(
      isPreviousResponseStateError(
        "Upstream Responses API returned HTTP 400: Invalid previous_response_id"
      )
    ).toBe(true);
    expect(isPreviousResponseStateError("response not found")).toBe(true);
    expect(isPreviousResponseStateError("quota exceeded")).toBe(false);
  });

  it("plans fallback by switching from current-only input to manual history", () => {
    const currentOnly = [
      {
        role: "user" as const,
        content: buildCurrentResponsesContent("make it brighter", [testImage]),
      },
    ];
    const manualHistory = buildResponsesInput(
      "make it brighter",
      [testImage],
      undefined,
      [
        {
          role: "user",
          text: "make a poster",
        },
        assistantWithNativeState,
      ]
    );

    expect(currentOnly).toHaveLength(1);
    expect(manualHistory.length).toBeGreaterThan(1);
    expect(
      manualHistory.some(
        (message) =>
          "role" in message &&
          message.role === "user" &&
          message.content.some(
            (part) =>
              part.type === "input_text" && part.text === "make a poster"
          )
      )
    ).toBe(true);
  });

  it("builds fallback request by clearing previous_response_id", () => {
    const fallbackInput = buildResponsesInput(
      "retry with history",
      undefined,
      undefined,
      [{ role: "user", text: "original request" }]
    );
    const request = buildPreviousResponseFallbackRequestBody(
      {
        model: "gpt-5.5",
        input: [
          { role: "user", content: [{ type: "input_text", text: "retry" }] },
        ],
        previous_response_id: "resp_invalid",
        store: true,
      },
      fallbackInput
    );

    expect(request.previous_response_id).toBeUndefined();
    expect(request.input).toBe(fallbackInput);
    expect(request.store).toBe(true);
  });
});

describe("Responses native state cache observation", () => {
  it("extracts OAI cached input tokens as the native-state cache-read signal", () => {
    const usage = extractResponsesTokenUsage({
      usage: {
        input_tokens: 1200,
        output_tokens: 80,
        total_tokens: 1280,
        input_tokens_details: {
          cached_tokens: 896,
        },
      },
    });

    expect(usage).toEqual({
      inputTokens: 1200,
      outputTokens: 80,
      totalTokens: 1280,
      cachedInputTokens: 896,
    });
  });

  it("observes cached token reads after previous_response_id is reused", async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";
    const { generateChatImage } = await import("./service");
    const bodies: Array<Record<string, unknown>> = [];
    const imageBase64 = Buffer.from("native-state-image").toString("base64");
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}")) as Record<
        string,
        unknown
      >;
      bodies.push(body);
      const isContinuation = body.previous_response_id === "resp_first";
      return new Response(
        JSON.stringify({
          id: isContinuation ? "resp_second" : "resp_first",
          output: [
            {
              type: "image_generation_call",
              status: "completed",
              result: imageBase64,
            },
          ],
          usage: {
            input_tokens: isContinuation ? 900 : 1100,
            output_tokens: 40,
            total_tokens: isContinuation ? 940 : 1140,
            input_tokens_details: {
              cached_tokens: isContinuation ? 640 : 0,
            },
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const config = responsesConfig();
    const first = await generateChatImage(config, {
      prompt: "生成一张蓝色海报",
      model: "gpt-5.5",
      history: [],
    });
    expect(first.responsesPreviousResponse?.responseId).toBe("resp_first");
    expect(first.responsesUsage?.cachedInputTokens).toBe(0);

    const second = await generateChatImage(config, {
      prompt: "沿用上一轮风格，改成红色",
      model: "gpt-5.5",
      history: [
        {
          role: "assistant",
          variants: [
            {
              text: "first image",
              responsesPreviousResponse: first.responsesPreviousResponse,
            },
          ],
        },
      ],
    });

    expect(second.responsesPreviousResponse?.responseId).toBe("resp_second");
    expect(second.responsesUsage?.cachedInputTokens).toBeGreaterThan(0);
    expect(bodies[0]?.store).toBe(true);
    expect(bodies[0]).not.toHaveProperty("previous_response_id");
    expect(bodies[0]?.prompt_cache_key).toEqual(
      expect.stringMatching(/^g2i_[a-f0-9]{32}$/)
    );
    expect(bodies[1]).toMatchObject({
      store: true,
      previous_response_id: "resp_first",
    });
    // 每请求唯一盐 → 两次请求的 prompt_cache_key 必不同(中和中转结果缓存:既不串图,
    // 同一输入也能要不同结果)。
    expect(bodies[1]?.prompt_cache_key).toEqual(
      expect.stringMatching(/^g2i_[a-f0-9]{32}$/)
    );
    expect(bodies[1]?.prompt_cache_key).not.toEqual(
      bodies[0]?.prompt_cache_key
    );
  });

  it("scopes official prompt cache keys to the selected Responses backend", async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";
    const { generateChatImage } = await import("./service");
    const bodies: Array<Record<string, unknown>> = [];
    const imageBase64 = Buffer.from("cache-key-image").toString("base64");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body || "{}")));
        return new Response(
          JSON.stringify({
            id: "resp_cache",
            output: [
              {
                type: "image_generation_call",
                status: "completed",
                result: imageBase64,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    await generateChatImage(responsesConfig(), {
      prompt: "生成一张产品海报",
      model: "gpt-5.5",
      history: [],
    });
    await generateChatImage(
      {
        ...responsesConfig(),
        backend: {
          type: "pool-account",
          id: "account-b",
          accountBackend: "responses",
        },
      },
      {
        prompt: "生成一张产品海报",
        model: "gpt-5.5",
        history: [],
      }
    );

    expect(bodies[0]?.prompt_cache_key).toEqual(
      expect.stringMatching(/^g2i_[a-f0-9]{32}$/)
    );
    expect(bodies[1]?.prompt_cache_key).toEqual(
      expect.stringMatching(/^g2i_[a-f0-9]{32}$/)
    );
    expect(bodies[1]?.prompt_cache_key).not.toBe(bodies[0]?.prompt_cache_key);
  });

  it("falls back to store:false for Agent when upstream rejects native state", async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";
    const { generateChatImage } = await import("./service");
    const bodies: Array<Record<string, unknown>> = [];
    const imageBase64 = Buffer.from("agent-store-fallback-image").toString(
      "base64"
    );
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}")) as Record<
        string,
        unknown
      >;
      bodies.push(body);
      if (bodies.length === 1) {
        return new Response(
          JSON.stringify({
            error: { message: "Store must be set to false" },
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
      return new Response(
        JSON.stringify({
          id: "resp_store_false",
          output: [
            {
              type: "image_generation_call",
              status: "completed",
              result: imageBase64,
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateChatImage(responsesConfig(), {
      prompt: "继续上一版做一张海报",
      model: "gpt-5.5",
      history: [assistantWithNativeState],
      agentMode: true,
    });

    expect(result.error).toBeUndefined();
    expect(result.imageBase64).toBe(imageBase64);
    expect(result.responsesPreviousResponse).toBeUndefined();
    expect(bodies[0]).toMatchObject({
      store: true,
      previous_response_id: "resp_previous",
    });
    expect(bodies[1]?.store).toBe(false);
    expect(bodies[1]).not.toHaveProperty("previous_response_id");
  });
});

describe("Responses image output compatibility", () => {
  it("extracts image_generation_call result object base64 fields", () => {
    expect(
      extractResponsesImageCallBase64({
        type: "image_generation_call",
        result: { base64: "ZmlsZQ==" },
      })
    ).toBe("ZmlsZQ==");
    expect(
      extractResponsesImageCallBase64({
        type: "image_generation_call",
        result: { b64_json: "aW1hZ2U=" },
      })
    ).toBe("aW1hZ2U=");
    expect(
      extractResponsesImageCallBase64({
        type: "image_generation_call",
        result: { image: "cGl4ZWw=" },
      })
    ).toBe("cGl4ZWw=");
    expect(
      extractResponsesImageCallBase64({
        type: "image_generation_call",
        result: { data: "ZGF0YQ==" },
      })
    ).toBe("ZGF0YQ==");
  });
});

describe("Responses image references", () => {
  it("turns current <ref id> references into real input_image content", () => {
    const content = buildCurrentResponsesContent('use this <ref id="hero" />', [
      testImage,
    ]);

    expect(content).toContainEqual({
      type: "input_image",
      image_url: "data:image/png;base64,aW1hZ2UtYnl0ZXM=",
    });
    expect(
      content.some(
        (part) =>
          part.type === "input_text" &&
          part.text.includes('<ref id="current-reference-1"')
      )
    ).toBe(true);
    expect(
      content.some(
        (part) => part.type === "input_text" && part.text.includes("@图1")
      )
    ).toBe(true);
  });

  it("inlines current input images as base64 only when forceBase64 is set", () => {
    const previousAppUrl = process.env.NEXT_PUBLIC_APP_URL;
    const previousSecret = process.env.BETTER_AUTH_SECRET;
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test";
    process.env.BETTER_AUTH_SECRET = "test-secret";
    try {
      const storedImage: ImageInputFile = {
        ...testImage,
        url: "https://app.example.test/api/storage/generations/user/requests/ref.png?sig=old&exp=1",
        storageBucket: "generations",
        storageKey: "user/requests/ref.png",
      };

      // 默认（无 forceBase64）：第一方签名站内 URL，不内联。
      const normal = buildResponsesInput(
        "edit it",
        [storedImage],
        undefined,
        undefined
      );
      const normalImage = normal
        .flatMap((message) => ("content" in message ? message.content : []))
        .find((part) => part.type === "input_image");
      expect(
        normalImage?.type === "input_image" &&
          typeof normalImage.image_url === "string" &&
          normalImage.image_url.startsWith(
            "https://app.example.test/api/storage/"
          )
      ).toBe(true);

      // forceBase64 + 有字节：跳过 URL 选择，强制内联 base64（上游下载我方 URL 失败兜底）。
      const inlined = buildResponsesInput(
        "edit it",
        [storedImage],
        undefined,
        undefined,
        { forceBase64: true }
      );
      expect(
        inlined.some(
          (message) =>
            "content" in message &&
            message.content.some(
              (part) =>
                part.type === "input_image" &&
                part.image_url === "data:image/png;base64,aW1hZ2UtYnl0ZXM="
            )
        )
      ).toBe(true);
    } finally {
      if (previousAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = previousAppUrl;
      if (previousSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = previousSecret;
    }
  });

  it("uses signed temporary URLs for current uploaded images when available", () => {
    const previousAppUrl = process.env.NEXT_PUBLIC_APP_URL;
    const previousSecret = process.env.BETTER_AUTH_SECRET;
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test";
    process.env.BETTER_AUTH_SECRET = "test-secret";
    try {
      const content = buildCurrentResponsesContent("make variants", [
        {
          ...testImage,
          url: "https://app.example.test/api/storage/generations/user/requests/ref.png?sig=old&exp=1",
          storageBucket: "generations",
          storageKey: "user/requests/ref.png",
        },
      ]);

      // 有 storageKey 时以新签名站内 URL（第一方）发送，绝不内联 base64。
      const imagePart = content.find((part) => part.type === "input_image");
      expect(
        imagePart?.type === "input_image" &&
          typeof imagePart.image_url === "string" &&
          imagePart.image_url.startsWith(
            "https://app.example.test/api/storage/generations/user/requests/ref.png?sig="
          )
      ).toBe(true);
      expect(
        content.some(
          (part) =>
            part.type === "input_image" &&
            typeof part.image_url === "string" &&
            part.image_url.startsWith("data:image/")
        )
      ).toBe(false);
    } finally {
      if (previousAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = previousAppUrl;
      if (previousSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = previousSecret;
    }
  });

  it("uses image file IDs as real input_image references", () => {
    const content = buildCurrentResponsesContent('edit <ref id="file" />', [
      {
        ...testImage,
        imageFileId: "file_image_123",
      },
    ]);

    expect(content).toContainEqual({
      type: "input_image",
      file_id: "file_image_123",
    });
  });

  it("uses historical image file IDs before URLs for the same Responses backend", () => {
    const input = buildResponsesInput(
      "refine it",
      undefined,
      undefined,
      [
        {
          role: "assistant",
          variants: [
            {
              text: "Generated image",
              imageUrl: "https://cdn.example.com/starry.png",
              imageFileId: "file_img_cached",
              backendMember: accountA,
            },
          ],
        },
      ],
      { currentBackendMember: accountA }
    );

    expect(
      input.some(
        (message) =>
          "content" in message &&
          message.content.some(
            (part) =>
              part.type === "input_image" && part.file_id === "file_img_cached"
          )
      )
    ).toBe(true);
    expect(
      input.some(
        (message) =>
          "content" in message &&
          message.content.some(
            (part) =>
              part.type === "input_image" &&
              part.image_url === "https://cdn.example.com/starry.png"
          )
      )
    ).toBe(false);
  });

  it("drops historical image file IDs from @ refs when the Responses backend changes", () => {
    const history: ChatHistoryMessage[] = [
      {
        role: "assistant",
        variants: [
          {
            text: "Generated image",
            imageUrl: "https://cdn.example.com/starry.png",
            imageFileId: "file_img_wrong_account",
            backendMember: accountA,
          },
        ],
      },
    ];
    const resolved = resolvePromptImageReferences({
      prompt: "参考 @第1轮图1 继续",
      history,
      currentBackendMember: accountB,
    });
    const content = buildCurrentResponsesContent(
      resolved.prompt,
      undefined,
      undefined,
      {
        extraImageReferences: resolved.historyImageReferences,
      }
    );

    expect(content).toContainEqual({
      type: "input_image",
      image_url: "https://cdn.example.com/starry.png",
    });
    expect(
      content.some(
        (part) =>
          part.type === "input_image" &&
          part.file_id === "file_img_wrong_account"
      )
    ).toBe(false);
  });

  it("adds historical generated images as real image inputs in the next turn", () => {
    const input = buildResponsesInput("add a moon", undefined, undefined, [
      {
        role: "assistant",
        variants: [
          {
            text: "Generated image",
            imageUrl: "https://cdn.example.com/starry.png",
          },
        ],
      },
    ]);

    expect(
      input.some(
        (message) =>
          "content" in message &&
          message.content.some(
            (part) =>
              part.type === "input_image" &&
              part.image_url === "https://cdn.example.com/starry.png"
          )
      )
    ).toBe(true);
  });

  it("marks future Chat image outputs with stable history labels", () => {
    const input = buildResponsesInput(
      "generate a poster",
      undefined,
      undefined,
      [],
      {
        generatedImageReferenceInstruction:
          buildGeneratedImageReferenceInstruction({ roundIndex: 1 }),
      }
    );

    expect(
      input.some(
        (message) =>
          "content" in message &&
          message.content.some(
            (part) =>
              part.type === "input_text" &&
              part.text.includes("@第1轮图1") &&
              part.text.includes("history-round-1-image-1")
          )
      )
    ).toBe(true);
  });

  it("rewrites @图 mentions to current reference tags", () => {
    const resolved = resolvePromptImageReferences({
      prompt: "参考 @图1 做一版海报",
      images: [testImage],
    });

    expect(resolved.prompt).toContain('<ref id="current-reference-1"');
    expect(resolved.historyImageReferences).toEqual([]);
  });

  it("rewrites @第N轮图M mentions and attaches the referenced history image", () => {
    const history: ChatHistoryMessage[] = [
      {
        role: "assistant",
        variants: [
          {
            text: "first",
            imageUrl: "https://cdn.example.com/one.png",
          },
          {
            text: "second",
            imageUrl: "https://cdn.example.com/two.png",
          },
        ],
      },
    ];
    const resolved = resolvePromptImageReferences({
      prompt: "参考 @第1轮图2 继续",
      history,
    });
    const content = buildCurrentResponsesContent(
      resolved.prompt,
      undefined,
      undefined,
      {
        extraImageReferences: resolved.historyImageReferences,
      }
    );

    expect(resolved.prompt).toContain('<ref id="history-round-1-image-2"');
    expect(content).toContainEqual({
      type: "input_image",
      image_url: "https://cdn.example.com/two.png",
    });
  });

  it("attaches explicit historical @ refs even when native previous_response_id is used", () => {
    const history: ChatHistoryMessage[] = [
      {
        role: "assistant",
        variants: [
          {
            text: "first",
            imageUrl: "https://cdn.example.com/one.png",
          },
        ],
      },
    ];
    const resolved = resolvePromptImageReferences({
      prompt: "参考 @第1轮图1 继续",
      history,
    });
    const content = buildCurrentResponsesContent(
      resolved.prompt,
      undefined,
      undefined,
      {
        extraImageReferences: resolved.historyImageReferences,
      }
    );

    expect(content).toContainEqual({
      type: "input_image",
      image_url: "https://cdn.example.com/one.png",
    });
    expect(
      content.some(
        (part) =>
          part.type === "input_text" &&
          part.text.includes("@第1轮图1") &&
          part.text.includes("Use this label")
      )
    ).toBe(true);
  });

  it("passes PDF attachments as input_file for Responses", () => {
    const content = buildCurrentResponsesContent(
      "summarize then make an image",
      undefined,
      [
        {
          data: Buffer.from("%PDF-1.7"),
          name: "brief.pdf",
          type: "application/pdf",
        },
      ]
    );

    expect(content).toContainEqual({
      type: "input_file",
      filename: "brief.pdf",
      file_data: "data:application/pdf;base64,JVBERi0xLjc=",
    });
  });
});

describe("Agent continue_generation tool", () => {
  it("extracts continue_generation function calls", () => {
    const calls = getContinueGenerationFunctionCalls([
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "continue_generation",
        arguments: JSON.stringify({ reason: "Need a polished second draft" }),
      },
    ]);

    expect(calls).toEqual([
      {
        id: "fc_1",
        callId: "call_1",
        name: "continue_generation",
        arguments: JSON.stringify({ reason: "Need a polished second draft" }),
        reason: "Need a polished second draft",
      },
    ]);
  });

  it("builds function call outputs for the next manual-history Agent round", () => {
    const items = buildContinueGenerationFunctionCallItems({
      includeFunctionCallInputs: true,
      outputItems: [
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "continue_generation",
          arguments: JSON.stringify({ reason: "Need another version" }),
        },
      ],
    });

    expect(items).toEqual([
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "continue_generation",
        arguments: JSON.stringify({ reason: "Need another version" }),
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: JSON.stringify({
          ok: true,
          continue: true,
          reason: "Need another version",
        }),
      },
    ]);
  });

  it("keeps Agent draft image refs text-only when native state is active", () => {
    const input = buildAgentContinuationInput({
      baseInput: [],
      previousResult: {
        imageOutputs: [
          { imageBase64: Buffer.from("draft").toString("base64") },
        ],
      },
      currentRound: 1,
      maxRounds: 3,
      historyRoundIndex: 1,
      includeImageEntities: false,
    });

    expect(
      input.some(
        (message) =>
          "content" in message &&
          message.content.some((part) => part.type === "input_image")
      )
    ).toBe(false);
    expect(
      input.some(
        (message) =>
          "content" in message &&
          message.content.some(
            (part) =>
              part.type === "input_text" &&
              part.text.includes("Agent round 1 draft 1")
          )
      )
    ).toBe(true);
    expect(
      input.some(
        (message) =>
          "content" in message &&
          message.content.some(
            (part) =>
              part.type === "input_text" && part.text.includes("@第1轮图2")
          )
      )
    ).toBe(true);
  });
});

describe("backend isolation", () => {
  it("enables store only for internal Chat/Agent Responses backend", () => {
    expect(
      shouldEnableResponsesPreviousResponse({
        settingEnabled: true,
        currentBackendMember: accountA,
      })
    ).toBe(true);
    expect(
      shouldEnableResponsesPreviousResponse({
        settingEnabled: true,
        rawResponsesBody: { input: "external" },
        currentBackendMember: accountA,
      })
    ).toBe(false);
    expect(
      shouldEnableResponsesPreviousResponse({
        settingEnabled: true,
        currentBackendMember: accountA,
        files: [
          {
            data: Buffer.from("%PDF"),
            name: "brief.pdf",
            type: "application/pdf",
          },
        ],
      })
    ).toBe(false);
    expect(
      shouldEnableResponsesPreviousResponse({
        settingEnabled: true,
        currentBackendMember: webAccount,
      })
    ).toBe(false);
  });

  it("does not enable Responses native state for Web backend state", () => {
    const state = resolveResponsesNativeState({
      enabled: false,
      currentBackendMember: webAccount,
      history: [assistantWithNativeState],
    });

    expect(state.canUsePreviousResponseId).toBe(false);
    expect(state.previousResponseId).toBeUndefined();
  });

  it("keeps external raw Responses pass-through store disabled", () => {
    const body = normalizeResponsesImageRequestBody(
      {
        model: "gpt-5.5",
        input: "draw",
        previous_response_id: "resp_external",
        prompt_cache_key: "caller-cache-key",
        store: true,
        tools: [{ type: "web_search" }],
        size: "1024x1024",
      },
      {
        model: "gpt-5.5",
        fallbackTool: { type: "image_generation", model: "gpt-image-2" },
        instructions: "test",
        stream: false,
      }
    );

    expect(body.store).toBe(false);
    expect(body.stream).toBe(false);
    expect(body.previous_response_id).toBe("resp_external");
    expect(body.prompt_cache_key).toBe("caller-cache-key");
    expect(body.input).toBe("draw");
    expect(body.size).toBeUndefined();
    expect(body.tools).toEqual([
      { type: "web_search" },
      { type: "image_generation", model: "gpt-image-2" },
    ]);
  });

  it("does not let raw Responses stream override the selected upstream mode", () => {
    const body = normalizeResponsesImageRequestBody(
      {
        model: "gpt-5.5",
        input: "draw",
        stream: true,
        tools: [],
      },
      {
        model: "gpt-5.5",
        fallbackTool: { type: "image_generation", model: "gpt-image-2" },
        instructions: "test",
        stream: false,
      }
    );

    expect(body.stream).toBe(false);
  });

  it("保留 Astra 与显式 Sunburst 的独立模型选择及有效默认推理", () => {
    const raw = {
      model: "gpt-6-astra",
      tools: [{ type: "image_generation", model: "gpt-image-2.5-sunburst" }],
    };
    const body = normalizeResponsesImageRequestBody(raw, {
      model: "gpt-6-astra",
      fallbackTool: { type: "image_generation", model: "gpt-image-2.5-flare" },
      instructions: "test",
      stream: false,
    });

    expect(body.model).toBe("gpt-6-astra");
    expect(body.tools).toEqual(raw.tools);
    expect(body.reasoning).toBeUndefined();
    expect(raw.tools[0]?.model).toBe("gpt-image-2.5-sunburst");

    const params = {
      prompt: "draw",
      model: "gpt-image-2.5-sunburst",
      gptModel: "gpt-6-astra",
    };
    const config = responsesConfig();
    const requests = [
      buildResponsesImageGenerationRequest(config, params),
      buildResponsesImageEditRequest(config, {
        ...params,
        images: [testImage],
      }),
    ];
    for (const request of requests) {
      expect(request.model).toBe("gpt-6-astra");
      expect(request.tools[0]?.model).toBe("gpt-image-2.5-sunburst");
      expect(request.reasoning.effort).toBe("medium");
    }
  });

  it.each([
    "none",
    "minimal",
  ] as const)("normalizes Astra %s reasoning for generation and editing", (thinking) => {
    const config = responsesConfig();
    const generation = buildResponsesImageGenerationRequest(config, {
      prompt: "draw",
      model: "gpt-image-2.5",
      gptModel: "gpt-6-astra",
      thinking,
    });
    const edit = buildResponsesImageEditRequest(config, {
      prompt: "edit",
      images: [testImage],
      model: "gpt-image-2.5",
      gptModel: "gpt-6-astra",
      thinking,
    });
    for (const request of [generation, edit]) {
      expect(request.reasoning.effort).toBe("low");
      expect(request.model).toBe("gpt-6-astra");
      expect(request.tools[0]?.model).toBe("gpt-image-2.5-sunburst");
    }
  });

  it("keeps ordinary single image generation store disabled", () => {
    const request = buildResponsesImageGenerationRequest(responsesConfig(), {
      prompt: "draw a cat",
    });

    expect(request.store).toBe(false);
    expect("previous_response_id" in request).toBe(false);
    expect(request.prompt_cache_key).toEqual(
      expect.stringMatching(/^g2i_[a-f0-9]{32}$/)
    );
    expect(request.instructions).not.toContain(
      RESPONSES_IMAGE_REFERENCE_INSTRUCTIONS
    );
  });

  it("passes image background to direct Responses image tool requests", () => {
    const generationRequest = buildResponsesImageGenerationRequest(
      responsesConfig(),
      {
        prompt: "draw a sticker",
        background: "transparent",
      }
    );
    const editRequest = buildResponsesImageEditRequest(responsesConfig(), {
      prompt: "make the background transparent",
      images: [testImage],
      background: "transparent",
    });

    expect(generationRequest.tools[0]?.background).toBe("transparent");
    expect(editRequest.tools[0]?.background).toBe("transparent");
  });

  it("recognizes store=false upstream errors and builds a store-disabled retry body", () => {
    expect(
      isResponsesStoreUnsupportedError(
        "Upstream Responses API returned HTTP 400: Store must be set to false"
      )
    ).toBe(true);

    expect(
      buildResponsesStoreFalseFallbackRequestBody({
        model: "gpt-5.5",
        input: "draw",
        store: true,
        previous_response_id: "resp_previous",
      })
    ).toMatchObject({
      model: "gpt-5.5",
      input: "draw",
      store: false,
      previous_response_id: undefined,
    });
  });

  it("adds global image reference instructions to direct Responses edit requests", () => {
    const request = buildResponsesImageEditRequest(responsesConfig(), {
      prompt: "把 @图1 改成蓝色背景",
      images: [testImage],
    });

    expect(request.instructions).toContain(
      RESPONSES_IMAGE_REFERENCE_INSTRUCTIONS
    );
    expect(request.instructions).toContain("@图1");
    expect(request.instructions).toContain('<ref id="..." />');
  });

  it("appends image reference instructions once to internal base instructions", () => {
    const instructions =
      withResponsesImageReferenceInstructions("Base instructions.");

    expect(instructions).toBe(
      `Base instructions.\n\n${RESPONSES_IMAGE_REFERENCE_INSTRUCTIONS}`
    );
  });

  it("rewrites direct image edit @图 mentions to edit reference tags", () => {
    const request = buildResponsesImageEditRequest(responsesConfig(), {
      prompt: "把 @图1 改成蓝色背景",
      images: [testImage],
    });

    const textPart = request.input[0]?.content.find(
      (part) => part.type === "input_text"
    );
    expect(textPart?.text).toContain('<ref id="edit-reference-1"');
    expect(request.input[0]?.content).toContainEqual({
      type: "input_image",
      image_url: "data:image/png;base64,aW1hZ2UtYnl0ZXM=",
    });
  });

  it("inlines external edit input URLs as base64 instead of forwarding them", () => {
    // 第三方外链 + 有字节 → 内联 base64，避免上游下载外链被图床限流 429。
    const request = buildResponsesImageEditRequest(responsesConfig(), {
      prompt: "改这张图",
      images: [{ ...testImage, url: "https://cdn.example.com/source.png" }],
      mask: { ...testImage, url: "https://cdn.example.com/mask.png" },
    });

    expect(request.input[0]?.content).toContainEqual({
      type: "input_image",
      image_url: "data:image/png;base64,aW1hZ2UtYnl0ZXM=",
    });
    expect(request.tools[0]?.input_image_mask).toEqual({
      image_url: "data:image/png;base64,aW1hZ2UtYnl0ZXM=",
    });
  });

  it("labels image edit source images before the user edit request", () => {
    const request = buildResponsesImageEditRequest(responsesConfig(), {
      prompt: "把 @图1 的构图套到 @图2 上",
      images: [
        testImage,
        { ...testImage, name: "style.png", data: Buffer.from("style") },
      ],
    });
    const content = request.input[0]?.content || [];

    expect(content[0]).toMatchObject({
      type: "input_text",
      text: expect.stringContaining("@图1"),
    });
    expect(content[0]).toMatchObject({
      type: "input_text",
      text: expect.stringContaining('id="edit-reference-1"'),
    });
    expect(content[1]).toMatchObject({ type: "input_image" });
    expect(content[2]).toMatchObject({
      type: "input_text",
      text: expect.stringContaining("source image above"),
    });
    expect(content[3]).toMatchObject({
      type: "input_text",
      text: expect.stringContaining("@图2"),
    });
    expect(content.at(-1)).toMatchObject({
      type: "input_text",
      text: expect.stringContaining("User edit request:"),
    });
    expect(content.at(-1)).toMatchObject({
      type: "input_text",
      text: expect.stringContaining('id="edit-reference-2"'),
    });
  });
});
