/** 聊天输入图引用协议回归：真实上传辅助函数与 JSON/SSE，隔离认证和生成服务。 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChatSourceImageReceiver,
  getMessageImageUrls,
} from "@/features/image-generation/components/chat-input-images";
import type {
  ChatConversation,
  ChatMessage,
} from "@/features/image-generation/components/chat-message-types";
import { readChatConversations } from "@/features/image-generation/components/chat-persistence";
import { ensureInputImageRehosted } from "@/features/image-generation/rehost-input-images";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  putObject: vi.fn(),
  getSignedUrl: vi.fn(),
  deleteObject: vi.fn(),
}));
vi.mock("@repo/shared/api-logger", () => ({
  withApiLogging: (handler: unknown) => handler,
}));
vi.mock("@repo/shared/auth", () => ({
  auth: { api: { getSession: async () => ({ user: { id: "user-a" } }) } },
}));
vi.mock("@repo/shared/subscription/services/user-plan", () => ({
  getUserPlan: async () => ({ plan: "pro" }),
}));
vi.mock("@repo/shared/subscription/services/plan-capabilities", () => ({
  canUsePlanCapability: async () => true,
  getPlanLimits: async () => ({
    maxChatImages: 8,
    maxChatContextChars: 32_000,
    maxBatchCount: 3,
    imageGenerationConcurrency: 1,
  }),
}));
vi.mock("@repo/shared/subscription/services/upload-limits", () => ({
  getPlanUploadLimits: async () => ({
    maxFileSizeBytes: 25 * 1024 * 1024,
    maxUploadBytes: 50 * 1024 * 1024,
  }),
}));
vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingString: async (key: string) => {
    if (key === "CONTENT_MODERATION_PUBLIC_BASE_URL")
      return "https://app.example.test";
    if (key === "NEXT_PUBLIC_GENERATIONS_BUCKET_NAME") return "generations";
    return "";
  },
}));
vi.mock("@repo/shared/storage/providers", () => ({
  getStorageProvider: async () => ({
    putObject: mocks.putObject,
    getSignedUrl: mocks.getSignedUrl,
    deleteObject: mocks.deleteObject,
  }),
}));
vi.mock("@/features/image-generation/operations", () => ({
  runImageGenerationForUser: mocks.run,
}));

import { POST } from "./route";

/** 夹入一个普通文件并使用同名图片，验证引用按图片顺序而非文件名映射。 */
function request(
  stream = false,
  ids: string[] = ["image-first", "image-second"],
  signal?: AbortSignal
) {
  const form = new FormData();
  form.set("prompt", "edit references");
  form.set("source_image_message_id", "message-user-1");
  form.set("source_image_attachment_ids", JSON.stringify(ids));
  form.append(
    "image[]",
    new File(["first"], "same.png", { type: "image/png" })
  );
  form.append("file", new File(["notes"], "notes.txt", { type: "text/plain" }));
  form.append(
    "image[]",
    new File(["second"], "same.png", { type: "image/png" })
  );
  if (stream) form.set("stream", "true");
  return new NextRequest("https://app.example.test/api/images/chat", {
    method: "POST",
    body: form,
    signal,
  });
}

/** 解析真实 SSE 响应，忽略保活和 flush 填充。 */
async function events(
  response: Response
): Promise<Array<Record<string, unknown>>> {
  return (await response.text())
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)) as Record<string, unknown>);
}

