/**
 * 生成退款 outbox：先落财务意图再执行 R10 退款，供运行时和图片维护复用。
 * 领取、确认均为单条 SQL；资金仍只由 grantCredits 自带事务处理，绝不嵌套事务。
 * 不保存调用方 description/metadata/error，纯中转也只有财务标量。
 */
import { db } from "@repo/database";
import { generation, generationRefundOutbox } from "@repo/database/schema";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { grantCredits } from "./credits/core";
import { describeErrorForLog, isDatabaseError } from "./db/error-summary";
import { logWarn } from "./logger";

/** 只记录稳定类别和数据库安全摘要，非数据库异常绝不记录任意 message/cause。 */
function logRefundFailure(error: unknown, context: Record<string, unknown>) {
  const database = isDatabaseError(error);
  const category = database
    ? "database"
    : error instanceof Error && error.name === "AccountFrozenError"
      ? "account_frozen"
      : error instanceof Error && error.name === "GenerationRefundLedgerError"
        ? "invalid_ledger_result"
        : "refund_execution";
  logWarn("Generation refund pending retry", {
    ...context,
    category,
    errorSummary: database ? describeErrorForLog(error) : category,
  });
}

const refundIntentSchema = z.object({
  userId: z
    .string()
    .min(1)
    .max(1024)
    .refine((value) => value.trim().length > 0),
  generationId: z
    .string()
    .min(1)
    .max(1024)
    .refine((value) => value.trim().length > 0),
  sourceRef: z
    .string()
    .min(1)
    .max(2048)
    .refine((value) => value.trim().length > 0),
  amount: z.number().finite().nonnegative().max(9999999999.99),
  targetCredits: z
    .number()
    .finite()
    .nonnegative()
    .max(9999999999.99)
    .default(0),
});
export type GenerationRefundIntentInput = z.input<typeof refundIntentSchema>;
type Intent = typeof generationRefundOutbox.$inferSelect;
const LEASE_MS = 60_000;

