/**
 * R44 后端池历史清理，供父 scheduled-jobs 接线；不改变选择、传输或配置路径。
 * 复用 expires_at / bucket_started_at 现有索引，逐批独立短语句，不开启外层事务。
 */
import {
  imageBackendSchedulerMetric,
  imageBackendStickyBinding,
} from "@repo/database/schema";
import {
  hasDatabaseErrorCode,
  PG_UNDEFINED_TABLE,
} from "@repo/shared/db/error-summary";
import { type SQL, sql } from "drizzle-orm";

type RetentionOptions = {
  now?: Date;
  batchSize?: number;
  maxBatches?: number;
  metricsRetentionDays?: number;
};
type Execute = (query: SQL) => Promise<{ rowCount: number | null }>;

/** 验证维护预算；非法输入在发送任何 SQL 前失败，默认保留 30 天小时指标。 */
function limits(options: RetentionOptions) {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? 500;
  const maxBatches = options.maxBatches ?? 4;
  const metricsRetentionDays = options.metricsRetentionDays ?? 30;
  if (
    !Number.isFinite(now.getTime()) ||
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 1000 ||
    !Number.isInteger(maxBatches) ||
    maxBatches < 1 ||
    maxBatches > 10 ||
    !Number.isInteger(metricsRetentionDays) ||
    metricsRetentionDays < 1 ||
    metricsRetentionDays > 365
  )
    throw new Error("Invalid pool retention limits");
  const metricsBefore = new Date(
    Math.floor(now.getTime() / 3_600_000) * 3_600_000 -
      metricsRetentionDays * 86_400_000
  );
  return { now, batchSize, maxBatches, metricsBefore };
}

/**
 * 生成参数化、按时间索引顺序取候选的两条清理语句，便于 DB-free 检查及父 PG EXPLAIN。
 * SKIP LOCKED 不与正在续期的 sticky 行等待；DELETE 重验时间避免并发续期后误删。
 * 这里只提供索引可用的 SQL 形状，实际计划与锁行为仍须真实 PostgreSQL 验证。
 */
export function buildPoolRetentionStatements(
  options: RetentionOptions = {}
): [SQL, SQL] {
  const { now, batchSize, metricsBefore } = limits(options);
  return [
    sql`with expired as (
      select ${imageBackendStickyBinding.id} from ${imageBackendStickyBinding}
      where ${imageBackendStickyBinding.expiresAt} <= ${now.toISOString()}::timestamp
      order by ${imageBackendStickyBinding.expiresAt}
      limit ${batchSize} for update skip locked
    ) delete from ${imageBackendStickyBinding} using expired
      where ${imageBackendStickyBinding.id} = expired.id
        and ${imageBackendStickyBinding.expiresAt} <= ${now.toISOString()}::timestamp`,
    sql`with expired as (
      select ${imageBackendSchedulerMetric.id} from ${imageBackendSchedulerMetric}
      where ${imageBackendSchedulerMetric.bucketStartedAt} < ${metricsBefore.toISOString()}::timestamp
      order by ${imageBackendSchedulerMetric.bucketStartedAt}
      limit ${batchSize} for update skip locked
    ) delete from ${imageBackendSchedulerMetric} using expired
      where ${imageBackendSchedulerMetric.id} = expired.id
        and ${imageBackendSchedulerMetric.bucketStartedAt} < ${metricsBefore.toISOString()}::timestamp`,
  ];
}

/**
 * 每表默认最多 4 批 × 500 行，空/不足一批即停止。缺表仅认 42P01，其余错误上抛。
 * execute 可注入测试或 PG 验收；默认延迟加载全局 db，每批各自提交，不持有长事务。
 */
export async function cleanupImageBackendRetention(
  options: RetentionOptions = {},
  execute?: Execute
): Promise<{ stickyDeleted: number; metricsDeleted: number }> {
  const { batchSize, maxBatches } = limits(options);
  const statements = buildPoolRetentionStatements(options);
  const run =
    execute ??
    (async (query: SQL) => (await import("@repo/database")).db.execute(query));
  const totals = [0, 0];
  for (const [index, query] of statements.entries()) {
    for (let batch = 0; batch < maxBatches; batch++) {
      let deleted: number;
      try {
        deleted = (await run(query)).rowCount ?? 0;
      } catch (error) {
        if (hasDatabaseErrorCode(error, PG_UNDEFINED_TABLE)) break;
        throw error;
      }
      totals[index] = (totals[index] ?? 0) + deleted;
      if (deleted < batchSize) break;
    }
  }
  return { stickyDeleted: totals[0] ?? 0, metricsDeleted: totals[1] ?? 0 };
}
