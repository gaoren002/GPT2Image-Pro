/**
 * API 日志薄封装；被 matcher 精确排除的大站内请求须先限流，再调用业务 handler。
 * 4xx/5xx 的 JSON 错误体会读取一份有界副本，把错误码与信息并入访问日志，便于定位拒绝原因。
 */
import type { NextRequest } from "next/server";
import {
  type ApiErrorLogDetails,
  logApiResponse,
  logError,
} from "./logger/index";
import {
  checkRateLimit,
  createRateLimitResponse,
  getClientIp,
  getRateLimitHeaders,
} from "./rate-limit/index";
import { getHandlerRateLimitType } from "./rate-limit/large-body-routes";

// never 承接动态路由不同的 params 类型，运行时原样透传，返回值保留 handler 精确类型。
type ApiHandler = (request: NextRequest, context: never) => Promise<Response>;

/** 读取错误体的字节上限；错误 JSON 很小，更大的正文不复制，避免为日志放大内存。 */
const ERROR_BODY_LOG_MAX_BYTES = 16 * 1024;
/** 读取错误体的最长等待；保活式长连接 JSON 不会让日志无限挂起。 */
const ERROR_BODY_LOG_TIMEOUT_MS = 5_000;
/** 日志中错误信息的最大长度。 */
const ERROR_MESSAGE_LOG_MAX_CHARS = 300;

/** 只读 4xx/5xx 的 JSON 正文；流式（SSE）与二进制响应不复制，以免副本积压。 */
function shouldReadErrorDetails(response: Response) {
  if (response.status < 400 || !response.body) return false;
  const contentType = response.headers.get("content-type")?.toLowerCase();
  if (!contentType?.includes("application/json")) return false;
  const declared = Number(response.headers.get("content-length") ?? 0);
  return !(Number.isFinite(declared) && declared > ERROR_BODY_LOG_MAX_BYTES);
}

/** 拼接读取到的分块；不依赖 Node Buffer，Edge 运行时同样可用。 */
function concatBytes(chunks: Uint8Array[]) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * 从错误体中取可记录的字段：兼容 OpenAI 风格 {error:{message,type,code}}
 * 与站内 {error:"..."}、{message:"..."}。信息压成单行并截断。
 */
function extractErrorDetails(payload: unknown): ApiErrorLogDetails | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  const raw = record.error;
  const error: Record<string, unknown> =
    typeof raw === "string"
      ? { message: raw }
      : raw && typeof raw === "object"
        ? (raw as Record<string, unknown>)
        : typeof record.message === "string"
          ? { message: record.message }
          : {};
  const details: ApiErrorLogDetails = {};
  if (typeof error.code === "string" && error.code) {
    details.errorCode = error.code.slice(0, 80);
  }
  if (typeof error.type === "string" && error.type) {
    details.errorType = error.type.slice(0, 80);
  }
  if (typeof error.message === "string") {
    const message = error.message.replace(/\s+/g, " ").trim();
    if (message) {
      details.errorMessage = message.slice(0, ERROR_MESSAGE_LOG_MAX_CHARS);
    }
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

/**
 * 读取错误响应副本并提取原因。原响应照常交给客户端；超出字节上限、超时、
 * 非 JSON 或解析失败时返回 undefined，只记录基础访问日志。从不抛错。
 */
async function readErrorDetails(
  copy: Response
): Promise<ApiErrorLogDetails | undefined> {
  if (!copy.body) return undefined;
  const reader = copy.body.getReader();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  }, ERROR_BODY_LOG_TIMEOUT_MS);
  // 只为日志服务的定时器不应让进程多挂 5 秒。
  (timer as unknown as { unref?: () => void }).unref?.();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > ERROR_BODY_LOG_MAX_BYTES) {
        // tee 分支的 cancel 要等另一分支也取消才完成，原响应正常读完时永不完成，不能 await。
        void reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
    if (timedOut) return undefined;
    return extractErrorDetails(
      JSON.parse(new TextDecoder().decode(concatBytes(chunks)))
    );
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 写访问日志。错误响应在后台读取副本后再记录，不延迟响应返回；
 * 耗时取响应生成时刻，不包含读取副本的时间。
 */
function logResponse(
  request: NextRequest,
  response: Response,
  duration: number
) {
  if (!shouldReadErrorDetails(response)) {
    logApiResponse(request, response, duration);
    return;
  }
  const copy = response.clone();
  void readErrorDetails(copy).then(
    (details) => logApiResponse(request, response, duration, details),
    () => logApiResponse(request, response, duration)
  );
}

/** 读取 URL/头部即可限流，不 clone/消费 body；业务鉴权、输入校验与异常语义保持原样。 */
export function withApiLogging<T extends ApiHandler>(handler: T): T {
  const wrapped = async (request: NextRequest, context: never) => {
    const startTime = Date.now();
    try {
      const type = getHandlerRateLimitType(new URL(request.url).pathname);
      const rateLimit = type
        ? await checkRateLimit(getClientIp(request), type)
        : null;
      const response =
        rateLimit && !rateLimit.success
          ? createRateLimitResponse(rateLimit)
          : await handler(request, context);
      if (rateLimit) {
        for (const [key, value] of new Headers(
          getRateLimitHeaders(rateLimit)
        )) {
          response.headers.set(key, value);
        }
        // 包含 401/403/429 和流式输出，禁止缓存任何用户输入与生成结果。
        // 追加而非覆盖，保留流式响应的 no-transform，避免代理重新缓冲或改写。
        const cacheControl = response.headers.get("Cache-Control");
        response.headers.set(
          "Cache-Control",
          cacheControl
            ? `${cacheControl}, private, no-store`
            : "private, no-store"
        );
      }
      logResponse(request, response, Date.now() - startTime);
      return response;
    } catch (error) {
      logError(error, {
        source: "api",
        method: request.method,
        path: new URL(request.url).pathname,
        duration: Date.now() - startTime,
      });
      throw error;
    }
  };
  return wrapped as T;
}
