import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { withApiLogging } from "@repo/shared/api-logger";
import { buildPublicImageUrl } from "@repo/shared/storage/signed-url";
import {
  canUsePlanCapability,
  getPlanLimits,
} from "@repo/shared/subscription/services/plan-capabilities";
import { getPlanUploadLimits } from "@repo/shared/subscription/services/upload-limits";
import { getUserPlan } from "@repo/shared/subscription/services/user-plan";
import type { NextRequest } from "next/server";

import { authenticateExternalApiRequest } from "@/features/external-api/auth";
import {
  createExternalImageStreamResponse,
  createJsonKeepAliveResponse,
  getImageBase64,
  getPublicImageUrl,
  openAIImageError,
  toOpenAIErrorPayload,
  wantsImageStreamResponse,
} from "@/features/external-api/images";
import {
  fetchPublicImage,
  readResponseBytesWithLimit,
} from "@/features/external-api/safe-image-fetch";
import { runImageGenerationForUser } from "@/features/image-generation/operations";
import {
  normalizeOutputCompression,
  normalizeOutputFormat,
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
  isImageModel,
  validateImageSize,
} from "@/features/image-generation/resolution";
import type {
  AgentRunEvent,
  ChatHistoryMessage,
  ChatHistoryVariant,
  ImageInputFile,
  ImageModeration,
  ImageOutputFormat,
  ImageQuality,
  ResponsesInputFile,
  ResponsesPreviousResponseState,
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
  "minimal",
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
]);
const MAX_AGENT_FILE_CONTEXT_CHARS = 24_000;
const MAX_HISTORY_MESSAGES = 24;
const MAX_HISTORY_TEXT = 4000;
const PDF_MIME_TYPES = new Set(["application/pdf"]);
const AGENT_FILE_ACCEPT_EXTENSIONS = new Set([
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
const AGENT_FILE_ACCEPT_TYPES = new Set([
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
const JSON_SCALAR_FIELDS = [
  "prompt",
  "apiPrompt",
  "api_prompt",
  "promptOptimization",
  "prompt_optimization",
  "promptRepair",
  "prompt_repair",
  "model",
  "gptModel",
  "gpt_model",
  "imageModel",
  "image_model",
  "size",
  "quality",
  "moderation",
  "thinking",
  "response_format",
  "output_format",
  "outputFormat",
  "output_compression",
  "outputCompression",
  "background",
  "transparentMatte",
  "transparent_matte",
  "stream",
  "n",
  "count",
  "agentMaxRounds",
  "agent_max_rounds",
  "agentForceMaxRounds",
  "agent_force_max_rounds",
] as const;

type JsonRecord = Record<string, unknown>;
type ImageReference =
  | { type: "file"; file: File }
  | { type: "url"; url: string };

class AgentReferenceError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isScalarJsonValue(value: unknown) {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function getText(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
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

function formDataFromJson(body: JsonRecord) {
  const formData = new FormData();
  for (const key of JSON_SCALAR_FIELDS) {
    const value = body[key];
    if (isScalarJsonValue(value)) {
      formData.append(key, String(value));
    }
  }
  if (typeof body.history !== "undefined") {
    formData.append(
      "history",
      typeof body.history === "string"
        ? body.history
        : JSON.stringify(body.history)
    );
  }
  return formData;
}

function getFileExtension(name: string) {
  const normalized = name.trim().toLowerCase();
  const index = normalized.lastIndexOf(".");
  return index >= 0 ? normalized.slice(index) : "";
}

function isReadableAgentFile(file: File) {
  const type = (file.type || "").toLowerCase();
  if (type.startsWith("text/") || AGENT_FILE_ACCEPT_TYPES.has(type)) {
    return true;
  }
  return AGENT_FILE_ACCEPT_EXTENSIONS.has(getFileExtension(file.name || ""));
}

function isPdfAgentFile(file: File) {
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

  let remaining = Math.min(maxChars, MAX_AGENT_FILE_CONTEXT_CHARS);
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

function splitUrlList(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean);
      }
    } catch {
      /* fall through to delimiter parsing */
    }
  }
  return trimmed
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function addUrlReference(
  references: ImageReference[],
  seenUrls: Set<string>,
  value: string
) {
  const url = value.trim();
  if (!url || seenUrls.has(url)) return;
  seenUrls.add(url);
  references.push({ type: "url", url });
}

function jsonReferenceToUrl(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!isRecord(value)) return null;

  const imageUrl = value.image_url ?? value.url;
  if (typeof imageUrl === "string" && imageUrl.trim()) {
    return imageUrl.trim();
  }

  if (typeof value.file_id === "string" && value.file_id.trim()) {
    throw new AgentReferenceError(
      "file_id image references are not supported by /v1/agents/images yet. Use image_url or multipart image uploads."
    );
  }

  return null;
}

function getFormImageReferences(formData: FormData) {
  const images: ImageReference[] = [];
  const seenUrls = new Set<string>();

  for (const [key, value] of formData.entries()) {
    if (
      value instanceof File &&
      (key === "image" || key === "image[]" || key.startsWith("image_"))
    ) {
      images.push({ type: "file", file: value });
      continue;
    }

    if (
      typeof value === "string" &&
      (key === "image" ||
        key === "images" ||
        key === "image_url" ||
        key === "image_url[]" ||
        key === "image_urls")
    ) {
      for (const url of splitUrlList(value)) {
        addUrlReference(images, seenUrls, url);
      }
    }
  }

  return images;
}

function getJsonImageReferences(body: JsonRecord) {
  const references: ImageReference[] = [];
  const seenUrls = new Set<string>();
  const images = body.images;
  if (Array.isArray(images)) {
    for (const item of images) {
      const url = jsonReferenceToUrl(item);
      if (url) addUrlReference(references, seenUrls, url);
    }
  } else {
    const url = jsonReferenceToUrl(images);
    if (url) addUrlReference(references, seenUrls, url);
  }

  const imageUrl = jsonReferenceToUrl(body.image_url ?? body.image);
  if (imageUrl) addUrlReference(references, seenUrls, imageUrl);

  const imageUrls = body.image_urls;
  if (Array.isArray(imageUrls)) {
    for (const item of imageUrls) {
      const url = jsonReferenceToUrl(item);
      if (url) addUrlReference(references, seenUrls, url);
    }
  } else if (typeof imageUrls === "string") {
    for (const url of splitUrlList(imageUrls)) {
      addUrlReference(references, seenUrls, url);
    }
  }

  return references;
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

function isPrivateIpAddress(address: string) {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  if (normalized === "::" || normalized.startsWith("fe80:")) return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("::ffff:")) {
    return isPrivateIpAddress(normalized.replace(/^::ffff:/, ""));
  }

  const parts = normalized.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) {
    return false;
  }

  const [a = 0, b = 0] = parts.map(Number);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

async function assertPublicImageUrl(url: URL) {
  const hostname = url.hostname.toLowerCase();
  if (url.username || url.password) {
    throw new AgentReferenceError("Image URL must not include credentials.");
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new AgentReferenceError("Image URL must be publicly reachable.");
  }
  if (
    hostname === "metadata.google.internal" ||
    hostname.endsWith(".internal")
  ) {
    throw new AgentReferenceError("Image URL must be publicly reachable.");
  }

  const strippedHostname = hostname.replace(/^\[|\]$/g, "");
  const literalIp = isIP(strippedHostname);
  if (literalIp) {
    if (isPrivateIpAddress(strippedHostname)) {
      throw new AgentReferenceError("Image URL must be publicly reachable.");
    }
    return;
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (
    addresses.length === 0 ||
    addresses.some((entry) => isPrivateIpAddress(entry.address))
  ) {
    throw new AgentReferenceError("Image URL must be publicly reachable.");
  }
}

function getImageExtension(contentType: string) {
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  if (contentType.includes("webp")) return "webp";
  return "png";
}

function parseDataImageReference(
  value: string,
  index: number,
  maxImageBytes: number
) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(value);
  if (!match) {
    throw new AgentReferenceError(
      "Image data URL must be base64 encoded image data."
    );
  }
  const type = match[1] || "image/png";
  const buffer = Buffer.from(match[2] || "", "base64");
  if (buffer.length > maxImageBytes) {
    throw new AgentReferenceError(
      `Image data URL exceeds the ${formatMegabytes(maxImageBytes)} limit.`,
      413
    );
  }
  return new File(
    [buffer],
    `agent-input-image-${index + 1}.${getImageExtension(type)}`,
    {
      type,
    }
  );
}

async function fetchImageReference(
  reference: ImageReference,
  index: number,
  maxImageBytes: number
) {
  if (reference.type === "file") return reference.file;
  if (reference.url.startsWith("data:image/")) {
    return parseDataImageReference(reference.url, index, maxImageBytes);
  }

  let url: URL;
  try {
    url = new URL(reference.url);
  } catch {
    throw new AgentReferenceError("Image URL is invalid.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AgentReferenceError("Image URL must use http or https.");
  }
  await assertPublicImageUrl(url);

  const response = await fetchPublicImage(url.toString(), {
    headers: { Accept: "image/png,image/jpeg,image/webp" },
  });
  if (!response.ok) {
    throw new AgentReferenceError(
      `Failed to fetch image URL: HTTP ${response.status}`,
      response.status >= 500 ? 502 : 400
    );
  }

  const contentType = (
    (response.headers.get("content-type") || "").split(";")[0] || ""
  ).trim();
  const type = contentType || "image/png";
  // 流式读取并在累计超限时主动 abort：content-length 头可伪造，不能据其预判大小，
  // 也不能先把整段正文缓冲进内存（否则可被巨大响应逼近 OOM）。
  const buffer = await readResponseBytesWithLimit(
    response,
    maxImageBytes,
    () => {
      throw new AgentReferenceError(
        `Image URL exceeds the ${formatMegabytes(maxImageBytes)} limit.`,
        413
      );
    }
  );

  return new File(
    [buffer],
    `agent-input-image-${index + 1}.${getImageExtension(type)}`,
    {
      type,
    }
  );
}

async function resolveImageReferences(
  references: ImageReference[],
  maxImageBytes: number
) {
  return await Promise.all(
    references.map((reference, index) =>
      fetchImageReference(reference, index, maxImageBytes)
    )
  );
}

function normalizeBackendMember(
  value: unknown
): StickyBackendMemberState | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type !== "api" && value.type !== "account") return undefined;
  if (typeof value.id !== "string" || !value.id.trim()) return undefined;
  return {
    type: value.type,
    id: value.id,
    groupId:
      typeof value.groupId === "string"
        ? value.groupId
        : value.groupId === null
          ? null
          : undefined,
    accountBackend:
      value.accountBackend === "web" || value.accountBackend === "responses"
        ? value.accountBackend
        : undefined,
  };
}

function normalizeResponsesPreviousResponse(
  value: unknown
): ResponsesPreviousResponseState | undefined {
  if (!isRecord(value) || typeof value.responseId !== "string") {
    return undefined;
  }
  const backendMember = normalizeBackendMember(value.backendMember);
  if (!backendMember) return undefined;
  return {
    responseId: value.responseId,
    backendMember,
    store: true,
    createdAt:
      typeof value.createdAt === "string" ? value.createdAt : undefined,
  };
}

function normalizeHistoryVariant(value: unknown): ChatHistoryVariant | null {
  if (!isRecord(value)) return null;
  return {
    text:
      typeof value.text === "string"
        ? value.text.slice(0, MAX_HISTORY_TEXT)
        : undefined,
    imageUrl:
      typeof value.imageUrl === "string"
        ? value.imageUrl.slice(0, MAX_HISTORY_TEXT)
        : undefined,
    imageFileId:
      typeof value.imageFileId === "string"
        ? value.imageFileId.slice(0, MAX_HISTORY_TEXT)
        : undefined,
    size: typeof value.size === "string" ? value.size : undefined,
    timestamp:
      typeof value.timestamp === "string" ? value.timestamp : undefined,
    backendMember: normalizeBackendMember(value.backendMember),
    responsesPreviousResponse: normalizeResponsesPreviousResponse(
      value.responsesPreviousResponse
    ),
  };
}

function normalizeHistory(value: unknown, maxChatImages: number) {
  const source = typeof value === "string" && value ? JSON.parse(value) : value;
  if (!Array.isArray(source)) return [];

  return source.slice(-MAX_HISTORY_MESSAGES).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const role = entry.role === "assistant" ? "assistant" : "user";
    const imageUrls = Array.isArray(entry.imageUrls)
      ? entry.imageUrls
          .filter((url): url is string => typeof url === "string")
          .slice(0, maxChatImages)
      : [];
    const variants = Array.isArray(entry.variants)
      ? entry.variants
          .map(normalizeHistoryVariant)
          .filter((item): item is NonNullable<typeof item> => Boolean(item))
          .slice(0, 10)
      : undefined;
    return [
      {
        role,
        text:
          typeof entry.text === "string"
            ? entry.text.slice(0, MAX_HISTORY_TEXT)
            : undefined,
        imageUrls,
        variants,
        activeVariant:
          typeof entry.activeVariant === "number" ? entry.activeVariant : 0,
        error: typeof entry.error === "string" ? entry.error : undefined,
      },
    ] satisfies ChatHistoryMessage[];
  });
}

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
  if (message.role === "user") return { ...message, text: trimmedText };
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

