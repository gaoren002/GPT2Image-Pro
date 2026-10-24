/** R08 入口契约回归：确保优惠下单和回调不能绕过预留事务。 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (name: string) =>
  readFileSync(new URL(name, import.meta.url), "utf8");
describe("R08 reservation wiring", () => {
  it("routes upgrade checkout through a transactional reservation", () => {
    expect(read("./actions.ts")).toContain("subscription.reserveUpgrade");
  });
  it("settles upgrades before the legacy claim/grant path", () => {
    const source = read("./epay-fulfillment.ts");
    expect(source).toContain("settleUpgradePayment");
    expect(source).not.toContain("voidActiveSubscriptionCreditsForUpgrade");
  });
});
