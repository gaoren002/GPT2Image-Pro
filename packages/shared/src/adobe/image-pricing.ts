/**
 * Adobe Firefly 图像模型计费倍率解析（纯函数，DB-free，可单测）。
 *
 * 口径：图像基础成本按尺寸（像素）计算，再按 firefly 模型族倍率缩放。本模块只负责
 * 从模型 id 解析出 firefly 模型族并取对应倍率，不读 DB、不算基础价格。
 * per-model 倍率由系统设置提供（IMAGE_MODEL_MULTIPLIERS）；非 firefly 模型恒返回 1。
 * 使用方：图像生成扣费（operations 侧），把该倍率折进整体计费倍率。
 */

const FIREFLY_MODEL_PREFIX = "firefly-";

// firefly 图像模型族枚举。与 adobe-direct 的族列表保持一致；用于从
// `firefly-<family>...` 形式的模型 id 中按"最长前缀"匹配出族，避免 nano-banana
// 误吞 nano-banana-pro / nano-banana2，gpt-image-2 误吞 gpt-image-1.5。
// gpt-image-2.5 独立成族：sunburst/flare 变体归 2.5，不再按前缀落到
// gpt-image-2 的定价（2026-10-20 之前 2.5 系共享 2 的倍率行）。
export const FIREFLY_IMAGE_FAMILIES = [
  "gpt-image-2.5",
  "gpt-image-2",
  "gpt-image-1.5",
  "nano-banana",
  "nano-banana2",
  "nano-banana-pro",
] as const;

export type FireflyImageFamily = (typeof FIREFLY_IMAGE_FAMILIES)[number];

/**
 * 从图像模型 id 解析 firefly 模型族。
 * @param model 模型 id；firefly 形如 `firefly-<family>` 或 `firefly-<family>-<...>`。
 * @returns 命中的模型族；非 firefly 模型或无法匹配时返回 null。
 */
function resolveFireflyImageFamily(
  model: string | null | undefined
): FireflyImageFamily | null {
  const normalized = model?.trim().toLowerCase();
  if (!normalized?.startsWith(FIREFLY_MODEL_PREFIX)) return null;
  const rest = normalized.slice(FIREFLY_MODEL_PREFIX.length);
  // 按族名长度降序匹配，确保最长前缀优先（如 gpt-image-1.5 先于 gpt-image-... 的歧义）。
  const byLength = [...FIREFLY_IMAGE_FAMILIES].sort(
    (a, b) => b.length - a.length
  );
  for (const family of byLength) {
    if (rest === family || rest.startsWith(`${family}-`)) return family;
  }
  return null;
}

/**
 * 解析某图像模型的计费倍率。
 * @param model 图像模型 id（如 `firefly-gpt-image-2`）。
 * @param multipliers family → 倍率 的配置 map（来自 IMAGE_MODEL_MULTIPLIERS）。
 * @returns 命中族且倍率为正有限数则返回该倍率；否则（含非 firefly 模型）返回 1。
 */
export function resolveImageModelMultiplier(
  model: string | null | undefined,
  multipliers: Record<string, number> | null | undefined
): number {
  const family = resolveFireflyImageFamily(model);
  if (!family || !multipliers) return 1;
  const value = multipliers[family];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 1;
}
