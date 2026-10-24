// @vitest-environment jsdom

/** 聊天持久化回归：真实 Storage 的账号归属、容量失败和参考图完整性。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatConversation, ChatMessage } from "./chat-message-types";
import {
  CHAT_CONVERSATION_MAX_BYTES,
  CHAT_CONVERSATIONS_STORAGE_KEY,
  CHAT_STORAGE_KEY,
  CHAT_STORAGE_MAX_BYTES,
  chatConversationsStorageKey,
  persistActiveChatConversation,
  persistChatConversationSnapshot,
  persistChatConversations,
  readActiveChatConversation,
  readChatConversations,
  sanitizePersistedChatMessages,
} from "./chat-persistence";

/** 构造不同正文的会话，避免正常的快照去重影响容量用例。 */
function messages(id: string, previewUrl?: string): ChatMessage[] {
  return [
    {
      id,
      role: "user",
      text: id,
      mode: "chat",
      createdAt: "2026-10-24T00:00:00Z",
      attachments: previewUrl
        ? [{ id: "image", name: "reference.png", kind: "image", previewUrl }]
        : undefined,
    },
  ];
}

/** 显式传入账号归属；旧实现忽略该参数，复现固定键写入。 */
function save(
  userId: string,
  id: string,
  image?: string,
  conversations: ChatConversation[] = []
) {
  const params = {
    scope: { userId, active: true },
    conversations,
    conversationId: id,
    mode: "chat" as const,
    messages: messages(id, image),
    titleFallback: "Untitled chat",
  };
  return persistChatConversationSnapshot(params);
}

