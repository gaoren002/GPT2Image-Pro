/**
 * MCP User 端点 - JSON-RPC 2.0 路由
 *
 * 职责：为终端用户提供基于 MCP 协议的图像生成及只读查询能力。
 * 默认关闭（MCP_USER_ENABLED=true 启用），使用独立的 mcp_api_key 鉴权。
 *
 * 协议：JSON-RPC 2.0（无 SSE，图像生成异步返回 taskId，客户端轮询 getStatus）
 *
 * 支持方法：
 * - initialize: 返回 MCP server 能力声明
 * - tools/list: 返回当前用户可访问的工具列表
 * - tools/call: 调用指定工具（委托 UOL invokeOperation）
 *
 * 使用方：外部 MCP 客户端（如 Claude Desktop、Cursor 等）
 * 关键依赖：
 * - @repo/shared/mcp（配置、鉴权、工具工厂）
 * - @repo/shared/uol（操作注册表、调用网关）
 * - @repo/database（mcp_api_key 表查询）
 *
 * 安全约束：
 * - 完全独立于 Admin MCP（不同路由、不同鉴权、不同工具集）
 * - 用户 MCP key 独立于 v1 API key（mcp_api_key 表）
 * - 绝不暴露管理员操作
 * - 计费走统一管线（与 v1 API 一致）
 */
import { type NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";

import { db } from "@repo/database";
import { mcpApiKey, user } from "@repo/database/schema";
import { and, eq } from "drizzle-orm";

import {
  isMcpUserEnabled,
  bindMcpUserAuth,
  authenticateMcpUserKey,
  buildUserMcpTools,
  McpAuthError,
} from "@repo/shared/mcp";
import { invokeOperation } from "@repo/shared/uol";
import type { Principal } from "@repo/shared/uol";
import { checkRateLimit } from "@repo/shared/rate-limit";
import { logWarn } from "@repo/shared/logger";
import { getUserPlan } from "@repo/shared/subscription/services/user-plan";
import {
  readJsonBodyWithinLimit,
  SELF_AUTHENTICATED_BODY_MAX_BYTES,
} from "@/server/bounded-json-body";
import { ensureUolInitialized } from "@/server/uol-init";

// 副作用导入：确保所有 UOL 操作已注册到 registry
import "@repo/shared/uol/operations";

// ============================================
// 鉴权绑定（进程启动时执行一次）
// ============================================

/**
 * 绑定 MCP User 鉴权的真实实现（含 DB 访问）。
 *
 * 查询 mcp_api_key 表，校验 key 有效性与用户状态，
 * 返回 Principal { type: "apiKey" }。
 */
bindMcpUserAuth(async (authHeader: string): Promise<Principal> => {
  if (!authHeader.startsWith("Bearer ")) {
    throw new McpAuthError("Missing or invalid Bearer token");
  }

  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    throw new McpAuthError("Empty Bearer token");
  }

  const keyHash = createHash("sha256").update(token).digest("hex");

  const keys = await db
    .select({
      id: mcpApiKey.id,
      userId: mcpApiKey.userId,
      keyHash: mcpApiKey.keyHash,
      isActive: mcpApiKey.isActive,
      userBanned: user.banned,
    })
    .from(mcpApiKey)
    .innerJoin(user, eq(user.id, mcpApiKey.userId))
    .where(
      and(
        eq(mcpApiKey.keyHash, keyHash),
        eq(mcpApiKey.isActive, true),
      ),
    )
    .limit(1);

  const record = keys[0];
  if (!record) {
    throw new McpAuthError("Invalid or inactive MCP key");
  }

  if (record.userBanned) {
    throw new McpAuthError("Account is banned", 403);
  }

  // 更新最后使用时间（非关键路径，失败不阻断）
  db.update(mcpApiKey)
    .set({ lastUsedAt: new Date(), updatedAt: new Date() })
    .where(eq(mcpApiKey.id, record.id))
    .catch(() => {
      /* 静默：lastUsedAt 更新失败不影响请求处理 */
    });

  const plan = await getUserPlan(record.userId);

  return {
    type: "apiKey",
    userId: record.userId,
    apiKeyId: record.id,
    plan: plan.plan,
    relayOnly: false,
  };
});

// ============================================
// JSON-RPC 类型
// ============================================

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

// ============================================
// JSON-RPC 错误码
// ============================================

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_SERVER_ERROR = -32000;

// ============================================
// MCP User rate limit 标识前缀
// ============================================

const MCP_USER_RATE_LIMIT_PREFIX = "mcp-user-key:";

