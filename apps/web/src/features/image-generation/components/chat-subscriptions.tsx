"use client";

/**
 * 聊天高频状态的叶子订阅组件(性能隔离层)。
 *
 * 职责:把流式期间逐帧变化的 chatMessages/chatStream 消费方从 1 万行的
 * create-page-client 父组件下沉到本文件的小组件里,使父组件在生成期间
 * 不再随每个流式帧全量重渲。
 *
 * 包含:
 * - ChatPersistenceAgent:去抖持久化 + 卸载冲刷(空渲染,纯副作用)。
 * - ChatMessageList:消息流渲染(订阅 chatMessages 与 chatStream.messageId)。
 * - ChatPanelStreamGate:面板级无消息 id 的流式占位门控。
 *
 * 约束:父组件传入的所有函数 prop 必须是 useCallback 固定引用,否则隔离失效。
 */

import type { MutableRefObject, ReactNode, SetStateAction } from "react";
import { useEffect, useRef } from "react";
import { useCreateRuntimeState } from "@/features/image-generation/create-runtime-store";
import type {
  ChatConversation,
  ChatMessage,
  ConversationMode,
} from "./chat-message-types";
import {
  CHAT_CONVERSATION_LIMIT,
  CHAT_CONVERSATIONS_STORAGE_KEY,
  CHAT_PERSIST_DEBOUNCE_MS,
  CHAT_STORAGE_KEY,
  chatActiveConversationStorageKey,
  compactChatConversations,
  getChatConversationTitle,
  inferChatConversationMode,
  isMessageInConversationMode,
  sanitizePersistedChatMessages,
} from "./chat-persistence";
import type { ChatStreamState } from "./chat-stream-state";

/**
 * 去抖持久化副作用组件。
 *
 * 每次 chatMessages 变化重置 300ms 尾沿定时器,静默期到达才 sanitize +
 * 推导标题 + JSON.stringify 全部会话并写 localStorage(成本随会话数线性
 * 增长,不能逐帧同步执行);卸载/beforeunload 经 pendingRef 冲刷末轮。
 * 渲染恒为 null,不产生 DOM。
 */
export function ChatPersistenceAgent({
  chatConversationId,
  isZh,
  didLoadChatRef,
  chatMessagesConversationIdRef,
  chatMessagesModeRef,
  chatConversationsRef,
  setChatConversations,
}: {
  chatConversationId: string;
  isZh: boolean;
  didLoadChatRef: MutableRefObject<boolean>;
  chatMessagesConversationIdRef: MutableRefObject<string | null>;
  chatMessagesModeRef: MutableRefObject<ConversationMode | null>;
  chatConversationsRef: MutableRefObject<ChatConversation[]>;
  setChatConversations: (next: SetStateAction<ChatConversation[]>) => void;
}) {
  const [chatMessages] = useCreateRuntimeState<ChatMessage[]>(
    "chatMessages",
    []
  );
  const pendingPersistRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!didLoadChatRef.current) return;
    const persist = () => {
      pendingPersistRef.current = null;
      try {
        if (
          chatMessages.length > 0 &&
          chatMessagesConversationIdRef.current &&
          (chatMessagesConversationIdRef.current !== chatConversationId ||
            (chatMessagesModeRef.current &&
              chatMessagesModeRef.current !==
                inferChatConversationMode(chatMessages)))
        ) {
          return;
        }
        if (chatMessages.length === 0) {
          window.localStorage.removeItem(CHAT_STORAGE_KEY);
          return;
        }
        const persistedMessages = sanitizePersistedChatMessages(chatMessages);
        const conversationMode = inferChatConversationMode(persistedMessages);
        chatMessagesConversationIdRef.current = chatConversationId;
        chatMessagesModeRef.current = conversationMode;
        const title = getChatConversationTitle(
          persistedMessages.filter((message) =>
            isMessageInConversationMode(message, conversationMode)
          ),
          isZh ? "未命名对话" : "Untitled chat"
        );
        const now = new Date().toISOString();
        const previousConversations = chatConversationsRef.current;
        const existing = previousConversations.find(
          (conversation) => conversation.id === chatConversationId
        );
        const current: ChatConversation = {
          id: chatConversationId,
          mode: existing?.mode || conversationMode,
          title,
          messages: persistedMessages,
          createdAt: existing?.createdAt || now,
          updatedAt: now,
        };
        const nextConversations = compactChatConversations([
          current,
          ...previousConversations.filter(
            (conversation) => conversation.id !== chatConversationId
          ),
        ]).slice(0, CHAT_CONVERSATION_LIMIT);
        chatConversationsRef.current = nextConversations;
        setChatConversations(nextConversations);
        window.localStorage.setItem(
          CHAT_CONVERSATIONS_STORAGE_KEY,
          JSON.stringify(nextConversations)
        );
        window.localStorage.setItem(
          chatActiveConversationStorageKey(current.mode),
          chatConversationId
        );
        window.localStorage.removeItem(CHAT_STORAGE_KEY);
      } catch {
        /* ignore local storage quota errors */
      }
    };
    pendingPersistRef.current = persist;
    const timer = window.setTimeout(persist, CHAT_PERSIST_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [
    chatConversationId,
    chatMessages,
    chatConversationsRef,
    chatMessagesConversationIdRef,
    chatMessagesModeRef,
    didLoadChatRef,
    isZh,
    setChatConversations,
  ]);

  // 关页/组件卸载时冲刷去抖窗口内尚未落库的会话变更。
  useEffect(() => {
    const flushPendingChatPersist = () => {
      pendingPersistRef.current?.();
    };
    window.addEventListener("beforeunload", flushPendingChatPersist);
    return () => {
      window.removeEventListener("beforeunload", flushPendingChatPersist);
      flushPendingChatPersist();
    };
  }, []);

  return null;
}

