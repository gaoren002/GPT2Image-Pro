/**
 * generation-daily-stats-plan 纯逻辑单测:UTC 日期推算、读路径尾巴边界、
 * 任务刷新区间规划(补齐 / 漂移修正 / 合并)与前缀尾巴合并。
 */
import { describe, expect, it } from "vitest";

import {
  addUtcDays,
  EMPTY_GENERATION_TOTALS,
  GENERATION_STATS_SETTLE_DAYS,
  getLiveTailStart,
  getSettledEndDay,
  mergeGenerationTotals,
  parseDay,
  planDailyStatsRefresh,
  toUtcDay,
  utcDayStart,
} from "./generation-daily-stats-plan";

describe("UTC 日期推算", () => {
  it("toUtcDay 取 UTC 日而非进程本地日", () => {
    expect(toUtcDay(new Date("2026-10-21T23:59:59.999Z"))).toBe("2026-10-21");
    expect(toUtcDay(new Date("2026-10-22T00:00:00.000Z"))).toBe("2026-10-22");
  });

  it("addUtcDays 跨月、跨年、负偏移", () => {
    expect(addUtcDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addUtcDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addUtcDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addUtcDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(addUtcDays("2026-10-22", 0)).toBe("2026-10-22");
  });

  it("utcDayStart 返回该日 UTC 0 点,非法格式抛错", () => {
    expect(utcDayStart("2026-10-21").toISOString()).toBe(
      "2026-10-21T00:00:00.000Z"
    );
    expect(() => utcDayStart("2026/10/21")).toThrow();
    expect(() => utcDayStart("")).toThrow();
  });

  it("getSettledEndDay:今天与最近 SETTLE_DAYS 天不入汇总表", () => {
    expect(GENERATION_STATS_SETTLE_DAYS).toBe(1);
    expect(getSettledEndDay(new Date("2026-10-22T00:00:00.000Z"))).toBe(
      "2026-10-21"
    );
    expect(getSettledEndDay(new Date("2026-10-22T23:59:59.999Z"))).toBe(
      "2026-10-21"
    );
    expect(getSettledEndDay(new Date("2027-01-01T08:00:00.000Z"))).toBe(
      "2026-12-31"
    );
  });

  it("parseDay 只接受 YYYY-MM-DD 字符串", () => {
    expect(parseDay("2026-10-21")).toBe("2026-10-21");
    expect(parseDay(null)).toBeNull();
    expect(parseDay(undefined)).toBeNull();
    expect(parseDay("21/10/2026")).toBeNull();
    expect(parseDay("2026-10-21 00:00:00")).toBeNull();
    expect(parseDay(new Date("2026-10-21T00:00:00Z"))).toBeNull();
  });
});

describe("getLiveTailStart", () => {
  it("表为空时需全表实时聚合", () => {
    expect(getLiveTailStart(null)).toBeNull();
  });

  it("尾巴从汇总表最后一天的次日 0 点开始", () => {
    expect(getLiveTailStart("2026-10-20")?.toISOString()).toBe(
      "2026-10-21T00:00:00.000Z"
    );
    expect(getLiveTailStart("2026-12-31")?.toISOString()).toBe(
      "2027-01-01T00:00:00.000Z"
    );
  });
});

describe("planDailyStatsRefresh", () => {
  const settledEndDay = "2026-10-21";

  it("空表:单段全量回填,不做漂移修正", () => {
    expect(
      planDailyStatsRefresh({
        settledEndDay,
        lastRolledDay: null,
        oldestRefreshedDay: null,
        chunkDays: 7,
      })
    ).toEqual([{ fromDay: null, toDay: settledEndDay }]);
  });

  it("已补齐:只重算最旧的一段", () => {
    expect(
      planDailyStatsRefresh({
        settledEndDay,
        lastRolledDay: "2026-10-20",
        oldestRefreshedDay: "2026-05-11",
        chunkDays: 7,
      })
    ).toEqual([{ fromDay: "2026-05-11", toDay: "2026-05-18" }]);
  });

  it("任务滞后:先漂移段后补齐段,升序且不重叠", () => {
    expect(
      planDailyStatsRefresh({
        settledEndDay,
        lastRolledDay: "2026-10-18",
        oldestRefreshedDay: "2026-06-01",
        chunkDays: 7,
      })
    ).toEqual([
      { fromDay: "2026-06-01", toDay: "2026-06-08" },
      { fromDay: "2026-10-19", toDay: settledEndDay },
    ]);
  });

  it("漂移段与补齐段相邻时合并为一段", () => {
    expect(
      planDailyStatsRefresh({
        settledEndDay,
        lastRolledDay: "2026-10-18",
        oldestRefreshedDay: "2026-10-12",
        chunkDays: 7,
      })
    ).toEqual([{ fromDay: "2026-10-12", toDay: settledEndDay }]);
  });

  it("漂移段越过补齐起点时合并,不重复扫描", () => {
    expect(
      planDailyStatsRefresh({
        settledEndDay,
        lastRolledDay: "2026-10-18",
        oldestRefreshedDay: "2026-10-15",
        chunkDays: 7,
      })
    ).toEqual([{ fromDay: "2026-10-15", toDay: settledEndDay }]);
  });

  it("漂移段在已结算边界处截断", () => {
    expect(
      planDailyStatsRefresh({
        settledEndDay,
        lastRolledDay: "2026-10-20",
        oldestRefreshedDay: "2026-10-17",
        chunkDays: 7,
      })
    ).toEqual([{ fromDay: "2026-10-17", toDay: settledEndDay }]);
  });

  it("chunkDays 非正整数时至少重算 1 天", () => {
    expect(
      planDailyStatsRefresh({
        settledEndDay,
        lastRolledDay: "2026-10-20",
        oldestRefreshedDay: "2026-09-01",
        chunkDays: 0,
      })
    ).toEqual([{ fromDay: "2026-09-01", toDay: "2026-09-02" }]);
    expect(
      planDailyStatsRefresh({
        settledEndDay,
        lastRolledDay: "2026-10-20",
        oldestRefreshedDay: "2026-09-01",
        chunkDays: 2.9,
      })
    ).toEqual([{ fromDay: "2026-09-01", toDay: "2026-09-03" }]);
  });

  it("越界的漂移日期被忽略", () => {
    expect(
      planDailyStatsRefresh({
        settledEndDay,
        lastRolledDay: "2026-10-20",
        oldestRefreshedDay: settledEndDay,
        chunkDays: 7,
      })
    ).toEqual([]);
  });
});

describe("mergeGenerationTotals", () => {
  it("逐项相加并消除积分的浮点尾差", () => {
    const merged = mergeGenerationTotals(
      {
        total: 1_300_000,
        completed: 1_140_000,
        failed: 160_000,
        pending: 0,
        completedImages: 1_120_000,
        creditsConsumed: 8_028_236.99,
      },
      {
        total: 7553,
        completed: 5100,
        failed: 2449,
        pending: 4,
        completedImages: 5145,
        creditsConsumed: 0.1 + 0.2,
      }
    );
    expect(merged).toEqual({
      total: 1_307_553,
      completed: 1_145_100,
      failed: 162_449,
      pending: 4,
      completedImages: 1_125_145,
      creditsConsumed: 8_028_237.29,
    });
  });

  it("空前缀等于尾巴本身,且不修改入参", () => {
    const tail = { ...EMPTY_GENERATION_TOTALS, total: 3, completed: 3 };
    expect(mergeGenerationTotals(EMPTY_GENERATION_TOTALS, tail)).toEqual(tail);
    expect(EMPTY_GENERATION_TOTALS.total).toBe(0);
  });
});
