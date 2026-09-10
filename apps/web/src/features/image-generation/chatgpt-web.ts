/**
 * 实现 ChatGPT Web 图像、文字与可编辑文件协议，供统一生成服务调用；依赖账号凭据与 Web 代理。
 */
import { createHash, randomUUID } from "node:crypto";
import { logError } from "@repo/shared/logger";
import { getRuntimeSettingString } from "@repo/shared/system-settings";
import { solveChatGptTurnstileToken } from "./chatgpt-web-turnstile";
import { parseImageSize } from "./resolution";
import { isContentSafetyRejection } from "./sla-classification";
import type {
  ApiConfig,
  ChatGptWebConversationState,
  ChatHistoryMessage,
  EditImageParams,
  GenerateImageParams,
  GenerateImageResult,
  ImageInputFile,
  ResponsesInputFile,
  ThinkingLevel,
} from "./types";
import { getWebConversationTurnNodes } from "./web-conversation-history";
import {
  buildWebHistoryTranscript,
  downloadWebHistoryImageReference,
  getRecentWebHistoryImageReferences,
} from "./web-history-references";
import {
  resolveImagesWebModel,
  resolveWorkWebModel,
} from "./web-model-catalog";

const CHATGPT_BASE_URL = "https://chatgpt.com";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0";
const DEFAULT_CLIENT_VERSION = "prod-0161b0c50546a593fb298ade09215fe186023bb5";
const DEFAULT_CLIENT_BUILD_NUMBER = "10493622";
const DEFAULT_POW_SCRIPT = "https://chatgpt.com/backend-api/sentinel/sdk.js";
const IMAGE_POLL_TIMEOUT_MS = 120_000;
const IMAGE_POLL_INTERVAL_MS = 6_000;
// 生成结果轮询前的静默期:web 出图是分钟级异步任务,发起后头 ~45s 几乎不可能就绪,期间每
// IMAGE_POLL_INTERVAL_MS 拉一次会话状态纯属无谓请求,还会把同一账号的会话查询端点打到 429。
// 故发起后至少等这么久再开始轮询,大幅削减状态查询量、降低 429。
const IMAGE_POLL_INITIAL_DELAY_MS = 45_000;
const WEB_PROXY_REQUEST_TIMEOUT_MS = 310_000;
const WEB_SCREEN_WIDTH = 2560;
const WEB_SCREEN_HEIGHT = 1440;

type ChatRequirements = {
  token: string;
  proofToken?: string;
  turnstileToken?: string;
  soToken?: string;
};

type UploadedAttachment = {
  file_id: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  content_type: "image_asset_pointer" | "file_asset_pointer";
  width?: number;
  height?: number;
};

type WebSession = {
  deviceId: string;
  sessionId: string;
};

type PowResources = {
  scriptSources: string[];
  dataBuild: string;
};

export type ChatGptWebAccountInfo = {
  email: string | null;
  userId: string | null;
  type: string;
  quota: number;
  limitsProgress: unknown[];
  defaultModelSlug: string | null;
  restoreAt: string | null;
  status: "active" | "limited";
};

const webSessionCache = new Map<string, WebSession>();
/** Node fetch 不保存 Set-Cookie；直连模式需按账号延续 Sentinel 的 oai-sc 状态。 */
const webSentinelCookieCache = new Map<string, string>();

type WebProxyResponsePayload = {
  status: number;
  headers?: Record<string, string[]>;
  bodyBase64?: string;
};

type WebImageParams = (GenerateImageParams | EditImageParams) & {
  history?: ChatHistoryMessage[];
  files?: ResponsesInputFile[];
};

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new Error("Image generation timed out after 20 minutes");
  }
}

type WebContinuationState = ChatGptWebConversationState & {
  useNativeContinuation: boolean;
};

function getPrompt(params: WebImageParams) {
  if (params.promptOptimization === false) {
    return params.prompt;
  }
  return params.apiPrompt || params.prompt;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function aspectRatioFromSize(size?: string) {
  const normalized = size?.trim().toLowerCase();
  if (!normalized || normalized === "auto") return null;
  if (/^\d{1,3}:\d{1,3}$/.test(normalized)) return normalized;

  const dimensions = parseImageSize(normalized);
  if (!dimensions) return null;

  const divisor = gcd(dimensions.width, dimensions.height);
  return `${dimensions.width / divisor}:${dimensions.height / divisor}`;
}

function buildImageSizePrompt(size?: string) {
  const ratio = aspectRatioFromSize(size);
  if (!ratio) return null;

  const hints: Record<string, string> = {
    "1:1": "Output the image in a strict 1:1 square composition.",
    "16:9": "Output the image in a 16:9 landscape composition.",
    "9:16": "Output the image in a 9:16 portrait composition.",
    "4:3": "Output the image in a 4:3 composition.",
    "3:4": "Output the image in a 3:4 portrait composition.",
    "3:2": "Output the image in a 3:2 landscape composition.",
    "2:3": "Output the image in a 2:3 portrait composition.",
  };
  const hint = hints[ratio] || `Output the image with a ${ratio} aspect ratio.`;
  const normalized = size?.trim();
  if (!normalized || normalized === ratio) return hint;
  return `${hint} Target size requested by the API is ${normalized}.`;
}

function applyImageSizePrompt(prompt: string, size?: string) {
  const hint = buildImageSizePrompt(size);
  if (!hint) return prompt;
  return `${prompt.trim()}\n\n${hint}`;
}

function lastWebConversationState(
  history: ChatHistoryMessage[] | undefined,
  accountId?: string
): WebContinuationState | null {
  for (let index = (history || []).length - 1; index >= 0; index--) {
    const message = history?.[index];
    if (!message || message.role !== "assistant" || message.error) continue;
    const variants = message.variants || [];
    const variant = variants[message.activeVariant || 0] || variants[0];
    const state = variant?.webConversation;
    if (!state?.conversationId || !state.parentMessageId) continue;
    const sameAccount =
      !accountId || !state.accountId || state.accountId === accountId;
    return {
      ...state,
      useNativeContinuation: sameAccount,
    };
  }
  return null;
}

function getWebSession(config: ApiConfig) {
  const key = getWebSessionKey(config);
  const cached = webSessionCache.get(key);
  if (cached) return cached;
  const session = {
    deviceId: randomUUID(),
    sessionId: randomUUID(),
  };
  webSessionCache.set(key, session);
  return session;
}

function getWebSessionKey(config: ApiConfig) {
  const workspaceId = Object.entries(config.headers || {}).find(
    ([key]) => key.toLowerCase() === "chatgpt-account-id"
  )?.[1];
  const identity = [config.backend?.id || "", workspaceId || "", config.apiKey]
    .map((value) => `${value.length}:${value}`)
    .join("|");
  return `web:${createHash("sha256").update(identity).digest("hex")}`;
}

function encodeBody(body: BodyInit | null | undefined) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body).toString("base64");
  if (body instanceof Uint8Array) return Buffer.from(body).toString("base64");
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString("base64");
  throw new Error(
    "ChatGPT Web proxy only supports string and binary request bodies"
  );
}

function decodeBody(bodyBase64: string | undefined) {
  if (!bodyBase64) return new Uint8Array();
  return Buffer.from(bodyBase64, "base64");
}

async function webErrorMessage(response: Response, context: string) {
  const text = await response.text().catch(() => "");
  const extracted = extractWebErrorPayloadMessage(text);
  const trimmed = (extracted || text).replace(/\s+/g, " ").trim();
  return `${context} failed: HTTP ${response.status}${
    trimmed ? ` ${trimmed.slice(0, 500)}` : ""
  }`;
}

function extractWebErrorPayloadMessage(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return "";
  try {
    const payload = JSON.parse(trimmed) as unknown;
    const message = webErrorPayloadMessage(payload);
    if (message) return message;
  } catch {
    /* fall back to raw text */
  }
  return "";
}