/** 对比引用与实际已上传对象，不能返回临时外部预签名 URL。 */
function expectReferences(value: unknown) {
  expect(value).toEqual({
    messageId: "message-user-1",
    images: [
      {
        attachmentId: "image-first",
        url: expect.stringMatching(
          /^\/api\/storage\/generations\/user-a\/requests\/.+-0\.png\?/
        ),
      },
      {
        attachmentId: "image-second",
        url: expect.stringMatching(
          /^\/api\/storage\/generations\/user-a\/requests\/.+-1\.png\?/
        ),
      },
    ],
  });
  expect(mocks.putObject.mock.calls.map((call) => call[2].toString())).toEqual([
    "first",
    "second",
  ]);
  expect(mocks.putObject).toHaveBeenCalledTimes(2);
  expect(mocks.deleteObject).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.stubEnv("BETTER_AUTH_SECRET", "test-chat-input-image-secret");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.test");
  mocks.run
    .mockReset()
    .mockResolvedValue({ generationId: "gen-1", responseText: "done" });
  mocks.putObject.mockReset().mockResolvedValue(undefined);
  mocks.getSignedUrl
    .mockReset()
    .mockResolvedValue("https://r2.example.test/short-lived?signature=test");
  mocks.deleteObject.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("聊天输入图引用响应", () => {
  it.each([
    false,
    true,
  ])("同步 HTTP 取消信号原样传入生成调用：stream=%s", async (stream) => {
    const controller = new AbortController();
    const incoming = request(stream, undefined, controller.signal);
    let started: () => void = () => {};
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    let receivedSignal: AbortSignal | undefined;
    let observedAbort = false;
    mocks.run.mockImplementation(async (input: { signal?: AbortSignal }) => {
      receivedSignal = input.signal;
      started();
      if (input.signal)
        await new Promise<void>((resolve) => {
          input.signal?.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              resolve();
            },
            { once: true }
          );
        });
      return { responseText: "finished" };
    });
    const response = POST(incoming);
    await running;
    try {
      expect(receivedSignal).toBe(incoming.signal);
      expect(receivedSignal?.aborted).toBe(false);
    } finally {
      controller.abort();
      await (await response).text();
    }
    expect(observedAbort).toBe(true);
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("JSON 回传现有上传的受控引用，不额外上传", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expectReferences((await response.json()).sourceImageReferences);
  });

  it("SSE 在生成结果之前确认引用；业务失败仍可保存参考图", async () => {
    mocks.run.mockResolvedValue({
      error: "upstream failed",
      generationId: "gen-1",
    });
    const result = await events(await POST(request(true)));
    expect(result[0]?.type).toBe("input_images");
    expectReferences(result[0]?.sourceImageReferences);
    expect(result.some((event) => event.type === "error")).toBe(true);
  });

  it("SSE 生成抛错前已确认输入图；流仍正常结束", async () => {
    mocks.run.mockRejectedValue(new Error("generation threw"));
    const result = await events(await POST(request(true)));
    expectReferences(result[0]?.sourceImageReferences);
    expect(result.at(-1)?.type).toBe("done");
  });

  it("JSON 业务失败或异常也带上传确认", async () => {
    mocks.run.mockRejectedValue(new Error("generation threw"));
    const response = await POST(request());
    expect(response.status).toBe(400);
    expectReferences((await response.json()).sourceImageReferences);
  });

  it("存储不可用时保留原字节输入，不伪造可持久化引用", async () => {
    mocks.putObject.mockRejectedValue(new Error("storage unavailable"));
    const response = await POST(request());
    const result = await response.json();
    expect(result.sourceImageReferences).toBeUndefined();
    expect(
      mocks.run.mock.calls[0]?.[0].images.map((image: { data: Buffer }) =>
        image.data.toString()
      )
    ).toEqual(["first", "second"]);
    expect(mocks.putObject).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["only-one"],
    ["duplicate", "duplicate"],
  ])("不接受长度不符或重复的附件 ID：%j", async (...ids) => {
    const response = await POST(request(false, ids));
    expect(response.status).toBe(400);
    expect(mocks.putObject).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("下一轮带受控引用时由现有 owner 校验续签，无输入文件就不再次上传", async () => {
    const form = new FormData();
    form.set("prompt", "continue");
    form.set(
      "history",
      JSON.stringify([
        {
          role: "user",
          text: "edit",
          imageUrls: [
            "/api/storage/generations/user-a/requests/original-0.png?exp=1&sig=old",
          ],
        },
      ])
    );
    const response = await POST(
      new NextRequest("https://app.example.test/api/images/chat", {
        method: "POST",
        body: form,
      })
    );
    expect(response.status).toBe(200);
    expect(mocks.putObject).not.toHaveBeenCalled();
    expect(mocks.run.mock.calls[0]?.[0].history[0].imageUrls[0]).toMatch(
      /^https:\/\/app.example.test\/api\/storage\/generations\/user-a\/requests\/original-0.png\?sig=/
    );
  });

  it.each([
    "json",
    "sse",
    "sse-error",
  ])("真实响应到刷新恢复再到下一轮，只发生初次上传：%s", async (mode) => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    const scope = { userId: "user-a", active: true };
    let messages: ChatMessage[] = [
      {
        id: "message-user-1",
        role: "user",
        mode: "chat",
        text: "edit",
        createdAt: "2026-10-24T00:00:00Z",
        attachments: [
          {
            id: "image-first",
            name: "same.png",
            kind: "image",
            previewUrl: `data:image/png;base64,${"x".repeat(4 * 1024 * 1024)}`,
          },
          { id: "note", name: "notes.txt", kind: "file" },
          {
            id: "image-second",
            name: "same.png",
            kind: "image",
            previewUrl: "data:image/png;base64,c2Vjb25k",
          },
        ],
      },
    ];
    const receive = createChatSourceImageReceiver({
      scope,
      conversationId: "conversation",
      mode: "chat",
      messageId: "message-user-1",
      attachmentIds: ["image-first", "image-second"],
      getMessages: () => messages,
      setMessages: (next) => {
        messages = next;
      },
      conversationsRef: { current: [] },
      setConversations: vi.fn(),
      titleFallback: "Untitled chat",
      onPersistenceResult: vi.fn(),
    });
    if (mode === "sse-error")
      mocks.run.mockResolvedValue({ error: "generation failed" });
    const response = await POST(request(mode !== "json"));
    if (mode === "json") receive(await response.json());
    else for (const event of await events(response)) receive(event);
    expect(mocks.putObject).toHaveBeenCalledTimes(2);
    const restored = readChatConversations(scope)
      .conversations as ChatConversation[];
    const user = restored[0]?.messages[0];
    if (!user) throw new Error("input references were not persisted");
    const imageUrls = getMessageImageUrls(user);
    expect(imageUrls).toHaveLength(2);
    expect(JSON.stringify(restored)).not.toContain("data:image");
    expect(JSON.stringify(restored).length).toBeLessThan(2_000);
    const form = new FormData();
    form.set("prompt", "continue after reload");
    form.set(
      "history",
      JSON.stringify([{ role: "user", text: user.text, imageUrls }])
    );
    mocks.run.mockResolvedValue({ responseText: "continued" });
    expect(
      (
        await POST(
          new NextRequest("https://app.example.test/api/images/chat", {
            method: "POST",
            body: form,
          })
        )
      ).status
    ).toBe(200);
    const history = mocks.run.mock.calls.at(-1)?.[0].history as Array<{
      imageUrls: string[];
    }>;
    for (const url of history[0]?.imageUrls || []) {
      const image = {
        data: Buffer.alloc(0),
        type: "image/png",
        name: "history.png",
        url,
      };
      // 使用真实 rehost 判断，证明下一轮进入服务层也会短路，不只是 route 没传文件。
      expect(
        await ensureInputImageRehosted(image, {
          userId: "user-a",
          generationId: "next-round",
        })
      ).toBe(image);
    }
    expect(mocks.putObject).toHaveBeenCalledTimes(2);
    expect(mocks.deleteObject).not.toHaveBeenCalled();
  });
});
