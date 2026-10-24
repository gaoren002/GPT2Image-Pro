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

import type {
  Dispatch,
  MutableRefObject,
  ReactNode,
  SetStateAction,
} from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import {
  useCreateRuntimeAccessor,
  useCreateRuntimeRef,
  useCreateRuntimeState,
  useResetCreateRuntimeKeys,
} from "@/features/image-generation/create-runtime-store";
import type {
  ChatConversation,
  ChatMessage,
  ConversationMode,
} from "./chat-message-types";
import {
  beginChatStorageScope,
  buildChatConversationSnapshot,
  CHAT_PERSIST_DEBOUNCE_MS,
  CHAT_STORAGE_SCOPE_REVOKED_EVENT,
  type ChatPersistenceResult,
  type ChatStorageScope,
  inferChatConversationMode,
  persistChatConversationSnapshot,
} from "./chat-persistence";
import type { ChatStreamState } from "./chat-stream-state";

const CHAT_ACCOUNT_RUNTIME_KEYS = [
  "chatConversationId",
  "chatConversations",
  "chatMessages",
  "chatAttachments",
  "chatPrompt",
  "chatPromptHasText",
  "chatPromptHasRef",
  "chatMention",
  "chatStream",
  "retryingChatMessageId",
  "isChatGenerating",
  "chatConversationsRef",
  "didLoadChatRef",
  "chatMessagesConversationIdRef",
  "chatMessagesModeRef",
  "activeChatRequestGenerationIdsRef",
];

/**
 * 会话确认前不挂载消息消费者。账号变化先撤销旧回调、清除旧账号内存,
 * 再挂载新账号；同账号软导航保留原 runtime store 和正在执行的回合。
 */
export function ChatAccountBoundary({
  renderAccount,
}: {
  renderAccount: (scope: ChatStorageScope) => ReactNode;
}) {
  // 侧栏已有 SSR 初值和回前台校验；复用同一身份，不再额外请求会话接口。
  const [userId] = useCreateRuntimeState<string | null | undefined>(
    "chatAccountUserId",
    undefined
  );
  const scopeRef = useCreateRuntimeRef<ChatStorageScope | null>(
    "chatStorageScopeRef",
    null
  );
  const resetKeys = useResetCreateRuntimeKeys();
  const [ready, setReady] = useState<ChatStorageScope | null>(null);

  // 在子树卸载清理之前撤销，避免旧 unmount flush 写入或复活旧消息。
  if (
    userId !== undefined &&
    scopeRef.current?.userId !== userId &&
    scopeRef.current
  ) {
    scopeRef.current.active = false;
  }

  useLayoutEffect(() => {
    if (userId === undefined) return;
    if (scopeRef.current && scopeRef.current.userId === userId) {
      setReady(scopeRef.current.active ? scopeRef.current : null);
      return;
    }
    resetKeys(CHAT_ACCOUNT_RUNTIME_KEYS);
    scopeRef.current = userId ? beginChatStorageScope(userId) : null;
    setReady(scopeRef.current);
  }, [userId, resetKeys, scopeRef]);

  useEffect(() => {
    const hideRevokedAccount = () => {
      if (scopeRef.current?.active) return;
      resetKeys(CHAT_ACCOUNT_RUNTIME_KEYS);
      setReady(null);
    };
    window.addEventListener(
      CHAT_STORAGE_SCOPE_REVOKED_EVENT,
      hideRevokedAccount
    );
    return () =>
      window.removeEventListener(
        CHAT_STORAGE_SCOPE_REVOKED_EVENT,
        hideRevokedAccount
      );
  }, [resetKeys, scopeRef]);

  return ready?.active && ready.userId === userId ? renderAccount(ready) : null;
}

