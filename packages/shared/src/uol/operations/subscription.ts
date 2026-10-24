/**
 * UOL 操作注册 - subscription 域
 *
 * 涵盖订阅/支付相关的所有操作：结账、取消、门户、计划查询、能力快照、
 * 文件大小检查、Webhook 处理等。
 *
 * 使用方：应用启动时通过 import 触发注册；invoke 网关通过名称调用。
 * 关键依赖：../registry（defineOperation）、zod（schema 校验）、
 * ../../subscription/services/plan-capabilities（能力矩阵）、
 * ../../subscription/services/user-plan（用户计划查询）、
 * ../../subscription/services/upload-limits（上传限制）
 */

import { z } from "zod";
import "../../payment/upgrade-reservation-operations";
import { defineOperation } from "../registry";
import { getPrincipalUserId } from "../principal";
import {
  getPlanCapabilitySnapshot,
  canUsePlanCapability,
  getPlanLimits,
  getPlanCapabilityMatrix,
  type PlanCapabilityKey,
} from "../../subscription/services/plan-capabilities";
import {
  getUserPlan,
  checkFileSizePrivilege,
} from "../../subscription/services/user-plan";
import type { SubscriptionPlan } from "../../config/subscription-plan";

// ============================================
// 1. subscription.createCheckout
// ============================================

defineOperation({
  name: "subscription.createCheckout",
  domain: "subscription",
  title: "Create Subscription Checkout",
  description:
    "创建订阅结账会话（Creem 或 Epay），返回 checkout URL 供前端跳转",
  access: { kind: "protected" },
  input: z.object({
    priceId: z.string().describe("目标套餐的价格 ID"),
    successUrl: z.string().url().optional().describe("支付成功后回调 URL"),
    cancelUrl: z.string().url().optional().describe("取消支付后回调 URL"),
    provider: z
      .enum(["creem", "epay"])
      .optional()
      .describe("支付渠道，未指定则使用系统默认"),
  }),
  output: z.object({
    checkoutUrl: z.string().url().describe("重定向用户完成支付的 URL"),
    sessionId: z.string().optional().describe("结账会话 ID"),
  }),
  readOnly: false,
  destructive: false,
  idempotency: { kind: "none" },
  sideEffects: ["external-call"],
  // Bound at app level - see apps/web/src/server/uol-bindings.ts
  execute: async () => {
    throw new Error(
      "subscription.createCheckout must be bound at app level",
    );
  },
});

// ============================================
// 2. subscription.getUpgradeQuote
// ============================================

defineOperation({
  name: "subscription.getUpgradeQuote",
  domain: "subscription",
  title: "Get Upgrade Quote",
  description:
    "获取升级订阅的报价信息（按比例计算差价/剩余天数抵扣等）",
  access: { kind: "protected" },
  input: z.object({
    targetPriceId: z.string().describe("目标升级套餐的价格 ID"),
  }),
  output: z.object({
    originalAmount: z.number().describe("目标套餐原价（分）"),
    prorationCredit: z.number().describe("按比例抵扣金额（分）"),
    finalAmount: z.number().describe("用户实际需支付金额（分）"),
    remainingDays: z.number().describe("当前周期剩余天数"),
    periodDays: z.number().describe("周期总天数"),
    currentPriceId: z.string().nullable().describe("当前套餐价格 ID"),
    targetPriceId: z.string().describe("目标套餐价格 ID"),
  }),
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  // Bound at app level - see apps/web/src/server/uol-bindings.ts
  execute: async () => {
    throw new Error(
      "subscription.getUpgradeQuote must be bound at app level",
    );
  },
});

// ============================================
// 3. subscription.cancel
// ============================================

defineOperation({
  name: "subscription.cancel",
  domain: "subscription",
  title: "Cancel Subscription",
  description: "取消当前订阅（周期结束时生效）",
  access: { kind: "protected" },
  input: z.object({
    immediate: z
      .boolean()
      .optional()
      .describe("是否立即取消而非周期结束时取消"),
  }),
  output: z.object({
    success: z.boolean(),
    cancelAtPeriodEnd: z.boolean().describe("是否在周期结束时取消"),
    currentPeriodEnd: z
      .string()
      .nullable()
      .describe("当前周期结束时间 ISO 8601"),
  }),
  readOnly: false,
  destructive: true,
  idempotency: { kind: "natural" },
  sideEffects: ["external-call"],
  // Bound at app level - see apps/web/src/server/uol-bindings.ts
  execute: async () => {
    throw new Error(
      "subscription.cancel must be bound at app level",
    );
  },
});

// ============================================
// 4. subscription.getPortal
// ============================================

