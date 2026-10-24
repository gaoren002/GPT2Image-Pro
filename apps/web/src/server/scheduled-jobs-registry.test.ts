/**
 * images-maintenance 的真实注册表接线：使用真实 UOL 注册表、准入规则与 invokeOperation，
 * 只把各操作的执行体换成替身（bindExecute 遇到未注册操作会直接抛错），验证维护任务以
 * cron 身份能走完全部步骤，且单步失败不会挡住后续的资金恢复。数据库访问一律拒绝。
 */
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  db: new Proxy(
    {},
    {
      get: () => {
        throw new Error("database must not be used in this wiring test");
      },
    }
  ),
}));
vi.mock("@repo/shared/generation-maintenance", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@repo/shared/generation-maintenance")
  >()),
  expireStalePendingGenerations: vi.fn(async () => []),
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

import {
  destroyExpiredGenerationPhotos,
  destroyGenerationPhotosByMaxCount,
} from "@repo/shared/generation-maintenance";
import { getRuntimeSettingSelect } from "@repo/shared/system-settings";
import { bindExecute } from "@repo/shared/uol";
import { runImageMaintenanceJob } from "./scheduled-jobs";

/** images-maintenance 依次经 UOL 网关调用的操作。 */
const MAINTENANCE_OPERATIONS = [
  "file.recoverTasks",
  "subscription.recoverEpayFulfillments",
  "subscription.expireUpgradeReservations",
  "image-generation.retryRefunds",
  "image-backend-pool.cleanupRetention",
] as const;

const executions = new Map<string, ReturnType<typeof vi.fn>>();

beforeEach(() => {
  executions.clear();
  for (const name of MAINTENANCE_OPERATIONS) {
    const execute = vi.fn(async () => ({ stub: name }));
    executions.set(name, execute);
    bindExecute(name, execute);
  }
});

it("全部维护操作都在定时任务模块中注册，并接受 cron 身份", async () => {
  const result = await runImageMaintenanceJob();
  expect(result.success).toBe(true);
  for (const name of MAINTENANCE_OPERATIONS) {
    expect(executions.get(name), name).toHaveBeenCalledTimes(1);
    expect(executions.get(name)?.mock.calls[0]?.[1]).toEqual({
      type: "cron",
      job: "images-maintenance",
    });
  }
});

it("单步失败时仍执行后续资金恢复，最后汇总抛出失败步骤", async () => {
  bindExecute("subscription.expireUpgradeReservations", async () => {
    throw new Error("synthetic reservation expiry failure");
  });
  const failure = await runImageMaintenanceJob().catch((error) => error);
  expect(failure).toMatchObject({
    code: "maintenance_steps_failed",
    failedSteps: ["subscription.expireUpgradeReservations"],
  });
  expect(executions.get("image-generation.retryRefunds")).toHaveBeenCalledTimes(
    1
  );
  expect(
    executions.get("image-backend-pool.cleanupRetention")
  ).toHaveBeenCalledTimes(1);
});

it("照片保留模式读取失败时本轮不清理照片，其余维护操作照常执行", async () => {
  vi.mocked(getRuntimeSettingSelect).mockRejectedValueOnce(
    new Error("synthetic settings failure")
  );
  const failure = await runImageMaintenanceJob().catch((error) => error);
  expect(failure).toMatchObject({
    code: "maintenance_steps_failed",
    failedSteps: ["photoRetentionMode"],
  });
  expect(destroyExpiredGenerationPhotos).not.toHaveBeenCalled();
  expect(destroyGenerationPhotosByMaxCount).not.toHaveBeenCalled();
  for (const name of MAINTENANCE_OPERATIONS) {
    expect(executions.get(name), name).toHaveBeenCalledTimes(1);
  }
});
