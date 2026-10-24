/**
 * 可编辑文件持久生命周期：原子执行认领、只留引用的完成态、账本核对与 R11 outbox 恢复。
 * prepared 只是意图；只有资金事务 guard 提交 running 后才能请求上游。恢复永不重做上游。
 */
import { randomUUID } from "node:crypto";
import { db } from "@repo/database";
import {
  creditsTransaction,
  editableFileTask,
  generationRefundOutbox,
} from "@repo/database/schema";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import * as creditsCore from "./credits/core";
import { submitGenerationRefund } from "./generation-refund-outbox";
import { logWarn } from "./logger";
import { buildSignedStorageImageUrl } from "./storage/signed-url";
import { storageKeyBelongsToUser } from "./storage/utils";
import {
  EditableFileTaskAlreadyConsumedError,
  EditableTaskPendingError,
  editableResultReferencesSchema,
  editableTaskId,
  type EditableResultReferences,
  type EditableTaskClaim,
  type EditableTaskIdentity,
} from "./editable-task-contract";
import { claimEditableTaskInTransaction } from "./editable-task-guard";

export {
  editableRequestFingerprint,
  EditableFileTaskAlreadyConsumedError,
} from "./editable-task-contract";
export type {
  EditableResultReferences,
  EditableTaskIdentity,
} from "./editable-task-contract";
type Task = typeof editableFileTask.$inferSelect;
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** POST重放不从数据库补齐请求身份；仅原用户、Key和指纹匹配才允许恢复原任务。 */
function matches(task: Task, identity: EditableTaskIdentity) {
  return (
    task.userId === identity.userId &&
    task.apiKeyId === (identity.apiKeyId ?? null) &&
    task.kind === identity.kind &&
    task.requestFingerprint === identity.requestFingerprint
  );
}

/** 输入以已认证身份构造；本层也防空 ID、非法金额与非法指纹进入数据库。 */
function validateIdentity(identity: EditableTaskIdentity) {
  if (
    !identity.userId ||
    !identity.taskId.trim() ||
    identity.taskId.trim().length > 200 ||
    !["ppt", "psd"].includes(identity.kind) ||
    !/^[a-f0-9]{64}$/.test(identity.requestFingerprint)
  ) {
    throw new Error("Invalid editable file task identity");
  }
}

/** 汇总实际消费及退款，不以 quotedCredits/任务状态替代真实 ledger。 */
async function readNetDebit(tx: Transaction | typeof db, task: Task) {
  const rows = await tx
    .select({
      type: creditsTransaction.type,
      amount: creditsTransaction.amount,
    })
    .from(creditsTransaction)
    .where(
      and(
        eq(creditsTransaction.userId, task.userId),
        inArray(creditsTransaction.type, ["consumption", "refund"]),
        or(
          eq(creditsTransaction.sourceRef, task.id),
          sql`${creditsTransaction.metadata}->>'generationId' = ${task.id}`
        )
      )
    );
  const net = rows.reduce(
    (sum, row) =>
      sum + (row.type === "consumption" ? 1 : -1) * Number(row.amount),
    0
  );
  if (!Number.isFinite(net) || net < -0.001)
    throw new Error("Invalid editable file ledger");
  return Math.max(0, Math.round(net * 100) / 100);
}

/**
 * 首次意图持久化；同身份完成态可回放，其余状态均禁止再次执行。
 * 旧 taskId/旧 hash 消费没有可验证结果，保守拒绝，不自动归属或重扣。
 */
