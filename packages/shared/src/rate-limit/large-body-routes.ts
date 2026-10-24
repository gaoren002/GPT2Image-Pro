/**
 * 大请求入口策略，供 middleware 路由分类和 withApiLogging 共用；不加载限流存储。
 * middleware.matcher 必须用静态字面量，因此由真实 Next matcher 回归约束两者一致。
 */

const PAGE_IMAGE_PATHS = new Set([
  "/api/images/chat",
  "/api/images/edit",
  "/api/editable-file/generate",
]);

const EXTERNAL_IMAGE_PATH =
  /^\/(?:api\/)?v1\/(?:images\/edits|agents\/images|chat\/completions|responses|ppts|psds)$/;

/**
 * 页面 AI POST 在 Node handler 统一计数，避免无 Redis 时 Edge/Node 内存桶分裂。
 * generate、web-select 的小 body 仍匹配 middleware，但不在那里重复计数。
 */
export function getHandlerRateLimitType(pathname: string): "ai" | null {
  const path = pathname.replace(/\/$/, "");
  return getLargeBodyRoutePolicy(path) === "page-ai" ||
    path === "/api/images/generate" ||
    path === "/api/images/chat/web-select"
    ? "ai"
    : null;
}

/**
 * 仅识别已存在的大 body handler，允许 Next 的尾斜线形式，不放宽到整个 API 前缀。
 * 站内请求在读 body 前使用原 ai/IP 桶；外部 API 保留鉴权、配额与并发队列策略，
 * 不新增每分钟限流。未知路径返回 null，继续使用原 middleware 保护。
 */
export function getLargeBodyRoutePolicy(
  pathname: string
): "page-ai" | "external" | null {
  const path = pathname.replace(/\/$/, "");
  if (PAGE_IMAGE_PATHS.has(path)) return "page-ai";
  if (EXTERNAL_IMAGE_PATH.test(path)) return "external";
  return null;
}
