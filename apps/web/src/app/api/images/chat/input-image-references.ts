/** 站内 chat 与 PPT/PSD 的附件确认薄适配；复用既有上传、签名与套餐大小限制。 */
import { randomUUID } from "node:crypto";
import { buildSignedStorageImageUrl } from "@repo/shared/storage/signed-url";
import type { ChatSourceImageReferences } from "@/features/image-generation/components/chat-input-images";
import { decodeBase64DataUrl } from "@/features/image-generation/editable-file-util";
import {
  getTotalUploadSize,
  uploadTemporaryImageUrls,
  validateImageFile,
} from "@/features/image-generation/request-utils";
import type { ChatHistoryMessage } from "@/features/image-generation/types";

export type SourceImageMetadata = {
  messageId: string;
  attachmentIds: string[];
};
export type InputImageLimits = {
  maxFileSizeBytes: number;
  maxUploadBytes: number;
};

/** 传输错误保留 413，且验证阶段不能产生存储或生成副作用。 */
export class InputImageReferenceError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

/** 标识只能关联本次提交的图片；重复 ID 或错位批次不能回填到其他附件。 */
export function parseSourceImageMetadata(
  value: unknown,
  count: number
): SourceImageMetadata | undefined {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== "object" ||
    !("messageId" in value) ||
    typeof value.messageId !== "string" ||
    !value.messageId.trim() ||
    value.messageId.length > 128 ||
    !("attachmentIds" in value) ||
    !Array.isArray(value.attachmentIds) ||
    value.attachmentIds.length !== count ||
    value.attachmentIds.some(
      (id: unknown) => typeof id !== "string" || !id.trim() || id.length > 128
    ) ||
    new Set(value.attachmentIds).size !== count
  ) {
    throw new InputImageReferenceError(
      "Source image attachment IDs must uniquely match the uploaded images."
    );
  }
  return {
    messageId: value.messageId,
    attachmentIds: value.attachmentIds as string[],
  };
}

/** 在解码分配前检查 base64 字节上界；历史图只接受可处理的图片格式。 */
export function inputImageDataToFile(
  value: string,
  index: number,
  maxBytes: number
) {
  const match = value.match(
    /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/
  );
  const encoded = match?.[2] ?? (!value.startsWith("data:") ? value : "");
  if (
    !encoded ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
  ) {
    throw new InputImageReferenceError(
      "Reference images must be PNG, JPEG, or WebP base64 images."
    );
  }
  const size =
    (encoded.length / 4) * 3 -
    (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
  if (size > maxBytes)
    throw new InputImageReferenceError(
      "Reference image exceeds the upload limit.",
      413
    );
  const image = decodeBase64DataUrl(value, index);
  const file = new File([new Uint8Array(image.data)], image.name, {
    type: image.type,
  });
  validateImageFile(file, { maxImageBytes: maxBytes });
  return file;
}

/** 复用请求图片存储；仅在全批上传确认后返回 owner 可续签的站内引用。 */
export async function confirmSourceImageFiles(
  userId: string,
  files: File[],
  metadata: SourceImageMetadata | undefined,
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  if (!metadata || !files.length) return undefined;
  const uploaded = await uploadTemporaryImageUrls(userId, randomUUID(), files, {
    scope: "requests",
    ...(signal ? { signal } : {}),
  });
  signal?.throwIfAborted();
  if (!uploaded || uploaded.length !== files.length) return undefined;
  const images: ChatSourceImageReferences["images"] = [];
  for (const [index, image] of uploaded.entries()) {
    const attachmentId = metadata.attachmentIds[index];
    const url = buildSignedStorageImageUrl(image.key, image.bucket);
    if (!attachmentId || !url) return undefined;
    images.push({ attachmentId, url });
  }
  return { messageId: metadata.messageId, images };
}

/** 先验证所有旧图与合并上传预算；只处理本轮实际上下文，不扫描其他会话或迁移存储。 */
export function prepareHistorySourceImages(
  history: ChatHistoryMessage[],
  limits: InputImageLimits,
  currentUploadBytes: number
) {
  let total = currentUploadBytes;
  const seen = new Set<string>();
  return history.map((message) => {
    const urls = message.imageUrls || [];
    const metadata = parseSourceImageMetadata(
      "sourceImageMetadata" in message
        ? message.sourceImageMetadata
        : undefined,
      urls.length
    );
    if (metadata && (message.role !== "user" || seen.has(metadata.messageId)))
      throw new InputImageReferenceError(
        "History source message IDs must be unique user messages."
      );
    if (metadata) seen.add(metadata.messageId);
    const files: File[] = [];
    const indexes: number[] = [];
    const attachmentIds: string[] = [];
    for (const [index, url] of urls.entries()) {
      if (!url.startsWith("data:")) continue;
      const file = inputImageDataToFile(url, index, limits.maxFileSizeBytes);
      total += file.size;
      if (total > limits.maxUploadBytes)
        throw new InputImageReferenceError(
          "Total upload size exceeds the upload limit.",
          413
        );
      // 没有稳定 ID 的旧客户端仍可生成，但不能猜测并持久化其附件归属。
      if (!metadata) continue;
      files.push(file);
      indexes.push(index);
      attachmentIds.push(metadata.attachmentIds[index] as string);
    }
    return {
      message,
      files,
      indexes,
      metadata: metadata
        ? { messageId: metadata.messageId, attachmentIds }
        : undefined,
    };
  });
}

/** 每条消息独立确认；失败保留原 data URL，成功引用同时用于当前生成与下一轮。 */
export async function confirmHistorySourceImages(
  userId: string,
  pending: ReturnType<typeof prepareHistorySourceImages>,
  signal?: AbortSignal
) {
  const references: ChatSourceImageReferences[] = [];
  const history: ChatHistoryMessage[] = [];
  for (const item of pending) {
    signal?.throwIfAborted();
    const reference = await confirmSourceImageFiles(
      userId,
      item.files,
      item.metadata,
      signal
    );
    signal?.throwIfAborted();
    // 客户端标识只供薄适配回填，不进入生成管线。
    const { sourceImageMetadata: _metadata, ...message } =
      item.message as ChatHistoryMessage & { sourceImageMetadata?: unknown };
    if (reference) {
      references.push(reference);
      const imageUrls = [...(message.imageUrls || [])];
      for (const [index, image] of reference.images.entries())
        imageUrls[item.indexes[index] as number] = image.url;
      history.push({ ...message, imageUrls });
    } else history.push(message);
  }
  return { history, references };
}

/** 按同一套餐预算检查 multipart 图，供独立文件适配使用。 */
export function validateSourceImageFiles(
  files: File[],
  limits: InputImageLimits
) {
  if (getTotalUploadSize(files) > limits.maxUploadBytes)
    throw new InputImageReferenceError(
      "Total upload size exceeds the upload limit.",
      413
    );
  for (const file of files) {
    if (file.size > limits.maxFileSizeBytes)
      throw new InputImageReferenceError(
        "Reference image exceeds the upload limit.",
        413
      );
    validateImageFile(file, { maxImageBytes: limits.maxFileSizeBytes });
  }
}
