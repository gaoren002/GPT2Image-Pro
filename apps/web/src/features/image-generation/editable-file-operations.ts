/**
 * PPT/PSD 编排，供 v1 handler、UOL 与前端调用：同事务幂等扣固定费与 Key → 上游 → 存储。
 * 财务真相使用 credits 账本；失败经 generation 专用退款原子退回钱包与原消费 Key。
 * 只有上游生成失败可以换号，本地财务、存储与取消失败不进入重试循环。
 * 无持久任务状态时，已消费的任务只拒绝重放；崩溃恢复与结果重取由后续任务层处理。
 */
import { createHash } from "node:crypto";
import { db } from "@repo/database";
import { creditsTransaction } from "@repo/database/schema";
import { consumeCredits } from "@repo/shared/credits/core";
import { refundGenerationCredits } from "@repo/shared/generation-maintenance";
import { logWarn } from "@repo/shared/logger";
import { getStorageProvider } from "@repo/shared/storage/providers";
import { buildSignedStorageImageUrl } from "@repo/shared/storage/signed-url";
import {
  getRuntimeSettingNumber,
  getRuntimeSettingString,
} from "@repo/shared/system-settings";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  ImageBackendPoolUnavailableError,
  releaseImageBackendInflightLease,
  reportImageBackendResult,
  resolveImageBackendPoolConfig,
} from "@/features/image-backend-pool/service";
import {
  type EditableFileBinary,
  type EditableFileKind,
  type EditableFileResult,
  generateFileWithChatGptWeb,
} from "./chatgpt-web";
import {
  decodeBase64DataUrl,
  editableFileExtension,
  editableFileServiceName,
  NO_WEB_ACCOUNT_ERROR,
} from "./editable-file-util";
import type { ImageInputFile } from "./types";

const DEFAULT_EDITABLE_CREDITS = 25;
const MAX_ACCOUNT_SWITCHES = 3;

export type EditableFileOutput = {
  conversationId: string;
  primaryUrl: string;
  zipUrl: string | null;
  creditsCharged: number;
};

type EditableFileInput = {
  userId: string;
  apiKeyId?: string;
  kind: EditableFileKind;
  prompt: string;
  base64Images: string[];
  taskId: string;
  signal?: AbortSignal;
};

/** 已消费的 taskId 不代表允许再次执行；即使首次失败并已退款，也必须换新任务。 */
export class EditableFileTaskAlreadyConsumedError extends Error {
  readonly code = "editable_file_task_already_consumed";
  readonly status = 409;

  /** 返回可供传输层映射的冲突错误，不回放其他 Key 或历史任务的内容。 */
  constructor() {
    super("Editable file task ID is already in use. Please start a new task.");
    this.name = "EditableFileTaskAlreadyConsumedError";
  }
}

/** 在产生下一项副作用前检查调用方取消，不把取消原因当账号故障。 */
function throwIfCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Editable file generation cancelled");
  error.name = "AbortError";
  throw error;
}

/** 租约释放失败只记录可定位标识，不能导致已成功的上游被重新执行。 */
async function releaseLease(
  params: Parameters<typeof releaseImageBackendInflightLease>[0]
): Promise<void> {
  try {
    await releaseImageBackendInflightLease(params);
  } catch {
    logWarn("可编辑文件租约释放失败", {
      memberId: params.memberId,
      leaseId: params.leaseId,
    });
  }
}

/** 存二进制并返回非空签名地址；设置、签名或存储失败直接交给外层退款，不换号。 */
async function storeEditableBinary(
  userId: string,
  kind: EditableFileKind,
  binary: EditableFileBinary,
  isZip: boolean
): Promise<string> {
  const bucket =
    (await getRuntimeSettingString("NEXT_PUBLIC_GENERATIONS_BUCKET_NAME")) ||
    "generations";
  const key = `${userId}/${nanoid(32)}.${editableFileExtension(kind, isZip)}`;
  const url = buildSignedStorageImageUrl(key, bucket);
  if (!url) throw new Error("Editable file storage URL could not be signed");
  const storage = await getStorageProvider();
  await storage.putObject(
    key,
    bucket,
    binary.buffer,
    binary.mimeType || "application/octet-stream"
  );
  return url;
}

