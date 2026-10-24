/** API 日志薄封装；被 matcher 精确排除的大站内请求须先限流，再调用业务 handler。 */
import type { NextRequest } from "next/server";
import { logApiResponse, logError } from "./logger/index";
import {
  checkRateLimit,
  createRateLimitResponse,
  getClientIp,
  getRateLimitHeaders,
} from "./rate-limit/index";
import { getHandlerRateLimitType } from "./rate-limit/large-body-routes";

// never 承接动态路由不同的 params 类型，运行时原样透传，返回值保留 handler 精确类型。
type ApiHandler = (request: NextRequest, context: never) => Promise<Response>;

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
      logApiResponse(request, response, Date.now() - startTime);
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
