/**
 * 内置浏览器缺失 Origin 头的认证请求兼容（纯函数，DB-free）。
 *
 * 使用方：apps/web 的 /api/auth/[...all] 路由在把 POST 交给 Better Auth 之前调用。
 *
 * 背景：Better Auth 对带 Cookie 的 POST 要求 Origin（或 Referer）命中 trustedOrigins，
 * 否则 403。微信/QQ 内置浏览器提交时不发 Origin（或发 "null"）却带 Cookie，曾导致
 * 重置密码大面积 403（2026-06 实测 24h 内 25 次提交 19 次 403）。此前的做法是全局
 * 关闭 CSRF 校验，但那同时关掉了"跨站导航登录"拦截，第三方页面可以让访客在不知情时
 * 登录到他人账号（Login CSRF）。
 *
 * 现做法：保留 Better Auth 的全部 CSRF 校验，只在请求"跨站 HTML 表单无法伪造"时为其
 * 补上本站 Origin。判定依据按强度排序：
 * - **必须是 JSON 请求体**。跨站 HTML 表单只能发 urlencoded / multipart / text-plain；
 *   跨源 fetch 发 application/json 会触发 CORS 预检，而本站 /api/auth 不返回 CORS
 *   允许头，预检即失败。本站认证调用一律发 JSON（./client.ts 显式设置，better-auth
 *   客户端对对象体也自动设为 application/json），因此内置浏览器的真实请求不受影响。
 * - Sec-Fetch-Site 明确为 cross-site 时不补写，跨站导航登录仍被 Better Auth 拒绝。
 *
 * WHY 不能只看"Origin 缺失"：按 Fetch 规范，导航型跨站 POST 在
 * `Referrer-Policy: no-referrer` 下 Origin 会被序列化为字面量 "null" 且不带 Referer，
 * 攻击页面加一行 meta 即可；不发 Sec-Fetch-* 的老客户端（Safari/iOS WKWebView < 16.4、
 * Firefox < 90、Chrome < 76、旧版微信 X5 等，正是本兼容层要照顾的人群）于是会被误判为
 * 同站，把 Better Auth 本应拒绝的跨站表单登录变成成功登录。JSON 这一条即封住该路径。
 *
 * 相比去掉 Cookie 的做法，这里保留 Cookie，使登出、修改密码等依赖会话的端点在内置
 * 浏览器中同样可用。
 */

/** 认证路由前缀，与 apps/web/src/app/api/auth/[...all] 一致。 */
export const AUTH_BASE_PATH = "/api/auth";

/**
 * 判断头是否缺失或为不透明来源 "null"。
 *
 * 两者都视为"没有可校验的来源"：内置浏览器可能完全不发 Origin，也可能发 "null"。
 * 单凭这一点不足以放行，必须同时满足 JSON 请求体（见模块注释）。
 */
function isAbsentOrOpaque(value: string | null): boolean {
  const normalized = value?.trim().toLowerCase();
  return !normalized || normalized === "null";
}

/**
 * 判断请求体是否为 JSON。
 *
 * 这是跨站 HTML 表单无法产生的正向信号：表单只能发
 * application/x-www-form-urlencoded、multipart/form-data 或 text/plain。
 */
function hasJsonContentType(headers: Headers): boolean {
  const contentType = headers.get("content-type")?.trim().toLowerCase();
  if (!contentType) return false;
  const mediaType = contentType.split(";")[0]?.trim();
  return mediaType === "application/json";
}

/**
 * 读取本站来源：优先部署配置，其次请求自身来源。
 *
 * @remarks 用 BETTER_AUTH_URL / NEXT_PUBLIC_APP_URL 的原因与 auth 配置一致：
 *   反代后请求 URL 可能不是对外域名，而 trustedOrigins 以这两个变量为准。
 */
function getTrustedSelfOrigin(request: Request): string | null {
  const configured =
    process.env.BETTER_AUTH_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // 配置非法时继续回退到请求自身来源。
    }
  }
  try {
    return new URL(request.url).origin;
  } catch {
    return null;
  }
}

/**
 * 为缺失 Origin 的同站认证 POST 补上本站 Origin，其余请求原样返回。
 *
 * @param request 进入 /api/auth 的原始请求。
 * @param basePath 认证路由前缀，默认 /api/auth。
 * @returns 需要兼容时返回补写了 Origin 的新请求（方法、URL、Cookie 与请求体不变），
 *   否则返回原请求对象。
 * @remarks 只处理 JSON 请求体的 POST。已带 Origin 或 Referer 的请求不改动，由 Better
 *   Auth 校验；Sec-Fetch-Site 为 cross-site 时不补写，跨站导航登录仍被拒绝。
 */
export function normalizeOriginlessAuthPost(
  request: Request,
  basePath: string = AUTH_BASE_PATH
): Request {
  if (request.method !== "POST") return request;

  const headers = request.headers;
  // 跨站 HTML 表单无法发 JSON；这是本兼容层唯一不可伪造的前提，必须先判。
  if (!hasJsonContentType(headers)) return request;
  if (!isAbsentOrOpaque(headers.get("origin"))) return request;
  if (!isAbsentOrOpaque(headers.get("referer"))) return request;

  const site = headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (site === "cross-site") return request;

  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return request;
  }
  if (!pathname.startsWith(`${basePath}/`)) return request;

  const selfOrigin = getTrustedSelfOrigin(request);
  if (!selfOrigin) return request;

  const patched = new Headers(headers);
  patched.set("origin", selfOrigin);
  return new Request(request, { headers: patched });
}
