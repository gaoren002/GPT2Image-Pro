// @vitest-environment jsdom
/** 附件确认到定稿的真实客户端状态回归：不复活 data URL、旧账号或已删除会话。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChatSourceImageReceiver,
  getChatHistoryImageInput,
  readEditableFileResponse,
} from "./chat-input-images";
import type { ChatConversation, ChatMessage } from "./chat-message-types";
import {
  chatActiveConversationStorageKey,
  readChatConversations,
  updateChatConversationMessage,
} from "./chat-persistence";
const dataUrl = `data:image/png;base64,${"a".repeat(2 * 1024 * 1024)}`;
const storedUrl = "/api/storage/generations/user-a/requests/old.png";
/** 同名文件混排，保留晚到确认之前的消息快照。 */
function setup() {
  let messages: ChatMessage[] = [
    {
      id: "user",
      role: "user",
      text: "file",
      createdAt: "2026-10-25T00:00:00Z",
      attachments: [
        { id: "note", kind: "file", name: "same.png" },
        { id: "image", name: "same.png", previewUrl: dataUrl },
      ],
    },
    {
      id: "assistant",
      role: "assistant",
      text: "pending",
      createdAt: "2026-10-25T00:00:00Z",
    },
  ];
  const params = {
    scope: { active: true, userId: "user-a" },
    conversationId: "old",
    mode: "web" as const,
    getMessages: () => messages,
    setMessages: vi.fn((next: ChatMessage[]) => {
      messages = next;
    }),
    conversationsRef: {
      current: [
        {
          id: "old",
          mode: "web",
          title: "file",
          messages,
          createdAt: "2026-10-25T00:00:00Z",
          updatedAt: "2026-10-25T00:00:00Z",
        },
      ] as ChatConversation[],
    },
    setConversations: vi.fn(),
    titleFallback: "untitled",
    onPersistenceResult: vi.fn(),
  };
  const receive = createChatSourceImageReceiver({
    ...params,
    messageId: "user",
    attachmentIds: ["image"],
  });
  const payload = {
    sourceImageReferences: {
      messageId: "user",
      images: [{ attachmentId: "image", url: storedUrl }],
    },
  };
  return { params, receive, payload };
}
beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});
describe("R37 客户端确认定稿", () => {
  it("旧无 kind 图片正确关联，普通文件不占图索引", () => {
    const { params } = setup();
    expect(
      getChatHistoryImageInput(params.getMessages()[0] as ChatMessage)
    ).toEqual({
      imageUrls: [dataUrl],
      sourceImageMetadata: { messageId: "user", attachmentIds: ["image"] },
    });
    expect(
      getChatHistoryImageInput(params.getMessages()[1] as ChatMessage).imageUrls
    ).toEqual([]);
  });
  it.each([
    false,
    true,
  ])("确认后定稿保存最新引用，保活成功/失败均先确认 error=%s", async (error) => {
    const { params, receive, payload } = setup();
    const result = await readEditableFileResponse(
      new Response(
        `  \n${JSON.stringify({ ...payload, ...(error ? { error: { message: "failed" } } : { result: { primary_url: "/file.pptx" } }) })}`
      ),
      receive
    );
    expect(params.getMessages()[0]?.attachments?.[1]?.previewUrl).toBe(
      storedUrl
    );
    updateChatConversationMessage({
      ...params,
      messageId: "assistant",
      update: (message) => ({
        ...message,
        text: result.error ? "failed" : "completed",
      }),
    });
    const restored = readChatConversations(params.scope)
      .conversations as ChatConversation[];
    expect(restored[0]?.messages[1]?.text).toBe(error ? "failed" : "completed");
    expect(JSON.stringify(restored)).not.toContain("data:image");
    expect(JSON.stringify(restored).length).toBeLessThan(2000);
  });
  it("导航后确认与定稿只写原会话且保留新活跃指针", () => {
    const { params, receive, payload } = setup();
    params.setMessages([
      {
        id: "other",
        role: "user",
        text: "new",
        createdAt: "2026-10-25T01:00:00Z",
      },
    ]);
    params.setMessages.mockClear();
    const key = chatActiveConversationStorageKey("web", params.scope);
    localStorage.setItem(key, "new-conversation");
    receive(payload);
    updateChatConversationMessage({
      ...params,
      messageId: "assistant",
      update: (message) => ({ ...message, text: "done" }),
    });
    expect(params.setMessages).not.toHaveBeenCalled();
    expect(localStorage.getItem(key)).toBe("new-conversation");
    expect(
      params.conversationsRef.current[0]?.messages[0]?.attachments?.[1]
        ?.previewUrl
    ).toBe(storedUrl);
    expect(params.conversationsRef.current[0]?.messages[1]?.text).toBe("done");
  });
  it.each(["revoked", "deleted"])("迟到确认/定稿无复活副作用 %s", (kind) => {
    const { params, receive, payload } = setup();
    if (kind === "revoked") params.scope.active = false;
    else {
      params.setMessages([]);
      params.conversationsRef.current = [];
      params.setMessages.mockClear();
    }
    receive(payload);
    updateChatConversationMessage({
      ...params,
      messageId: "assistant",
      update: (message) => ({ ...message, text: "done" }),
    });
    expect(params.setMessages).not.toHaveBeenCalled();
    expect(params.onPersistenceResult).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });
  it("重复确认只保存一次；损坏 JSON 不清原图", async () => {
    const first = setup();
    first.receive(first.payload);
    first.receive(first.payload);
    expect(first.params.onPersistenceResult).toHaveBeenCalledTimes(1);
    const second = setup();
    await expect(
      readEditableFileResponse(new Response("{broken"), second.receive)
    ).rejects.toThrow();
    expect(second.params.getMessages()[0]?.attachments?.[1]?.previewUrl).toBe(
      dataUrl
    );
  });
  it("确认后 localStorage 不可用仍保留内存引用并报告失败", () => {
    const { params, receive, payload } = setup();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    receive(payload);
    expect(params.getMessages()[0]?.attachments?.[1]?.previewUrl).toBe(
      storedUrl
    );
    expect(params.onPersistenceResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" })
    );
  });
});
