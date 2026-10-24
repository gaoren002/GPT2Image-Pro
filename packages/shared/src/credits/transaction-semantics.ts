/**
 * 积分流水纯语义：供用户流水与过期报表共享升级预留流转规则。
 * 不读取数据库/配置，不按 expiration/refund 类型推断钱包方向。
 */
export const UPGRADE_RESERVATION_REASON = "subscription_upgrade_reservation";
export type LedgerAccountMatch =
  | { readonly prefix: string }
  | { readonly exact: string };
type UpgradeLedgerRule = {
  readonly kind: string;
  readonly type: "expiration" | "refund";
  readonly debit: LedgerAccountMatch;
  readonly credit: LedgerAccountMatch;
  readonly excludeFromExpiration: boolean;
};
/** reason 与账户路径必须同时命中；不把普通退款、到期和历史升级核销误判为预留。 */
export const UPGRADE_RESERVATION_LEDGER_RULES = [
  {
    kind: "upgrade_hold",
    type: "expiration",
    debit: { prefix: "WALLET:" },
    credit: { prefix: "RESERVATION:" },
    excludeFromExpiration: true,
  },
  {
    kind: "upgrade_release",
    type: "refund",
    debit: { prefix: "RESERVATION:" },
    credit: { prefix: "WALLET:" },
    excludeFromExpiration: false,
  },
  {
    kind: "upgrade_settlement",
    type: "expiration",
    debit: { prefix: "RESERVATION:" },
    credit: { exact: "SYSTEM:subscription_upgrade" },
    excludeFromExpiration: true,
  },
  {
    kind: "upgrade_expiration",
    type: "expiration",
    debit: { prefix: "RESERVATION:" },
    credit: { exact: "SYSTEM:expired" },
    excludeFromExpiration: false,
  },
  {
    kind: "upgrade_refund_hold",
    type: "expiration",
    debit: { prefix: "WALLET:" },
    credit: { prefix: "REFUND:" },
    excludeFromExpiration: true,
  },
  {
    kind: "upgrade_refund_settlement",
    type: "expiration",
    debit: { prefix: "REFUND:" },
    credit: { exact: "SYSTEM:subscription_refund" },
    excludeFromExpiration: true,
  },
  {
    kind: "upgrade_refund_restore",
    type: "refund",
    debit: { exact: "SYSTEM:subscription_upgrade" },
    credit: { prefix: "WALLET:" },
    excludeFromExpiration: false,
  },
] as const satisfies readonly UpgradeLedgerRule[];
export type UpgradeReservationLedgerKind =
  (typeof UPGRADE_RESERVATION_LEDGER_RULES)[number]["kind"];
export type CreditLedgerTransaction = {
  type: string;
  amount: number;
  debitAccount: string;
  creditAccount: string;
  metadata?: Record<string, unknown> | null;
};
/** 精确系统账户与命名空间账户使用不同匹配规则，避免宽松子串误识别。 */
function matchesAccount(account: string, match: LedgerAccountMatch): boolean {
  return "exact" in match
    ? account === match.exact
    : account.startsWith(match.prefix);
}
/** 返回展示语义和实际钱包变动；非钱包账户间流转为零，真正到期仍可核销预留资产。 */
export function getCreditTransactionSemantics(
  transaction: CreditLedgerTransaction
) {
  const rule =
    transaction.metadata?.reason === UPGRADE_RESERVATION_REASON
      ? UPGRADE_RESERVATION_LEDGER_RULES.find(
          (candidate) =>
            candidate.type === transaction.type &&
            matchesAccount(transaction.debitAccount, candidate.debit) &&
            matchesAccount(transaction.creditAccount, candidate.credit)
        )
      : undefined;
  const amount = Number.isFinite(transaction.amount) ? transaction.amount : 0;
  const walletDebit = transaction.debitAccount.startsWith("WALLET:")
    ? amount
    : 0;
  const walletCredit = transaction.creditAccount.startsWith("WALLET:")
    ? amount
    : 0;
  return {
    reservationKind: rule?.kind ?? null,
    walletDelta: walletCredit - walletDebit,
    isExpirationWriteOff:
      transaction.type === "expiration" && !rule?.excludeFromExpiration,
  };
}
