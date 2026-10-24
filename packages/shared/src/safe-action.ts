/** Server Action 认证与错误出口；数据库失败须先脱敏，再交给日志和监控。 */
import { headers } from "next/headers";
import { createSafeActionClient } from "next-safe-action";
import { z } from "zod";

import { auth } from "./auth/index";
import { getUserRoleById } from "./auth/role-server";
import {
  canAccessAdminArea,
  canManageUserPermissions,
  canViewImageBackendPool,
} from "./auth/roles";
import { logError, logger } from "./logger/index";
import { captureError } from "./monitoring/index";
import { describeErrorForLog, isDatabaseError } from "./db/error-summary";

const actionMetadataSchema = z
  .object({
    action: z.string().min(1),
  })
  .optional();

class ActionAuthError extends Error {
  constructor() {
    super("登录已失效，请重新登录");
    this.name = "ActionAuthError";
  }
}

class ActionBannedError extends Error {
  constructor() {
    super("账号已被封禁");
    this.name = "ActionBannedError";
  }
}

/**
 * 面向用户的已知错误:用于校验类/可预期失败(如套餐未配置、余额不足),其 message 即便在生产环境
 * 也原样回传前端展示,而不是被统一替换成"服务器错误"。仅放可安全展示给用户的提示,勿带内部细节。
 */
export class ActionUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionUserError";
  }
}

/**
 * 基础 Action 客户端
 *
 * 用于创建不需要认证的 Server Actions
 * 自动集成日志和错误监控（开箱即用）
 */
const baseActionClient = createSafeActionClient({
  defineMetadataSchema: () => actionMetadataSchema,
  /**
   * 处理服务器错误
   * - 自动记录结构化日志
   * - 自动上报 Sentry（如已配置）
   * - 生产环境下隐藏具体错误信息
   */
  handleServerError(error) {
    if (isDatabaseError(error)) {
      // DrizzleQueryError 的 message/stack/query/params/cause 都可能含凭据。
      // 创建独立错误，只传摘要；不能复用原始 stack/cause 或把原错误放入 context。
      const safeError = new Error(describeErrorForLog(error));
      safeError.name = "DatabaseError";
      logError(safeError, { source: "server-action" });
      captureError(safeError, { source: "server-action" });
      return "数据库操作失败，请稍后重试";
    }

    if (
      error instanceof ActionAuthError ||
      error instanceof ActionBannedError ||
      error instanceof ActionUserError
    ) {
      return error.message;
    }

    // 结构化日志记录
    logError(error, { source: "server-action" });

    // Sentry 上报（未配置时自动跳过）
    captureError(error, { source: "server-action" });

    // 生产环境返回通用错误信息
    if (process.env.NODE_ENV === "production") {
      return "服务器错误，请稍后重试";
    }

    return error.message;
  },
});

export const actionClient = baseActionClient.use(
  async ({ metadata, ctx, next }) => {
    const startTime = Date.now();
    const result = await next();
    const duration = Date.now() - startTime;
    const userId = (ctx as { userId?: string }).userId;
    const error =
      !result.success && "serverError" in result
        ? (result as { serverError?: unknown }).serverError
        : undefined;

    logger.info(
      {
        action: metadata?.action ?? "server-action",
        success: result.success,
        duration,
        ...(userId ? { userId } : {}),
        ...(error ? { error } : {}),
      },
      "Server action"
    );

    return result;
  }
);

/**
 * 受保护的 Action 客户端
 *
 * 用于创建需要用户认证的 Server Actions
 * 通过中间件验证用户会话，并将用户信息传递给 action
 */
export const protectedAction = actionClient.use(async ({ next }) => {
  /**
   * 获取当前用户会话
   * 使用 Better Auth 的 getSession 方法
   */
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  // 如果没有会话或用户信息，重定向到登录页
  if (!session || !session.user) {
    throw new ActionAuthError();
  }

  // 封禁强制点：被封用户的现有会话立即失效，不再放行任何受保护操作。
  // 管理员 banUserAction 仅写 banned=true 而不删会话，故必须在每次受保护调用时复查。
  if ((session.user as { banned?: boolean | null }).banned) {
    throw new ActionBannedError();
  }

  // 设置用户上下文到日志
  logger.debug({ userId: session.user.id }, "Authenticated action executed");

  /**
   * 将用户信息传递给下游 action
   * ctx 对象可以在 action 中通过 ctx 参数访问
   */
  return next({
    ctx: {
      userId: session.user.id,
      user: session.user,
    },
  });
});

/**
 * 管理员 Action 客户端
 *
 * 用于创建需要管理员权限的 Server Actions
 * 在 protectedAction 基础上增加角色验证
 */
export const adminAction = protectedAction.use(async ({ next, ctx }) => {
  const role = await getUserRoleById(ctx.userId);
  if (!canAccessAdminArea(role)) {
    throw new Error("此操作需要管理员权限");
  }

  return next({
    ctx: {
      ...ctx,
      role,
      isAdmin: true,
    },
  });
});

export const superAdminAction = protectedAction.use(async ({ next, ctx }) => {
  const role = await getUserRoleById(ctx.userId);
  if (!canManageUserPermissions(role)) {
    throw new Error("此操作需要超管权限");
  }

  return next({
    ctx: {
      ...ctx,
      role,
      isAdmin: true,
      isSuperAdmin: true,
    },
  });
});

export const imageBackendPoolViewerAction = protectedAction.use(
  async ({ next, ctx }) => {
    const role = await getUserRoleById(ctx.userId);
    if (!canViewImageBackendPool(role)) {
      throw new Error("此操作需要生图后端池查看权限");
    }

    return next({
      ctx: {
        ...ctx,
        role,
        canViewImageBackendPool: true,
      },
    });
  }
);
