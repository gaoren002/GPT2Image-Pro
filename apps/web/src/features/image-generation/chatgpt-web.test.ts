/**
 * 验证 ChatGPT Web 的图像、会话和附件协议；使用模拟设置与网络隔离，避免访问真实账号。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing__,
  editImageWithChatGptWeb,
  generateFileWithChatGptWeb,
  generateImageWithChatGptWeb,
} from "./chatgpt-web";

vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingString: vi.fn(async () => undefined),
}));

vi.mock("@repo/shared/logger", () => ({ logError: vi.fn() }));

function xorTurnstileProgram(program: unknown, key: string) {
  const source = JSON.stringify(program);
  let encoded = "";
  for (let index = 0; index < source.length; index++) {
    encoded += String.fromCharCode(
      source.charCodeAt(index) ^ key.charCodeAt(index % key.length)
    );
  }
  return Buffer.from(encoded).toString("base64");
}

describe("ChatGPT Web 抓包协议回归", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([
    {
      options: {
        gptModel: "gpt-6-astra",
        thinking: "xhigh" as const,
        profile: "work" as const,
        systemHints: [],
      },
      expected: {
        model: "gpt-6-astra-wm",
        thinking_effort: "xhigh",
        conversation_origin: "tpp",
        service_tier: "standard",
        system_hints: [],
      },
    },
    {
      options: {
        gptModel: "gpt-5.5",
        thinking: "none" as const,
        profile: "work" as const,
        systemHints: [],
      },
      expected: {
        model: "gpt-5.5-wm",
        thinking_effort: "min",
        conversation_origin: "tpp",
        service_tier: "standard",
        system_hints: [],
      },
    },
    {
      options: {
        gptModel: "gpt-5.6-sol",
        thinking: "xhigh" as const,
        profile: "images" as const,
      },
      expected: {
        model: "gpt-5-6-thinking",
        thinking_effort: "max",
        system_hints: ["picture_v2"],
      },
    },
    {
      options: {
        gptModel: "gpt-6-astra",
        thinking: "high" as const,
        profile: "images" as const,
      },
      expected: {
        model: "gpt-6-astra-wm",
        thinking_effort: "extended",
        conversation_origin: "tpp",
        service_tier: "standard",
        system_hints: ["picture_v2"],
      },
    },
    {
      options: {
        gptModel: "gpt-5.5",
        thinking: "none" as const,
        profile: "images" as const,
      },
      expected: { model: "gpt-5-5-instant", system_hints: ["picture_v2"] },
    },
    {
      options: {
        gptModel: "gpt-5.6-sol",
        thinking: "medium" as const,
        profile: "images" as const,
        systemHints: [],
      },
      expected: {
        model: "gpt-5-6-thinking",
        thinking_effort: "standard",
        system_hints: [],
      },
    },
  ])("prepare 与 submit 使用相同的已验证模型参数 $expected.model", async ({
    options,
    expected,
  }) => {
    vi.stubEnv("CHATGPT_WEB_PROXY_URL", "");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ conduit_token: "test-conduit" }))
      .mockResolvedValueOnce(new Response("data: [DONE]\n\n"));
    const config = { baseUrl: "https://chatgpt.com", apiKey: "test-token" };
    const requestOptions = {
      ...options,
      parentMessageId: "test-parent",
      requestMessageId: "test-request",
      turnTraceId: "test-turn-trace",
    };
    const requirements = {
      token: "test-requirements",
      proofToken: "test-proof",
      turnstileToken: "test-turnstile",
    };
    const conduit = await __testing__.prepareImageConversation(
      config,
      "测试",
      requestOptions
    );
    await __testing__.startImageGeneration(
      config,
      "测试",
      requirements,
      conduit,
      requestOptions,
      []
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject(expected);
      expect(body).not.toHaveProperty("paragen_thinking_level");
      if (!("thinking_effort" in expected))
        expect(body).not.toHaveProperty("thinking_effort");
      if (!("conversation_origin" in expected)) {
        expect(body).not.toHaveProperty("conversation_origin");
        expect(body).not.toHaveProperty("service_tier");
      }
      expect(body).not.toHaveProperty("tools");
      expect(body).not.toHaveProperty("image_model");
    }
    const prepareBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const submitBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    const responseContracts = [
      {
        id: "photo_upload_action.v1",
        protocol_version: 1,
        presets: ["cap:image", "cap:file", "placement:end"],
      },
    ];
    expect(prepareBody).toMatchObject({
      client_prepare_state: "none",
      client_prepare_dispatch: "debounced",
      client_prepare_source: "composer_editor_state",
      local_function_names: ["local.continue_in_work"],
      model_response_contracts: responseContracts,
      client_contextual_info: {
        app_name: "chatgpt.com",
        has_web_push_capabilities: true,
        web_push_notification_permission: "default",
      },
    });
    expect(prepareBody).not.toHaveProperty("fork_from_shared_post");
    expect(prepareBody).not.toHaveProperty("force_parallel_switch");
    expect(prepareBody).not.toHaveProperty(
      "paragen_cot_summary_display_override"
    );
    expect(prepareBody.partial_query.id).not.toBe(submitBody.messages[0].id);
    expect(submitBody).toMatchObject({
      client_prepare_state: "success",
      force_parallel_switch: "auto",
      paragen_cot_summary_display_override: "allow",
      local_function_names: ["local.continue_in_work"],
      model_response_contracts: responseContracts,
      client_contextual_info: {
        app_name: "chatgpt.com",
        has_web_push_capabilities: true,
        web_push_notification_permission: "default",
      },
    });
    expect(submitBody).not.toHaveProperty("fork_from_shared_post");
    expect(prepareBody.parent_message_id).toBe("test-parent");
    expect(submitBody.parent_message_id).toBe("test-parent");
    expect(submitBody.messages[0].metadata).toEqual({
      ...(expected.system_hints.length
        ? { system_hints: expected.system_hints }
        : { selected_sources: [] }),
      serialization_metadata: { custom_symbol_offsets: [] },
      submission_mode: "manual_send",
    });
    const prepareHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const submitHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(prepareHeaders.get("accept")).toBe("*/*");
    expect(prepareHeaders.has("openai-sentinel-chat-requirements-token")).toBe(
      false
    );
    expect(prepareHeaders.has("x-conduit-token")).toBe(false);
    expect(prepareHeaders.get("x-oai-turn-trace-id")).toBe("test-turn-trace");
    expect(prepareHeaders.get("oai-client-version")).toBe(
      "prod-0161b0c50546a593fb298ade09215fe186023bb5"
    );
    expect(prepareHeaders.get("oai-client-build-number")).toBe("10493622");
    expect(prepareHeaders.get("oai-genui-client-actions")).toBe(
      "open_entity_detail"
    );
    expect(submitHeaders.get("accept")).toBe("text/event-stream");
    expect(submitHeaders.get("openai-sentinel-chat-requirements-token")).toBe(
      "test-requirements"
    );
    expect(submitHeaders.get("x-conduit-token")).toBe("test-conduit");
    expect(submitHeaders.get("openai-sentinel-proof-token")).toBe("test-proof");
    expect(submitHeaders.get("openai-sentinel-turnstile-token")).toBe(
      "test-turnstile"
    );
    expect(submitHeaders.get("x-oai-turn-trace-id")).toBe("test-turn-trace");
  });

  it("按最新 Sentinel prepare/finalize 协议生成并回传挑战令牌", async () => {
    vi.stubEnv("CHATGPT_WEB_PROXY_URL", "");
    let requirementsToken = "";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url, init) => {
        const requestUrl = String(url);
        if (requestUrl.endsWith("/chat-requirements/prepare")) {
          const body = JSON.parse(String(init?.body));
          requirementsToken = body.p;
          return Response.json({
            prepare_token: "test-prepare-token",
            proofofwork: {
              required: true,
              seed: "test-seed",
              difficulty: "ffffffff",
            },
            turnstile: {
              required: true,
              dx: xorTurnstileProgram([[3, "test-turnstile"]], body.p),
            },
            so: { required: true },
          });
        }
        if (requestUrl.endsWith("/chat-requirements/finalize")) {
          return Response.json({ token: "test-chat-requirements-token" });
        }
        return new Response("unexpected request", { status: 500 });
      });

    const requirements = await __testing__.getChatRequirements(
      {
        baseUrl: "https://chatgpt.com",
        apiKey: "test-token",
        headers: { "chatgpt-account-id": "test-workspace" },
      },
      {
        scriptSources: ["https://chatgpt.com/backend-api/sentinel/sdk.js"],
        dataBuild: "test-build",
      }
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const prepareUrl = String(fetchMock.mock.calls[0]?.[0]);
    const finalizeUrl = String(fetchMock.mock.calls[1]?.[0]);
    expect(prepareUrl).toBe(
      "https://chatgpt.com/backend-api/sentinel/chat-requirements/prepare"
    );
    expect(finalizeUrl).toBe(
      "https://chatgpt.com/backend-api/sentinel/chat-requirements/finalize"
    );
    const prepareHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const finalizeHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(prepareHeaders.get("accept")).toBe("*/*");
    expect(finalizeHeaders.get("accept")).toBe("*/*");
    expect(prepareHeaders.get("chatgpt-account-id")).toBe("test-workspace");
    expect(finalizeHeaders.get("chatgpt-account-id")).toBe("test-workspace");
    expect(requirementsToken.startsWith("gAAAAAC")).toBe(true);
    const requirementsConfig = JSON.parse(
      Buffer.from(requirementsToken.slice(7), "base64").toString("utf8")
    );
    expect(requirementsConfig).toHaveLength(25);
    expect(requirementsConfig[0]).toBe(4000);
    expect(requirementsConfig[1]).toContain("GMT+0800 (中国标准时间)");
    expect(requirementsConfig[2]).toBe(4294705152);
    expect(requirementsConfig[3]).toBe(1);
    expect(requirementsConfig[7]).toBe("zh-CN");
    expect(requirementsConfig[8]).toBe("zh-CN,zh,en,en-US");
    expect(requirementsConfig[16]).toBe(8);
    expect(requirementsConfig.slice(18)).toEqual(Array(7).fill(0));

    const finalizeBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(finalizeBody).toEqual({
      prepare_token: "test-prepare-token",
      proofofwork: expect.stringMatching(/^gAAAAAB.+~S$/),
      turnstile: Buffer.from("test-turnstile").toString("base64"),
    });
    expect(finalizeBody).not.toHaveProperty("proof_token");
    expect(finalizeBody).not.toHaveProperty("turnstile_token");
    const proofConfig = JSON.parse(
      Buffer.from(finalizeBody.proofofwork.slice(7, -2), "base64").toString(
        "utf8"
      )
    );
    expect(proofConfig).toHaveLength(25);
    expect(proofConfig[2]).toBe(4294705152);
    expect(proofConfig[3]).toBe(0);
    expect(proofConfig[14]).toBe(requirementsConfig[14]);
    expect(requirements).toEqual({
      token: "test-chat-requirements-token",
      proofToken: finalizeBody.proofofwork,
      turnstileToken: finalizeBody.turnstile,
      soToken: undefined,
    });
  });

  it("必需的 Turnstile 无法解算时停止在 finalize 之前", async () => {
    vi.stubEnv("CHATGPT_WEB_PROXY_URL", "");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        prepare_token: "test-prepare-token",
        proofofwork: { required: false },
        turnstile: { required: true, dx: "invalid-dx" },
      })
    );

    await expect(
      __testing__.getChatRequirements(
        { baseUrl: "https://chatgpt.com", apiKey: "test-token" },
        {
          scriptSources: ["https://chatgpt.com/backend-api/sentinel/sdk.js"],
          dataBuild: "test-build",
        }
      )
    ).rejects.toThrow("Turnstile challenge failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("PoW challenge 字段非法时停止在 finalize 之前", async () => {
    vi.stubEnv("CHATGPT_WEB_PROXY_URL", "");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        prepare_token: "test-prepare-token",
        proofofwork: {
          required: true,
          seed: "test-seed",
          difficulty: "not-hex",
        },
        turnstile: { required: false },
      })
    );

    await expect(
      __testing__.getChatRequirements(
        { baseUrl: "https://chatgpt.com", apiKey: "invalid-pow-token" },
        {
          scriptSources: ["https://chatgpt.com/backend-api/sentinel/sdk.js"],
          dataBuild: "test-build",
        }
      )
    ).rejects.toThrow("proof challenge is incomplete");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("直连请求按账号延续 Sentinel oai-sc cookie", async () => {
    vi.stubEnv("CHATGPT_WEB_PROXY_URL", "");
    const cookies = new Map<string, string | null>();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url, init) => {
        const requestUrl = String(url);
        const cookie = new Headers(init?.headers).get("cookie");
        if (requestUrl.endsWith("/backend-api/f/conversation/prepare")) {
          cookies.set("conversation-prepare", cookie);
          return Response.json({ conduit_token: "test-conduit" });
        }
        if (requestUrl.endsWith("/chat-requirements/prepare")) {
          cookies.set("requirements-prepare", cookie);
          return Response.json(
            {
              prepare_token: "test-prepare-token",
              proofofwork: { required: false },
              turnstile: { required: false },
            },
            {
              headers: {
                "Set-Cookie": "oai-sc=requirements-state; Path=/; HttpOnly",
              },
            }
          );
        }
        if (requestUrl.endsWith("/chat-requirements/finalize")) {
          cookies.set("requirements-finalize", cookie);
          return Response.json(
            { token: "test-chat-requirements-token" },
            { headers: { "Set-Cookie": "oai-sc=finalize-state; Path=/" } }
          );
        }
        if (requestUrl.endsWith("/backend-api/f/conversation")) {
          cookies.set("conversation-submit", cookie);
          return new Response("data: [DONE]\n\n");
        }
        return new Response("unexpected request", { status: 500 });
      });
    const config = {
      baseUrl: "https://chatgpt.com",
      apiKey: "cookie-test-token",
    };
    const options = {
      gptModel: "gpt-5.5",
      thinking: "medium" as const,
      profile: "images" as const,
      parentMessageId: "test-parent",
      requestMessageId: "test-request",
      turnTraceId: "test-turn-trace",
    };

    const conduitToken = await __testing__.prepareImageConversation(
      config,
      "测试",
      options
    );
    const requirements = await __testing__.getChatRequirements(config, {
      scriptSources: ["https://chatgpt.com/backend-api/sentinel/sdk.js"],
      dataBuild: "test-build",
    });
    await __testing__.startImageGeneration(
      config,
      "测试",
      requirements,
      conduitToken,
      options,
      []
    );

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(cookies).toEqual(
      new Map([
        ["conversation-prepare", null],
        ["requirements-prepare", null],
        ["requirements-finalize", "oai-sc=requirements-state"],
        ["conversation-submit", "oai-sc=finalize-state"],
      ])
    );
  });

  it("access token 前缀相同时仍隔离直连 cookie 会话", async () => {
    vi.stubEnv("CHATGPT_WEB_PROXY_URL", "");
    const cookies: Array<string | null> = [];
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url, init) => {
        cookies.push(new Headers(init?.headers).get("cookie"));
        if (String(url).endsWith("/chat-requirements/prepare")) {
          return Response.json(
            {
              prepare_token: "test-prepare-token",
              proofofwork: { required: false },
              turnstile: { required: false },
            },
            cookies.length === 1
              ? { headers: { "Set-Cookie": "oai-sc=first-account; Path=/" } }
              : undefined
          );
        }
        return Response.json({ token: "test-requirements-token" });
      });
    const sharedPrefix = "same-jwt-prefix".padEnd(24, "x");
    const resources = {
      scriptSources: ["https://chatgpt.com/backend-api/sentinel/sdk.js"],
      dataBuild: "test-build",
    };

    await __testing__.getChatRequirements(
      {
        baseUrl: "https://chatgpt.com",
        apiKey: `${sharedPrefix}-account-one`,
      },
      resources
    );
    await __testing__.getChatRequirements(
      {
        baseUrl: "https://chatgpt.com",
        apiKey: `${sharedPrefix}-account-two`,
      },
      resources
    );

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(cookies).toEqual([null, "oai-sc=first-account", null, null]);
  });

  it("优先读取新版 conversations 消息列表", async () => {
    vi.stubEnv("CHATGPT_WEB_PROXY_URL", "");
    const payload = { messages: [], page_info: { has_previous_page: false } };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json(payload));
    expect(
      JSON.parse(
        await __testing__.getConversationText(
          { baseUrl: "https://chatgpt.com", apiKey: "test-token" },
          "test-conversation"
        )
      )
    ).toEqual(payload);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://chatgpt.com/backend-api/conversations/test-conversation?include_has_versions=true&num_turns=10"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    404, 405, 410,
  ])("新版端点 HTTP %s 时兼容旧版 mapping 查询", async (status) => {
    vi.stubEnv("CHATGPT_WEB_PROXY_URL", "");
    const payload = { mapping: {} };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("not found", { status }))
      .mockResolvedValueOnce(Response.json(payload));
    expect(
      JSON.parse(
        await __testing__.getConversationText(
          { baseUrl: "https://chatgpt.com", apiKey: "test-token" },
          "test-conversation"
        )
      )
    ).toEqual(payload);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://chatgpt.com/backend-api/conversation/test-conversation"
    );
  });

  it.each([
    401, 403, 429, 500,
  ])("新版查询 HTTP %s 不追加旧端点请求", async (status) => {
    vi.stubEnv("CHATGPT_WEB_PROXY_URL", "");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("upstream error", { status }));
    await expect(
      __testing__.getConversationText(
        { baseUrl: "https://chatgpt.com", apiKey: "test-token" },
        "test-conversation"
      )
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("ChatGPT Web image choices", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it.each([
    undefined,
    "gpt-image-2.5",
    "gpt-image-2.5-flare",
    "gpt-image-2.5-sunburst",
    "gpt-image-2.5-sunburst.web",
  ])("默认和显式 %s 均发起 Web 生成/编辑，实际上游错误正常返回", async (model) => {
    vi.stubEnv("CHATGPT_WEB_PROXY_URL", "");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) => {
        const requestUrl = String(url);
        if (requestUrl.endsWith("/backend-api/f/conversation/prepare")) {
          return Response.json({ conduit_token: "test-conduit" });
        }
        if (
          requestUrl.endsWith("/backend-api/sentinel/chat-requirements/prepare")
        ) {
          return Response.json({
            prepare_token: "test-prepare",
            proofofwork: { required: false },
            turnstile: { required: false },
          });
        }
        return requestUrl === "https://chatgpt.com/"
          ? new Response("<html></html>")
          : new Response("mock upstream unauthorized", { status: 401 });
      });
    try {
      const config = { baseUrl: "https://chatgpt.com", apiKey: "test-token" };
      const results = await Promise.all([
        generateImageWithChatGptWeb(config, { prompt: "画一只猫", model }),
        editImageWithChatGptWeb(config, {
          prompt: "换成蓝色背景",
          model,
          images: [
            {
              data: Buffer.from("test"),
              name: "reference.png",
              type: "image/png",
            },
          ],
        }),
      ]);
      for (const result of results) {
        expect(result.error).toContain("HTTP 401");
        expect(result.imageBase64).toBeUndefined();
      }
      expect(fetchMock).toHaveBeenCalled();
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes("/backend-api/sentinel/chat-requirements")
        )
      ).toBe(true);
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes("/backend-api/files")
        )
      ).toBe(true);
      const prepareIndex = fetchMock.mock.calls.findIndex(([url]) =>
        String(url).endsWith("/backend-api/f/conversation/prepare")
      );
      const requirementsIndex = fetchMock.mock.calls.findIndex(([url]) =>
        String(url).endsWith("/backend-api/sentinel/chat-requirements/prepare")
      );
      const finalizeIndex = fetchMock.mock.calls.findIndex(([url]) =>
        String(url).endsWith("/backend-api/sentinel/chat-requirements/finalize")
      );
      expect(prepareIndex).toBeGreaterThanOrEqual(0);
      expect(requirementsIndex).toBeGreaterThan(prepareIndex);
      expect(finalizeIndex).toBeGreaterThan(requirementsIndex);
      expect(
        fetchMock.mock.calls.some(
          ([url]) =>
            String(url) ===
            "https://chatgpt.com/backend-api/sentinel/chat-requirements"
        )
      ).toBe(false);
    } finally {
      fetchMock.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("treats a missing image_gen limit as zero quota", () => {
    expect(
      __testing__.extractQuotaAndRestoreAt([
        { feature_name: "deep_research", remaining: 20 },
      ])
    ).toEqual({ quota: 0, restoreAt: null });
  });

  it("extracts image_gen quota and reset time", () => {
    expect(
      __testing__.extractQuotaAndRestoreAt([
        {
          feature_name: "image_gen",
          remaining: 12.8,
          reset_after: "2026-07-23T00:00:00Z",
        },
      ])
    ).toEqual({
      quota: 12,
      restoreAt: "2026-07-23T00:00:00Z",
    });
  });

  it("extracts too many requests from Web JSON error payloads", () => {
    expect(
      __testing__.extractWebErrorPayloadMessage(
        JSON.stringify({ detail: "Too many requests" })
      )
    ).toBe("Too many requests");
  });

  it("extracts quota errors from Web HTTP 200 plain text streams", () => {
    expect(
      __testing__.extractWebStreamError("The quota has been exceeded.")
    ).toBe("The quota has been exceeded.");
  });

  it("从 Web SSE 的中文 assistant 终稿识别图片额度耗尽", () => {
    const message = {
      id: "quota-answer",
      author: { role: "assistant" },
      channel: "final",
      end_turn: true,
      content: {
        content_type: "text",
        parts: [
          "你已达到 Free 套餐的图像生成请求上限。上限将在 22 小时后重置。",
        ],
      },
    };
    const sse = `data: ${JSON.stringify({ o: "add", v: { message } })}\n\n`;

    expect(__testing__.extractWebStreamError(sse)).toContain(
      "图像生成请求上限"
    );
  });

  it("从 batch v 数组中的 assistant 终稿识别图片额度耗尽", () => {
    const message = {
      id: "quota-answer",
      author: { role: "assistant" },
      channel: "final",
      end_turn: true,
      content: {
        content_type: "text",
        parts: ["你已达到 Free 套餐的图像生成请求上限。"],
      },
    };
    const sse = `data: ${JSON.stringify({ o: "batch", v: [{ message }] })}\n\n`;

    expect(__testing__.extractWebStreamError(sse)).toContain(
      "图像生成请求上限"
    );
  });

  it("完整 SSE 后段已有图片时忽略前段 assistant 额度终稿", () => {
    const quotaMessage = {
      id: "quota-answer",
      author: { role: "assistant" },
      channel: "final",
      end_turn: true,
      content: {
        content_type: "text",
        parts: ["你已达到 Free 套餐的图像生成请求上限。"],
      },
    };
    const imageMessage = {
      id: "generated-image",
      author: { role: "assistant" },
      content: {
        content_type: "multimodal_text",
        parts: [{ asset_pointer: "sediment://generated-image" }],
      },
    };
    const sse = [
      `data: ${JSON.stringify({ o: "add", v: { message: quotaMessage } })}`,
      "",
      `data: ${JSON.stringify({ o: "add", v: { message: imageMessage } })}`,
      "",
    ].join("\n");

    expect(__testing__.extractWebStreamError(sse)).toBe("");
  });

  it("完整 SSE 即使后段有图片也保持 tool system_error 强优先", () => {
    const toolError = {
      id: "tool-error",
      author: { role: "tool" },
      content: {
        content_type: "system_error",
        name: "ChatGPTAgentToolRateLimitException",
        text: "unable to invoke the image_gen.text2im tool right now",
      },
    };
    const imageMessage = {
      id: "generated-image",
      author: { role: "assistant" },
      content: {
        content_type: "multimodal_text",
        parts: [{ asset_pointer: "sediment://generated-image" }],
      },
    };
    const sse = [
      `data: ${JSON.stringify({ o: "add", v: { message: toolError } })}`,
      "",
      `data: ${JSON.stringify({ o: "add", v: { message: imageMessage } })}`,
      "",
    ].join("\n");

    expect(__testing__.extractWebStreamError(sse)).toContain(
      "ChatGPTAgentToolRateLimitException"
    );
  });

  it("assistant analysis 即使包含完整额度模板也不作为终态错误", () => {
    const message = {
      id: "analysis",
      author: { role: "assistant" },
      channel: "analysis",
      status: "finished_successfully",
      content: {
        content_type: "text",
        parts: ["你已达到 Free 套餐的图像生成请求上限。"],
      },
    };
    const sse = `data: ${JSON.stringify({ o: "add", v: { message } })}\n\n`;

    expect(__testing__.extractWebStreamError(sse)).toBe("");
  });

  it("用户消息里包含完整额度模板时不把提示词误判为上游限额", () => {
    const message = {
      id: "quota-prompt",
      author: { role: "user" },
      content: {
        content_type: "text",
        parts: [
          "海报原文：你已达到 Free 套餐的图像生成请求上限。上限将在 22 小时后重置。",
        ],
      },
    };
    const sse = `data: ${JSON.stringify({ o: "add", v: { message } })}\n\n`;

    expect(__testing__.extractWebStreamError(sse)).toBe("");
  });

  it("递归取出包在 o/v 流式增量 v 里的错误文案", () => {
    expect(
      __testing__.extractWebErrorPayloadMessage(
        JSON.stringify({ o: "add", v: { detail: "Too many requests" } })
      )
    ).toBe("Too many requests");
  });

  it("命中错误条件但是 o/v 分片时,不回显原始分片,只给可读关键词短语", () => {
    const sse =
      'data: {"o":"add","v":{"message":{"id":"911374","content":{"parts":["You have hit your usage limit, try again later"]}}}}\n\n';
    const result = __testing__.extractWebStreamError(sse);
    expect(result).not.toContain('{"o"');
    expect(result.toLowerCase()).toContain("usage limit");
  });

  it("普通 o/v 消息增量(无错误关键词)不被当作错误", () => {
    const sse = 'data: {"o":"add","v":{"message":{"id":"abc"}}}\n\n';
    expect(__testing__.extractWebStreamError(sse)).toBe("");
  });

  it("把 ChatGPT 画图工具限流(system_error)从 o/v 流抽成错误,不回显原始分片", () => {
    const message = {
      id: "50f6deb3-9839-43fb-8da9-99fc55ace099",
      author: { role: "tool", name: "t2uay3k.sj1i4kz", metadata: {} },
      content: {
        content_type: "system_error",
        name: "ChatGPTAgentToolRateLimitException",
        text: 'Before doing anything else, explicitly explain to the user that you were unable to invoke the image_gen.text2im tool right now. Make sure to begin your response with "You\'ve hit the Free plan limit for image generation."',
      },
    };
    const sse = `data: ${JSON.stringify({ o: "add", v: { message } })}\n\n`;
    const result = __testing__.extractWebStreamError(sse);
    expect(result).toContain("ChatGPTAgentToolRateLimitException");
    expect(result).toContain("image_gen.text2im");
    expect(result).not.toContain('{"o"');
  });

  it("extractWebSystemError 抽出嵌套在 o/v 里的 system_error name 与 text", () => {
    const result = __testing__.extractWebSystemError({
      o: "add",
      v: {
        message: {
          author: { role: "tool" },
          content: {
            content_type: "system_error",
            name: "ChatGPTAgentToolRateLimitException",
            text: "you were unable to invoke the image_gen.text2im tool right now",
          },
        },
      },
    });
    expect(result).toContain("ChatGPTAgentToolRateLimitException");
    expect(result).toContain("image_gen.text2im");
  });

  it("没有 system_error 的普通增量,extractWebSystemError 返回空", () => {
    expect(
      __testing__.extractWebSystemError({
        o: "add",
        v: { message: { id: "abc", content: { content_type: "text" } } },
      })
    ).toBe("");
  });

  it("仅从当前请求之后的已完成 assistant/tool 节点提取额度错误", () => {
    const conversation = {
      messages: [
        {
          id: "history-request",
          author: { role: "user" },
          metadata: { working_turn_id: "history-turn" },
          content: { content_type: "text", parts: ["画一只猫"] },
        },
        {
          id: "history-answer",
          author: { role: "assistant" },
          channel: "final",
          end_turn: true,
          metadata: { working_turn_id: "history-turn" },
          content: {
            content_type: "text",
            parts: ["你已达到 Free 套餐的图像生成请求上限。"],
          },
        },
        {
          id: "request",
          author: { role: "user" },
          metadata: { working_turn_id: "current-turn" },
          content: {
            content_type: "text",
            parts: ["海报里写上“图像生成请求上限”这几个字"],
          },
        },
        {
          id: "answer",
          author: { role: "assistant" },
          channel: "final",
          end_turn: true,
          metadata: { working_turn_id: "current-turn" },
          content: {
            content_type: "text",
            parts: [
              "你已达到 Free 套餐的图像生成请求上限。上限将在 22 小时后重置。",
            ],
          },
        },
      ],
    };

    expect(
      __testing__.extractCompletedImageGenerationError(
        JSON.stringify(conversation),
        "request"
      )
    ).toContain("图像生成请求上限");
    expect(
      __testing__.extractCompletedImageGenerationError(
        JSON.stringify({
          messages: conversation.messages.slice(0, 3),
        }),
        "request"
      )
    ).toBe("");
  });

  it("从当前请求后的 tool system_error 立即提取额度错误", () => {
    const conversation = {
      messages: [
        {
          id: "request",
          author: { role: "user" },
          metadata: { working_turn_id: "current-turn" },
          content: { content_type: "text", parts: ["画一只猫"] },
        },
        {
          id: "tool-error",
          author: { role: "tool" },
          metadata: { working_turn_id: "current-turn" },
          content: {
            content_type: "system_error",
            name: "ChatGPTAgentToolRateLimitException",
            text: "unable to invoke the image_gen.text2im tool right now",
          },
        },
      ],
    };

    expect(
      __testing__.extractCompletedImageGenerationError(
        JSON.stringify(conversation),
        "request"
      )
    ).toContain("ChatGPTAgentToolRateLimitException");
  });

  it("轮询首次快照发现已完成额度回复后立即返回", async () => {
    vi.stubEnv("CHATGPT_WEB_PROXY_URL", "");
    const conversation = {
      messages: [
        {
          id: "request",
          author: { role: "user" },
          metadata: { working_turn_id: "current-turn" },
          content: { content_type: "text", parts: ["画一只猫"] },
        },
        {
          id: "answer",
          author: { role: "assistant" },
          channel: "final",
          end_turn: true,
          metadata: { working_turn_id: "current-turn" },
          content: {
            content_type: "text",
            parts: ["你已达到 Free 套餐的图像生成请求上限。"],
          },
        },
      ],
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json(conversation));

    const result = await __testing__.pollImageCandidates(
      { baseUrl: "https://chatgpt.com", apiKey: "test-token" },
      "conversation",
      "request"
    );

    expect(result.error).toContain("图像生成请求上限");
    expect(result.candidates).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("SSE 未带图时先探测一次额度终态，不等待 45 秒静默期", async () => {
    vi.stubEnv("CHATGPT_WEB_PROXY_URL", "");
    let requestMessageId = "";
    let conversationReads = 0;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url, init) => {
        const requestUrl = String(url);
        if (requestUrl === "https://chatgpt.com/") {
          return new Response(
            '<html data-build="test-build"><script src="/backend-api/sentinel/sdk.js"></script></html>'
          );
        }
        if (requestUrl.endsWith("/backend-api/f/conversation/prepare")) {
          return Response.json({ conduit_token: "test-conduit" });
        }
        if (
          requestUrl.endsWith("/backend-api/sentinel/chat-requirements/prepare")
        ) {
          return Response.json({
            prepare_token: "test-prepare",
            proofofwork: { required: false },
            turnstile: { required: false },
          });
        }
        if (
          requestUrl.endsWith(
            "/backend-api/sentinel/chat-requirements/finalize"
          )
        ) {
          return Response.json({ token: "test-requirements" });
        }
        if (requestUrl.endsWith("/backend-api/f/conversation")) {
          const body = JSON.parse(String(init?.body));
          requestMessageId = String(body.messages[0].id);
          return new Response(
            `data: ${JSON.stringify({ conversation_id: "conversation" })}\n\ndata: [DONE]\n\n`
          );
        }
        if (requestUrl.includes("/backend-api/conversations/conversation")) {
          conversationReads += 1;
          return Response.json({
            messages: [
              {
                id: requestMessageId,
                author: { role: "user" },
                content: { content_type: "text", parts: ["画一只猫"] },
              },
              {
                id: "quota-answer",
                author: { role: "assistant" },
                channel: "final",
                end_turn: true,
                metadata: { parent_id: requestMessageId },
                content: {
                  content_type: "text",
                  parts: ["你已达到 Free 套餐的图像生成请求上限。"],
                },
              },
            ],
          });
        }
        throw new Error(`unexpected request: ${requestUrl}`);
      });

    const result = await generateImageWithChatGptWeb(
      { baseUrl: "https://chatgpt.com", apiKey: "test-token" },
      { prompt: "画一只猫" }
    );

    expect(result.error).toContain("图像生成请求上限");
    expect(conversationReads).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("同一轮快照同时有图片和额度文字时优先返回图片", async () => {
    vi.stubEnv("CHATGPT_WEB_PROXY_URL", "");
    const conversation = {
      messages: [
        {
          id: "request",
          author: { role: "user" },
          metadata: { working_turn_id: "current-turn" },
          content: { content_type: "text", parts: ["画一只猫"] },
        },
        {
          id: "image",
          author: { role: "assistant" },
          metadata: { working_turn_id: "current-turn" },
          content: {
            content_type: "multimodal_text",
            parts: [{ asset_pointer: "sediment://generated-image" }],
          },
        },
        {
          id: "answer",
          author: { role: "assistant" },
          channel: "final",
          end_turn: true,
          metadata: { working_turn_id: "current-turn" },
          content: {
            content_type: "text",
            parts: ["你已达到 Free 套餐的图像生成请求上限。"],
          },
        },
      ],
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(conversation)
    );

    const result = await __testing__.pollImageCandidates(
      { baseUrl: "https://chatgpt.com", apiKey: "test-token" },
      "conversation",
      "request"
    );

    expect(result.error).toBeUndefined();
    expect(result.candidates[0]?.sedimentIds).toEqual(["generated-image"]);
  });

  it("已有流图时立即探测会话并优先使用完整多候选与选择元数据", async () => {
    vi.stubEnv("CHATGPT_WEB_PROXY_URL", "");
    const conversation = {
      messages: [
        {
          id: "request",
          author: { role: "user" },
          metadata: { working_turn_id: "current-turn" },
          content: { content_type: "text", parts: ["画两张猫"] },
        },
        {
          id: "selection",
          author: { role: "assistant" },
          metadata: {
            working_turn_id: "current-turn",
            selected_image_message_id: "image-one",
          },
          content: { content_type: "text", parts: [] },
        },
        {
          id: "image-one",
          author: { role: "assistant" },
          metadata: {
            working_turn_id: "current-turn",
            image_gen_group_id: "group-one",
            generation_index: 1,
          },
          content: {
            content_type: "multimodal_text",
            parts: [{ asset_pointer: "sediment://candidate-one" }],
          },
        },
        {
          id: "image-two",
          author: { role: "assistant" },
          metadata: {
            working_turn_id: "current-turn",
            image_gen_group_id: "group-one",
            generation_index: 2,
          },
          content: {
            content_type: "multimodal_text",
            parts: [{ asset_pointer: "sediment://candidate-two" }],
          },
        },
      ],
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) => {
        const requestUrl = String(url);
        if (requestUrl.includes("/backend-api/conversations/conversation")) {
          return Response.json(conversation);
        }
        const fileId = requestUrl.match(/attachment\/([^/]+)\/download$/)?.[1];
        if (fileId) {
          return Response.json({ download_url: `https://download/${fileId}` });
        }
        throw new Error(`unexpected request: ${requestUrl}`);
      });

    const result = await __testing__.resolveImageCandidateUrls(
      { baseUrl: "https://chatgpt.com", apiKey: "test-token" },
      "conversation",
      { fileIds: [], sedimentIds: ["stream-partial"] },
      "request",
      undefined,
      {
        deadline: Date.now() + 120_000,
        regularPollingStartsAt: Date.now() + 45_000,
      }
    );

    expect(result.outputs).toEqual([
      {
        url: "https://download/candidate-one",
        messageId: "image-one",
        groupId: "group-one",
        generationIndex: 1,
      },
      {
        url: "https://download/candidate-two",
        messageId: "image-two",
        groupId: "group-one",
        generationIndex: 2,
      },
    ]);
    expect(result.selectionMessageId).toBe("selection");
    expect(result.selectedImageMessageId).toBe("image-one");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("已有流图但即时会话快照为空时直接使用流图，不进入定期轮询", async () => {
    vi.stubEnv("CHATGPT_WEB_PROXY_URL", "");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) => {
        const requestUrl = String(url);
        if (requestUrl.includes("/backend-api/conversations/conversation")) {
          return Response.json({ mapping: {} });
        }
        if (requestUrl.includes("/attachment/stream-image/download")) {
          return Response.json({
            download_url: "https://download/stream-image",
          });
        }
        throw new Error(`unexpected request: ${requestUrl}`);
      });

    const result = await __testing__.resolveImageCandidateUrls(
      { baseUrl: "https://chatgpt.com", apiKey: "test-token" },
      "conversation",
      { fileIds: [], sedimentIds: ["stream-image"] },
      "request",
      undefined,
      {
        deadline: Date.now() + 120_000,
        regularPollingStartsAt: Date.now() + 45_000,
      }
    );

    expect(result.outputs.map((output) => output.url)).toEqual([
      "https://download/stream-image",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("候选轮询耗尽后不再开启第二个 ID 轮询窗口", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T00:00:00Z"));
    vi.stubEnv("CHATGPT_WEB_PROXY_URL", "");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ mapping: {} }));
    try {
      const promise = __testing__.resolveImageCandidateUrls(
        { baseUrl: "https://chatgpt.com", apiKey: "test-token" },
        "conversation",
        { fileIds: [], sedimentIds: [] },
        "request",
        undefined,
        { deadline: Date.now() + 12_000 }
      );
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.outputs).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("extracts sibling image candidates after a request message", () => {
    const conversation = {
      current_node: "choice_b",
      mapping: {
        request_1: {
          id: "request_1",
          create_time: 100,
          children: ["selection_1"],
          message: { id: "request_1", create_time: 100 },
        },
        selection_1: {
          id: "selection_1",
          parent: "request_1",
          create_time: 101,
          children: ["choice_a", "choice_b"],
          message: {
            id: "select_message_1",
            metadata: { selected_image_message_id: "choice_message_a" },
          },
        },
        choice_b: {
          id: "choice_b",
          parent: "selection_1",
          create_time: 103,
          message: {
            id: "choice_message_b",
            content: {
              parts: [{ asset_pointer: "sediment://file_choice_b" }],
            },
            metadata: {
              image_gen_group_id: "group_1",
              generation_index: 2,
            },
          },
        },
        choice_a: {
          id: "choice_a",
          parent: "selection_1",
          create_time: 102,
          message: {
            id: "choice_message_a",
            content: {
              parts: [{ asset_pointer: "sediment://file_choice_a" }],
            },
            metadata: {
              image_gen_group_id: "group_1",
              generation_index: 1,
            },
          },
        },
      },
    };

    const candidates = __testing__.imageCandidatesAfterMessage(
      JSON.stringify(conversation),
      "request_1"
    );

    expect(candidates).toEqual([
      {
        fileIds: [],
        sedimentIds: ["file_choice_a"],
        messageId: "choice_message_a",
        groupId: "group_1",
        generationIndex: 1,
      },
      {
        fileIds: [],
        sedimentIds: ["file_choice_b"],
        messageId: "choice_message_b",
        groupId: "group_1",
        generationIndex: 2,
      },
    ]);
  });

  it("ignores user-uploaded image nodes after a request message", () => {
    const conversation = {
      current_node: "generated_1",
      mapping: {
        request_1: {
          id: "request_1",
          create_time: 100,
          children: ["uploaded_1", "generated_1"],
          message: {
            id: "request_1",
            create_time: 100,
            author: { role: "user" },
          },
        },
        uploaded_1: {
          id: "uploaded_1",
          parent: "request_1",
          create_time: 101,
          message: {
            id: "uploaded_message_1",
            author: { role: "user" },
            content: {
              content_type: "multimodal_text",
              parts: [{ asset_pointer: "sediment://uploaded_input" }],
            },
          },
        },
        generated_1: {
          id: "generated_1",
          parent: "request_1",
          create_time: 102,
          message: {
            id: "generated_message_1",
            author: { role: "assistant" },
            content: {
              parts: [{ asset_pointer: "sediment://generated_output" }],
            },
            metadata: {
              image_gen_group_id: "group_1",
              generation_index: 1,
            },
          },
        },
      },
    };

    expect(
      __testing__.imageCandidatesAfterMessage(
        JSON.stringify(conversation),
        "request_1"
      )
    ).toEqual([
      {
        fileIds: [],
        sedimentIds: ["generated_output"],
        messageId: "generated_message_1",
        groupId: "group_1",
        generationIndex: 1,
      },
    ]);
  });

  it("detects exact Web outputs that match input images", () => {
    const input = Buffer.from("same image bytes");

    expect(
      __testing__.outputMatchesInputImage(
        [{ imageBase64: input.toString("base64"), index: 0 }],
        [{ data: input, name: "input.jpg", type: "image/jpeg" }]
      )
    ).toBe(true);

    expect(
      __testing__.outputMatchesInputImage(
        [
          {
            imageBase64: Buffer.from("new image").toString("base64"),
            index: 0,
          },
        ],
        [{ data: input, name: "input.jpg", type: "image/jpeg" }]
      )
    ).toBe(false);
  });

  it("extracts the Web selection message id from SSE metadata", () => {
    const sse = [
      'data: {"v":{"id":"select_message_1","metadata":{"selected_image_message_id":"choice_message_a"}}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    expect(__testing__.extractSelectionMessageId(sse)).toBe("select_message_1");
  });

  it("extracts the Web selection message from conversation mapping", () => {
    const conversation = {
      current_node: "choice_a",
      mapping: {
        request_1: {
          id: "request_1",
          create_time: 100,
          children: ["selection_1"],
        },
        selection_1: {
          id: "selection_1",
          parent: "request_1",
          create_time: 101,
          message: {
            id: "select_message_1",
            metadata: { selected_image_message_id: "choice_message_a" },
          },
        },
        choice_a: {
          id: "choice_a",
          parent: "selection_1",
          create_time: 102,
          message: {
            id: "choice_message_a",
            content: {
              parts: [{ asset_pointer: "sediment://file_choice_a" }],
            },
            metadata: {
              image_gen_group_id: "group_1",
              generation_index: 1,
            },
          },
        },
      },
    };

    expect(
      __testing__.imageSelectionAfterMessage(
        JSON.stringify(conversation),
        "request_1"
      )
    ).toEqual({
      messageId: "select_message_1",
      selectedImageMessageId: "choice_message_a",
    });
  });
});

describe("ChatGPT Web editable file (ppt/psd)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("文件入口按 bootstrap、prepare、Sentinel、submit 顺序复用会话标识", async () => {
    vi.stubEnv("CHATGPT_WEB_PROXY_URL", "");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          '<html data-build="test-build"><script src="/backend-api/sentinel/sdk.js"></script></html>'
        )
      )
      .mockResolvedValueOnce(Response.json({ conduit_token: "file-conduit" }))
      .mockResolvedValueOnce(
        Response.json({
          prepare_token: "file-prepare-token",
          proofofwork: { required: false },
          turnstile: { required: false },
        })
      )
      .mockResolvedValueOnce(Response.json({ token: "file-requirements" }))
      .mockResolvedValueOnce(new Response("data: [DONE]\n\n"));
    const config = {
      baseUrl: "https://chatgpt.com",
      apiKey: "editable-envelope-token",
    };

    await expect(
      generateFileWithChatGptWeb({
        config,
        kind: "ppt",
        prompt: "制作文件",
        images: [],
      })
    ).rejects.toThrow("无 conversation_id");

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://chatgpt.com/",
      "https://chatgpt.com/backend-api/f/conversation/prepare",
      "https://chatgpt.com/backend-api/sentinel/chat-requirements/prepare",
      "https://chatgpt.com/backend-api/sentinel/chat-requirements/finalize",
      "https://chatgpt.com/backend-api/f/conversation",
    ]);
    const prepareInit = fetchMock.mock.calls[1]?.[1];
    const submitInit = fetchMock.mock.calls[4]?.[1];
    const prepareHeaders = new Headers(prepareInit?.headers);
    const submitHeaders = new Headers(submitInit?.headers);
    const prepareBody = JSON.parse(String(prepareInit?.body));
    const submitBody = JSON.parse(String(submitInit?.body));

    expect(prepareHeaders.get("accept")).toBe("*/*");
    expect(
      prepareHeaders.get("openai-sentinel-chat-requirements-token")
    ).toBeNull();
    expect(prepareHeaders.get("x-conduit-token")).toBeNull();
    expect(submitHeaders.get("accept")).toBe("text/event-stream");
    expect(submitHeaders.get("x-oai-turn-trace-id")).toBe(
      prepareHeaders.get("x-oai-turn-trace-id")
    );
    expect(submitHeaders.get("x-conduit-token")).toBe("file-conduit");
    expect(submitHeaders.get("openai-sentinel-chat-requirements-token")).toBe(
      "file-requirements"
    );
    expect(submitBody.parent_message_id).toBe(prepareBody.parent_message_id);
    expect(prepareBody.partial_query.id).not.toBe(submitBody.messages[0].id);
    expect(prepareBody.client_prepare_state).toBe("none");
    expect(prepareBody.client_prepare_dispatch).toBe("debounced");
    expect(prepareBody.client_prepare_source).toBe("composer_editor_state");
    expect(submitBody.client_prepare_state).toBe("success");
    expect(prepareBody).not.toHaveProperty("fork_from_shared_post");
  });

  it("extracts primary + zip artifacts from metadata.attachments", () => {
    const conversation = {
      current_node: "asst_1",
      mapping: {
        request_1: {
          id: "request_1",
          create_time: 100,
          children: ["asst_1"],
          message: { id: "request_1", create_time: 100 },
        },
        asst_1: {
          id: "asst_1",
          parent: "request_1",
          create_time: 101,
          message: {
            id: "asst_message_1",
            metadata: {
              attachments: [
                {
                  id: "file-abc",
                  name: "deck.pptx",
                  mimeType:
                    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                },
                { id: "file-zip", name: "assets.zip" },
              ],
            },
          },
        },
      },
    };
    const artifacts = __testing__.extractEditableArtifacts(
      JSON.stringify(conversation),
      "request_1",
      "ppt"
    );
    const primary = artifacts.find((a) => !a.isZip);
    const zip = artifacts.find((a) => a.isZip);
    expect(primary?.name).toBe("deck.pptx");
    expect(primary?.fileId).toBe("file-abc");
    expect(primary?.messageId).toBe("asst_message_1");
    expect(zip?.name).toBe("assets.zip");
    expect(zip?.fileId).toBe("file-zip");
  });

  it("extracts psd artifact from a /mnt/data sandbox path in message text", () => {
    const conversation = {
      current_node: "asst_1",
      mapping: {
        request_1: {
          id: "request_1",
          create_time: 100,
          children: ["asst_1"],
          message: { id: "request_1", create_time: 100 },
        },
        asst_1: {
          id: "asst_1",
          parent: "request_1",
          create_time: 101,
          message: {
            id: "asst_message_1",
            content: {
              parts: ["已导出 sandbox:/mnt/data/poster.psd,请下载。"],
            },
          },
        },
      },
    };
    const artifacts = __testing__.extractEditableArtifacts(
      JSON.stringify(conversation),
      "request_1",
      "psd"
    );
    expect(artifacts.some((a) => a.name === "poster.psd" && !a.isZip)).toBe(
      true
    );
    expect(artifacts[0]?.sandboxPath).toBe("/mnt/data/poster.psd");
  });

  it("appends user extra to the fixed template", () => {
    const withExtra = __testing__.editableFilePrompt("ppt", "8 页,商务风");
    expect(withExtra).toContain("以下是用户补充需求");
    expect(withExtra).toContain("8 页,商务风");
    const empty = __testing__.editableFilePrompt("psd", "   ");
    expect(empty).not.toContain("以下是用户补充需求");
  });
});

