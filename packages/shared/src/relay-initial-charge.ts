/** 纯中转初始财务生命周期：只恢复确定未开始工作的扣费，已 dispatch 永不自动退款。 */
import { db } from "@repo/database";
import { relayInitialCharge } from "@repo/database/schema";
import { and, asc, eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import { enqueueGenerationRefund } from "./generation-refund-outbox";
import { logWarn } from "./logger";
import {
  type RelayInitialCaptureIntent,
  RelayInitialDispatchError,
  relayInitialCaptureSchema,
} from "./relay-initial-charge-contract";

export {
  createRelayInitialCapture,
  PURE_RELAY_CREDIT_DESCRIPTION,
  RelayInitialDispatchError,
} from "./relay-initial-charge-contract";

/**
 * 审核/上游工作前唯一 CAS。只有成功返回才执行；ACK 未知也不能重试派发。
 * 与过期认领竞争同一行；一旦 dispatched，进程退出后的上游结果仍可能未知。
 */
export async function dispatchRelayInitialCharge(
  userId: string,
  intent: RelayInitialCaptureIntent
): Promise<void> {
  const parsed = relayInitialCaptureSchema.parse(intent);
  let claimed: { id: string } | undefined;
  try {
    [claimed] = await db
      .update(relayInitialCharge)
      .set({
        state: "dispatched",
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(relayInitialCharge.id, parsed.captureId),
          eq(relayInitialCharge.userId, userId),
          eq(relayInitialCharge.generationId, parsed.generationId),
          eq(relayInitialCharge.state, "captured"),
          sql`${relayInitialCharge.expiresAt} > clock_timestamp()`
        )
      )
      .returning({ id: relayInitialCharge.id });
  } catch {
    // 提交或确认中断：状态可能已是 dispatched，到期恢复不会再处理。
    throw new RelayInitialDispatchError("unknown");
  }
  if (!claimed) throw new RelayInitialDispatchError("rejected");
}

/** 数据库时钟决定到期；pending 独立持久，CAS 后 enqueue 前退出也能再次领取。 */
function recoverableCondition() {
  return and(
    sql`${relayInitialCharge.state} IN ('captured', 'refund_pending')`,
    or(
      and(
        eq(relayInitialCharge.state, "captured"),
        sql`${relayInitialCharge.expiresAt} <= clock_timestamp()`
      ),
      eq(relayInitialCharge.state, "refund_pending")
    )
  );
}

/**
 * 有界扫描后在 UPDATE 重查，绝不从无 generation/无 marker/超时响应猜测应退。
 * enqueue 成功只标 refund_enqueued，资金恢复继续由 R11 独立事务和原 Key 账本负责。
 */
export async function recoverRelayInitialCharges(limit = 100) {
  const batchSize = z.number().int().min(1).max(500).parse(limit);
  const rows = await db
    .select({ id: relayInitialCharge.id })
    .from(relayInitialCharge)
    .where(recoverableCondition())
    .orderBy(asc(relayInitialCharge.expiresAt), asc(relayInitialCharge.id))
    .limit(batchSize);
  const result = { scanned: rows.length, enqueued: 0, failed: 0 };
  for (const candidate of rows) {
    try {
      const [claimed] = await db
        .update(relayInitialCharge)
        .set({
          state: "refund_pending",
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(eq(relayInitialCharge.id, candidate.id), recoverableCondition())
        )
        .returning();
      if (!claimed) continue;
      // captured 尚未获准审核/调用上游，因此初始消费目标为0；不改变普通失败的审核计价政策。
      await enqueueGenerationRefund({
        userId: claimed.userId,
        generationId: claimed.generationId,
        sourceRef: `${claimed.generationId}:relay-initial-recovery-refund`,
        amount: Number(claimed.amount),
        targetCredits: 0,
      });
      await db
        .update(relayInitialCharge)
        .set({ state: "refund_enqueued", updatedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(relayInitialCharge.id, claimed.id),
            eq(relayInitialCharge.state, "refund_pending")
          )
        );
      result.enqueued++;
    } catch {
      // 仅固定类别，不把任意数据库异常、调用方内容或 SQL 参数写入日志。
      result.failed++;
      logWarn("Pure relay initial refund pending retry", {
        source: "relay-initial-charge-recovery",
      });
    }
  }
  return result;
}
