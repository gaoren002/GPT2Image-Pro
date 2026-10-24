/**
 * PPT/PSD 编排，供 v1 handler、UOL 与前端调用：同事务幂等扣固定费与 Key → 上游 → 存储。
 * 财务真相使用 credits 账本；失败经 generation 专用退款原子退回钱包与原消费 Key。
 * 只有上游生成失败可以换号，本地财务、存储与取消失败不进入重试循环。
 * 持久任务负责执行认领和结果引用；失败/过期走 R11 outbox，重放只重签已完成结果。
 */
import {
  prepareEditableTask,
  captureEditableTask,
  completeEditableTask,
  failEditableTask,
  deliverEditableTask,
  getEditableTask,
  editableRequestFingerprint,
  editableExecutionSignal,
  assertEditableTaskExecutable,
  EditableFileTaskAlreadyConsumedError,
} from "@repo/shared/editable-task-lifecycle";
import { getPlanBillingConfig } from "@repo/shared/subscription/services/plan-capabilities";
import { getUserPlan } from "@repo/shared/subscription/services/user-plan";
import { logWarn } from "@repo/shared/logger";
import { getStorageProvider } from "@repo/shared/storage/providers";
import {
  getRuntimeSettingNumber,
  getRuntimeSettingString,
} from "@repo/shared/system-settings";
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
  requestFingerprint: string;
  publicTaskId: string;
};

type EditableFileInput = {
  userId: string;
  apiKeyId?: string;
  kind: EditableFileKind;
  prompt: string;
  base64Images: string[];
  taskId: string;
  signal?: AbortSignal;
  chatRound?: boolean;
  publicTaskId?: string;
};

export { EditableFileTaskAlreadyConsumedError };

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

/** 存二进制并返回稳定对象引用；签名留到完成态持久化之后，失败不重做上游。 */
async function storeEditableBinary(
  userId: string,
  kind: EditableFileKind,
  binary: EditableFileBinary,
  isZip: boolean,
  beforeWork: () => Promise<void>
): Promise<{ key: string; bucket: string }> {
  const bucket =
    (await getRuntimeSettingString("NEXT_PUBLIC_GENERATIONS_BUCKET_NAME")) ||
    "generations";
  const key = `${userId}/${nanoid(32)}.${editableFileExtension(kind, isZip)}`;
  const storage = await getStorageProvider();
  await beforeWork();
  await storage.putObject(
    key,
    bucket,
    binary.buffer,
    binary.mimeType || "application/octet-stream"
  );
  return { key, bucket };
}

