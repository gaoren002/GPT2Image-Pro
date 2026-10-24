// @vitest-environment jsdom

/** 输入图引用闭环回归：稳定 ID、历史/重试图片、即时持久化及账号撤销。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as inputImages from "./chat-input-images";
import type { ChatConversation, ChatMessage } from "./chat-message-types";
import {
  beginChatStorageScope,
  readChatConversations,
} from "./chat-persistence";

const url1 =
  "/api/storage/generations/user-a/requests/batch-0.png?sig=one&exp=1";
const url2 =
  "/api/storage/generations/user-a/requests/batch-1.png?sig=two&exp=1";

/** 混排非图片附件及同名图片；只有稳定 ID 能确定替换对象。 */
function message(): ChatMessage {
  return {
    id: "user-message",
    role: "user",
    text: "edit",
    mode: "chat",
    createdAt: "2026-10-24T00:00:00Z",
    attachments: [
      {
        id: "image-one",
        name: "same.png",
        kind: "image",
        previewUrl: `data:image/png;base64,${"x".repeat(4 * 1024 * 1024)}`,
      },
      { id: "note", name: "note.txt", kind: "file" },
      {
        id: "image-two",
        name: "same.png",
        kind: "image",
        previewUrl: "data:image/png;base64,YWJj",
      },
    ],
  };
}