export async function prepareEditableTask(
  identity: EditableTaskIdentity,
  amount: number,
  publicId = `task_${randomUUID()}`
) {
  validateIdentity(identity);
  if (!/^task_[a-zA-Z0-9_-]{16,100}$/.test(publicId))
    throw new Error("Invalid editable poll ID");
  if (
    !Number.isFinite(amount) ||
    amount < 0 ||
    amount > 9999999999.99 ||
    Math.round(amount * 100) / 100 !== amount
  )
    throw new Error("Invalid editable file price");
  const id = editableTaskId(identity.userId, identity.kind, identity.taskId);
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(editableFileTask)
      .where(eq(editableFileTask.id, id));
    if (existing) {
      if (!matches(existing, identity) || existing.state !== "completed")
        throw new EditableFileTaskAlreadyConsumedError();
      return { task: existing, claim: null };
    }
    const [legacy] = await tx
      .select({ id: creditsTransaction.id })
      .from(creditsTransaction)
      .where(
        and(
          eq(creditsTransaction.userId, identity.userId),
          eq(creditsTransaction.type, "consumption"),
          inArray(creditsTransaction.sourceRef, [
            id,
            `editable-file:${identity.taskId.trim()}`,
          ])
        )
      )
      .limit(1);
    if (legacy) throw new EditableFileTaskAlreadyConsumedError();
    const token = randomUUID();
    const [task] = await tx
      .insert(editableFileTask)
      .values({
        id,
        publicId,
        userId: identity.userId,
        apiKeyId: identity.apiKeyId ?? null,
        kind: identity.kind,
        requestFingerprint: identity.requestFingerprint,
        claimToken: token,
        state: "prepared",
        quotedCredits: amount,
        expiresAt: sql`clock_timestamp() + interval '30 minutes'`,
      })
      .onConflictDoNothing()
      .returning();
    if (!task) throw new EditableFileTaskAlreadyConsumedError();
    return { task, claim: { taskId: id, claimToken: token } };
  });
}

/**
 * 扣费服务必须支持同事务认领协议；版本不兼容时拒绝付费 capture，防止退化为双写。
 * 零价无需钱包行/账本伪交易，但仍在事务内认领同一个墓碑。
 */
export async function captureEditableTask(
  task: Task,
  claim: EditableTaskClaim,
  chatRoundCredits = 0
) {
  const payment = {
    userId: task.userId,
    amount: Number(task.quotedCredits),
    sourceRef: task.id,
    ...(task.apiKeyId === null ? {} : { externalApiKeyId: task.apiKeyId }),
    serviceName:
      task.kind === "psd" ? "editable_file_psd" : "editable_file_ppt",
    description: task.kind === "psd" ? "生成 PSD 文件" : "生成 PPT 文件",
    metadata: {
      generationId: task.id,
      kind: task.kind,
      billingVersion: 2,
      baseCredits: Number(task.quotedCredits) - chatRoundCredits,
      chatRoundCredits,
    },
    editableTaskClaim: claim,
  };
  if (payment.amount === 0) {
    await db.transaction((tx) =>
      claimEditableTaskInTransaction(tx, claim, payment)
    );
    return;
  }
  if (Reflect.get(creditsCore, "EDITABLE_TASK_ATOMIC_CAPTURE_VERSION") !== 1)
    throw new Error("Editable file atomic capture is not wired");
  const debit = await creditsCore.consumeCredits(payment);
  if (debit.alreadyConsumed) throw new EditableFileTaskAlreadyConsumedError();
}

/** 只有当前未过期 owner 能把存储引用一起提交为完成态；已退任务拒绝迟到产物。 */
export async function completeEditableTask(
  claim: EditableTaskClaim,
  references: EditableResultReferences
) {
  const refs = editableResultReferencesSchema.parse(references);
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(editableFileTask)
      .where(eq(editableFileTask.id, claim.taskId))
      .for("update");
    if (!task || task.claimToken !== claim.claimToken)
      throw new EditableFileTaskAlreadyConsumedError();
    if (task.state === "completed") return task;
    if (
      task.state !== "running" ||
      !storageKeyBelongsToUser(refs.primary.key, task.userId) ||
      (refs.zip && !storageKeyBelongsToUser(refs.zip.key, task.userId))
    )
      throw new EditableFileTaskAlreadyConsumedError();
    if ((await readNetDebit(tx, task)) !== Number(task.quotedCredits))
      throw new Error("Editable file capture is not settled");
    const [completed] = await tx
      .update(editableFileTask)
      .set({
        state: "completed",
        resultReferences: refs,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(editableFileTask.id, task.id),
          sql`${editableFileTask.expiresAt} > clock_timestamp()`
        )
      )
      .returning();
    if (!completed) throw new EditableFileTaskAlreadyConsumedError();
    return completed;
  });
}

/**
 * 行锁与 capture 共用，先持久终止执行并写 R11 outbox，再释放锁执行资金退款。
 * 即使进程在两者之间崩溃，既有 outbox 也能恢复；完成态绝不被请求断连/签名故障退掉。
 */
