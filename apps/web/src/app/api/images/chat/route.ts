import { randomUUID } from "node:crypto";
import { withApiLogging } from "@repo/shared/api-logger";
import { auth } from "@repo/shared/auth";
import { buildPublicImageUrl } from "@repo/shared/storage/signed-url";
import {
  canUsePlanCapability,
  getPlanLimits,
} from "@repo/shared/subscription/services/plan-capabilities";
import { getPlanUploadLimits } from "@repo/shared/subscription/services/upload-limits";
import { getUserPlan } from "@repo/shared/subscription/services/user-plan";
import { type NextRequest, NextResponse } from "next/server";
import {
  firstBatchError,
  runBatchImageGeneration,
} from "@/features/image-generation/batch-runner";
import { runImageGenerationForUser } from "@/features/image-generation/operations";
import { isFireflyModel } from "@/features/image-generation/resolution";
import {
  normalizeImageBackground,
  normalizeOutputCompression,
  normalizeOutputFormat,
  VALID_IMAGE_BACKGROUNDS,
  VALID_OUTPUT_FORMATS,
} from "@/features/image-generation/output-format";
import {
  filesToImageInputs,
  formatMegabytes,
  getTotalUploadSize,
  uploadTemporaryImageUrls,
  validateImageFile,
} from "@/features/image-generation/request-utils";
import {
  alignImageSizeToStep,
  DEFAULT_IMAGE_SIZE,
  IMAGE_PROMPT_MAX_CHARACTERS,
  IMAGE_PROMPT_TOO_LONG_MESSAGE,
  validateImageSize,
} from "@/features/image-generation/resolution";
import { createImageStreamResponse } from "@/features/image-generation/streaming";
import type {
  ChatHistoryMessage,
  ImageBackground,
  ImageModeration,
  ImageOutputFormat,
  ImageQuality,
  ResponsesInputFile,
  StickyBackendMemberState,
  ThinkingLevel,
} from "@/features/image-generation/types";

const VALID_QUALITIES = new Set<ImageQuality>([
  "auto",
  "low",
  "medium",
  "high",
  // gpt-image-2.5（sunburst/flare）新增档位。
  "xhigh",
  "max",
]);
const VALID_MODERATION = new Set<ImageModeration>(["auto", "low"]);
const VALID_THINKING = new Set<ThinkingLevel>([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
]);
const MAX_CHAT_FILE_CONTEXT_CHARS = 24_000;
const PROMPT_IMAGE_REFERENCE_PATTERN = /@(?:第)?\d+轮图\d+|@图\d+/;
const PDF_MIME_TYPES = new Set(["application/pdf"]);
const CHAT_FILE_ACCEPT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".log",
  ".xml",
  ".html",
  ".htm",
  ".css",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
  ".java",
  ".go",
  ".rs",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".sql",
  ".sh",
  ".toml",
  ".ini",
  ".env",
  ".pdf",
]);
const CHAT_FILE_ACCEPT_TYPES = new Set([
  "application/pdf",
  "application/json",
  "application/jsonl",
  "application/ld+json",
  "application/xml",
  "application/x-yaml",
  "application/yaml",
  "text/csv",
  "text/html",
  "text/markdown",
  "text/plain",
  "text/xml",
]);

function getPreferredBackendMember(
  history: ChatHistoryMessage[]
): StickyBackendMemberState | undefined {
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (!message || message.role !== "assistant" || message.error) continue;
    const variants = message.variants || [];
    const variant = variants[message.activeVariant || 0] || variants[0];
    const responsesBackendMember =
      variant?.responsesPreviousResponse?.backendMember;
    if (responsesBackendMember?.id) return responsesBackendMember;
    const backendMember = variant?.backendMember;
    if (backendMember?.id) return backendMember;
    const accountId = variant?.webConversation?.accountId;
    if (accountId) return { type: "account", id: accountId, accountBackend: "web" };
  }
  return undefined;
}

