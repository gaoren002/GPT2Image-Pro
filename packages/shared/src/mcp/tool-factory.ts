/**
 * MCP Admin 工具工厂
 *
 * 职责：从 UOL Registry 读取操作定义，按权限过滤后转换为 MCP 工具格式。
 * 仅暴露 admin / superAdmin / imageBackendPoolViewer 权限的操作，
 * 排除 system / protected / apiKey / cron / webhook / proxySecret 以及
 * image-generation 和 external-api 域（用户侧 MCP 负责）。
 *
 * 使用方：route.ts 中响应 tools/list 请求
 * 关键依赖：uol/registry.ts（listOperations）、uol/types.ts（OperationDefinition）
 *
 * 设计决策：
 * - 最小暴露面：只暴露管理操作，不暴露用户侧或系统内部操作
 * - 工具名转换：点号(.) → 下划线(_)，兼容 MCP 工具名称规范
 * - JSON Schema 使用 Zod4 原生导出，保留输入约束与可选语义
 * - 添加 readOnlyHint / destructiveHint 注解供 agent 决策参考
 */
import { buildMcpInputSchema } from "./input-schema";
import type { Principal } from "../uol/principal";
import { isOperationBound, listOperations } from "../uol/registry";
import type { AccessRequirement, OperationDefinition } from "../uol/types";
import { getMcpDeniedOps, getMcpReadOnlyMode } from "./config";

/**
 * MCP 工具定义（JSON-RPC tools/list 响应中的单个工具）
 */
export interface McpToolDefinition {
  /** 工具名称（点号转下划线） */
  name: string;
  /** 工具描述（面向 agent） */
  description: string;
  /** JSON Schema 格式的输入参数 */
  inputSchema: Record<string, unknown>;
  /** 工具注解（只读/破坏性提示） */
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  };
}

/**
 * MCP Admin 允许暴露的 access kind 白名单。
 * 只有这些权限类型的操作才通过 MCP Admin 暴露。
 */
const ALLOWED_ACCESS_KINDS: ReadonlySet<AccessRequirement["kind"]> = new Set([
  "admin",
  "superAdmin",
  "imageBackendPoolViewer",
]);

/**
 * MCP Admin 排除的业务域。
 * image-generation 和 external-api 属于用户侧 MCP，不通过管理 MCP 暴露。
 */
const EXCLUDED_DOMAINS: ReadonlySet<string> = new Set([
  "image-generation",
  "external-api",
]);

/**
 * 将操作名转为 MCP 工具名（点号 → 下划线）。
 * MCP 工具名称规范不允许点号。
 */
export function operationNameToToolName(opName: string): string {
  return opName.replace(/\./g, "_");
}

/**
 * 将 MCP 工具名还原为操作名（下划线 → 点号）。
 * 注意：仅还原第一个下划线为点号（domain.operation 格式）。
 */
export function toolNameToOperationName(toolName: string): string {
  // 操作名格式为 "domain.operation"，即只有一个点号
  // 对应工具名为 "domain_operation"，只需还原第一个下划线
  const idx = toolName.indexOf("_");
  if (idx === -1) return toolName;
  return `${toolName.slice(0, idx)}.${toolName.slice(idx + 1)}`;
}

/**
 * 判断操作是否可通过 MCP Admin 暴露。
 *
 * 过滤条件：
 * 1. access.kind 在白名单中
 * 2. domain 不在排除列表中
 * 3. 不在 denied ops 列表中
 * 4. 只读模式下仅暴露 readOnly=true 的操作
 */
function isOperationExposable(
  op: OperationDefinition,
  deniedOps: string[],
  readOnlyMode: boolean
): boolean {
  // 权限白名单过滤
  if (!ALLOWED_ACCESS_KINDS.has(op.access.kind)) return false;

  // 仍是 shared 包中的 stub 时不暴露给 MCP 客户端。
  if (!isOperationBound(op.name)) return false;

  // 排除域过滤
  if (EXCLUDED_DOMAINS.has(op.domain)) return false;

  // denied ops 过滤
  if (deniedOps.includes(op.name)) return false;

  // 只读模式过滤
  if (readOnlyMode && !op.readOnly) return false;

  return true;
}

/**
 * 构建 MCP Admin 工具列表。
 *
 * 读取全局 registry，按权限过滤后转换为 MCP 工具格式。
 * principal 参数用于未来细粒度权限控制扩展（当前所有 MCP admin
 * 共享同一 super_admin 身份，已通过 access kind 过滤）。
 *
 * @param _principal - 当前 MCP 调用者身份（预留扩展）
 * @returns 可暴露的 MCP 工具定义数组
 */
export function buildAdminMcpTools(_principal: Principal): McpToolDefinition[] {
  const deniedOps = getMcpDeniedOps();
  const readOnlyMode = getMcpReadOnlyMode();
  const allOps = listOperations();

  const tools: McpToolDefinition[] = [];

  for (const op of allOps) {
    if (!isOperationExposable(op, deniedOps, readOnlyMode)) continue;

    const tool: McpToolDefinition = {
      name: operationNameToToolName(op.name),
      description: `[${op.domain}] ${op.title} - ${op.description}`,
      inputSchema: buildMcpInputSchema(op),
    };

    // 添加注解
    if (op.readOnly || op.destructive) {
      tool.annotations = {};
      if (op.readOnly) tool.annotations.readOnlyHint = true;
      if (op.destructive) tool.annotations.destructiveHint = true;
    }

    tools.push(tool);
  }

  return tools;
}