function webErrorPayloadMessage(payload: unknown): string {
  if (typeof payload === "string") return payload.trim();
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  for (const key of ["detail", "message", "error_description", "code"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const error = record.error;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object") {
    const nested = webErrorPayloadMessage(error);
    if (nested) return nested;
  }
  // ChatGPT web 流式增量(o/v 操作)会把真实错误文案包在 v 里(如 {"o":"add","v":{...}});
  // 像 error 一样递归取出,避免上层兜底把原始 o/v 协议分片当错误回显给用户。
  const value = record.v;
  if (value && typeof value === "object") {
    const nested = webErrorPayloadMessage(value);
    if (nested) return nested;
  }
  return "";
}

function headersToObject(headers: HeadersInit | undefined) {
  const result: Record<string, string> = {};
  if (!headers) return result;
  const source = new Headers(headers);
  source.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function withSentinelCookie(
  headers: Record<string, string>,
  sentinelCookie: string | undefined
) {
  if (!sentinelCookie) return headers;
  const cookieKey =
    Object.keys(headers).find((key) => key.toLowerCase() === "cookie") ||
    "Cookie";
  const cookies = (headers[cookieKey] || "")
    .split(";")
    .map((cookie) => cookie.trim())
    .filter((cookie) => cookie && !cookie.toLowerCase().startsWith("oai-sc="));
  cookies.push(`oai-sc=${sentinelCookie}`);
  return { ...headers, [cookieKey]: cookies.join("; ") };
}

function captureSentinelCookie(config: ApiConfig, response: Response) {
  const getSetCookie = (
    response.headers as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie;
  const values =
    typeof getSetCookie === "function"
      ? getSetCookie.call(response.headers)
      : [response.headers.get("set-cookie") || ""];
  for (const value of values) {
    const match = value.match(/(?:^|,\s*)oai-sc=([^;,]*)/i);
    if (!match) continue;
    const cookie = match[1]?.trim();
    const key = getWebSessionKey(config);
    if (cookie) webSentinelCookieCache.set(key, cookie);
    else webSentinelCookieCache.delete(key);
  }
}

function toResponseHeaders(headers: WebProxyResponsePayload["headers"]) {
  const result = new Headers();
  for (const [key, values] of Object.entries(headers || {})) {
    if (key.toLowerCase() === "content-encoding") continue;
    for (const value of values) {
      result.append(key, value);
    }
  }
  return result;
}

async function getWebProxyConfig() {
  const rawUrl =
    (await getRuntimeSettingString("CHATGPT_WEB_PROXY_URL")) ||
    process.env.CHATGPT_WEB_PROXY_URL?.trim();
  const url = rawUrl?.replace(/\/+$/, "");
  if (!url) return null;
  return {
    url,
    secret:
      (await getRuntimeSettingString("CHATGPT_WEB_PROXY_SECRET")) ||
      process.env.CHATGPT_WEB_PROXY_SECRET?.trim() ||
      "",
  };
}

async function fetchChatGptWeb(
  config: ApiConfig,
  urlPath: string,
  targetPath: string,
  init?: RequestInit,
  extraHeaders?: Record<string, string>
) {
  const headers = {
    ...headersToObject(init?.headers),
    ...(extraHeaders || {}),
  };
  const proxy = await getWebProxyConfig();
  if (!proxy) {
    const response = await fetch(`${CHATGPT_BASE_URL}${urlPath}`, {
      ...init,
      headers: withSentinelCookie(
        headers,
        webSentinelCookieCache.get(getWebSessionKey(config))
      ),
    });
    captureSentinelCookie(config, response);
    return response;
  }

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  if (init?.signal?.aborted) {
    controller.abort();
  } else {
    init?.signal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const timeout = setTimeout(() => {
    controller.abort();
  }, WEB_PROXY_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${proxy.url}/request`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(proxy.secret ? { "X-Proxy-Secret": proxy.secret } : {}),
      },
      body: JSON.stringify({
        sessionKey: getWebSessionKey(config),
        method: init?.method || "GET",
        urlPath,
        targetPath,
        headers,
        headerOrder: Object.keys(headers),
        bodyBase64: encodeBody(init?.body),
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `ChatGPT Web proxy failed: HTTP ${response.status}${text ? ` ${text.slice(0, 300)}` : ""}`
      );
    }
    const payload = (await response.json()) as WebProxyResponsePayload;
    return new Response(decodeBody(payload.bodyBase64), {
      status: payload.status,
      headers: toResponseHeaders(payload.headers),
    });
  } finally {
    clearTimeout(timeout);
    init?.signal?.removeEventListener("abort", abortFromCaller);
  }
}

function powResourcesFromHtml(html: string): PowResources {
  const scriptSources =
    [...html.matchAll(/<script[^>]+src="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((value): value is string => Boolean(value)) || [];
  const htmlMatch = html.match(/<html[^>]*data-build="([^"]*)"/);
  const scriptMatch = html.match(/\/c\/[^/]+\/_/);
  return {
    scriptSources: scriptSources.length ? scriptSources : [DEFAULT_POW_SCRIPT],
    dataBuild: htmlMatch?.[1] || scriptMatch?.[0] || "",
  };
}

function legacyParseTime() {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][
    now.getUTCDay()
  ];
  const month = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ][now.getUTCMonth()];
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${weekday} ${month} ${pad(now.getUTCDate())} ${now.getUTCFullYear()} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())} GMT+0800 (中国标准时间)`;
}

const POW_NAVIGATOR_PROPERTIES = [
  "storage−[object StorageManager]",
  "locks−[object LockManager]",
  "appCodeName−Mozilla",
  "permissions−[object Permissions]",
  "webdriver−false",
  "vendor−Google Inc.",
  "mediaDevices−[object MediaDevices]",
  "cookieEnabled−true",
  "product−Gecko",
  "onLine−true",
  "credentials−[object CredentialsContainer]",
  "serviceWorker−[object ServiceWorkerContainer]",
  "gpu−[object GPU]",
  "pdfViewerEnabled−true",
  "language−zh-CN",
  "geolocation−[object Geolocation]",
  "userAgentData−[object NavigatorUAData]",
  "hardwareConcurrency−8",
] as const;
const POW_WINDOW_KEYS = [
  "window",
  "self",
  "document",
  "location",
  "history",
  "navigation",
  "innerWidth",
  "innerHeight",
  "devicePixelRatio",
  "screen",
  "chrome",
  "navigator",
  "performance",
  "crypto",
  "indexedDB",
  "sessionStorage",
  "localStorage",
  "scheduler",
  "atob",
  "btoa",
  "fetch",
  "matchMedia",
  "postMessage",
  "queueMicrotask",
  "requestAnimationFrame",
  "createImageBitmap",
  "setInterval",
  "setTimeout",
  "caches",
] as const;

function randomPowValue<T>(values: readonly T[]): T {
  const value = values[Math.floor(Math.random() * values.length)];
  if (value === undefined) throw new Error("ChatGPT Web PoW 候选列表为空");
  return value;
}

function powConfig(resources: PowResources) {
  const preferredScriptSources = resources.scriptSources.filter(
    (source) =>
      source.includes("/sentinel/") ||
      source.includes("/cdn-cgi/challenge-platform/")
  );
  const scriptSource = randomPowValue(
    preferredScriptSources.length
      ? preferredScriptSources
      : resources.scriptSources.length
        ? resources.scriptSources
        : [DEFAULT_POW_SCRIPT]
  );
  const monotonicNow = performance.now();
  const reactKeySuffix = Math.random().toString(36).slice(2);
  return [
    WEB_SCREEN_WIDTH + WEB_SCREEN_HEIGHT,
    legacyParseTime(),
    4294705152,
    1,
    USER_AGENT,
    scriptSource,
    resources.dataBuild,
    "zh-CN",
    "zh-CN,zh,en,en-US",
    0,
    randomPowValue(POW_NAVIGATOR_PROPERTIES),
    randomPowValue([
      `__reactContainer$${reactKeySuffix}`,
      `_reactListening${reactKeySuffix}`,
      `__reactResources$${reactKeySuffix}`,
      "location",
    ]),
    randomPowValue(POW_WINDOW_KEYS),
    monotonicNow,
    randomUUID(),
    "",
    8,
    Date.now() - monotonicNow,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ];
}

/** 2026-09 Web Sentinel SDK 的 32 位 FNV-1a + avalanche 哈希。 */
function sentinelPowHash(value: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 2_246_822_507) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 3_266_489_909) >>> 0;
  hash ^= hash >>> 16;
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function solvePow(
  seed: string,
  difficulty: string,
  config: unknown[],
  signal?: AbortSignal
) {
  const startedAt = performance.now();
  for (let index = 0; index < 500_000; index++) {
    if ((index & 1023) === 0 && signal?.aborted) {
      throw new Error("ChatGPT Web proof challenge aborted");
    }
    config[3] = index;
    config[9] = Math.round(performance.now() - startedAt);
    const encoded = Buffer.from(JSON.stringify(config)).toString("base64");
    const hash = sentinelPowHash(seed + encoded);
    if (hash.slice(0, difficulty.length) <= difficulty) {
      return { token: `${encoded}~S`, solved: true };
    }
  }
  return {
    token: `wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D${Buffer.from(`"${seed}"`).toString("base64")}`,
    solved: false,
  };
}

function buildLegacyRequirementsToken(
  resources: PowResources,
  config = powConfig(resources)
) {
  const startedAt = performance.now();
  config[3] = 1;
  config[9] = performance.now() - startedAt;
  return `gAAAAAC${Buffer.from(JSON.stringify(config)).toString("base64")}`;
}

function buildProofToken(data: {
  seed?: string;
  difficulty?: string;
  resources: PowResources;
  config?: unknown[];
  signal?: AbortSignal;
}) {
  if (
    typeof data.seed !== "string" ||
    !data.seed ||
    data.seed.length > 1024 ||
    typeof data.difficulty !== "string" ||
    !/^[0-9a-f]{1,8}$/i.test(data.difficulty)
  ) {
    return "";
  }
  const { token, solved } = solvePow(
    data.seed,
    data.difficulty.toLowerCase(),
    data.config || powConfig(data.resources),
    data.signal
  );
  if (!solved) {
    throw new Error(
      `failed to solve proof token: difficulty=${data.difficulty}`
    );
  }
  return `gAAAAAB${token}`;
}

function configuredHeader(config: ApiConfig, name: string) {
  const match = Object.entries(config.headers || {}).find(
    ([key]) => key.toLowerCase() === name.toLowerCase()
  );
  const value = match?.[1]?.trim();
  return value || undefined;
}

function getHeaders(
  config: ApiConfig,
  path: string,
  extra?: Record<string, string>
) {
  const session = getWebSession(config);
  const chatgptAccountId = configuredHeader(config, "ChatGPT-Account-Id");
  return {
    "User-Agent": USER_AGENT,
    Origin: CHATGPT_BASE_URL,
    Referer: `${CHATGPT_BASE_URL}/`,
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-US;q=0.7",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    Priority: "u=1, i",
    "Sec-Ch-Ua":
      '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
    "Sec-Ch-Ua-Arch": '"x86"',
    "Sec-Ch-Ua-Bitness": '"64"',
    "Sec-Ch-Ua-Full-Version": '"143.0.3650.96"',
    "Sec-Ch-Ua-Full-Version-List":
      '"Microsoft Edge";v="143.0.3650.96", "Chromium";v="143.0.7499.147", "Not A(Brand";v="24.0.0.0"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Model": '""',
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Ch-Ua-Platform-Version": '"19.0.0"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "OAI-Device-Id": session.deviceId,
    "OAI-Session-Id": session.sessionId,
    "OAI-Language": "zh-CN",
    "OAI-Client-Version": DEFAULT_CLIENT_VERSION,
    "OAI-Client-Build-Number": DEFAULT_CLIENT_BUILD_NUMBER,
    ...(chatgptAccountId ? { "ChatGPT-Account-Id": chatgptAccountId } : {}),
    "X-OpenAI-Target-Path": path,
    "X-OpenAI-Target-Route": path,
    Authorization: `Bearer ${config.apiKey}`,
    ...extra,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrNull(value: unknown) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function numberOrZero(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function extractQuotaAndRestoreAt(limitsProgress: unknown[]) {
  for (const item of limitsProgress) {
    const row = asRecord(item);
    if (row.feature_name === "image_gen") {
      return {
        quota: numberOrZero(row.remaining),
        restoreAt: stringOrNull(row.reset_after),
      };
    }
  }
  return { quota: 0, restoreAt: null };
}

async function fetchWebJson<T>(
  config: ApiConfig,
  urlPath: string,
  targetPath: string,
  init?: RequestInit,
  extraHeaders?: Record<string, string>
) {
  const response = await fetchChatGptWeb(
    config,
    urlPath,
    targetPath,
    init,
    getHeaders(config, targetPath, {
      Accept: "application/json",
      ...(extraHeaders || {}),
    })
  );
  if (!response.ok) {
    const message = `${targetPath} failed: HTTP ${response.status}`;
    if (response.status === 401) {
      throw new Error(`invalid access token: ${message}`);
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

export async function getChatGptWebAccountInfo(
  config: ApiConfig
): Promise<ChatGptWebAccountInfo> {
  const mePath = "/backend-api/me";
  const initPath = "/backend-api/conversation/init";
  const accountPath = "/backend-api/accounts/check/v4-2023-04-27";
  const [mePayload, initPayload, accountPayload] = await Promise.all([
    fetchWebJson<Record<string, unknown>>(config, mePath, mePath),
    fetchWebJson<Record<string, unknown>>(
      config,
      initPath,
      initPath,
      {
        method: "POST",
        body: JSON.stringify({
          gizmo_id: null,
          requested_default_model: null,
          conversation_id: null,
          timezone_offset_min: -480,
        }),
      },
      { "Content-Type": "application/json" }
    ),
    fetchWebJson<Record<string, unknown>>(
      config,
      `${accountPath}?timezone_offset_min=-480`,
      accountPath
    ),
  ]);

  const accounts = asRecord(accountPayload.accounts);
  const defaultAccount = asRecord(asRecord(accounts.default).account);
  const planType = String(defaultAccount.plan_type || "free");
  const limitsProgress = Array.isArray(initPayload.limits_progress)
    ? initPayload.limits_progress
    : [];
  const { quota, restoreAt } = extractQuotaAndRestoreAt(limitsProgress);

  return {
    email: stringOrNull(mePayload.email),
    userId: stringOrNull(mePayload.id),
    type: planType,
    quota,
    limitsProgress,
    defaultModelSlug: stringOrNull(initPayload.default_model_slug),
    restoreAt,
    status: quota === 0 ? "limited" : "active",
  };
}

async function bootstrap(config: ApiConfig) {
  const response = await fetchChatGptWeb(config, "/", "/", {
    signal: config.signal,
    headers: getHeaders(config, "/", {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }),
  });
  if (!response.ok) {
    throw new Error(await webErrorMessage(response, "ChatGPT Web bootstrap"));
  }
  return powResourcesFromHtml(await response.text());
}

async function getChatRequirements(
  config: ApiConfig,
  bootstrappedResources?: PowResources
) {
  const resources = bootstrappedResources || (await bootstrap(config));
  const basePath = "/backend-api/sentinel/chat-requirements";
  const preparePath = `${basePath}/prepare`;
  const pFingerprint = powConfig(resources);
  const pToken = buildLegacyRequirementsToken(resources, pFingerprint);
  const prepareResponse = await fetchChatGptWeb(
    config,
    preparePath,
    preparePath,
    {
      method: "POST",
      signal: config.signal,
      headers: getHeaders(config, preparePath, {
        "Content-Type": "application/json",
        Accept: "*/*",
      }),
      body: JSON.stringify({ p: pToken }),
    }
  );
  if (!prepareResponse.ok) {
    throw new Error(
      await webErrorMessage(prepareResponse, "ChatGPT Web requirements prepare")
    );
  }
  const prepareData = (await prepareResponse.json()) as {
    prepare_token?: string;
    arkose?: { required?: boolean };
    proofofwork?: {
      required?: boolean;
      seed?: string;
      difficulty?: string;
    };
    turnstile?: { required?: boolean; dx?: string };
  };
  if (!prepareData.prepare_token) {
    throw new Error(
      "ChatGPT Web requirements prepare response missing prepare token"
    );
  }
  if (prepareData.arkose?.required) {
    throw new Error(
      "ChatGPT Web requirements requires unsupported Arkose token"
    );
  }

  let proofToken = "";
  if (prepareData.proofofwork?.required) {
    const proofFingerprint = powConfig(resources);
    const deviceId = pFingerprint[14];
    if (typeof deviceId !== "string" || !deviceId) {
      throw new Error("ChatGPT Web requirements fingerprint is incomplete");
    }
    // Sentinel 会在 p 与 proof 间保留设备 UUID，其余动态采样项重新生成。
    proofFingerprint[14] = deviceId;
    proofToken = buildProofToken({
      seed: prepareData.proofofwork.seed,
      difficulty: prepareData.proofofwork.difficulty,
      resources,
      config: proofFingerprint,
      signal: config.signal,
    });
  }
  if (prepareData.proofofwork?.required && !proofToken) {
    throw new Error("ChatGPT Web requirements proof challenge is incomplete");
  }
  const turnstileToken = prepareData.turnstile?.required
    ? solveChatGptTurnstileToken(prepareData.turnstile.dx || "", pToken)
    : "";
  if (prepareData.turnstile?.required && !turnstileToken) {
    throw new Error("ChatGPT Web requirements Turnstile challenge failed");
  }

  const finalizePath = `${basePath}/finalize`;
  const response = await fetchChatGptWeb(config, finalizePath, finalizePath, {
    method: "POST",
    signal: config.signal,
    headers: getHeaders(config, finalizePath, {
      "Content-Type": "application/json",
      Accept: "*/*",
    }),
    body: JSON.stringify({
      prepare_token: prepareData.prepare_token,
      proofofwork: proofToken,
      turnstile: turnstileToken,
    }),
  });
  if (!response.ok) {
    throw new Error(
      await webErrorMessage(response, "ChatGPT Web requirements finalize")
    );
  }
  const data = (await response.json()) as {
    token?: string;
    so_token?: string;
  };
  if (!data.token) {
    throw new Error("ChatGPT Web requirements finalize response missing token");
  }
  return {
    token: data.token,
    proofToken: proofToken || undefined,
    turnstileToken: turnstileToken || undefined,
    soToken: data.so_token,
  } satisfies ChatRequirements;
}

function imageDimensions(buffer: Buffer) {
  if (
    buffer.length >= 24 &&
    buffer.readUInt32BE(0) === 0x89504e47 &&
    buffer.toString("ascii", 12, 16) === "IHDR"
  ) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }
  if (buffer.length >= 10 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1] ?? 0;
      const length = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xc3) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }
      offset += 2 + length;
    }
  }
  return { width: 1024, height: 1024 };
}

async function uploadAttachment(
  config: ApiConfig,
  file: ImageInputFile | ResponsesInputFile,
  index: number,
  options?: { image?: boolean }
) {
  const isImage = Boolean(options?.image);
  const dimensions = isImage ? imageDimensions(file.data) : null;
  const path = "/backend-api/files";
  const fileName =
    file.name || (isImage ? `image_${index}.png` : `file_${index}`);
  const createResponse = await fetchChatGptWeb(config, path, path, {
    method: "POST",
    signal: config.signal,
    headers: getHeaders(config, path, {
      "Content-Type": "application/json",
      Accept: "application/json",
    }),
    body: JSON.stringify({
      file_name: fileName,
      file_size: file.data.length,
      use_case: "multimodal",
      ...(dimensions
        ? {
            width: dimensions.width,
            height: dimensions.height,
          }
        : {}),
    }),
  });
  if (!createResponse.ok) {
    throw new Error(
      await webErrorMessage(createResponse, "ChatGPT Web file create")
    );
  }
  const uploadMeta = (await createResponse.json()) as {
    file_id: string;
    upload_url: string;
  };
  const uploadResponse = await fetch(uploadMeta.upload_url, {
    method: "PUT",
    signal: config.signal,
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "x-ms-blob-type": "BlockBlob",
      "x-ms-version": "2020-04-08",
      Origin: CHATGPT_BASE_URL,
      Referer: `${CHATGPT_BASE_URL}/`,
      "User-Agent": USER_AGENT,
    },
    body: new Uint8Array(file.data),
  });
  if (!uploadResponse.ok) {
    throw new Error(
      `ChatGPT Web file upload failed: HTTP ${uploadResponse.status}`
    );
  }
  const uploadedPath = `/backend-api/files/${uploadMeta.file_id}/uploaded`;
  const uploadedResponse = await fetchChatGptWeb(
    config,
    uploadedPath,
    uploadedPath,
    {
      method: "POST",
      signal: config.signal,
      headers: getHeaders(config, uploadedPath, {
        "Content-Type": "application/json",
        Accept: "application/json",
      }),
      body: "{}",
    }
  );
  if (!uploadedResponse.ok) {
    throw new Error(
      await webErrorMessage(uploadedResponse, "ChatGPT Web file finalize")
    );
  }
  return {
    file_id: uploadMeta.file_id,
    file_name: fileName,
    file_size: file.data.length,
    mime_type: file.type || "application/octet-stream",
    content_type: isImage ? "image_asset_pointer" : "file_asset_pointer",
    ...(dimensions
      ? {
          width: dimensions.width,
          height: dimensions.height,
        }
      : {}),
  } satisfies UploadedAttachment;
}

type WebConversationRequestOptions = {
  gptModel?: string;
  thinking?: ThinkingLevel;
  promptOptimization?: boolean;
  profile: "images" | "work";
  parentMessageId: string;
  turnTraceId: string;
  continuation?: WebContinuationState | null;
  /** Images 强制生图默认 picture_v2；Work 传空数组，由 profile 独立决定模型目录。 */
  systemHints?: string[];
};

type WebConversationSubmitOptions = WebConversationRequestOptions & {
  requestMessageId: string;
};

const WEB_LOCAL_FUNCTION_NAMES = ["local.continue_in_work"] as const;
/** 最新 Images 与 Work HAR 均携带的网页响应契约，不包含图片版本字段。 */
const WEB_MODEL_RESPONSE_CONTRACTS = [
  {
    id: "photo_upload_action.v1",
    protocol_version: 1,
    presets: ["cap:image", "cap:file", "placement:end"],
  },
] as const;

/**
 * 按显式场景转换已鉴权的站内模型，并返回正式提交的并行开关。
 * 未收录的管理员自定义 Web 标识保留旧协议，不把未经验证的别名写入模型表。
 * 纯参数转换，无网络副作用；权限仍由统一生成服务在进入 Web 前校验。
 */
function webConversationModelRequest(options: WebConversationRequestOptions) {
  const resolved =
    options.profile === "work"
      ? resolveWorkWebModel(options)
      : resolveImagesWebModel(options);
  if (resolved) {
    return {
      modelParameters: resolved,
      forceParallelSwitch: "auto" as const,
    };
  }
  return {
    modelParameters: {
      model: options.gptModel?.trim() || "gpt-5-5-thinking",
      paragen_thinking_level: webThinkingValue(
        options.thinking,
        options.promptOptimization
      ),
    },
    forceParallelSwitch:
      options.promptOptimization === false ? "instant" : "auto",
  };
}

/** 为未收录的管理员自定义 Web slug 保留旧思考参数；已验证模型使用 thinking_effort。 */
function webThinkingValue(
  thinking: ThinkingLevel | undefined,
  promptOptimization?: boolean
) {
  if (promptOptimization === false) return "instant";
  if (thinking === "minimal") return "instant";
  if (thinking === "none") return "instant";
  if (thinking === "xhigh") return "high";
  return thinking || "low";
}

/** prepare 返回 JSON，使用同轮 trace，但不提前发送正式提交的 Sentinel 凭据。 */
function prepareConversationHeaders(
  config: ApiConfig,
  path: string,
  turnTraceId: string
) {
  return getHeaders(config, path, {
    "Content-Type": "application/json",
    Accept: "*/*",
    "OAI-GenUI-Client-Actions": "open_entity_detail",
    "X-Oai-Turn-Trace-Id": turnTraceId,
  });
}

/** 正式会话提交使用 SSE 与 Sentinel 凭据，可附带 prepare 返回的 conduit token。 */
function imageHeaders(
  config: ApiConfig,
  path: string,
  requirements: ChatRequirements,
  options?: { conduitToken?: string; turnTraceId?: string }
) {
  return getHeaders(config, path, {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "OAI-GenUI-Client-Actions": "open_entity_detail",
    "OpenAI-Sentinel-Chat-Requirements-Token": requirements.token,
    ...(requirements.proofToken
      ? { "OpenAI-Sentinel-Proof-Token": requirements.proofToken }
      : {}),
    ...(requirements.turnstileToken
      ? { "OpenAI-Sentinel-Turnstile-Token": requirements.turnstileToken }
      : {}),
    ...(requirements.soToken
      ? { "OpenAI-Sentinel-SO-Token": requirements.soToken }
      : {}),
    ...(options?.conduitToken
      ? { "X-Conduit-Token": options.conduitToken }
      : {}),
    "X-Oai-Turn-Trace-Id": options?.turnTraceId || randomUUID(),
  });
}

async function prepareImageConversation(
  config: ApiConfig,
  prompt: string,
  options: WebConversationRequestOptions
) {
  const path = "/backend-api/f/conversation/prepare";
  const systemHints = options.systemHints ?? ["picture_v2"];
  const { modelParameters } = webConversationModelRequest(options);
  const response = await fetchChatGptWeb(config, path, path, {
    method: "POST",
    signal: config.signal,
    headers: prepareConversationHeaders(config, path, options.turnTraceId),
    body: JSON.stringify({
      action: "next",
      ...(options.continuation?.useNativeContinuation
        ? { conversation_id: options.continuation.conversationId }
        : {}),
      parent_message_id: options.parentMessageId,
      ...modelParameters,
      client_prepare_state: "none",
      client_prepare_dispatch: "debounced",
      client_prepare_source: "composer_editor_state",
      timezone_offset_min: -480,
      timezone: "Asia/Shanghai",
      conversation_mode: { kind: "primary_assistant" },
      system_hints: systemHints,
      model_response_contracts: WEB_MODEL_RESPONSE_CONTRACTS,
      partial_query: {
        id: randomUUID(),
        author: { role: "user" },
        content: { content_type: "text", parts: [prompt] },
      },
      supports_buffering: true,
      supported_encodings: ["v1"],
      local_function_names: WEB_LOCAL_FUNCTION_NAMES,
      client_contextual_info: {
        app_name: "chatgpt.com",
        has_web_push_capabilities: true,
        web_push_notification_permission: "default",
      },
    }),
  });
  if (!response.ok) {
    throw new Error(await webErrorMessage(response, "ChatGPT Web prepare"));
  }
  const data = (await response.json()) as { conduit_token?: string };
  return data.conduit_token || "";
}

/** 构造正式用户消息；普通 Images/Work 使用最新 metadata，文件模式保留其独立旧协议。 */
function buildMessage(
  prompt: string,
  references: UploadedAttachment[],
  messageId: string,
  // 图片生成用 ["picture_v2"];可编辑文件(PPT/PSD)生成传 [](gpt-5-5-thinking + 代码解释器)。
  systemHints: string[] = ["picture_v2"],
  metadataProfile: "conversation" | "editable-file" = "conversation"
) {
  const parts = references.map((item) => ({
    content_type: item.content_type,
    asset_pointer: `file-service://${item.file_id}`,
    ...(item.width && item.height
      ? {
          width: item.width,
          height: item.height,
        }
      : {}),
    size_bytes: item.file_size,
    name: item.file_name,
    mime_type: item.mime_type,
  })) as Array<Record<string, unknown> | string>;
  parts.push(prompt);
  return {
    id: messageId,
    author: { role: "user" },
    create_time: Date.now() / 1000,
    content: references.length
      ? { content_type: "multimodal_text", parts }
      : { content_type: "text", parts: [prompt] },
    metadata: {
      ...(metadataProfile === "editable-file"
        ? { system_hints: systemHints }
        : systemHints.length
          ? { system_hints: systemHints }
          : { selected_sources: [] }),
      serialization_metadata: { custom_symbol_offsets: [] },
      ...(metadataProfile === "conversation"
        ? { submission_mode: "manual_send" }
        : {}),
      ...(references.length
        ? {
            attachments: references.map((item) => ({
              id: item.file_id,
              mimeType: item.mime_type,
              name: item.file_name,
              size: item.file_size,
              ...(item.width && item.height
                ? {
                    width: item.width,
                    height: item.height,
                  }
                : {}),
            })),
          }
        : {}),
    },
  };
}

async function startImageGeneration(
  config: ApiConfig,
  prompt: string,
  requirements: ChatRequirements,
  conduitToken: string,
  options: WebConversationSubmitOptions,
  references: UploadedAttachment[]
) {
  const path = "/backend-api/f/conversation";
  const systemHints = options.systemHints ?? ["picture_v2"];
  const { forceParallelSwitch, modelParameters } =
    webConversationModelRequest(options);
  const response = await fetchChatGptWeb(config, path, path, {
    method: "POST",
    signal: config.signal,
    headers: imageHeaders(config, path, requirements, {
      conduitToken,
      turnTraceId: options.turnTraceId,
    }),
    body: JSON.stringify({
      action: "next",
      messages: [
        buildMessage(prompt, references, options.requestMessageId, systemHints),
      ],
      ...(options.continuation?.useNativeContinuation
        ? { conversation_id: options.continuation.conversationId }
        : {}),
      parent_message_id: options.parentMessageId,
      ...modelParameters,
      client_prepare_state: "success",
      timezone_offset_min: -480,
      timezone: "Asia/Shanghai",
      conversation_mode: { kind: "primary_assistant" },
      enable_message_followups: true,
      system_hints: systemHints,
      model_response_contracts: WEB_MODEL_RESPONSE_CONTRACTS,
      supports_buffering: true,
      supported_encodings: ["v1"],
      local_function_names: WEB_LOCAL_FUNCTION_NAMES,
      client_contextual_info: {
        is_dark_mode: false,
        time_since_loaded: 1200,
        page_height: 1072,
        page_width: 1724,
        pixel_ratio: 1.2,
        screen_height: WEB_SCREEN_HEIGHT,
        screen_width: WEB_SCREEN_WIDTH,
        app_name: "chatgpt.com",
        has_web_push_capabilities: true,
        web_push_notification_permission: "default",
      },
      paragen_cot_summary_display_override: "allow",
      force_parallel_switch: forceParallelSwitch,
    }),
  });
  if (!response.ok) {
    throw new Error(
      await webErrorMessage(response, "ChatGPT Web image request")
    );
  }
  return response;
}

async function readSseText(response: Response) {
  return response.text();
}

function extractConversationId(text: string) {
  const matches = [...text.matchAll(/"conversation_id"\s*:\s*"([^"]+)"/g)];
  return matches.at(-1)?.[1] || "";
}

function messageIdFromValue(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.id === "string") return record.id;
  const message = record.message;
  if (message && typeof message === "object") {
    const id = (message as Record<string, unknown>).id;
    if (typeof id === "string") return id;
  }
  return "";
}

function metadataString(value: unknown, key: string) {
  return isRecord(value) && typeof value[key] === "string"
    ? (value[key] as string)
    : "";
}

function messageMetadataFromValue(value: unknown) {
  if (!isRecord(value)) return {};
  if (isRecord(value.metadata)) return value.metadata;
  if (isRecord(value.message) && isRecord(value.message.metadata)) {
    return value.message.metadata;
  }
  return {};
}

function selectedImageMessageIdFromValue(value: unknown) {
  return metadataString(
    messageMetadataFromValue(value),
    "selected_image_message_id"
  );
}

function extractLastMessageId(text: string) {
  let messageId = "";
  const normalized = text.replace(/\r\n/g, "\n");
  for (const block of normalized.split("\n\n")) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]" || data === "v1") continue;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }
    if (!payload || typeof payload !== "object") continue;
    const record = payload as Record<string, unknown>;
    const directId = messageIdFromValue(record);
    if (directId) messageId = directId;
    const valueId = messageIdFromValue(record.v);
    if (valueId) messageId = valueId;
    if (Array.isArray(record.v)) {
      for (const item of record.v) {
        const patchId = messageIdFromValue(
          item && typeof item === "object"
            ? (item as Record<string, unknown>).v
            : undefined
        );
        if (patchId) messageId = patchId;
      }
    }
  }
  return messageId;
}

function extractSelectionMessageId(text: string) {
  let selectionMessageId = "";
  const normalized = text.replace(/\r\n/g, "\n");
  for (const block of normalized.split("\n\n")) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]" || data === "v1") continue;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }
    if (!isRecord(payload)) continue;
    const directSelected = selectedImageMessageIdFromValue(payload);
    const directId = messageIdFromValue(payload);
    if (directSelected && directId) selectionMessageId = directId;
    const valueSelected = selectedImageMessageIdFromValue(payload.v);
    const valueId = messageIdFromValue(payload.v);
    if (valueSelected && valueId) selectionMessageId = valueId;
    if (Array.isArray(payload.v)) {
      for (const item of payload.v) {
        const value = isRecord(item) ? item.v : undefined;
        const patchSelected = selectedImageMessageIdFromValue(value);
        const patchId = messageIdFromValue(value);
        if (patchSelected && patchId) selectionMessageId = patchId;
      }
    }
  }
  return selectionMessageId;
}