defineOperation({
  name: "subscription.getPortal",
  domain: "subscription",
  title: "Get Customer Portal",
  description: "创建客户门户链接（管理订阅、发票、支付方式）",
  access: { kind: "protected" },
  input: z.object({
    returnUrl: z.string().url().optional().describe("门户退出后返回的 URL"),
  }),
  output: z.object({
    portalUrl: z.string().url().describe("客户门户 URL"),
  }),
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: ["external-call"],
  // Bound at app level - see apps/web/src/server/uol-bindings.ts
  execute: async () => {
    throw new Error(
      "subscription.getPortal must be bound at app level",
    );
  },
});

// ============================================
// 5. subscription.getUserSubscription
// ============================================

defineOperation({
  name: "subscription.getUserSubscription",
  domain: "subscription",
  title: "Get User Subscription",
  description: "获取指定用户的完整订阅信息",
  access: { kind: "protected" },
  input: z.object({
    userId: z.string().describe("目标用户 ID"),
  }),
  output: z.object({
    plan: z.string().describe("计划类型: free | starter | pro | ultra | enterprise"),
    planName: z.string().describe("计划显示名称"),
    hasActiveSubscription: z.boolean(),
    subscriptionStatus: z.string().nullable(),
    currentPeriodEnd: z.string().nullable().describe("ISO 8601"),
    priceId: z.string().nullable(),
    cancelAtPeriodEnd: z.boolean(),
  }),
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async (input) => {
    const info = await getUserPlan(input.userId);
    return {
      plan: info.plan,
      planName: info.planName,
      hasActiveSubscription: info.hasActiveSubscription,
      subscriptionStatus: info.subscriptionStatus,
      currentPeriodEnd: info.currentPeriodEnd?.toISOString() ?? null,
      priceId: info.priceId,
      cancelAtPeriodEnd: info.cancelAtPeriodEnd,
    };
  },
});

// ============================================
// 6. subscription.hasActive
// ============================================

defineOperation({
  name: "subscription.hasActive",
  domain: "subscription",
  title: "Check Active Subscription",
  description: "检查指定用户是否有活跃订阅",
  access: { kind: "protected" },
  input: z.object({
    userId: z.string().describe("目标用户 ID"),
  }),
  output: z.object({
    hasActive: z.boolean().describe("是否有活跃订阅"),
    plan: z.string().optional().describe("当前计划类型（如有活跃订阅）"),
  }),
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async (input) => {
    const info = await getUserPlan(input.userId);
    return {
      hasActive: info.hasActiveSubscription,
      plan: info.hasActiveSubscription ? info.plan : undefined,
    };
  },
});

// ============================================
// 7. subscription.getMyPlan
// ============================================

defineOperation({
  name: "subscription.getMyPlan",
  domain: "subscription",
  title: "Get My Plan",
  description:
    "获取当前用户的订阅计划及能力快照（plan + capabilities）",
  access: { kind: "protected" },
  input: z.object({}),
  output: z.object({
    plan: z.string().describe("计划类型"),
    planName: z.string().describe("计划名称"),
    capabilities: z.record(z.string(), z.unknown()).describe("能力快照对象"),
    hasActiveSubscription: z.boolean(),
    currentPeriodEnd: z.string().nullable().describe("ISO 8601"),
    priceId: z.string().nullable(),
    cancelAtPeriodEnd: z.boolean(),
  }),
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async (_input, principal) => {
    const userId = getPrincipalUserId(principal);
    if (!userId) throw new Error("No userId in principal");

    const info = await getUserPlan(userId);
    const snapshot = await getPlanCapabilitySnapshot(info.plan);
    return {
      plan: info.plan,
      planName: info.planName,
      capabilities: snapshot as unknown as Record<string, unknown>,
      hasActiveSubscription: info.hasActiveSubscription,
      currentPeriodEnd: info.currentPeriodEnd?.toISOString() ?? null,
      priceId: info.priceId,
      cancelAtPeriodEnd: info.cancelAtPeriodEnd,
    };
  },
});

// ============================================
// 8. subscription.getUserPlan
// ============================================

defineOperation({
  name: "subscription.getUserPlan",
  domain: "subscription",
  title: "Get User Plan",
  description: "获取指定用户的计划类型（仅返回计划标识）",
  access: { kind: "protected" },
  input: z.object({
    userId: z.string().describe("目标用户 ID"),
  }),
  output: z.object({
    plan: z.string().describe("计划类型: free | starter | pro | ultra | enterprise"),
  }),
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async (input) => {
    const info = await getUserPlan(input.userId);
    return { plan: info.plan };
  },
});

// ============================================
// 9. subscription.checkFileSize
// ============================================