function imageResponseData(
  request: NextRequest,
  result: Awaited<ReturnType<typeof runImageGenerationForUser>>,
  responseFormat: "url" | "b64_json"
) {
  const outputs = result.imageOutputs?.length
    ? result.imageOutputs
    : result.imageUrl
      ? [
          {
            imageUrl: result.imageUrl,
            revisedPrompt: result.revisedPrompt,
            promptRepairNotice: result.promptRepairNotice,
            outputRole: "final" as const,
          },
        ]
      : [];

  return Promise.all(
    outputs.map(async (output) => ({
      ...(responseFormat === "b64_json"
        ? {
            b64_json:
              output.imageBase64 ||
              (await getImageBase64(request, output.imageUrl)),
          }
        : { url: getPublicImageUrl(request, output.imageUrl) }),
      revised_prompt: output.revisedPrompt || result.revisedPrompt,
      prompt_repair_notice:
        output.promptRepairNotice || result.promptRepairNotice,
      generation_id: output.generationId,
      generationId: output.generationId,
      size: output.size || result.size,
      output_role: output.outputRole || "final",
      outputRole: output.outputRole || "final",
      index: output.index,
    }))
  );
}

function toAgentEventPayload(event: AgentRunEvent) {
  return {
    type: "agent.event",
    event,
  };
}

