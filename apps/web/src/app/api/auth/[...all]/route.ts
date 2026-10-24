import { toNextJsHandler } from "better-auth/next-js";
import { withApiLogging } from "@repo/shared/api-logger";
import { auth } from "@repo/shared/auth";
import { stripCookiesForOriginlessAuthPost } from "@repo/shared/auth/origin-compat";

/**
 * Better Auth API 路由处理器
 *
 * 此文件处理所有 /api/auth/* 请求
 * Better Auth 自动处理:
 * - /api/auth/sign-in - 登录
 * - /api/auth/sign-up - 注册
 * - /api/auth/sign-out - 登出
 * - /api/auth/session - 获取会话
 * - /api/auth/callback/* - OAuth 回调
 * - 等等...
 */
const authHandlers = toNextJsHandler(auth);

type AuthHandler = (request: Request, context?: unknown) => Promise<Response>;

function withPrivateNoStore<T extends AuthHandler>(handler: T): T {
  const wrapped = async (request: Request, context?: unknown) => {
    const response = await handler(request, context);
    response.headers.set(
      "Cache-Control",
      "private, no-store, no-cache, max-age=0, must-revalidate"
    );
    response.headers.set("Pragma", "no-cache");
    response.headers.set("Expires", "0");
    return response;
  };

  return wrapped as T;
}

/**
 * 内置浏览器兼容:缺失 Origin 的会话无关 POST(重置密码、登录、注册等)去掉 Cookie
 * 后再交给 Better Auth,使其不触发"带 Cookie 必须带 Origin"的检查;CSRF 校验本身
 * 保持开启,跨站请求仍被拒绝。详见 @repo/shared/auth/origin-compat。
 */
const handleAuthPost: AuthHandler = (request) =>
  authHandlers.POST(stripCookiesForOriginlessAuthPost(request));

export const GET = withApiLogging(withPrivateNoStore(authHandlers.GET));
export const POST = withApiLogging(withPrivateNoStore(handleAuthPost));