function extractImageIds(text: string) {
  const fileIds = new Set<string>();
  const sedimentIds = new Set<string>();
  for (const match of text.matchAll(/file-service:\/\/([A-Za-z0-9_-]+)/g)) {
    const id = match[1];
    if (id && id !== "file_upload") fileIds.add(id);
  }
  for (const match of text.matchAll(/sediment:\/\/([A-Za-z0-9_-]+)/g)) {
    if (match[1]) sedimentIds.add(match[1]);
  }
  return { fileIds: [...fileIds], sedimentIds: [...sedimentIds] };
}

type WebImageCandidate = {
  fileIds: string[];
  sedimentIds: string[];
  messageId?: string;
  groupId?: string;
  generationIndex?: number;
};

type WebImageIds = ReturnType<typeof extractImageIds>;

function emptyImageIds(): WebImageIds {
  return { fileIds: [], sedimentIds: [] };
}

function hasImageIds(ids: WebImageIds) {
  return ids.fileIds.length > 0 || ids.sedimentIds.length > 0;
}

function imageIdsFromCandidate(candidate: WebImageCandidate): WebImageIds {
  return {
    fileIds: candidate.fileIds,
    sedimentIds: candidate.sedimentIds,
  };
}

function mergeImageCandidates(candidates: WebImageCandidate[]) {
  const byKey = new Map<string, WebImageCandidate>();
  for (const candidate of candidates) {
    const ids = imageIdsFromCandidate(candidate);
    if (!hasImageIds(ids)) continue;
    const key =
      candidate.messageId ||
      `${candidate.fileIds.join(",")}|${candidate.sedimentIds.join(",")}`;
    const previous = byKey.get(key);
    byKey.set(key, {
      fileIds: dedupeStrings([
        ...(previous?.fileIds || []),
        ...candidate.fileIds,
      ]),
      sedimentIds: dedupeStrings([
        ...(previous?.sedimentIds || []),
        ...candidate.sedimentIds,
      ]),
      messageId: candidate.messageId || previous?.messageId,
      groupId: candidate.groupId || previous?.groupId,
      generationIndex: candidate.generationIndex ?? previous?.generationIndex,
    });
  }
  return [...byKey.values()].sort((left, right) => {
    const leftIndex = left.generationIndex ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = right.generationIndex ?? Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    return 0;
  });
}

function dedupeStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function mergeImageIds(...items: WebImageIds[]) {
  return {
    fileIds: dedupeStrings(items.flatMap((item) => item.fileIds)),
    sedimentIds: dedupeStrings(items.flatMap((item) => item.sedimentIds)),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getConversationMapping(data: unknown) {
  if (!isRecord(data) || !isRecord(data.mapping)) return null;
  return data.mapping;
}

function conversationNodeParentId(node: unknown) {
  if (!isRecord(node)) return "";
  if (typeof node.parent === "string") return node.parent;
  if (typeof node.parent_id === "string") return node.parent_id;
  const message = node.message;
  if (isRecord(message) && isRecord(message.metadata)) {
    const parentId = message.metadata.parent_id;
    if (typeof parentId === "string") return parentId;
  }
  return "";
}

function conversationNodeId(node: unknown, fallbackId = "") {
  if (!isRecord(node)) return fallbackId;
  if (isRecord(node.message) && typeof node.message.id === "string") {
    return node.message.id;
  }
  if (typeof node.id === "string") return node.id;
  return fallbackId;
}

function conversationNodeCreateTime(node: unknown) {
  if (!isRecord(node)) return null;
  const direct = Number(node.create_time);
  if (Number.isFinite(direct)) return direct;
  if (isRecord(node.message)) {
    const messageCreateTime = Number(node.message.create_time);
    if (Number.isFinite(messageCreateTime)) return messageCreateTime;
  }
  return null;
}

function directConversationChildren(
  mapping: Record<string, unknown>,
  parentId: string
) {
  const ids = new Set<string>();
  const parentNode = mapping[parentId];
  if (isRecord(parentNode) && Array.isArray(parentNode.children)) {
    for (const child of parentNode.children) {
      if (typeof child === "string") ids.add(child);
    }
  }
  for (const [id, node] of Object.entries(mapping)) {
    if (conversationNodeParentId(node) === parentId) ids.add(id);
  }
  return [...ids];
}

function descendantConversationNodes(
  mapping: Record<string, unknown>,
  parentId: string
) {
  const nodes: Array<{ id: string; node: unknown }> = [];
  const queue = directConversationChildren(mapping, parentId);
  const seen = new Set<string>([parentId]);
  while (queue.length) {
    const id = queue.shift() || "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const node = mapping[id];
    if (!node) continue;
    nodes.push({ id, node });
    queue.push(...directConversationChildren(mapping, id));
  }
  return nodes;
}

function findConversationNode(
  mapping: Record<string, unknown>,
  messageId: string
) {
  if (!messageId) return null;
  if (mapping[messageId]) {
    return { id: messageId, node: mapping[messageId] };
  }
  for (const [id, node] of Object.entries(mapping)) {
    if (conversationNodeId(node, id) === messageId) return { id, node };
  }
  return null;
}

function conversationNodesAfterCreateTime(
  mapping: Record<string, unknown>,
  requestMessageId: string
) {
  const request = findConversationNode(mapping, requestMessageId);
  const requestCreateTime = conversationNodeCreateTime(request?.node);
  if (requestCreateTime === null) return [];

  return Object.entries(mapping)
    .filter(([id, node]) => {
      const nodeId = conversationNodeId(node, id);
      if (request && id === request.id) return false;
      if (nodeId === requestMessageId) return false;
      const createTime = conversationNodeCreateTime(node);
      return createTime !== null && createTime >= requestCreateTime;
    })
    .sort(([, left], [, right]) => {
      const leftTime = conversationNodeCreateTime(left) ?? 0;
      const rightTime = conversationNodeCreateTime(right) ?? 0;
      return leftTime - rightTime;
    })
    .map(([id, node]) => ({ id, node }));
}

function mergeConversationNodes(
  ...lists: Array<Array<{ id: string; node: unknown }>>
) {
  const merged: Array<{ id: string; node: unknown }> = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const item of list) {
      const id = conversationNodeId(item.node, item.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      merged.push(item);
    }
  }
  return merged;
}

function conversationNodesAfterMessage(
  conversationText: string,
  requestMessageId: string
) {
  if (!conversationText || !requestMessageId) return [];
  let data: unknown;
  try {
    data = JSON.parse(conversationText);
  } catch {
    return [];
  }
  const turnNodes = getWebConversationTurnNodes(data, requestMessageId);
  if (turnNodes !== null) return turnNodes;
  const mapping = getConversationMapping(data);
  if (!mapping) return [];

  const currentNode =
    isRecord(data) && typeof data.current_node === "string"
      ? data.current_node
      : "";
  const chain: Array<{ id: string; node: unknown }> = [];
  const seen = new Set<string>();
  let cursor = currentNode;
  let reachedRequest = false;
  while (cursor && !seen.has(cursor)) {
    if (cursor === requestMessageId) {
      reachedRequest = true;
      break;
    }
    seen.add(cursor);
    const node = mapping[cursor];
    if (!node) break;
    chain.push({ id: cursor, node });
    cursor = conversationNodeParentId(node);
  }
  const request = findConversationNode(mapping, requestMessageId);
  const descendantNodes = descendantConversationNodes(
    mapping,
    request?.id || requestMessageId
  );
  const temporalNodes = conversationNodesAfterCreateTime(
    mapping,
    requestMessageId
  );

  return mergeConversationNodes(
    reachedRequest ? chain.reverse() : [],
    descendantNodes,
    temporalNodes
  );
}

function scopedConversationTextAfterMessage(
  conversationText: string,
  requestMessageId: string
) {
  return conversationNodesAfterMessage(conversationText, requestMessageId)
    .map(({ node }) => JSON.stringify(node))
    .join("\n");
}

function imageIdsFromJson(value: unknown): WebImageIds {
  return extractImageIds(JSON.stringify(value));
}

function imageCandidateFromConversationNode(
  id: string,
  node: unknown
): WebImageCandidate | null {
  const ids = imageIdsFromJson(node);
  if (!hasImageIds(ids)) return null;
  const metadata = messageMetadataFromValue(node);
  const generationIndex = Number(metadata.generation_index);
  return {
    ...ids,
    messageId: conversationNodeId(node, id),
    groupId: metadataString(metadata, "image_gen_group_id"),
    generationIndex: Number.isFinite(generationIndex)
      ? generationIndex
      : undefined,
  };
}

function imageCandidatesAfterMessage(
  conversationText: string,
  requestMessageId: string
) {
  return mergeImageCandidates(
    conversationNodesAfterMessage(conversationText, requestMessageId).flatMap(
      ({ id, node }) => {
        if (nodeAuthorRole(node) === "user") return [];
        const candidate = imageCandidateFromConversationNode(id, node);
        return candidate ? [candidate] : [];
      }
    )
  );
}

function imageSelectionAfterMessage(
  conversationText: string,
  requestMessageId: string
) {
  for (const { id, node } of conversationNodesAfterMessage(
    conversationText,
    requestMessageId
  )) {
    const selectedImageMessageId = selectedImageMessageIdFromValue(node);
    const messageId = conversationNodeId(node, id);
    if (selectedImageMessageId && messageId) {
      return { messageId, selectedImageMessageId };
    }
  }
  return { messageId: "", selectedImageMessageId: "" };
}

function latestConversationMessageIdAfter(
  conversationText: string,
  requestMessageId: string
) {
  const nodes = conversationNodesAfterMessage(
    conversationText,
    requestMessageId
  );
  const latest = nodes.at(-1);
  return latest ? conversationNodeId(latest.node, latest.id) : "";
}

// ===== 网页对话(文字问答)文本抽取 =====
//
// WHY:图像路径注入 picture_v2 强制出图,只回图不回文字。网页对话不注入 picture_v2,模型像
// 正常 ChatGPT 那样回文字、仅在被要求时出图。这里从会话 mapping 里抽出 assistant 的最终文字答复
// (content_type=text/multimodal_text 的 parts),跳过 thoughts/reasoning 中间节点;并据 end_turn
// 判定 turn 是否收尾,供轮询决定何时返回。

/** 取节点内层的 message 对象(节点可能直接是 message,也可能包一层 {message})。 */
function nodeMessageObject(node: unknown): Record<string, unknown> | null {
  if (!isRecord(node)) return null;
  if (isRecord(node.message)) return node.message;
  if (isRecord(node.content) && isRecord(node.author)) return node;
  return null;
}

/** 节点的 author.role(user/assistant/tool/system)。 */
function nodeAuthorRole(node: unknown): string {
  const message = nodeMessageObject(node);
  const author = message && isRecord(message.author) ? message.author : null;
  return author && typeof author.role === "string" ? author.role : "";
}

/**
 * 节点的文字内容:仅 content_type=text/multimodal_text 的字符串 parts 拼接;
 * thoughts/reasoning/code 等非最终答复内容返回空。
 */
function nodeTextContent(node: unknown): string {
  const message = nodeMessageObject(node);
  const content = message && isRecord(message.content) ? message.content : null;
  if (!content) return "";
  const type =
    typeof content.content_type === "string" ? content.content_type : "";
  if (type !== "text" && type !== "multimodal_text") return "";
  const parts = Array.isArray(content.parts) ? content.parts : [];
  return parts
    .filter((part): part is string => typeof part === "string")
    .join("")
    .trim();
}

/** turn 是否已收尾(最终 assistant 文字节点带 end_turn=true)。 */
function nodeEndTurn(node: unknown): boolean {
  const message = nodeMessageObject(node);
  return Boolean(message && message.end_turn === true);
}

/**
 * 从 requestMessageId 之后的节点里抽出 assistant 最终文字答复。
 * text:最后一条 assistant text 节点的内容(定稿答复);complete:该 turn 是否已 end_turn 收尾。
 */
function extractAssistantAnswer(
  conversationText: string,
  requestMessageId: string
): { text: string; complete: boolean } {
  let text = "";
  let complete = false;
  for (const { node } of conversationNodesAfterMessage(
    conversationText,
    requestMessageId
  )) {
    if (nodeAuthorRole(node) !== "assistant") continue;
    const message = nodeMessageObject(node);
    // Work 的 analysis 也可能是 text；只有面向用户的最终通道可作为答复，空终稿也必须收尾。
    if (typeof message?.channel === "string" && message.channel !== "final")
      continue;
    if (typeof message?.recipient === "string" && message.recipient !== "all")
      continue;
    const part = nodeTextContent(node);
    if (part) text = part;
    if (nodeEndTurn(node)) {
      text = part;
      complete = true;
    }
  }
  return { text, complete };
}

/**
 * 从 ChatGPT web 流式增量(o/v 操作)里抽出"系统错误"消息(content_type=system_error)。
 *
 * WHY:ChatGPT 无法调用画图工具时不会返回图片,而是塞一条 author.role="tool"、
 * content.content_type="system_error" 的消息(典型 name=ChatGPTAgentToolRateLimitException,
 * 即 image_gen.text2im 工具被账号级限流)。若不在此抽出,下游只会看到 "no image output",
 * 既无法归类为限流(短冷却 + 换号重试),也丢失可读原因与 SLA 可观测性。
 * 返回 name + text 拼接;name 一定在首个 add 分片里,即使 text 后续才 append 也够归类。
 */
function extractWebSystemError(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  const content = record.content;
  if (content && typeof content === "object") {
    const c = content as Record<string, unknown>;
    if (c.content_type === "system_error") {
      const name = typeof c.name === "string" ? c.name : "";
      const text =
        typeof c.text === "string"
          ? c.text
          : Array.isArray(c.parts)
            ? c.parts
                .filter((part): part is string => typeof part === "string")
                .join(" ")
            : "";
      const combined = `${name} ${text}`.replace(/\s+/g, " ").trim();
      if (combined) return combined.slice(0, 500);
    }
  }
  for (const value of Object.values(record)) {
    if (value && typeof value === "object") {
      const nested = extractWebSystemError(value);
      if (nested) return nested;
    }
  }
  return "";
}

function extractWebStreamError(text: string) {
  const normalized = text.replace(/\r\n/g, "\n");
  for (const block of normalized.split("\n\n")) {
    if (!block.trim()) continue;
    let eventName = "";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const separatorIndex = line.indexOf(":");
      const field =
        separatorIndex === -1 ? line : line.slice(0, separatorIndex);
      const rawValue =
        separatorIndex === -1 ? "" : line.slice(separatorIndex + 1);
      const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
      if (field === "event") eventName = value;
      if (field === "data") dataLines.push(value);
    }
    const data = dataLines.join("\n").trim();
    if (!data || data === "[DONE]") continue;
    let payload: Record<string, unknown> | null = null;
    try {
      payload = JSON.parse(data) as Record<string, unknown>;
    } catch {
      payload = null;
    }
    // 系统错误(工具限流等)优先抽出:它代表本次确定性失败,且要让下游按限流归类,
    // 不能落到 "no image output" 兜底。
    const systemError = payload ? extractWebSystemError(payload) : "";
    if (systemError) return systemError;
    const message = payload ? webErrorPayloadMessage(payload) : "";
    const code =
      typeof payload?.code === "string"
        ? payload.code
        : payload?.error &&
            typeof payload.error === "object" &&
            "code" in payload.error &&
            typeof (payload.error as { code?: unknown }).code === "string"
          ? (payload.error as { code: string }).code
          : "";
    if (
      eventName.toLowerCase().includes("error") ||
      String(payload?.type || "")
        .toLowerCase()
        .includes("error") ||
      /usage limit|usage_limit|rate limit|rate_limit|too many requests|quota|limit has been reached|limit_reached|billing_hard_limit/i.test(
        `${message} ${code} ${data}`
      )
    ) {
      // 抽到可读字段才返回;否则绝不回显原始 o/v 协议分片(那会把
      // {"o":"add","v":{...}} 整段甩给用户)。落到下方按全文抽取限流/配额关键词短语。
      if (message || code) return message || code;
    }
  }
  const match = text.match(
    /(usage limit[^"\n]*|usage_limit[^"\n]*|limit has been reached[^"\n]*|limit_reached[^"\n]*|rate limit[^"\n]*|rate_limit[^"\n]*|too many requests[^"\n]*|(?:the )?quota (?:has been )?exceeded[^"\n]*|billing_hard_limit[^"\n]*)/i
  );
  return match?.[1] || "";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 读取抓包验证的最新十轮消息；只有端点不存在时回退旧 mapping 协议。
 * 限流、鉴权与服务错误直接交给轮询层处理，避免重复请求放大故障；不保存会话内容。
 */
async function getConversationText(
  config: ApiConfig,
  conversationId: string,
  signal?: AbortSignal
) {
  const encodedId = encodeURIComponent(conversationId);
  const path = `/backend-api/conversations/${encodedId}?include_has_versions=true&num_turns=10`;
  let response = await fetchChatGptWeb(config, path, path, {
    signal,
    headers: getHeaders(config, path, { Accept: "application/json" }),
  });
  if ([404, 405, 410].includes(response.status)) {
    const legacyPath = `/backend-api/conversation/${encodedId}`;
    response = await fetchChatGptWeb(config, legacyPath, legacyPath, {
      signal,
      headers: getHeaders(config, legacyPath, { Accept: "application/json" }),
    });
  }
  if (!response.ok) {
    throw new Error(
      await webErrorMessage(response, "ChatGPT Web conversation")
    );
  }
  return JSON.stringify(await response.json());
}

function latestConversationMessageId(text: string) {
  if (!text) return "";
  try {
    const data = JSON.parse(text) as { current_node?: unknown };
    if (typeof data.current_node === "string") return data.current_node;
  } catch {
    /* fall back to scanning below */
  }
  const idMatches = [...text.matchAll(/"id"\s*:\s*"([^"]+)"/g)];
  return idMatches.at(-1)?.[1] || "";
}

// 会话查询是否被限流(429/too many requests):供轮询容错时加大退避。
function isWebRateLimited(message: string) {
  return /429|too many requests|rate limit/i.test(message);
}

async function pollImageIds(
  config: ApiConfig,
  conversationId: string,
  requestMessageId?: string,
  signal?: AbortSignal
) {
  const deadline = Date.now() + IMAGE_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    let text: string;
    try {
      text = await getConversationText(config, conversationId, signal);
    } catch (error) {
      // 单次状态查询失败(典型 429 会话查询限流 / 交接期瞬时错误)不该拖垮整次生成:
      // 真 abort/超时上抛;否则按是否限流决定退避时长后继续轮询。
      throwIfAborted(signal);
      const message = error instanceof Error ? error.message : String(error);
      await sleep(IMAGE_POLL_INTERVAL_MS * (isWebRateLimited(message) ? 3 : 1));
      continue;
    }
    const scopedText = requestMessageId
      ? scopedConversationTextAfterMessage(text, requestMessageId)
      : text;
    const ids = extractImageIds(scopedText);
    if (hasImageIds(ids)) {
      return {
        ids,
        parentMessageId: requestMessageId
          ? latestConversationMessageIdAfter(text, requestMessageId)
          : latestConversationMessageId(text),
      };
    }
    await sleep(IMAGE_POLL_INTERVAL_MS);
  }
  return { ids: emptyImageIds(), parentMessageId: "" };
}

async function pollImageCandidates(
  config: ApiConfig,
  conversationId: string,
  requestMessageId: string,
  signal?: AbortSignal
) {
  const deadline = Date.now() + IMAGE_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    let text: string;
    try {
      text = await getConversationText(config, conversationId, signal);
    } catch (error) {
      // 单次状态查询失败(典型 429 会话查询限流 / 交接期瞬时错误)不该拖垮整次生成:
      // 真 abort/超时上抛;否则按是否限流决定退避时长后继续轮询。
      throwIfAborted(signal);
      const message = error instanceof Error ? error.message : String(error);
      await sleep(IMAGE_POLL_INTERVAL_MS * (isWebRateLimited(message) ? 3 : 1));
      continue;
    }
    const candidates = imageCandidatesAfterMessage(text, requestMessageId);
    if (candidates.length) {
      const selection = imageSelectionAfterMessage(text, requestMessageId);
      return {
        candidates,
        selectionMessageId: selection.messageId,
        selectedImageMessageId: selection.selectedImageMessageId,
        parentMessageId: latestConversationMessageIdAfter(
          text,
          requestMessageId
        ),
      };
    }
    await sleep(IMAGE_POLL_INTERVAL_MS);
  }
  return { candidates: [], parentMessageId: "" };
}

async function getDownloadUrl(
  config: ApiConfig,
  path: string,
  signal?: AbortSignal
) {
  const response = await fetchChatGptWeb(config, path, path, {
    signal,
    headers: getHeaders(config, path, { Accept: "application/json" }),
  });
  if (!response.ok) {
    throw new Error(
      await webErrorMessage(response, "ChatGPT Web image lookup")
    );
  }
  const data = (await response.json()) as {
    download_url?: string;
    url?: string;
  };
  return data.download_url || data.url || "";
}

async function resolveImageUrls(
  config: ApiConfig,
  conversationId: string,
  ids: WebImageIds,
  requestMessageId?: string,
  signal?: AbortSignal
) {
  const polled =
    conversationId && requestMessageId
      ? await pollImageIds(config, conversationId, requestMessageId, signal)
      : null;
  const scopedHasIds = hasImageIds(polled?.ids || emptyImageIds());
  const shouldPollUnscoped =
    conversationId && !requestMessageId && !hasImageIds(ids) && !scopedHasIds;
  const unscopedPolled =
    !polled && shouldPollUnscoped
      ? await pollImageIds(config, conversationId, undefined, signal)
      : null;
  const resolvedIds = scopedHasIds
    ? mergeImageIds(polled?.ids || emptyImageIds(), ids)
    : hasImageIds(unscopedPolled?.ids || emptyImageIds())
      ? unscopedPolled?.ids || ids
      : ids;
  const urls: string[] = [];
  for (const fileId of resolvedIds.fileIds) {
    const url = await getDownloadUrl(
      config,
      `/backend-api/files/${fileId}/download`,
      signal
    );
    if (url) urls.push(url);
  }
  const uniqueUrls = dedupeStrings(urls);
  if (urls.length || !conversationId) {
    return {
      urls: uniqueUrls,
      parentMessageId:
        polled?.parentMessageId || unscopedPolled?.parentMessageId || "",
    };
  }
  for (const sedimentId of resolvedIds.sedimentIds) {
    const url = await getDownloadUrl(
      config,
      `/backend-api/conversation/${conversationId}/attachment/${sedimentId}/download`,
      signal
    );
    if (url) urls.push(url);
  }
  return {
    urls: dedupeStrings(urls),
    parentMessageId:
      polled?.parentMessageId || unscopedPolled?.parentMessageId || "",
  };
}

async function resolveImageCandidateUrls(
  config: ApiConfig,
  conversationId: string,
  streamIds: WebImageIds,
  requestMessageId?: string,
  signal?: AbortSignal
) {
  const polled =
    conversationId && requestMessageId
      ? await pollImageCandidates(
          config,
          conversationId,
          requestMessageId,
          signal
        )
      : null;
  const candidates = polled?.candidates.length
    ? polled.candidates
    : hasImageIds(streamIds)
      ? [{ ...streamIds }]
      : [];
  const outputs: Array<{
    url: string;
    messageId?: string;
    groupId?: string;
    generationIndex?: number;
  }> = [];

  for (const candidate of mergeImageCandidates(candidates)) {
    const urls: string[] = [];
    for (const fileId of candidate.fileIds) {
      const url = await getDownloadUrl(
        config,
        `/backend-api/files/${fileId}/download`,
        signal
      );
      if (url) urls.push(url);
    }
    for (const sedimentId of candidate.sedimentIds) {
      const url = await getDownloadUrl(
        config,
        `/backend-api/conversation/${conversationId}/attachment/${sedimentId}/download`,
        signal
      );
      if (url) urls.push(url);
    }
    for (const url of dedupeStrings(urls)) {
      outputs.push({
        url,
        messageId: candidate.messageId,
        groupId: candidate.groupId,
        generationIndex: candidate.generationIndex,
      });
    }
  }

  if (!outputs.length) {
    const fallback = await resolveImageUrls(
      config,
      conversationId,
      streamIds,
      requestMessageId,
      signal
    );
    for (const url of fallback.urls) outputs.push({ url });
    return {
      outputs,
      selectionMessageId: polled?.selectionMessageId || "",
      selectedImageMessageId: polled?.selectedImageMessageId || "",
      parentMessageId: fallback.parentMessageId,
    };
  }

  return {
    outputs,
    selectionMessageId: polled?.selectionMessageId || "",
    selectedImageMessageId: polled?.selectedImageMessageId || "",
    parentMessageId: polled?.parentMessageId || "",
  };
}

async function downloadImage(
  config: ApiConfig,
  url: string,
  signal?: AbortSignal
) {
  const response = await fetch(url, {
    signal,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "User-Agent": USER_AGENT,
    },
  });
  if (!response.ok) {
    throw new Error(
      `ChatGPT Web image download failed: HTTP ${response.status}`
    );
  }
  return Buffer.from(await response.arrayBuffer()).toString("base64");
}