defineOperation({
  name: "subscription.checkFileSize",
  domain: "subscription",
  title: "Check File Size Limit",
  description: "检查文件大小是否在用户计划的上传限制内",
  access: { kind: "protected" },
  input: z.object({
    userId: z.string().describe("目标用户 ID"),
    fileSizeBytes: z.number().int().positive().describe("文件大小（字节）"),
  }),
  output: z.object({
    allowed: z.boolean().describe("是否允许"),
    errorMessage: z.string().optional().describe("不允许时的错误消息"),
    upgradeMessage: z.string().optional().describe("升级建议消息"),
  }),
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async (input) => {
    const result = await checkFileSizePrivilege(
      input.userId,
      input.fileSizeBytes,
    );
    return {
      allowed: result.allowed,
      errorMessage: result.errorMessage,
      upgradeMessage: result.upgradeMessage,
    };
  },
});

// ============================================
// 10. subscription.getCapabilitySnapshot
// ============================================

defineOperation({
  name: "subscription.getCapabilitySnapshot",
  domain: "subscription",
  title: "Get Capability Snapshot",
  description:
    "获取指定计划的完整能力快照（features/limits/moderation/billing）",
  access: { kind: "protected" },
  input: z.object({
    plan: z
      .enum(["free", "starter", "pro", "ultra", "enterprise"])
      .describe("目标计划类型"),
  }),
  output: z.object({
    plan: z.string(),
    features: z.record(z.string(), z.boolean()).describe("功能开关映射"),
    limits: z
      .object({
        maxFileMb: z.number(),
        maxUploadMb: z.number(),
        maxFileSizeBytes: z.number(),
        maxUploadBytes: z.number(),
        queuePriority: z.string(),
        imageGenerationConcurrency: z.number(),
        monthlyCredits: z.number(),
        maxBatchCount: z.number(),
        maxEditImages: z.number(),
        maxChatImages: z.number(),
        maxChatContextChars: z.number(),
      })
      .describe("计划限制"),
    moderation: z
      .object({
        defaultBlockRiskLevel: z.string(),
        maxBlockRiskLevel: z.string(),
        allowedBlockRiskLevels: z.array(z.string()),
      })
      .describe("审核配置"),
    billing: z
      .object({
        chatRoundCredits: z.number(),
        agentRoundCredits: z.number(),
      })
      .describe("计费配置"),
  }),
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async (input) => {
    const snapshot = await getPlanCapabilitySnapshot(
      input.plan as SubscriptionPlan,
    );
    return {
      plan: snapshot.plan,
      features: snapshot.features as Record<string, boolean>,
      limits: {
        maxFileMb: snapshot.limits.maxFileMb,
        maxUploadMb: snapshot.limits.maxUploadMb,
        maxFileSizeBytes: snapshot.limits.maxFileSizeBytes,
        maxUploadBytes: snapshot.limits.maxUploadBytes,
        queuePriority: snapshot.limits.queuePriority,
        imageGenerationConcurrency:
          snapshot.limits.imageGenerationConcurrency,
        monthlyCredits: snapshot.limits.monthlyCredits,
        maxBatchCount: snapshot.limits.maxBatchCount,
        maxEditImages: snapshot.limits.maxEditImages,
        maxChatImages: snapshot.limits.maxChatImages,
        maxChatContextChars: snapshot.limits.maxChatContextChars,
      },
      moderation: {
        defaultBlockRiskLevel:
          snapshot.moderation.defaultBlockRiskLevel,
        maxBlockRiskLevel: snapshot.moderation.maxBlockRiskLevel,
        allowedBlockRiskLevels:
          snapshot.moderation.allowedBlockRiskLevels,
      },
      billing: {
        chatRoundCredits: snapshot.billing.chatRoundCredits,
        agentRoundCredits: snapshot.billing.agentRoundCredits,
      },
    };
  },
});

// ============================================
// 11. subscription.canUseCapability
// ============================================

defineOperation({
  name: "subscription.canUseCapability",
  domain: "subscription",
  title: "Check Capability Access",
  description: "检查指定计划是否可以使用某个能力位",
  access: { kind: "protected" },
  input: z.object({
    plan: z
      .enum(["free", "starter", "pro", "ultra", "enterprise"])
      .describe("用户计划"),
    capability: z.string().describe("能力位键名（如 imageGeneration.chat）"),
  }),
  output: z.object({
    allowed: z.boolean().describe("是否允许使用该能力"),
    requiredPlan: z
      .string()
      .optional()
      .describe("如不允许，所需最低计划"),
  }),
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async (input) => {
    const allowed = await canUsePlanCapability(
      input.plan as SubscriptionPlan,
      input.capability as PlanCapabilityKey,
    );
    if (allowed) {
      return { allowed: true };
    }
    // 查找所需最低计划：从能力矩阵获取该能力位要求的最低 plan
    const matrix = await getPlanCapabilityMatrix();
    const requiredPlan =
      matrix.features[input.capability as PlanCapabilityKey];
    return {
      allowed: false,
      requiredPlan: requiredPlan ?? undefined,
    };
  },
});

