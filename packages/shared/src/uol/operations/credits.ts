/**
 * UOL Operations - credits (积分计费) 领域操作注册
 *
 * 职责：注册所有积分计费相关操作到全局注册表。
 * 涵盖余额查询、发放、消耗、冻结、管理员调整、退款、过期处理等。
 *
 * 使用方：应用启动时通过 import 触发注册；invoke 网关通过名称调用。
 * 关键依赖：../registry（defineOperation）、zod（schema 校验）、
 * ../../credits/core（积分核心 service-fns）、
 * ../../generation-maintenance（退款 service-fn）
 */
import { z } from "zod";

import { defineOperation } from "../registry";
import { getPrincipalUserId } from "../principal";
import {
  getCreditsBalance,
  grantCredits,
  consumeCredits,
  freezeCreditsAccount,
  unfreezeCreditsAccount,
  processExpiredBatches,
  getUserActiveBatches as fetchUserActiveBatches,
  getUserTransactions as fetchUserTransactions,
  getUserTransactionsCount,
  voidActiveSubscriptionCreditsForUpgrade,
  ensureRegistrationBonus,
} from "../../credits/core";
import { refundGenerationCredits } from "../../generation-maintenance";
import { getRuntimeSettingNumber } from "../../system-settings";

// ---------------------------------------------------------------------------
// 1. credits.getBalance - 获取指定用户积分余额（含过期处理副作用）
// ---------------------------------------------------------------------------
export const getBalance = defineOperation({
  name: "credits.getBalance",
  domain: "credits",
  title: "Get Credits Balance",
  description:
    "获取指定用户的积分余额。语义只读但内部会触发过期批次处理" +
    "（条件更新已过期 batch 状态）以及 ensureCreditsBalance（无账户则创建）。",
  input: z.object({
    userId: z.string().describe("目标用户 ID"),
  }),
  output: z.object({
    balance: z.number().describe("当前可用积分余额"),
  }),
  access: { kind: "protected" },
  readOnly: false,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: ["billing"],
  hasMaintenanceWrite: true,
  execute: async (input) => {
    const account = await getCreditsBalance(input.userId);
    return { balance: account.balance };
  },
});

// ---------------------------------------------------------------------------
// 2. credits.getMyBalance - 获取当前用户积分余额（含注册奖励副作用）
// ---------------------------------------------------------------------------
export const getMyBalance = defineOperation({
  name: "credits.getMyBalance",
  domain: "credits",
  title: "Get My Credits Balance",
  description:
    "获取当前登录用户的积分余额。首次调用时会触发注册奖励发放" +
    "（ensureRegistrationBonus），由 sourceRef 唯一索引保证只发一次。",
  input: z.object({}),
  output: z.object({
    balance: z.number().describe("当前可用积分余额"),
  }),
  access: { kind: "protected" },
  readOnly: false,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: ["billing"],
  hasMaintenanceWrite: true,
  execute: async (_input, principal) => {
    const userId = getPrincipalUserId(principal);
    if (!userId) throw new Error("No userId in principal");

    // 注册奖励：首次查询余额时懒加载发放
    const bonusAmount = await getRuntimeSettingNumber(
      "REGISTRATION_BONUS_CREDITS",
      100,
      { nonNegative: true },
    );
    await ensureRegistrationBonus(userId, bonusAmount);

    const account = await getCreditsBalance(userId);
    return { balance: account.balance };
  },
});

