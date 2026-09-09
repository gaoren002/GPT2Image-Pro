/**
 * 订阅计划权限配置
 *
 * 定义各计划的特权限制和功能访问权限
 */

import { PRICE_IDS } from "./payment";

// ============================================
// 计划类型定义
// ============================================

/**
 * 订阅计划类型
 */
export type SubscriptionPlan =
  | "free"
  | "starter"
  | "pro"
  | "ultra"
  | "enterprise";

export const SUBSCRIPTION_PLANS: SubscriptionPlan[] = [
  "free",
  "starter",
  "pro",
  "ultra",
  "enterprise",
];

export type ModerationBlockRiskLevel = "low" | "medium" | "high";

export const MODERATION_BLOCK_RISK_LEVELS = [
  "low",
  "medium",
  "high",
] as const;

const MODERATION_BLOCK_RISK_LEVEL_RANK: Record<
  ModerationBlockRiskLevel,
  number
> = {
  low: 1,
  medium: 2,
  high: 3,
};

/** 对话模型目录：普通套餐使用 GPT-5.5，旗舰能力解锁四款高级模型。 */
export const GPT55_CHAT_MODEL = "gpt-5.5";
export const GPT6_ASTRA_CHAT_MODEL = "gpt-6-astra";
export const GPT56_SOL_CHAT_MODEL = "gpt-5.6-sol";
export const GPT56_TERRA_CHAT_MODEL = "gpt-5.6-terra";
export const GPT56_LUNA_CHAT_MODEL = "gpt-5.6-luna";

export const PREMIUM_CHAT_MODELS = [
  GPT6_ASTRA_CHAT_MODEL,
  GPT56_SOL_CHAT_MODEL,
  GPT56_TERRA_CHAT_MODEL,
  GPT56_LUNA_CHAT_MODEL,
] as const;

export const RESPONSES_IMAGE_MODELS = [
  GPT55_CHAT_MODEL,
  ...PREMIUM_CHAT_MODELS,
] as const;

export type ResponsesImageModel = (typeof RESPONSES_IMAGE_MODELS)[number];

/** 检查模型是否在当前文本模型目录中；用于选择器恢复和服务端白名单校验。 */
export function isResponsesImageModel(
  model: string
): model is ResponsesImageModel {
  return RESPONSES_IMAGE_MODELS.some((candidate) => candidate === model);
}

/** 检查模型是否需要旗舰能力；白名单由 isResponsesImageModel 单独校验。 */
export function isPremiumChatModel(model: string): boolean {
  return PREMIUM_CHAT_MODELS.some((candidate) => candidate === model);
}

export type UploadLimitSettingKey =
  | "PLAN_FREE_MAX_FILE_MB"
  | "PLAN_FREE_MAX_UPLOAD_MB"
  | "PLAN_STARTER_MAX_FILE_MB"
  | "PLAN_STARTER_MAX_UPLOAD_MB"
  | "PLAN_PRO_MAX_FILE_MB"
  | "PLAN_PRO_MAX_UPLOAD_MB"
  | "PLAN_ULTRA_MAX_FILE_MB"
  | "PLAN_ULTRA_MAX_UPLOAD_MB"
  | "PLAN_ENTERPRISE_MAX_FILE_MB"
  | "PLAN_ENTERPRISE_MAX_UPLOAD_MB";

/**
 * 队列优先级
 */
export type QueuePriority = "normal" | "priority" | "highest";

/**
 * 计划特权配置
 */
export interface PlanPrivileges {
  /** 计划名称 */
  name: string;
  /** 单文件大小上限 (bytes) */
  maxFileSizeBytes: number;
  /** 单次图片编辑/对话上传总大小上限 (bytes) */
  maxUploadBytes: number;
  /** 队列优先级 */
  queuePriority: QueuePriority;
  /** 单用户图片生成并发上限 */
  imageGenerationConcurrency: number;
  /** 月度积分配额 (免费版为一次性) */
  monthlyCredits: number;
}

// ============================================
// 计划特权配置
// ============================================

/**
 * 各计划的特权配置
 */
