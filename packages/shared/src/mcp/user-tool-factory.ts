/**
 * MCP User 工具工厂
 *
 * 职责：根据调用者 Principal（含 plan 信息），从 UOL Registry 中
 * 筛选出用户可通过 MCP 访问的操作子集，并转化为 MCP Tool 描述。
 *
 * 筛选规则：
 * - 仅暴露预定义的白名单操作（image-generation / external-api / credits / subscription 域的特定只读+生图操作）
 * - 绝不暴露管理员操作
 * - 操作可用性受套餐能力位约束
 *
 * 使用方：MCP user route handler（tools/list 方法）
 * 关键依赖：../uol/registry（listOperations、getOperation）、../uol/types
 */
import { buildMcpInputSchema } from "./input-schema";
import { getOperation, isOperationBound } from "../uol/registry";
import type { OperationDefinition } from "../uol/types";
import type { Principal } from "../uol/principal";

/**
 * MCP Tool 描述 - 对应 MCP 协议 tools/list 响应中的单个工具项
 */
export interface McpToolDescriptor {
  /** 工具名称（对应 UOL operation name） */
  name: string;
  /** 人类可读描述 */
  description: string;
  /** JSON Schema 格式的输入 schema */
  inputSchema: Record<string, unknown>;
  /** MCP Tool 注解（只读/破坏性/副作用等） */
  annotations: {
    readOnly: boolean;
    destructive: boolean;
    sideEffects: string[];
    domain: string;
  };
}

/**
 * 用户 MCP 可访问的操作白名单。
 *
 * 仅列出终端用户通过 MCP 协议应可调用的操作名称。
 * 管理员操作、内部操作、危险操作一律不在此列。
 *
 * 分类：
 * - image-generation: 生成核心 + 状态查询 + 历史
 * - external-api (read-only): 余额、模型列表
 * - credits (read-only): 余额、活跃批次、交易记录
 * - subscription (read-only): 当前套餐、能力位查询
 */
const USER_MCP_ALLOWED_OPERATIONS: readonly string[] = [
  // 图像生成核心
  "image.generate",
  "image.getStatus",
  "image.getUserGenerations",
  "image.getUserGenerationCount",

  // 外部 API 只读端点
  "externalApi.getCredits",
  "externalApi.getModels",

  // 积分只读端点
  "credits.getBalance",
  "credits.getMyActiveBatches",
  "credits.getMyTransactions",

  // 订阅只读端点
  "subscription.getMyPlan",
  "subscription.canUseCapability",
] as const;

/**
 * 构建用户 MCP 工具列表。
 *
 * 从 UOL Registry 中读取白名单操作，过滤出当前用户套餐可访问的子集，
 * 转化为 MCP Tool 描述列表。
 *
 * @param principal - 已鉴权的调用者身份（含 plan 信息）
 * @returns 用户可调用的 MCP 工具描述列表
 *
 * 副作用：无（纯读取 registry + 过滤）
 * 边界：registry 中不存在的操作名静默跳过（不报错）
 */
export function buildUserMcpTools(principal: Principal): McpToolDescriptor[] {
  const tools: McpToolDescriptor[] = [];

  for (const opName of USER_MCP_ALLOWED_OPERATIONS) {
    const def: OperationDefinition | undefined = getOperation(opName);
    if (!def) continue;
    if (!isOperationBound(opName)) continue;

    // 基本 access 校验：apiKey 和 protected 类型操作对 MCP user 均可
    if (
      def.access.kind !== "protected" &&
      def.access.kind !== "apiKey" &&
      def.access.kind !== "owner"
    ) {
      continue;
    }

    // 套餐能力位过滤：如操作声明了 planCapability，当前用户 plan 需满足
    if (def.access.kind === "apiKey" && "planCapability" in def.access) {
      const requiredCap = def.access.planCapability;
      if (requiredCap && principal.type === "apiKey") {
        // 简单套餐等级判断：enterprise > ultra > pro > starter > free
        const planHierarchy = ["free", "starter", "pro", "ultra", "enterprise"];
        const userLevel = planHierarchy.indexOf(principal.plan);
        const requiredLevel = planHierarchy.indexOf(requiredCap);
        if (userLevel < requiredLevel) continue;
      }
    }

    tools.push({
      name: def.name,
      description: def.description,
      inputSchema: buildMcpInputSchema(def, ["userId"]),
      annotations: {
        readOnly: def.readOnly,
        destructive: def.destructive,
        sideEffects: [...def.sideEffects],
        domain: def.domain,
      },
    });
  }

  return tools;
}
