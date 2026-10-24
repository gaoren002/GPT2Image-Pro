/**
 * MCP Admin 鉴权模块
 *
 * 职责：验证 MCP Admin 请求的 Bearer token，
 * 使用 timingSafeEqual 恒定时间比对防止时序攻击。
 *
 * 使用方：apps/web/src/app/api/mcp/admin/route.ts
 * 关键依赖：node:crypto（timingSafeEqual）、config.ts（getMcpAdminSecret）
 *
 * 设计决策：
 * - Fail-closed：无 secret 配置时始终拒绝
 * - 返回固定 Principal（super_admin 身份），代表 MCP 管理密钥绑定的系统管理员
 * - 不读取 DB（鉴权无 IO 依赖，极快且无连接要求）
 */
import { timingSafeEqual } from "node:crypto";

import type { Principal } from "../uol/principal";
import { getMcpAdminSecret } from "./config";

/**
 * MCP Admin 鉴权结果
 */
export type McpAuthResult =
  | { ok: true; principal: Principal }
  | { ok: false; error: string };

/**
 * MCP Admin 固定管理员 userId（MCP 密钥绑定的虚拟身份）。
 * 审计日志中以此标识 MCP 调用来源。
 */
export const MCP_ADMIN_PRINCIPAL_USER_ID = "__mcp_admin__";

/**
 * 验证 MCP Admin 请求的 Authorization header。
 *
 * 预期格式：Bearer <secret>
 * - 无 secret 配置 → 拒绝（fail-closed）
 * - header 格式不正确 → 拒绝
 * - secret 不匹配 → 拒绝
 * - 匹配 → 返回 super_admin Principal
 *
 * @param authHeader - 请求的 Authorization header 值（可能为 null/undefined）
 * @returns 鉴权结果（含 principal 或错误描述）
 */
export function authenticateMcpAdmin(
  authHeader: string | null | undefined
): McpAuthResult {
  const configuredSecret = getMcpAdminSecret();

  // Fail-closed：未配置 secret 时一律拒绝
  if (!configuredSecret) {
    return {
      ok: false,
      error: "MCP admin secret not configured",
    };
  }

  if (!authHeader) {
    return {
      ok: false,
      error: "Missing Authorization header",
    };
  }

  // 解析 Bearer token
  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    return {
      ok: false,
      error: "Invalid Authorization header format (expected: Bearer <token>)",
    };
  }

  const providedToken = parts[1];
  if (!providedToken) {
    return {
      ok: false,
      error: "Empty bearer token",
    };
  }

  // 恒定时间比对防止时序攻击
  const secretBuffer = Buffer.from(configuredSecret, "utf-8");
  const tokenBuffer = Buffer.from(providedToken, "utf-8");

  // 长度不同时 timingSafeEqual 会抛出，需先检查长度
  // 但为了不泄露长度信息，先做哈希再比较
  // 更简洁的方式：统一长度后比较
  if (secretBuffer.length !== tokenBuffer.length) {
    // 为防止长度信息泄露，仍执行一次常量时间操作
    timingSafeEqual(secretBuffer, secretBuffer);
    return { ok: false, error: "Invalid credentials" };
  }

  if (!timingSafeEqual(secretBuffer, tokenBuffer)) {
    return { ok: false, error: "Invalid credentials" };
  }

  return {
    ok: true,
    principal: {
      type: "user",
      userId: MCP_ADMIN_PRINCIPAL_USER_ID,
      role: "super_admin",
    },
  };
}