export const PLAN_PRIVILEGES: Record<SubscriptionPlan, PlanPrivileges> = {
  free: {
    name: "Free",
    maxFileSizeBytes: 5 * 1024 * 1024, // 5MB
    maxUploadBytes: 75 * 1024 * 1024, // 75MB
    queuePriority: "normal",
    imageGenerationConcurrency: 2,
    monthlyCredits: 100, // 一次性
  },
  starter: {
    name: "Starter",
    maxFileSizeBytes: 20 * 1024 * 1024, // 20MB
    maxUploadBytes: 75 * 1024 * 1024, // 75MB
    queuePriority: "normal",
    imageGenerationConcurrency: 5,
    monthlyCredits: 5_000,
  },
  pro: {
    name: "Pro",
    maxFileSizeBytes: 50 * 1024 * 1024, // 50MB
    maxUploadBytes: 75 * 1024 * 1024, // 75MB
    queuePriority: "priority",
    imageGenerationConcurrency: 15,
    monthlyCredits: 20_000,
  },
  ultra: {
    name: "Ultra",
    maxFileSizeBytes: 100 * 1024 * 1024, // 100MB
    maxUploadBytes: 100 * 1024 * 1024, // 100MB
    queuePriority: "highest",
    imageGenerationConcurrency: 50,
    monthlyCredits: 80_000,
  },
  enterprise: {
    name: "Enterprise",
    maxFileSizeBytes: 200 * 1024 * 1024, // 200MB
    maxUploadBytes: 200 * 1024 * 1024, // 200MB
    queuePriority: "highest",
    imageGenerationConcurrency: 100,
    monthlyCredits: 320_000,
  },
};

/**
 * 计划等级，用于功能门槛判断
 */
export const PLAN_RANK: Record<SubscriptionPlan, number> = {
  free: 0,
  starter: 1,
  pro: 2,
  ultra: 3,
  enterprise: 4,
};

// ============================================
// Price ID 到计划的映射
// ============================================

/**
 * 根据 Price ID 获取计划类型
 *
 * @param priceId - 价格/产品 ID
 * @returns 计划类型，如果未找到则返回 null
 */
export function getPlanFromPriceId(priceId: string): SubscriptionPlan | null {
  // Starter
  if (
    priceId === PRICE_IDS.STARTER_MONTHLY ||
    priceId === PRICE_IDS.STARTER_YEARLY
  ) {
    return "starter";
  }

  // Pro
  if (priceId === PRICE_IDS.PRO_MONTHLY || priceId === PRICE_IDS.PRO_YEARLY) {
    return "pro";
  }

  // Ultra
  if (
    priceId === PRICE_IDS.ULTRA_MONTHLY ||
    priceId === PRICE_IDS.ULTRA_YEARLY
  ) {
    return "ultra";
  }

  // Enterprise
  if (
    priceId === PRICE_IDS.ENTERPRISE_MONTHLY ||
    priceId === PRICE_IDS.ENTERPRISE_YEARLY
  ) {
    return "enterprise";
  }

  return null;
}

// ============================================
// 特权检查工具函数
// ============================================

/**
 * 获取计划的特权配置
 *
 * @param plan - 订阅计划
 * @returns 计划特权配置
 */
export function getPlanPrivileges(plan: SubscriptionPlan): PlanPrivileges {
  return PLAN_PRIVILEGES[plan];
}

export const PLAN_UPLOAD_LIMIT_SETTING_KEYS: Record<
  SubscriptionPlan,
  {
    maxFileMb: UploadLimitSettingKey;
    maxUploadMb: UploadLimitSettingKey;
  }
> = {
  free: {
    maxFileMb: "PLAN_FREE_MAX_FILE_MB",
    maxUploadMb: "PLAN_FREE_MAX_UPLOAD_MB",
  },
  starter: {
    maxFileMb: "PLAN_STARTER_MAX_FILE_MB",
    maxUploadMb: "PLAN_STARTER_MAX_UPLOAD_MB",
  },
  pro: {
    maxFileMb: "PLAN_PRO_MAX_FILE_MB",
    maxUploadMb: "PLAN_PRO_MAX_UPLOAD_MB",
  },
  ultra: {
    maxFileMb: "PLAN_ULTRA_MAX_FILE_MB",
    maxUploadMb: "PLAN_ULTRA_MAX_UPLOAD_MB",
  },
  enterprise: {
    maxFileMb: "PLAN_ENTERPRISE_MAX_FILE_MB",
    maxUploadMb: "PLAN_ENTERPRISE_MAX_UPLOAD_MB",
  },
};

/**
 * 检查当前计划是否达到目标计划等级
 *
 * @param plan - 当前计划
 * @param requiredPlan - 需要达到的最低计划
 * @returns 是否满足等级要求
 */
export function isPlanAtLeast(
  plan: SubscriptionPlan,
  requiredPlan: SubscriptionPlan
): boolean {
  return PLAN_RANK[plan] >= PLAN_RANK[requiredPlan];
}

export function isSubscriptionPlan(value: unknown): value is SubscriptionPlan {
  return (
    value === "free" ||
    value === "starter" ||
    value === "pro" ||
    value === "ultra" ||
    value === "enterprise"
  );
}

export function normalizeSubscriptionPlan(
  value: unknown,
  fallback: SubscriptionPlan = "free"
): SubscriptionPlan {
  return isSubscriptionPlan(value) ? value : fallback;
}

/**
 * 是否允许创建和使用外接 API Key
 */