/** 金额与 PostgreSQL numeric(12,2) 一致，避免重放因浮点误差产生参数冲突。 */
function roundCredits(amount: number) {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

/**
 * 固定 phase/sourceRef 的意图只创建一次；任务/目标不可变，较小请求复用首次金额。
 * 持久化失败直接抛出，禁止继续退款。只接受并落库白名单财务字段。
 */
async function persistGenerationRefundIntent(
  input: GenerationRefundIntentInput
) {
  const parsed = refundIntentSchema.parse(input);
  const amount = roundCredits(parsed.amount);
  const targetCredits = roundCredits(parsed.targetCredits);
  const [inserted] = await db
    .insert(generationRefundOutbox)
    .values({
      id: crypto.randomUUID(),
      userId: parsed.userId,
      generationId: parsed.generationId,
      sourceRef: parsed.sourceRef,
      requestedAmount: amount,
      targetCredits,
    })
    .onConflictDoNothing({
      target: [generationRefundOutbox.userId, generationRefundOutbox.sourceRef],
    })
    .returning();
  const existing =
    inserted ??
    (
      await db
        .select()
        .from(generationRefundOutbox)
        .where(
          and(
            eq(generationRefundOutbox.userId, parsed.userId),
            eq(generationRefundOutbox.sourceRef, parsed.sourceRef)
          )
        )
        .limit(1)
    )[0];
  if (!existing) throw new Error("Generation refund intent was not persisted");
  if (
    existing.generationId !== parsed.generationId ||
    amount > Number(existing.requestedAmount) ||
    Number(existing.targetCredits) !== targetCredits
  ) {
    throw new Error("Generation refund intent conflict");
  }
  return existing;
}

/** 持久化失败仅暴露固定错误，不把 Drizzle SQL/参数或输入内容传播到产品日志。 */
export async function enqueueGenerationRefund(
  input: GenerationRefundIntentInput
) {
  try {
    return await persistGenerationRefundIntent(input);
  } catch (error) {
    logRefundFailure(error, { source: "generation-refund-enqueue" });
    if (
      error instanceof Error &&
      error.message === "Generation refund intent conflict"
    )
      throw error;
    throw new Error("Generation refund intent could not be persisted");
  }
}

/** 持久尝试版本只允许本次领取确认，迟到 worker 不得覆盖另一轮的租期或终态。 */
function attemptConditions(intent: Intent) {
  return and(
    eq(generationRefundOutbox.id, intent.id),
    eq(generationRefundOutbox.state, "pending"),
    eq(generationRefundOutbox.attempts, intent.attempts)
  );
}

/**
 * 执行已持久意图，资金提交后才确认；确认/投影失败保留 pending 供幂等重放。
 * 资金提交响应丢失也由 R10 同 sourceRef 查重。这里只记录固定错误类别，不留私密异常。
 */
async function executeIntent(intent: Intent, now: Date) {
  try {
    const granted = await grantCredits({
      userId: intent.userId,
      // settled 的零额/no-debit 意图可能没有退款流水；重放也只核对，不能支付后来的补扣。
      amount: intent.state === "settled" ? 0 : Number(intent.requestedAmount),
      sourceType: "refund",
      debitAccount: "SYSTEM:generation_refund",
      transactionType: "refund",
      sourceRef: intent.sourceRef,
      description: "Generation refund settlement",
      generationRefund: {
        generationId: intent.generationId,
        targetCredits: Number(intent.targetCredits),
      },
      metadata: { generationId: intent.generationId },
    });
    const remainingDebited = granted.remainingDebited;
    if (
      typeof remainingDebited !== "number" ||
      !Number.isFinite(remainingDebited) ||
      remainingDebited < 0
    ) {
      const error = new Error(
        "Generation refund did not return an authoritative remaining debit"
      );
      error.name = "GenerationRefundLedgerError";
      throw error;
    }
    // generation 只是展示投影。仅收敛失败记录且只减不增，防止迟到确认覆盖另一阶段退款。
    // 无 generation 行的 pureRelay/editable 也可正常确认意图。
    await db
      .update(generation)
      .set({
        creditsConsumed: sql`LEAST(${generation.creditsConsumed}, ${remainingDebited})`,
      })
      .where(
        and(
          eq(generation.id, intent.generationId),
          eq(generation.userId, intent.userId),
          eq(generation.status, "failed")
        )
      );
    await db
      .update(generationRefundOutbox)
      .set({ state: "settled", settledAt: now })
      .where(attemptConditions(intent));
    return {
      refunded: !granted.alreadyGranted && granted.amount > 0,
      amount: !granted.alreadyGranted ? granted.amount : 0,
      remainingDebited,
    };
  } catch (error) {
    logRefundFailure(error, {
      id: intent.id,
      generationId: intent.generationId,
      attempts: intent.attempts,
    });
    // 永不耗尽重试：冻结账户等长期失败也保留 pending，解冻/修复后可自动恢复。
    const delayMs = Math.min(
      3_600_000,
      1000 * 2 ** Math.min(intent.attempts, 12)
    );
    try {
      await db
        .update(generationRefundOutbox)
        .set({ nextAttemptAt: new Date(now.getTime() + delayMs) })
        .where(attemptConditions(intent));
    } catch (retryError) {
      logRefundFailure(retryError, {
        id: intent.id,
        generationId: intent.generationId,
        attempts: intent.attempts,
        stage: "retry_schedule",
      });
    }
    throw new Error("Generation refund pending retry");
  }
}

/**
 * 既有退款入口适配：先持久化，再记录租期并同步尝试。重复调用可执行同一意图，
 * R10 事务锁/账本负责资金幂等；租期仅减少后台重复投递，不充当财务锁。
 */
export async function submitGenerationRefund(
  input: GenerationRefundIntentInput
) {
  const intent = await enqueueGenerationRefund(input);
  const now = new Date();
  let attempt: Intent | undefined;
  try {
    [attempt] = await db
      .update(generationRefundOutbox)
      .set({
        attempts: sql`${generationRefundOutbox.attempts} + 1`,
        nextAttemptAt: new Date(now.getTime() + LEASE_MS),
      })
      .where(
        and(
          eq(generationRefundOutbox.id, intent.id),
          eq(generationRefundOutbox.state, "pending")
        )
      )
      .returning();
  } catch (error) {
    logRefundFailure(error, {
      id: intent.id,
      generationId: intent.generationId,
      attempts: intent.attempts,
      stage: "claim",
    });
    throw new Error("Generation refund pending retry");
  }
  return executeIntent(attempt ?? intent, now);
}

/**
 * 后台有界领取：due 条件在 UPDATE 时重查，并持久租期；多个进程扫描同一候选只一方领取。
 * 任意一步退出均由到期租期恢复；单条失败不阻断其他退款，批次读取失败则直接抛出。
 */
async function replayGenerationRefundOutbox(
  options: { now?: Date; limit?: number } = {}
) {
  const now = options.now ?? new Date();
  const limit = z
    .number()
    .int()
    .min(1)
    .max(500)
    .parse(options.limit ?? 100);
  const rows = await db
    .select()
    .from(generationRefundOutbox)
    .where(
      and(
        eq(generationRefundOutbox.state, "pending"),
        lte(generationRefundOutbox.nextAttemptAt, now)
      )
    )
    .orderBy(
      asc(generationRefundOutbox.nextAttemptAt),
      asc(generationRefundOutbox.id)
    )
    .limit(limit);
  const result = { attempted: 0, settled: 0, failed: 0, creditsRefunded: 0 };
  for (const row of rows) {
    const [claimed] = await db
      .update(generationRefundOutbox)
      .set({
        attempts: sql`${generationRefundOutbox.attempts} + 1`,
        nextAttemptAt: new Date(now.getTime() + LEASE_MS),
      })
      .where(
        and(
          eq(generationRefundOutbox.id, row.id),
          eq(generationRefundOutbox.state, "pending"),
          lte(generationRefundOutbox.nextAttemptAt, now)
        )
      )
      .returning();
    if (!claimed) continue;
    result.attempted += 1;
    try {
      const refund = await executeIntent(claimed, now);
      result.settled += 1;
      result.creditsRefunded = roundCredits(
        result.creditsRefunded + refund.amount
      );
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

/** 后台读取/领取错误也只向外传播固定提示，安全摘要留在结构化日志。 */
export async function processGenerationRefundOutbox(
  options: { now?: Date; limit?: number } = {}
) {
  try {
    return await replayGenerationRefundOutbox(options);
  } catch (error) {
    logRefundFailure(error, { source: "generation-refund-replay" });
    throw new Error("Generation refund recovery unavailable");
  }
}
