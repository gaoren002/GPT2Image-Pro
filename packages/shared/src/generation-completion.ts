/** 普通 async 的终态展示投影意图：复用 generation 行，不参与初始 capture，不保存 relay 内容。 */
import { db } from "@repo/database";
import {
  creditsTransaction,
  generation,
  generationRefundOutbox,
} from "@repo/database/schema";
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { logWarn } from "./logger";
import { enqueueGenerationRefund } from "./generation-refund-outbox";
import { z } from "zod";

/** ready 表示交付和真实结算已持久登记，任何迟到 timeout CAS 都不能再认领退款。 */
export function withoutReadyGenerationCompletion() {
  return sql`COALESCE(${generation.metadata}::jsonb->'asyncCompletion'->>'state', '') <> 'ready'`;
}

/** 只在最终结算之前登记本阶段补偿上界；R11 仍会在锁内按真实净扣费裁剪。 */
export async function prepareGenerationCompletion(
  userId: string,
  generationId: string,
  maxRefundAmount: number
) {
  const [prepared] = await db
    .update(generation)
    .set({
      metadata: sql`COALESCE(${generation.metadata}, '{}'::json)::jsonb || ${JSON.stringify({ asyncCompletion: { version: 1, state: "settling", maxRefundAmount } })}::jsonb`,
    })
    .where(
      and(
        eq(generation.id, generationId),
        eq(generation.userId, userId),
        eq(generation.status, "pending"),
        withoutReadyGenerationCompletion()
      )
    )
    .returning({ id: generation.id });
  if (!prepared) throw new Error("Image completion intent unavailable");
}

export type GenerationCompletionProjection = {
  storageKey: string;
  storageBucket?: string;
  fileSize: number;
  size: string;
  revisedPrompt: string | undefined;
  creditsConsumed: number;
  metadata: SQL;
  completedAt: Date;
};

/** ready 及完整原投影先提交；之后只写展示状态，失败只保留修复意图，不吞付费交付。 */
export async function publishGenerationCompletion(
  userId: string,
  generationId: string,
  projection: GenerationCompletionProjection
) {
  const [ready] = await db
    .update(generation)
    .set({
      ...projection,
      metadata: sql`${projection.metadata}::jsonb || ${JSON.stringify({ asyncCompletion: { version: 1, state: "ready" } })}::jsonb`,
    })
    .where(
      and(
        eq(generation.id, generationId),
        eq(generation.userId, userId),
        eq(generation.status, "pending"),
        sql`${generation.metadata}::jsonb->'asyncCompletion'->>'state' = 'settling'`
      )
    )
    .returning({ id: generation.id });
  if (!ready) throw new Error("Image completion intent unavailable");
  try {
    await repairGenerationCompletion(userId, generationId);
    return { historyPending: false };
  } catch {
    logWarn("Image completion projection pending repair", {
      generationId,
      source: "generation-completion",
    });
    return { historyPending: true };
  }
}