export async function failEditableTask(
  id: string,
  claimToken?: string,
  onlyExpired = false
) {
  const task = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(editableFileTask)
      .where(eq(editableFileTask.id, id))
      .for("update");
    if (!row || (claimToken && row.claimToken !== claimToken))
      throw new EditableFileTaskAlreadyConsumedError();
    if (["completed", "refunded", "failed"].includes(row.state)) return row;
    const net = await readNetDebit(tx, row);
    const [stopped] = await tx
      .update(editableFileTask)
      .set({
        state:
          net > 0
            ? "refund_pending"
            : row.state === "prepared"
              ? "failed"
              : "refunded",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(editableFileTask.id, id),
          onlyExpired
            ? sql`${editableFileTask.expiresAt} <= clock_timestamp()`
            : undefined
        )
      )
      .returning();
    if (!stopped) return row;
    if (net > 0) {
      await tx
        .insert(generationRefundOutbox)
        .values({
          id: randomUUID(),
          userId: row.userId,
          generationId: id,
          sourceRef: `${id}:lifecycle-refund`,
          requestedAmount: Math.max(net, Number(row.quotedCredits)),
          targetCredits: 0,
        })
        .onConflictDoNothing({
          target: [
            generationRefundOutbox.userId,
            generationRefundOutbox.sourceRef,
          ],
        });
    }
    return stopped;
  });
  if (task.state !== "refund_pending") return task;
  try {
    await submitGenerationRefund({
      userId: task.userId,
      generationId: id,
      sourceRef: `${id}:lifecycle-refund`,
      amount: Number(task.quotedCredits),
      targetCredits: 0,
    });
    // 终态后的 capture 被 guard 拒绝；确认仍读账本，outbox 的 settled 不是财务真相。
    if ((await readNetDebit(db, task)) !== 0)
      throw new Error("Unsettled editable file debit");
    const [refunded] = await db
      .update(editableFileTask)
      .set({ state: "refunded", updatedAt: new Date() })
      .where(
        and(
          eq(editableFileTask.id, id),
          eq(editableFileTask.state, "refund_pending")
        )
      )
      .returning();
    return refunded ?? task;
  } catch {
    await db
      .update(editableFileTask)
      .set({
        expiresAt: sql`clock_timestamp() + interval '60 seconds'`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(editableFileTask.id, id),
          eq(editableFileTask.state, "refund_pending")
        )
      );
    throw new EditableTaskPendingError("editable_file_refund_pending");
  }
}

/** 交付时读取账本并重新签名；签名失败保留 completed，调用者可以同身份重取。 */
export async function deliverEditableTask(task: Task) {
  if (task.state !== "completed" || !task.resultReferences)
    throw new EditableFileTaskAlreadyConsumedError();
  try {
    const refs = editableResultReferencesSchema.parse(task.resultReferences);
    if (
      !storageKeyBelongsToUser(refs.primary.key, task.userId) ||
      (refs.zip && !storageKeyBelongsToUser(refs.zip.key, task.userId))
    )
      throw new Error("Invalid result owner");
    const primaryUrl = buildSignedStorageImageUrl(
      refs.primary.key,
      refs.primary.bucket
    );
    const zipUrl = refs.zip
      ? buildSignedStorageImageUrl(refs.zip.key, refs.zip.bucket)
      : null;
    if (!primaryUrl || (refs.zip && !zipUrl))
      throw new Error("Result signing unavailable");
    return {
      conversationId: refs.conversationId,
      primaryUrl,
      zipUrl,
      creditsCharged: await readNetDebit(db, task),
    };
  } catch {
    throw new EditableTaskPendingError("editable_file_delivery_pending");
  }
}

/** 在已验证归属后构造状态，过期仅退款恢复；从不重新执行上游。 */
async function presentEditableTask(row: Task, taskId: string) {
  let task = row;
  if (["prepared", "running", "refund_pending"].includes(task.state)) {
    try {
      task = await failEditableTask(task.id, undefined, true);
    } catch {
      const [latest] = await db
        .select()
        .from(editableFileTask)
        .where(eq(editableFileTask.id, task.id));
      if (!latest) return null;
      task = latest;
    }
  }
  return {
    taskId,
    publicId: task.publicId,
    kind: task.kind,
    status: task.state,
    requestFingerprint: task.requestFingerprint,
    creditsCharged: await readNetDebit(db, task),
    result: task.state === "completed" ? await deliverEditableTask(task) : null,
  };
}