async function downloadImageOutputs(
  config: ApiConfig,
  images: Array<{
    url: string;
    messageId?: string;
    groupId?: string;
    generationIndex?: number;
  }>,
  signal?: AbortSignal
) {
  const outputs: NonNullable<GenerateImageResult["imageOutputs"]> = [];
  const seenUrls = new Set<string>();
  for (const image of images) {
    if (!image.url || seenUrls.has(image.url)) continue;
    seenUrls.add(image.url);
    try {
      outputs.push({
        imageBase64: await downloadImage(config, image.url, signal),
        webImageMessageId: image.messageId,
        webImageGroupId: image.groupId,
        index: outputs.length,
        outputRole: images.length > 1 ? "choice" : "final",
      });
    } catch (error) {
      logError(error, {
        source: "chatgpt-web-image-download",
        backendId: config.backend?.id,
      });
    }
  }
  return outputs;
}

function imageBase64Sha256(imageBase64: string) {
  return createHash("sha256")
    .update(Buffer.from(imageBase64, "base64"))
    .digest("hex");
}

function inputImageSha256Set(images: ImageInputFile[]) {
  return new Set(
    images
      .map((image) =>
        image.data?.length
          ? createHash("sha256").update(image.data).digest("hex")
          : ""
      )
      .filter(Boolean)
  );
}