// ============================================
// POST Handler
// ============================================

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. 功能开关检查
  if (!isMcpUserEnabled()) {
    return NextResponse.json(
      { error: "MCP User endpoint is disabled" },
      { status: 404 },
    );
  }

  // 2. 鉴权
  const authHeader = request.headers.get("authorization") || "";
  let principal: Principal;
  try {
    principal = await authenticateMcpUserKey(authHeader);
  } catch (err: unknown) {
    if (err instanceof McpAuthError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.httpStatus },
      );
    }
    return NextResponse.json(
      { error: "Authentication failed" },
      { status: 401 },
    );
  }

  // 3. Per-key 速率限制
  if (principal.type === "apiKey") {
    const rateLimit = await checkRateLimit(
      `${MCP_USER_RATE_LIMIT_PREFIX}${principal.apiKeyId}`,
      "ai",
    );
    if (!rateLimit.success) {
      logWarn("MCP User key rate limit exceeded", {
        source: "mcp-user-route",
        apiKeyId: principal.apiKeyId,
        userId: principal.userId,
        limit: rateLimit.limit,
        reset: rateLimit.reset,
      });
      return NextResponse.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: JSON_RPC_SERVER_ERROR,
            message: "Rate limit exceeded",
          },
        } satisfies JsonRpcResponse,
        { status: 429 },
      );
    }
  }

  try {
    await ensureUolInitialized();
  } catch {
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: JSON_RPC_SERVER_ERROR,
          message: "MCP tools are not ready",
        },
      } satisfies JsonRpcResponse,
      { status: 500 },
    );
  }

  // 4. 解析 JSON-RPC 请求体。本路径不经 middleware，必须在鉴权后限长读取。
  const parsed = await readJsonBodyWithinLimit(
    request,
    SELF_AUTHENTICATED_BODY_MAX_BYTES,
  );
  if (!parsed.ok) {
    const tooLarge = parsed.reason === "too_large";
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: tooLarge ? JSON_RPC_INVALID_REQUEST : JSON_RPC_PARSE_ERROR,
          message: tooLarge
            ? "Request body too large"
            : "Failed to parse JSON body",
        },
      } satisfies JsonRpcResponse,
      { status: tooLarge ? 413 : 400 },
    );
  }
  const body = parsed.value as Partial<JsonRpcRequest> | null;
  if (
    !body ||
    typeof body !== "object" ||
    body.jsonrpc !== "2.0" ||
    typeof body.method !== "string"
  ) {
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: JSON_RPC_INVALID_REQUEST,
          message: "Invalid JSON-RPC request",
        },
      } satisfies JsonRpcResponse,
      { status: 400 },
    );
  }
  const rpcRequest = body as JsonRpcRequest;

  // 5. 路由 JSON-RPC method
  const response = await handleMethod(rpcRequest, principal);
  return NextResponse.json(response);
}

// ============================================
// Method Router
// ============================================

async function handleMethod(
  req: JsonRpcRequest,
  principal: Principal,
): Promise<JsonRpcResponse> {
  switch (req.method) {
    case "initialize":
      return handleInitialize(req);
    case "tools/list":
      return handleToolsList(req, principal);
    case "tools/call":
      return handleToolsCall(req, principal);
    default:
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: {
          code: JSON_RPC_METHOD_NOT_FOUND,
          message: `Unknown method: ${req.method}`,
        },
      };
  }
}

// ============================================
// initialize
// ============================================

function handleInitialize(req: JsonRpcRequest): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: req.id,
    result: {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: { listChanged: false },
      },
      serverInfo: {
        name: "gpt2image-user-mcp",
        version: "1.0.0",
      },
    },
  };
}

// ============================================
// tools/list
// ============================================

function handleToolsList(
  req: JsonRpcRequest,
  principal: Principal,
): JsonRpcResponse {
  const tools = buildUserMcpTools(principal);
  return {
    jsonrpc: "2.0",
    id: req.id,
    result: { tools },
  };
}

// ============================================
// tools/call
// ============================================

async function handleToolsCall(
  req: JsonRpcRequest,
  principal: Principal,
): Promise<JsonRpcResponse> {
  const params = req.params ?? {};
  const toolName = params.name as string | undefined;
  const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;

  if (!toolName || typeof toolName !== "string") {
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: {
        code: JSON_RPC_INVALID_REQUEST,
        message: "Missing tool name in params.name",
      },
    };
  }

  // 验证工具在用户白名单中
  const userTools = buildUserMcpTools(principal);
  const allowed = userTools.some(
    (t: { name: string }) => t.name === toolName,
  );
  if (!allowed) {
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: {
        code: JSON_RPC_METHOD_NOT_FOUND,
        message: `Tool not available: ${toolName}`,
      },
    };
  }

  // 为需要 userId 的操作自动注入（防止用户伪造其他用户 ID）
  const enrichedArgs = enrichArgsWithUserId(toolArgs, principal);

  try {
    const result = await invokeOperation(
      toolName,
      enrichedArgs,
      principal,
    );
    return {
      jsonrpc: "2.0",
      id: req.id,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
        isError: false,
      },
    };
  } catch (e: unknown) {
    const error = e as { code?: string; message?: string; httpStatus?: number };
    return {
      jsonrpc: "2.0",
      id: req.id,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: error.code ?? "internal_error",
              message: error.message ?? "An unexpected error occurred",
            }),
          },
        ],
        isError: true,
      },
    };
  }
}

/**
 * 为操作参数自动注入当前用户 ID。
 *
 * 安全约束：用户不可通过 MCP 操作其他用户的数据。
 * 当操作 input 包含 userId 字段时，强制覆盖为当前 principal 的 userId。
 */
function enrichArgsWithUserId(
  args: Record<string, unknown>,
  principal: Principal,
): Record<string, unknown> {
  if (principal.type !== "apiKey" && principal.type !== "user") {
    return args;
  }
  // 强制注入 userId，防止越权
  return {
    ...args,
    userId: principal.userId,
  };
}