/** 仅包围上游调用的换号循环；池查询、取消、存储和财务失败不能落入账号失败重试。 */
async function generateEditableFile(
  params: EditableFileInput,
  images: ImageInputFile[]
): Promise<EditableFileResult> {
  const excluded: string[] = [];
  let lastError = new Error(NO_WEB_ACCOUNT_ERROR);
  for (let attempt = 0; attempt <= MAX_ACCOUNT_SWITCHES; attempt++) {
    throwIfCancelled(params.signal);
    let resolved: Awaited<ReturnType<typeof resolveImageBackendPoolConfig>> =
      null;
    try {
      resolved = await resolveImageBackendPoolConfig({
        userId: params.userId,
        apiKeyId: params.apiKeyId,
        requestKind: "image_generation",
        accountBackendPreference: "web",
        accountPlanFilter: "paid",
        // 文件生成跨组选择付费 Web 账号；Key 已与钱包在同一消费事务 capture。
        spanGroupsForWeb: true,
        excludedMemberKeys: [...excluded],
      });
    } catch (error) {
      if (!(error instanceof ImageBackendPoolUnavailableError)) throw error;
    }
    const backend = resolved?.config.backend;
    if (!resolved || !backend) break;
    const memberType = backend.type === "pool-api" ? "api" : "account";
    let outcome: { success: boolean; error?: string } | undefined;
    try {
      throwIfCancelled(params.signal);
      if (backend.accountBackend !== "web") {
        if (backend.id) excluded.push(`${memberType}:${backend.id}`);
        continue;
      }
      try {
        const result = await generateFileWithChatGptWeb({
          config: {
            ...resolved.config,
            signal: params.signal ?? resolved.config.signal,
          },
          kind: params.kind,
          prompt: params.prompt,
          images,
        });
        outcome = { success: true };
        return result;
      } catch (error) {
        throwIfCancelled(params.signal);
        lastError = error instanceof Error ? error : new Error(String(error));
        outcome = { success: false, error: lastError.message };
        if (backend.id) excluded.push(`${memberType}:${backend.id}`);
        logWarn("可编辑文件上游失败，换号重试", {
          taskId: params.taskId,
          kind: params.kind,
          attempt,
          memberId: backend.id,
        });
      }
    } finally {
      await releaseLease({
        memberType,
        memberId: backend.id,
        leaseId: backend.inflightLeaseId,
        leasePersisted: backend.inflightLeasePersisted,
      });
      if (outcome) {
        try {
          await reportImageBackendResult({
            memberType,
            memberId: backend.id,
            ...outcome,
          });
        } catch {
          logWarn("可编辑文件上游结果上报失败", {
            taskId: params.taskId,
            memberId: backend.id,
          });
        }
      }
    }
  }
  throw lastError;
}

/**
 * 生成一份 PPT/PSD：固定费认领成功才执行，失败按实际净扣费封顶退款。
 * taskId 按用户、文件类型隔离；重复消费直接拒绝，不依赖进程内任务缓存。
 * 底层消费和专用退款各自拥有事务，本编排不能再嵌套外层事务。
 */
