/**
 * generation 按日汇总(表 generation_daily_stats,迁移 0051)的读写。
 *
 * 职责:
 * - loadGenerationTotals:全局状态页"全站累计"读路径 = 汇总表已结算前缀求和 +
 *   最近一两天的实时尾巴。替代原对 130 万行全表聚合(实测 27-31 秒,冷缓存时整段
 *   压在页面请求上),冷路径降到亚秒级。
 * - runGenerationDailyStatsJob:内置定时任务(internal-job-scheduler 的
 *   generation-daily-stats):补齐新结算的日期,并按 refreshedAt 轮转重算旧日期。
 *
 * 口径:聚合表达式只在 TOTALS_AGGREGATES 定义一次,前缀(入表)与尾巴(实时)共用,
 * 与原全表聚合逐项一致(上线前在生产以按日求和对照全表结果,6 项全等)。
 *
 * 依赖:@repo/database(db、generation、generationDailyStats);纯逻辑见
 * generation-daily-stats-plan.ts。
 */
import { db, generation, generationDailyStats } from "@repo/database";
import { and, asc, gte, lt, type SQL, sql } from "drizzle-orm";

import {
  type DayRange,
  EMPTY_GENERATION_TOTALS,
  GENERATION_STATS_DRIFT_CHUNK_DAYS,
  type GenerationTotals,
  getLiveTailStart,
  getSettledEndDay,
  mergeGenerationTotals,
  parseDay,
  planDailyStatsRefresh,
  utcDayStart,
} from "./generation-daily-stats-plan";

/**
 * 汇总列的聚合表达式(纯常量 SQL,不含任何参数,故可安全 sql.raw)。作用于
 * generationRowsSource 产出的别名 g。
 *
 * completedImages 与全局状态页窗口统计同口径:completed 行优先取
 * metadata.outputImage.billableImageOutputCount(须为 JSON number),缺失时按
 * storage_key 是否存在计 1/0。
 */
const TOTALS_AGGREGATES = {
  total: "count(*)",
  completed:
    "coalesce(sum(case when g.status = 'completed' then 1 else 0 end), 0)",
  failed: "coalesce(sum(case when g.status = 'failed' then 1 else 0 end), 0)",
  pending: "coalesce(sum(case when g.status = 'pending' then 1 else 0 end), 0)",
  completedImages:
    "coalesce(sum(case when g.status = 'completed' then case when jsonb_typeof(g.bic) = 'number' then (g.bic #>> '{}')::int when g.storage_key is not null then 1 else 0 end else 0 end), 0)",
  creditsConsumed: "coalesce(sum(g.credits_consumed), 0)",
} as const;

/**
 * 汇总所需的逐行字段,作为 FROM 子查询(别名 g)。
 *
 * WHY offset 0:generation.metadata 是 json(文本)列,每次 ::jsonb 都要 TOAST 解压
 * 并整段解析,是这类聚合的全部成本。offset 0 是优化屏障,阻止 PostgreSQL 把子查询
 * 上拉展开——展开后外层 CASE 每引用一次 bic 就重算一次转换。这里每行只取一次,
 * 且只对 completed 行取(其余行不读 metadata)。
 *
 * @param range.from / range.to - created_at 的左闭 / 右开边界(UTC 0 点);null 不设限
 */
function generationRowsSource(range: {
  from: Date | null;
  to: Date | null;
}): SQL {
  const conditions: SQL[] = [];
  if (range.from) conditions.push(gte(generation.createdAt, range.from));
  if (range.to) conditions.push(lt(generation.createdAt, range.to));
  const where =
    conditions.length > 0
      ? sql` where ${sql.join(conditions, sql` and `)}`
      : sql``;
  return sql`(select ${generation.createdAt}::date as day, ${generation.status} as status, ${generation.storageKey} as storage_key, ${generation.creditsConsumed} as credits_consumed, case when ${generation.status} = 'completed' then ${generation.metadata}::jsonb #> '{outputImage,billableImageOutputCount}' end as bic from ${generation}${where} offset 0) as g`;
}

/** 实时聚合的 select 字段(每次调用新建,避免共享 SQL 片段被 mapWith 改写)。 */
function liveTotalsSelection() {
  return {
    total: sql<number>`${sql.raw(TOTALS_AGGREGATES.total)}`.mapWith(Number),
    completed: sql<number>`${sql.raw(TOTALS_AGGREGATES.completed)}`.mapWith(
      Number
    ),
    failed: sql<number>`${sql.raw(TOTALS_AGGREGATES.failed)}`.mapWith(Number),
    pending: sql<number>`${sql.raw(TOTALS_AGGREGATES.pending)}`.mapWith(Number),
    completedImages: sql<number>`${sql.raw(
      TOTALS_AGGREGATES.completedImages
    )}`.mapWith(Number),
    creditsConsumed: sql<number>`${sql.raw(
      TOTALS_AGGREGATES.creditsConsumed
    )}`.mapWith(Number),
  };
}

/** 汇总表中已结算区间(day < settledEndDay)的最大日期,固定 "YYYY-MM-DD" 输出。 */
const lastRolledDayExpr = sql<
  string | null
>`to_char(max(${generationDailyStats.day}), 'YYYY-MM-DD')`;

/**
 * 全站累计(全局状态页)。
 *
 * = 汇总表前缀(day < settledEndDay)+ 实时尾巴(created_at >= 前缀最后一天的次日)。
 * 前缀和与尾巴边界出自同一条语句快照,任务在两次查询之间提交也不会重复或漏计。
 * 汇总表为空(首次部署、回填完成前)时尾巴退化为全表实时聚合:结果仍精确,只是慢。
 *
 * @param now - 当前时刻(测试可注入)
 * @returns 与原全表聚合同口径的累计值;数据库异常上抛由页面缓存层处理
 */
