/**
 * 聊天会话 localStorage 持久化(纯函数,DB-free)。
 *
 * 使用方:创作页与聊天叶子订阅组件。v2 按账号存储并校验归属;
 * 无归属的 v1 数据不读取、不自动迁移。容量不足时保留完整内存消息,
 * 返回可报告的失败结果，不能删图片来换取一次表面成功的写入。
 */

import { normalizeAgentEvent } from "../agent-round-cards";
import type { AgentRunEvent } from "../types";
import type {
  ChatConversation,
  ChatMessage,
  ConversationMode,
} from "./chat-message-types";

export const CHAT_STORAGE_KEY = "gpt2image_chat_messages_v1";
export const CHAT_CONVERSATIONS_STORAGE_KEY = "gpt2image_chat_conversations_v1";
export const CHAT_ACTIVE_CONVERSATION_STORAGE_KEY =
  "gpt2image_active_chat_conversation_v1";
export const CHAT_ACTIVE_AGENT_CONVERSATION_STORAGE_KEY =
  "gpt2image_active_agent_conversation_v1";
export const CHAT_CONVERSATION_LIMIT = 30;
// 按 UTF-16 字节估算 localStorage 占用，给同源其他设置和 JSON 外壳留余量。
export const CHAT_CONVERSATION_MAX_BYTES = 1024 * 1024;
export const CHAT_STORAGE_MAX_BYTES = 3 * 1024 * 1024;
export const CHAT_STORAGE_SCOPE_REVOKED_EVENT = "chat-storage-scope-revoked";

export type ChatStorageScope = { userId: string; active: boolean };
export type ChatPersistenceResult = {
  status: "saved" | "partial" | "failed" | "inactive";
  failedConversationIds: string[];
  reason?: "size" | "unavailable" | "invalid";
};

let currentScope: ChatStorageScope | null = null;

/** 绑定当前已确认账号；旧闭包保留旧对象，切换后即失去写入资格。 */
export function beginChatStorageScope(userId: string): ChatStorageScope {
  if (currentScope?.active && currentScope.userId === userId)
    return currentScope;
  if (currentScope) currentScope.active = false;
  currentScope = { userId, active: true };
  return currentScope;
}

/** 成功登出或会话切换时立即撤销旧回调，事件用于同时隐藏页面内存消息。 */
export function revokeChatStorageScope(userId: string | undefined) {
  if (!userId || currentScope?.userId !== userId) return;
  currentScope.active = false;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(CHAT_STORAGE_SCOPE_REVOKED_EVENT));
  }
}

/** 键名带显式版本和编码后的账号，旧无归属键不作为任何账号的回退。 */
export function chatConversationsStorageKey(scope: ChatStorageScope) {
  return `gpt2image_chat_v2:${encodeURIComponent(scope.userId)}:conversations`;
}
/**
 * 会话持久化去抖窗口(毫秒)。流式生成期 chatMessages 每个增量都变,
 * 若每次都同步 JSON.stringify 全部会话并写 localStorage 会逐 token 阻塞
 * 主线程;取尾沿去抖,回合结束或停顿时才真正落库。
 */
export const CHAT_PERSIST_DEBOUNCE_MS = 300;

export function chatActiveConversationStorageKey(
  mode: ConversationMode,
  scope: ChatStorageScope
) {
  return `gpt2image_chat_v2:${encodeURIComponent(scope.userId)}:active:${mode}`;
}

/** 只读取带正确归属的 v2 外壳；正文继续交由创作页的消息校验器校验。 */
export function readChatConversations(scope: ChatStorageScope): {
  conversations: unknown[];
  error?: "unavailable" | "invalid";
} {
  if (!scope.active || !scope.userId || typeof window === "undefined") {
    return { conversations: [] };
  }
  try {
    const raw = window.localStorage.getItem(chatConversationsStorageKey(scope));
    if (!raw) return { conversations: [] };
    const data: unknown = JSON.parse(raw);
    if (
      !data ||
      typeof data !== "object" ||
      !("version" in data) ||
      data.version !== 2 ||
      !("userId" in data) ||
      data.userId !== scope.userId ||
      !("conversations" in data) ||
      !Array.isArray(data.conversations)
    )
      return { conversations: [], error: "invalid" };
    return { conversations: data.conversations };
  } catch (error) {
    return {
      conversations: [],
      error: error instanceof SyntaxError ? "invalid" : "unavailable",
    };
  }
}

/** 活跃会话键也按模式和账号隔离，存储不可用时让页面继续使用内存状态。 */
export function readActiveChatConversation(
  scope: ChatStorageScope,
  mode: ConversationMode
) {
  if (!scope.active || !scope.userId || typeof window === "undefined")
    return null;
  try {
    return window.localStorage.getItem(
      chatActiveConversationStorageKey(mode, scope)
    );
  } catch {
    return null;
  }
}

