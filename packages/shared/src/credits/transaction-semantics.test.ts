/** R08 流水与报表口径回归；纯规则加实际 SQL 聚合，不连接项目数据库。 */
import { createRequire } from "node:module";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  type CreditLedgerTransaction,
  getCreditTransactionSemantics,
  UPGRADE_RESERVATION_REASON,
} from "./transaction-semantics";
import { creditExpirationWriteOffCondition } from "./transaction-semantics-sql";

/** CI 与生产使用 Node22；仅使用内存 SQLite 执行与 PG 兼容的 CASE/LIKE/JSON 片段，不替代 PG 锁验收。 */
interface MemorySqlite {
  exec(query: string): void;
  prepare(query: string): {
    run(...values: unknown[]): unknown;
    get(bindings: Record<string, string>): Record<string, unknown> | undefined;
  };
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (location: string) => MemorySqlite;
};
/** 仿照真实预留 ledger 的账户方向和 reason。 */
function tx(
  debitAccount: string,
  creditAccount: string,
  type = "expiration",
  amount = 100
): CreditLedgerTransaction {
  return {
    debitAccount,
    creditAccount,
    type,
    amount,
    metadata: { reason: UPGRADE_RESERVATION_REASON },
  };
}
const hold = tx("WALLET:u", "RESERVATION:order");
const settlement = tx("RESERVATION:order", "SYSTEM:subscription_upgrade");
const released = tx("RESERVATION:order", "WALLET:u", "refund");
const expired = tx("RESERVATION:order", "SYSTEM:expired");
const refundHold = tx("WALLET:u", "REFUND:order");
const refundSettlement = tx("REFUND:order", "SYSTEM:subscription_refund");
const restored = tx("SYSTEM:subscription_upgrade", "WALLET:u", "refund");

/** 编译生产报表使用的真实 Drizzle 条件后执行聚合，专门检验 NULL、OR 和账户路径过滤。 */
function reportedExpiration(rows: CreditLedgerTransaction[]): number {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA case_sensitive_like = ON");
    database.exec(
      "CREATE TABLE ledger(type TEXT, amount NUMERIC, debit_account TEXT, credit_account TEXT, metadata TEXT)"
    );
    const insert = database.prepare(
      "INSERT INTO ledger VALUES (?, ?, ?, ?, ?)"
    );
    for (const row of rows)
      insert.run(
        row.type,
        row.amount,
        row.debitAccount,
        row.creditAccount,
        row.metadata ? JSON.stringify(row.metadata) : null
      );
    const condition = creditExpirationWriteOffCondition({
      type: sql.raw("type"),
      debitAccount: sql.raw("debit_account"),
      creditAccount: sql.raw("credit_account"),
      metadata: sql.raw("metadata"),
    });
    const query = new PgDialect().sqlToQuery(
      sql`SELECT COALESCE(SUM(CASE WHEN ${condition} THEN amount ELSE 0 END), 0) AS total FROM ledger`
    );
    const bindings = Object.fromEntries(
      query.params.map((value, index) => [`$${index + 1}`, String(value)])
    );
    return Number(database.prepare(query.sql).get(bindings)?.total);
  } finally {
    database.close();
  }
}

describe("credit transaction wallet semantics", () => {
  it.each([
    [hold, "upgrade_hold", -100],
    [released, "upgrade_release", 100],
    [settlement, "upgrade_settlement", 0],
    [expired, "upgrade_expiration", 0],
    [refundHold, "upgrade_refund_hold", -100],
    [refundSettlement, "upgrade_refund_settlement", 0],
    [restored, "upgrade_refund_restore", 100],
  ] as const)("recognizes %j as %s with wallet delta %i", (row, kind, walletDelta) => {
    expect(getCreditTransactionSemantics(row)).toMatchObject({
      reservationKind: kind,
      walletDelta,
    });
  });
  it("requires both reason and account path to recognize reservation entries", () => {
    expect(
      getCreditTransactionSemantics({ ...hold, metadata: null }).reservationKind
    ).toBeNull();
    expect(
      getCreditTransactionSemantics({
        ...hold,
        metadata: { reason: "unrelated" },
      }).reservationKind
    ).toBeNull();
    expect(
      getCreditTransactionSemantics(tx("WALLET:u", "SERVICE:image"))
        .reservationKind
    ).toBeNull();
    expect(
      getCreditTransactionSemantics(tx("WALLET_LIKE:u", "RESERVATION:order"))
        .reservationKind
    ).toBeNull();
  });
  it("uses real wallet direction even if the legacy type suggests income", () => {
    expect(
      getCreditTransactionSemantics(tx("WALLET:u", "SERVICE:refund", "refund"))
        .walletDelta
    ).toBe(-100);
    expect(
      getCreditTransactionSemantics(
        tx("SYSTEM:source", "WALLET:u", "expiration")
      ).walletDelta
    ).toBe(100);
    expect(
      getCreditTransactionSemantics(tx("WALLET:u", "WALLET:u")).walletDelta
    ).toBe(0);
  });
  it("keeps ordinary purchase, consumption and expiry semantics", () => {
    expect(
      getCreditTransactionSemantics({
        ...tx("PAYMENT:order", "WALLET:u", "purchase"),
        metadata: null,
      }).walletDelta
    ).toBe(100);
    expect(
      getCreditTransactionSemantics({
        ...tx("WALLET:u", "SYSTEM:expired"),
        metadata: null,
      })
    ).toMatchObject({ walletDelta: -100, isExpirationWriteOff: true });
    expect(
      getCreditTransactionSemantics(
        tx("WALLET:u", "SERVICE:image", "consumption")
      ).walletDelta
    ).toBe(-100);
  });
});
describe("expiration aggregation excludes reservation transfers", () => {
  it("does not report hold100 plus settle100 as expired200", () => {
    expect(reportedExpiration([hold, settlement])).toBe(0);
    expect(
      [hold, settlement].filter(
        (row) => getCreditTransactionSemantics(row).isExpirationWriteOff
      )
    ).toEqual([]);
  });
  it("counts real expiry of held assets once without a second wallet debit", () => {
    expect(reportedExpiration([hold, expired])).toBe(100);
    expect(
      [hold, expired].reduce(
        (sum, row) => sum + getCreditTransactionSemantics(row).walletDelta,
        0
      )
    ).toBe(-100);
  });
  it("excludes refund freeze/settle while preserving actual ordinary expiry", () => {
    const ordinary = {
      ...tx("WALLET:u", "SYSTEM:expired", "expiration", 25),
      metadata: null,
    };
    expect(
      reportedExpiration([
        hold,
        settlement,
        refundHold,
        refundSettlement,
        ordinary,
      ])
    ).toBe(25);
  });
  it("does not lose ordinary NULL/missing metadata rows or unrelated transfers", () => {
    const rows = [
      { ...tx("WALLET:u", "SYSTEM:expired", "expiration", 10), metadata: null },
      { ...tx("WALLET:u", "SYSTEM:expired", "expiration", 5), metadata: {} },
      { ...hold, amount: 7, metadata: { reason: "unrelated" } },
      tx("WALLET:u", "SYSTEM:other", "expiration", 3),
    ];
    expect(reportedExpiration(rows)).toBe(25);
  });
  it("never counts releases/restoration as expiry even when they involve reservation assets", () => {
    expect(reportedExpiration([released, restored])).toBe(0);
  });
});
