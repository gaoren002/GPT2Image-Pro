/** UOL 输入/权限与财务快照隔离回归，不加载数据库。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invokeOperation } from "../uol/invoke";

const mocks = vi.hoisted(() => ({
  reserve: vi.fn(),
  cancel: vi.fn(),
  expire: vi.fn(),
  prepareRefund: vi.fn(),
  confirmRefund: vi.fn(),
  purchase: vi.fn(),
}));
vi.mock("./upgrade-reservation", () => ({ upgradeReservations: mocks }));
vi.mock("./epay", () => ({ createRuntimeEpayPurchase: mocks.purchase }));

import {
  cancelUpgrade,
  confirmUpgradeRefund,
  expireUpgrades,
  prepareUpgradeRefund,
  reserveUpgrade,
} from "./upgrade-reservation-operations";

const context = { requestId: "test", assertOwnership: () => {} };
beforeEach(() => {
  vi.clearAllMocks();
});
describe("upgrade UOL contract", () => {
  it("takes ownership only from principal and strips untrusted financial metadata", async () => {
    const input = reserveUpgrade.input.parse({
      targetPriceId: "pro",
      clientRequestId: "r",
      userId: "attacker",
      metadata: { targetCredits: 999999 },
      expiresAt: "2099",
    });
    mocks.reserve.mockResolvedValue({
      payable: true,
      reservation: {
        outTradeNo: "server-order",
        expiresAt: new Date("2026-01-01"),
        snapshot: { targetPriceId: "pro", quote: { amountDue: 30 } },
      },
    });
    mocks.purchase.mockResolvedValue({
      url: "https://example.invalid/pay",
      params: {},
    });
    await reserveUpgrade.execute(
      input,
      { type: "user", userId: "owner", role: "user" },
      context
    );
    expect(mocks.reserve).toHaveBeenCalledWith({
      targetPriceId: "pro",
      clientRequestId: "r",
      userId: "owner",
    });
    expect(mocks.purchase).toHaveBeenCalledWith({
      outTradeNo: "server-order",
      name: "GPT2IMAGE upgrade pro",
      money: 30,
    });
  });
  it("does not cancel a reused hold if checkout signing fails", async () => {
    mocks.reserve.mockResolvedValue({
      payable: true,
      reservation: {
        outTradeNo: "same",
        expiresAt: new Date(),
        snapshot: { targetPriceId: "pro", quote: { amountDue: 30 } },
      },
    });
    mocks.purchase.mockRejectedValue(new Error("signing failure"));
    await expect(
      reserveUpgrade.execute(
        { targetPriceId: "pro", clientRequestId: "r" },
        { type: "user", userId: "u", role: "user" },
        context
      )
    ).rejects.toThrow("signing failure");
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it("requires protected checkout/cancel, cron cleanup and super administrator refunds", () => {
    expect(reserveUpgrade.access.kind).toBe("protected");
    expect(cancelUpgrade.access.kind).toBe("protected");
    expect(expireUpgrades.access.kind).toBe("cron");
    expect(prepareUpgradeRefund.access.kind).toBe("superAdmin");
    expect(confirmUpgradeRefund.access.kind).toBe("superAdmin");
    expect(reserveUpgrade.idempotency).toMatchObject({
      kind: "required",
      keyField: "clientRequestId",
    });
    expect(confirmUpgradeRefund.idempotency).toMatchObject({
      kind: "required",
      keyField: "refundRef",
    });
  });
});

describe.each([
  {
    name: "subscription.prepareUpgradeRefund",
    input: { outTradeNo: "paid-order" },
    method: mocks.prepareRefund,
    output: { amount: 30, state: "refund_pending" },
  },
  {
    name: "subscription.confirmUpgradeRefund",
    input: { outTradeNo: "paid-order", refundRef: "receipt", amount: 30 },
    method: mocks.confirmRefund,
    output: { state: "refunded" },
  },
])("upgrade refund gateway access: $name", ({
  name,
  input,
  method,
  output,
}) => {
  it.each([
    "observer_admin",
    "admin",
  ] as const)("rejects %s before touching financial services", async (role) => {
    method.mockResolvedValue(output);
    await expect(
      invokeOperation(name, input, { type: "user", userId: "actor", role })
    ).rejects.toMatchObject({ code: "forbidden", httpStatus: 403 });
    expect(method).not.toHaveBeenCalled();
  });
  it("allows super_admin to invoke the financial operation", async () => {
    method.mockResolvedValue(output);
    await expect(
      invokeOperation(name, input, {
        type: "user",
        userId: "super",
        role: "super_admin",
      })
    ).resolves.toEqual(output);
    expect(method).toHaveBeenCalledTimes(1);
  });
});