/** 仅包围上游调用的换号循环；池查询、取消、存储和财务失败不能落入账号失败重试。 */
async function generateEditableFile(
  params: EditableFileInput,
  images: ImageInputFile[],
  beforeWork: () => Promise<void>
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
      await beforeWork();
      throwIfCancelled(params.signal);
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
        outcome = { success: false, error: "editable_file_upstream_failed" };
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
 * 单次任务执行：指纹校验→原子 capture/claim→上游→存储→持久引用→签名交付。
 * 重放/查询只读既有结果。任何失败及未知结果都不自动重启上游；仅到期补偿。
 * chatRound 纳入首次报价同事务扣费，消除成功产物被后扣失败吞掉的窗口。
 */
export async function prepareEditableFileExecution(
  params: EditableFileInput
): Promise<{
  requestFingerprint: string;
  publicTaskId: string;
  execute: () => Promise<EditableFileOutput>;
}> {
  const taskId = params.taskId.trim();
  if (!taskId || taskId.length > 200)
    throw new Error("Invalid editable file task ID");
  throwIfCancelled(params.signal);
  if (params.kind === "psd" && params.base64Images.length === 0)
    throw new Error("base64_images is empty");
  if (params.chatRound && params.apiKeyId)
    throw new Error("Chat round requires a session identity");
  const requestFingerprint = editableRequestFingerprint(params);
  const identity = {
    userId: params.userId,
    apiKeyId: params.apiKeyId,
    kind: params.kind,
    taskId,
    requestFingerprint,
  };
  const previous = await getEditableTask(identity);
  if (previous) {
    if (previous.result)
      return {
        requestFingerprint,
        publicTaskId: previous.publicId,
        execute: async () => {
          const refreshed = await getEditableTask(identity);
          if (!refreshed?.result)
            throw new EditableFileTaskAlreadyConsumedError();
          return {
            ...refreshed.result,
            requestFingerprint,
            publicTaskId: refreshed.publicId,
          };
        },
      };
    throw Object.assign(new EditableFileTaskAlreadyConsumedError(), {
      publicTaskId: previous.publicId,
      requestFingerprint,
    });
  }
  const images = params.base64Images.map((raw, index) =>
    decodeBase64DataUrl(raw, index + 1)
  );
  const configuredAmount = await getRuntimeSettingNumber(
    params.kind === "psd"
      ? "EDITABLE_FILE_PSD_CREDITS"
      : "EDITABLE_FILE_PPT_CREDITS",
    DEFAULT_EDITABLE_CREDITS
  );
  if (!Number.isFinite(configuredAmount) || configuredAmount < 0)
    throw new Error("Invalid editable file price");
  let roundFee = 0;
  if (params.chatRound) {
    const plan = await getUserPlan(params.userId);
    const billing = await getPlanBillingConfig(plan.plan);
    if (
      !Number.isFinite(billing.chatRoundCredits) ||
      billing.chatRoundCredits < 0
    )
      throw new Error("Invalid chat round price");
    roundFee = Math.trunc(billing.chatRoundCredits);
  }
  const amount = Math.trunc(configuredAmount) + roundFee;
  const prepared = await prepareEditableTask(
    identity,
    amount,
    params.publicTaskId
  );
  if (!prepared.claim)
    return {
      requestFingerprint,
      publicTaskId: prepared.task.publicId,
      execute: async () => ({
        ...(await deliverEditableTask(prepared.task)),
        requestFingerprint,
        publicTaskId: prepared.task.publicId,
      }),
    };
  const { claim, task } = prepared;
  return {
    requestFingerprint,
    publicTaskId: task.publicId,
    execute: async () => {
      throwIfCancelled(params.signal);
      let captured = false;
      try {
        await captureEditableTask(task, claim, roundFee);
        captured = true;
        const signal = await editableExecutionSignal(claim, params.signal);
        // 后续await可能跨过期限/终态；每次真正发起上游或存储写前再复核，且不重置signal。
        const beforeWork = async () => {
          throwIfCancelled(signal);
          await assertEditableTaskExecutable(claim);
          throwIfCancelled(signal);
        };
        throwIfCancelled(signal);
        const result = await generateEditableFile(
          { ...params, signal },
          images,
          beforeWork
        );
        throwIfCancelled(signal);
        const primary = await storeEditableBinary(
          params.userId,
          params.kind,
          result.primary,
          false,
          beforeWork
        );
        const zip = result.zip
          ? await storeEditableBinary(
              params.userId,
              params.kind,
              result.zip,
              true,
              beforeWork
            )
          : null;
        const completed = await completeEditableTask(claim, {
          conversationId: result.conversationId,
          primary,
          zip,
        });
        return {
          ...(await deliverEditableTask(completed)),
          requestFingerprint,
          publicTaskId: completed.publicId,
        };
      } catch (error) {
        if (!captured && error instanceof EditableFileTaskAlreadyConsumedError)
          throw error;
        // 包括 COMMIT 响应丢失：在锁内重读完成态，已持久结果继续交付，不退款或再调用上游。
        const stopped = await failEditableTask(task.id, claim.claimToken);
        if (stopped.state === "completed")
          return {
            ...(await deliverEditableTask(stopped)),
            requestFingerprint,
            publicTaskId: stopped.publicId,
          };
        throw error;
      }
    },
  };
}

/** 同步适配复用先落盘再执行的两阶段入口，资金仍只在执行 guard 的同一事务中发生。 */
export async function runEditableFileForUser(
  params: EditableFileInput
): Promise<EditableFileOutput> {
  return (await prepareEditableFileExecution(params)).execute();
}
