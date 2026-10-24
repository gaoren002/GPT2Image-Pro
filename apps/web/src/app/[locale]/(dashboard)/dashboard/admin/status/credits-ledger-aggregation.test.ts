/** 全局状态页接线回归：24h/7d 两个窗口都必须复用已测试的过期核销条件。 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("admin status expiration write-off wiring", () => {
  it("filters both existing ledger windows without counting reservation transfers", () => {
    const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    expect(
      source.match(/creditExpirationWriteOffCondition\(creditsTransaction\)/g)
    ).toHaveLength(2);
    expect(source).not.toMatch(
      /creditsTransaction\.type\} = 'expiration' then/
    );
  });
});