/** 读取所有值，只检查测试样本，不依赖实现选择的键名。 */
function storageValues() {
  return Array.from(
    { length: localStorage.length },
    (_, index) => localStorage.getItem(localStorage.key(index) || "") || ""
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("聊天本地持久化", () => {
  it("A、B 账号独立保存，B 的写入不覆盖 A", () => {
    save("user-a", "message-from-a");
    save("user-b", "message-from-b");
    expect(
      storageValues().some((value) => value.includes("message-from-a"))
    ).toBe(true);
    expect(
      storageValues().some((value) => value.includes("message-from-b"))
    ).toBe(true);
    expect(localStorage.getItem(CHAT_CONVERSATIONS_STORAGE_KEY)).toBeNull();
  });

  it("旧无归属存储既不迁入当前账号，也不由保存顺手删除", () => {
    const legacy = JSON.stringify(messages("unowned-history"));
    localStorage.setItem(CHAT_STORAGE_KEY, legacy);
    save("user-b", "new-message");
    expect(localStorage.getItem(CHAT_STORAGE_KEY)).toBe(legacy);
    expect(
      storageValues().filter((value) => value.includes("unowned-history"))
    ).toEqual([legacy]);
  });

  it("已撤销的旧账号回调不能落盘", () => {
    const params = {
      scope: { userId: "user-a", active: false },
      conversations: [],
      conversationId: "old",
      mode: "chat" as const,
      messages: messages("old-account-callback"),
      titleFallback: "Untitled chat",
    };
    persistChatConversationSnapshot(params);
    expect(localStorage.length).toBe(0);
  });

  it("超限会话不阻止另一个会话保存，失败有返回值", () => {
    const hugeMessages = messages(
      "oversized",
      `data:image/png;base64,${"a".repeat(6 * 1024 * 1024)}`
    );
    const oversized: ChatConversation = {
      id: "oversized",
      mode: "chat",
      title: "oversized",
      messages: hugeMessages,
      createdAt: "2026-10-24T00:00:00Z",
      updatedAt: "2026-10-24T00:00:00Z",
    };
    const result = save("user-a", "small-chat", undefined, [oversized]);
    expect(storageValues().some((value) => value.includes("small-chat"))).toBe(
      true
    );
    expect(result).toMatchObject({
      status: "partial",
      failedConversationIds: ["oversized"],
    });
    expect(oversized.messages[0]?.attachments?.[0]?.previewUrl).toBe(
      hugeMessages[0]?.attachments?.[0]?.previewUrl
    );
  });

  it("浏览器拒绝写入时返回可报告失败，保留上次成功记录", () => {
    save("user-a", "last-good");
    const previous = storageValues();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage denied", "QuotaExceededError");
    });
    expect(save("user-a", "next-message")).toMatchObject({
      status: "failed",
      reason: "unavailable",
    });
    expect(storageValues()).toEqual(previous);
  });

  it("正常附件和已发送上下文保留 data URL，存储副本不改变内存消息", () => {
    const source = messages("with-image", "data:image/png;base64,YWJj");
    const result = sanitizePersistedChatMessages(source);
    expect(result[0]?.attachments?.[0]?.previewUrl).toBe(
      "data:image/png;base64,YWJj"
    );
    expect(source[0]?.attachments?.[0]?.previewUrl).toBe(
      "data:image/png;base64,YWJj"
    );
  });

  it("正常带图会话刷新后完整恢复，B 账号和旧无归属记录不会成为回退", () => {
    const first = { userId: "user-a", active: true };
    const second = { userId: "user-b", active: true };
    localStorage.setItem(
      CHAT_CONVERSATIONS_STORAGE_KEY,
      JSON.stringify([{ id: "unowned" }])
    );
    localStorage.setItem(
      CHAT_STORAGE_KEY,
      JSON.stringify(messages("unowned-message"))
    );
    const image = "data:image/png;base64,YWJj";
    save(first.userId, "saved-with-image", image);
    expect(readChatConversations(first).conversations).toEqual([
      expect.objectContaining({
        id: "saved-with-image",
        messages: messages("saved-with-image", image),
      }),
    ]);
    expect(readChatConversations(second)).toEqual({ conversations: [] });
    localStorage.setItem(
      chatConversationsStorageKey(second),
      localStorage.getItem(chatConversationsStorageKey(first)) || ""
    );
    expect(readChatConversations(second)).toEqual({
      conversations: [],
      error: "invalid",
    });
    expect(readChatConversations(first).conversations).toHaveLength(1);
  });

  it("旧成功快照遇到大图更新仍保留，同时可持久化其他小会话", () => {
    const scope = { userId: "user-a", active: true };
    const image = "data:image/png;base64,YWJj";
    save(scope.userId, "original", image);
    const original = readChatConversations(scope)
      .conversations[0] as ChatConversation;
    const updated = {
      ...original,
      messages: messages(
        "oversized-update",
        `data:image/png;base64,${"b".repeat(CHAT_CONVERSATION_MAX_BYTES)}`
      ),
    };
    expect(persistChatConversations(scope, [updated])).toMatchObject({
      status: "partial",
      failedConversationIds: ["original"],
    });
    expect(readChatConversations(scope).conversations).toEqual([original]);
    expect(
      save(scope.userId, "another-small-chat", undefined, [updated])
    ).toMatchObject({ status: "partial", failedConversationIds: ["original"] });
    expect(readChatConversations(scope).conversations).toEqual([
      expect.objectContaining({ id: "another-small-chat" }),
      original,
    ]);
    expect(
      updated.messages[0]?.attachments?.[0]?.previewUrl?.length
    ).toBeGreaterThan(CHAT_CONVERSATION_MAX_BYTES);
  });

  it("总量有界，达到预算后仍能保存后续小会话并报告未保存项", () => {
    const scope = { userId: "user-a", active: true };
    const conversations: ChatConversation[] = Array.from(
      { length: 5 },
      (_, index) => ({
        id: `large-${index}`,
        mode: "chat",
        title: `large-${index}`,
        messages: messages(
          `large-${index}`,
          `data:image/png;base64,${"c".repeat(400_000)}`
        ),
        createdAt: "2026-10-24T00:00:00Z",
        updatedAt: "2026-10-24T00:00:00Z",
      })
    );
    const result = save(
      scope.userId,
      "tiny-still-saved",
      undefined,
      conversations
    );
    expect(result.status).toBe("partial");
    const raw = localStorage.getItem(chatConversationsStorageKey(scope)) || "";
    expect(raw).toContain("tiny-still-saved");
    expect(raw.length * 2).toBeLessThanOrEqual(CHAT_STORAGE_MAX_BYTES);
    expect(conversations).toHaveLength(5);
  });

  it("chat、agent、web 活跃指针独立；清理 A 的列表不会影响 B", () => {
    const first = { userId: "user-a", active: true };
    const second = { userId: "user-b", active: true };
    save(first.userId, "from-a");
    save(second.userId, "from-b");
    for (const mode of ["chat", "agent", "web"] as const) {
      expect(
        persistActiveChatConversation(first, mode, `a-${mode}`).status
      ).toBe("saved");
      expect(
        persistActiveChatConversation(second, mode, `b-${mode}`).status
      ).toBe("saved");
    }
    persistChatConversations(first, []);
    expect(readChatConversations(first).conversations).toEqual([]);
    expect(readChatConversations(second).conversations).toHaveLength(1);
    for (const mode of ["chat", "agent", "web"] as const) {
      expect(readActiveChatConversation(first, mode)).toBe(`a-${mode}`);
      expect(readActiveChatConversation(second, mode)).toBe(`b-${mode}`);
    }
  });

  it("损坏的 JSON 返回读取失败，不能删除另一账号或上次磁盘数据", () => {
    const scope = { userId: "user-a", active: true };
    save("user-b", "other-account");
    localStorage.setItem(chatConversationsStorageKey(scope), "{");
    const previous = storageValues();
    expect(readChatConversations(scope)).toEqual({
      conversations: [],
      error: "invalid",
    });
    expect(storageValues()).toEqual(previous);
  });
});
