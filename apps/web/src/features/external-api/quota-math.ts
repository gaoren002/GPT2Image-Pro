/**
 * 外部 API Key 配额相关的纯函数与错误类型（DB-free）。
 *
 * 从 quota.ts 抽出，使额度归一化/剩余额度计算等纯逻辑可在不 import @repo/database 的
 * 情况下单测（quota.ts 顶层 import db，否则连带加载真实 DB 模块无法 DB-free 测试）。
 * quota.ts re-export 这些符号，调用方无需改动。
 */

const CREDIT_DECIMAL_PLACES = 2;
const CREDIT_DECIMAL_FACTOR = 10 ** CREDIT_DECIMAL_PLACES;

// 与积分账本同一精度不变量：四舍五入到两位小数（EPSILON 修正浮点误差）。
export function roundQuotaCredits(value: number) {
  return (
    Math.round((value + Number.EPSILON) * CREDIT_DECIMAL_FACTOR) /
    CREDIT_DECIMAL_FACTOR
  );
}

/**
 * 归一化 API Key 额度上限：空值表示"不限额"返回 null；非有限或负数抛错；否则两位取整。
 */
export function normalizeExternalApiKeyCreditLimit(
  value: number | string | null | undefined
) {
  if (value === undefined || value === null || value === "") return null;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new Error("API Key 额度必须是大于等于 0 的数字");
  }
  return roundQuotaCredits(numeric);
}

/**
 * 计算剩余可用额度：不限额（limit===null）返回 null；否则 max(0, limit-used) 并两位取整。
 */
export function getExternalApiKeyQuotaRemaining(
  creditLimit: number | null,
  creditsUsed: number
) {
  if (creditLimit === null) return null;
  return roundQuotaCredits(Math.max(0, creditLimit - creditsUsed));
}