export function canUseExternalApi(plan: SubscriptionPlan): boolean {
  return isPlanAtLeast(plan, "starter");
}

/**
 * 是否允许配置自己的 OpenAI 兼容 API
 */
export function canUseCustomApi(plan: SubscriptionPlan): boolean {
  return isPlanAtLeast(plan, "starter");
}

/**
 * 是否允许使用对话生图
 */
export function canUseChat(plan: SubscriptionPlan): boolean {
  return isPlanAtLeast(plan, "pro");
}

/**
 * 是否允许外接 Responses 生图接口
 */
export function canUseExternalResponsesImageApi(
  plan: SubscriptionPlan
): boolean {
  return isPlanAtLeast(plan, "pro");
}

/**
 * 是否允许自定义提示词优化开关
 */
export function canUsePromptOptimization(plan: SubscriptionPlan): boolean {
  return isPlanAtLeast(plan, "pro");
}

/**
 * 是否允许对话生图使用 GPT-6 Astra 和 GPT-5.6 系列
 */
export function canUsePremiumChatModels(plan: SubscriptionPlan): boolean {
  return isPlanAtLeast(plan, "ultra");
}

/**
 * 审核命中时是否只结算审核积分
 */
export function canUseModerationOnlyFailureSettlement(
  plan: SubscriptionPlan
): boolean {
  return isPlanAtLeast(plan, "ultra");
}

/**
 * 套餐默认审核拦截级别。
 *
 * low = low/medium/high 均拦截
 * medium = 放开 low，仅拦截 medium/high
 * high = 放开 low/medium，仅拦截 high
 */
export function getDefaultModerationBlockRiskLevel(
  plan: SubscriptionPlan
): ModerationBlockRiskLevel {
  if (plan === "enterprise") return "high";
  if (plan === "ultra") return "medium";
  return "low";
}

export function getMaxModerationBlockRiskLevelForPlan(
  plan: SubscriptionPlan
): ModerationBlockRiskLevel {
  if (plan === "enterprise") return "high";
  if (plan === "ultra") return "medium";
  return "low";
}

export function isModerationBlockRiskLevel(
  value: unknown
): value is ModerationBlockRiskLevel {
  return (
    value === "low" ||
    value === "medium" ||
    value === "high"
  );
}

export function getAllowedModerationBlockRiskLevels(
  plan: SubscriptionPlan
): ModerationBlockRiskLevel[] {
  const maxLevel = getMaxModerationBlockRiskLevelForPlan(plan);
  const maxRank = MODERATION_BLOCK_RISK_LEVEL_RANK[maxLevel];
  return MODERATION_BLOCK_RISK_LEVELS.filter(
    (level) => MODERATION_BLOCK_RISK_LEVEL_RANK[level] <= maxRank
  );
}

export function normalizeModerationBlockRiskLevelForPlan(
  plan: SubscriptionPlan,
  value?: string | null
): ModerationBlockRiskLevel {
  const fallback = getDefaultModerationBlockRiskLevel(plan);
  const requested = isModerationBlockRiskLevel(value) ? value : fallback;
  const maxLevel = getMaxModerationBlockRiskLevelForPlan(plan);

  return MODERATION_BLOCK_RISK_LEVEL_RANK[requested] >
    MODERATION_BLOCK_RISK_LEVEL_RANK[maxLevel]
    ? maxLevel
    : requested;
}

/**
 * 检查文件大小是否在限制内
 *
 * @param plan - 订阅计划
 * @param fileSizeBytes - 文件大小（字节）
 * @returns 是否在限制内
 */
export function isWithinFileSizeLimit(
  plan: SubscriptionPlan,
  fileSizeBytes: number
): boolean {
  return fileSizeBytes <= PLAN_PRIVILEGES[plan].maxFileSizeBytes;
}

/**
 * 格式化文件大小限制（用于错误消息）
 *
 * @param plan - 订阅计划
 * @returns 格式化的文件大小字符串（如 "5MB"）
 */
export function formatFileSizeLimit(plan: SubscriptionPlan): string {
  const bytes = PLAN_PRIVILEGES[plan].maxFileSizeBytes;
  return `${bytes / (1024 * 1024)}MB`;
}

/**
 * 获取升级建议（当特权不足时）
 *
 * @param currentPlan - 当前计划
 * @param requiredFeature - 需要的功能描述
 * @returns 升级建议消息
 */
export function getUpgradeMessage(
  currentPlan: SubscriptionPlan,
  requiredFeature: string
): string {
  const upgradeTo =
    currentPlan === "free"
      ? "Starter"
      : currentPlan === "starter"
        ? "Pro"
        : currentPlan === "pro"
          ? "Ultra"
          : "Enterprise";

  return `${requiredFeature} requires ${upgradeTo} plan or higher. Please upgrade to continue.`;
}
