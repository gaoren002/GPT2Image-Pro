/**
 * 验证 ChatGPT Web 的图像、会话和附件协议；使用模拟设置与网络隔离，避免访问真实账号。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing__,
  editImageWithChatGptWeb,
  generateImageWithChatGptWeb,
} from "./chatgpt-web";

vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingString: vi.fn(async () => undefined),
}));

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
      options: { gptModel: "gpt-5.6-sol", thinking: "xhigh" as const },
      expected: {
        model: "gpt-5-6-thinking",
        thinking_effort: "max",
        system_hints: ["picture_v2"],
      },
    },
    {
      options: { gptModel: "gpt-5.5", thinking: "none" as const },
      expected: { model: "gpt-5-5-instant", system_hints: ["picture_v2"] },
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
    const requestOptions = { ...options, requestMessageId: "test-request" };
    const requirements = { token: "test-requirements" };
    const conduit = await __testing__.prepareImageConversation(
      config,
      "测试",
      requirements,
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
    }
    expect(
      JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))
        .force_parallel_switch
    ).toBe("auto");
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
  it.each([
    "gpt-image-2.5",
    "gpt-image-2.5-flare",
    "gpt-image-2.5-sunburst.web",
  ])("生成和编辑 %s 在上传或请求之前明确拒绝，避免静默出旧版图", async (model) => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response("unexpected upstream request", { status: 400 })
      );
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
        expect(result.error).toContain("WEB_IMAGE_MODEL_UNAVAILABLE");
        expect(result.imageBase64).toBeUndefined();
      }
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
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
