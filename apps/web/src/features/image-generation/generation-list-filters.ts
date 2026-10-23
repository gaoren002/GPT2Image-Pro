/** 历史记录与图库共用的 URL 筛选校验；保持无数据库依赖，便于验证输入边界。 */

export type GenerationListSearchParams = {
  [key: string]: string | string[] | undefined;
};

/** 单值筛选不接受重复查询键或其他类型；忽略歧义输入，避免对数组调用字符串方法。 */
export function getSingleGenerationListParam(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 页码必须为正整数且分页计算不溢出；非法输入回到第一页。 */
export function normalizeGenerationListPage(
  value: unknown,
  pageSize: number
): number {
  const page = Number(getSingleGenerationListParam(value));
  return Number.isSafeInteger(page) &&
    page > 0 &&
    Number.isSafeInteger(page * pageSize)
    ? page
    : 1;
}

/**
 * 校验 date 输入框的 YYYY-MM-DD 值；非法日期视为未筛选。
 * UTC 仅用于检查日历日是否存在，查询仍由页面按原有本地日界构造。
 */
export function normalizeGenerationListDate(value: unknown): string {
  const date = getSingleGenerationListParam(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "";
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === date
    ? date
    : "";
}
