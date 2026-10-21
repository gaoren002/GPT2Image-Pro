/**
 * 池 API 成员的按模型计价倍率（纯函数，DB-free）。
 *
 * 同一个上游 API 服务不同模型时成本差异可能很大（如 2.5 系贵于 2 系、
 * 改写后的 -gzs/-zx 变体另有定价）。本模块把「模型 id → 计费倍率」做成
 * 每个池 API 成员可配的表（存 metadata.modelBilling），在 operations.ts
 * 与组倍率叠乘：
 *
 *   billingMultiplier = 后端池倍率 × 模型倍率(本模块,仅 pool-api) × 质量倍率
 *
 * 值支持两种形态：
 * - 数字：该模型对所有质量档统一按此倍率（与成员级质量表叠乘）；
 * - 质量分档表 {auto/low/medium/high/xhigh/max → 倍率}：该模型按质量档取倍率，
 *   命中时【取代】成员级质量表（避免双重计价）；档位缺失回退 1（xhigh/max
 *   未配置回退 high，与 quality-billing 口径一致）。
 *
 * 匹配规则：【精确命中】。键与出站模型 id 全等（大小写敏感）才生效，
 * 不做前缀/族匹配——避免 gpt-image-2 误伤 gpt-image-2.5；要给改写变体
 * 定价就把改写后的完整 id 配成键。
 * 仅作用于 pool-api 成员（账号不读此表）。
 */

import { QUALITY_BILLING_LEVELS, type QualityBillingLevel } from "./quality-billing";

/** 单模型的计价配置：统一倍率，或按质量分档。 */
export type ModelBillingEntry =
  | number
  | Partial<Record<QualityBillingLevel, number>>;

/** 每成员的模型倍率表；未配置的模型视为 1。 */
export type ModelBillingConfig = Record<string, ModelBillingEntry>;

/** 与 operations.ts normalizeBillingMultiplier 同口径：正值、[0.01, 100]、两位小数。 */
const MIN_MODEL_BILLING_MULTIPLIER = 0.01;
const MAX_MODEL_BILLING_MULTIPLIER = 100;
const MAX_MODEL_BILLING_ENTRIES = 100;

const QUALITY_LEVEL_SET = new Set<string>(QUALITY_BILLING_LEVELS);

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

function normalizeQualityLevel(value: string): string {
  return value.trim().toLowerCase();
}

/** 清洗单条目：数字直接收敛；对象只保留合法质量档的合法数值。 */
function parseEntry(value: unknown): ModelBillingEntry | null {
  if (typeof value === "number" || typeof value === "string") {
    const multiplier = sanitizeMultiplier(value);
    return multiplier === null ? null : multiplier;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Partial<Record<QualityBillingLevel, number>> = {};
  for (const [rawLevel, rawMultiplier] of Object.entries(
    value as Record<string, unknown>
  )) {
    const level = normalizeQualityLevel(rawLevel);
    if (!QUALITY_LEVEL_SET.has(level)) continue;
    const multiplier = sanitizeMultiplier(rawMultiplier);
    if (multiplier === null) continue;
    out[level as QualityBillingLevel] = multiplier;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * 把任意输入（成员 metadata.modelBilling / 表单对象）清洗成合法倍率表：
 * 键收窄为非空字符串（去首尾空白），数值非法丢弃；超上限截断防止滥用。
 * 不删除值为 1 的键（保留管理员显式意图）。
 */
export function parseModelBilling(value: unknown): ModelBillingConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: ModelBillingConfig = {};
  for (const [rawModel, rawEntry] of Object.entries(
    value as Record<string, unknown>
  )) {
    const model = rawModel.trim();
    if (!model) continue;
    const entry = parseEntry(rawEntry);
    if (entry === null) continue;
    out[model] = entry;
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

export type ResolvedModelBilling = {
  /** 该模型（按请求质量）的倍率；未配置 1。 */
  multiplier: number;
  /**
   * 该模型是否启用了质量分档表。为真时调用方应【跳过】成员级质量倍率
   * （本表已按质量定价，再叠成员级表会双重计价）。
   */
  replacesQualityBilling: boolean;
};

/**
 * 解析某次请求的模型倍率（仅 pool-api 成员调用方传入配置）：
 * - 未配置 / 出站模型为空 → 1，不改变既有计费；
 * - 精确命中（大小写敏感全等）→ 数字取该值；质量分档表按请求 quality
 *   取档（xhigh/max 未配置回退 high），无该档回退 1。
 */
export function resolveModelBilling(
  config: unknown,
  model: string | null | undefined,
  quality: string | null | undefined
): ResolvedModelBilling {
  const parsed = parseModelBilling(config);
  if (!Object.keys(parsed).length) {
    return { multiplier: 1, replacesQualityBilling: false };
  }
  const requested = model?.trim();
  if (!requested) return { multiplier: 1, replacesQualityBilling: false };
  const entry = parsed[requested];
  if (entry === undefined) {
    return { multiplier: 1, replacesQualityBilling: false };
  }
  if (typeof entry === "number") {
    return { multiplier: entry, replacesQualityBilling: false };
  }
  const requestedQuality = normalizeQualityLevel(String(quality || ""));
  const exact =
    QUALITY_LEVEL_SET.has(requestedQuality) && requestedQuality
      ? entry[requestedQuality as QualityBillingLevel]
      : undefined;
  if (typeof exact === "number") {
    return { multiplier: exact, replacesQualityBilling: true };
  }
  if (requestedQuality === "xhigh" || requestedQuality === "max") {
    const high = entry.high;
    if (typeof high === "number") {
      return { multiplier: high, replacesQualityBilling: true };
    }
  }
  return { multiplier: 1, replacesQualityBilling: true };
}

/**
 * 兼容旧签名：只取倍率数值。新调用方请用 resolveModelBilling（能感知
 * 质量分档取代语义）。
 */
export function resolveModelBillingMultiplier(
  config: unknown,
  model: string | null | undefined,
  quality?: string | null | undefined
): number {
  return resolveModelBilling(config, model, quality).multiplier;
}
