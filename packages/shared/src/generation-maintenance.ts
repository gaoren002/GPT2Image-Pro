import { db } from "@repo/database";
import { creditsTransaction, generation } from "@repo/database/schema";
import { and, desc, eq, isNotNull, lt, sql } from "drizzle-orm";
import { grantCredits } from "./credits/core";
import { getFailedGenerationTargetCreditsFromMetadata } from "./generation-settlement";
import { logError } from "./logger";
import { getStorageProvider } from "./storage/providers";
import { getRuntimeSettingNumber } from "./system-settings";

export const IMAGE_GENERATION_PENDING_TIMEOUT_MS = 20 * 60 * 1000;

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
 * 退款幂等查重:按 credits_transaction(type='refund', source_ref) 判断。
 *
 * WHY 交易表而非批次表:财务真相在双重记账的 credits_transaction;且退款
 * 批次已改为按用户合并入单条"退款池批次"(source_ref 为 NULL,见
 * grantCredits 的 refund 分支),新退款不再有自己的批次行,按批次查重会
 * 永远 miss 导致重复退款。交易行每笔退款一条,幂等语义不受合并影响。
 */
async function refundAlreadyGranted(userId: string, sourceRef: string) {
  const [existing] = await db
    .select({ id: creditsTransaction.id })
    .from(creditsTransaction)
    .where(
      and(
        eq(creditsTransaction.userId, userId),
        eq(creditsTransaction.type, "refund"),
        eq(creditsTransaction.sourceRef, sourceRef)
      )
    )
    .limit(1);

  return Boolean(existing);
}

export async function refundGenerationCredits(params: {
  generationId: string;
  userId: string;
  amount: number;
  sourceRef: string;
  description: string;
  metadata?: Record<string, unknown>;
}) {
  if (params.amount <= 0) {
    return { refunded: false, amount: 0 };
  }

  if (await refundAlreadyGranted(params.userId, params.sourceRef)) {
    return { refunded: false, amount: params.amount };
  }

  await grantCredits({
    userId: params.userId,
    amount: params.amount,
    sourceType: "refund",
    debitAccount: "SYSTEM:generation_refund",
    transactionType: "refund",
    sourceRef: params.sourceRef,
    description: params.description,
    metadata: {
      generationId: params.generationId,
      ...params.metadata,
    },
  });

  return { refunded: true, amount: params.amount };
}

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
      prompt: generation.prompt,
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
  }> = [];

  for (const row of staleRows) {
    const chargedCredits = Math.max(0, Number(row.creditsConsumed) || 0);
    const targetCredits = getFailedGenerationTargetCreditsFromMetadata({
      reason: "generation_error",
      chargedCredits,
      metadata: row.metadata,
    });
    const creditsToRefund = computeTimeoutRefund({
      chargedCredits,
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
              refundCredits: creditsToRefund,
            },
          }
        )}::jsonb`,
      })
      .where(
        and(
          eq(generation.id, row.id),
          eq(generation.status, "pending" as const)
        )
      )
      .returning({ id: generation.id });

    if (!updated) continue;

    let refundGranted = false;
    if (creditsToRefund > 0) {
      try {
        const refund = await refundGenerationCredits({
          generationId: row.id,
          userId: row.userId,
          amount: creditsToRefund,
          sourceRef,
          description: `Refund timed out image generation charge: ${row.prompt.slice(
            0,
            50
          )}`,
          metadata: {
            reason: "pending_timeout",
            createdAt: row.createdAt.toISOString(),
            expiredAt: now.toISOString(),
            timeoutMs,
          },
        });
        refundGranted = refund.refunded;

        await db
          .update(generation)
          .set({
            creditsConsumed: targetCredits,
            metadata: sql`COALESCE(${generation.metadata}, '{}'::json)::jsonb || ${JSON.stringify(
              {
                timeoutRefund: {
                  sourceRef,
                  creditsRefunded: creditsToRefund,
                  granted: refund.refunded,
                  settledAt: now.toISOString(),
                },
              }
            )}::jsonb`,
          })
          .where(eq(generation.id, row.id));
      } catch (error) {
        logError(error, {
          source: "image-generation-timeout-refund",
          generationId: row.id,
          userId: row.userId,
          creditsToRefund,
        });
      }
    }

    results.push({
      generationId: row.id,
      userId: row.userId,
      creditsRefunded: refundGranted ? creditsToRefund : 0,
      refundGranted,
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