/**
 * 聊天消息列表(叶子订阅组件)。
 *
 * 职责:订阅 chatMessages(流式期间逐帧变化)与 chatStream.messageId,把
 * 消息流的渲染隔离在本文内;父组件 create-page-client 不再订阅这两个 key,
 * 生成期间不再随流式帧全量重渲。
 *
 * 使用方:create-page-client 的 chat 面板(children 注入消息卡片渲染)。
 * 约束:children 与各 prop 必须是稳定引用(useCallback/useMemo 固定)。
 */

export function ChatMessageList({
  activeConversationMode,
  isConversationModeMatch,
  renderList,
}: {
  activeConversationMode: "chat" | "agent" | "web";
  isConversationModeMatch: (
    message: ChatMessage,
    mode: "chat" | "agent" | "web"
  ) => boolean;
  renderList: (
    visibleChatMessages: ChatMessage[],
    chatStreamMessageId: string | undefined
  ) => ReactNode;
}) {
  const [chatMessages] = useCreateRuntimeState<ChatMessage[]>(
    "chatMessages",
    []
  );
  const [chatStream] = useCreateRuntimeState<ChatStreamState | null>(
    "chatStream",
    null
  );
  const visibleChatMessages = chatMessages.filter((message) =>
    isConversationModeMatch(message, activeConversationMode)
  );
  return <>{renderList(visibleChatMessages, chatStream?.messageId)}</>;
}

/**
 * 面板级流式占位门控(叶子订阅组件)。
 *
 * 职责:chat 面板底部"无消息 id 的流式气泡"(瀑布流前置请求/无 messageId
 * 流)的显示条件判定。原逻辑内联在父组件,依赖 chatStream 逐帧订阅;下沉后
 * 父组件不再订阅 chatStream。renderBubble 须为稳定引用。
 */

export function ChatPanelStreamGate({
  activeConversationMode,
  renderBubble,
  retryingChatMessageId,
}: {
  activeConversationMode: "chat" | "agent" | "web";
  renderBubble: (messageId?: string) => ReactNode;
  retryingChatMessageId: string | null;
}) {
  const [chatStream] = useCreateRuntimeState<ChatStreamState | null>(
    "chatStream",
    null
  );
  if (!chatStream || retryingChatMessageId || chatStream.messageId) {
    return null;
  }
  if (chatStream.mode !== activeConversationMode) return null;
  return (
    <div className="flex justify-start">
      <div className="max-w-[88%]">{renderBubble(undefined)}</div>
    </div>
  );
}
