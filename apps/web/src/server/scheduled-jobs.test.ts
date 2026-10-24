/**
 * 图片维护调度测试：锁定定时任务的全量调用语义，防止重新引入隐式批次上限。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  destroyExpiredGenerationPhotos: vi.fn(),
  destroyGenerationPhotosByMaxCount: vi.fn(),
  expireStalePendingGenerations: vi.fn(),
  getRuntimeSettingSelect: vi.fn(),
  invokeOperation: vi.fn().mockResolvedValue({ released: 0 }),
}));

vi.mock("@repo/shared/payment/upgrade-reservation-operations", () => ({}));
vi.mock("@/features/payment/epay-recovery-operation", () => ({}));
vi.mock("@/features/image-backend-pool/retention-operation", () => ({}));
vi.mock("@repo/shared/uol", () => ({ invokeOperation: mocks.invokeOperation }));

vi.mock("@repo/shared/credits/core", () => ({
  processExpiredBatches: vi.fn(),
}));

vi.mock("@repo/shared/generation-maintenance", () => ({
  destroyExpiredGenerationPhotos: mocks.destroyExpiredGenerationPhotos,
  destroyGenerationPhotosByMaxCount: mocks.destroyGenerationPhotosByMaxCount,
  expireStalePendingGenerations: mocks.expireStalePendingGenerations,
}));

vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingNumber: vi.fn(),
  getRuntimeSettingSelect: mocks.getRuntimeSettingSelect,
}));

vi.mock("@/features/image-backend-pool/service", () => ({
  refreshStaleWebBackendAccounts: vi.fn(),
  runAutoSub2ApiAccessTokenSync: vi.fn(),
}));

import { runImageMaintenanceJob } from "./scheduled-jobs";

const emptyCleanupResult = {
  enabled: true,
  destroyed: 0,
  failed: 0,
  storageObjectsDeleted: 0,
  details: [],
};

describe("runImageMaintenanceJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.expireStalePendingGenerations.mockResolvedValue([]);
    mocks.destroyExpiredGenerationPhotos.mockResolvedValue(emptyCleanupResult);
    mocks.destroyGenerationPhotosByMaxCount.mockResolvedValue(
      emptyCleanupResult
    );
  });

  it("runs time-based photo and pending maintenance without a row limit", async () => {
    mocks.getRuntimeSettingSelect.mockResolvedValue("time");

    await runImageMaintenanceJob();

    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "subscription.expireUpgradeReservations",
      { limit: 500 },
      { type: "cron", job: "images-maintenance" }
    );
    expect(mocks.destroyExpiredGenerationPhotos.mock.calls).toEqual([[]]);
    expect(mocks.expireStalePendingGenerations.mock.calls).toEqual([[]]);
    expect(mocks.destroyGenerationPhotosByMaxCount).not.toHaveBeenCalled();
  });

  it("runs max-count photo and pending maintenance without a row limit", async () => {
    mocks.getRuntimeSettingSelect.mockResolvedValue("count");

    await runImageMaintenanceJob();

    expect(mocks.destroyGenerationPhotosByMaxCount.mock.calls).toEqual([[]]);
    expect(mocks.expireStalePendingGenerations.mock.calls).toEqual([[]]);
    expect(mocks.destroyExpiredGenerationPhotos).not.toHaveBeenCalled();
  });
});