// ---------------------------------------------------------------------------
// 3. credits.grant - 发放积分（webhook/admin/refund 调用）
// ---------------------------------------------------------------------------
export const grant = defineOperation({
  name: "credits.grant",
  domain: "credits",
  title: "Grant Credits",
  description:
    "向用户发放积分（事务内创建 batch + transaction + 更新余额）。" +
    "传入 sourceRef 时强幂等（onConflict source_type+source_ref）；" +
    "不传 sourceRef 则不幂等。冻结账户会抛错拒绝发放。",
  input: z.object({
    userId: z.string().describe("目标用户 ID"),
    amount: z.number().int().positive().describe("发放积分数量"),
    sourceType: z
      .string()
      .describe("来源类型：purchase/subscription/admin_grant/refund/bonus 等"),
    sourceRef: z
      .string()
      .optional()
      .describe("幂等键（唯一来源引用）；有则强幂等"),
    expiresAt: z
      .string()
      .datetime()
      .optional()
      .describe("批次过期时间（ISO8601）"),
    reason: z.string().optional().describe("发放原因备注"),
  }),
  output: z.object({
    batchId: z.string().describe("新建积分批次 ID"),
    balance: z.number().describe("发放后最新余额"),
  }),
  access: { kind: "protected" },
  readOnly: false,
  destructive: false,
  idempotency: {
    kind: "required",
    keyField: "sourceRef",
    scope: "per-user",
  },
  sideEffects: ["billing"],
  execute: async (input) => {
    const params: Parameters<typeof grantCredits>[0] = {
      userId: input.userId,
      amount: input.amount,
      sourceType: input.sourceType as Parameters<typeof grantCredits>[0]["sourceType"],
      debitAccount: `SYSTEM:${input.sourceType}`,
      transactionType: input.sourceType as Parameters<typeof grantCredits>[0]["transactionType"],
      ...(input.reason != null ? { description: input.reason } : {}),
    };
    if (input.sourceRef) {
      params.sourceRef = input.sourceRef;
    }
    if (input.expiresAt) {
      params.expiresAt = new Date(input.expiresAt);
    }
    const result = await grantCredits(params);
    return {
      batchId: result.batchId ?? "",
      balance: result.newBalance,
    };
  },
});

// ---------------------------------------------------------------------------
// 4. credits.consume - 消耗积分（带 sourceRef 强幂等）
// ---------------------------------------------------------------------------
export const consume = defineOperation({
  name: "credits.consume",
  domain: "credits",
  title: "Consume Credits",
  description:
    "从用户余额中扣减积分（FIFO 优先级 bonus>subscription>purchase）。" +
    "内部先触发过期批次处理，再逐批扣减并记账。传入 sourceRef 时" +
    "通过 per-user 偏唯一索引 (user_id,type,source_ref) 保证强幂等。",
  input: z.object({
    userId: z.string().describe("目标用户 ID"),
    amount: z.number().int().positive().describe("扣减积分数量"),
    type: z.string().describe("消耗类型：generation/manual_deduct 等"),
    sourceRef: z
      .string()
      .optional()
      .describe("幂等键；传入则强幂等，不传则不幂等"),
    reason: z.string().optional().describe("消耗原因"),
  }),
  output: z.object({
    transactionId: z.string().describe("交易记录 ID"),
    balance: z.number().describe("扣减后最新余额"),
  }),
  access: { kind: "protected" },
  readOnly: false,
  destructive: false,
  idempotency: {
    kind: "required",
    keyField: "sourceRef",
    scope: "per-user",
  },
  sideEffects: ["billing"],
  execute: async (input) => {
    const result = await consumeCredits({
      userId: input.userId,
      amount: input.amount,
      serviceName: input.type,
      ...(input.sourceRef != null ? { sourceRef: input.sourceRef } : {}),
      ...(input.reason != null ? { description: input.reason } : {}),
    });
    return {
      transactionId: result.transactionId,
      balance: result.remainingBalance,
    };
  },
});

