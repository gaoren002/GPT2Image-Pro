/** 聊天输入图客户端工具：消息参考图筛选、上传确认与重试上下文；只依赖客户端安全模块。 */
import { parseStorageImageUrl } from "@repo/shared/storage/image-url";
import type {
  ChatConversation,
  ChatMessage,
  ConversationMode,
} from "./chat-message-types";
import {
  buildChatConversationSnapshot,
  type ChatPersistenceResult,
  type ChatStorageScope,
  persistChatConversations,
} from "./chat-persistence";

export type ChatSourceImageReferences = {
  messageId: string;
  images: Array<{ attachmentId: string; url: string }>;
};

/** 生成 history 及重试上下文时接受受控相对 URL；未确认上传仍保留原 data URL。 */
export function getMessageImageUrls(message: ChatMessage) {
  const urls: string[] = [];
  for (const attachment of message.attachments || []) {
    const url = attachment.previewUrl;
    if (
      url &&
      (url.startsWith("data:image/") ||
        (url.startsWith("/api/storage/") && parseStorageImageUrl(url)) ||
        url.startsWith("http://") ||
        url.startsWith("https://"))
    ) {
      urls.push(url);
    }
  }
  return urls;
}

/** 重试当前 prompt 时仍携带原参考图，避免把原 prompt 再当作一轮历史文本。 */
export function buildChatRetryHistory(
  messages: ChatMessage[],
  userMessageId: string
) {
  const index = messages.findIndex(
    (message) => message.id === userMessageId && message.role === "user"
  );
  if (index < 0) return [];
  const user = messages[index];
  const previous = messages.slice(0, index);
  return user && getMessageImageUrls(user).length
    ? [...previous, { ...user, text: "" }]
    : previous;
}

/** 验证整个确认批次，不能因响应顺序变化、重复 ID 或错误归属而替错附件。 */
function sourceImageUrlsById(
  payload: unknown,
  scope: ChatStorageScope,
  messageId: string,
  attachmentIds: string[]
) {
  if (
    !payload ||
    typeof payload !== "object" ||
    !("sourceImageReferences" in payload)
  )
    return null;
  const value = payload.sourceImageReferences;
  if (
    !value ||
    typeof value !== "object" ||
    !("messageId" in value) ||
    value.messageId !== messageId ||
    !("images" in value) ||
    !Array.isArray(value.images) ||
    value.images.length !== attachmentIds.length ||
    !attachmentIds.length ||
    new Set(attachmentIds).size !== attachmentIds.length
  )
    return null;
  const expectedIds = new Set(attachmentIds);
  const urls = new Map<string, string>();
  for (const image of value.images) {
    if (
      !image ||
      typeof image !== "object" ||
      !("attachmentId" in image) ||
      typeof image.attachmentId !== "string" ||
      !expectedIds.has(image.attachmentId) ||
      urls.has(image.attachmentId) ||
      !("url" in image) ||
      typeof image.url !== "string" ||
      !image.url.startsWith("/api/storage/")
    )
      return null;
    const reference = parseStorageImageUrl(image.url);
    if (!reference?.key.startsWith(`${scope.userId}/`)) return null;
    urls.set(image.attachmentId, image.url);
  }
  return urls;
}

/** 仅替换目标 userMessage 的对应图片；重复事件不复制消息或触发重复写盘。 */
function replaceSourceImageUrls(
  messages: ChatMessage[],
  messageId: string,
  urls: Map<string, string>
) {
  let changed = false;
  const next = messages.map((message) => {
    if (message.id !== messageId || message.role !== "user") return message;
    const attachments = message.attachments?.map((attachment) => {
      const url = urls.get(attachment.id);
      if (!url || attachment.kind === "file" || attachment.previewUrl === url)
        return attachment;
      changed = true;
      return { ...attachment, previewUrl: url };
    });
    return changed ? { ...message, attachments } : message;
  });
  return changed ? next : messages;
}

/**
 * 接收 JSON 成功/失败结果及 SSE 确认，立即将已上传图片引用写回消息和快照。
 * 账号撤销后无副作用；上传无确认则保留 data URL；本机保存失败仍保留可用引用。
 * 导航期间可更新原会话列表，但不能把旧消息写入其他当前会话或改其活跃指针。
 */
export function createChatSourceImageReceiver(params: {
  scope: ChatStorageScope;
  conversationId: string;
  mode: ConversationMode;
  messageId: string;
  attachmentIds: string[];
  getMessages: () => ChatMessage[];
  setMessages: (messages: ChatMessage[]) => void;
  conversationsRef: { current: ChatConversation[] };
  setConversations: (conversations: ChatConversation[]) => void;
  titleFallback: string;
  onPersistenceResult: (result: ChatPersistenceResult) => void;
}) {
  return (payload: unknown) => {
    if (!params.scope.active) return;
    const urls = sourceImageUrlsById(
      payload,
      params.scope,
      params.messageId,
      params.attachmentIds
    );
    if (!urls) return;
    const current = params.getMessages();
    const conversation = params.conversationsRef.current.find(
      (item) => item.id === params.conversationId
    );
    const source = current.some(
      (message) => message.id === params.messageId && message.role === "user"
    )
      ? current
      : conversation?.messages;
    if (!source) return;
    const messages = replaceSourceImageUrls(source, params.messageId, urls);
    if (messages === source) return;
    if (source === current) params.setMessages(messages);
    const conversations = buildChatConversationSnapshot({
      conversations: params.conversationsRef.current,
      conversationId: params.conversationId,
      mode: params.mode,
      messages,
      titleFallback: params.titleFallback,
    });
    params.conversationsRef.current = conversations;
    params.setConversations(conversations);
    params.onPersistenceResult(
      persistChatConversations(params.scope, conversations)
    );
  };
}
