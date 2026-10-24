import "@/features/payment/epay-recovery-operation";
import "@repo/shared/payment/upgrade-reservation-operations";
import { processExpiredBatches } from "@repo/shared/credits/core";
import {
  destroyExpiredGenerationPhotos,
  destroyGenerationPhotosByMaxCount,
  expireStalePendingGenerations,
} from "@repo/shared/generation-maintenance";
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

export async function runImageMaintenanceJob() {
  // R05 到期任务先封闭执行，再持久投递 R11；绝不重发上游。
  const editableRecovery = await invokeOperation(
    "file.recoverTasks",
    { limit: 100 },
    { type: "cron", job: "images-maintenance" }
  );
  // 独立恢复已收款普通订单，lease 超时可重领；不依赖网关再次通知。
  const epayRecovery = await invokeOperation(
    "subscription.recoverEpayFulfillments",
    { limit: 100 },
    { type: "cron", job: "images-maintenance" }
  );
  // 沿用现有五分钟维护节拍释放过期升级预留，财务事务独立于图片清理。
  await invokeOperation(
    "subscription.expireUpgradeReservations",
    { limit: 500 },
    { type: "cron", job: "images-maintenance" }
  );
  // 图片清理三态模式：off=不清理（永久保存，默认）；time=按时间过期；
  // count=按最大保留张数删最老图。互斥：每次维护只跑其中一种照片清理逻辑，
  // 避免两套逻辑重复处理同一行。模式取值与设置项 options 逐字一致。
  const retentionMode = await getRuntimeSettingSelect(
    "GENERATION_IMAGE_RETENTION_MODE",
    ["off", "time", "count"] as const,
    "off"
  );

  const photoRetentionTask =
    retentionMode === "time"
      ? destroyExpiredGenerationPhotos()
      : retentionMode === "count"
        ? destroyGenerationPhotosByMaxCount()
        : Promise.resolve({
            enabled: false as const,
            destroyed: 0,
            failed: 0,
            storageObjectsDeleted: 0,
            details: [] as Array<{
              generationId: string;
              userId: string;
              storageObjectsDeleted: number;
            }>,
          });

  const [pendingResults, photoRetention] = await Promise.all([
    expireStalePendingGenerations(),
    photoRetentionTask,
  ]);

  // 超时终态已提交后再补偿/重放，退款失败不依赖 pending 下次仍被扫描。
  const refundRecovery = await invokeOperation(
    "image-generation.retryRefunds",
    { limit: 100 },
    { type: "cron", job: "images-maintenance" }
  );
  // 清理置于资金恢复之后；每条 SQL 有固定批量预算，不持有任务级长事务。
  const backendRetention = await invokeOperation(
    "image-backend-pool.cleanupRetention",
    {},
    { type: "cron", job: "images-maintenance" }
  );

  return {
    success: true,
    editableRecovery,
    refundRecovery,
    backendRetention,
    epayRecovery,
    ...summarizeExpiredPendingGenerations(pendingResults),
    details: pendingResults,
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