/** 写入活跃会话指针；失败返回给 UI，旧账号闭包不产生副作用。 */
export function persistActiveChatConversation(
  scope: ChatStorageScope,
  mode: ConversationMode,
  conversationId: string
): ChatPersistenceResult {
  if (!scope.active || !scope.userId || typeof window === "undefined") {
    return { status: "inactive", failedConversationIds: [] };
  }
  try {
    window.localStorage.setItem(
      chatActiveConversationStorageKey(mode, scope),
      conversationId
    );
    return { status: "saved", failedConversationIds: [] };
  } catch {
    return {
      status: "failed",
      reason: "unavailable",
      failedConversationIds: [conversationId],
    };
  }
}

/** 校验旧成功快照的外层，避免损坏的一条记录阻断其他会话的保存。 */
function isStoredConversation(value: unknown): value is ChatConversation {
  if (!value || typeof value !== "object") return false;
  return (
    "id" in value &&
    typeof value.id === "string" &&
    "messages" in value &&
    Array.isArray(value.messages) &&
    "mode" in value &&
    ["chat", "agent", "web"].includes(String(value.mode)) &&
    "title" in value &&
    typeof value.title === "string" &&
    "createdAt" in value &&
    typeof value.createdAt === "string" &&
    "updatedAt" in value &&
    typeof value.updatedAt === "string"
  );
}

/** 大 data URL 在 JSON 分配前就超预算时立即停止；最终仍按转义后的实际长度计数。 */
function chatConversationStorageBytes(conversation: ChatConversation) {
  const overLimit = Symbol("chat-storage-size");
  let stringBytes = 0;
  try {
    return (
      JSON.stringify(conversation, (_key, value: unknown) => {
        if (typeof value === "string") {
          stringBytes += value.length * 2;
          if (stringBytes > CHAT_CONVERSATION_MAX_BYTES) throw overLimit;
        }
        return value;
      }).length * 2
    );
  } catch (error) {
    if (error === overLimit) return Number.POSITIVE_INFINITY;
    throw error;
  }
}

/**
 * 独立检查每个会话及整份快照大小；超限项保留上次成功快照并报告。
 * 内存中的完整会话不被裁图或替换，小会话仍能继续写入。
 */
export function persistChatConversations(
  scope: ChatStorageScope,
  conversations: ChatConversation[]
): ChatPersistenceResult {
  if (!scope.active || !scope.userId || typeof window === "undefined") {
    return { status: "inactive", failedConversationIds: [] };
  }
  try {
    const previous = readChatConversations(scope);
    if (previous.error === "unavailable") {
      return {
        status: "failed",
        reason: "unavailable",
        failedConversationIds: conversations.map((item) => item.id),
      };
    }
    const previousById = new Map(
      previous.conversations
        .filter(isStoredConversation)
        .map((item) => [item.id, item])
    );
    const stored: ChatConversation[] = [];
    const failedConversationIds: string[] = [];
    const envelope = { version: 2, userId: scope.userId, conversations: [] };
    let bytes = JSON.stringify(envelope).length * 2;
    for (const conversation of conversations.slice(
      0,
      CHAT_CONVERSATION_LIMIT
    )) {
      const candidate = {
        ...conversation,
        messages: sanitizePersistedChatMessages(conversation.messages),
      };
      let serializedBytes = chatConversationStorageBytes(candidate);
      const separatorBytes = stored.length ? 2 : 0;
      let selected: ChatConversation = candidate;
      if (
        serializedBytes > CHAT_CONVERSATION_MAX_BYTES ||
        bytes + serializedBytes + separatorBytes > CHAT_STORAGE_MAX_BYTES
      ) {
        failedConversationIds.push(conversation.id);
        const fallback = previousById.get(conversation.id);
        if (!fallback) continue;
        serializedBytes = chatConversationStorageBytes(fallback);
        if (
          serializedBytes > CHAT_CONVERSATION_MAX_BYTES ||
          bytes + serializedBytes + separatorBytes > CHAT_STORAGE_MAX_BYTES
        )
          continue;
        selected = fallback;
      }
      stored.push(selected);
      bytes += serializedBytes + separatorBytes;
    }
    window.localStorage.setItem(
      chatConversationsStorageKey(scope),
      JSON.stringify({
        version: 2,
        userId: scope.userId,
        conversations: stored,
      })
    );
    return {
      status: failedConversationIds.length ? "partial" : "saved",
      failedConversationIds,
      reason: failedConversationIds.length ? "size" : undefined,
    };
  } catch {
    return {
      status: "failed",
      reason: "unavailable",
      failedConversationIds: conversations.map((item) => item.id),
    };
  }
}

