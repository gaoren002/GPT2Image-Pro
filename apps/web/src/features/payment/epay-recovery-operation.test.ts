/** 普通支付恢复权限：真实 UOL 网关在加载任何财务执行代码前拒绝用户身份。 */
import { invokeOperation } from "@repo/shared/uol";
import { beforeEach, expect, it, vi } from "vitest";

const recover = vi.hoisted(() =>
  vi.fn(async () => ({ scanned: 1, fulfilled: 1, failed: 0 }))
);
vi.mock("./epay-fulfillment", () => ({ recoverEpayFulfillments: recover }));

import "./epay-recovery-operation";

beforeEach(() => vi.clearAllMocks());
it.each([
  "user",
  "admin",
  "super_admin",
] as const)("%s 不能执行全站收款恢复", async (role) => {
  await expect(
    invokeOperation(
      "subscription.recoverEpayFulfillments",
      { limit: 100 },
      { type: "user", userId: "u", role }
    )
  ).rejects.toMatchObject({ code: "forbidden", httpStatus: 403 });
  expect(recover).not.toHaveBeenCalled();
});
it("cron 有界执行恢复，输入越界先拒绝", async () => {
  const principal = { type: "cron", job: "images-maintenance" } as const;
  await expect(
    invokeOperation(
      "subscription.recoverEpayFulfillments",
      { limit: 501 },
      principal
    )
  ).rejects.toMatchObject({ code: "validation_error" });
  expect(recover).not.toHaveBeenCalled();
  expect(
    await invokeOperation(
      "subscription.recoverEpayFulfillments",
      { limit: 100 },
      principal
    )
  ).toEqual({ scanned: 1, fulfilled: 1, failed: 0 });
  expect(recover).toHaveBeenCalledWith(100);
});
