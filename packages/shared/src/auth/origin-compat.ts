/**
 * 内置浏览器缺失 Origin 头的认证请求兼容（纯函数，DB-free）。
 *
 * 使用方：apps/web 的 /api/auth/[...all] 路由在把 POST 交给 Better Auth 之前调用。
 *
 * 背景：Better Auth 对带 Cookie 的 POST 要求 Origin（或 Referer）命中 trustedOrigins，
 * 否则 403。微信/QQ 内置浏览器提交时不发 Origin（或发 "null"）却带 Cookie，曾导致
 * 重置密码大面积 403（2026-06 实测 24h 内 25 次提交 19 次 403）。此前的做法是全局
 * 关闭 CSRF 校验，但那同时关掉了“跨站导航登录”拦截，第三方页面可以让访客在不知情时
 * 登录到他人账号（Login CSRF）。
 *
 * 现做法：保留 Better Auth 的全部 CSRF 校验，只对“不依赖会话”的少数端点，在请求
 * 缺失 Origin 时去掉 Cookie 再交给 Better Auth。这些端点靠请求体里的凭据或一次性
 * 令牌完成认证，本就不读取会话 Cookie；去掉 Cookie 后不再触发“带 Cookie 必须带
 * Origin”的检查，而跨站导航与跨站 Origin 的拦截（依据 Sec-Fetch-* 与 Origin 头）
 * 照常生效。正常浏览器的 POST 总会携带 Origin，不受本兼容逻辑影响。
 */

/** 认证路由前缀，与 apps/web/src/app/api/auth/[...all] 一致。 */
export const AUTH_BASE_PATH = "/api/auth";

/**
 * 不依赖会话 Cookie 的 Better Auth POST 端点（相对 AUTH_BASE_PATH）。
 * 只收录确有内置浏览器兼容需求、且请求本身携带凭据或一次性令牌的端点；
 * 修改密码、更新资料、登出等依赖会话的端点不得加入，否则会话 Cookie 被去掉后无法工作。
 */
export const SESSION_FREE_AUTH_POST_PATHS: ReadonlySet<string> = new Set([
  "/reset-password",
  "/request-password-reset",
  "/sign-in/email",
  "/sign-up/email",
]);

/**
 * 判断 Origin 头是否缺失或为不透明来源 "null"。
 */
function isOriginMissing(origin: string | null): boolean {
  const normalized = origin?.trim().toLowerCase();
  return !normalized || normalized === "null";
}

/**
 * 为缺失 Origin 的会话无关认证 POST 去掉 Cookie，其余请求原样返回。
 *
 * @param request 进入 /api/auth 的原始请求。
 * @param basePath 认证路由前缀，默认 /api/auth。
 * @returns 需要兼容时返回去掉 Cookie 的新请求（方法、URL、其他头与请求体不变），
 *   否则返回原请求对象。
 * @remarks 只处理 POST；不修改 Origin，也不放宽任何校验，跨站请求仍由 Better Auth 拒绝。
 */
export function stripCookiesForOriginlessAuthPost(
  request: Request,
  basePath: string = AUTH_BASE_PATH
): Request {
  if (request.method !== "POST") return request;
  if (!request.headers.has("cookie")) return request;
  if (!isOriginMissing(request.headers.get("origin"))) return request;

  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return request;
  }
  if (!pathname.startsWith(`${basePath}/`)) return request;
  const endpoint = pathname.slice(basePath.length).replace(/\/+$/, "");
  if (!SESSION_FREE_AUTH_POST_PATHS.has(endpoint)) return request;

  const headers = new Headers(request.headers);
  headers.delete("cookie");
  return new Request(request, { headers });
}