function outputMatchesInputImage(
  imageOutputs: NonNullable<GenerateImageResult["imageOutputs"]>,
  images: ImageInputFile[]
) {
  if (!imageOutputs.length || !images.length) return false;
  const inputHashes = inputImageSha256Set(images);
  if (!inputHashes.size) return false;
  return imageOutputs.some((output) => {
    if (!output.imageBase64) return false;
    return inputHashes.has(imageBase64Sha256(output.imageBase64));
  });
}

// 在飞「续接对话」占用集合:同一 ChatGPT 会话同一时刻只允许一个请求续接。并发的同提示
// 请求(读到同一旧会话状态)只放行第一个续接,其余强制开新对话,避免同时从同一节点分叉、
// 产出几乎一样的图。进程内即可:线上正常流量全打主副本(3308),备副本仅 failover 启用。
const inflightWebContinuations = new Set<string>();

// 非原生续接时随 prompt 带上的历史文字转录上限(字符)。图不完全附带(见 downloadRecentWebHistory
// Images 的 limit),但历史文字尽量带上、控制在此上限内(保留最近轮次)。
const WEB_HISTORY_TRANSCRIPT_MAX_CHARS = 6000;

/**
 * 非原生续接时,把历史文字转录作为上下文前置到当前请求前(图另行以附件重附)。
 * 明确标注为"仅供理解上下文",避免模型把历史文字直接画进图/复述。
 */
function withWebHistoryContext(prompt: string, transcript: string) {
  if (!transcript) return prompt;
  return (
    "以下是之前的对话记录,仅供你理解上下文(不要把这些文字直接画进图或原样复述):\n" +
    `${transcript}\n\n请据此完成当前请求:\n${prompt}`
  );
}

// 非原生续接(换号/开新会话)时,把最近若干历史图(assistant 生成图 + 用户上传参考图)下成
// 附件重新带上,弥补 ChatGPT 会话上下文丢失。下载失败的单张跳过,不阻断整轮。
async function downloadRecentWebHistoryImages(
  history: ChatHistoryMessage[] | undefined,
  signal: AbortSignal,
  limit = 3
): Promise<ImageInputFile[]> {
  const references = getRecentWebHistoryImageReferences(history, { limit });
  const downloaded = await Promise.all(
    references.map((reference) =>
      downloadWebHistoryImageReference(reference, { signal }).catch(() => null)
    )
  );
  return downloaded.filter((image): image is ImageInputFile => image !== null);
}

async function runWebImage(
  config: ApiConfig,
  params: WebImageParams,
  images: ImageInputFile[]
): Promise<GenerateImageResult> {
  // Web 默认图片引擎为 GPT Image 2.5，沿用 picture_v2 发起请求，无需 API 风格的图片版本字段。
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 20 * 60 * 1000);
  const abortFromParent = () => abortController.abort(params.signal?.reason);
  if (params.signal?.aborted) {
    abortFromParent();
  } else {
    params.signal?.addEventListener("abort", abortFromParent, { once: true });
  }
  // 本次若成功占用某会话续接,记下其 id,在 finally 释放。
  let claimedWebConversationId: string | null = null;
  try {
    const configWithSignal = { ...config, signal: abortController.signal };
    const requestMessageId = randomUUID();
    let continuation = lastWebConversationState(
      params.history,
      config.backend?.id
    );
    // 并发互斥:该会话已被在飞请求占用则本次改开新对话(continuation=null);后续逻辑
    // (含重新附带历史参考图)沿用既有的 null 分支,故新对话仍会带上 @图 参考图。
    if (continuation?.useNativeContinuation && continuation.conversationId) {
      if (inflightWebContinuations.has(continuation.conversationId)) {
        continuation = null;
      } else {
        inflightWebContinuations.add(continuation.conversationId);
        claimedWebConversationId = continuation.conversationId;
      }
    }
    // 原生续接时 ChatGPT 会话已含历史(文字+图),不重复带;换号/新会话时把历史文字转录前置、
    // 并重附最近历史图(含用户上传),尽量还原多轮上下文。
    const historyTranscript = continuation?.useNativeContinuation
      ? ""
      : buildWebHistoryTranscript(
          params.history,
          WEB_HISTORY_TRANSCRIPT_MAX_CHARS
        );
    const prompt = withWebHistoryContext(
      applyImageSizePrompt(getPrompt(params), params.size),
      historyTranscript
    );
    const historyImages = continuation?.useNativeContinuation
      ? []
      : await downloadRecentWebHistoryImages(
          params.history,
          abortController.signal
        );
    const references = [
      ...(await Promise.all(
        images.map((image, index) =>
          uploadAttachment(configWithSignal, image, index + 1, {
            image: true,
          })
        )
      )),
      ...(await Promise.all(
        historyImages.map((image, index) =>
          uploadAttachment(configWithSignal, image, images.length + index + 1, {
            image: true,
          })
        )
      )),
      ...(await Promise.all(
        (params.files || []).map((file, index) =>
          uploadAttachment(
            configWithSignal,
            file,
            images.length + historyImages.length + index + 1
          )
        )
      )),
    ];
    const requestParentMessageId = continuation?.useNativeContinuation
      ? continuation.parentMessageId
      : randomUUID();
    const requestOptions = {
      gptModel: params.gptModel,
      thinking: params.thinking,
      promptOptimization: params.promptOptimization,
      profile: "images" as const,
      continuation,
      parentMessageId: requestParentMessageId,
      turnTraceId: randomUUID(),
    };
    const resources = await bootstrap(configWithSignal);
    const conduitToken = await prepareImageConversation(
      configWithSignal,
      prompt,
      requestOptions
    );
    const requirements = await getChatRequirements(configWithSignal, resources);
    const launchedAt = Date.now();
    const response = await startImageGeneration(
      configWithSignal,
      prompt,
      requirements,
      conduitToken,
      {
        ...requestOptions,
        requestMessageId,
      },
      references
    );
    const text = await readSseText(response);
    throwIfAborted(abortController.signal);
    const streamError = extractWebStreamError(text);
    if (streamError) {
      return { error: streamError };
    }
    const conversationId = extractConversationId(text);
    let parentMessageId = extractLastMessageId(text);
    const selectionMessageIdFromStream = extractSelectionMessageId(text);
    const ids = extractImageIds(text);
    // 发起后至少静默 IMAGE_POLL_INITIAL_DELAY_MS 再开始轮询状态:web 出图头 ~45s 几乎不可能就绪,
    // 期间轮询纯属无谓请求且会把会话查询端点打到 429。流里已直接带出图则跳过等待(无需轮询)。
    if (!hasImageIds(ids)) {
      const waitMs = IMAGE_POLL_INITIAL_DELAY_MS - (Date.now() - launchedAt);
      if (waitMs > 0) {
        await sleep(waitMs);
        throwIfAborted(abortController.signal);
      }
    }
    const resolved = await resolveImageCandidateUrls(
      configWithSignal,
      conversationId,
      ids,
      requestMessageId,
      abortController.signal
    );
    const candidateImages = resolved.outputs;
    parentMessageId = resolved.parentMessageId || parentMessageId;
    if (conversationId && !parentMessageId) {
      // best-effort:仅为补续接用的 parentMessageId,此处 429/瞬时失败不该拖垮已出图的成功单。
      try {
        parentMessageId = latestConversationMessageId(
          await getConversationText(
            configWithSignal,
            conversationId,
            abortController.signal
          )
        );
      } catch {
        throwIfAborted(abortController.signal);
      }
    }
    if (!candidateImages[0]?.url) {
      // 无图:web 对违规内容常"软拒绝"(picture_v2 不返图,只回一段拒绝文字)。抽出 assistant
      // 文字,若命中内容安全拒绝 → 直接返回该拒绝文案:SLA 归 moderation(真实审核,而非事后
      // 靠后端类型猜的"疑似审核"),且被 isUserRequestBackendError 判为不可切换 → 秒级失败、不再
      // 逐个换号重试同样会被拒的内容一路 churn 到 20 分钟超时。抽不到/非拒绝则退回原 "no image output"。
      try {
        const answer = extractAssistantAnswer(
          await getConversationText(
            configWithSignal,
            conversationId,
            abortController.signal
          ),
          requestMessageId
        );
        if (answer.text && isContentSafetyRejection(answer.text)) {
          return { error: answer.text.slice(0, 500) };
        }
      } catch {
        throwIfAborted(abortController.signal);
      }
      return { error: "ChatGPT Web backend returned no image output" };
    }
    const imageOutputs = await downloadImageOutputs(
      configWithSignal,
      candidateImages,
      abortController.signal
    );
    if (!imageOutputs[0]?.imageBase64) {
      return { error: "ChatGPT Web backend returned no downloadable image" };
    }
    if (outputMatchesInputImage(imageOutputs, images)) {
      return { error: "ChatGPT Web backend returned input image as output" };
    }
    const selectionMessageId =
      selectionMessageIdFromStream || resolved.selectionMessageId || "";
    const selectedImageMessageId =
      resolved.selectedImageMessageId || imageOutputs[0].webImageMessageId;
    return {
      imageBase64: imageOutputs[0].imageBase64,
      imageOutputs,
      imageOutputCount: imageOutputs.length,
      ...(conversationId && parentMessageId
        ? {
            webConversation: {
              conversationId,
              parentMessageId,
              accountId: config.backend?.id,
              apiKeyId: config.backend?.apiKeyId,
              selectionMessageId,
              selectedImageMessageId,
            },
          }
        : {}),
    };
  } catch (error) {
    logError(error, {
      source: "chatgpt-web-image",
      backendId: config.backend?.id,
      requestKind: config.backend?.requestKind,
    });
    return {
      error:
        error instanceof Error ? error.message : "ChatGPT Web image failed",
    };
  } finally {
    clearTimeout(timeout);
    params.signal?.removeEventListener("abort", abortFromParent);
    if (claimedWebConversationId) {
      inflightWebContinuations.delete(claimedWebConversationId);
    }
  }
}

export async function generateImageWithChatGptWeb(
  config: ApiConfig,
  params: GenerateImageParams
) {
  return runWebImage(config, params, []);
}

export async function editImageWithChatGptWeb(
  config: ApiConfig,
  params: EditImageParams
) {
  return runWebImage(config, params, params.images);
}

// ===== 网页对话(文字问答 + 按需出图)=====
//
// WHY:chat(web) tab 是"真正的网页对话"——用户问"这是什么"要回文字,说"画一只猫"才出图,
// 而图像路径(runWebImage)注入 picture_v2 强制出图、返回值只有图,问文字也会硬出图。
// 这里不注入 picture_v2,发用户原始消息,轮询会话抽 assistant 最终文字答复;若模型自发出图
// 则一并抽图下载。返回 { responseText?, imageBase64?, imageOutputs?, webConversation }。
// 复用图像路径的 PoW/Sentinel/上传/续接/下载链路,仅 system_hints 与结果抽取不同。
// 此处按需出图默认使用 GPT Image 2.5，沿用 ChatGPT 网页协议。

const WEB_CHAT_POLL_TIMEOUT_MS = 180_000;
const WEB_CHAT_STALL_MS = 45_000;

/**
 * 轮询会话直到 assistant turn 收尾(或长时间停滞/超时),抽出文字答复与"是否出了图"。
 * WHY 轮询而非解析 SSE:web SSE 是 o/v 增量协议,直接拼文本易错;轮询 mapping 取定稿节点更稳,
 * 且兼容 thinking 模型的异步交接(提交前会话短暂 404)。
 */
async function pollWebChatResult(
  config: ApiConfig,
  conversationId: string,
  requestMessageId: string,
  signal?: AbortSignal
): Promise<{
  responseText: string;
  hasImage: boolean;
  parentMessageId: string;
}> {
  const deadline = Date.now() + WEB_CHAT_POLL_TIMEOUT_MS;
  let bestText = "";
  let hasImage = false;
  let parentMessageId = "";
  let lastText = "";
  let stableSince = 0;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    let text: string;
    try {
      text = await getConversationText(config, conversationId, signal);
    } catch {
      // 交接期瞬时 404/inaccessible 视为未就绪继续轮询;真 abort/超时上抛。
      throwIfAborted(signal);
      await sleep(IMAGE_POLL_INTERVAL_MS);
      continue;
    }
    const answer = extractAssistantAnswer(text, requestMessageId);
    if (answer.text) bestText = answer.text;
    if (imageCandidatesAfterMessage(text, requestMessageId).length) {
      hasImage = true;
    }
    const latestParent = latestConversationMessageIdAfter(
      text,
      requestMessageId
    );
    if (latestParent) parentMessageId = latestParent;
    // turn 收尾即定稿返回(文字答复到手;若也出了图,hasImage 已置位)。
    if (answer.complete) {
      return { responseText: answer.text, hasImage, parentMessageId };
    }
    // fail-safe:会话内容长时间不变但未标 end_turn(偶发未回收的 turn),用已抽到的文本收尾。
    if (text === lastText) {
      if (!stableSince) {
        stableSince = Date.now();
      } else if (
        Date.now() - stableSince >= WEB_CHAT_STALL_MS &&
        (bestText || hasImage)
      ) {
        return { responseText: bestText, hasImage, parentMessageId };
      }
    } else {
      stableSince = 0;
      lastText = text;
    }
    await sleep(IMAGE_POLL_INTERVAL_MS);
  }
  return { responseText: bestText, hasImage, parentMessageId };
}