/** POST 重放必须验证 user/Key/原请求指纹，不以已知 taskId 代替内容校验。 */
export async function getEditableTask(identity: EditableTaskIdentity) {
  validateIdentity(identity);
  const id = editableTaskId(identity.userId, identity.kind, identity.taskId);
  const [task] = await db
    .select()
    .from(editableFileTask)
    .where(eq(editableFileTask.id, id));
  if (!task || !matches(task, identity)) return null;
  try {
    return await presentEditableTask(task, identity.taskId);
  } catch (error) {
    // 已核验原请求：即使完成态暂时无法重签，也保留ACK丢失后的持久轮询入口。
    if (error instanceof EditableTaskPendingError)
      Object.assign(error, {
        publicTaskId: task.publicId,
        requestFingerprint: task.requestFingerprint,
      });
    throw error;
  }
}

/** 既有外接轮询仅携带 opaque ID，kind 从持久记录读取；Key 必须精确相等（含null）。 */
export async function getEditableTaskByPublicId(identity: {
  userId: string;
  apiKeyId?: string | undefined;
  publicId: string;
}) {
  const [task] = await db
    .select()
    .from(editableFileTask)
    .where(
      and(
        eq(editableFileTask.publicId, identity.publicId),
        eq(editableFileTask.userId, identity.userId)
      )
    );
  if (!task || task.apiKeyId !== (identity.apiKeyId ?? null)) return null;
  return presentEditableTask(task, identity.publicId);
}

/** 站内断连前已知 userMessageId，可用会话与kind查询；只读取无APIKey任务。 */
export async function getSessionEditableTask(identity: {
  userId: string;
  kind: "ppt" | "psd";
  taskId: string;
}) {
  const id = editableTaskId(identity.userId, identity.kind, identity.taskId);
  const [task] = await db
    .select()
    .from(editableFileTask)
    .where(
      and(
        eq(editableFileTask.id, id),
        eq(editableFileTask.userId, identity.userId)
      )
    );
  if (!task || task.apiKeyId !== null) return null;
  return presentEditableTask(task, identity.taskId);
}

/** 有界维护扫描供 UOL/cron 调用；每行独立，故障不阻塞其余到期任务，墓碑永久保留。 */
export async function recoverEditableTasks(limit = 100) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new Error("Invalid editable task recovery limit");
  const rows = await db
    .select({ id: editableFileTask.id })
    .from(editableFileTask)
    .where(
      and(
        inArray(editableFileTask.state, [
          "prepared",
          "running",
          "refund_pending",
        ]),
        sql`${editableFileTask.expiresAt} <= clock_timestamp()`
      )
    )
    .orderBy(asc(editableFileTask.expiresAt), asc(editableFileTask.id))
    .limit(limit);
  let recovered = 0;
  for (const row of rows) {
    try {
      await failEditableTask(row.id, undefined, true);
      recovered++;
    } catch {
      logWarn("Editable task recovery pending", { taskId: row.id });
    }
  }
  return { scanned: rows.length, recovered };
}

/**
 * 开始新工作前复核当前owner/running/DB期限。返回原期限剩余毫秒，扣除本次查询耗时，
 * 包括连接等待和成功响应延迟；宁可提前取消，也不能因ACK迟到重新获得完整执行窗口。
 * 这是本地开工围栏，不持事务跨远端请求，不承诺检查与上游调用跨系统原子。
 */
export async function assertEditableTaskExecutable(claim: EditableTaskClaim) {
  const started = performance.now();
  const [task] = await db
    .select({
      remainingMs:
        sql<number>`floor(extract(epoch from (${editableFileTask.expiresAt} - clock_timestamp())) * 1000)`
          .mapWith(Number)
          .as("remaining_ms"),
    })
    .from(editableFileTask)
    .where(
      and(
        eq(editableFileTask.id, claim.taskId),
        eq(editableFileTask.claimToken, claim.claimToken),
        eq(editableFileTask.state, "running"),
        sql`${editableFileTask.expiresAt} > clock_timestamp()`
      )
    );
  const remainingMs = task
    ? Math.floor(task.remainingMs - (performance.now() - started))
    : 0;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0)
    throw new EditableFileTaskAlreadyConsumedError();
  return remainingMs;
}

/** 仅用数据库确认的原剩余期限建立一次取消信号；之后的开工检查不得续期。 */
export async function editableExecutionSignal(
  claim: EditableTaskClaim,
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  const remainingMs = await assertEditableTaskExecutable(claim);
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(Math.min(remainingMs, 2_147_483_647));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
