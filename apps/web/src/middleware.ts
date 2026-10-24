import {
  checkRateLimit,
  createRateLimitResponse,
  getClientIp,
  getRateLimitHeaders,
} from "@repo/shared/rate-limit";
import { type NextRequest, NextResponse } from "next/server";
import createIntlMiddleware from "next-intl/middleware";
import { routing } from "@/i18n/routing";
import { getApiRateLimitType } from "./rate-limit-routing";

/**
 * 创建国际化中间件
 */
const intlMiddleware = createIntlMiddleware(routing);
const VERSIONED_ASSET_PREFIX_PATTERN =
  /^\/(?:gpt2-assets|next-assets)-[^/]+(\/_next\/.*)$/;

function setPrivateNoStore<T extends Response>(response: T): T {
  response.headers.set(
    "Cache-Control",
    "private, no-store, no-cache, max-age=0, must-revalidate"
  );
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");
  return response;
}

/**
 * 中间件配置
 *
 * 功能:
 * 1. API 限流（全局 + 路由级别）
 * 2. 国际化路由处理 (next-intl)
 * 3. 认证保护 (Better Auth)
 *    - /dashboard/* 需要登录才能访问
 *    - 未登录用户将被重定向到 /sign-in
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (VERSIONED_ASSET_PREFIX_PATTERN.test(pathname)) {
    const rewrittenUrl = request.nextUrl.clone();
    rewrittenUrl.pathname = pathname.replace(
      /^\/(?:gpt2-assets|next-assets)-[^/]+/,
      ""
    );
    return NextResponse.rewrite(rewrittenUrl);
  }

  // ============================================
  // API 路由限流
  // ============================================
  if (pathname.startsWith("/api/")) {
    // 跳过健康检查和 webhook（webhook 需要验证签名，不应被限流阻断）
    if (pathname === "/api/health" || pathname.startsWith("/api/webhooks/")) {
      return NextResponse.next();
    }

    const isPrivateApiPath =
      pathname.startsWith("/api/auth/") || pathname === "/api/session/current";

    // 白名单模式：只对匹配的敏感路由做限流。认证类路由（登录、注册、发码、
    // 重置密码）也在此限流，因此必须先于下方认证路径的 no-store 放行执行；
    // 此前放行分支在前，认证限流从未生效（2026-10-24 审查确认）。
    const rateLimitType = getApiRateLimitType(pathname);
    if (rateLimitType) {
      const ip = getClientIp(request);
      const result = await checkRateLimit(ip, rateLimitType);

      if (!result.success) {
        const limited = createRateLimitResponse(result);
        return isPrivateApiPath ? setPrivateNoStore(limited) : limited;
      }

      const response = NextResponse.next();
      const headers = getRateLimitHeaders(result);
      for (const [key, value] of Object.entries(headers)) {
        response.headers.set(key, value);
      }
      return isPrivateApiPath ? setPrivateNoStore(response) : response;
    }

    if (isPrivateApiPath) {
      return setPrivateNoStore(NextResponse.next());
    }

    // 未匹配的 API 路由直接放行，不触发 Redis
    return NextResponse.next();
  }

  if (pathname === "/moderate") {
    return NextResponse.next();
  }

  if (pathname.startsWith("/v1/")) {
    const rateLimitType = getApiRateLimitType(pathname);
    if (rateLimitType) {
      const ip = getClientIp(request);
      const result = await checkRateLimit(ip, rateLimitType);

      if (!result.success) {
        return createRateLimitResponse(result);
      }

      const response = NextResponse.next();
      const headers = getRateLimitHeaders(result);
      for (const [key, value] of Object.entries(headers)) {
        response.headers.set(key, value);
      }
      return response;
    }

    return NextResponse.next();
  }

  // ============================================
  // 非 API 路由：国际化 + 认证保护
  // ============================================

  // 获取 Better Auth 的 session token
  const sessionToken =
    request.cookies.get("better-auth.session_token")?.value ||
    request.cookies.get("__Secure-better-auth.session_token")?.value;

  // 从路径中提取不带语言前缀的路径
  // 例如: /en/dashboard -> /dashboard, /zh/sign-in -> /sign-in
  const pathnameWithoutLocale = pathname.replace(/^\/(en|zh)/, "") || "/";

  // 定义需要保护的路由
  const protectedRoutes = ["/dashboard"];

  // 定义认证页面路由 (已登录用户不应访问)
  const authRoutes = ["/sign-in", "/sign-up"];

  // 检查当前路径是否是受保护的路由
  const isProtectedRoute = protectedRoutes.some(
    (route) =>
      pathnameWithoutLocale === route ||
      pathnameWithoutLocale.startsWith(`${route}/`)
  );

  // 检查当前路径是否是认证页面
  const isAuthRoute = authRoutes.some(
    (route) => pathnameWithoutLocale === route
  );

  // 获取当前语言前缀 (用于重定向)
  const localeMatch = pathname.match(/^\/(en|zh)/);
  const locale = localeMatch ? localeMatch[1] : routing.defaultLocale;

  // 如果访问受保护路由但未登录，重定向到登录页
  if (isProtectedRoute && !sessionToken) {
    const signInUrl = new URL(`/${locale}/sign-in`, request.url);
    // 保存原始 URL，登录后可以重定向回来
    signInUrl.searchParams.set("callbackUrl", pathname);
    return setPrivateNoStore(NextResponse.redirect(signInUrl));
  }

  // 执行国际化中间件
  const response = intlMiddleware(request);
  return isProtectedRoute || isAuthRoute ? setPrivateNoStore(response) : response;
}

/**
 * 中间件匹配配置
 *
 * 现在也匹配 API 路由，以便进行全局限流
 */
export const config = {
  matcher: [
    /*
     * 匹配所有路径除了:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public folder files
     *
     * 注意: 现在包含 /api 路由以便进行限流
     */
    "/((?!_next/static|_next/image|favicon.ico|site\\.webmanifest|sitemap\\.xml|robots\\.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
