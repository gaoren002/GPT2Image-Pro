/**
 * PostgreSQL 连接池参数（纯函数，无 I/O）。
 *
 * 使用方：./index.ts 创建标准 pg 连接池；packages/shared 的单测直接校验本模块。
 * 不 import pg 或 schema，便于在 DB-free 测试中加载。
 *
 * WHY 显式配置：pg-pool 默认 max=10 且不设取连接超时，池被占满时新请求无限排队。
 * 一旦出现“持有连接的事务再等待另一条连接”的循环等待，全站数据库访问会永久挂起，
 * 只能重启恢复。设置取连接超时后，最坏情况变为单个请求报错，而不是整站卡死。
 */

/** 默认池大小，与 pg-pool 默认值一致，避免本次修复改变既有容量假设。 */
export const DEFAULT_POOL_MAX = 10;

/**
 * 默认取连接超时。取 30 秒而非更短：正常负载下取连接是瞬时的，超过 30 秒说明
 * 已经饱和；过短会把短暂拥塞变成资金路径（扣费/退款）上的错误。
 */
export const DEFAULT_CONNECTION_TIMEOUT_MS = 30_000;

export type PgPoolConfig = {
  connectionString: string;
  max: number;
  connectionTimeoutMillis: number;
  statement_timeout?: number;
  idle_in_transaction_session_timeout?: number;
};

/**
 * 解析正整数环境变量；缺省、空串或非法值返回 undefined，由调用方决定默认值。
 */
function readPositiveInteger(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * 根据环境变量构造连接池参数。
 *
 * @param connectionString 数据库连接串。
 * @param env 环境变量（默认 process.env）。识别：
 *   - DATABASE_POOL_MAX：池大小，默认 10；
 *   - DATABASE_POOL_CONNECTION_TIMEOUT_MS：取连接超时，默认 30000；
 *   - DATABASE_STATEMENT_TIMEOUT_MS：单语句超时，默认不设置；
 *   - DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS：事务空闲超时，默认不设置。
 * @returns 传给 pg Pool 的参数。
 * @remarks 后两项默认不启用：部分维护语句和业务事务可能较长，需要时按部署显式开启。
 *   内部调度器使用独立会话 advisory 锁，不再为整个任务持有应用池事务；
 *   任务自身的数据库操作仍遵循各自的事务边界。
 */
export function buildPgPoolConfig(
  connectionString: string,
  env: Record<string, string | undefined> = process.env
): PgPoolConfig {
  const config: PgPoolConfig = {
    connectionString,
    max: readPositiveInteger(env.DATABASE_POOL_MAX) ?? DEFAULT_POOL_MAX,
    connectionTimeoutMillis:
      readPositiveInteger(env.DATABASE_POOL_CONNECTION_TIMEOUT_MS) ??
      DEFAULT_CONNECTION_TIMEOUT_MS,
  };

  const statementTimeout = readPositiveInteger(
    env.DATABASE_STATEMENT_TIMEOUT_MS
  );
  if (statementTimeout !== undefined) {
    config.statement_timeout = statementTimeout;
  }

  const idleInTransactionTimeout = readPositiveInteger(
    env.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS
  );
  if (idleInTransactionTimeout !== undefined) {
    config.idle_in_transaction_session_timeout = idleInTransactionTimeout;
  }

  return config;
}