// ---------------------------------------------------------------------------
// 5. credits.useCredits - 用户侧消耗积分（不传 sourceRef，非幂等）
// ---------------------------------------------------------------------------
export const useCredits = defineOperation({
  name: "credits.useCredits",
  domain: "credits",
  title: "Use Credits (Non-Idempotent)",
  description:
    "用户侧消耗积分的 server-action 形态。内部调用 consumeCredits 但" +
    "不传 sourceRef，因此重复提交会重复扣费。适用于用户手动消耗场景。" +
    "注意：此操作非幂等，调用方应做前端去重。",
  input: z.object({
    amount: z.number().int().positive().describe("消耗积分数量"),
    reason: z.string().optional().describe("消耗原因"),
  }),
  output: z.object({
    success: z.boolean(),
    balance: z.number().describe("扣减后最新余额"),
  }),
  access: { kind: "protected" },
  readOnly: false,
  destructive: false,
  idempotency: { kind: "none" },
  sideEffects: ["billing"],
  execute: async (input, principal) => {
    const userId = getPrincipalUserId(principal);
    if (!userId) throw new Error("No userId in principal");

    const result = await consumeCredits({
      userId,
      amount: input.amount,
      serviceName: "manual",
      ...(input.reason != null ? { description: input.reason } : {}),
    });
    return {
      success: result.success,
      balance: result.remainingBalance,
    };
  },
});

// ---------------------------------------------------------------------------
// 6. credits.checkAvailable - 检查用户积分是否足够
// ---------------------------------------------------------------------------
export const checkAvailable = defineOperation({
  name: "credits.checkAvailable",
  domain: "credits",
  title: "Check Credits Available",
  description:
    "检查当前用户积分余额是否满足指定数量要求。语义只读但内部会" +
    "触发 getCreditsBalance（含过期处理副作用）。",
  input: z.object({
    amount: z.number().int().positive().describe("需要检查的积分数量"),
  }),
  output: z.object({
    available: z.boolean().describe("是否有足够积分"),
    balance: z.number().describe("当前余额"),
  }),
  access: { kind: "protected" },
  readOnly: false,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: ["billing"],
  hasMaintenanceWrite: true,
  execute: async (input, principal) => {
    const userId = getPrincipalUserId(principal);
    if (!userId) throw new Error("No userId in principal");

    const account = await getCreditsBalance(userId);
    return {
      available: account.balance >= input.amount,
      balance: account.balance,
    };
  },
});

