/**
 * generation 按日汇总的纯逻辑:UTC 日期推算、刷新区间规划、前缀与尾巴合并。
 *
 * 使用方:generation-daily-stats.ts(读路径 loadGenerationTotals 与内置任务
 * runGenerationDailyStatsJob)。本模块不 import @repo/database,可脱离数据库单测。
 *
 * 术语:
 * - 日期一律是 UTC 日的 "YYYY-MM-DD" 字符串(与 generation.created_at::date 对齐;
 *   created_at 为 UTC 墙钟的 timestamp without time zone)。该格式可直接按字典序比较。
 * - 已结算日:早于 settledEndDay 的日期。最近 SETTLE_DAYS 天(含今天)不入汇总表,
 *   由读路径实时聚合——这些天里还有 pending 行在落定、刚完成的行在补 metadata,
 *   入表后会立刻过期。
 * - 区间统一为左闭右开 [fromDay, toDay);fromDay 为 null 表示不设下界(首次全量回填)。
 */

/** 不入汇总表、由读路径实时聚合的最近天数(1 = 昨天与今天)。 */
export const GENERATION_STATS_SETTLE_DAYS = 1;

/**
 * 每次任务轮转重算的旧日期跨度(天)。用户硬删除、图片销毁(storage_key 置空)
 * 会改写旧行;按 refreshedAt 最旧优先每次重算一段,约 165 天历史在 10 分钟间隔下
 * 约 4 小时轮完一圈,累计值漂移以此为上界。
 */
export const GENERATION_STATS_DRIFT_CHUNK_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 日汇总区间,左闭右开;fromDay 为 null 表示从最早的记录开始。 */
export type DayRange = {
  fromDay: string | null;
  toDay: string;
};

/** 全站累计口径:与全局状态页原全表聚合的字段一一对应。 */
export type GenerationTotals = {
  total: number;
  completed: number;
  failed: number;
  pending: number;
  completedImages: number;
  creditsConsumed: number;
};

export const EMPTY_GENERATION_TOTALS: GenerationTotals = {
  total: 0,
  completed: 0,
  failed: 0,
  pending: 0,
  completedImages: 0,
  creditsConsumed: 0,
};

/**
 * 取 Date 所在的 UTC 日。
 * @param date - 任意时刻
 * @returns "YYYY-MM-DD"
 */
export function toUtcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * UTC 日的 0 点时刻,用作 created_at 比较边界。
 * @param day - "YYYY-MM-DD"
 * @throws 日期格式非法时抛错(调用方传入的都应是 parseDay 校验过的值)
 */
export function utcDayStart(day: string): Date {
  if (!DAY_PATTERN.test(day)) {
    throw new Error(`Invalid UTC day: ${day}`);
  }
  return new Date(`${day}T00:00:00.000Z`);
}

/**
 * UTC 日期加减天数。按毫秒运算,不受进程时区与夏令时影响。
 * @param day - "YYYY-MM-DD"
 * @param days - 可为负
 */
export function addUtcDays(day: string, days: number): string {
  return toUtcDay(new Date(utcDayStart(day).getTime() + days * DAY_MS));
}

/**
 * 已结算区间的右开边界:早于它的日期才入汇总表。
 * @param now - 当前时刻
 * @returns 例:now 为 10-22 任意时刻、SETTLE_DAYS=1 时返回 "10-21"(昨天起实时)
 */
export function getSettledEndDay(now: Date): string {
  return addUtcDays(toUtcDay(now), -GENERATION_STATS_SETTLE_DAYS);
}

/**
 * 校验数据库返回的日期值(SQL 侧用 to_char 固定输出 "YYYY-MM-DD",不受 DateStyle 影响)。
 * @returns 合法日期字符串;null / 非法值返回 null(由调用方决定回退策略)
 */
export function parseDay(value: unknown): string | null {
  return typeof value === "string" && DAY_PATTERN.test(value) ? value : null;
}