export const postExternalAgentImages = withApiLogging(
  async (request: NextRequest) => {
    const auth = await authenticateExternalApiRequest(request);
    if (!auth) {
      return openAIImageError(
        "Invalid or missing API key",
        401,
        "invalid_api_key"
      );
    }

    const plan = await getUserPlan(auth.userId);
    if (!(await canUsePlanCapability(plan.plan, "externalApi.agent"))) {
      return openAIImageError(
        "External Agent image API requires Ultra plan or higher.",
        403,
        "insufficient_plan"
      );
    }

    const planLimits = await getPlanLimits(plan.plan);
    const uploadLimits = await getPlanUploadLimits(plan.plan);
    const maxImageBytes = uploadLimits.maxFileSizeBytes;
    const maxRequestBytes = uploadLimits.maxUploadBytes;

    let formData: FormData;
    let imageReferences: ImageReference[];
    try {
      const contentType = request.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return openAIImageError("Invalid JSON body.");
        }
        if (!isRecord(body)) {
          return openAIImageError("Request body must be a JSON object.");
        }
        formData = formDataFromJson(body);
        imageReferences = getJsonImageReferences(body);
      } else {
        formData = await request.formData();
        imageReferences = getFormImageReferences(formData);
      }
    } catch (error) {
      if (error instanceof AgentReferenceError) {
        return openAIImageError(error.message, error.status);
      }
      return openAIImageError(
        `Upload is too large or incomplete. Each attachment must be ${formatMegabytes(maxImageBytes)} or smaller, and the total upload must be ${formatMegabytes(maxRequestBytes)} or smaller.`,
        413
      );
    }

    const prompt = getText(formData, "prompt");
    if (!prompt) return openAIImageError("Prompt is required.");
    if (prompt.length > IMAGE_PROMPT_MAX_CHARACTERS) {
      return openAIImageError(IMAGE_PROMPT_TOO_LONG_MESSAGE);
    }

    const apiPrompt =
      getText(formData, "apiPrompt") ||
      getText(formData, "api_prompt") ||
      undefined;
    if (apiPrompt && apiPrompt.length > 8000) {
      return openAIImageError(
        "Context prompt exceeds the 8000 character limit."
      );
    }
    const promptOptimization = getOptionalBoolean(
      formData,
      "promptOptimization",
      "prompt_optimization"
    );
    // 审核改写重试开关(issue #24):传 false 时,审核拦截后不自动改写提示词重试,直接返回真实错误。
    const moderationPromptRepair = getOptionalBoolean(
      formData,
      "promptRepair",
      "prompt_repair"
    );

    let agentMaxRounds: number | undefined;
    try {
      agentMaxRounds = getOptionalInteger(
        formData,
        "agentMaxRounds",
        "agent_max_rounds"
      );
    } catch (error) {
      return openAIImageError(
        error instanceof Error ? error.message : "Invalid Agent max rounds."
      );
    }
    if (
      agentMaxRounds !== undefined &&
      (agentMaxRounds < 1 || agentMaxRounds > 8)
    ) {
      return openAIImageError("agent_max_rounds must be between 1 and 8.");
    }
    const agentForceMaxRounds = getOptionalBoolean(
      formData,
      "agentForceMaxRounds",
      "agent_force_max_rounds"
    );

    const size = alignImageSizeToStep(
      getText(formData, "size") || DEFAULT_IMAGE_SIZE
    );
    const sizeCheck = validateImageSize(size);
    if (!sizeCheck.valid) return openAIImageError(sizeCheck.message);

    const qualityValue = getText(formData, "quality") || "auto";
    if (!VALID_QUALITIES.has(qualityValue as ImageQuality)) {
      return openAIImageError("Invalid quality.");
    }
    const quality = qualityValue as ImageQuality;
    const moderationValue = getText(formData, "moderation") || "auto";
    if (!VALID_MODERATION.has(moderationValue as ImageModeration)) {
      return openAIImageError("Invalid moderation.");
    }
    const moderation = moderationValue as ImageModeration;
    const thinkingValue = getText(formData, "thinking") || "low";
    if (!VALID_THINKING.has(thinkingValue as ThinkingLevel)) {
      return openAIImageError("Invalid thinking level.");
    }
    const thinking = thinkingValue as ThinkingLevel;
    const outputFormatValue =
      getText(formData, "output_format") || getText(formData, "outputFormat");
    const outputFormat = normalizeOutputFormat(outputFormatValue);
    if (
      outputFormatValue &&
      !VALID_OUTPUT_FORMATS.has(outputFormat as ImageOutputFormat)
    ) {
      return openAIImageError("Invalid output_format.");
    }
    const outputCompression = normalizeOutputCompression(
      getText(formData, "output_compression") ||
        getText(formData, "outputCompression")
    );
    // 透明背景控制(issue #27):与图片接口同义,chat/agent 模式适用。
    const backgroundValue = getText(formData, "background") || undefined;
    if (
      backgroundValue &&
      backgroundValue !== "transparent" &&
      backgroundValue !== "opaque" &&
      backgroundValue !== "auto"
    ) {
      return openAIImageError("Invalid background.");
    }
    const background = backgroundValue as
      | "transparent"
      | "opaque"
      | "auto"
      | undefined;
    const transparentMatte = getOptionalBoolean(
      formData,
      "transparentMatte",
      "transparent_matte"
    );
    const responseFormat =
      getText(formData, "response_format") === "b64_json" ? "b64_json" : "url";
    const useStreamResponse = wantsImageStreamResponse(
      request,
      getOptionalBoolean(formData, "stream")
    );
    if (
      useStreamResponse &&
      !(await canUsePlanCapability(plan.plan, "externalApi.streaming"))
    ) {
      return openAIImageError(
        "External API streaming is not enabled for this plan.",
        403,
        "insufficient_plan"
      );
    }
    let requestedCount: number | undefined;
    try {
      requestedCount = getOptionalInteger(formData, "n", "count");
    } catch (error) {
      return openAIImageError(
        error instanceof Error ? error.message : "Invalid n."
      );
    }
    if (requestedCount !== undefined && requestedCount !== 1) {
      return openAIImageError(
        "/v1/agents/images runs one Agent at a time; n/count must be 1."
      );
    }

    let history: ChatHistoryMessage[] = [];
    try {
      history = normalizeHistory(
        getText(formData, "history"),
        planLimits.maxChatImages
      );
    } catch {
      return openAIImageError("history must be valid JSON.");
    }
    const preferredBackendMember = getPreferredBackendMember(history);
    const stickyPreviousResponseId = getLatestResponsesPreviousResponseId(history);

    const attachmentFiles = getAttachmentFiles(formData);
    if (
      imageReferences.length + attachmentFiles.length >
      planLimits.maxChatImages
    ) {
      return openAIImageError(
        `No more than ${planLimits.maxChatImages} attachments are allowed.`
      );
    }

    try {
      const sourceFiles = await resolveImageReferences(
        imageReferences,
        maxImageBytes
      );
      for (const file of sourceFiles) {
        validateImageFile(file, {
          maxImageBytes,
          invalidTypeMessage:
            "Reference images must be PNG, JPEG, or WebP files.",
        });
      }
      for (const file of attachmentFiles) {
        if (!isReadableAgentFile(file)) {
          return openAIImageError(
            "Attachments must be text, code, JSON, CSV, Markdown, XML, YAML, PDF, or log files."
          );
        }
        if (file.size <= 0) {
          return openAIImageError(`${file.name || "Attachment"} is empty.`);
        }
        if (file.size > maxImageBytes) {
          return openAIImageError(
            `${file.name || "Attachment"} exceeds the ${formatMegabytes(maxImageBytes)} limit.`,
            413
          );
        }
      }
      if (
        getTotalUploadSize([...sourceFiles, ...attachmentFiles]) >
        maxRequestBytes
      ) {
        return openAIImageError(
          `Total upload size must be no more than ${formatMegabytes(maxRequestBytes)}.`,
          413
        );
      }

      const pdfFiles = attachmentFiles.filter(isPdfAgentFile);
      const textFiles = attachmentFiles.filter((file) => !isPdfAgentFile(file));
      const fileContext = await buildFileContext(
        textFiles,
        Math.max(0, planLimits.maxChatContextChars - prompt.length)
      );
      const responseInputFiles = await filesToResponsesInputFiles(pdfFiles);
      const limitedContext = limitChatContext({
        prompt,
        apiPrompt,
        fileContext,
        promptOptimization,
        history,
        maxChatContextChars: planLimits.maxChatContextChars,
      });
      if (limitedContext.error) return openAIImageError(limitedContext.error);
      history = normalizeHistoryImageUrls(request, limitedContext.history);

      const batchId = randomUUID();
      const sourceImageUrls = await uploadTemporaryImageUrls(
        auth.userId,
        batchId,
        sourceFiles,
        { scope: "requests" }
      );
      const buildImages = async (): Promise<ImageInputFile[]> =>
        await filesToImageInputs(sourceFiles, sourceImageUrls);
      const requestedModel = getText(formData, "model");
      const requestedImageModel =
        getText(formData, "imageModel") ||
        getText(formData, "image_model") ||
        (isImageModel(requestedModel) ? requestedModel : undefined);
      const requestedGptModel =
        getText(formData, "gptModel") ||
        getText(formData, "gpt_model") ||
        (requestedModel && !isImageModel(requestedModel)
          ? requestedModel
          : undefined);

      const runAgent = async (
        callbacks?: Parameters<typeof runImageGenerationForUser>[1]
      ) =>
        await runImageGenerationForUser(
          {
            mode: "chat",
            userId: auth.userId,
            generationId: randomUUID(),
            apiKeyId: auth.apiKeyId,
            relayOnly: auth.relayOnly,
            prompt,
            apiPrompt,
            fileContext,
            files: responseInputFiles,
            promptOptimization,
            moderationPromptRepair,
            images: await buildImages(),
            history,
            preferredBackendMemberId: preferredBackendMember?.id,
            preferredBackendMemberType: preferredBackendMember?.type,
            stickyPreviousResponseId,
            maxChatContextChars: planLimits.maxChatContextChars,
            size,
            model: requestedGptModel,
            imageModel: requestedImageModel,
            quality,
            n: 1,
            moderation,
            outputFormat,
            outputCompression,
            background,
            transparentMatte,
            stream: undefined,
            thinking,
            agentMode: true,
            agentMaxRounds,
            agentForceMaxRounds,
            requiresResponsesBackend: true,
          },
          callbacks
        );

      if (useStreamResponse) {
        return createExternalImageStreamResponse(async (emit) => {
          const result = await runAgent({
            onPartialImage: async (image) => {
              await emit({
                event: "agent.partial_image",
                data: {
                  type: "agent.partial_image",
                  partial_image_index: image.partialImageIndex,
                  b64_json: image.imageBase64,
                  url: image.imageUrl,
                  final: image.final,
                },
              });
            },
            onTextDelta: async (delta) => {
              await emit({
                event: "agent.text_delta",
                data: { type: "agent.text_delta", delta },
              });
            },
            onThinkingDelta: async (delta) => {
              await emit({
                event: "agent.thinking_delta",
                data: { type: "agent.thinking_delta", delta },
              });
            },
            onAgentDelta: async (delta) => {
              await emit({
                event: "agent.delta",
                data: { type: "agent.delta", delta },
              });
            },
            onAgentEvent: async (event) => {
              await emit({
                event: "agent.event",
                data: toAgentEventPayload(event),
              });
            },
          });

          if (result.error) {
            const payload = toOpenAIErrorPayload(result.error, {
              generationId: result.generationId,
              creditsConsumed: result.creditsConsumed,
            });
            await emit({
              event: "agent.failed",
              data: {
                type: "agent.failed",
                error: payload.error,
                generation_id: result.generationId,
                generationId: result.generationId,
                credits_consumed: result.creditsConsumed,
              },
            });
            return;
          }

          const data = await imageResponseData(request, result, responseFormat);
          await emit({
            event: "agent.completed",
            data: {
              type: "agent.completed",
              generation_id: result.generationId,
              generationId: result.generationId,
              model: result.model,
              size: result.size,
              response_text: result.responseText,
              responseText: result.responseText,
              response_agent: result.responseAgent,
              responseAgent: result.responseAgent,
              agent_round_count: result.agentRoundCount,
              agentRoundCount: result.agentRoundCount,
              credits_consumed: result.creditsConsumed,
              data,
              agent_events: result.agentEvents || [],
              agentEvents: result.agentEvents || [],
              backend_member: result.backendMember,
              backendMember: result.backendMember,
              responses_previous_response: result.responsesPreviousResponse,
              responsesPreviousResponse: result.responsesPreviousResponse,
            },
          });
        });
      }

      return createJsonKeepAliveResponse(async () => {
        const result = await runAgent();
        if (result.error) {
          return toOpenAIErrorPayload(result.error, {
            generationId: result.generationId,
            creditsConsumed: result.creditsConsumed,
          });
        }
        const data = await imageResponseData(request, result, responseFormat);
        return {
          object: "agent.image_run",
          created: Math.floor(Date.now() / 1000),
          generation_id: result.generationId,
          generationId: result.generationId,
          model: result.model,
          size: result.size,
          response_text: result.responseText,
          responseText: result.responseText,
          response_agent: result.responseAgent,
          responseAgent: result.responseAgent,
          agent_round_count: result.agentRoundCount,
          agentRoundCount: result.agentRoundCount,
          credits_consumed: result.creditsConsumed,
          data,
          agent_events: result.agentEvents || [],
          agentEvents: result.agentEvents || [],
          backend_member: result.backendMember,
          backendMember: result.backendMember,
          responses_previous_response: result.responsesPreviousResponse,
          responsesPreviousResponse: result.responsesPreviousResponse,
          usage: null,
        };
      });
    } catch (error) {
      if (error instanceof AgentReferenceError) {
        return openAIImageError(error.message, error.status);
      }
      return openAIImageError(
        error instanceof Error
          ? error.message
          : "Failed to run Agent image API."
      );
    }
  }
);