/** 退款前先原子认领失败；ready/已完成胜出则不得退款，连接未知则保留恢复而非猜测。 */
export async function claimGenerationCompletionFailure(
  userId: string,
  generationId: string,
  lastKnownCredits: number,
  targetCredits: number
): Promise<"failed" | "ready" | "unknown"> {
  try {
    return await db.transaction(
      async (tx) => {
        const lockKey = JSON.stringify([
          "generation-refund",
          userId,
          generationId,
        ]);
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`
        );
        const [row] = await tx
          .select({ status: generation.status, metadata: generation.metadata })
          .from(generation)
          .where(
            and(eq(generation.id, generationId), eq(generation.userId, userId))
          )
          .limit(1)
          .for("update");
        if (
          row?.status === "completed" ||
          generationCompletionRecovery(row?.metadata ?? null, 0).ready
        )
          return "ready" as const;
        if (!row || (row.status !== "pending" && row.status !== "failed"))
          return "unknown" as const;
        const [ledger] = await tx
          .select({ net: generationNetSql() })
          .from(creditsTransaction)
          .where(
            and(
              eq(creditsTransaction.userId, userId),
              sql`${creditsTransaction.metadata}->>'generationId' = ${generationId}`
            )
          );
        const net = Number(ledger?.net);
        if (!Number.isFinite(net) || net < 0)
          throw new Error("Generation ledger unavailable");
        const completion = generationCompletionRecovery(row.metadata, net);
        const effectiveTarget = completion.targetCredits ?? targetCredits;
        await tx
          .update(generation)
          .set({
            status: "failed",
            creditsConsumed: net,
            error: "Image completion registration failed",
            completedAt: new Date(),
            metadata: sql`COALESCE(${generation.metadata}, '{}'::json)::jsonb || ${JSON.stringify({ settlement: { targetCredits: effectiveTarget, reason: "completion_registration_failed" }, asyncCompletion: { version: 1, state: "failed", targetCredits: effectiveTarget, maxRefundAmount: Math.max(lastKnownCredits, completion.maxRefundAmount, net) } })}::jsonb`,
          })
          .where(
            and(
              eq(generation.id, generationId),
              eq(generation.userId, userId),
              withoutReadyGenerationCompletion()
            )
          );
        return "failed" as const;
      },
      { isolationLevel: "read committed" }
    );
  } catch {
    return "unknown";
  }
}

/** 自然幂等重放 ready 行；不扣费、不退款、不重读图片，服务重启后仍可恢复。 */
export async function repairGenerationCompletion(
  userId: string,
  generationId: string
) {
  await db
    .update(generation)
    .set({ status: "completed", error: null })
    .where(
      and(
        eq(generation.id, generationId),
        eq(generation.userId, userId),
        eq(generation.status, "pending"),
        sql`${generation.metadata}::jsonb->'asyncCompletion'->>'state' = 'ready'`
      )
    );
}

/** ready 行归恢复器，settling 行保留已知补扣上界，避免崩溃后只按初始投影少退。 */
export function generationCompletionRecovery(
  metadata: Record<string, unknown> | null,
  chargedCredits: number
) {
  const value = metadata?.asyncCompletion;
  const marker =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const settlement = metadata?.settlement;
  const timeout = metadata?.timeout;
  const candidates = [
    marker.targetCredits,
    settlement && typeof settlement === "object"
      ? (settlement as Record<string, unknown>).targetCredits
      : undefined,
    timeout && typeof timeout === "object"
      ? (timeout as Record<string, unknown>).targetCredits
      : undefined,
  ];
  const targetCredits = candidates.find(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value) && value >= 0
  );
  return {
    isCompletion: marker.version === 1,
    targetCredits,
    ready: marker.version === 1 && marker.state === "ready",
    maxRefundAmount:
      marker.version === 1 &&
      typeof marker.maxRefundAmount === "number" &&
      Number.isFinite(marker.maxRefundAmount)
        ? Math.max(chargedCredits, marker.maxRefundAmount)
        : chargedCredits,
  };
}

/** 恢复确认丢失的 ready 意图；读失败保持 unknown，不能据异常推断已退款或已交付。 */
export async function readGenerationCompletionState(
  userId: string,
  generationId: string
): Promise<"ready" | "completed" | "unknown"> {
  try {
    const [row] = await db
      .select({ status: generation.status, metadata: generation.metadata })
      .from(generation)
      .where(
        and(eq(generation.id, generationId), eq(generation.userId, userId))
      )
      .limit(1);
    if (row?.status === "completed") return "completed";
    return generationCompletionRecovery(row?.metadata ?? null, 0).ready
      ? "ready"
      : "unknown";
  } catch {
    return "unknown";
  }
}

/** generation 专用消费/退款净额；类型限制与 R11 财务索引口径一致。 */
function generationNetSql() {
  return sql<number>`GREATEST(0, COALESCE(SUM(CASE WHEN ${creditsTransaction.type} = 'consumption' THEN ${creditsTransaction.amount} WHEN ${creditsTransaction.type} = 'refund' THEN -${creditsTransaction.amount} ELSE 0 END), 0))::float8`;
}

/** 退款异常后仅从已提交账本读净额；连接也不可用时显式 unknown，不拿缓存金额冒充净额。 */
export async function readGenerationNetCredits(
  userId: string,
  generationId: string
): Promise<number | undefined> {
  try {
    const [row] = await db
      .select({
        net: generationNetSql(),
      })
      .from(creditsTransaction)
      .where(
        and(
          eq(creditsTransaction.userId, userId),
          sql`${creditsTransaction.metadata}->>'generationId' = ${generationId}`
        )
      );
    return row && Number.isFinite(Number(row.net))
      ? Number(row.net)
      : undefined;
  } catch {
    return undefined;
  }
}

/** 失败行已围栏后，读取真实 net 与持久上界；不能拿调用方缓存当作全退请求额。 */
export async function readGenerationCompletionRefundPlan(
  userId: string,
  generationId: string,
  lastKnownCredits: number,
  fallbackTarget?: number
) {
  const [row] = await db
    .select({ metadata: generation.metadata, status: generation.status })
    .from(generation)
    .where(and(eq(generation.id, generationId), eq(generation.userId, userId)))
    .limit(1);
  const net = await readGenerationNetCredits(userId, generationId);
  if (net === undefined) throw new Error("Generation ledger unavailable");
  const completion = generationCompletionRecovery(row?.metadata ?? null, net);
  if (completion.ready || row?.status === "completed")
    throw new Error("Generation delivery is ready");
  // failed 是持久补扣围栏；pending/未知行的暂时 net0 不能证明随后不会再提交消费。
  if (row?.status !== "failed")
    throw new Error("Generation failure fence unavailable");
  const targetCredits = completion.targetCredits ?? fallbackTarget;
  if (
    targetCredits === undefined ||
    !Number.isFinite(targetCredits) ||
    targetCredits < 0
  )
    throw new Error("Generation refund target unavailable");
  return {
    net,
    targetCredits,
    amount: Math.max(
      0,
      Math.max(net, completion.maxRefundAmount, lastKnownCredits) -
        targetCredits
    ),
  };
}

const COMPLETION_REFUND_SUFFIX = ":completion-target-refund-v2";

/** 修复含旧低额 settled phase 的 R35 failed 行；独立终态 phase 仍由 R11 锁内裁剪，目标不可猜测。 */
export async function recoverGenerationCompletionRefunds(
  options: { limit?: number } = {}
) {
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
      metadata: sql<
        Record<string, unknown>
      >`jsonb_build_object('asyncCompletion', ${generation.metadata}::jsonb->'asyncCompletion', 'settlement', ${generation.metadata}::jsonb->'settlement', 'timeout', ${generation.metadata}::jsonb->'timeout')`,
    })
    .from(generation)
    .where(
      and(
        eq(generation.status, "failed"),
        sql`${generation.metadata}::jsonb->'asyncCompletion'->>'version' = '1'`,
        sql`NOT EXISTS (SELECT 1 FROM ${generationRefundOutbox} WHERE ${generationRefundOutbox.userId} = ${generation.userId} AND ${generationRefundOutbox.generationId} = ${generation.id} AND ${generationRefundOutbox.sourceRef} = (${generation.id} || ${COMPLETION_REFUND_SUFFIX}))`
      )
    )
    .orderBy(asc(generation.createdAt), asc(generation.id))
    .limit(limit);
  let enqueued = 0,
    recoveryFailed = 0;
  for (const row of rows) {
    const completion = generationCompletionRecovery(
      row.metadata,
      Number(row.creditsConsumed)
    );
    if (!completion.isCompletion) continue;
    try {
      if (completion.targetCredits === undefined)
        throw new Error("Generation refund target unavailable");
      const plan = await readGenerationCompletionRefundPlan(
        row.userId,
        row.id,
        completion.maxRefundAmount,
        completion.targetCredits
      );
      await enqueueGenerationRefund({
        userId: row.userId,
        generationId: row.id,
        sourceRef: `${row.id}${COMPLETION_REFUND_SUFFIX}`,
        amount: plan.amount,
        targetCredits: plan.targetCredits,
      });
      enqueued += 1;
    } catch {
      recoveryFailed += 1;
      logWarn("Generation completion refund pending recovery", {
        generationId: row.id,
        source: "generation-completion",
      });
    }
  }
  return { enqueued, recoveryFailed };
}