function getLatestResponsesPreviousResponseId(
  history: ChatHistoryMessage[]
): string | undefined {
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (!message || message.role !== "assistant" || message.error) continue;
    const variants = message.variants || [];
    const variant = variants[message.activeVariant || 0] || variants[0];
    return variant?.responsesPreviousResponse?.responseId;
  }
  return undefined;
}

function errorResponse(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function getText(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getCount(formData: FormData, maxBatchCount: number) {
  const value = getText(formData, "count");
  if (!value) return 1;
  if (!/^\d+$/.test(value)) {
    throw new Error("count must be an integer.");
  }
  const count = Number(value);
  if (count < 1 || count > maxBatchCount) {
    throw new Error(`count must be between 1 and ${maxBatchCount}.`);
  }
  return count;
}

function getOptionalBoolean(formData: FormData, ...keys: string[]) {
  for (const key of keys) {
    const value = getText(formData, key).toLowerCase();
    if (!value) continue;
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
  }
  return undefined;
}

function getOptionalInteger(formData: FormData, ...keys: string[]) {
  for (const key of keys) {
    const value = getText(formData, key);
    if (!value) continue;
    if (!/^\d+$/.test(value)) {
      throw new Error(`${key} must be an integer.`);
    }
    return Number(value);
  }
  return undefined;
}

function getConversationMode(formData: FormData) {
  const value =
    getText(formData, "conversationMode") ||
    getText(formData, "conversation_mode");
  if (!value) return undefined;
  if (value === "chat" || value === "agent" || value === "waterfall") {
    return value;
  }
  throw new Error("conversation_mode must be chat, agent, or waterfall.");
}

function hasPromptImageReference(text: string | undefined) {
  return Boolean(text && PROMPT_IMAGE_REFERENCE_PATTERN.test(text));
}

function wantsStreamResponse(request: NextRequest, formData: FormData) {
  if (formData.get("stream") === "true") return true;
  return request.headers.get("accept")?.includes("text/event-stream") ?? false;
}

function getRequestBaseUrl(request: NextRequest) {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.BETTER_AUTH_URL ||
    new URL(request.url).origin
  );
}

function toPublicImageUrl(request: NextRequest, imageUrl?: string) {
  return buildPublicImageUrl(imageUrl, getRequestBaseUrl(request));
}

function normalizeHistoryImageUrls(
  request: NextRequest,
  history: ChatHistoryMessage[]
) {
  return history.map((message) => ({
    ...message,
    imageUrls: (message.imageUrls || []).map(
      (url) => toPublicImageUrl(request, url) || url
    ),
    variants: message.variants?.map((variant) => ({
      ...variant,
      imageUrl: toPublicImageUrl(request, variant.imageUrl),
    })),
  }));
}

function getImageFiles(formData: FormData) {
  const images: File[] = [];

  for (const [key, value] of formData.entries()) {
    if (
      value instanceof File &&
      (key === "image" || key === "image[]" || key.startsWith("image_"))
    ) {
      images.push(value);
    }
  }

  return images;
}

function getAttachmentFiles(formData: FormData) {
  const files: File[] = [];

  for (const [key, value] of formData.entries()) {
    if (
      value instanceof File &&
      (key === "file" ||
        key === "file[]" ||
        key === "attachment" ||
        key === "attachment[]" ||
        key.startsWith("file_") ||
        key.startsWith("attachment_"))
    ) {
      files.push(value);
    }
  }

  return files;
}

function getFileExtension(name: string) {
  const normalized = name.trim().toLowerCase();
  const index = normalized.lastIndexOf(".");
  return index >= 0 ? normalized.slice(index) : "";
}

function isReadableChatFile(file: File) {
  const type = (file.type || "").toLowerCase();
  if (type.startsWith("text/") || CHAT_FILE_ACCEPT_TYPES.has(type)) {
    return true;
  }
  return CHAT_FILE_ACCEPT_EXTENSIONS.has(getFileExtension(file.name || ""));
}

function isPdfChatFile(file: File) {
  const type = (file.type || "").toLowerCase();
  return (
    PDF_MIME_TYPES.has(type) || getFileExtension(file.name || "") === ".pdf"
  );
}

function sanitizeFileText(value: string) {
  return value.split("\0").join("").replace(/\r\n/g, "\n");
}

async function buildFileContext(files: File[], maxChars: number) {
  if (!files.length) return "";

  let remaining = Math.min(maxChars, MAX_CHAT_FILE_CONTEXT_CHARS);
  const parts: string[] = [];
  for (const file of files) {
    if (remaining <= 0) break;
    const buffer = Buffer.from(await file.arrayBuffer());
    const text = sanitizeFileText(buffer.toString("utf8"));
    const header = `\n--- ${file.name || "attachment"} (${file.type || "text/plain"}, ${file.size} bytes) ---\n`;
    const available = Math.max(0, remaining - header.length);
    if (available <= 0) break;
    const clipped = text.slice(0, available);
    parts.push(`${header}${clipped}`);
    remaining -= header.length + clipped.length;
    if (clipped.length < text.length) {
      parts.push("\n[File content truncated]\n");
      break;
    }
  }

  if (!parts.length) return "";
  return `Attached local files are included below. Use them as request context; do not assume access to server filesystem paths.${parts.join("")}`;
}

async function filesToResponsesInputFiles(
  files: File[]
): Promise<ResponsesInputFile[]> {
  return await Promise.all(
    files.map(async (file) => ({
      data: Buffer.from(await file.arrayBuffer()),
      name: file.name || "attachment",
      type: file.type || "application/octet-stream",
    }))
  );
}

function getHistory(
  formData: FormData,
  maxChatImages: number
): ChatHistoryMessage[] {
  const value = getText(formData, "history");
  if (!value) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("history must be valid JSON.");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("history must be an array.");
  }

  return parsed.slice(-24).flatMap((item): ChatHistoryMessage[] => {
    if (!item || typeof item !== "object") return [];
    const source = item as Record<string, unknown>;
    const role = source.role === "assistant" ? "assistant" : "user";
    const text =
      typeof source.text === "string" ? source.text.slice(0, 4000) : "";
    const imageUrls = Array.isArray(source.imageUrls)
      ? source.imageUrls
          .filter((url): url is string => typeof url === "string")
          .slice(0, maxChatImages)
      : [];
    const variants = Array.isArray(source.variants)
      ? source.variants
          .filter((variant) => variant && typeof variant === "object")
          .slice(0, 10)
          .map((variant) => {
            const item = variant as Record<string, unknown>;
            return {
              text:
                typeof item.text === "string"
                  ? item.text.slice(0, 4000)
                  : undefined,
              imageUrl:
                typeof item.imageUrl === "string"
                  ? item.imageUrl.slice(0, 4000)
                  : undefined,
              imageFileId:
                typeof item.imageFileId === "string"
                  ? item.imageFileId.slice(0, 4000)
                  : undefined,
              size: typeof item.size === "string" ? item.size : undefined,
              timestamp:
                typeof item.timestamp === "string" ? item.timestamp : undefined,
              webConversation:
                item.webConversation &&
                typeof item.webConversation === "object" &&
                typeof (item.webConversation as Record<string, unknown>)
                  .conversationId === "string" &&
                typeof (item.webConversation as Record<string, unknown>)
                  .parentMessageId === "string"
                  ? {
                      conversationId: (
                        item.webConversation as Record<string, unknown>
                      ).conversationId as string,
                      parentMessageId: (
                        item.webConversation as Record<string, unknown>
                      ).parentMessageId as string,
                      accountId:
                        typeof (item.webConversation as Record<string, unknown>)
                          .accountId === "string"
                          ? ((item.webConversation as Record<string, unknown>)
                              .accountId as string)
                          : undefined,
                      apiKeyId:
                        typeof (item.webConversation as Record<string, unknown>)
                          .apiKeyId === "string"
                          ? ((item.webConversation as Record<string, unknown>)
                              .apiKeyId as string)
                          : undefined,
                      selectionMessageId:
                        typeof (item.webConversation as Record<string, unknown>)
                          .selectionMessageId === "string"
                          ? ((item.webConversation as Record<string, unknown>)
                              .selectionMessageId as string)
                          : undefined,
                      selectedImageMessageId:
                        typeof (item.webConversation as Record<string, unknown>)
                          .selectedImageMessageId === "string"
                          ? ((item.webConversation as Record<string, unknown>)
                              .selectedImageMessageId as string)
                          : undefined,
                    }
                  : undefined,
              backendMember:
                item.backendMember &&
                typeof item.backendMember === "object" &&
                ((item.backendMember as Record<string, unknown>).type ===
                  "api" ||
                  (item.backendMember as Record<string, unknown>).type ===
                    "account") &&
                typeof (item.backendMember as Record<string, unknown>).id ===
                  "string"
                  ? {
                      type: (item.backendMember as Record<string, unknown>)
                        .type as "api" | "account",
                      id: (item.backendMember as Record<string, unknown>)
                        .id as string,
                      groupId:
                        typeof (item.backendMember as Record<string, unknown>)
                          .groupId === "string"
                          ? ((item.backendMember as Record<string, unknown>)
                              .groupId as string)
                          : (item.backendMember as Record<string, unknown>)
                                .groupId === null
                            ? null
                            : undefined,
                      accountBackend:
                        (item.backendMember as Record<string, unknown>)
                          .accountBackend === "web" ||
                        (item.backendMember as Record<string, unknown>)
                          .accountBackend === "responses"
                          ? ((item.backendMember as Record<string, unknown>)
                              .accountBackend as "web" | "responses")
                          : undefined,
                    }
                  : undefined,
              responsesPreviousResponse:
                item.responsesPreviousResponse &&
                typeof item.responsesPreviousResponse === "object" &&
                typeof (
                  item.responsesPreviousResponse as Record<string, unknown>
                ).responseId === "string" &&
                (item.responsesPreviousResponse as Record<string, unknown>)
                  .backendMember &&
                typeof (
                  item.responsesPreviousResponse as Record<string, unknown>
                ).backendMember === "object"
                  ? (() => {
                      const native = item.responsesPreviousResponse as Record<
                        string,
                        unknown
                      >;
                      const nativeBackend = native.backendMember as Record<
                        string,
                        unknown
                      >;
                      if (
                        (nativeBackend.type !== "api" &&
                          nativeBackend.type !== "account") ||
                        typeof nativeBackend.id !== "string"
                      ) {
                        return undefined;
                      }
                      return {
                        responseId: native.responseId as string,
                        backendMember: {
                          type: nativeBackend.type as "api" | "account",
                          id: nativeBackend.id as string,
                          groupId:
                            typeof nativeBackend.groupId === "string"
                              ? (nativeBackend.groupId as string)
                              : nativeBackend.groupId === null
                                ? null
                                : undefined,
                          accountBackend:
                            nativeBackend.accountBackend === "web" ||
                            nativeBackend.accountBackend === "responses"
                              ? (nativeBackend.accountBackend as
                                  | "web"
                                  | "responses")
                              : undefined,
                        },
                        store: true as const,
                        createdAt:
                          typeof native.createdAt === "string"
                            ? (native.createdAt as string)
                            : undefined,
                      };
                    })()
                  : undefined,
            };
          })
      : undefined;

    return [
      {
        role,
        text,
        imageUrls,
        variants,
        activeVariant:
          typeof source.activeVariant === "number"
            ? source.activeVariant
            : undefined,
        error: typeof source.error === "string" ? source.error : undefined,
      },
    ];
  });
}