async function runWebChat(
  config: ApiConfig,
  params: WebImageParams,
  images: ImageInputFile[]
): Promise<GenerateImageResult> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 20 * 60 * 1000);
  const abortFromParent = () => abortController.abort(params.signal?.reason);
  if (params.signal?.aborted) {
    abortFromParent();
  } else {
    params.signal?.addEventListener("abort", abortFromParent, { once: true });
  }
  let claimedWebConversationId: string | null = null;
  try {
    const configWithSignal = { ...config, signal: abortController.signal };
    const requestMessageId = randomUUID();
    let continuation = lastWebConversationState(
      params.history,
      config.backend?.id
    );
    // 并发互斥:同会话被在飞请求占用则本轮改开新对话(同图像路径逻辑)。
    if (continuation?.useNativeContinuation && continuation.conversationId) {
      if (inflightWebContinuations.has(continuation.conversationId)) {
        continuation = null;
      } else {
        inflightWebContinuations.add(continuation.conversationId);
        claimedWebConversationId = continuation.conversationId;
      }
    }
    // 网页对话:发用户原始消息(不用图像优化后的 apiPrompt),不注入 picture_v2。
    // 续接同一会话时上下文已在会话内;换号/新会话时把历史文字转录前置 + 重附最近历史图(含用户
    // 上传参考图),覆盖"上一轮纯文字、参考图是用户上传"及多轮文字上下文的换号丢失场景。
    const historyTranscript = continuation?.useNativeContinuation
      ? ""
      : buildWebHistoryTranscript(
          params.history,
          WEB_HISTORY_TRANSCRIPT_MAX_CHARS
        );
    const prompt = withWebHistoryContext(params.prompt, historyTranscript);
    const historyImages = continuation?.useNativeContinuation
      ? []
      : await downloadRecentWebHistoryImages(
          params.history,
          abortController.signal
        );
    const references = [
      ...(await Promise.all(
        images.map((image, index) =>
          uploadAttachment(configWithSignal, image, index + 1, { image: true })
        )
      )),
      ...(await Promise.all(
        historyImages.map((image, index) =>
          uploadAttachment(configWithSignal, image, images.length + index + 1, {
            image: true,
          })
        )
      )),
      ...(await Promise.all(
        (params.files || []).map((file, index) =>
          uploadAttachment(
            configWithSignal,
            file,
            images.length + historyImages.length + index + 1
          )
        )
      )),
    ];
    const requestParentMessageId = continuation?.useNativeContinuation
      ? continuation.parentMessageId
      : randomUUID();
    const options = {
      gptModel: params.gptModel,
      thinking: params.thinking,
      promptOptimization: params.promptOptimization,
      profile: "work" as const,
      continuation,
      parentMessageId: requestParentMessageId,
      requestMessageId,
      systemHints: [] as string[],
      turnTraceId: randomUUID(),
    };
    const resources = await bootstrap(configWithSignal);
    const conduitToken = await prepareImageConversation(
      configWithSignal,
      prompt,
      options
    );
    const requirements = await getChatRequirements(configWithSignal, resources);
    const response = await startImageGeneration(
      configWithSignal,
      prompt,
      requirements,
      conduitToken,
      options,
      references
    );
    const text = await readSseText(response);
    throwIfAborted(abortController.signal);
    const streamError = extractWebStreamError(text);
    if (streamError) {
      return { error: streamError };
    }
    const conversationId = extractConversationId(text);
    if (!conversationId) {
      return { error: "ChatGPT Web chat returned no conversation" };
    }
    const chat = await pollWebChatResult(
      configWithSignal,
      conversationId,
      requestMessageId,
      abortController.signal
    );
    let parentMessageId = chat.parentMessageId || extractLastMessageId(text);
    let imageOutputs: NonNullable<GenerateImageResult["imageOutputs"]> = [];
    if (chat.hasImage) {
      const resolved = await resolveImageCandidateUrls(
        configWithSignal,
        conversationId,
        extractImageIds(text),
        requestMessageId,
        abortController.signal
      );
      imageOutputs = await downloadImageOutputs(
        configWithSignal,
        resolved.outputs,
        abortController.signal
      );
      parentMessageId = resolved.parentMessageId || parentMessageId;
    }
    const responseText = chat.responseText?.trim() || "";
    if (!responseText && !imageOutputs.length) {
      return { error: "ChatGPT Web chat returned no response" };
    }
    if (conversationId && !parentMessageId) {
      // best-effort:同上,补 parentMessageId 的兜底查询失败不该拖垮已完成的回复/出图。
      try {
        parentMessageId = latestConversationMessageId(
          await getConversationText(
            configWithSignal,
            conversationId,
            abortController.signal
          )
        );
      } catch {
        throwIfAborted(abortController.signal);
      }
    }
    return {
      ...(responseText ? { responseText } : {}),
      ...(imageOutputs[0]?.imageBase64
        ? {
            imageBase64: imageOutputs[0].imageBase64,
            imageOutputs,
            imageOutputCount: imageOutputs.length,
          }
        : {}),
      ...(conversationId && parentMessageId
        ? {
            webConversation: {
              conversationId,
              parentMessageId,
              accountId: config.backend?.id,
              apiKeyId: config.backend?.apiKeyId,
            },
          }
        : {}),
    };
  } catch (error) {
    logError(error, {
      source: "chatgpt-web-chat",
      backendId: config.backend?.id,
      requestKind: config.backend?.requestKind,
    });
    return {
      error: error instanceof Error ? error.message : "ChatGPT Web chat failed",
    };
  } finally {
    clearTimeout(timeout);
    params.signal?.removeEventListener("abort", abortFromParent);
    if (claimedWebConversationId) {
      inflightWebContinuations.delete(claimedWebConversationId);
    }
  }
}

/**
 * 网页对话入口(chat(web) 文字轮次)。text-capable:回文字,模型自发出图时一并返回图。
 * 与 generateImageWithChatGptWeb 的差别:不强制出图、允许 text-only 结果。
 */
export async function chatWithChatGptWeb(
  config: ApiConfig,
  params: WebImageParams,
  images: ImageInputFile[] = []
) {
  return runWebChat(config, params, images);
}

export async function selectChatGptWebImageCandidate(params: {
  config: ApiConfig;
  conversationId: string;
  messageId: string;
  selectedImageMessageId: string;
}) {
  const path = "/backend-api/image-gen/message-select";
  const response = await fetchChatGptWeb(params.config, path, path, {
    method: "POST",
    signal: params.config.signal,
    headers: getHeaders(params.config, path, {
      "Content-Type": "application/json",
      Accept: "application/json",
    }),
    body: JSON.stringify({
      message_id: params.messageId,
      selected_image_message_id: params.selectedImageMessageId,
      conversation_id: params.conversationId,
    }),
  });
  if (!response.ok) {
    throw new Error(
      await webErrorMessage(response, "ChatGPT Web image select")
    );
  }
  return true;
}

// ===== 可编辑文件生成(PPT/PSD):对话式产文件 =====
//
// 移植 basketikun/chatgpt2api 的机制(非 gizmo):model=gpt-5-5-thinking + thinking_effort=extended
// + system_hints=[] + 固定中文提示词 → ChatGPT 内建生图 + 代码解释器(Python 沙盒)拼出 .pptx/.psd
// 写到 /mnt/data,再从会话结果里抠沙盒路径/附件 file_id,按 4 端点顺序换下载链接拉二进制。
// 复用现有 web 对话链路(PoW/Sentinel/上传/会话轮询/getDownloadUrl);不动图片生成路径。
// 依赖账号:代码解释器 + gpt-5-5-thinking 灰度(限 plus/pro,调度层保证,见 editable-file-operations)。

const EDITABLE_FILE_MODEL = "gpt-5-5-thinking";
const EDITABLE_FILE_THINKING_EFFORT = "extended";
const EDITABLE_FILE_POLL_TIMEOUT_MS = 600_000; // 文件生成分钟级,10min
const EDITABLE_FILE_POLL_INTERVAL_MS = 5_000;
// 下载就绪时序:沙盒文件在会话里"出现"(代码写了目标路径)≠"已产出可下载"——代码可能反复失败、
// turn 未完成。故轮询时逐候选实际尝试下载,只有真解析出可下载二进制才算"找到";轮询本身即重试。
// 主文件到手后再给 zip 一段宽限;会话内容长时间停滞且仍无产物则提前结束(避免 10min 空等)。
const EDITABLE_ZIP_GRACE_MS = 30_000;
const EDITABLE_STALL_MS = 120_000;
const EDITABLE_USER_EXTRA_PREFIX = "以下是用户补充需求,请直接结合执行:\n";

// 固定提示词(移植 chatgpt2api _editable_prompt 的三步/两段模板)。
const EDITABLE_PPT_PROMPT =
  "我需要你根据用户的需求,来制作一个可以编辑的PPT。整体流程:\n" +
  "1. 用生图的方式,帮我生成一个精美的产品介绍ppt,5-6个页面;\n" +
  "2. 帮我把以上涉及到的所有图像和形状素材,拆分成单独的png;\n" +
  "3. 利用以上所有图片和形状素材,用python-pptx帮我还原你第一次生成的展示ppt,导出为可编辑的 .pptx 文件,并把用到的素材打包成 .zip。";
const EDITABLE_PSD_PROMPT =
  "帮我生成这个图像,并把这张海报/图像分成若干独立图层素材,再帮我把拆分的图层素材拼合成一个可编辑的 psd 文件(每个图层独立),导出 .psd 文件,并把用到的图层素材打包成 .zip。";