// ---------------------------------------------------------------------------
// 7. credits.getMyActiveBatches - 获取当前用户活跃积分批次
// ---------------------------------------------------------------------------
export const getMyActiveBatches = defineOperation({
  name: "credits.getMyActiveBatches",
  domain: "credits",
  title: "Get My Active Batches",
  description:
    "获取当前登录用户的所有活跃（status=active）积分批次列表，" +
    "包含剩余积分、过期时间等信息。纯读操作。",
  input: z.object({}),
  output: z.object({
    batches: z.array(
      z.object({
        id: z.string(),
        sourceType: z.string(),
        remaining: z.number(),
        expiresAt: z.string().datetime().nullable(),
        createdAt: z.string().datetime(),
      }),
    ),
  }),
  access: { kind: "protected" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async (_input, principal) => {
    const userId = getPrincipalUserId(principal);
    if (!userId) throw new Error("No userId in principal");

    const batches = await fetchUserActiveBatches(userId);
    return {
      batches: batches.map((b) => ({
        id: b.id,
        sourceType: b.sourceType,
        remaining: b.remaining,
        expiresAt: b.expiresAt?.toISOString() ?? null,
        createdAt: b.issuedAt.toISOString(),
      })),
    };
  },
});

// ---------------------------------------------------------------------------
// 8. credits.getUserActiveBatches - 获取指定用户活跃积分批次
// ---------------------------------------------------------------------------
export const getUserActiveBatches = defineOperation({
  name: "credits.getUserActiveBatches",
  domain: "credits",
  title: "Get User Active Batches",
  description:
    "获取指定用户的所有活跃积分批次列表（管理员或内部服务调用）。" +
    "纯读操作，无内置鉴权。",
  input: z.object({
    userId: z.string().describe("目标用户 ID"),
  }),
  output: z.object({
    batches: z.array(
      z.object({
        id: z.string(),
        sourceType: z.string(),
        remaining: z.number(),
        expiresAt: z.string().datetime().nullable(),
        createdAt: z.string().datetime(),
      }),
    ),
  }),
  access: { kind: "admin" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async (input) => {
    const batches = await fetchUserActiveBatches(input.userId);
    return {
      batches: batches.map((b) => ({
        id: b.id,
        sourceType: b.sourceType,
        remaining: b.remaining,
        expiresAt: b.expiresAt?.toISOString() ?? null,
        createdAt: b.issuedAt.toISOString(),
      })),
    };
  },
});

// ---------------------------------------------------------------------------
// 9. credits.getMyTransactions - 获取当前用户交易记录
// ---------------------------------------------------------------------------
export const getMyTransactions = defineOperation({
  name: "credits.getMyTransactions",
  domain: "credits",
  title: "Get My Transactions",
  description: "获取当前登录用户的积分交易记录列表（分页）。纯读操作。",
  input: z.object({
    limit: z.number().int().positive().default(20).describe("每页条数"),
    offset: z.number().int().min(0).default(0).describe("偏移量"),
  }),
  output: z.object({
    transactions: z.array(
      z.object({
        id: z.string(),
        type: z.string(),
        amount: z.number(),
        sourceRef: z.string().nullable(),
        createdAt: z.string().datetime(),
      }),
    ),
    total: z.number().describe("总记录数"),
  }),
  access: { kind: "protected" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async (input, principal) => {
    const userId = getPrincipalUserId(principal);
    if (!userId) throw new Error("No userId in principal");

    const [transactions, total] = await Promise.all([
      fetchUserTransactions(userId, {
        limit: input.limit,
        offset: input.offset,
      }),
      getUserTransactionsCount(userId),
    ]);
    return {
      transactions: transactions.map((t) => ({
        id: t.id,
        type: t.type,
        amount: t.amount,
        sourceRef: t.sourceRef ?? null,
        createdAt: t.createdAt.toISOString(),
      })),
      total,
    };
  },
});

// ---------------------------------------------------------------------------
// 10. credits.getUserTransactions - 获取指定用户交易记录（管理员）
// ---------------------------------------------------------------------------
export const getUserTransactions = defineOperation({
  name: "credits.getUserTransactions",
  domain: "credits",
  title: "Get User Transactions",
  description:
    "获取指定用户的积分交易记录列表（管理员查询，分页）。纯读操作。",
  input: z.object({
    userId: z.string().describe("目标用户 ID"),
    limit: z.number().int().positive().default(20).describe("每页条数"),
    offset: z.number().int().min(0).default(0).describe("偏移量"),
  }),
  output: z.object({
    transactions: z.array(
      z.object({
        id: z.string(),
        type: z.string(),
        amount: z.number(),
        sourceRef: z.string().nullable(),
        createdAt: z.string().datetime(),
      }),
    ),
    total: z.number().describe("总记录数"),
  }),
  access: { kind: "admin" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async (input) => {
    const [transactions, total] = await Promise.all([
      fetchUserTransactions(input.userId, {
        limit: input.limit,
        offset: input.offset,
      }),
      getUserTransactionsCount(input.userId),
    ]);
    return {
      transactions: transactions.map((t) => ({
        id: t.id,
        type: t.type,
        amount: t.amount,
        sourceRef: t.sourceRef ?? null,
        createdAt: t.createdAt.toISOString(),
      })),
      total,
    };
  },
});

// ---------------------------------------------------------------------------
// 11. credits.getUserTransactionCount - 获取指定用户交易总数
// ---------------------------------------------------------------------------
export const getUserTransactionCount = defineOperation({
  name: "credits.getUserTransactionCount",
  domain: "credits",
  title: "Get User Transaction Count",
  description: "获取指定用户的积分交易总记录数（管理员查询）。纯读操作。",
  input: z.object({
    userId: z.string().describe("目标用户 ID"),
  }),
  output: z.object({
    count: z.number().describe("交易总记录数"),
  }),
  access: { kind: "admin" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async (input) => {
    const count = await getUserTransactionsCount(input.userId);
    return { count };
  },
});

// ---------------------------------------------------------------------------
// 12. credits.voidSubscriptionCreditsForUpgrade - 升级时作废订阅积分
// ---------------------------------------------------------------------------
export const voidSubscriptionCreditsForUpgrade = defineOperation({
  name: "credits.voidSubscriptionCreditsForUpgrade",
  domain: "credits",
  title: "Void Subscription Credits For Upgrade",
  description:
    "套餐升级时作废当前订阅周期剩余的活跃订阅积分批次。" +
    "逐批次置 expired + 写 expiration 交易 + 扣减余额。" +
    "条件更新（status=active）保证幂等。由支付 webhook 调用。",
  input: z.object({
    userId: z.string().describe("目标用户 ID"),
  }),
  output: z.object({
    voidedCount: z.number().describe("作废的批次数量"),
    deductedAmount: z.number().describe("扣减的总积分数"),
  }),
  access: { kind: "webhook", provider: "creem" },
  readOnly: false,
  destructive: true,
  idempotency: { kind: "natural" },
  sideEffects: ["billing"],
  execute: async (input) => {
    const result = await voidActiveSubscriptionCreditsForUpgrade({
      userId: input.userId,
    });
    return {
      voidedCount: result.voidedBatches.length,
      deductedAmount: result.voidedAmount,
    };
  },
});

// ---------------------------------------------------------------------------
// 13. credits.processExpired - 处理过期积分批次
// ---------------------------------------------------------------------------
export const processExpired = defineOperation({
  name: "credits.processExpired",
  domain: "credits",
  title: "Process Expired Batches",
  description:
    "扫描并处理所有已过期但状态仍为 active 的积分批次。" +
    "逐批次置 expired + 写 expiration 交易 + 扣减余额 + logEvent。" +
    "条件更新保证每批只处理一次（幂等收敛）。" +
    "由 cron/getBalance/consume 内部触发。",
  input: z.object({
    userId: z.string().describe("目标用户 ID"),
  }),
  output: z.object({
    processedCount: z.number().describe("已处理的过期批次数量"),
  }),
  access: { kind: "system" },
  readOnly: false,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: ["billing"],
  hasMaintenanceWrite: true,
  execute: async (input) => {
    const results = await processExpiredBatches({ userId: input.userId });
    return { processedCount: results?.length ?? 0 };
  },
});

// ---------------------------------------------------------------------------
// 14. credits.runExpireJob - 积分过期定时任务（cron）
// ---------------------------------------------------------------------------
export const runExpireJob = defineOperation({
  name: "credits.runExpireJob",
  domain: "credits",
  title: "Run Credits Expire Job",
  description:
    "积分过期 cron 任务入口。扫描所有有活跃批次待过期的用户，" +
    "逐用户调用 processExpiredBatches。依赖底层幂等保证可安全重复执行。" +
    "通过 cron-secret Bearer token 鉴权（timingSafeEqual）。",
  input: z.object({}),
  output: z.object({
    usersProcessed: z.number().describe("处理的用户数"),
    batchesExpired: z.number().describe("过期的批次总数"),
  }),
  access: { kind: "cron" },
  readOnly: false,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: ["billing"],
  hasMaintenanceWrite: true,
  execute: async () => {
    // 不传 userId 则处理所有用户的过期批次
    const results = await processExpiredBatches();
    const uniqueUsers = new Set(results?.map((r) => r.userId) ?? []);
    return {
      usersProcessed: uniqueUsers.size,
      batchesExpired: results?.length ?? 0,
    };
  },
});

// ---------------------------------------------------------------------------
// 15. credits.freeze - 冻结用户积分账户
// ---------------------------------------------------------------------------
export const freeze = defineOperation({
  name: "credits.freeze",
  domain: "credits",
  title: "Freeze Credits Account",
  description:
    "将用户积分账户状态设为 frozen。冻结后该用户无法被发放或消耗积分。" +
    "幂等操作（已冻结则无变化）。",
  input: z.object({
    userId: z.string().describe("目标用户 ID"),
  }),
  output: z.object({
    success: z.boolean(),
  }),
  access: { kind: "admin" },
  readOnly: false,
  destructive: true,
  idempotency: { kind: "natural" },
  sideEffects: ["billing", "audit"],
  execute: async (input) => {
    await freezeCreditsAccount(input.userId);
    return { success: true };
  },
});

// ---------------------------------------------------------------------------
// 16. credits.unfreeze - 解冻用户积分账户
// ---------------------------------------------------------------------------
export const unfreeze = defineOperation({
  name: "credits.unfreeze",
  domain: "credits",
  title: "Unfreeze Credits Account",
  description:
    "将用户积分账户状态恢复为 active。解冻后恢复正常发放与消耗。" +
    "幂等操作（已 active 则无变化）。",
  input: z.object({
    userId: z.string().describe("目标用户 ID"),
  }),
  output: z.object({
    success: z.boolean(),
  }),
  access: { kind: "admin" },
  readOnly: false,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: ["billing", "audit"],
  execute: async (input) => {
    await unfreezeCreditsAccount(input.userId);
    return { success: true };
  },
});

// ---------------------------------------------------------------------------
// 17. credits.setStatus - 管理员设置用户积分状态（含审计）
// ---------------------------------------------------------------------------
export const setStatus = defineOperation({
  name: "credits.setStatus",
  domain: "credits",
  title: "Set User Credits Status",
  description:
    "管理员操作：设置用户积分账户状态（frozen/active）。" +
    "内部调用 freeze/unfreeze + 写审计日志 + revalidate 缓存。" +
    "底层操作幂等，但审计日志每次追加。",
  input: z.object({
    userId: z.string().describe("目标用户 ID"),
    status: z
      .enum(["active", "frozen"])
      .describe("目标状态"),
  }),
  output: z.object({
    success: z.boolean(),
  }),
  access: { kind: "admin" },
  readOnly: false,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: ["billing", "audit", "cache"],
  execute: async (input) => {
    if (input.status === "frozen") {
      await freezeCreditsAccount(input.userId);
    } else {
      await unfreezeCreditsAccount(input.userId);
    }
    return { success: true };
  },
});

// ---------------------------------------------------------------------------
// 18. credits.adminGrant - 管理员充值的独立 UOL 契约与原子事务服务
// ---------------------------------------------------------------------------
export { adminGrant } from "./credits-admin-grant";

// ---------------------------------------------------------------------------
// 19. credits.adminAdjust - 管理员调整积分（set/deduct，非幂等）
// ---------------------------------------------------------------------------
export const adminAdjust = defineOperation({
  name: "credits.adminAdjust",
  domain: "credits",
  title: "Admin Adjust Credits",
  description:
    "超级管理员调整用户积分。mode=set 时计算差额后 grant 或 consume；" +
    "mode=deduct 时直接 consume。注意：基于读后写（TOCTOU）实现，" +
    "非幂等，存在并发竞态风险。含审计日志 + revalidate 缓存。",
  input: z.object({
    userId: z.string().describe("目标用户 ID"),
    mode: z
      .enum(["set", "deduct"])
      .describe("调整模式：set=设定目标余额，deduct=扣减指定数量"),
    amount: z
      .number()
      .int()
      .min(0)
      .describe("目标余额（set 模式）或扣减数量（deduct 模式）"),
    reason: z.string().optional().describe("调整原因"),
  }),
  output: z.object({
    previousBalance: z.number().describe("调整前余额"),
    newBalance: z.number().describe("调整后余额"),
  }),
  access: { kind: "superAdmin" },
  readOnly: false,
  destructive: true,
  idempotency: { kind: "none" },
  sideEffects: ["billing", "audit", "cache"],
  // Bound at app level - see apps/web/src/server/uol-bindings.ts
  execute: async () => {
    throw new Error(
      "credits.adminAdjust must be bound at app level",
    );
  },
});

// ---------------------------------------------------------------------------
// 20. credits.refund - 退款生成任务积分
// ---------------------------------------------------------------------------
export const refund = defineOperation({
  name: "credits.refund",
  domain: "credits",
  title: "Refund Generation Credits",
  description:
    "生成任务失败时退还已扣积分。内部调用 grantCredits(refund, " +
    "SYSTEM:generation_refund)，通过 credits_batch(refund,source_ref) " +
    "唯一索引保证强幂等（双重保障：短路 + 唯一约束）。" +
    "由图像管线失败结算路径调用。",
  input: z.object({
    userId: z.string().describe("目标用户 ID"),
    amount: z.number().int().positive().describe("退还积分数量"),
    sourceRef: z
      .string()
      .describe("幂等键（通常为 SYSTEM:generation_refund:{generationId}）"),
    reason: z.string().optional().describe("退款原因"),
  }),
  output: z.object({
    batchId: z.string().describe("退款积分批次 ID"),
    balance: z.number().describe("退款后最新余额"),
  }),
  access: { kind: "system" },
  readOnly: false,
  destructive: false,
  idempotency: {
    kind: "required",
    keyField: "sourceRef",
    scope: "per-user",
  },
  sideEffects: ["billing"],
  execute: async (input) => {
    // 从 sourceRef 提取 generationId（格式: SYSTEM:generation_refund:{id}）
    const parts = input.sourceRef.split(":");
    const generationId = parts[parts.length - 1] ?? input.sourceRef;

    const result = await refundGenerationCredits({
      generationId,
      userId: input.userId,
      amount: input.amount,
      targetCredits: 0,
      sourceRef: input.sourceRef,
      description: input.reason ?? "Generation refund",
    });

    // 退款后获取最新余额
    const account = await getCreditsBalance(input.userId);
    return {
      batchId: result.refunded ? generationId : "",
      balance: account.balance,
    };
  },
});

// ---------------------------------------------------------------------------
// 21. credits.createPurchaseCheckout - 创建积分购买结账会话
// ---------------------------------------------------------------------------
export const createPurchaseCheckout = defineOperation({
  name: "credits.createPurchaseCheckout",
  domain: "credits",
  title: "Create Credits Purchase Checkout",
  description:
    "创建积分购买结账会话（Epay 落单 / Creem 外呼）。不直接发放积分，" +
    "积分在支付 webhook 确认后发放。每次调用创建新 checkout（非幂等）。" +
    "按用户套餐校验购买资格。",
  input: z.object({
    packageId: z.string().describe("积分包 ID"),
    paymentProvider: z
      .enum(["creem", "epay"])
      .optional()
      .describe("支付渠道（可选，默认按配置）"),
    successUrl: z.string().url().optional().describe("支付成功回跳 URL"),
    cancelUrl: z.string().url().optional().describe("支付取消回跳 URL"),
  }),
  output: z.object({
    checkoutUrl: z.string().describe("支付页面 URL"),
    orderId: z.string().describe("订单 ID"),
  }),
  access: { kind: "protected" },
  readOnly: false,
  destructive: false,
  idempotency: { kind: "none" },
  sideEffects: ["billing", "external-call"],
  // Bound at app level - see apps/web/src/server/uol-bindings.ts
  execute: async () => {
    throw new Error(
      "credits.createPurchaseCheckout must be bound at app level",
    );
  },
});