function getHistoryMessageText(message: ChatHistoryMessage) {
  if (message.error) return "";
  if (message.role === "user") return message.text || "";

  const variants = message.variants || [];
  const variant = variants[message.activeVariant || 0] || variants[0];
  const imageNote = variant?.imageUrl
    ? `\nGenerated image: ${variant.imageUrl}`
    : "";
  return `${variant?.text || message.text || ""}${imageNote}`;
}

function trimHistoryMessageText(
  message: ChatHistoryMessage,
  maxChars: number
): ChatHistoryMessage | null {
  if (maxChars <= 0 || message.error) return null;

  const text = getHistoryMessageText(message);
  if (!text) return message;
  const trimmedText = text.length > maxChars ? text.slice(0, maxChars) : text;

  if (message.role === "user") {
    return { ...message, text: trimmedText };
  }

  return {
    ...message,
    text: trimmedText,
    variants: message.variants?.map((variant, index) => ({
      ...variant,
      text: index === (message.activeVariant || 0) ? trimmedText : variant.text,
    })),
    activeVariant: message.activeVariant,
  };
}

function limitChatContext(params: {
  prompt: string;
  apiPrompt?: string;
  fileContext?: string;
  promptOptimization?: boolean;
  history: ChatHistoryMessage[];
  maxChatContextChars: number;
}): { history: ChatHistoryMessage[]; error?: string } {
  const basePrompt =
    params.promptOptimization === false
      ? params.prompt
      : params.apiPrompt || params.prompt;
  const currentPrompt = params.fileContext
    ? `${basePrompt}\n\n${params.fileContext}`
    : basePrompt;
  let remaining = params.maxChatContextChars - currentPrompt.length;

  if (remaining < 0) {
    return {
      history: [],
      error: `Chat input context must be no more than ${params.maxChatContextChars} characters.`,
    };
  }

  const limited: ChatHistoryMessage[] = [];
  for (let index = params.history.length - 1; index >= 0; index--) {
    const message = params.history[index];
    if (!message || message.error) continue;

    const textLength = getHistoryMessageText(message).length;
    if (textLength <= remaining) {
      limited.unshift(message);
      remaining -= textLength;
      continue;
    }

    const trimmed = trimHistoryMessageText(message, remaining);
    if (trimmed) limited.unshift(trimmed);
    break;
  }

  return { history: limited };
}

