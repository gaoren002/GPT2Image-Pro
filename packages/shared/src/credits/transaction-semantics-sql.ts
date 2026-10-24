/** 过期报表的纯 SQL 构造器：复用展示规则，不加载数据库，普通 NULL metadata 不被过滤。 */
import { type SQL, type SQLWrapper, sql } from "drizzle-orm";
import {
  type LedgerAccountMatch,
  UPGRADE_RESERVATION_LEDGER_RULES,
  UPGRADE_RESERVATION_REASON,
} from "./transaction-semantics";

/** 按统一账户规则构造参数化谓词；所有账户模式均来自代码常量。 */
function matchAccount(column: SQLWrapper, match: LedgerAccountMatch): SQL {
  return "exact" in match
    ? sql`${column} = ${match.exact}`
    : sql`${column} LIKE ${`${match.prefix}%`}`;
}
/** 只排除已识别的预留/结算/退款冻结；RESERVATION 到 SYSTEM:expired 仍计核销。 */
export function creditExpirationWriteOffCondition(columns: {
  type: SQLWrapper;
  debitAccount: SQLWrapper;
  creditAccount: SQLWrapper;
  metadata: SQLWrapper;
}): SQL {
  const excluded = UPGRADE_RESERVATION_LEDGER_RULES.filter(
    (rule) => rule.type === "expiration" && rule.excludeFromExpiration
  ).map(
    (rule) =>
      sql`(${matchAccount(columns.debitAccount, rule.debit)} AND ${matchAccount(columns.creditAccount, rule.credit)})`
  );
  return sql`(${columns.type} = 'expiration' AND NOT (
    COALESCE(${columns.metadata}->>'reason', '') = ${UPGRADE_RESERVATION_REASON}
    AND (${sql.join(excluded, sql` OR `)})
  ))`;
}
