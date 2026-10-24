/**
 * MCP Admin API 路由 - JSON-RPC 2.0 端点
 *
 * 职责：作为外部 agent（Claude Desktop / Codex 等）访问管理操作的单一入口。
 * 实现最小化 JSON-RPC 2.0 协议（initialize / tools/list / tools/call）。
 *
 * 使用方：外部 MCP 客户端通过 POST 请求调用
 * 关键依赖：
 * - @repo/shared/mcp（鉴权、配置、工具工厂、脱敏）
 * - @repo/shared/uol（invokeOperation、OperationError、Principal）
 * - @repo/shared/logger（结构化日志）
 *
 * 安全设计：
 * - 默认关闭：MCP_ENABLED 未设置时返回 404
 * - Bearer 密钥鉴权：timingSafeEqual 恒定时间比对
 * - 限流：内存滑动窗口（MCP 专用，阈值来自 MCP_RATE_LIMIT_PER_MIN 环境变量）
 * - 审计：每次 tools/call 记录脱敏后的调用日志
 * - 不暴露 system/protected/apiKey/cron/webhook/proxySecret 操作
 * - 不暴露 image-generation 和 external-api 域
 */
import {
  authenticateMcpAdmin,
  buildAdminMcpTools,
  getMcpRateLimitPerMin,
  isMcpAdminEnabled,
  redactSensitiveFields,
  toolNameToOperationName,
} from "@repo/shared/mcp";
import { logger } from "@repo/shared/logger";
import {
  invokeOperation,
  OperationError,
  type Principal,
} from "@repo/shared/uol";
import {
  readJsonBodyWithinLimit,
  SELF_AUTHENTICATED_BODY_MAX_BYTES,
} from "@/server/bounded-json-body";
import { ensureUolInitialized } from "@/server/uol-init";

// 确保所有操作已注册到 registry
import "@repo/shared/uol/operations";

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

// ============================================
// JSON-RPC 类型定义
// ============================================

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

// ============================================
// JSON-RPC 错误码
// ============================================

const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;
const JSONRPC_INTERNAL_ERROR = -32603;

// 自定义错误码（-32000 ~ -32099 范围内）
const JSONRPC_AUTH_ERROR = -32001;
const JSONRPC_RATE_LIMITED = -32002;
const JSONRPC_OPERATION_ERROR = -32003;

// ============================================
// 辅助函数
// ============================================

function jsonRpcSuccess(
  id: string | number | null,
  result: unknown,
): JsonRpcSuccessResponse {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

// ============================================
// MCP 协议版本
// ============================================

const MCP_PROTOCOL_VERSION = "2024-11-05";
const MCP_SERVER_NAME = "gpt2image-admin";
const MCP_SERVER_VERSION = "1.0.0";

// ============================================
// 内存限流（MCP 专用，独立于全局 rate-limit）
// ============================================

interface McpRateBucket {
  count: number;
  resetAt: number;
}

const mcpRateBuckets = new Map<string, McpRateBucket>();

/**
 * MCP 专用内存限流检查。
 * MCP 端点统一使用 "mcp_admin" 为标识前缀，
 * 按来源 IP（或固定标识）做每分钟限流。
 */
function checkMcpRateLimit(perMinLimit: number): boolean {
  const now = Date.now();
  const key = "mcp_admin_global";
  const bucket = mcpRateBuckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    // 清理过期桶
    if (mcpRateBuckets.size > 1000) {
      for (const [k, v] of mcpRateBuckets) {
        if (v.resetAt <= now) mcpRateBuckets.delete(k);
      }
    }
    mcpRateBuckets.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }

  bucket.count += 1;
  return bucket.count <= perMinLimit;
}

// ============================================
// POST Handler
// ============================================

