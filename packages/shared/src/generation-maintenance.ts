/** 图片维护与专用退款入口；退款意图由持久 outbox 恢复，金额真相仍在 credits 账本。 */
import { db } from "@repo/database";
import { generation, generationRefundOutbox } from "@repo/database/schema";
import { and, asc, desc, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import {
  enqueueGenerationRefund,
  processGenerationRefundOutbox,
  submitGenerationRefund,
} from "./generation-refund-outbox";
import {
  getFailedGenerationTargetCreditsFromMetadata,
  isInitialChargeUnconfirmed,
} from "./generation-settlement";
import { logError, logWarn } from "./logger";
import { describeErrorForLog, isDatabaseError } from "./db/error-summary";
import { z } from "zod";
import { defineOperation } from "./uol/registry";
import { getStorageProvider } from "./storage/providers";
import { getRuntimeSettingNumber } from "./system-settings";
import {
  generationCompletionRecovery,
  repairGenerationCompletion,
  withoutReadyGenerationCompletion,
  recoverGenerationCompletionRefunds,
} from "./generation-completion";
export {
  prepareGenerationCompletion,
  publishGenerationCompletion,
  claimGenerationCompletionFailure,
  readGenerationNetCredits,
  readGenerationCompletionState,
  withoutReadyGenerationCompletion,
  readGenerationCompletionRefundPlan,
} from "./generation-completion";

// PG 验收及内部维护从既有公开包入口访问，无需改共享 package.json 的 exports。
export { enqueueGenerationRefund, processGenerationRefundOutbox };

export const IMAGE_GENERATION_PENDING_TIMEOUT_MS = 20 * 60 * 1000;
const FAILED_GENERATION_REFUND_SOURCE_SUFFIX = ":failed-recovery-refund";

/**
 * 失败任务退款回填只覆盖此刻之后创建的任务（新退款路径的生产上线时刻）。
 *
 * 旧版退款流水只在 metadata.sourceRef 里带任务 ID，没有 metadata.generationId；R10 按
 * 任务 ID 汇总的账本净额看不到这些退款，会把旧版已退过、只保留审核费的失败任务当作
 * 仍在扣费，再按 creditsConsumed 退一次（2026-10-25 上线首轮实测重复退回审核费）。
 * 更早的失败任务已由旧版结算，若需补偿须按账本审计单独处理，不能用本回填。
 */
export const FAILED_GENERATION_RECOVERY_SINCE = new Date(
  "2026-10-25T01:51:00.000Z"
);

// 超时文案/选择器抽到 db-free 的 ./generation-timeout（纯分类器 sla-classification
// 也要用，不能经本模块的 `import { db }` 把数据库连接拖进纯路径）。本模块 pending 清扫
// 用 resolveImageGenerationTimeoutError，同时重导出以保持
// `@repo/shared/generation-maintenance` 的既有公开面不变。
import { resolveImageGenerationTimeoutError } from "./generation-timeout";

export {
  IMAGE_GENERATION_TIMEOUT_ERROR,
  IMAGE_GENERATION_WEB_TIMEOUT_ERROR,
  resolveImageGenerationTimeoutError,
} from "./generation-timeout";
export const GENERATION_IMAGE_RETENTION_HOURS_SETTING_KEY =
  "GENERATION_IMAGE_RETENTION_HOURS";
export const GENERATION_IMAGE_RETENTION_MODE_SETTING_KEY =
  "GENERATION_IMAGE_RETENTION_MODE";
export const GENERATION_IMAGE_MAX_COUNT_SETTING_KEY =
  "GENERATION_IMAGE_MAX_COUNT";
export const GENERATION_IMAGE_MAX_COUNT_DEFAULT = 10000;

type ExpireStalePendingGenerationsOptions = {
  userId?: string;
  now?: Date;
  limit?: number;
  timeoutMs?: number;
};

type DestroyExpiredGenerationPhotosOptions = {
  now?: Date;
  limit?: number;
  retentionHours?: number;
};

type DestroyGenerationPhotosByMaxCountOptions = {
  now?: Date;
  limit?: number;
  maxCount?: number;
};

export type GenerationImageStorageReference = {
  bucket: string;
  key: string;
};

type LimitableRowsQuery<Row> = PromiseLike<Row[]> & {
  limit: (limit: number) => PromiseLike<Row[]>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getGenerationBucket(bucket?: string | null) {
  return (
    bucket || process.env.NEXT_PUBLIC_GENERATIONS_BUCKET_NAME || "generations"
  );
}

/**
 * 执行可选限量的维护查询；省略 limit 时直接执行原查询，不生成 SQL LIMIT。
 *
 * 调度任务依赖省略 limit 实现全量维护；页面等延迟敏感路径仍可显式传入上限。
 */
export async function executeMaintenanceQuery<Row>(
  query: LimitableRowsQuery<Row>,
  limit?: number
) {
  return await (limit === undefined ? query : query.limit(limit));
}

/**
 * 计算超时退款金额（纯函数，DB-free）。
 *
 * 退款 = max(0, 已扣 - 目标保留)。Math.max(0) 防止 target>charged 时退成负数（多退）。
 * sourceRef 由调用方按 `${genId}:timeout-refund` 拼接做幂等键，避免重复退款。
 */
export function computeTimeoutRefund(params: {
  chargedCredits: number;
  targetCredits: number;
}) {
  const chargedCredits = Math.max(0, params.chargedCredits);
  const targetCredits = Math.max(0, params.targetCredits);
  return Math.max(0, chargedCredits - targetCredits);
}

/**
 * 解析照片保留窗口（纯函数，DB-free）。
 *
 * retentionHours<=0（默认 0=永久保留）短路返回 {enabled:false, cutoff:null}，
 * 是阻止全站已完成图片被批量删除的唯一防线；否则 cutoff=now-retentionHours 小时。
 */
export function resolvePhotoRetentionWindow(
  retentionHours: number,
  now: Date
): { enabled: boolean; cutoff: Date | null } {
  if (retentionHours <= 0) {
    return { enabled: false, cutoff: null };
  }
  return {
    enabled: true,
    cutoff: new Date(now.getTime() - retentionHours * 60 * 60 * 1000),
  };
}

/**
 * 解析按张数保留是否启用（纯函数，DB-free）。
 *
 * maxCount<=0 或非有限数短路返回 {enabled:false}，是阻止"保留 0 张=删光全站"的
 * 运行层护栏（写入层 min:1 之外的二次设防），与 resolvePhotoRetentionWindow 的
 * <=0 短路设计对齐。启用时回传归一化后的整数阈值（向下取整，避免小数 OFFSET）。
 */
export function resolveMaxCountRetention(maxCount: number): {
  enabled: boolean;
  maxCount: number;
} {
  if (!Number.isFinite(maxCount) || maxCount <= 0) {
    return { enabled: false, maxCount: 0 };
  }
  return { enabled: true, maxCount: Math.floor(maxCount) };
}

/**
 * 判断一次系统设置写入后是否应立即触发"按最大张数"清理（纯函数，DB-free）。
 *
 * 单点判定，供所有写设置入口（server action 与 UOL operation）共用，保证"启用即执行"
 * 行为在不同传输路径上一致。条件：本次提交确实变更了清理模式键，且其新值为 "count"。
 * changedKeys 来自 setSystemSettings 返回（本次实际写/删的键）；newModeValue 是该键的
 * 新值，清空（回退默认）时调用方应传 undefined，使其不被误判为启用。
 */
export function shouldRunMaxCountCleanupOnSettingsChange(
  changedKeys: readonly string[],
  newModeValue: unknown
): boolean {
  return (
    changedKeys.includes(GENERATION_IMAGE_RETENTION_MODE_SETTING_KEY) &&
    newModeValue === "count"
  );
}

export function collectGenerationImageStorageReferences(params: {
  storageKey?: string | null;
  storageBucket?: string | null;
  metadata?: Record<string, unknown> | null;
}): GenerationImageStorageReference[] {
  const defaultBucket = getGenerationBucket(params.storageBucket);
  const refs = new Map<string, GenerationImageStorageReference>();
  const addReference = (key: unknown, bucketValue?: unknown) => {
    const storageKey = stringValue(key);
    if (!storageKey) return;
    const bucket = stringValue(bucketValue) || defaultBucket;
    refs.set(`${bucket}:${storageKey}`, { bucket, key: storageKey });
  };

  addReference(params.storageKey);

  const outputImage = isRecord(params.metadata?.outputImage)
    ? params.metadata.outputImage
    : null;
  const outputs = Array.isArray(outputImage?.imageOutputs)
    ? outputImage.imageOutputs
    : [];
  for (const output of outputs) {
    if (!isRecord(output)) continue;
    addReference(output.storageKey, output.storageBucket);
  }

  const inputImages = isRecord(params.metadata?.inputImages)
    ? params.metadata.inputImages
    : null;
  const images = Array.isArray(inputImages?.images) ? inputImages.images : [];
  for (const image of images) {
    if (!isRecord(image)) continue;
    addReference(image.storageKey, image.storageBucket);
  }

  return Array.from(refs.values());
}

export function stripDestroyedGenerationImageReferences(
  metadata: Record<string, unknown> | null | undefined,
  params: {
    destroyedAt: string;
    retentionHours: number;
    storageObjectsDeleted: number;
  }
) {
  const nextMetadata = isRecord(metadata) ? { ...metadata } : {};
  const outputImage = isRecord(nextMetadata.outputImage)
    ? { ...nextMetadata.outputImage }
    : {};

  if (Array.isArray(outputImage.imageOutputs)) {
    outputImage.imageOutputs = outputImage.imageOutputs.map((output) => {
      if (!isRecord(output)) return output;
      const nextOutput = { ...output };
      delete nextOutput.storageKey;
      delete nextOutput.imageUrl;
      delete nextOutput.imageFileId;
      delete nextOutput.webImageMessageId;
      delete nextOutput.webImageGroupId;
      return nextOutput;
    });
  }

  outputImage.photoRetention = {
    destroyedAt: params.destroyedAt,
    retentionHours: params.retentionHours,
    storageObjectsDeleted: params.storageObjectsDeleted,
  };
  nextMetadata.outputImage = outputImage;

  const inputImages = isRecord(nextMetadata.inputImages)
    ? { ...nextMetadata.inputImages }
    : null;
  if (inputImages) {
    if (Array.isArray(inputImages.images)) {
      inputImages.images = inputImages.images.map((image) => {
        if (!isRecord(image)) return image;
        const nextImage = { ...image };
        delete nextImage.storageKey;
        delete nextImage.storageBucket;
        delete nextImage.imageUrl;
        return nextImage;
      });
    }
    inputImages.photoRetention = {
      destroyedAt: params.destroyedAt,
      retentionHours: params.retentionHours,
      storageObjectsDeleted: params.storageObjectsDeleted,
    };
    nextMetadata.inputImages = inputImages;
  }

  const responseOutput = isRecord(nextMetadata.responseOutput)
    ? { ...nextMetadata.responseOutput }
    : null;
  if (responseOutput && Array.isArray(responseOutput.agentEvents)) {
    responseOutput.agentEvents = responseOutput.agentEvents.map((event) => {
      if (!isRecord(event)) return event;
      const nextEvent = { ...event };
      delete nextEvent.imageUrl;
      return nextEvent;
    });
    nextMetadata.responseOutput = responseOutput;
  }

  return nextMetadata;
}

/**
 * 专用生成退款：先持久化财务意图，再同事务封顶/退 Key。兼容调用方描述和元数据参数，
 * 但不向 outbox 或账本转存任意私密内容。targetCredits 由明确结算目标传入。
 */
export async function refundGenerationCredits(params: {
  generationId: string;
  userId: string;
  amount: number;
  sourceRef: string;
  description: string;
  metadata?: Record<string, unknown>;
  targetCredits?: number;
}) {
  return submitGenerationRefund({
    generationId: params.generationId,
    userId: params.userId,
    amount: params.amount,
    sourceRef: params.sourceRef,
    targetCredits:
      params.targetCredits ??
      (typeof params.metadata?.targetCredits === "number"
        ? params.metadata.targetCredits
        : undefined),
  });
}

/**
 * 补偿终态→enqueue 间退出的 failed 任务，只按终态恢复意图是否缺失筛选；只扫描
 * FAILED_GENERATION_RECOVERY_SINCE 之后创建的任务，旧版任务的账本不足以安全回填。
 * 旧 phase 的意图不代表本次终态已结算；终态意图存在后由 worker 重试，避免反复回填。
 * 只投影结算所需财务标量，最终仍由 R10 在锁内按净扣费与目标费用封顶。
 */
export async function recoverFailedGenerationRefunds(
  options: { limit?: number } = {}
) {
  const completionRecovery = await recoverGenerationCompletionRefunds(options);
  const limit = z
    .number()
    .int()
    .min(1)
    .max(500)
    .parse(options.limit ?? 100);
  const rows = await db
    .select({
      id: generation.id,
      userId: generation.userId,
      creditsConsumed: generation.creditsConsumed,
      metadata: sql<Record<string, unknown>>`jsonb_build_object(
      'moderationFailureCredits', ${generation.metadata}::jsonb->'moderationFailureCredits',
      'billingMultiplier', ${generation.metadata}::jsonb->'billingMultiplier',
      'creditCost', jsonb_build_object(
        'moderationOnlyCredits', ${generation.metadata}::jsonb->'creditCost'->'moderationOnlyCredits',
        'moderationCredits', ${generation.metadata}::jsonb->'creditCost'->'moderationCredits'),
      'targetCredits', COALESCE(${generation.metadata}::jsonb->'timeout'->'targetCredits', ${generation.metadata}::jsonb->'settlement'->'targetCredits'))`,
    })
    .from(generation)
    .where(
      and(
        eq(generation.status, "failed"),
        // 旧版退款流水不带 generationId，账本净额不可信，见 FAILED_GENERATION_RECOVERY_SINCE。
        gte(generation.createdAt, FAILED_GENERATION_RECOVERY_SINCE),
        sql`COALESCE(${generation.metadata}::jsonb->'asyncCompletion'->>'version', '') <> '1'`,
        // 无法证明费用目标的旧行继续留在 failed/账本待审计，不创建虚假的已结算意图。
        sql`(jsonb_typeof(COALESCE(${generation.metadata}::jsonb->'timeout'->'targetCredits',
          ${generation.metadata}::jsonb->'settlement'->'targetCredits')) = 'number'
          OR jsonb_typeof(${generation.metadata}::jsonb->'moderationFailureCredits') = 'number')`,
        sql`NOT EXISTS (SELECT 1 FROM ${generationRefundOutbox}
      WHERE ${generationRefundOutbox.userId} = ${generation.userId}
        AND ${generationRefundOutbox.generationId} = ${generation.id}
        AND ${generationRefundOutbox.sourceRef} = (${generation.id} || ${FAILED_GENERATION_REFUND_SOURCE_SUFFIX}))`
      )
    )
    .orderBy(asc(generation.createdAt), asc(generation.id))
    .limit(limit);
  let enqueued = completionRecovery.enqueued;
  let recoveryFailed = completionRecovery.recoveryFailed;
  for (const row of rows) {
    if (
      generationCompletionRecovery(row.metadata, Number(row.creditsConsumed))
        .isCompletion
    )
      continue;
    try {
      const chargedCredits = Math.max(0, Number(row.creditsConsumed) || 0);
      const target = row.metadata?.targetCredits;
      const explicitTarget =
        typeof target === "number" && Number.isFinite(target) && target >= 0;
      // 历史 failed 未记录具体失败原因，审核拦截与生成失败可能收费不同。
      // 不能把较高的合法审核费退掉；没有明确目标时先按保守上界补偿，差额留待账本审计。
      // 不用已降低的 creditsConsumed 裁剪策略目标，否则自己的投影更新会改变 phase 参数。
      const metadata = row.metadata;
      const policyCharge = Number.MAX_SAFE_INTEGER;
      const targetCredits = explicitTarget
        ? target
        : Math.max(
            getFailedGenerationTargetCreditsFromMetadata({
              reason: "generation_error",
              chargedCredits: policyCharge,
              metadata,
            }),
            getFailedGenerationTargetCreditsFromMetadata({
              reason: "moderation_block",
              chargedCredits: policyCharge,
              metadata,
            })
          );
      await enqueueGenerationRefund({
        userId: row.userId,
        generationId: row.id,
        sourceRef: `${row.id}${FAILED_GENERATION_REFUND_SOURCE_SUFFIX}`,
        amount: chargedCredits,
        targetCredits,
      });
      enqueued += 1;
    } catch (error) {
      recoveryFailed += 1;
      logWarn("Failed generation refund recovery requires retry", {
        generationId: row.id,
        errorSummary: isDatabaseError(error)
          ? describeErrorForLog(error)
          : "refund_recovery_failed",
      });
    }
  }
  return { enqueued, recoveryFailed };
}

/** 图片维护复用的退款恢复入口；先补偿无意图终态，再投递到期意图。 */
export async function retryGenerationRefunds(
  options: { now?: Date; limit?: number } = {}
) {
  let recovered = { enqueued: 0, recoveryFailed: 0 };
  try {
    recovered = await recoverFailedGenerationRefunds(options);
  } catch (error) {
    // 存量扫描故障也不能阻断独立的已持久意图；1 表示整批回填失败，金额不丢弃。
    recovered.recoveryFailed = 1;
    logWarn("Failed generation refund recovery scan failed", {
      errorSummary: isDatabaseError(error)
        ? describeErrorForLog(error)
        : "refund_recovery_failed",
    });
  }
  return { ...recovered, ...(await processGenerationRefundOutbox(options)) };
}

/** cron 专用退款恢复操作；自然幂等，单个资金事务在 R10 内完成。 */
export const retryGenerationRefundsOperation = defineOperation({
  name: "image-generation.retryRefunds",
  domain: "credits",
  title: "Retry Generation Refunds",
  description: "补偿失败生成并恢复持久退款意图",
  input: z.object({ limit: z.number().int().min(1).max(500).default(100) }),
  output: z.object({
    enqueued: z.number(),
    recoveryFailed: z.number(),
    attempted: z.number(),
    settled: z.number(),
    failed: z.number(),
    creditsRefunded: z.number(),
  }),
  access: { kind: "cron" },
  readOnly: false,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: ["billing"],
  execute: (input) => retryGenerationRefunds(input),
});

export async function expireStalePendingGenerations(
  options: ExpireStalePendingGenerationsOptions = {}
) {
  const now = options.now ?? new Date();
  const timeoutMs = options.timeoutMs ?? IMAGE_GENERATION_PENDING_TIMEOUT_MS;
  const cutoff = new Date(now.getTime() - timeoutMs);
  const conditions = [
    eq(generation.status, "pending" as const),
    lt(generation.createdAt, cutoff),
  ];

  if (options.userId) {
    conditions.push(eq(generation.userId, options.userId));
  }

  const staleRowsQuery = db
    .select({
      id: generation.id,
      userId: generation.userId,
      creditsConsumed: generation.creditsConsumed,
      metadata: generation.metadata,
      createdAt: generation.createdAt,
    })
    .from(generation)
    .where(and(...conditions))
    .orderBy(desc(generation.createdAt));
  // 后台维护不传 limit 时全量收敛；用户请求路径仍可显式传入小批次上限，
  // 避免一次页面读取承担全站 pending 维护成本。
  const staleRows = await executeMaintenanceQuery(
    staleRowsQuery,
    options.limit
  );

  const results: Array<{
    generationId: string;
    userId: string;
    creditsRefunded: number;
    refundGranted: boolean;
    remainingDebited: number | null;
  }> = [];

  for (const row of staleRows) {
    const chargedCredits = Math.max(0, Number(row.creditsConsumed) || 0);
    const completion = generationCompletionRecovery(
      row.metadata,
      chargedCredits
    );
    if (completion.ready) {
      try {
        await repairGenerationCompletion(row.userId, row.id);
      } catch {
        logWarn("Image completion projection pending repair", {
          generationId: row.id,
          source: "generation-maintenance",
        });
      }
      continue;
    }
    // 首笔扣费结果未知的任务从未开工，按 0 结算；其余沿用生成失败的目标。
    const targetCredits = isInitialChargeUnconfirmed(row.metadata)
      ? 0
      : getFailedGenerationTargetCreditsFromMetadata({
          reason: "generation_error",
          chargedCredits,
          metadata: row.metadata,
        });
    const creditsToRefund = computeTimeoutRefund({
      chargedCredits: completion.maxRefundAmount,
      targetCredits,
    });
    const sourceRef = `${row.id}:timeout-refund`;
    // 命中后端从 metadata.backend 取（Web 账号超时补"疑似审核"提示并归 moderation）。
    const backendMeta =
      isRecord(row.metadata) &&
      isRecord((row.metadata as Record<string, unknown>).backend)
        ? ((row.metadata as Record<string, unknown>).backend as {
            type?: string | null;
            accountBackend?: string | null;
          })
        : null;

    const [updated] = await db
      .update(generation)
      .set({
        status: "failed",
        error: resolveImageGenerationTimeoutError(backendMeta),
        completedAt: now,
        metadata: sql`COALESCE(${generation.metadata}, '{}'::json)::jsonb || ${JSON.stringify(
          {
            timeout: {
              reason: "pending_timeout",
              timeoutMs,
              expiredAt: now.toISOString(),
              targetCredits,
              refundSourceRef: sourceRef,
              requestedRefundCredits: creditsToRefund,
            },
          }
        )}::jsonb`,
      })
      .where(
        and(
          eq(generation.id, row.id),
          eq(generation.status, "pending" as const),
          withoutReadyGenerationCompletion()
        )
      )
      .returning({ id: generation.id });

    if (!updated) continue;

    let refundGranted = false;
    let creditsRefunded = 0;
    let remainingDebited: number | null = null;
    try {
      const refund = await refundGenerationCredits({
        generationId: row.id,
        userId: row.userId,
        amount: creditsToRefund,
        sourceRef,
        description: "Refund timed out image generation charge",
        targetCredits,
        metadata: {
          reason: "pending_timeout",
          createdAt: row.createdAt.toISOString(),
          expiredAt: now.toISOString(),
          timeoutMs,
        },
      });
      refundGranted = refund.refunded;
      creditsRefunded = refund.amount;
      remainingDebited = refund.remainingDebited;

      await db
        .update(generation)
        .set({
          creditsConsumed: sql`LEAST(${generation.creditsConsumed}, ${refund.remainingDebited})`,
          metadata: sql`COALESCE(${generation.metadata}, '{}'::json)::jsonb || ${JSON.stringify(
            {
              timeoutRefund: {
                sourceRef,
                requestedCredits: creditsToRefund,
                creditsRefunded: refund.amount,
                remainingDebited: refund.remainingDebited,
                granted: refund.refunded,
                settledAt: now.toISOString(),
              },
            }
          )}::jsonb`,
        })
        .where(eq(generation.id, row.id));
    } catch (error) {
      logWarn("Image generation timeout refund pending retry", {
        errorSummary: isDatabaseError(error)
          ? describeErrorForLog(error)
          : "refund_pending_retry",
        source: "image-generation-timeout-refund",
        generationId: row.id,
        userId: row.userId,
        creditsToRefund,
      });
    }

    results.push({
      generationId: row.id,
      userId: row.userId,
      creditsRefunded,
      refundGranted,
      remainingDebited,
    });
  }

  return results;
}

export async function destroyExpiredGenerationPhotos(
  options: DestroyExpiredGenerationPhotosOptions = {}
) {
  const now = options.now ?? new Date();
  const retentionHours =
    options.retentionHours ??
    (await getRuntimeSettingNumber(
      GENERATION_IMAGE_RETENTION_HOURS_SETTING_KEY,
      0,
      { nonNegative: true }
    ));

  const window = resolvePhotoRetentionWindow(retentionHours, now);
  if (!window.enabled || !window.cutoff) {
    return {
      enabled: false,
      retentionHours,
      cutoff: null,
      destroyed: 0,
      failed: 0,
      storageObjectsDeleted: 0,
      details: [] as Array<{
        generationId: string;
        userId: string;
        storageObjectsDeleted: number;
      }>,
    };
  }

  const cutoff = window.cutoff;
  const rowsQuery = db
    .select({
      id: generation.id,
      userId: generation.userId,
      storageKey: generation.storageKey,
      storageBucket: generation.storageBucket,
      metadata: generation.metadata,
      completedAt: generation.completedAt,
      createdAt: generation.createdAt,
    })
    .from(generation)
    .where(
      and(
        eq(generation.status, "completed" as const),
        isNotNull(generation.storageKey),
        sql`COALESCE(${generation.completedAt}, ${generation.createdAt}) < ${cutoff}`
      )
    )
    .orderBy(desc(generation.completedAt));
  // limit 仅作为调用方主动选择的小批次护栏；省略时处理全部过期记录。
  const rows = await executeMaintenanceQuery(rowsQuery, options.limit);

  const details: Array<{
    generationId: string;
    userId: string;
    storageObjectsDeleted: number;
  }> = [];
  let failed = 0;
  let storageObjectsDeleted = 0;
  const storage = rows.length > 0 ? await getStorageProvider() : null;

  for (const row of rows) {
    const refs = collectGenerationImageStorageReferences(row);
    if (refs.length === 0) continue;

    try {
      for (const ref of refs) {
        await storage?.deleteObject(ref.key, ref.bucket);
      }

      const destroyedAt = now.toISOString();
      const [updated] = await db
        .update(generation)
        .set({
          storageKey: null,
          fileSize: null,
          metadata: stripDestroyedGenerationImageReferences(row.metadata, {
            destroyedAt,
            retentionHours,
            storageObjectsDeleted: refs.length,
          }),
        })
        .where(
          and(
            eq(generation.id, row.id),
            eq(generation.status, "completed" as const),
            isNotNull(generation.storageKey)
          )
        )
        .returning({ id: generation.id });

      if (!updated) continue;

      storageObjectsDeleted += refs.length;
      details.push({
        generationId: row.id,
        userId: row.userId,
        storageObjectsDeleted: refs.length,
      });
    } catch (error) {
      failed += 1;
      logError(error, {
        source: "generation-photo-retention",
        generationId: row.id,
        userId: row.userId,
        retentionHours,
      });
    }
  }

  return {
    enabled: true,
    retentionHours,
    cutoff: cutoff.toISOString(),
    destroyed: details.length,
    failed,
    storageObjectsDeleted,
    details,
  };
}

/**
 * 按"每用户最大保留张数"清理：每个用户各自保留最新的 maxCount 张可展示图，
 * 删除该用户更老的图片文件。阈值是 per-user 的，不是全站。
 *
 * 与 destroyExpiredGenerationPhotos 同语义地"只删图、不删行"：删存储对象后把
 * generation 行的 storageKey/fileSize 置空并在 metadata 记审计，画廊/历史的
 * isNotNull(storageKey) 过滤会自动隐藏；绝不删 generation 行、不动 creditsConsumed。
 *
 * 口径 = status='completed' AND storageKey IS NOT NULL 的行；按 user_id 分区、
 * COALESCE(completedAt, createdAt) DESC（最新在前，desc(id) 作确定性次级键）排名，
 * 删每个用户排名 > maxCount 的行（该用户超出额度的更老图）；不足额度的用户零删除。
 * 默认不设 LIMIT，一次查询全部超额行；调用方显式传 limit 时才缩小处理范围。
 *
 * 收敛性：成功处理的行会把 storageKey 置空并退出排名集；若个别对象删除失败，
 * 后续调度会继续重试，最终单调收敛到"每个用户恰好保留最新 maxCount 张"。
 *
 * 短路防线：maxCount<=0 或非有限数经 resolveMaxCountRetention 返回 enabled:false，
 * 直接零结果返回，不查库、不删文件。
 */
export async function destroyGenerationPhotosByMaxCount(
  options: DestroyGenerationPhotosByMaxCountOptions = {}
) {
  const now = options.now ?? new Date();
  const maxCount =
    options.maxCount ??
    (await getRuntimeSettingNumber(
      GENERATION_IMAGE_MAX_COUNT_SETTING_KEY,
      GENERATION_IMAGE_MAX_COUNT_DEFAULT,
      { positive: true }
    ));

  const guard = resolveMaxCountRetention(maxCount);
  if (!guard.enabled) {
    return {
      enabled: false,
      maxCount: guard.maxCount,
      destroyed: 0,
      failed: 0,
      storageObjectsDeleted: 0,
      details: [] as Array<{
        generationId: string;
        userId: string;
        storageObjectsDeleted: number;
      }>,
    };
  }

  // 每用户保留：按 user_id 分区、COALESCE(completedAt,createdAt) DESC（最新在前，
  // desc(id) 为确定性次级键）用 row_number 排名，取每个用户排名 > maxCount 的行
  // （该用户超出额度的更老图）。多数用户不足额度则零删除。删后这些行 storageKey
  // 置空退出排名集，下批重排继续，逐批单调收敛。
  const orderExpr = sql`COALESCE(${generation.completedAt}, ${generation.createdAt})`;
  const ranked = db.$with("ranked").as(
    db
      .select({
        id: generation.id,
        userId: generation.userId,
        storageKey: generation.storageKey,
        storageBucket: generation.storageBucket,
        metadata: generation.metadata,
        rn: sql<number>`row_number() over (partition by ${generation.userId} order by ${orderExpr} desc, ${generation.id} desc)`.as(
          "rn"
        ),
      })
      .from(generation)
      .where(
        and(
          eq(generation.status, "completed" as const),
          isNotNull(generation.storageKey)
        )
      )
  );
  const rowsQuery = db
    .with(ranked)
    .select({
      id: ranked.id,
      userId: ranked.userId,
      storageKey: ranked.storageKey,
      storageBucket: ranked.storageBucket,
      metadata: ranked.metadata,
    })
    .from(ranked)
    .where(sql`${ranked.rn} > ${guard.maxCount}`);
  // limit 仅作为调用方主动选择的小批次护栏；省略时处理全部超额记录。
  const rows = await executeMaintenanceQuery(rowsQuery, options.limit);

  const details: Array<{
    generationId: string;
    userId: string;
    storageObjectsDeleted: number;
  }> = [];
  let failed = 0;
  let storageObjectsDeleted = 0;
  const storage = rows.length > 0 ? await getStorageProvider() : null;

  for (const row of rows) {
    const refs = collectGenerationImageStorageReferences(row);
    if (refs.length === 0) continue;

    try {
      for (const ref of refs) {
        await storage?.deleteObject(ref.key, ref.bucket);
      }

      const destroyedAt = now.toISOString();
      const [updated] = await db
        .update(generation)
        .set({
          storageKey: null,
          fileSize: null,
          // retentionHours 在张数模式下无对应窗口，审计字段填 0 仅表"此次销毁"，
          // 真正语义由 destroyedAt + storageObjectsDeleted 表达。
          metadata: stripDestroyedGenerationImageReferences(row.metadata, {
            destroyedAt,
            retentionHours: 0,
            storageObjectsDeleted: refs.length,
          }),
        })
        .where(
          and(
            eq(generation.id, row.id),
            eq(generation.status, "completed" as const),
            isNotNull(generation.storageKey)
          )
        )
        .returning({ id: generation.id });

      if (!updated) continue;

      storageObjectsDeleted += refs.length;
      details.push({
        generationId: row.id,
        userId: row.userId,
        storageObjectsDeleted: refs.length,
      });
    } catch (error) {
      failed += 1;
      logError(error, {
        source: "generation-photo-max-count",
        generationId: row.id,
        userId: row.userId,
        maxCount: guard.maxCount,
      });
    }
  }

  return {
    enabled: true,
    maxCount: guard.maxCount,
    destroyed: details.length,
    failed,
    storageObjectsDeleted,
    details,
  };
}
