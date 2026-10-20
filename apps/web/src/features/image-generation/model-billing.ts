/**
 * 池 API 成员的按模型计价倍率（纯函数，DB-free）。
 *
 * 同一个上游 API 服务不同模型时成本差异可能很大（如 2.5 系贵于 2 系、
 * 改写后的 -gzs/-zx 变体另有定价）。本模块把「模型 id → 计费倍率」做成
 * 每个池 API 成员可配的表（存 metadata.modelBilling），在 operations.ts
 * 与组倍率、质量倍率、Adobe 模型族倍率叠乘：
 *
 *   billingMultiplier = 后端池倍率 × 模型族倍率(firefly) × 模型倍率(本模块,仅 pool-api) × 质量倍率
 *
 * 匹配规则：【精确命中】。键与出站模型 id 全等（大小写敏感）才生效，
 * 不做前缀/族匹配——避免 gpt-image-2 误伤 gpt-image-2.5；要给改写变体
 * 定价就把改写后的完整 id 配成键。
 * 仅作用于 pool-api 成员（账号/Adobe 走各自倍率链，不读此表）。
 */

/** 每成员的模型倍率表；未配置的模型视为 1。 */
export type ModelBillingConfig = Record<string, number>;

/** 与 operations.ts normalizeBillingMultiplier 同口径：正值、[0.01, 100]、两位小数。 */
const MIN_MODEL_BILLING_MULTIPLIER = 0.01;
const MAX_MODEL_BILLING_MULTIPLIER = 100;
const MAX_MODEL_BILLING_ENTRIES = 100;

function sanitizeMultiplier(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return (
    Math.round(
      Math.min(
        MAX_MODEL_BILLING_MULTIPLIER,
        Math.max(MIN_MODEL_BILLING_MULTIPLIER, parsed)
      ) * 100
    ) / 100
  );
}

/**
 * 把任意输入（成员 metadata.modelBilling / 表单对象）清洗成合法倍率表：
 * 键收窄为非空字符串（去首尾空白），数值非法丢弃；超上限截断防止滥用。
 * 不删除值为 1 的键（保留管理员显式意图）。
 */
export function parseModelBilling(value: unknown): ModelBillingConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: ModelBillingConfig = {};
  for (const [rawModel, rawMultiplier] of Object.entries(
    value as Record<string, unknown>
  )) {
    const model = rawModel.trim();
    if (!model) continue;
    const multiplier = sanitizeMultiplier(rawMultiplier);
    if (multiplier === null) continue;
    out[model] = multiplier;
    if (Object.keys(out).length >= MAX_MODEL_BILLING_ENTRIES) break;
  }
  return out;
}

/**
 * 供入库前收紧：清洗后空表返回 null（null = 未配置，全部按 1 倍计），
 * 与 model_mapping 的存储约定一致。
 */
export function normalizeModelBillingForStorage(
  value: unknown
): ModelBillingConfig | null {
  const parsed = parseModelBilling(value);
  if (!Object.keys(parsed).length) return null;
  return parsed;
}

/**
 * 解析某次请求的模型倍率（仅 pool-api 成员调用方传入配置）：
 * - 未配置 / 出站模型为空 → 1，不改变既有计费；
 * - 精确命中（大小写敏感全等）→ 该模型倍率。
 */
export function resolveModelBillingMultiplier(
  config: unknown,
  model: string | null | undefined
): number {
  const parsed = parseModelBilling(config);
  if (!Object.keys(parsed).length) return 1;
  const requested = model?.trim();
  if (!requested) return 1;
  const exact = parsed[requested];
  return typeof exact === "number" ? exact : 1;
}