export async function loadGenerationTotals(
  now: Date = new Date()
): Promise<GenerationTotals> {
  const settledEndDay = getSettledEndDay(now);
  const [prefixRow] = await db
    .select({
      total:
        sql<number>`coalesce(sum(${generationDailyStats.total}), 0)`.mapWith(
          Number
        ),
      completed:
        sql<number>`coalesce(sum(${generationDailyStats.completed}), 0)`.mapWith(
          Number
        ),
      failed:
        sql<number>`coalesce(sum(${generationDailyStats.failed}), 0)`.mapWith(
          Number
        ),
      pending:
        sql<number>`coalesce(sum(${generationDailyStats.pending}), 0)`.mapWith(
          Number
        ),
      completedImages:
        sql<number>`coalesce(sum(${generationDailyStats.completedImages}), 0)`.mapWith(
          Number
        ),
      creditsConsumed:
        sql<number>`coalesce(sum(${generationDailyStats.creditsConsumed}), 0)`.mapWith(
          Number
        ),
      lastRolledDay: lastRolledDayExpr,
    })
    .from(generationDailyStats)
    .where(lt(generationDailyStats.day, settledEndDay));

  const lastRolledDay = parseDay(prefixRow?.lastRolledDay ?? null);
  const prefix: GenerationTotals =
    prefixRow && lastRolledDay
      ? {
          total: prefixRow.total,
          completed: prefixRow.completed,
          failed: prefixRow.failed,
          pending: prefixRow.pending,
          completedImages: prefixRow.completedImages,
          creditsConsumed: prefixRow.creditsConsumed,
        }
      : EMPTY_GENERATION_TOTALS;

  const [tailRow] = await db
    .select(liveTotalsSelection())
    .from(
      generationRowsSource({ from: getLiveTailStart(lastRolledDay), to: null })
    );

  return mergeGenerationTotals(prefix, tailRow ?? EMPTY_GENERATION_TOTALS);
}

/**
 * 原子重算一个日期区间:删除区间内旧汇总行,再按 generation 现状逐日插入。
 *
 * 同一事务内先删后插,读路径永远看不到"已删未插"的中间态;区间内已无记录的日期
 * (例如当天记录被全部删除)随删除自然消失,与"按 generation 直接聚合"一致。
 * 只读 generation、只写汇总表,不锁业务行。
 *
 * @param range - [fromDay, toDay);fromDay 为 null 表示从最早记录起(全量回填)
 */
async function refreshDayRange(range: DayRange): Promise<void> {
  const rows = generationRowsSource({
    from: range.fromDay ? utcDayStart(range.fromDay) : null,
    to: utcDayStart(range.toDay),
  });
  await db.transaction(async (tx) => {
    await tx
      .delete(generationDailyStats)
      .where(
        range.fromDay
          ? and(
              gte(generationDailyStats.day, range.fromDay),
              lt(generationDailyStats.day, range.toDay)
            )
          : lt(generationDailyStats.day, range.toDay)
      );
    await tx.execute(
      sql`insert into ${generationDailyStats} ("day", "total", "completed", "failed", "pending", "completed_images", "credits_consumed", "refreshed_at") select g.day, ${sql.raw(TOTALS_AGGREGATES.total)}, ${sql.raw(TOTALS_AGGREGATES.completed)}, ${sql.raw(TOTALS_AGGREGATES.failed)}, ${sql.raw(TOTALS_AGGREGATES.pending)}, ${sql.raw(TOTALS_AGGREGATES.completedImages)}, ${sql.raw(TOTALS_AGGREGATES.creditsConsumed)}, now() from ${rows} group by g.day`
    );
  });
}

/**
 * 内置任务:维护 generation_daily_stats。
 *
 * 由 internal-job-scheduler 以数据库 advisory lock + 间隔状态调度,多实例下同一时刻
 * 只有一个进程执行。首次运行(表为空)做一次全量回填(生产约 40 秒,后台进行);
 * 此后每次只补齐新结算的日期并轮转重算一段旧日期(通常数秒内)。
 *
 * @param now - 当前时刻(测试可注入)
 * @returns 本次重算的区间与已结算边界,供调度日志与排查
 * @throws 数据库异常上抛,由调度器记录并在下个周期重试(已完成的区间各自已提交)
 */
export async function runGenerationDailyStatsJob(now: Date = new Date()) {
  const settledEndDay = getSettledEndDay(now);
  const [lastRow] = await db
    .select({ lastRolledDay: lastRolledDayExpr })
    .from(generationDailyStats)
    .where(lt(generationDailyStats.day, settledEndDay));
  const [oldestRow] = await db
    .select({
      day: sql<string>`to_char(${generationDailyStats.day}, 'YYYY-MM-DD')`,
    })
    .from(generationDailyStats)
    .where(lt(generationDailyStats.day, settledEndDay))
    .orderBy(
      asc(generationDailyStats.refreshedAt),
      asc(generationDailyStats.day)
    )
    .limit(1);

  const ranges = planDailyStatsRefresh({
    settledEndDay,
    lastRolledDay: parseDay(lastRow?.lastRolledDay ?? null),
    oldestRefreshedDay: parseDay(oldestRow?.day ?? null),
    chunkDays: GENERATION_STATS_DRIFT_CHUNK_DAYS,
  });
  // 升序逐段提交:中途失败时已完成的段保留,下次从表内最后一天续补,不留缺口。
  for (const range of ranges) {
    await refreshDayRange(range);
  }
  return { settledEndDay, ranges };
}
