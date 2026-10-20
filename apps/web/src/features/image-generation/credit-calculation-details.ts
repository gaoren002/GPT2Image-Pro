export type GenerationCreditDetails = {
  actualImageCredits: number | null;
  actualSize: string | null;
  /** 倍率后基础生图积分（库内 creditCost/perOutput 存储口径）。 */
  baseCredits: number | null;
  /** 倍率前基础生图积分（展示用，由 baseCredits / 计费倍率 反推，两位小数）。 */
  baseCreditsBeforeMultiplier: number | null;
  billableImageOutputCount: number | null;
  billingGroupId: string | null;
  billingMultiplier: number;
  /** 倍率分量留痕（新记录才有；旧记录为 null，展示退回总倍率单行）。 */
  backendBillingMultiplier: number | null;
  modelFamilyMultiplier: number | null;
  poolApiModelBillingMultiplier: number | null;
  poolApiModelBillingReplacesQuality: boolean | null;
  qualityBillingMultiplier: number | null;
  chatCredits: number | null;
  chatRoundCount: number | null;
  chatRoundCredits: number | null;
  imageModerationCount: number | null;
  mode: string | null;
  moderationCredits: number | null;
  /** 倍率前审核附加积分（展示用，反推口径同 baseCreditsBeforeMultiplier）。 */
  moderationCreditsBeforeMultiplier: number | null;
  requestedSize: string | null;
  requestedTotalCredits: number | null;
  textModerationCount: number | null;
  totalCredits: number;
  upstreamImageOutputCount: number | null;
};

type CreditCostRecord = {
  baseCredits: number | null;
  imageModerationCount: number | null;
  moderationCredits: number | null;
  textModerationCount: number | null;
  totalCredits: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readNumber(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function readPositiveNumber(value: unknown): number | null {
  const numeric = readNumber(value);
  return numeric !== null && numeric > 0 ? numeric : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function readCreditCost(value: unknown): CreditCostRecord | null {
  if (!isRecord(value)) return null;
  return {
    baseCredits: readNumber(value.baseCredits),
    imageModerationCount: readNumber(value.imageModerationCount),
    moderationCredits: readNumber(value.moderationCredits),
    textModerationCount: readNumber(value.textModerationCount),
    totalCredits: readNumber(value.totalCredits),
  };
}

function sumCreditCosts(
  value: unknown,
  key: keyof CreditCostRecord
): number | null {
  if (!Array.isArray(value)) return null;
  let total = 0;
  let found = false;
  for (const item of value) {
    const creditCost = readCreditCost(item);
    const amount = creditCost?.[key];
    if (typeof amount === "number") {
      total += amount;
      found = true;
    }
  }
  return found ? Math.round((total + Number.EPSILON) * 100) / 100 : null;
}

/**
 * 由倍率后数值反推倍率前展示值。服务端口径是「倍率前 × 倍率后逐项向上取整两位」，
 * 反推按就近取整两位，仅用于明细展示（公式自洽），不参与任何结算。
 */
function creditsBeforeMultiplier(
  value: number | null,
  multiplier: number
): number | null {
  if (value === null || !(multiplier > 0)) return null;
  return Math.round((value / multiplier + Number.EPSILON) * 100) / 100;
}

export function extractGenerationCreditDetails(
  metadata: unknown,
  creditsConsumed: number
): GenerationCreditDetails | null {
  if (!isRecord(metadata)) return null;

  const backend = isRecord(metadata.backend) ? metadata.backend : {};
  const outputImage = isRecord(metadata.outputImage) ? metadata.outputImage : {};
  const creditCost = readCreditCost(metadata.creditCost);
  const requestedCreditCost = readCreditCost(outputImage.requestedCreditCost);
  const actualCreditCost = readCreditCost(outputImage.actualCreditCost);
  const perOutputCreditCosts = outputImage.perOutputCreditCosts;
  const chatTextOnlyCharge = isRecord(metadata.chatTextOnlyCharge)
    ? metadata.chatTextOnlyCharge
    : null;
  const billingMultiplier =
    readPositiveNumber(metadata.billingMultiplier) ??
    readPositiveNumber(backend.billingMultiplier) ??
    1;
  const chatRoundCredits =
    readNumber(outputImage.chatRoundCredits) ??
    readNumber(chatTextOnlyCharge?.chatRoundCredits);
  const chatRoundCount =
    readNumber(outputImage.chatRoundCount) ??
    readNumber(chatTextOnlyCharge?.chatRoundCount);
  const chatCredits =
    readNumber(chatTextOnlyCharge?.credits) ??
    (chatRoundCredits !== null && chatRoundCount !== null
      ? Math.round(
          (chatRoundCredits * chatRoundCount + Number.EPSILON) * 100
        ) / 100
      : null);

  const actualImageCredits =
    sumCreditCosts(perOutputCreditCosts, "totalCredits") ??
    actualCreditCost?.totalCredits ??
    null;
  const baseCredits =
    sumCreditCosts(perOutputCreditCosts, "baseCredits") ??
    actualCreditCost?.baseCredits ??
    creditCost?.baseCredits ??
    null;
  const moderationCredits =
    sumCreditCosts(perOutputCreditCosts, "moderationCredits") ??
    actualCreditCost?.moderationCredits ??
    creditCost?.moderationCredits ??
    null;

  return {
    actualImageCredits,
    actualSize: readString(outputImage.actualSize),
    baseCredits,
    baseCreditsBeforeMultiplier: creditsBeforeMultiplier(
      baseCredits,
      billingMultiplier
    ),
    billableImageOutputCount: readNumber(outputImage.billableImageOutputCount),
    billingGroupId:
      readString(metadata.billingGroupId) ?? readString(backend.billingGroupId),
    billingMultiplier,
    backendBillingMultiplier: readPositiveNumber(
      metadata.backendBillingMultiplier
    ),
    modelFamilyMultiplier: readPositiveNumber(metadata.modelFamilyMultiplier),
    poolApiModelBillingMultiplier: readPositiveNumber(
      metadata.poolApiModelBillingMultiplier
    ),
    poolApiModelBillingReplacesQuality:
      typeof metadata.poolApiModelBillingReplacesQuality === "boolean"
        ? metadata.poolApiModelBillingReplacesQuality
        : null,
    qualityBillingMultiplier: readPositiveNumber(
      metadata.qualityBillingMultiplier
    ),
    chatCredits,
    chatRoundCount,
    chatRoundCredits,
    imageModerationCount:
      sumCreditCosts(perOutputCreditCosts, "imageModerationCount") ??
      actualCreditCost?.imageModerationCount ??
      creditCost?.imageModerationCount ??
      null,
    mode: readString(metadata.mode),
    moderationCredits,
    moderationCreditsBeforeMultiplier: creditsBeforeMultiplier(
      moderationCredits,
      billingMultiplier
    ),
    requestedSize: readString(outputImage.requestedSize),
    requestedTotalCredits:
      requestedCreditCost?.totalCredits ?? creditCost?.totalCredits ?? null,
    textModerationCount:
      sumCreditCosts(perOutputCreditCosts, "textModerationCount") ??
      actualCreditCost?.textModerationCount ??
      creditCost?.textModerationCount ??
      null,
    totalCredits: creditsConsumed,
    upstreamImageOutputCount: readNumber(outputImage.upstreamImageOutputCount),
  };
}
