import "@/features/payment/epay-recovery-operation";
import "@repo/shared/payment/upgrade-reservation-operations";
import { processExpiredBatches } from "@repo/shared/credits/core";
import { describeErrorForLog } from "@repo/shared/db/error-summary";
import {
  destroyExpiredGenerationPhotos,
  destroyGenerationPhotosByMaxCount,
  expireStalePendingGenerations,
} from "@repo/shared/generation-maintenance";
import { logWarn } from "@repo/shared/logger";
import {
  getRuntimeSettingNumber,
  getRuntimeSettingSelect,
} from "@repo/shared/system-settings";
import { invokeOperation } from "@repo/shared/uol";

import {
  refreshStaleWebBackendAccounts,
  runAutoSub2ApiAccessTokenSync,
} from "@/features/image-backend-pool/service";
import "@/features/image-backend-pool/retention-operation";
import {
  buildCreditsExpireResponse,
  summarizeExpiredPendingGenerations,
} from "@/server/scheduled-jobs-response";

const MAINTENANCE_PRINCIPAL = {
  type: "cron",
  job: "images-maintenance",
} as const;

/**
 * 执行一个维护步骤并隔离失败。
 *
 * 图片维护的各恢复步骤彼此独立：单步抛错只记录脱敏摘要并继续执行后续步骤，
 * 避免某一步（例如操作未注册或准入被拒）挡住退款重放等资金恢复。调用方在全部
 * 步骤结束后汇总抛出，调度器仍按失败落盘。
 *
 * @returns 步骤结果；失败时返回 null 并把步骤名记入 failures
 */
async function runMaintenanceStep<T>(
  failures: string[],
  name: string,
  run: () => Promise<T>
): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    failures.push(name);
    logWarn("images-maintenance step failed", {
      step: name,
      error: describeErrorForLog(error),
    });
    return null;
  }
}

export async function runImageMaintenanceJob() {
  const failures: string[] = [];
  const step = <T>(name: string, run: () => Promise<T>) =>
    runMaintenanceStep(failures, name, run);

  // R05 到期任务先封闭执行，再持久投递 R11；绝不重发上游。
  const editableRecovery = await step("file.recoverTasks", () =>
    invokeOperation("file.recoverTasks", { limit: 100 }, MAINTENANCE_PRINCIPAL)
  );
  // 独立恢复已收款普通订单，lease 超时可重领；不依赖网关再次通知。
  const epayRecovery = await step("subscription.recoverEpayFulfillments", () =>
    invokeOperation(
      "subscription.recoverEpayFulfillments",
      { limit: 100 },
      MAINTENANCE_PRINCIPAL
    )
  );
  // 沿用现有五分钟维护节拍释放过期升级预留，财务事务独立于图片清理。
  await step("subscription.expireUpgradeReservations", () =>
    invokeOperation(
      "subscription.expireUpgradeReservations",
      { limit: 500 },
      MAINTENANCE_PRINCIPAL
    )
  );
  // 图片清理三态模式：off=不清理（永久保存，默认）；time=按时间过期；
  // count=按最大保留张数删最老图。互斥：每次维护只跑其中一种照片清理逻辑，
  // 避免两套逻辑重复处理同一行。模式取值与设置项 options 逐字一致。
  // 读取失败记为失败步骤并按 off 处理：本轮不清理照片，也不挡住后续资金恢复。
  const retentionMode =
    (await step("photoRetentionMode", () =>
      getRuntimeSettingSelect(
        "GENERATION_IMAGE_RETENTION_MODE",
        ["off", "time", "count"] as const,
        "off"
      )
    )) ?? "off";

  const [pendingResults, photoRetention] = await Promise.all([
    step("expireStalePendingGenerations", () =>
      expireStalePendingGenerations()
    ),
    step("photoRetention", async () => {
      if (retentionMode === "time") return destroyExpiredGenerationPhotos();
      if (retentionMode === "count") return destroyGenerationPhotosByMaxCount();
      return {
        enabled: false as const,
        destroyed: 0,
        failed: 0,
        storageObjectsDeleted: 0,
        details: [] as Array<{
          generationId: string;
          userId: string;
          storageObjectsDeleted: number;
        }>,
      };
    }),
  ]);

  // 超时终态已提交后再补偿/重放，退款失败不依赖 pending 下次仍被扫描。
  const refundRecovery = await step("image-generation.retryRefunds", () =>
    invokeOperation(
      "image-generation.retryRefunds",
      { limit: 100 },
      MAINTENANCE_PRINCIPAL
    )
  );
  // 清理置于资金恢复之后；每条 SQL 有固定批量预算，不持有任务级长事务。
  const backendRetention = await step(
    "image-backend-pool.cleanupRetention",
    () =>
      invokeOperation(
        "image-backend-pool.cleanupRetention",
        {},
        MAINTENANCE_PRINCIPAL
      )
  );

  if (failures.length > 0) {
    throw Object.assign(
      new Error(`images-maintenance steps failed: ${failures.join(", ")}`),
      { code: "maintenance_steps_failed", failedSteps: failures }
    );
  }

  const pending = pendingResults ?? [];
  return {
    success: true,
    editableRecovery,
    refundRecovery,
    backendRetention,
    epayRecovery,
    ...summarizeExpiredPendingGenerations(pending),
    details: pending,
    retentionMode,
    photoRetention,
    timestamp: new Date().toISOString(),
  };
}

export async function runCreditsExpireJob() {
  await invokeOperation(
    "subscription.expireUpgradeReservations",
    { limit: 500 },
    { type: "cron", job: "credits-expire" }
  );
  const results = await processExpiredBatches();

  return {
    ...buildCreditsExpireResponse(results),
    timestamp: new Date().toISOString(),
  };
}

export async function runWebAccountsRefreshJob() {
  const staleMinutes = await getRuntimeSettingNumber(
    "CHATGPT_WEB_ACCOUNT_REFRESH_STALE_MINUTES",
    30,
    { positive: true }
  );
  const limit = await getRuntimeSettingNumber(
    "CHATGPT_WEB_ACCOUNT_REFRESH_LIMIT",
    20,
    { positive: true }
  );
  const result = await refreshStaleWebBackendAccounts({
    staleMinutes,
    limit,
  });

  return {
    success: true,
    ...result,
    timestamp: new Date().toISOString(),
  };
}

export async function runSub2ApiSyncJob(options?: { force?: boolean }) {
  const result = await runAutoSub2ApiAccessTokenSync(options);
  return {
    ...result,
    timestamp: new Date().toISOString(),
  };
}
