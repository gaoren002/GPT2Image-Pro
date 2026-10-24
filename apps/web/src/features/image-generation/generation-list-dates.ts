/** 历史和图库共用的日期边界；复用 URL 日历日校验与 shared 时区转换，不依赖数据库。 */
import { parseDateInputInTimeZone } from "@repo/shared/time-zone";
import { normalizeGenerationListDate } from "./generation-list-filters";

/**
 * 将日期筛选归一化并按应用时区解释；非法或重复参数视为未筛选。
 * 上下界分别解析，保留结束日整天，避免以固定 24 小时计算跨 DST 的日界。
 */
export function parseGenerationListDates(
  filters: { from?: unknown; to?: unknown },
  timeZone: string
) {
  const fromInput = normalizeGenerationListDate(filters.from);
  const toInput = normalizeGenerationListDate(filters.to);
  return {
    fromInput,
    toInput,
    fromDate: parseDateInputInTimeZone(fromInput, { timeZone }),
    toDate: parseDateInputInTimeZone(toInput, { timeZone, endOfDay: true }),
  };
}
