/**
 * 首笔扣费提交结果未知时写入 pending 行的标记。此类任务从未审核、也未调用上游，
 * 超时清扫按目标 0 结算（全额退回实际入账的扣费），不保留审核费。
 */
export const INITIAL_CHARGE_UNCONFIRMED_METADATA = {
  initialCharge: { outcome: "unconfirmed" },
} as const;

/** 判断 generation metadata 是否带首笔扣费未确认标记。 */
export function isInitialChargeUnconfirmed(
  metadata: Record<string, unknown> | null | undefined
) {
  const initialCharge = metadata?.initialCharge;
  return (
    !!initialCharge &&
    typeof initialCharge === "object" &&
    !Array.isArray(initialCharge) &&
    (initialCharge as Record<string, unknown>).outcome === "unconfirmed"
  );
}

export type FailedGenerationSettlementReason =
  | "moderation_block"
  | "moderation_error"
  | "generation_error"
  | "storage_error"
  | "settlement_error";

export function getFailedGenerationTargetCredits(params: {
  reason: FailedGenerationSettlementReason;
  moderationFailureCredits: number;
  moderationOnlyCredits?: number;
}) {
  if (params.reason === "moderation_block") {
    return Math.max(0, params.moderationFailureCredits);
  }

  if (params.reason === "moderation_error") {
    return 0;
  }

  return Math.max(
    0,
    params.moderationOnlyCredits ?? params.moderationFailureCredits
  );
}

function readNumber(value: unknown) {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function applyBillingMultiplier(value: number, multiplier: number) {
  if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier === 1) {
    return value;
  }
  return Math.round((value * multiplier + Number.EPSILON) * 100) / 100;
}

export function getFailedGenerationTargetCreditsFromMetadata(params: {
  reason: FailedGenerationSettlementReason;
  chargedCredits: number;
  metadata?: Record<string, unknown> | null;
}) {
  const metadata = params.metadata ?? {};
  const creditCost = readRecord(metadata.creditCost);
  const chargedCredits = Math.max(0, params.chargedCredits);
  const billingMultiplier = readNumber(metadata.billingMultiplier) ?? 1;
  const moderationFailureCredits =
    readNumber(metadata.moderationFailureCredits) ?? chargedCredits;
  const moderationOnlyCredits =
    readNumber(creditCost?.moderationOnlyCredits) ??
    (readNumber(creditCost?.moderationCredits) !== undefined
      ? applyBillingMultiplier(
          readNumber(creditCost?.moderationCredits) ?? 0,
          billingMultiplier
        )
      : undefined);
  const settlementParams: Parameters<typeof getFailedGenerationTargetCredits>[0] =
    {
      reason: params.reason,
      moderationFailureCredits,
    };

  if (moderationOnlyCredits !== undefined) {
    settlementParams.moderationOnlyCredits = moderationOnlyCredits;
  }

  return Math.min(
    chargedCredits,
    getFailedGenerationTargetCredits(settlementParams)
  );
}