// ============================================
// 12. subscription.getPlanLimits
// ============================================

defineOperation({
  name: "subscription.getPlanLimits",
  domain: "subscription",
  title: "Get Plan Limits",
  description: "获取指定计划的限制配置",
  access: { kind: "protected" },
  input: z.object({
    plan: z
      .enum(["free", "starter", "pro", "ultra", "enterprise"])
      .describe("目标计划类型"),
  }),
  output: z.object({
    maxFileMb: z.number(),
    maxUploadMb: z.number(),
    queuePriority: z.string(),
    imageGenerationConcurrency: z.number(),
    monthlyCredits: z.number(),
    maxBatchCount: z.number(),
    maxEditImages: z.number(),
    maxChatImages: z.number(),
    maxChatContextChars: z.number(),
  }),
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async (input) => {
    const limits = await getPlanLimits(
      input.plan as SubscriptionPlan,
    );
    return {
      maxFileMb: limits.maxFileMb,
      maxUploadMb: limits.maxUploadMb,
      queuePriority: limits.queuePriority,
      imageGenerationConcurrency:
        limits.imageGenerationConcurrency,
      monthlyCredits: limits.monthlyCredits,
      maxBatchCount: limits.maxBatchCount,
      maxEditImages: limits.maxEditImages,
      maxChatImages: limits.maxChatImages,
      maxChatContextChars: limits.maxChatContextChars,
    };
  },
});

// ============================================
// 13. subscription.webhookCreem
// ============================================

defineOperation({
  name: "subscription.webhookCreem",
  domain: "subscription",
  title: "Handle Creem Webhook",
  description:
    "处理 Creem 支付平台的 Webhook 回调（签名验证 + 订阅状态同步）",
  access: { kind: "webhook", provider: "creem" },
  input: z.object({
    headers: z.record(z.string(), z.string()).describe("请求头（含签名）"),
    body: z.record(z.string(), z.unknown()).describe("Webhook 载荷"),
  }),
  output: z.object({
    handled: z.boolean().describe("是否成功处理"),
    eventType: z.string().optional().describe("事件类型"),
  }),
  readOnly: false,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: ["billing"],
  // Bound at app level - see apps/web/src/server/uol-bindings.ts
  execute: async () => {
    throw new Error(
      "subscription.webhookCreem must be bound at app level",
    );
  },
});

// ============================================
// 14. subscription.webhookEpay
// ============================================

defineOperation({
  name: "subscription.webhookEpay",
  domain: "subscription",
  title: "Handle Epay Webhook",
  description:
    "处理易支付（Epay）的异步通知回调（签名验证 + 订单状态同步）",
  access: { kind: "webhook", provider: "epay" },
  input: z.object({
    params: z.record(z.string(), z.string()).describe("通知参数（含签名字段）"),
  }),
  output: z.object({
    handled: z.boolean().describe("是否成功处理"),
    tradeNo: z.string().optional().describe("第三方交易号"),
    outTradeNo: z.string().optional().describe("商户订单号"),
  }),
  readOnly: false,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: ["billing"],
  // Bound at app level - see apps/web/src/server/uol-bindings.ts
  execute: async () => {
    throw new Error(
      "subscription.webhookEpay must be bound at app level",
    );
  },
});

// ============================================
// 15. subscription.fulfillEpay
// ============================================

defineOperation({
  name: "subscription.fulfillEpay",
  domain: "subscription",
  title: "Fulfill Epay Payment",
  description:
    "履约已成功的 Epay 支付订单（激活订阅/发放积分等）",
  access: { kind: "system" },
  input: z.object({
    outTradeNo: z.string().describe("商户订单号"),
    tradeNo: z.string().describe("第三方交易号"),
    amount: z.number().describe("实际支付金额"),
    tradeStatus: z.string().describe("交易状态"),
  }),
  output: z.object({
    fulfilled: z.boolean().describe("是否成功履约"),
    businessType: z
      .enum(["subscription", "credit_purchase"])
      .optional()
      .describe("业务类型"),
  }),
  readOnly: false,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: ["billing"],
  // Bound at app level - see apps/web/src/server/uol-bindings.ts
  execute: async () => {
    throw new Error(
      "subscription.fulfillEpay must be bound at app level",
    );
  },
});
