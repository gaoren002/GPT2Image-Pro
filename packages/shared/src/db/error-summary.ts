/**
 * 数据库错误的安全摘要与错误码判定（纯函数，无 I/O）。
 *
 * 使用方：任何需要把数据库错误写进日志、返回给管理端或上报监控的调用点。
 *
 * WHY：drizzle-orm 把驱动错误包装成 `Failed query: <SQL>\nparams: <全部参数>`。
 * 直接记录 error.message 会把语句参数一起写出去——导入上游账号、同步令牌、
 * 批量改写凭据等路径的参数里就是明文 access/refresh token 与厂商密钥，它们会进入
 * 日志、日志汇聚系统以及 Sentry（Pino 的 redact 只按字段名脱敏，不处理消息字符串）。
 * 另外，判断"表不存在"这类条件必须用驱动错误码：SQL 文本里必然含表名，按消息子串
 * 判断会把语句超时、锁超时、断连一并误判，使依赖该判定的降级逻辑在数据库压力最大时
 * 放弃并发控制。
 */

/** PostgreSQL 错误码：关系（表/视图）不存在。 */
export const PG_UNDEFINED_TABLE = "42P01";

/** 数据库错误的安全摘要：只含可公开的结构化信息，不含 SQL 文本与参数。 */
export type DatabaseErrorSummary = {
  /** 驱动错误码（如 23505 唯一约束冲突、42P01 表不存在）；未知时为 null。 */
  code: string | null;
  /** 约束名（如唯一索引名）；未知时为 null。 */
  constraint: string | null;
  /** 涉及的表名；未知时为 null。 */
  table: string | null;
  /**
   * 错误类名。注意 drizzle 的查询包装错误不设置 name，这里会是 "Error"；
   * 驱动原始错误（pg）通常为 "error"。仅作辅助信息，不用于判定。
   */
  name: string | null;
};

type ErrorLike = {
  name?: unknown;
  code?: unknown;
  constraint?: unknown;
  table?: unknown;
  cause?: unknown;
  /** drizzle DrizzleQueryError 的自有属性，用于识别包装层。 */
  query?: unknown;
  params?: unknown;
};

function asErrorLike(value: unknown): ErrorLike | null {
  return typeof value === "object" && value !== null
    ? (value as ErrorLike)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * 沿 cause 链收集错误对象，最外层在前。
 *
 * @param error 任意抛出值。
 * @param maxDepth 最大跟随层数，避免 cause 自引用导致死循环。
 */
function collectErrorChain(error: unknown, maxDepth = 8): ErrorLike[] {
  const chain: ErrorLike[] = [];
  const seen = new Set<unknown>();
  let current = asErrorLike(error);
  while (current && chain.length < maxDepth && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = asErrorLike(current.cause);
  }
  return chain;
}

/**
 * 提取数据库错误的安全摘要。
 *
 * @param error 任意抛出值（drizzle 包装错误、驱动原始错误或其他值）。
 * @returns 结构化摘要；取不到的字段为 null。绝不包含 SQL 文本或语句参数。
 */
export function summarizeDatabaseError(error: unknown): DatabaseErrorSummary {
  const chain = collectErrorChain(error);
  const summary: DatabaseErrorSummary = {
    code: null,
    constraint: null,
    table: null,
    name: null,
  };

  for (const link of chain) {
    summary.code ??= readString(link.code);
    summary.constraint ??= readString(link.constraint);
    summary.table ??= readString(link.table);
    summary.name ??= readString(link.name);
  }

  return summary;
}

/**
 * 判断是否为数据库层错误：带 PostgreSQL SQLSTATE，或为 drizzle 的查询包装错误。
 * 普通业务 code（如 QUOTA_EXCEEDED）不属于数据库错误，不能因此隐藏业务提示。
 *
 * WHY 不按 name 判断：drizzle-orm 0.45.2 的 DrizzleQueryError 构造器不设置 this.name
 * （见 drizzle-orm/errors.js），实例的 name 就是 "Error"。它可靠的特征是自有属性
 * query（SQL 文本）与 params（绑定参数数组），以及固定的 message 前缀；底层驱动错误
 * 没有 code 时（连接被对端关闭、取连接超时等）只能靠这些特征识别，否则会回退成
 * 原样返回 message，把 SQL 与明文参数写进日志。
 */
export function isDatabaseError(error: unknown): boolean {
  return collectErrorChain(error).some((link) => {
    if (
      typeof link.code === "string" &&
      /^(?:[0-9][0-9A-Z]|F0|HV|P0|XX)[0-9A-Z]{3}$/.test(link.code)
    ) {
      return true;
    }
    if (typeof link.query === "string" && Array.isArray(link.params)) {
      return true;
    }
    return (
      link instanceof Error && link.message.startsWith("Failed query:")
    );
  });
}

/**
 * 把错误转成可安全写入日志、管理端响应与监控的短描述。
 *
 * @param error 任意抛出值。
 * @returns 数据库错误返回 `DatabaseError(code=..., constraint=..., table=...)` 形式的
 *   摘要（取不到任何字段时只返回 `DatabaseError`）；其他错误返回原始 message
 *   （这些路径不含语句参数）。
 * @remarks 数据库错误绝不回显 message：drizzle 的 message 带 SQL 与全部参数，
 *   导入与同步路径的参数即明文令牌。
 */
export function describeErrorForLog(error: unknown): string {
  if (!isDatabaseError(error)) {
    return error instanceof Error ? error.message : String(error);
  }
  const summary = summarizeDatabaseError(error);
  const parts = [
    summary.code ? `code=${summary.code}` : null,
    summary.constraint ? `constraint=${summary.constraint}` : null,
    summary.table ? `table=${summary.table}` : null,
  ].filter((part): part is string => part !== null);
  // 固定用 DatabaseError 作前缀：drizzle 包装层的 name 是 "Error"、驱动是 "error"，
  // 都不具备区分价值，拼进去只会让日志更难读。
  return parts.length > 0
    ? `DatabaseError(${parts.join(", ")})`
    : "DatabaseError";
}

/**
 * 判断数据库错误是否带指定驱动错误码（沿 cause 链查找）。
 *
 * @param error 任意抛出值。
 * @param code PostgreSQL 错误码，如 PG_UNDEFINED_TABLE。
 * @remarks 不做消息子串匹配：drizzle 的消息含完整 SQL，子串判断会误判超时、
 *   锁等待与断连等完全不同的故障。
 */
export function hasDatabaseErrorCode(error: unknown, code: string): boolean {
  return collectErrorChain(error).some(
    (link) => readString(link.code) === code
  );
}
