/** 聊天输入图客户端工具：消息参考图筛选、上传确认与重试上下文；只依赖客户端安全模块。 */
import { parseStorageImageUrl } from "@repo/shared/storage/image-url";
import type { ChatMessage } from "./chat-message-types";
import {
  type ChatConversationUpdateContext,
  type ChatStorageScope,
  updateChatConversationMessage,
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

/** 历史图片与稳定附件 ID 使用同一筛选；仅旧 data URL 需要服务器回传确认。 */
export function getChatHistoryImageInput(message: ChatMessage) {
  if (message.role !== "user") return { imageUrls: [] as string[] };
  const images = (message.attachments || []).filter(
    (attachment) =>
      attachment.kind !== "file" &&
      getMessageImageUrls({ ...message, attachments: [attachment] }).length > 0
  );
  const imageUrls = images.map((attachment) => attachment.previewUrl as string);
  return {
    imageUrls,
    sourceImageMetadata: imageUrls.some((url) => url.startsWith("data:image/"))
      ? {
          messageId: message.id,
          attachmentIds: images.map((attachment) => attachment.id),
        }
      : undefined,
  };
}

/** PPT/PSD 使用二进制 multipart；同一图片不再在客户端另编码一份 base64 JSON。 */
export function buildEditableFileRequest(params: {
  kind: "ppt" | "psd";
  prompt: string;
  messageId: string;
  images: Array<{ attachmentId: string; file: File }>;
}) {
  const form = new FormData();
  form.set("taskId", params.messageId);
  form.set("kind", params.kind);
  form.set("prompt", params.prompt);
  form.set("chatRound", "true");
  form.set("source_image_message_id", params.messageId);
  form.set(
    "source_image_attachment_ids",
    JSON.stringify(params.images.map((image) => image.attachmentId))
  );
  for (const image of params.images) form.append("image", image.file);
  return form;
}

/** 保活 JSON 在最终结果与错误里均可携带确认；先回填再由页面处理业务成功/失败。 */
export async function readEditableFileResponse(
  response: Response,
  receive: (payload: unknown) => void
): Promise<{
  error?: { message?: string } | string;
  result?: { primary_url?: string; zip_url?: string | null };
  credits_charged?: number;
}> {
  const text = await response.text();
  const start = text.indexOf("{");
  if (start < 0) throw new Error("空响应");
  const data = JSON.parse(text.slice(start));
  receive(data);
  return data;
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
    (!("sourceImageReferences" in payload) &&
      !("historySourceImageReferences" in payload))
  )
    return null;
  const history =
    "historySourceImageReferences" in payload &&
    Array.isArray(payload.historySourceImageReferences)
      ? payload.historySourceImageReferences.filter(
          (item: unknown) =>
            item &&
            typeof item === "object" &&
            "messageId" in item &&
            item.messageId === messageId
        )
      : [];
  if (history.length > 1) return null;
  const source =
    "sourceImageReferences" in payload
      ? payload.sourceImageReferences
      : undefined;
  const value =
    source &&
    typeof source === "object" &&
    "messageId" in source &&
    source.messageId === messageId
      ? source
      : history[0];
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

/**
 * 接收 JSON 成功/失败结果及 SSE 确认，立即将已上传图片引用写回消息和快照。
 * 账号撤销后无副作用；上传无确认则保留 data URL；本机保存失败仍保留可用引用。
 * 导航期间可更新原会话列表，但不能把旧消息写入其他当前会话或改其活跃指针。
 */
export function createChatSourceImageReceiver(
  params: ChatConversationUpdateContext & {
    messageId: string;
    attachmentIds: string[];
  }
) {
  return (payload: unknown) => {
    if (!params.scope.active) return;
    const urls = sourceImageUrlsById(
      payload,
      params.scope,
      params.messageId,
      params.attachmentIds
    );
    if (!urls) return;
    updateChatConversationMessage({
      ...params,
      update: (message) => {
        if (message.role !== "user") return message;
        let changed = false;
        const attachments = message.attachments?.map((attachment) => {
          const url = urls.get(attachment.id);
          if (
            !url ||
            attachment.kind === "file" ||
            attachment.previewUrl === url
          )
            return attachment;
          changed = true;
          return { ...attachment, previewUrl: url };
        });
        return changed ? { ...message, attachments } : message;
      },
    });
  };
}