export function isMessageInConversationMode(
  message: ChatMessage,
  mode: ConversationMode
) {
  return mode === "agent"
    ? message.mode === "agent"
    : mode === "web"
      ? message.mode === "web"
      : message.mode !== "agent" && message.mode !== "web";
}

function sanitizeAgentEventsForStorage(events: AgentRunEvent[] | undefined) {
  return (events || []).map((event) => {
    const normalized = normalizeAgentEvent(event);
    if (normalized.imageUrl?.startsWith("data:image/")) {
      return { ...normalized, imageUrl: undefined };
    }
    return normalized;
  });
}

export function sanitizePersistedChatMessages(messages: ChatMessage[]) {
  return messages.slice(-80).map((message) => ({
    ...message,
    attachments: message.attachments?.filter(
      (attachment) => !attachment.previewUrl?.startsWith("blob:")
    ),
    variants: message.variants?.map((variant) => ({
      ...variant,
      agentEvents: sanitizeAgentEventsForStorage(variant.agentEvents),
    })),
  }));
}

export function inferChatConversationMode(
  messages: ChatMessage[]
): ConversationMode {
  if (messages.some((message) => message.mode === "agent")) return "agent";
  if (messages.some((message) => message.mode === "web")) return "web";
  return "chat";
}

function getChatMessageSignature(message: ChatMessage) {
  return `${message.role}\u0000${message.id}\u0000${message.text}`;
}

function isConversationSnapshotOf(
  candidate: ChatConversation,
  target: ChatConversation
) {
  if (candidate.mode !== target.mode) return false;
  if (candidate.id === target.id) return true;
  if (candidate.messages.length > target.messages.length) return false;
  return candidate.messages.every(
    (message, index) =>
      getChatMessageSignature(message) ===
      getChatMessageSignature(target.messages[index] as ChatMessage)
  );
}

export function compactChatConversations(conversations: ChatConversation[]) {
  const byCompleteness = [...conversations].sort((a, b) => {
    const messageCountDelta = b.messages.length - a.messages.length;
    if (messageCountDelta !== 0) return messageCountDelta;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
  const compacted: ChatConversation[] = [];

  for (const conversation of byCompleteness) {
    if (
      compacted.some((existing) =>
        isConversationSnapshotOf(conversation, existing)
      )
    ) {
      continue;
    }
    compacted.push(conversation);
  }

  return compacted.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export function getChatConversationTitle(
  messages: ChatMessage[],
  fallback: string
) {
  const firstUserMessage = messages.find((message) => message.role === "user");
  const title = firstUserMessage?.text.trim();
  if (!title) return fallback;
  return title.length > 48 ? `${title.slice(0, 48)}...` : title;
}

/** 生成内存快照，供去抖与立即保存共用；不按存储预算删减图片。 */
export function buildChatConversationSnapshot(params: {
  conversations: ChatConversation[];
  conversationId: string;
  mode: ConversationMode;
  messages: ChatMessage[];
  titleFallback: string;
}) {
  if (params.messages.length === 0) return params.conversations;
  const persistedMessages = sanitizePersistedChatMessages(params.messages);
  const title = getChatConversationTitle(
    persistedMessages.filter((message) =>
      isMessageInConversationMode(message, params.mode)
    ),
    params.titleFallback
  );
  const now = new Date().toISOString();
  const existing = params.conversations.find(
    (conversation) => conversation.id === params.conversationId
  );
  const current: ChatConversation = {
    id: params.conversationId,
    mode: existing?.mode || params.mode,
    title,
    messages: persistedMessages,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  const nextConversations = compactChatConversations([
    current,
    ...params.conversations.filter(
      (conversation) => conversation.id !== params.conversationId
    ),
  ]).slice(0, CHAT_CONVERSATION_LIMIT);
  return nextConversations;
}

/** 保存单个会话快照；所有写入口必须携带不可跨账号复用的 scope。 */
export function persistChatConversationSnapshot(
  params: Parameters<typeof buildChatConversationSnapshot>[0] & {
    scope: ChatStorageScope;
  }
): ChatPersistenceResult {
  if (
    !params.scope.active ||
    !params.scope.userId ||
    params.messages.length === 0
  ) {
    return { status: "inactive", failedConversationIds: [] };
  }
  const result = persistChatConversations(
    params.scope,
    buildChatConversationSnapshot(params)
  );
  if (result.status !== "saved" && result.status !== "partial") return result;
  const activeResult = persistActiveChatConversation(
    params.scope,
    params.mode,
    params.conversationId
  );
  return activeResult.status === "failed" ? activeResult : result;
}
