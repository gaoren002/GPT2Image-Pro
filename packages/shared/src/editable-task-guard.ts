/** 仅在 consumeCredits 的同一事务内调用的认领 guard；零价也复用，不能外包资金事务。 */
import type { db } from "@repo/database";
import { creditsTransaction, editableFileTask } from "@repo/database/schema";
import { and, eq, sql } from "drizzle-orm";
import {
  EditableFileTaskAlreadyConsumedError,
  type EditableTaskClaim,
} from "./editable-task-contract";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * 先锁任务，再检查期限、身份和资金键，随后 prepared→running 与资金同事务提交。
 * 过期维护先终止 prepared/running 再投递退款；因此晚开始/晚提交的 capture 无法越过终态。
 */
export async function claimEditableTaskInTransaction(
  tx: Transaction,
  claim: EditableTaskClaim,
  payment: {
    userId: string;
    amount: number;
    sourceRef?: string;
    externalApiKeyId?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  const [task] = await tx
    .select()
    .from(editableFileTask)
    .where(eq(editableFileTask.id, claim.taskId))
    .for("update");
  if (
    task?.state !== "prepared" ||
    task.claimToken !== claim.claimToken ||
    task.userId !== payment.userId ||
    task.apiKeyId !== (payment.externalApiKeyId ?? null) ||
    task.id !== payment.sourceRef ||
    payment.metadata?.generationId !== task.id ||
    Number(task.quotedCredits) !== payment.amount
  ) {
    throw new EditableFileTaskAlreadyConsumedError();
  }
  // 旧版本在同一新 hash 上已有消费但没有任务行，不能当新任务再执行。
  const [existing] = await tx
    .select({ id: creditsTransaction.id })
    .from(creditsTransaction)
    .where(
      and(
        eq(creditsTransaction.userId, task.userId),
        eq(creditsTransaction.type, "consumption"),
        eq(creditsTransaction.sourceRef, task.id)
      )
    )
    .limit(1);
  if (existing) throw new EditableFileTaskAlreadyConsumedError();
  const [claimed] = await tx
    .update(editableFileTask)
    .set({ state: "running", updatedAt: new Date() })
    .where(
      and(
        eq(editableFileTask.id, task.id),
        sql`${editableFileTask.expiresAt} > clock_timestamp()`
      )
    )
    .returning({ id: editableFileTask.id });
  if (!claimed) throw new EditableFileTaskAlreadyConsumedError();
}
