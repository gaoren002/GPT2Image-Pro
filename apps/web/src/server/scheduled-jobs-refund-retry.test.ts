/** R11 images-maintenance 接线：保留 hold expiry，先扫描终态再调用退款恢复操作。 */
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => ({ settled: 1 })),
  expire: vi.fn(async () => []),
}));
vi.mock("@repo/shared/payment/upgrade-reservation-operations", () => ({}));
vi.mock("@/features/payment/epay-recovery-operation", () => ({}));
vi.mock("@/features/image-backend-pool/retention-operation", () => ({}));
vi.mock("@repo/shared/uol", () => ({ invokeOperation: mocks.invoke }));
vi.mock("@repo/shared/credits/core", () => ({
  processExpiredBatches: vi.fn(),
}));
vi.mock("@repo/shared/generation-maintenance", () => ({
  expireStalePendingGenerations: mocks.expire,
  destroyExpiredGenerationPhotos: vi.fn(),
  destroyGenerationPhotosByMaxCount: vi.fn(),
}));
vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingSelect: vi.fn(async () => "off"),
  getRuntimeSettingNumber: vi.fn(),
}));
vi.mock("@/features/image-backend-pool/service", () => ({
  refreshStaleWebBackendAccounts: vi.fn(),
  runAutoSub2ApiAccessTokenSync: vi.fn(),
}));

import { runImageMaintenanceJob } from "./scheduled-jobs";

it("images-maintenance 保留升级预留释放并执行退款恢复", async () => {
  const result = await runImageMaintenanceJob();
  expect(mocks.invoke.mock.calls).toEqual([
    [
      "subscription.recoverEpayFulfillments",
      { limit: 100 },
      { type: "cron", job: "images-maintenance" },
    ],
    [
      "subscription.expireUpgradeReservations",
      { limit: 500 },
      { type: "cron", job: "images-maintenance" },
    ],
    [
      "image-generation.retryRefunds",
      { limit: 100 },
      { type: "cron", job: "images-maintenance" },
    ],
    [
      "image-backend-pool.cleanupRetention",
      {},
      { type: "cron", job: "images-maintenance" },
    ],
  ]);
  expect(mocks.expire.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.invoke.mock.invocationCallOrder[2] ?? 0
  );
  expect(result.refundRecovery).toEqual({ settled: 1 });
});
