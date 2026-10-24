/**
 * 生成管线错误脱敏（DB-free，可单测）。
 *
 * 职责：把异常转成"可安全回传给前端"的 message。数据库/内部异常（如 Drizzle 池查询
 * 失败、Postgres 故障）绝不能把裸 SQL、列名、连接细节暴露到用户 toast——记服务端日志
 * 并回通用可重试消息;已知用户级错误（积分不足、无可用后端等）保留原 message。
 *
 * 背景：issue #35「图生图报错」——图像后端池成员选择查询瞬时失败,Drizzle 的
 * "Failed query: select ... params: ..."（含 api_key 等列名）经兜底 catch 原样回传,
 * 直接显示在用户的「生成失败」toast 里。本模块在管线兜底处拦截这类内部错误。
 *
 * 使用方：image-generation/operations.ts 的兜底 catch。
 */

import {
  describeErrorForLog,
  isDatabaseError,
} from "@repo/shared/db/error-summary";
import { logError } from "@repo/shared/logger";

/**
 * 是否数据库/内部异常（不应把细节暴露给终端用户）。
 * 判据：
 * - Drizzle 把查询错误包成 message 形如 "Failed query: <sql>\nparams: ..."。
 * - 共享判定沿 cause 链识别 Drizzle 与 PostgreSQL SQLSTATE，包括无 code 的断连。
 * - node-postgres 原始错误也可能仅带 `severity`。
 * 反例：已知用户级错误（如 "Insufficient credits"、"分组无可用后端"）是普通 Error,
 * 无上述特征 → 返回 false → 原样透传。
 */
export function isInternalDatabaseError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (isDatabaseError(error)) return true;
  if (/^Failed query:/i.test(error.message)) return true;
  const candidate = error as { severity?: unknown };
  if (typeof candidate.severity === "string") return true;
  return false;
}

/**
 * 把异常转成回传给前端的 message：
 * - 内部/DB 异常 → 安全摘要重建 Error 后记日志（保留 source/generationId）+ 回 fallback;
 * - 其余 → 用 error.message（非 Error 用 fallback）。
 */
export function toClientErrorMessage(
  error: unknown,
  context: { source: string; generationId?: string },
  fallback: string
): string {
  if (isInternalDatabaseError(error)) {
    // 与 SafeAction 出口一致：原始 message/stack/query/params/cause 都可能含凭据。
    // 仅传新建的摘要错误；只有 severity 或兼容消息前缀时使用固定摘要，避免回退到原文。
    const safeError = new Error(
      isDatabaseError(error) ? describeErrorForLog(error) : "DatabaseError"
    );
    safeError.name = "DatabaseError";
    logError(safeError, {
      source: context.source,
      ...(context.generationId ? { generationId: context.generationId } : {}),
    });
    return fallback;
  }
  return error instanceof Error ? error.message : fallback;
}
