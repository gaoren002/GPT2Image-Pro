/** 外接 API 页的首屏摘要与字段归一化；仅类型依赖受保护查询，无数据库运行时依赖。 */
import type {
  ModerationBlockRiskLevel,
  SubscriptionPlan,
} from "@repo/shared/config/subscription-plan";
import type { getMyPlanAction } from "@repo/shared/subscription/actions/get-user-plan";
import type { PlanCapabilitySnapshot } from "@repo/shared/subscription/services/plan-capabilities";
import type {
  ImageBackendGroupBackendType,
  ImageBackendGroupSizeTier,
} from "@/features/image-backend-pool/types";
import type { getExternalApiKeys } from "./actions/external-api-key";

type KeysQueryResult = Awaited<ReturnType<typeof getExternalApiKeys>>;
type KeysQueryData = NonNullable<NonNullable<KeysQueryResult>["data"]>;
type PlanQueryResult = Awaited<ReturnType<typeof getMyPlanAction>>;

export type ImageBackendGroupOption = {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  isUserSelectable: boolean;
  isEnabled: boolean;
  contentSafetyEnabled: boolean | null;
  backendType: ImageBackendGroupBackendType;
  sizeTier?: ImageBackendGroupSizeTier;
  billingMultiplier?: number;
  /** quality 档位的成员计费倍率；未配置时由原报价逻辑按 1 倍处理。 */
  qualityMultipliers?: Partial<Record<string, number>> | null;
};

export type ExternalApiKeySummary = {
  id: string;
  name: string;
  keyPrefix: string;
  lastFour: string;
  moderationBlockRiskLevel: ModerationBlockRiskLevel;
  generationGroupId: string | null;
  creditLimit: number | null;
  creditsUsed: number;
  relayOnly: boolean;
  asyncTaskMode: boolean;
  lastUsedAt: Date | string | null;
  isActive: boolean;
  createdAt: Date | string;
};

export type ExternalApiKeyInitialSnapshot = {
  keys: ExternalApiKeySummary[];
  groups: ImageBackendGroupOption[];
  plan: SubscriptionPlan;
  capabilities: PlanCapabilitySnapshot | null;
};

/** 首屏与刷新共享 Key 摘要白名单；不把原始密钥或哈希透传到客户端 props。 */
export function normalizeExternalApiKeySummaries(
  keys: KeysQueryData["keys"]
): ExternalApiKeySummary[] {
  return keys.map((key) => ({
    id: key.id,
    name: key.name,
    keyPrefix: key.keyPrefix,
    lastFour: key.lastFour,
    moderationBlockRiskLevel:
      key.moderationBlockRiskLevel === "medium" ||
      key.moderationBlockRiskLevel === "high"
        ? key.moderationBlockRiskLevel
        : "low",
    generationGroupId: key.generationGroupId,
    creditLimit: typeof key.creditLimit === "number" ? key.creditLimit : null,
    creditsUsed: Number(key.creditsUsed || 0),
    relayOnly: key.relayOnly === true,
    asyncTaskMode: key.asyncTaskMode === true,
    lastUsedAt:
      key.lastUsedAt instanceof Date
        ? key.lastUsedAt.toISOString()
        : key.lastUsedAt,
    isActive: key.isActive,
    createdAt:
      key.createdAt instanceof Date
        ? key.createdAt.toISOString()
        : key.createdAt,
  }));
}

/**
 * 合并现有两个受保护 action 的成功结果；鉴权或查询失败时不生成快照，客户端沿原流程重试。
 * Date 明确转 ISO，快照可作为 RSC props 传输；套餐能力保持 action 的权威结果。
 */
export function buildExternalApiKeyInitialSnapshot(
  keysResult: KeysQueryResult,
  planResult: PlanQueryResult
): ExternalApiKeyInitialSnapshot | undefined {
  if (!keysResult?.data || !planResult?.data) return undefined;
  return {
    keys: normalizeExternalApiKeySummaries(keysResult.data.keys),
    groups: keysResult.data.groups.map((group) => ({
      id: group.id,
      name: group.name,
      description: group.description,
      isDefault: group.isDefault,
      isUserSelectable: group.isUserSelectable,
      isEnabled: group.isEnabled,
      contentSafetyEnabled: group.contentSafetyEnabled,
      backendType: group.backendType,
      sizeTier: group.sizeTier,
      billingMultiplier: group.billingMultiplier,
      qualityMultipliers: group.qualityMultipliers,
    })),
    plan: planResult.data.plan,
    capabilities: planResult.data.capabilities ?? null,
  };
}