/** 旧异步请求的 setter 即使晚返回，也不能写进下一账号的共享 runtime。 */
export function useChatScopeSetter<T>(
  scope: ChatStorageScope,
  setter: Dispatch<SetStateAction<T>>
) {
  return useCallback(
    (next: SetStateAction<T>) => {
      if (scope.active) setter(next);
    },
    [scope, setter]
  );
}

/** 用固定通知 id 合并去抖期间的重复失败；不输出消息正文或附件内容。 */
export function reportChatPersistenceResult(
  result: ChatPersistenceResult,
  isZh: boolean,
  messages: ChatMessage[] = []
) {
  if (result.status !== "failed" && result.status !== "partial") return;
  // 上传确认会把大 data URL 换成小引用；仅延迟这段窗口内的容量提示。
  // 上传/生成失败定稿后仍会报告，浏览器拒绝存储等实际写入失败始终立即报告。
  if (
    result.reason === "size" &&
    messages.at(-1)?.variants?.some((variant) => variant.pending) &&
    messages.some((message) =>
      message.attachments?.some((attachment) =>
        attachment.previewUrl?.startsWith("data:image/")
      )
    )
  )
    return;
  toast.error(
    result.reason === "size"
      ? isZh
        ? "部分对话超过本地保存容量，完整内容仅保留在当前页面；刷新后会恢复上次保存的记录。其他对话可继续保存。"
        : "Some chats exceed local storage limits. Full content remains on this page; reloading restores the last saved version. Other chats can still be saved."
      : isZh
        ? "对话未能保存到本机，当前页面内容仍在；刷新或关闭页面可能丢失本次更改。"
        : "Chat could not be saved locally. Content remains on this page; reloading or closing it may lose recent changes.",
    { id: "chat-persistence-failure" }
  );
}

/** 去抖保存和卸载冲刷共用带归属的快照；失败仍保留完整内存消息。 */
export function ChatPersistenceAgent({
  scope,
  chatConversationId,
  isZh,
  didLoadChatRef,
  chatMessagesConversationIdRef,
  chatMessagesModeRef,
  chatConversationsRef,
  setChatConversations,
}: {
  scope: ChatStorageScope;
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
  const [getChatMessages] = useCreateRuntimeAccessor<ChatMessage[]>(
    "chatMessages",
    []
  );
  const pendingPersistRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!didLoadChatRef.current || !scope.active) return;
    const persist = () => {
      pendingPersistRef.current = null;
      if (!scope.active) return;
      // 上传确认可能与关页发生在同一事件内，effect 闭包尚未重建；只冲刷最新 store。
      const messages = getChatMessages();
      if (!messages.length) return;
      if (
        chatMessagesConversationIdRef.current &&
        (chatMessagesConversationIdRef.current !== chatConversationId ||
          (chatMessagesModeRef.current &&
            chatMessagesModeRef.current !==
              inferChatConversationMode(messages)))
      )
        return;
      const conversationMode = inferChatConversationMode(messages);
      const params = {
        scope,
        conversations: chatConversationsRef.current,
        conversationId: chatConversationId,
        mode: conversationMode,
        messages,
        titleFallback: isZh ? "未命名对话" : "Untitled chat",
      };
      chatMessagesConversationIdRef.current = chatConversationId;
      chatMessagesModeRef.current = conversationMode;
      const nextConversations = buildChatConversationSnapshot(params);
      chatConversationsRef.current = nextConversations;
      setChatConversations(nextConversations);
      reportChatPersistenceResult(
        persistChatConversationSnapshot(params),
        isZh,
        messages
      );
    };
    pendingPersistRef.current = persist;
    const timer = window.setTimeout(persist, CHAT_PERSIST_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [
    scope,
    chatConversationId,
    chatMessages,
    getChatMessages,
    chatConversationsRef,
    chatMessagesConversationIdRef,
    chatMessagesModeRef,
    didLoadChatRef,
    isZh,
    setChatConversations,
  ]);

  useEffect(() => {
    const flush = () => pendingPersistRef.current?.();
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
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
