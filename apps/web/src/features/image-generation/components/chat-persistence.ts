/**
 * 聊天会话 localStorage 持久化(纯函数,DB-free)。
 *
 * 职责:sanitize / 会话压缩 / 标题推导 / 快照写入等纯逻辑,此前内联在
 * create-page-client;聊天叶子组件(chat-subscriptions)拆出后抽到本模块,
 * create-page-client 与叶子组件共用同一份实现,持久化语义不变。
 *
 * 存储 key 与上限:与历史版本保持一致(v1 后缀),localStorage 里的旧数据
 * 无需迁移。
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
/**
 * 会话持久化去抖窗口(毫秒)。流式生成期 chatMessages 每个增量都变,
 * 若每次都同步 JSON.stringify 全部会话并写 localStorage 会逐 token 阻塞
 * 主线程;取尾沿去抖,回合结束或停顿时才真正落库。
 */
export const CHAT_PERSIST_DEBOUNCE_MS = 300;

export function chatActiveConversationStorageKey(mode: ConversationMode) {
  return mode === "agent"
    ? CHAT_ACTIVE_AGENT_CONVERSATION_STORAGE_KEY
    : CHAT_ACTIVE_CONVERSATION_STORAGE_KEY;
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

export function persistChatConversationSnapshot(params: {
  conversations: ChatConversation[];
  conversationId: string;
  mode: ConversationMode;
  messages: ChatMessage[];
  titleFallback: string;
}) {
  if (typeof window === "undefined" || params.messages.length === 0) return;
  try {
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
    window.localStorage.setItem(
      CHAT_CONVERSATIONS_STORAGE_KEY,
      JSON.stringify(nextConversations)
    );
    window.localStorage.setItem(
      chatActiveConversationStorageKey(current.mode),
      params.conversationId
    );
    window.localStorage.removeItem(CHAT_STORAGE_KEY);
  } catch {
    /* ignore local storage quota errors */
  }
}
