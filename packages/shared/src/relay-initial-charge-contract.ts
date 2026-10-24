/** 纯中转初始扣费契约：仅含财务身份和期限；不保存内容，不承诺上游 exactly-once。 */
import { z } from "zod";

export const PURE_RELAY_CREDIT_DESCRIPTION = "Pure relay generation charge";
export const relayInitialCaptureSchema = z
  .object({
    captureId: z.string().uuid(),
    generationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    expiresAt: z.date(),
  })
  .strict();
export type RelayInitialCaptureIntent = z.infer<
  typeof relayInitialCaptureSchema
>;

/** 在执行请求内部创建随机财务认领身份；零扣费路径不调用、不制造消费流水。 */
export function createRelayInitialCapture(
  generationId: string,
  expiresAt: Date
): RelayInitialCaptureIntent {
  return relayInitialCaptureSchema.parse({
    captureId: crypto.randomUUID(),
    generationId,
    expiresAt,
  });
}

/** 初始 sourceRef 必须精确匹配；拒绝把补扣/其他任务标成可全退的初始消费。 */
export function validateRelayInitialCapture(
  intent: RelayInitialCaptureIntent,
  payment: { sourceRef?: string; metadata?: Record<string, unknown> }
) {
  const parsed = relayInitialCaptureSchema.parse(intent);
  if (
    payment.sourceRef !== `${parsed.generationId}:charge` ||
    payment.metadata?.generationId !== parsed.generationId
  ) {
    throw new Error("Invalid pure relay initial capture identity");
  }
  return parsed;
}

/** 账本只写初始审计标记；可变状态在财务表，不能据本标记推断尚未 dispatch。 */
export function relayInitialCaptureMarker(intent: RelayInitialCaptureIntent) {
  return {
    version: 1 as const,
    captureId: intent.captureId,
    state: "captured" as const,
  };
}

/**
 * 不带数据库错误详情的稳定拒绝；失败/确认未知均不得继续上游调用。
 *
 * outcome 区分两种情况：rejected 表示 CAS 确定未命中（意图已过期或已被恢复认领，
 * 由到期恢复负责退款）；unknown 表示 CAS 的提交或确认中断，状态可能已变为
 * dispatched，到期恢复不会再退款，调用方确知本请求未开工时须自行投递退款。
 */
export class RelayInitialDispatchError extends Error {
  readonly code = "relay_initial_dispatch_unavailable";
  constructor(readonly outcome: "rejected" | "unknown" = "unknown") {
    super("Pure relay initial charge could not be claimed for dispatch");
    this.name = "RelayInitialDispatchError";
  }
}

const optionalAmount = z.number().finite().nonnegative().optional();
const optionalIdentifier = z.string().max(1024).nullable().optional();
const billingSnapshotFields = {
  backendType: optionalIdentifier,
  backendId: optionalIdentifier,
  groupId: optionalIdentifier,
  billingGroupId: optionalIdentifier,
  accountBackend: optionalIdentifier,
  requestedQuality: optionalIdentifier,
  billingQuality: optionalIdentifier,
  outboundModel: optionalIdentifier,
  outboundQuality: optionalIdentifier,
  billingMultiplier: optionalAmount,
  qualityBillingMultiplier: optionalAmount,
  backendBillingMultiplier: optionalAmount,
  poolApiModelBillingMultiplier: optionalAmount,
  poolApiModelBillingReplacesQuality: z.boolean().optional(),
};
const initialFinancialMetadataSchema = z.object({
  ...billingSnapshotFields,
  mode: z.enum(["generate", "edit", "chat"]).optional(),
  // 与 validateImageSize 接受的写法一致（auto、WxH、比例串），只限定字段形状，
  // 防止任意文本进入账本；不在这里重复校验尺寸取值。
  size: z
    .string()
    .max(32)
    .regex(/^(?:auto|\d{2,5}x\d{2,5}|[1-9]\d?\s*:\s*[1-9]\d?)$/i)
    .optional(),
  initialBilling: z.object(billingSnapshotFields).optional(),
  actualBilling: z.null().optional(),
  chargeImageCredits: z.boolean().optional(),
  chargeModerationCredits: z.boolean().optional(),
  billingMode: z.enum(["full", "moderation_only", "none"]).optional(),
  initialCredits: optionalAmount,
  targetImageCredits: optionalAmount,
  creditCost: z
    .object({
      baseCredits: optionalAmount,
      effectiveBaseCredits: optionalAmount,
      totalCredits: optionalAmount,
      imageModerationCount: optionalAmount,
      moderationCny: optionalAmount,
      moderationCredits: optionalAmount,
      moderationOnlyCredits: optionalAmount,
      pixels: optionalAmount,
      qualityMultiplier: optionalAmount,
      textModerationCount: optionalAmount,
      textModerationCredits: optionalAmount,
      thinkingMultiplier: optionalAmount,
    })
    .optional(),
});

/** 初始账本只投影既有计价白名单；未知字段在根与嵌套对象均剔除，身份由 core 覆盖。 */
export function relayInitialCaptureMetadata(
  metadata: Record<string, unknown> | undefined,
  intent: RelayInitialCaptureIntent
) {
  return {
    ...initialFinancialMetadataSchema.parse(metadata ?? {}),
    generationId: intent.generationId,
    relayInitialCapture: relayInitialCaptureMarker(intent),
  };
}