export async function POST(request: Request) {
  // 1. 检查 MCP 是否启用
  if (!isMcpAdminEnabled()) {
    return NextResponse.json(
      { error: "MCP Admin is not enabled" },
      { status: 404 },
    );
  }

  // 2. 限流检查
  const rateLimit = getMcpRateLimitPerMin();
  if (!checkMcpRateLimit(rateLimit)) {
    return NextResponse.json(
      jsonRpcError(null, JSONRPC_RATE_LIMITED, "Rate limit exceeded"),
      { status: 429 },
    );
  }

  // 3. 鉴权
  const authHeader = request.headers.get("authorization");
  const authResult = authenticateMcpAdmin(authHeader);
  if (!authResult.ok) {
    return NextResponse.json(
      jsonRpcError(null, JSONRPC_AUTH_ERROR, authResult.error),
      { status: 401 },
    );
  }

  const { principal } = authResult;

  try {
    await ensureUolInitialized();
  } catch {
    return NextResponse.json(
      jsonRpcError(null, JSONRPC_INTERNAL_ERROR, "MCP tools are not ready"),
      { status: 500 },
    );
  }

  // 4. 解析请求体。本路径不经 middleware，必须在鉴权后限长读取。
  const parsed = await readJsonBodyWithinLimit(
    request,
    SELF_AUTHENTICATED_BODY_MAX_BYTES,
  );
  if (!parsed.ok) {
    return parsed.reason === "too_large"
      ? NextResponse.json(
          jsonRpcError(null, JSONRPC_INVALID_REQUEST, "Request body too large"),
          { status: 413 },
        )
      : NextResponse.json(
          jsonRpcError(null, JSONRPC_PARSE_ERROR, "Parse error"),
          { status: 400 },
        );
  }
  const body = parsed.value;

  // 5. 校验 JSON-RPC 格式
  const rpcRequest = body as Partial<JsonRpcRequest>;
  if (
    !rpcRequest ||
    rpcRequest.jsonrpc !== "2.0" ||
    typeof rpcRequest.method !== "string"
  ) {
    return NextResponse.json(
      jsonRpcError(
        rpcRequest?.id ?? null,
        JSONRPC_INVALID_REQUEST,
        "Invalid JSON-RPC request",
      ),
      { status: 400 },
    );
  }

  const id = rpcRequest.id ?? null;
  const method = rpcRequest.method;
  const params = rpcRequest.params ?? {};

  // 6. 路由 JSON-RPC 方法
  switch (method) {
    case "initialize":
      return NextResponse.json(
        jsonRpcSuccess(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          serverInfo: {
            name: MCP_SERVER_NAME,
            version: MCP_SERVER_VERSION,
          },
          capabilities: {
            tools: {},
          },
        }),
      );

    case "tools/list":
      return handleToolsList(id, principal);

    case "tools/call":
      return handleToolsCall(id, params, principal);

    default:
      return NextResponse.json(
        jsonRpcError(id, JSONRPC_METHOD_NOT_FOUND, `Unknown method: ${method}`),
        { status: 400 },
      );
  }
}

// ============================================
// Method Handlers
// ============================================

function handleToolsList(
  id: string | number | null,
  principal: Principal,
) {
  const tools = buildAdminMcpTools(principal);
  return NextResponse.json(jsonRpcSuccess(id, { tools }));
}

async function handleToolsCall(
  id: string | number | null,
  params: Record<string, unknown>,
  principal: Principal,
) {
  const toolName = params.name;
  const args = params.arguments ?? {};

  if (typeof toolName !== "string" || !toolName) {
    return NextResponse.json(
      jsonRpcError(
        id,
        JSONRPC_INVALID_PARAMS,
        "Missing or invalid 'name' in tools/call params",
      ),
      { status: 400 },
    );
  }

  // 工具名 → 操作名
  const operationName = toolNameToOperationName(toolName);
  const allowed = buildAdminMcpTools(principal).some(
    (tool) => tool.name === toolName,
  );
  if (!allowed) {
    return NextResponse.json(
      jsonRpcError(
        id,
        JSONRPC_METHOD_NOT_FOUND,
        `Tool not available: ${toolName}`,
      ),
      { status: 400 },
    );
  }

  // 审计日志（脱敏参数）
  logger.info(
    {
      mcp: true,
      method: "tools/call",
      tool: toolName,
      operation: operationName,
      params: redactSensitiveFields(args),
    },
    `[MCP Admin] tools/call: ${operationName}`,
  );

  try {
    const result = await invokeOperation(operationName, args, principal);
    return NextResponse.json(
      jsonRpcSuccess(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      }),
    );
  } catch (err: unknown) {
    if (err instanceof OperationError) {
      logger.warn(
        {
          mcp: true,
          method: "tools/call",
          tool: toolName,
          errorCode: err.code,
          errorMessage: err.message,
        },
        `[MCP Admin] Operation error: ${err.code} - ${err.message}`,
      );
      return NextResponse.json(
        jsonRpcError(id, JSONRPC_OPERATION_ERROR, err.message, {
          code: err.code,
          details: err.details,
        }),
      );
    }

    // 未知错误脱敏
    const errMsg =
      err instanceof Error ? err.message : "Unknown error";
    logger.error(
      {
        mcp: true,
        method: "tools/call",
        tool: toolName,
        err: errMsg,
      },
      `[MCP Admin] Unexpected error in tools/call`,
    );
    return NextResponse.json(
      jsonRpcError(id, JSONRPC_INTERNAL_ERROR, "Internal server error"),
      { status: 500 },
    );
  }
}