/** 构造可用于 JSON 结果、SSE 确认或 error 事件的统一上传确认。 */
function payload() {
  return {
    sourceImageReferences: {
      messageId: "user-message",
      images: [
        { attachmentId: "image-two", url: url2 },
        { attachmentId: "image-one", url: url1 },
      ],
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("聊天输入图引用", () => {
  it("相对受控存储 URL 能进入后续 history，仍保留未确认的 data URL", () => {
    const current = message();
    if (!current.attachments?.[0]) throw new Error("missing image");
    current.attachments[0].previewUrl = url1;
    expect(inputImages.getMessageImageUrls(current)).toEqual([
      url1,
      "data:image/png;base64,YWJj",
    ]);
  });

  it("引用确认按消息和附件 ID 替换，4MB 原图不再进入 localStorage", () => {
    const scope = { userId: "user-a", active: true };
    let messages = [message()];
    const conversationsRef = { current: [] as ChatConversation[] };
    const onPersistenceResult = vi.fn();
    const receive = inputImages.createChatSourceImageReceiver({
      scope,
      conversationId: "conversation",
      mode: "chat",
      messageId: "user-message",
      attachmentIds: ["image-one", "image-two"],
      getMessages: () => messages,
      setMessages: (next) => {
        messages = next;
      },
      conversationsRef,
      setConversations: vi.fn(),
      titleFallback: "Untitled chat",
      onPersistenceResult,
    });
    receive(payload());
    expect(messages[0]?.attachments).toEqual([
      { id: "image-one", name: "same.png", kind: "image", previewUrl: url1 },
      { id: "note", name: "note.txt", kind: "file" },
      { id: "image-two", name: "same.png", kind: "image", previewUrl: url2 },
    ]);
    const stored = readChatConversations(scope)
      .conversations as ChatConversation[];
    expect(
      inputImages.getMessageImageUrls(stored[0]?.messages[0] as ChatMessage)
    ).toEqual([url1, url2]);
    expect(JSON.stringify(stored)).not.toContain("data:image");
    expect(JSON.stringify(stored).length).toBeLessThan(2_000);
    expect(onPersistenceResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: "saved" })
    );
    const first = messages;
    receive(payload());
    expect(messages).toBe(first);
  });

  it.each([
    "json",
    "sse",
  ])("换账号后迟到 %s 输入引用不能写内存、会话列表或磁盘", async (transport) => {
    const scope = beginChatStorageScope("user-a");
    const setMessages = vi.fn();
    const setConversations = vi.fn();
    const report = vi.fn();
    const getMessages = vi.fn(() => [message()]);
    const conversationsRef = { current: [] as ChatConversation[] };
    const receive = inputImages.createChatSourceImageReceiver({
      scope,
      conversationId: "conversation",
      mode: "chat",
      messageId: "user-message",
      attachmentIds: ["image-one", "image-two"],
      getMessages,
      setMessages,
      conversationsRef,
      setConversations,
      titleFallback: "Untitled chat",
      onPersistenceResult: report,
    });
    let finish: (value: unknown) => void = () => {};
    const response = new Promise<unknown>((resolve) => {
      finish = resolve;
    }).then(receive);
    const newScope = beginChatStorageScope("user-b");
    localStorage.setItem("user-b-sentinel", "unchanged");
    finish(
      transport === "json"
        ? JSON.parse(JSON.stringify(payload()))
        : { type: "input_images", ...payload() }
    );
    await response;
    expect(scope.active).toBe(false);
    expect(newScope.active).toBe(true);
    expect(getMessages).not.toHaveBeenCalled();
    expect(setMessages).not.toHaveBeenCalled();
    expect(setConversations).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    expect(conversationsRef.current).toEqual([]);
    expect(localStorage.length).toBe(1);
    expect(localStorage.getItem("user-b-sentinel")).toBe("unchanged");
  });

  it.each([
    "missing",
    "wrong-message",
    "duplicate-id",
    "foreign-owner",
    "external-url",
  ])("缺失/非法确认保留原参考图：%s", (kind) => {
    const original = [message()];
    const data = payload();
    if (kind === "wrong-message")
      data.sourceImageReferences.messageId = "other-message";
    if (kind === "duplicate-id")
      data.sourceImageReferences.images[1] = {
        attachmentId: "image-two",
        url: url1,
      };
    if (kind === "foreign-owner")
      data.sourceImageReferences.images[0] = {
        attachmentId: "image-two",
        url: "/api/storage/generations/user-b/private.png",
      };
    if (kind === "external-url")
      data.sourceImageReferences.images[0] = {
        attachmentId: "image-two",
        url: "https://external.example.test/image.png",
      };
    const setMessages = vi.fn();
    const receive = inputImages.createChatSourceImageReceiver({
      scope: { userId: "user-a", active: true },
      conversationId: "conversation",
      mode: "chat",
      messageId: "user-message",
      attachmentIds: ["image-one", "image-two"],
      getMessages: () => original,
      setMessages,
      conversationsRef: { current: [] },
      setConversations: vi.fn(),
      titleFallback: "Untitled chat",
      onPersistenceResult: vi.fn(),
    });
    receive(kind === "missing" ? { error: "storage unavailable" } : data);
    expect(setMessages).not.toHaveBeenCalled();
    expect(original[0]?.attachments?.[0]?.previewUrl).toMatch(/^data:image/);
  });

  it("浏览器存储不可用仍在内存保留已上传引用，并报告持久化失败", () => {
    let messages = [message()];
    const report = vi.fn();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "QuotaExceededError");
    });
    const receive = inputImages.createChatSourceImageReceiver({
      scope: { userId: "user-a", active: true },
      conversationId: "conversation",
      mode: "chat",
      messageId: "user-message",
      attachmentIds: ["image-one", "image-two"],
      getMessages: () => messages,
      setMessages: (next) => {
        messages = next;
      },
      conversationsRef: { current: [] },
      setConversations: vi.fn(),
      titleFallback: "Untitled chat",
      onPersistenceResult: report,
    });
    receive(payload());
    expect(inputImages.getMessageImageUrls(messages[0] as ChatMessage)).toEqual(
      [url1, url2]
    );
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" })
    );
  });

  it("生成失败后重试仍携带该 userMessage 的图片，文本 prompt 不重复", () => {
    const user = message();
    if (!user.attachments?.[0]) throw new Error("missing image");
    user.attachments[0].previewUrl = url1;
    const history = inputImages.buildChatRetryHistory(
      [
        user,
        {
          id: "assistant",
          role: "assistant",
          text: "failed",
          createdAt: user.createdAt,
        },
      ],
      user.id
    );
    expect(history).toHaveLength(1);
    expect(history[0]?.text).toBe("");
    expect(inputImages.getMessageImageUrls(history[0] as ChatMessage)).toEqual([
      url1,
      "data:image/png;base64,YWJj",
    ]);
  });

  it("导航后确认只更新原会话，不能覆盖当前会话或改活跃指针", () => {
    const scope = { userId: "user-a", active: true };
    const previous: ChatConversation = {
      id: "previous",
      mode: "chat",
      title: "previous",
      messages: [message()],
      createdAt: "2026-10-24T00:00:00Z",
      updatedAt: "2026-10-24T00:00:00Z",
    };
    const conversationsRef = { current: [previous] };
    const setMessages = vi.fn();
    const receive = inputImages.createChatSourceImageReceiver({
      scope,
      conversationId: "previous",
      mode: "chat",
      messageId: "user-message",
      attachmentIds: ["image-one", "image-two"],
      getMessages: () => [
        {
          id: "other-message",
          role: "user",
          text: "other",
          createdAt: previous.createdAt,
        },
      ],
      setMessages,
      conversationsRef,
      setConversations: vi.fn(),
      titleFallback: "Untitled chat",
      onPersistenceResult: vi.fn(),
    });
    receive(payload());
    expect(setMessages).not.toHaveBeenCalled();
    expect(
      inputImages.getMessageImageUrls(
        conversationsRef.current[0]?.messages[0] as ChatMessage
      )
    ).toEqual([url1, url2]);
  });
});