export const POST = withApiLogging(async (request: NextRequest) => {
  const session = await auth.api.getSession({
    headers: request.headers,
  });

  if (!session?.user) {
    return errorResponse("Unauthorized", 401);
  }

  const plan = await getUserPlan(session.user.id);
  const uploadLimits = await getPlanUploadLimits(plan.plan);
  const maxImageBytes = uploadLimits.maxFileSizeBytes;
  const maxRequestBytes = uploadLimits.maxUploadBytes;

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse(
      `Upload is too large or incomplete. Each reference image must be ${formatMegabytes(maxImageBytes)} or smaller, and the total upload must be ${formatMegabytes(maxRequestBytes)} or smaller.`,
      413
    );
  }

  const prompt = getText(formData, "prompt");
  if (!prompt) {
    return errorResponse("Prompt is required.");
  }
  if (prompt.length > IMAGE_PROMPT_MAX_CHARACTERS) {
    return errorResponse(IMAGE_PROMPT_TOO_LONG_MESSAGE);
  }

  const apiPrompt = getText(formData, "apiPrompt") || undefined;
  if (apiPrompt && apiPrompt.length > 8000) {
    return errorResponse("Context prompt exceeds the 8000 character limit.");
  }
  const promptOptimization = getOptionalBoolean(
    formData,
    "promptOptimization",
    "prompt_optimization"
  );
  const requestedGenerationId =
    getText(formData, "generationId") || getText(formData, "generation_id");
  if (requestedGenerationId.length > 128) {
    return errorResponse("generationId is too long.");
  }
  const mixWebFirst = getOptionalBoolean(
    formData,
    "mixWebFirst",
    "mix_web_first"
  );
  // 网页对话轮次(chat(web) tab):走 web 池的 text-capable 路径(回文字、按需出图)。
  const webChat = getOptionalBoolean(formData, "webChat", "web_chat") === true;
  // webChat 必须落在 web 后端,故不因 @图 引用被强制导向 responses 后端;web 路径自行处理
  // 参考图(最近生成图/上传图作为会话上下文)。非 webChat 时 @图 引用仍需 responses 原生解析。
  const requiresResponsesBackend =
    !webChat &&
    (getOptionalBoolean(
      formData,
      "requiresResponsesBackend",
      "requires_responses_backend"
    ) === true ||
      hasPromptImageReference(prompt) ||
      hasPromptImageReference(apiPrompt));
  let conversationMode: "chat" | "agent" | "waterfall" | undefined;
  try {
    conversationMode = getConversationMode(formData);
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : "Invalid conversation mode."
    );
  }
  const agentMode =
    conversationMode === "agent" ||
    (!conversationMode &&
      getOptionalBoolean(formData, "agentMode", "agent_mode") === true);
  let agentMaxRounds: number | undefined;
  try {
    agentMaxRounds = getOptionalInteger(
      formData,
      "agentMaxRounds",
      "agent_max_rounds"
    );
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : "Invalid Agent max rounds."
    );
  }
  if (
    agentMaxRounds !== undefined &&
    (agentMaxRounds < 1 || agentMaxRounds > 8)
  ) {
    return errorResponse("agentMaxRounds must be between 1 and 8.");
  }
  const agentForceMaxRounds = getOptionalBoolean(
    formData,
    "agentForceMaxRounds",
    "agent_force_max_rounds"
  );
  // 分层生成:仅 agent 模式下有效(见后端 generateChatImage)。
  const layeredGeneration = getOptionalBoolean(
    formData,
    "layeredGeneration",
    "layered_generation"
  );
  const waterfallMode =
    conversationMode === "waterfall" ||
    (!conversationMode &&
      getOptionalBoolean(formData, "waterfallMode", "waterfall_mode") === true);
  const requiredCapability = agentMode
    ? "imageGeneration.agent"
    : waterfallMode
      ? "imageGeneration.waterfall"
      : "imageGeneration.chat";
  if (!(await canUsePlanCapability(plan.plan, requiredCapability))) {
    const modeLabel = agentMode
      ? "Agent"
      : waterfallMode
        ? "Waterfall"
        : "Chat";
    return errorResponse(
      `${modeLabel} mode is not enabled for this plan.`,
      403
    );
  }
  const planLimits = await getPlanLimits(plan.plan);
  let history: ChatHistoryMessage[] = [];
  try {
    history = getHistory(formData, planLimits.maxChatImages);
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : "Invalid history."
    );
  }
  const sourceFiles = getImageFiles(formData);
  const attachmentFiles = getAttachmentFiles(formData);
  if (sourceFiles.length + attachmentFiles.length > planLimits.maxChatImages) {
    return errorResponse(
      `No more than ${planLimits.maxChatImages} attachments are allowed.`
    );
  }

  let fileContext = "";
  let responseInputFiles: ResponsesInputFile[] = [];
  try {
    for (const file of attachmentFiles) {
      if (!isReadableChatFile(file)) {
        return errorResponse(
          "Attachments must be text, code, JSON, CSV, Markdown, XML, YAML, PDF, or log files."
        );
      }
      if (file.size <= 0) {
        return errorResponse(`${file.name || "Attachment"} is empty.`);
      }
      if (file.size > maxImageBytes) {
        return errorResponse(
          `${file.name || "Attachment"} exceeds the ${formatMegabytes(maxImageBytes)} limit.`,
          413
        );
      }
    }
    const totalAttachmentSize =
      getTotalUploadSize(sourceFiles) + getTotalUploadSize(attachmentFiles);
    if (totalAttachmentSize > maxRequestBytes) {
      return errorResponse(
        `Total upload size must be no more than ${formatMegabytes(maxRequestBytes)}.`,
        413
      );
    }
    const pdfFiles = attachmentFiles.filter(isPdfChatFile);
    const textFiles = attachmentFiles.filter((file) => !isPdfChatFile(file));
    fileContext = await buildFileContext(
      textFiles,
      Math.max(0, planLimits.maxChatContextChars - prompt.length)
    );
    responseInputFiles = await filesToResponsesInputFiles(pdfFiles);
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : "Failed to read attachments."
    );
  }

  const limitedContext = limitChatContext({
    prompt,
    apiPrompt,
    fileContext,
    promptOptimization,
    history,
    maxChatContextChars: planLimits.maxChatContextChars,
  });
  if (limitedContext.error) {
    return errorResponse(limitedContext.error);
  }
  history = normalizeHistoryImageUrls(request, limitedContext.history);
  const preferredBackendMember = getPreferredBackendMember(history);
  const stickyPreviousResponseId = getLatestResponsesPreviousResponseId(history);

  let size = alignImageSizeToStep(
    getText(formData, "size") || DEFAULT_IMAGE_SIZE
  );
  const sizeCheck = validateImageSize(size);
  if (!sizeCheck.valid) {
    if (sourceFiles.length > 0) {
      size = DEFAULT_IMAGE_SIZE;
    } else {
      return errorResponse(sizeCheck.message);
    }
  }

  const qualityValue = getText(formData, "quality") || "auto";
  if (!VALID_QUALITIES.has(qualityValue as ImageQuality)) {
    return errorResponse("Invalid quality.");
  }
  const quality = qualityValue as ImageQuality;

  const moderationValue = getText(formData, "moderation") || "auto";
  if (!VALID_MODERATION.has(moderationValue as ImageModeration)) {
    return errorResponse("Invalid moderation.");
  }
  const moderation = moderationValue as ImageModeration;
  const outputFormatValue =
    getText(formData, "output_format") || getText(formData, "outputFormat");
  const outputFormat = normalizeOutputFormat(outputFormatValue);
  if (
    outputFormatValue &&
    !VALID_OUTPUT_FORMATS.has(outputFormat as ImageOutputFormat)
  ) {
    return errorResponse("Invalid output_format.");
  }
  const outputCompression = normalizeOutputCompression(
    getText(formData, "output_compression") ||
      getText(formData, "outputCompression")
  );
  const backgroundValue = getText(formData, "background");
  const background = normalizeImageBackground(backgroundValue);
  if (
    backgroundValue &&
    !VALID_IMAGE_BACKGROUNDS.has(background as ImageBackground)
  ) {
    return errorResponse("Invalid background.");
  }
  // 透明背景抠图回退显式开关(issue #27):chat/瀑布流可用,agent 由下游忽略。
  const transparentMatte = getOptionalBoolean(
    formData,
    "transparentMatte",
    "transparent_matte"
  );
  // 高清修复:显式 false 走轻量 general-x4v3;undefined/true 由后端选 SwinIR 超分。
  const hdRepair = getOptionalBoolean(formData, "hdRepair", "hd_repair");

  const thinkingValue = getText(formData, "thinking") || "low";
  if (!VALID_THINKING.has(thinkingValue as ThinkingLevel)) {
    return errorResponse("Invalid thinking level.");
  }
  const thinking = thinkingValue as ThinkingLevel;

  let count = 1;
  try {
    count = getCount(formData, planLimits.maxBatchCount);
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : "Invalid count."
    );
  }
  if (
    count > 1 &&
    !(await canUsePlanCapability(plan.plan, "imageGeneration.batch"))
  ) {
    return errorResponse(
      "Batch image generation is not enabled for this plan.",
      403
    );
  }

  const model = getText(formData, "model") || undefined;
  const imageModel =
    getText(formData, "imageModel") ||
    getText(formData, "image_model") ||
    undefined;
  // 对话生图/Agent 走 Codex/Responses 语义,与 Adobe 直连不兼容;firefly 图像模型在此
  // 不被支持(否则 firefly 意图不进 fireflyOnly,会落到非 Adobe 后端)。UI 已不暴露,此处
  // 服务端兜底拒收,作为防御边界。
  if (isFireflyModel(imageModel)) {
    return errorResponse(
      "Firefly image models are not supported in chat/agent mode. Use /api/images/generate or /api/images/edit (or the external API) for Firefly.",
      400
    );
  }
  try {
    for (const file of sourceFiles) {
      validateImageFile(file, {
        maxImageBytes,
        invalidTypeMessage:
          "Reference images must be PNG, JPEG, or WebP files.",
      });
    }

    const totalUploadSize =
      getTotalUploadSize(sourceFiles) + getTotalUploadSize(attachmentFiles);
    if (totalUploadSize > maxRequestBytes) {
      return errorResponse(
        `Total upload size must be no more than ${formatMegabytes(maxRequestBytes)}.`,
        413
      );
    }

    const batchId = randomUUID();
    const sourceImageUrls = await uploadTemporaryImageUrls(
      session.user.id,
      batchId,
      sourceFiles,
      { scope: "requests" }
    );
    const useStreamResponse = wantsStreamResponse(request, formData);

    const buildImages = async () =>
      await filesToImageInputs(sourceFiles, sourceImageUrls);

    const runChat = async (
      generationId: string,
      onPartialImage?: Parameters<typeof runImageGenerationForUser>[1]
    ) =>
      await runImageGenerationForUser(
        {
          mode: "chat",
          userId: session.user.id,
          generationId,
          prompt,
          apiPrompt,
          fileContext,
          files: responseInputFiles,
          promptOptimization,
          images: await buildImages(),
          history,
          preferredBackendMemberId: preferredBackendMember?.id,
          preferredBackendMemberType: preferredBackendMember?.type,
          stickyPreviousResponseId,
          maxChatContextChars: planLimits.maxChatContextChars,
          size,
          model,
          imageModel,
          quality,
          n: 1,
          moderation,
          outputFormat,
          outputCompression,
          background,
          transparentMatte,
          hdRepair,
          stream: useStreamResponse,
          thinking,
          agentMode,
          agentMaxRounds,
          agentForceMaxRounds,
          layeredGeneration,
          waterfallMode,
          // webChat 强制 web-first(true),否则沿用请求值;requiresResponsesBackend 时禁用。
          mixWebFirst: requiresResponsesBackend
            ? false
            : webChat
              ? true
              : mixWebFirst,
          requiresResponsesBackend,
          webChat,
        },
        onPartialImage
      );

    if (useStreamResponse) {
      return createImageStreamResponse(async (emit) => {
        await runBatchImageGeneration({
          count,
          concurrency: planLimits.imageGenerationConcurrency,
          generationIds:
            count === 1 && requestedGenerationId
              ? [requestedGenerationId]
              : undefined,
          run: runChat,
          callbacks: (index) => ({
            onPartialImage: async (image) => {
              await emit({
                type: "partial_image",
                index,
                partial_image_index: image.partialImageIndex,
                b64_json: image.imageBase64,
                url: image.imageUrl,
                final: image.final,
              });
            },
            onTextDelta: async (delta) => {
              await emit({ type: "text_delta", index, delta });
            },
            onThinkingDelta: async (delta) => {
              await emit({ type: "thinking_delta", index, delta });
            },
            onAgentDelta: async (delta) => {
              await emit({ type: "agent_delta", index, delta });
            },
            onAgentEvent: async (event) => {
              await emit({ type: "agent_event", index, event });
            },
          }),
          onResult: async (result) => {
            if (result.error) {
              await emit({
                type: "error",
                error: result.error,
                generationId: result.generationId,
                creditsConsumed: result.creditsConsumed,
              });
              return;
            }

            await emit({ type: "completed", ...result });
          },
        });

        return null;
      });
    }

    if (count === 1) {
      const result = await runChat(requestedGenerationId || randomUUID());
      return NextResponse.json(result);
    }

    const results = await runBatchImageGeneration({
      count,
      concurrency: planLimits.imageGenerationConcurrency,
      generationIds:
        count === 1 && requestedGenerationId
          ? [requestedGenerationId]
          : undefined,
      run: runChat,
    });

    return NextResponse.json({
      results,
      error: firstBatchError(results)?.error,
    });
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : "Failed to generate image."
    );
  }
});
