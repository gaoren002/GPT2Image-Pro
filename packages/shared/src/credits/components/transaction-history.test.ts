/** R08 流水实际渲染回归：保留真实组件和中英文文案，仅替换服务端动作数据。 */
import { readFileSync } from "node:fs";
import { type AbstractIntlMessages, NextIntlClientProvider } from "next-intl";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  transactions: [] as Record<string, unknown>[],
}));
vi.mock("../actions", () => ({ getMyTransactions: () => {} }));
vi.mock("next-safe-action/hooks", () => ({
  useAction: () => ({
    execute: () => {},
    isPending: false,
    result: {
      data: {
        transactions: state.transactions,
        totalCount: state.transactions.length,
      },
    },
  }),
}));

import { TransactionHistory } from "./transaction-history";

/** 与服务端预留 ledger 相同的财务字段；不含生成内容或真实用户数据。 */
function transaction(
  debitAccount: string,
  creditAccount: string,
  type = "expiration"
) {
  return {
    id: "row",
    type,
    amount: 100,
    debitAccount,
    creditAccount,
    description: "订阅升级预留结算",
    metadata: { reason: "subscription_upgrade_reservation" },
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
}
/** 真正加载应用语言包，避免测试只返回翻译键而掩盖漏译。 */
function render(locale: "zh" | "en") {
  const messages = JSON.parse(
    readFileSync(
      new URL(
        `../../../../../apps/web/messages/${locale}.json`,
        import.meta.url
      ),
      "utf8"
    )
  ) as AbstractIntlMessages;
  // React 会把第三个参数注入 children，Provider 的必填 children 类型不能从该参数推导。
  return renderToStaticMarkup(
    createElement(
      NextIntlClientProvider,
      { locale, messages, timeZone: "UTC" } as Parameters<
        typeof NextIntlClientProvider
      >[0],
      createElement(TransactionHistory, { timeZone: "UTC" })
    )
  );
}
describe("upgrade reservation transaction rendering", () => {
  it.each([
    "zh",
    "en",
  ] as const)("does not debit a reservation settlement again (%s)", (locale) => {
    state.transactions = [
      transaction("RESERVATION:order", "SYSTEM:subscription_upgrade"),
    ];
    const html = render(locale);
    expect(html).not.toContain("-100");
    expect(html).toContain(locale === "zh" ? "折抵结算" : "Upgrade settlement");
    expect(html).not.toContain(
      locale === "zh" ? "积分已过期" : "Credits expired"
    );
  });
  it.each([
    "zh",
    "en",
  ] as const)("labels wallet hold and actual release instead of expiry/refund (%s)", (locale) => {
    state.transactions = [transaction("WALLET:user", "RESERVATION:order")];
    const held = render(locale);
    expect(held).toContain("-100");
    expect(held).toContain(locale === "zh" ? "折抵预留" : "Upgrade hold");
    state.transactions = [
      transaction("RESERVATION:order", "WALLET:user", "refund"),
    ];
    const released = render(locale);
    expect(released).toContain("+100");
    expect(released).toContain(locale === "zh" ? "预留释放" : "Hold released");
  });
});

describe.each([
  "zh",
  "en",
] as const)("remaining reservation flow translations: %s", (locale) => {
  it.each([
    [
      "WALLET:user",
      "REFUND:order",
      "expiration",
      "退款权益冻结",
      "Refund hold",
      "-100",
    ],
    [
      "REFUND:order",
      "SYSTEM:subscription_refund",
      "expiration",
      "退款结算",
      "Refund settlement",
      "0",
    ],
    [
      "SYSTEM:subscription_upgrade",
      "WALLET:user",
      "refund",
      "旧积分返还",
      "Old credits restored",
      "+100",
    ],
    [
      "RESERVATION:order",
      "SYSTEM:expired",
      "expiration",
      "预留积分到期",
      "Held credits expired",
      "0",
    ],
  ])("renders %s -> %s accurately", (debit, credit, type, zh, en, amount) => {
    state.transactions = [transaction(debit, credit, type)];
    const html = render(locale);
    expect(html).toContain(locale === "zh" ? zh : en);
    const displayedAmount = html.match(
      /<div class="col-span-2 text-right font-medium [^"]+"[^>]*>(.*?)<\/div>/
    )?.[1];
    expect(displayedAmount).toBe(amount);
    if (amount === "0")
      expect(html).toContain(
        locale === "zh" ? "钱包无变动" : "No wallet change"
      );
  });
});
