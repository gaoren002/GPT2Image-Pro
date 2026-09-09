import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingBoolean: vi.fn(async () => false),
  getRuntimeSettingNumber: vi.fn(
    async (_key: string, fallback: number) => fallback
  ),
  getRuntimeSettingString: vi.fn(async () => ""),
}));

import type { ApiConfig } from "./types";

const encoder = new TextEncoder();

function sseBlock(event: string, data: Record<string, unknown>) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe("Responses streaming parser", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects unlisted client chat model names for pool API responses backends", async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";
    const { getResponsesModel } = await import("./service");
    const config: ApiConfig = {
      baseUrl: "https://api.example.test/v1",
      apiKey: "test-key",
      model: "gpt-image-2",
      backend: {
        type: "pool-api",
        id: "api_1",
        groupId: "group_1",
        requestKind: "chat",
        apiInterfaceMode: "mixed",
        reportResult: false,
      },
    };

    await expect(
      getResponsesModel(config, "platform-codex-model")
    ).rejects.toThrow("Unsupported chat model.");
  });

  it("ignores image model names as chat models for pool API responses backends", async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";
    const { getResponsesModel } = await import("./service");
    const config: ApiConfig = {
      baseUrl: "https://api.example.test/v1",
      apiKey: "test-key",
      model: "gpt-image-2",
      backend: {
        type: "pool-api",
        id: "api_1",
        groupId: "group_1",
        requestKind: "chat",
        apiInterfaceMode: "mixed",
        reportResult: false,
      },
    };

    await expect(getResponsesModel(config, "gpt-image-2")).resolves.toBe(
      "gpt-5.5"
    );
  });

  it.each([
    "gpt-6-astra",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ])("enforces the premium gate for %s across account and API backends", async (model) => {
    process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";
    const { getResponsesModel } = await import("./service");
    for (const type of ["pool-account", "pool-api"] as const) {
      const config: ApiConfig = {
        baseUrl: "https://api.example.test/v1",
        apiKey: "test-key",
        model,
        backend: {
          type,
          id: "backend_1",
          groupId: "group_1",
          accountBackend: "responses",
          requestKind: "chat",
          apiInterfaceMode: "mixed",
          reportResult: false,
        },
      };
      await expect(
        getResponsesModel(config, undefined, { allowPremiumModels: false })
      ).resolves.toBe("gpt-5.5");
      await expect(
        getResponsesModel(config, model, { allowPremiumModels: false })
      ).rejects.toThrow("Premium chat models require Ultra plan.");
      await expect(
        getResponsesModel(config, model, { allowPremiumModels: true })
      ).resolves.toBe(model);
      await expect(
        getResponsesModel(config, "gpt-5.5", { allowPremiumModels: false })
      ).resolves.toBe("gpt-5.5");
    }
  });

  it("replaces retired GPT defaults and keeps administrator API aliases", async () => {
    const { getResponsesModel } = await import("./service");
    const config: ApiConfig = {
      baseUrl: "https://api.example.test/v1",
      apiKey: "test-key",
      model: "gpt-5.4",
      backend: {
        type: "pool-api",
        id: "api_1",
        groupId: "group_1",
        requestKind: "chat",
        apiInterfaceMode: "mixed",
        reportResult: false,
      },
    };
    await expect(getResponsesModel(config)).resolves.toBe("gpt-5.5");
    await expect(getResponsesModel(config, "gpt-5.4")).rejects.toThrow(
      "Unsupported chat model."
    );
    await expect(
      getResponsesModel({ ...config, model: "platform-codex-model" })
    ).resolves.toBe("platform-codex-model");
  });

  it("repairs moderation-blocked prompts through a text-only Responses request", async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";
    const { repairModerationBlockedPromptWithResponses } = await import(
      "./service"
    );
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          id: "resp_repair",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "A policy-safe cinematic portrait with softened details",
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await repairModerationBlockedPromptWithResponses(
      {
        baseUrl: "https://api.example.test/v1",
        apiKey: "test-key",
        model: "gpt-5.5",
      },
      {
        prompt: "blocked portrait prompt",
        failureReason: "Content failed moderation",
        mode: "generate",
        size: "1024x1024",
      }
    );

    expect(result.prompt).toBe(
      "A policy-safe cinematic portrait with softened details"
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/v1/responses",
      expect.objectContaining({
        body: expect.stringContaining('"store":false'),
      })
    );
    const firstCall = fetchMock.mock.calls.at(0) as
      | [string, RequestInit]
      | undefined;
    const requestOptions = firstCall?.[1] as RequestInit | undefined;
    expect(String(requestOptions?.body)).not.toContain("image_generation");
  });

  it("parses stream=true Responses bodies incrementally even when content-type is wrong", async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";
    const { generateChatImage } = await import("./service");
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(nextController) {
        controller = nextController;
      },
    });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    let resolveFirstDelta!: () => void;
    const firstDelta = new Promise<void>((resolve) => {
      resolveFirstDelta = resolve;
    });
    const deltas: string[] = [];
    const config: ApiConfig = {
      baseUrl: "https://api.example.test/v1",
      apiKey: "test-key",
    };

    const resultPromise = generateChatImage(
      config,
      {
        prompt: "hello",
        model: "gpt-5.5",
        stream: true,
      },
      {
        onTextDelta: (delta) => {
          deltas.push(delta);
          resolveFirstDelta();
        },
      }
    );

    controller?.enqueue(
      encoder.encode(
        sseBlock("response.output_text.delta", {
          type: "response.output_text.delta",
          delta: "hello",
        })
      )
    );

    await firstDelta;
    expect(deltas).toEqual(["hello"]);

    controller?.enqueue(
      encoder.encode(
        sseBlock("response.completed", {
          type: "response.completed",
          response: { id: "resp_test", output: [] },
        })
      )
    );
    controller?.close();

    await expect(resultPromise).resolves.toMatchObject({
      responseText: "hello",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/v1/responses",
      expect.objectContaining({
        body: expect.stringContaining('"stream":true'),
      })
    );
  });

  it("parses streamed Images API bodies for non-stream callers when content-type is wrong", async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";
    const { generateImage } = await import("./service");
    const imageBase64 = Buffer.from("image-result").toString("base64");
    const fetchMock = vi.fn(async () => {
      return new Response(
        sseBlock("image_generation.completed", {
          type: "image_generation.completed",
          b64_json: imageBase64,
          revised_prompt: "a small test icon",
        }),
        {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateImage(
      {
        baseUrl: "https://api.example.test/v1",
        apiKey: "test-key",
        useStream: true,
      },
      {
        prompt: "make an icon",
        model: "gpt-image-2",
        size: "1024x1024",
      }
    );

    expect(result.imageBase64).toBe(imageBase64);
    expect(result.revisedPrompt).toBe("a small test icon");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/v1/images/generations",
      expect.objectContaining({
        body: expect.stringContaining('"stream":true'),
      })
    );
  });

  it("routes pool API images generations through Responses when image upstream mode is responses", async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";
    const { generateImage } = await import("./service");
    const imageBase64 = Buffer.from("responses-image-result").toString(
      "base64"
    );
    const fetchMock = vi.fn(async () => {
      return new Response(
        sseBlock("response.completed", {
          type: "response.completed",
          response: {
            id: "resp_test",
            output: [
              {
                id: "ig_1",
                type: "image_generation_call",
                status: "completed",
                result: imageBase64,
              },
            ],
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateImage(
      {
        baseUrl: "https://api.example.test/v1",
        apiKey: "test-key",
        model: "external-responses-model",
        backend: {
          type: "pool-api",
          apiInterfaceMode: "responses",
          imagesUpstreamMode: "responses",
          requestKind: "image_generation",
        },
      },
      {
        prompt: "make an icon",
        model: "gpt-image-2",
        size: "1024x1024",
      }
    );

    expect(result.imageBase64).toBe(imageBase64);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/v1/responses",
      expect.objectContaining({
        body: expect.stringContaining('"action":"generate"'),
      })
    );
  });

  it("routes pool API images edits through Responses when image upstream mode is responses", async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";
    const { editImage } = await import("./service");
    const imageBase64 = Buffer.from("responses-edit-result").toString("base64");
    const fetchMock = vi.fn(async () => {
      return new Response(
        sseBlock("response.completed", {
          type: "response.completed",
          response: {
            id: "resp_test",
            output: [
              {
                id: "ig_1",
                type: "image_generation_call",
                status: "completed",
                result: imageBase64,
              },
            ],
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await editImage(
      {
        baseUrl: "https://api.example.test/v1",
        apiKey: "test-key",
        model: "external-responses-model",
        backend: {
          type: "pool-api",
          apiInterfaceMode: "responses",
          imagesUpstreamMode: "responses",
          requestKind: "image_edit",
        },
      },
      {
        prompt: "make it blue",
        images: [
          {
            name: "source.png",
            type: "image/png",
            data: Buffer.from("source-image"),
          },
        ],
        model: "gpt-image-2",
        size: "1024x1024",
      }
    );

    expect(result.imageBase64).toBe(imageBase64);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/v1/responses",
      expect.objectContaining({
        body: expect.stringContaining('"action":"edit"'),
      })
    );
  });

  it("uses the final completed image instead of streamed partial image data", async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";
    const { generateImage } = await import("./service");
    const partialBase64 = Buffer.from("partial-image").toString("base64");
    const finalBase64 = Buffer.from("final-image").toString("base64");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          sseBlock("image_generation.partial_image", {
            type: "image_generation.partial_image",
            b64_json: partialBase64,
            partial_image_index: 0,
          }) +
            sseBlock("image_generation.completed", {
              type: "image_generation.completed",
              b64_json: finalBase64,
              revised_prompt: "final prompt",
            }),
          {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }
        );
      })
    );

    const result = await generateImage(
      {
        baseUrl: "https://api.example.test/v1",
        apiKey: "test-key",
        useStream: true,
      },
      {
        prompt: "make an icon",
        model: "gpt-image-2",
        size: "1024x1024",
      }
    );

    expect(result.imageBase64).toBe(finalBase64);
    expect(result.imageBase64).not.toBe(partialBase64);
    expect(result.revisedPrompt).toBe("final prompt");
  });

  it("surfaces JSON Images API errors returned to an upstream stream request", async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";
    const { generateImage } = await import("./service");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            error: {
              message: "The quota has been exceeded.",
              type: "image_generation_user_error",
              code: "quota_exceeded",
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }
        );
      })
    );

    const result = await generateImage(
      {
        baseUrl: "https://api.example.test/v1",
        apiKey: "test-key",
        useStream: true,
      },
      {
        prompt: "make an icon",
        model: "gpt-image-2",
        size: "1024x1024",
      }
    );

    expect(result.error).toContain("The quota has been exceeded.");
    expect(result.error).toContain("quota_exceeded");
  });

  it("surfaces JSON Responses API errors returned to an upstream stream request", async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";
    const { generateChatImage } = await import("./service");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            error: {
              message: "Store must be set to false",
              type: "invalid_request_error",
              code: "invalid_value",
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }
        );
      })
    );

    const result = await generateChatImage(
      {
        baseUrl: "https://api.example.test/v1",
        apiKey: "test-key",
        useStream: true,
      },
      {
        prompt: "make an image",
        model: "gpt-5.5",
      }
    );

    expect(result.error).toContain("Store must be set to false");
    expect(result.error).toContain("invalid_value");
  });

  it("can route Chat mode to native upstream Chat Completions when configured", async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";
    const { generateChatImage } = await import("./service");
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit): Promise<Response> => {
        return new Response(
          JSON.stringify({
            id: "chatcmpl_test",
            model: "gpt-5.5",
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "native chat result",
                  images: [
                    {
                      b64_json: Buffer.from("native-image").toString("base64"),
                      revised_prompt: "native image",
                    },
                  ],
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateChatImage(
      {
        baseUrl: "https://api.example.test/v1",
        apiKey: "test-key",
        backend: {
          type: "pool-api",
          apiInterfaceMode: "mixed",
          chatCompletionsUpstreamMode: "chat_completions",
        },
      },
      {
        prompt: "hello",
        model: "gpt-5.5",
      }
    );

    expect(result.responseText).toBe("native chat result");
    expect(result.imageBase64).toBe(
      Buffer.from("native-image").toString("base64")
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/v1/chat/completions",
      expect.objectContaining({
        body: expect.stringMatching(/"prompt_cache_key":"g2i_[a-f0-9]{32}"/),
      })
    );
    const calls = fetchMock.mock.calls;
    const firstCall = calls[0];
    if (!firstCall) throw new Error("expected chat completions fetch call");
    const init = firstCall[1] as RequestInit | undefined;
    expect(String(init?.body || "")).not.toContain('"stream":true');
  });

  it("can route Chat mode to upstream Images generations when configured", async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";
    const { generateChatImage } = await import("./service");
    const imageBase64 = Buffer.from("images-chat-result").toString("base64");
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ data: [{ b64_json: imageBase64 }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateChatImage(
      {
        baseUrl: "https://api.example.test/v1",
        apiKey: "test-key",
        backend: {
          type: "pool-api",
          requestKind: "chat",
          apiInterfaceMode: "mixed",
          chatCompletionsUpstreamMode: "images",
        },
      },
      {
        prompt: "draw a poster",
        imageModel: "gpt-image-2",
      }
    );

    expect(result.imageBase64).toBe(imageBase64);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/v1/images/generations",
      expect.objectContaining({
        body: expect.stringContaining('"model":"gpt-image-2"'),
      })
    );
  });

  it("routes Images Chat with a current reference image to upstream edits", async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";
    const { generateChatImage } = await import("./service");
    const imageBase64 = Buffer.from("images-chat-edit").toString("base64");
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ data: [{ b64_json: imageBase64 }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateChatImage(
      {
        baseUrl: "https://api.example.test/v1",
        apiKey: "test-key",
        backend: {
          type: "user-api",
          chatCompletionsUpstreamMode: "images",
        },
      },
      {
        prompt: "make it red",
        imageModel: "gpt-image-2",
        images: [
          {
            data: Buffer.from("reference-image"),
            name: "reference.png",
            type: "image/png",
          },
        ],
      }
    );

    expect(result.imageBase64).toBe(imageBase64);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.example.test/v1/images/edits"
    );
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBeInstanceOf(FormData);
  });

  it("rejects multi-turn Chat requests when Images upstream mode is configured", async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";
    const { generateChatImage } = await import("./service");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateChatImage(
      {
        baseUrl: "https://api.example.test/v1",
        apiKey: "test-key",
        backend: {
          type: "user-api",
          chatCompletionsUpstreamMode: "images",
        },
      },
      {
        prompt: "make it red",
        imageModel: "gpt-image-2",
        history: [
          { role: "user", text: "draw a poster" },
          { role: "assistant", text: "done" },
        ],
      }
    );

    expect(result.error).toContain("only supports single-turn");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("streams native upstream Chat Completions only when backend streaming is enabled", async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";
    const { generateChatImage } = await import("./service");
    const fetchMock = vi.fn(async () => {
      return new Response(
        `${sseBlock("chat.completion.chunk", {
          choices: [{ delta: { content: "hello" } }],
        })}data: [DONE]\n\n`,
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const deltas: string[] = [];

    const result = await generateChatImage(
      {
        baseUrl: "https://api.example.test/v1",
        apiKey: "test-key",
        useStream: true,
        backend: {
          type: "pool-api",
          apiInterfaceMode: "mixed",
          chatCompletionsUpstreamMode: "chat_completions",
        },
      },
      {
        prompt: "hello",
        model: "gpt-5.5",
      },
      {
        onTextDelta: (delta) => {
          deltas.push(delta);
        },
      }
    );

    expect(result.responseText).toBe("hello");
    expect(deltas).toEqual(["hello"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/v1/chat/completions",
      expect.objectContaining({
        body: expect.stringContaining('"stream":true'),
      })
    );
  });

  it("closes streamed image generation task when final image only arrives in response.completed", async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";
    const { generateChatImage } = await import("./service");
    const imageBase64 = Buffer.from("final-image").toString("base64");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            sseBlock("response.output_item.added", {
              type: "response.output_item.added",
              item: {
                id: "ig_1",
                type: "image_generation_call",
                status: "in_progress",
              },
            }) +
              sseBlock("response.image_generation_call.in_progress", {
                type: "response.image_generation_call.in_progress",
                item_id: "ig_1",
              }) +
              sseBlock("response.completed", {
                type: "response.completed",
                response: {
                  id: "resp_test",
                  output: [
                    {
                      id: "ig_1",
                      type: "image_generation_call",
                      status: "completed",
                      result: imageBase64,
                    },
                  ],
                },
              })
          )
        );
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      })
    );

    const agentEvents: Array<{
      id?: string;
      status?: string;
      title?: string;
      toolType?: string;
    }> = [];
    const result = await generateChatImage(
      {
        baseUrl: "https://api.example.test/v1",
        apiKey: "test-key",
      },
      {
        prompt: "make an image",
        model: "gpt-5.5",
        stream: true,
      },
      {
        onAgentEvent: (event) => {
          agentEvents.push(event);
        },
      }
    );

    expect(result.imageBase64).toBe(imageBase64);
    expect(result.agentEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "ig_1",
          status: "completed",
          title: "最终图片已生成",
          toolType: "image_generation_call",
        }),
      ])
    );
    expect(agentEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "ig_1",
          status: "running",
          toolType: "image_generation_call",
        }),
      ])
    );
  });

  it("keeps response.completed image outputs authoritative over earlier streamed output items", async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";
    const { generateChatImage } = await import("./service");
    const draftBase64 = Buffer.from("draft-image").toString("base64");
    const finalBase64 = Buffer.from("final-image").toString("base64");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          sseBlock("response.output_item.done", {
            type: "response.output_item.done",
            item: {
              id: "ig_draft",
              type: "image_generation_call",
              status: "completed",
              result: draftBase64,
            },
          }) +
            sseBlock("response.completed", {
              type: "response.completed",
              response: {
                id: "resp_test",
                output: [
                  {
                    id: "ig_final",
                    type: "image_generation_call",
                    status: "completed",
                    result: finalBase64,
                  },
                ],
              },
            }),
          {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }
        );
      })
    );

    const result = await generateChatImage(
      {
        baseUrl: "https://api.example.test/v1",
        apiKey: "test-key",
      },
      {
        prompt: "make an image",
        model: "gpt-5.5",
        stream: true,
      }
    );

    expect(result.imageOutputs).toEqual([
      expect.objectContaining({ imageBase64: finalBase64 }),
    ]);
    expect(result.imageOutputs).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ imageBase64: draftBase64 }),
      ])
    );
  });
});