export async function runEditableFileForUser(
  params: EditableFileInput
): Promise<EditableFileOutput> {
  const { userId, apiKeyId, kind } = params;
  const taskId = params.taskId.trim();
  if (!taskId || taskId.length > 200)
    throw new Error("Invalid editable file task ID");
  throwIfCancelled(params.signal);
  if (kind === "psd" && params.base64Images.length === 0) {
    throw new Error("base64_images is empty");
  }
  const images = params.base64Images.map((raw, index) =>
    decodeBase64DataUrl(raw, index + 1)
  );
  const configuredAmount = await getRuntimeSettingNumber(
    kind === "psd" ? "EDITABLE_FILE_PSD_CREDITS" : "EDITABLE_FILE_PPT_CREDITS",
    DEFAULT_EDITABLE_CREDITS
  );
  const amount = Math.trunc(configuredAmount);
  // 零额消费无法在现有账本中认领；持久任务层就绪前，不能以零价绕过重放保护。
  if (!Number.isFinite(configuredAmount) || amount <= 0) {
    throw new Error(
      "Editable file generation requires a positive fixed credit price"
    );
  }
  // 哈希元组避免客户端分隔符碰撞，也避免全局退款唯一键在不同用户之间冲突。
  const generationId = `editable-file:${createHash("sha256")
    .update(JSON.stringify([userId, kind, taskId]))
    .digest("hex")}`;
  const metadata = {
    generationId,
    taskId,
    kind,
    billingVersion: 1,
  };
  // 历史版本只用 taskId，且没有可重取的持久结果。新键启用前先拒绝旧消费，
  // 避免升级后的客户端重投被重新收费。旧版本跨类型共键，兼容检查也保守拒绝两种类型。
  const [legacyConsumption] = await db
    .select({ id: creditsTransaction.id })
    .from(creditsTransaction)
    .where(
      and(
        eq(creditsTransaction.userId, userId),
        eq(creditsTransaction.type, "consumption"),
        eq(creditsTransaction.sourceRef, `editable-file:${taskId}`)
      )
    )
    .limit(1);
  if (legacyConsumption) throw new EditableFileTaskAlreadyConsumedError();
  throwIfCancelled(params.signal);
  // Key capture、批次与钱包由底层单个事务提交；失败无独立预留需要补偿。
  const consumption = await consumeCredits({
    userId,
    amount,
    ...(apiKeyId !== undefined ? { externalApiKeyId: apiKeyId } : {}),
    serviceName: editableFileServiceName(kind),
    description: kind === "psd" ? "生成 PSD 文件" : "生成 PPT 文件",
    sourceRef: generationId,
    metadata,
  });
  // 回放不能执行，也不能退掉原消费所属的 Key 或钱包。
  if (consumption.alreadyConsumed)
    throw new EditableFileTaskAlreadyConsumedError();

  try {
    throwIfCancelled(params.signal);
    const result = await generateEditableFile(params, images);
    throwIfCancelled(params.signal);
    const primaryUrl = await storeEditableBinary(
      userId,
      kind,
      result.primary,
      false
    );
    const zipUrl = result.zip
      ? await storeEditableBinary(userId, kind, result.zip, true)
      : null;
    return {
      conversationId: result.conversationId,
      primaryUrl,
      zipUrl,
      creditsCharged: amount,
    };
  } catch (error) {
    try {
      const refund = await refundGenerationCredits({
        userId,
        generationId,
        amount,
        targetCredits: 0,
        sourceRef: `${generationId}:failure-refund`,
        description:
          kind === "psd" ? "PSD 文件生成失败退还" : "PPT 文件生成失败退还",
        metadata: {
          ...metadata,
          reason: params.signal?.aborted ? "cancelled" : "editable_file_failed",
        },
      });
      if (refund.remainingDebited !== 0)
        throw new Error("Editable file refund has an unsettled debit");
    } catch (refundError) {
      logWarn("可编辑文件退款待处理", {
        userId,
        taskId,
        generationId,
        apiKeyId,
        amount,
      });
      throw Object.assign(
        new Error(
          "Editable file refund is pending. Reference this task ID for support.",
          {
            cause: new AggregateError([error, refundError]),
          }
        ),
        { code: "editable_file_refund_pending", generationId, taskId }
      );
    }
    throw error;
  }
}