// 沙盒路径 / asset pointer 正则(移植 chatgpt2api 常量)。
const EDITABLE_PPT_FILE_RE =
  /(?:sandbox:)?(\/mnt\/data\/[^\s"'\)\]]+\.(?:pptx?|zip))/gi;
const EDITABLE_PSD_FILE_RE =
  /(?:sandbox:)?(\/mnt\/data\/[^\s"'\)\]]+\.(?:psd|zip))/gi;
const EDITABLE_ASSET_POINTER_RE =
  /(?:file-service|sediment):\/\/([A-Za-z0-9_-]+)/g;

export type EditableFileKind = "ppt" | "psd";

/** 会话结果里定位到的一个文件产物(主文件或 zip)。 */
type EditableArtifact = {
  attachmentId: string;
  fileId: string;
  name: string;
  mimeType: string;
  sandboxPath: string;
  messageId: string;
  isZip: boolean;
};

/** 下载落地的文件二进制(不转 base64,保留 mime)。 */
export type EditableFileBinary = {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  size: number;
};

export type EditableFileResult = {
  conversationId: string;
  primary: EditableFileBinary;
  zip: EditableFileBinary | null;
};

function editableFilePrompt(kind: EditableFileKind, userPrompt: string) {
  const base = kind === "psd" ? EDITABLE_PSD_PROMPT : EDITABLE_PPT_PROMPT;
  const extra = userPrompt.trim();
  return extra ? `${base}\n\n${EDITABLE_USER_EXTRA_PREFIX}${extra}` : base;
}

/** 文件模式的会话预备:去掉 picture_v2/paragen,改 gpt-5-5-thinking + thinking_effort=extended。 */
async function prepareFileConversation(
  config: ApiConfig,
  prompt: string,
  options: {
    parentMessageId: string;
    turnTraceId: string;
  }
) {
  const path = "/backend-api/f/conversation/prepare";
  const response = await fetchChatGptWeb(config, path, path, {
    method: "POST",
    signal: config.signal,
    headers: prepareConversationHeaders(config, path, options.turnTraceId),
    body: JSON.stringify({
      action: "next",
      parent_message_id: options.parentMessageId,
      model: EDITABLE_FILE_MODEL,
      thinking_effort: EDITABLE_FILE_THINKING_EFFORT,
      client_prepare_state: "none",
      client_prepare_dispatch: "debounced",
      client_prepare_source: "composer_editor_state",
      timezone_offset_min: -480,
      timezone: "Asia/Shanghai",
      conversation_mode: { kind: "primary_assistant" },
      system_hints: [],
      partial_query: {
        id: randomUUID(),
        author: { role: "user" },
        content: { content_type: "text", parts: [prompt] },
      },
      supports_buffering: true,
      supported_encodings: ["v1"],
      client_contextual_info: { app_name: "chatgpt.com" },
    }),
  });
  if (!response.ok) {
    throw new Error(
      await webErrorMessage(response, "ChatGPT Web file prepare")
    );
  }
  const data = (await response.json()) as { conduit_token?: string };
  return data.conduit_token || "";
}

/** 文件模式的会话发起:system_hints=[]、gpt-5-5-thinking + thinking_effort=extended。 */
async function startFileConversation(
  config: ApiConfig,
  prompt: string,
  requirements: ChatRequirements,
  conduitToken: string,
  requestMessageId: string,
  references: UploadedAttachment[],
  options: {
    parentMessageId: string;
    turnTraceId: string;
  }
) {
  const path = "/backend-api/f/conversation";
  const response = await fetchChatGptWeb(config, path, path, {
    method: "POST",
    signal: config.signal,
    headers: imageHeaders(config, path, requirements, {
      conduitToken,
      turnTraceId: options.turnTraceId,
    }),
    body: JSON.stringify({
      action: "next",
      messages: [
        buildMessage(prompt, references, requestMessageId, [], "editable-file"),
      ],
      parent_message_id: options.parentMessageId,
      model: EDITABLE_FILE_MODEL,
      thinking_effort: EDITABLE_FILE_THINKING_EFFORT,
      client_prepare_state: "success",
      timezone_offset_min: -480,
      timezone: "Asia/Shanghai",
      conversation_mode: { kind: "primary_assistant" },
      enable_message_followups: true,
      system_hints: [],
      supports_buffering: true,
      supported_encodings: ["v1"],
      client_contextual_info: { app_name: "chatgpt.com" },
    }),
  });
  if (!response.ok) {
    throw new Error(
      await webErrorMessage(response, "ChatGPT Web file request")
    );
  }
  return response;
}

/** 从一条消息节点的 metadata.attachments 取附件(file_id/name/mime/attachmentId)。 */
function attachmentsFromNode(node: unknown): Array<Record<string, unknown>> {
  const metadata = messageMetadataFromValue(node);
  const attachments = isRecord(metadata) ? metadata.attachments : undefined;
  return Array.isArray(attachments)
    ? attachments.filter((a): a is Record<string, unknown> => isRecord(a))
    : [];
}

/**
 * 从会话结果里提取文件产物(移植 chatgpt2api _extract_editable_artifacts):
 * 遍历 requestMessageId 之后的 assistant/tool 节点,① 从 metadata.attachments 取附件;
 * ② 从节点序列化文本里正则抠沙盒路径 /mnt/data/*.(pptx|psd|zip);③ 抠 asset_pointer 的 file_id。
 * 按扩展名判定 kind 主文件 vs zip。export 供单测。
 */
function extractEditableArtifacts(
  conversationText: string,
  requestMessageId: string,
  kind: EditableFileKind
): EditableArtifact[] {
  const fileRe = kind === "psd" ? EDITABLE_PSD_FILE_RE : EDITABLE_PPT_FILE_RE;
  const primaryExt = kind === "psd" ? /\.psd$/i : /\.pptx?$/i;
  const artifacts: EditableArtifact[] = [];
  const seen = new Set<string>();
  for (const { id, node } of conversationNodesAfterMessage(
    conversationText,
    requestMessageId
  )) {
    const messageId = conversationNodeId(node, id);
    const serialized = JSON.stringify(node);
    // 附件来源
    for (const att of attachmentsFromNode(node)) {
      const name = String(att.name || att.file_name || "");
      const fileId = String(att.id || att.file_id || "");
      if (!name || (!primaryExt.test(name) && !/\.zip$/i.test(name))) continue;
      const key = `${fileId}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      artifacts.push({
        attachmentId: String(att.id || ""),
        fileId,
        name,
        mimeType: String(att.mimeType || att.mime_type || ""),
        sandboxPath: "",
        messageId,
        isZip: /\.zip$/i.test(name),
      });
    }
    // 沙盒路径来源
    for (const m of serialized.matchAll(fileRe)) {
      const sandboxPath = m[1] || "";
      if (!sandboxPath) continue;
      const name = sandboxPath.split("/").pop() || sandboxPath;
      const key = `sandbox:${sandboxPath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const pointer = [...serialized.matchAll(EDITABLE_ASSET_POINTER_RE)][0];
      artifacts.push({
        attachmentId: "",
        fileId: pointer?.[1] || "",
        name,
        mimeType: "",
        sandboxPath,
        messageId,
        isZip: /\.zip$/i.test(name),
      });
    }
  }
  return artifacts;
}

/** 从产物按 4 端点顺序解析真实下载 URL(移植 chatgpt2api _resolve_editable_download_url)。 */
async function resolveEditableDownloadUrl(
  config: ApiConfig,
  conversationId: string,
  artifact: EditableArtifact
): Promise<string> {
  const candidates: string[] = [];
  if (artifact.sandboxPath) {
    const q = new URLSearchParams({
      message_id: artifact.messageId,
      sandbox_path: artifact.sandboxPath,
    });
    candidates.push(
      `/backend-api/conversation/${conversationId}/interpreter/download?${q.toString()}`
    );
  }
  if (artifact.attachmentId) {
    candidates.push(
      `/backend-api/conversation/${conversationId}/attachment/${artifact.attachmentId}/download`
    );
  }
  if (artifact.fileId) {
    candidates.push(
      `/backend-api/files/download/${artifact.fileId}?post_id=&inline=false`
    );
    candidates.push(`/backend-api/files/${artifact.fileId}/download`);
  }
  // 按端点顺序试解析:任一返回 download_url/url 即用;未就绪(空/非 200/抛错)则试下一个,
  // 全空返回 ""(由轮询循环下一轮重试)。
  for (const path of candidates) {
    try {
      const url = await getDownloadUrl(config, path, config.signal);
      if (url) return url;
    } catch {
      // 该端点未就绪或不适用,试下一个。
    }
  }
  return "";
}

/**
 * 拉取已解析出的下载 URL。按 URL 形态选路:
 * - chatgpt.com/openai.com 后端 URL 或相对路径:走 Go 代理(WARP 出网 + cookie),
 *   否则用机房 IP 直连会被 Cloudflare 拦(与生图同源问题)。
 * - 外部签名 URL(oaiusercontent 等):直连 + Authorization/UA(与 downloadImage 一致)。
 */
async function fetchResolvedDownload(
  config: ApiConfig,
  url: string
): Promise<Response> {
  let abs: URL | null = null;
  try {
    abs = new URL(url);
  } catch {
    abs = null;
  }
  const isBackend =
    !abs || abs.host.endsWith("chatgpt.com") || abs.host.endsWith("openai.com");
  if (isBackend) {
    const path = abs ? `${abs.pathname}${abs.search}` : url;
    return fetchChatGptWeb(config, path, path, {
      signal: config.signal,
      headers: getHeaders(config, path, {
        Accept: "application/octet-stream",
      }),
    });
  }
  return fetch(url, {
    signal: config.signal,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "User-Agent": USER_AGENT,
    },
  });
}

/**
 * 单次尝试:解析下载 URL → 拉二进制 → EditableFileBinary(保留 mime/文件名)。
 * 未就绪(空 url / 非 200 / 空体)返回 null;由 pollAndDownloadEditableFile 的轮询循环驱动重试。
 */
async function downloadEditableBinary(
  config: ApiConfig,
  conversationId: string,
  artifact: EditableArtifact
): Promise<EditableFileBinary | null> {
  const url = await resolveEditableDownloadUrl(
    config,
    conversationId,
    artifact
  );
  if (!url) return null;
  const response = await fetchResolvedDownload(config, url);
  const buffer = response.ok ? Buffer.from(await response.arrayBuffer()) : null;
  if (buffer && buffer.length > 0) {
    const mimeType =
      artifact.mimeType ||
      response.headers.get("content-type") ||
      "application/octet-stream";
    return { buffer, fileName: artifact.name, mimeType, size: buffer.length };
  }
  return null;
}

/**
 * 轮询会话并逐候选实际下载,凑齐可下载的「主文件」(+尽力凑「zip」)。
 *
 * WHY 边轮询边下载(而非先"发现路径"再下载):沙盒里 /mnt/data/x.pptx 的路径会先出现在
 *   assistant 的**代码**里(仅是目标路径),此时文件尚未产出、甚至代码可能反复 Traceback 失败;
 *   turn 也常未完成。只有 interpreter/download 真解析出可下载二进制,才证明文件已产出。故这里对每个
 *   候选直接试下载,成功才计入 primary/zip;轮询本身充当"等待文件产出"的重试。
 * WHY 容错轮询:thinking 模型走 ChatGPT 异步「缓冲流交接」(stream_handoff)——建会话 SSE 秒回
 *   handoff、turn 在服务端 conduit 异步跑;提交前 GET 会话会短暂 404,须容忍继续轮询。
 * 收敛:主文件到手后给 zip 一段宽限即返回(zip 可缺);会话内容长时间停滞且仍无主文件 → 提前结束
 *   (turn 很可能结束但无产物),交由上层换号重试,避免 10min 空等。abort/超时经 throwIfAborted 上抛。
 */
async function pollAndDownloadEditableFile(
  config: ApiConfig,
  conversationId: string,
  requestMessageId: string,
  kind: EditableFileKind
): Promise<{
  primary: EditableFileBinary | null;
  zip: EditableFileBinary | null;
}> {
  const deadline = Date.now() + EDITABLE_FILE_POLL_TIMEOUT_MS;
  let primary: EditableFileBinary | null = null;
  let zip: EditableFileBinary | null = null;
  let everAccessible = false;
  let lastFetchError = "";
  let zipGraceDeadline = 0;
  let lastText = "";
  let stableSince = 0;
  while (Date.now() < deadline) {
    throwIfAborted(config.signal);
    let text: string;
    try {
      text = await getConversationText(config, conversationId, config.signal);
    } catch (error) {
      // 真 abort/超时须上抛;交接期的瞬时 404/inaccessible 视为"尚未就绪",继续轮询。
      throwIfAborted(config.signal);
      lastFetchError = error instanceof Error ? error.message : String(error);
      await sleep(EDITABLE_FILE_POLL_INTERVAL_MS);
      continue;
    }
    everAccessible = true;
    // 逐候选试下载:只有真拿到可下载二进制才计入对应槽位。
    for (const artifact of extractEditableArtifacts(
      text,
      requestMessageId,
      kind
    )) {
      if (artifact.isZip ? zip : primary) continue; // 槽位已满,跳过
      const binary = await downloadEditableBinary(
        config,
        conversationId,
        artifact
      );
      if (!binary) continue;
      if (artifact.isZip) {
        zip = binary;
      } else {
        primary = binary;
        zipGraceDeadline = Date.now() + EDITABLE_ZIP_GRACE_MS;
      }
    }
    if (primary && zip) break;
    if (primary && Date.now() >= zipGraceDeadline) break; // 主文件到手 + zip 宽限过 → 收工
    // fail-fast:仍无主文件且会话内容长时间不变 → turn 很可能已结束但无产物,提前结束换号。
    if (!primary) {
      if (text === lastText) {
        if (!stableSince) {
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= EDITABLE_STALL_MS) {
          break;
        }
      } else {
        stableSince = 0;
        lastText = text;
      }
    }
    await sleep(EDITABLE_FILE_POLL_INTERVAL_MS);
  }
  // 整段窗口都没成功抓过会话:抛真实原因(如持续 403/被墙),而非笼统的"未取到主文件"。
  if (!everAccessible && lastFetchError) {
    throw new Error(lastFetchError);
  }
  return { primary, zip };
}

/**
 * 对话式生成可编辑文件(PPT/PSD)。上层入口(editable-file-operations 调用,传已选 plus/pro 账号 config)。
 * 流程:上传输入图 → bootstrap → prepareFileConversation → getChatRequirements →
 *   startFileConversation → 读 SSE 取
 *   conversationId → 轮询取主文件+zip → 下载二进制。主文件缺失则抛错;zip 可缺。
 */
export async function generateFileWithChatGptWeb(params: {
  config: ApiConfig;
  kind: EditableFileKind;
  prompt: string;
  images: ImageInputFile[];
}): Promise<EditableFileResult> {
  const abortController = new AbortController();
  const timeout = setTimeout(
    () => abortController.abort(),
    EDITABLE_FILE_POLL_TIMEOUT_MS + 60_000
  );
  try {
    const config = { ...params.config, signal: abortController.signal };
    const requestMessageId = randomUUID();
    const prompt = editableFilePrompt(params.kind, params.prompt);
    const references = await Promise.all(
      params.images.map((image, index) =>
        uploadAttachment(config, image, index + 1, { image: true })
      )
    );
    const conversationOptions = {
      parentMessageId: randomUUID(),
      turnTraceId: randomUUID(),
    };
    const resources = await bootstrap(config);
    const conduitToken = await prepareFileConversation(
      config,
      prompt,
      conversationOptions
    );
    const requirements = await getChatRequirements(config, resources);
    const response = await startFileConversation(
      config,
      prompt,
      requirements,
      conduitToken,
      requestMessageId,
      references,
      conversationOptions
    );
    const text = await readSseText(response);
    throwIfAborted(abortController.signal);
    const streamError = extractWebStreamError(text);
    const conversationId = extractConversationId(text);
    if (streamError) throw new Error(streamError);
    if (!conversationId) {
      throw new Error("ChatGPT Web file: 无 conversation_id");
    }
    const { primary: primaryBinary, zip: zipBinary } =
      await pollAndDownloadEditableFile(
        config,
        conversationId,
        requestMessageId,
        params.kind
      );
    if (!primaryBinary) {
      throw new Error(`ChatGPT Web file: 未在超时内取到 ${params.kind} 主文件`);
    }
    return { conversationId, primary: primaryBinary, zip: zipBinary };
  } finally {
    clearTimeout(timeout);
  }
}

export const __testing__ = {
  prepareImageConversation,
  startImageGeneration,
  getChatRequirements,
  getConversationText,
  extractQuotaAndRestoreAt,
  extractWebErrorPayloadMessage,
  extractWebStreamError,
  extractWebSystemError,
  imageCandidatesAfterMessage,
  imageSelectionAfterMessage,
  conversationNodesAfterMessage,
  extractImageIds,
  outputMatchesInputImage,
  extractSelectionMessageId,
  scopedConversationTextAfterMessage,
  extractEditableArtifacts,
  editableFilePrompt,
  extractAssistantAnswer,
};