/**
 * 读路径的实时尾巴起点:汇总表最后一天的次日 0 点。
 *
 * WHY 由汇总表自身推导而非直接用 settledEndDay:任务可能滞后(刚过 0 点尚未补齐、
 * 调度器被关闭),以表内真实覆盖到的日期为界,尾巴自动覆盖缺口,结果始终精确;
 * 前缀和与该边界出自同一条 SQL 快照,不会与尾巴重复计数。
 *
 * @param lastRolledDay - 汇总表中已结算区间内的最大日期;null 表示表为空
 * @returns 尾巴起点;null 表示需对全表实时聚合(仅首次回填完成前出现)
 */
export function getLiveTailStart(lastRolledDay: string | null): Date | null {
  return lastRolledDay ? utcDayStart(addUtcDays(lastRolledDay, 1)) : null;
}

/**
 * 规划本次任务要重算的区间。
 *
 * 1. 补齐:从汇总表最后一天的次日到 settledEndDay(表为空则为全量回填,fromDay=null)。
 *    每过一个 UTC 0 点会多出一天待补。按"最后一天的次日"连续推进,汇总表因此
 *    不会出现中间缺口(读路径的正确性依赖这一点)。
 * 2. 漂移修正:从 refreshedAt 最旧的日期起重算 chunkDays 天,吸收旧行改写。
 * 两段相邻或重叠时合并为一段,避免重复扫描。
 *
 * @param input.settledEndDay - 已结算区间右开边界(getSettledEndDay)
 * @param input.lastRolledDay - 汇总表已结算区间内的最大日期,表为空时为 null
 * @param input.oldestRefreshedDay - refreshedAt 最旧的已结算日期,表为空时为 null
 * @param input.chunkDays - 漂移修正跨度(天),须为正整数
 * @returns 按日期升序的区间列表;无事可做时为空数组
 */
export function planDailyStatsRefresh(input: {
  settledEndDay: string;
  lastRolledDay: string | null;
  oldestRefreshedDay: string | null;
  chunkDays: number;
}): DayRange[] {
  const { settledEndDay, lastRolledDay, oldestRefreshedDay } = input;
  const chunkDays = Math.max(1, Math.trunc(input.chunkDays));

  const fillFrom = lastRolledDay ? addUtcDays(lastRolledDay, 1) : null;
  const fill: DayRange | null =
    fillFrom === null || fillFrom < settledEndDay
      ? { fromDay: fillFrom, toDay: settledEndDay }
      : null;

  let drift: DayRange | null = null;
  if (oldestRefreshedDay && oldestRefreshedDay < settledEndDay) {
    const chunkEnd = addUtcDays(oldestRefreshedDay, chunkDays);
    drift = {
      fromDay: oldestRefreshedDay,
      toDay: chunkEnd < settledEndDay ? chunkEnd : settledEndDay,
    };
  }

  if (fill && drift) {
    // 全量回填已覆盖一切;否则相邻 / 重叠则合并(drift 必在 fill 之前开始)。
    if (fill.fromDay === null) return [fill];
    if (drift.toDay >= fill.fromDay) {
      return [{ fromDay: drift.fromDay, toDay: fill.toDay }];
    }
    return [drift, fill];
  }
  if (fill) return [fill];
  if (drift) return [drift];
  return [];
}

/**
 * 已结算前缀 + 实时尾巴逐项相加。
 * @returns 新对象,不修改入参
 */
export function mergeGenerationTotals(
  prefix: GenerationTotals,
  tail: GenerationTotals
): GenerationTotals {
  return {
    total: prefix.total + tail.total,
    completed: prefix.completed + tail.completed,
    failed: prefix.failed + tail.failed,
    pending: prefix.pending + tail.pending,
    completedImages: prefix.completedImages + tail.completedImages,
    // numeric(18,2) 求和后转 number;两段相加后按分取整,消除二进制浮点尾差。
    creditsConsumed:
      Math.round((prefix.creditsConsumed + tail.creditsConsumed) * 100) / 100,
  };
}