describe("ChatGPT Web chat (text answer extraction)", () => {
  it.each([
    ["ChatGPT Web conversation failed: HTTP 404", true],
    ["ChatGPT Web conversation failed: HTTP 410", true],
    ["Conversation is temporarily inaccessible", true],
    ["ChatGPT Web conversation failed: HTTP 401 Unauthorized", false],
    ["ChatGPT Web conversation failed: HTTP 429 Too Many Requests", false],
    ["ChatGPT Web conversation failed: HTTP 503", false],
    ["fetch failed", false],
  ])("短任务轮询错误 %s 的交接期判定为 %s", (message, expected) => {
    expect(
      __testing__.isTransientWebConversationHandoffError(new Error(message))
    ).toBe(expected);
  });

  it.each([
    "",
    "本轮答案",
  ])("新版 messages 按轮次提取最终答案 %j，不串入前后轮次或思考", (answer) => {
    const conversation = {
      messages: [
        {
          id: "previous",
          author: { role: "user" },
          metadata: { working_turn_id: "turn-previous" },
        },
        {
          id: "previous-answer",
          author: { role: "assistant" },
          channel: "final",
          end_turn: true,
          metadata: { working_turn_id: "turn-previous" },
          content: { content_type: "text", parts: ["前轮答案"] },
        },
        {
          id: "request",
          author: { role: "user" },
          metadata: {
            working_turn_id: "turn-current",
            turn_exchange_id: "exchange-current",
          },
        },
        {
          id: "analysis",
          author: { role: "assistant" },
          channel: "analysis",
          metadata: {
            working_turn_id: "turn-current",
            turn_exchange_id: "exchange-current",
          },
          content: { content_type: "text", parts: ["内部思考"] },
        },
        {
          id: "answer",
          author: { role: "assistant" },
          channel: "final",
          recipient: "all",
          status: "finished_successfully",
          end_turn: true,
          metadata: {
            working_turn_id: "turn-current",
            turn_exchange_id: "exchange-current",
          },
          content: { content_type: "text", parts: [answer] },
        },
        {
          id: "next",
          author: { role: "user" },
          metadata: { working_turn_id: "turn-next" },
        },
        {
          id: "next-answer",
          author: { role: "assistant" },
          channel: "final",
          end_turn: true,
          metadata: { working_turn_id: "turn-next" },
          content: { content_type: "text", parts: ["后轮答案"] },
        },
      ],
    };
    expect(
      __testing__.extractAssistantAnswer(
        JSON.stringify(conversation),
        "request"
      )
    ).toEqual({ text: answer, complete: true });
    expect(
      __testing__
        .conversationNodesAfterMessage(JSON.stringify(conversation), "request")
        .map(({ id }) => id)
    ).toEqual(["analysis", "answer"]);
  });

  it("空的最终答复标记完成，不把此前 analysis 文本当作答案", () => {
    const conversation = {
      mapping: {
        request: { id: "request", children: ["analysis"] },
        analysis: {
          parent: "request",
          children: ["final"],
          message: {
            id: "analysis",
            author: { role: "assistant" },
            channel: "analysis",
            content: { content_type: "text", parts: ["内部思考"] },
          },
        },
        final: {
          parent: "analysis",
          message: {
            id: "final",
            author: { role: "assistant" },
            channel: "final",
            status: "finished_successfully",
            end_turn: true,
            content: { content_type: "text", parts: [""] },
          },
        },
      },
    };
    expect(
      __testing__.extractAssistantAnswer(
        JSON.stringify(conversation),
        "request"
      )
    ).toEqual({ text: "", complete: true });
  });

  it("extracts the finalized assistant text and marks the turn complete", () => {
    const conversation = {
      current_node: "answer_1",
      mapping: {
        request_1: { id: "request_1", create_time: 100, children: ["think_1"] },
        think_1: {
          id: "think_1",
          parent: "request_1",
          create_time: 101,
          children: ["answer_1"],
          message: {
            id: "think_1",
            author: { role: "assistant" },
            content: { content_type: "thoughts", parts: ["让我想想"] },
          },
        },
        answer_1: {
          id: "answer_1",
          parent: "think_1",
          create_time: 102,
          message: {
            id: "answer_1",
            author: { role: "assistant" },
            content: { content_type: "text", parts: ["这是", "一只猫。"] },
            end_turn: true,
          },
        },
      },
    };
    const result = __testing__.extractAssistantAnswer(
      JSON.stringify(conversation),
      "request_1"
    );
    // thoughts 节点被跳过;只取最终 text 节点,且 end_turn=true → complete。
    expect(result).toEqual({ text: "这是一只猫。", complete: true });
  });

  it("returns text without complete while the turn is still streaming", () => {
    const conversation = {
      current_node: "answer_1",
      mapping: {
        request_1: {
          id: "request_1",
          create_time: 100,
          children: ["answer_1"],
        },
        answer_1: {
          id: "answer_1",
          parent: "request_1",
          create_time: 101,
          message: {
            id: "answer_1",
            author: { role: "assistant" },
            content: { content_type: "text", parts: ["部分回答"] },
            end_turn: null,
          },
        },
      },
    };
    const result = __testing__.extractAssistantAnswer(
      JSON.stringify(conversation),
      "request_1"
    );
    expect(result).toEqual({ text: "部分回答", complete: false });
  });
});
