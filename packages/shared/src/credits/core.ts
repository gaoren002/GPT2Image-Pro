/**
 * 积分系统核心逻辑
 *
 * 实现企业级双重记账和 FIFO 过期机制
 */

import {
  and,
  asc,
  eq,
  gte,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";

import { db } from "@repo/database";
import {
  type CreditsBatchSource,
  type CreditsTransactionType,
  creditsBalance,
  creditsBatch,
  creditsTransaction,
} from "@repo/database/schema";
import { logEvent } from "../logger/index";
import { getRuntimeSettingNumber } from "../system-settings";
import { CREDIT_CONFIG_DEFAULTS } from "./config";
import {
  isUniqueConstraintViolation,
  readConsumedBatchesFromMetadata,
} from "./idempotency";

const CREDIT_DECIMAL_PLACES = 2;
const CREDIT_DECIMAL_FACTOR = 10 ** CREDIT_DECIMAL_PLACES;

function creditBatchSourcePriorityOrder() {
  return sql`CASE ${creditsBatch.sourceType}
    WHEN 'bonus' THEN 1
    WHEN 'subscription' THEN 2
    WHEN 'purchase' THEN 3
    ELSE 4
  END`;
}

function creditBatchExpiryOrder() {
  return sql`${creditsBatch.expiresAt} IS NULL`;
}

async function getDefaultCreditsExpiryDate(issuedAt: Date) {
  const expiryDays = await getRuntimeSettingNumber(
    "CREDITS_EXPIRY_DAYS",
    CREDIT_CONFIG_DEFAULTS.creditsExpiryDays,
    { nonNegative: true }
  );
  if (expiryDays <= 0) return null;
  return new Date(issuedAt.getTime() + expiryDays * 24 * 60 * 60 * 1000);
}

async function getFreeCreditsExpiryDays() {
  return getRuntimeSettingNumber(
    "FREE_CREDITS_EXPIRY_DAYS",
    CREDIT_CONFIG_DEFAULTS.freeCreditsExpiryDays,
    { positive: true }
  );
}

async function getFreeCreditsExpiryDate(issuedAt: Date) {
  const expiryDays = await getFreeCreditsExpiryDays();
  return new Date(issuedAt.getTime() + expiryDays * 24 * 60 * 60 * 1000);
}

function normalizeCreditAmount(amount: number) {
  if (!Number.isFinite(amount)) {
    throw new Error("积分数量必须是有效数字");
  }
  return (
    Math.round((amount + Number.EPSILON) * CREDIT_DECIMAL_FACTOR) /
    CREDIT_DECIMAL_FACTOR
  );
}

// ============================================
// 类型定义
// ============================================

/**
 * 发放积分参数
 */
export interface GrantCreditsParams {
  /** 用户 ID */
  userId: string;
  /** 积分数量 */
  amount: number;
  /** 来源类型 */
  sourceType: CreditsBatchSource;
  /** 借方账户（资金来源） */
  debitAccount: string;
  /** 交易类型 */
  transactionType: CreditsTransactionType;
  /** 过期时间，默认按系统积分有效期计算 */
  expiresAt?: Date | null;
  /** 来源引用（如订单 ID） */
  sourceRef?: string;
  /** 描述 */
  description?: string;
  /** 元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 消费积分参数
 */
export interface ConsumeCreditsParams {
  /** 用户 ID */
  userId: string;
  /** 消费数量 */
  amount: number;
  /** 服务名称 */
  serviceName: string;
  /** 描述 */
  description?: string;
  /**
   * 来源引用（幂等键）。传入后，同一 (consumption, sourceRef) 只扣费一次：
   * 重试/并发的重复扣费会被偏唯一索引拒绝并安全跳过，返回首次扣费结果。
   * 不传则行为与历史一致（不幂等）。
   */
  sourceRef?: string;
  /** 元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 积分消费结果
 */
export interface ConsumeCreditsResult {
  /** 是否成功 */
  success: boolean;
  /** 实际消费数量 */
  consumedAmount: number;
  /** 剩余余额 */
  remainingBalance: number;
  /** 交易 ID */
  transactionId: string;
  /** 消费的批次详情 */
  consumedBatches: Array<{
    batchId: string;
    consumedFromBatch: number;
  }>;
  /** 是否为幂等命中（重复 sourceRef，未实际再次扣费） */
  alreadyConsumed?: boolean;
}

/**
 * 套餐升级作废旧订阅积分参数
 */
export interface VoidSubscriptionCreditsForUpgradeParams {
  /** 用户 ID */
  userId: string;
  /** 新套餐积分批次 sourceRef，避免刚发放的新积分被作废 */
  newBatchSourceRef?: string;
  /** 订阅 ID */
  subscriptionId?: string;
  /** 旧套餐价格 ID */
  upgradeFromPriceId?: string;
  /** 新套餐价格 ID */
  upgradeToPriceId?: string;
  /** 只作废此时间之前发放的订阅积分，避免重复回调误扣后续周期积分 */
  issuedBefore?: Date;
  /** 描述 */
  description?: string;
  /** 元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 积分余额错误
 */
export class InsufficientCreditsError extends Error {
  constructor(
    public required: number,
    public available: number
  ) {
    super(`积分不足: 需要 ${required}，可用 ${available}`);
    this.name = "InsufficientCreditsError";
  }
}

/**
 * 账户冻结错误
 */
export class AccountFrozenError extends Error {
  constructor(userId: string) {
    super(`用户 ${userId} 的积分账户已被冻结`);
    this.name = "AccountFrozenError";
  }
}

// ============================================
// 核心函数
// ============================================

/**
 * 确保用户有积分账户
 *
 * 如果账户不存在则创建
 */
export async function ensureCreditsBalance(userId: string) {
  const [existing] = await db
    .select()
    .from(creditsBalance)
    .where(eq(creditsBalance.userId, userId))
    .limit(1);

  if (existing) {
    return existing;
  }

  const [newBalance] = await db
    .insert(creditsBalance)
    .values({
      id: crypto.randomUUID(),
      userId,
      balance: 0,
      totalEarned: 0,
      totalSpent: 0,
      status: "active",
    })
    .returning();

  if (!newBalance) {
    throw new Error("创建积分账户失败");
  }

  return newBalance;
}

/**
 * 获取用户积分余额
 */
export async function getCreditsBalance(userId: string) {
  await processExpiredBatches({ userId });
  return await ensureCreditsBalance(userId);
}

/**
 * 确保用户获得注册奖励
 *
 * 懒加载机制：
 * 1. 检查用户是否已经领过注册奖励
 * 2. 如果没有注册奖励交易，补发注册奖励
 * 3. 这种方式比在注册时发放更安全，避免 Auth Hook 失败导致的问题
 *
 * @param userId 用户 ID
 * @param bonusAmount 注册奖励积分数量
 */
export async function ensureRegistrationBonus(
  userId: string,
  bonusAmount: number
) {
  const [existingTransaction] = await db
    .select({ id: creditsTransaction.id })
    .from(creditsTransaction)
    .where(
      and(
        eq(creditsTransaction.userId, userId),
        eq(creditsTransaction.type, "registration_bonus")
      )
    )
    .limit(1);

  if (existingTransaction) {
    await ensureRegistrationBonusExpiry(userId);
    return { granted: false, reason: "Registration bonus already granted" };
  }

  const issuedAt = new Date();
  const result = await grantCredits({
    userId,
    amount: bonusAmount,
    sourceType: "bonus",
    debitAccount: "SYSTEM:registration_bonus",
    transactionType: "registration_bonus",
    expiresAt: await getFreeCreditsExpiryDate(issuedAt),
    sourceRef: `registration_bonus:${userId}`,
    description: "新用户注册奖励",
    metadata: {
      bonusType: "registration",
      grantedAt: issuedAt.toISOString(),
    },
  });

  return {
    granted: true,
    ...result,
  };
}

/**
 * 注册奖励积分默认 7 天过期。保留这个修正逻辑可以让之前被设为
 * 永不过期的活跃注册奖励批次，在用户下次读取余额时自动改回 7 天有效期。
 */
export async function ensureRegistrationBonusExpiry(userId: string) {
  const sourceRef = `registration_bonus:${userId}`;
  const expiryDays = await getFreeCreditsExpiryDays();

  const updatedBatches = await db
    .update(creditsBatch)
    .set({
      expiresAt: sql`${creditsBatch.issuedAt} + (${expiryDays} * interval '1 day')`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(creditsBatch.userId, userId),
        eq(creditsBatch.sourceType, "bonus"),
        eq(creditsBatch.status, "active"),
        or(
          eq(creditsBatch.sourceRef, sourceRef),
          isNull(creditsBatch.sourceRef)
        ),
        or(
          isNull(creditsBatch.expiresAt),
          gt(
            creditsBatch.expiresAt,
            sql`${creditsBatch.issuedAt} + (${expiryDays} * interval '1 day')`
          )
        )
      )
    )
    .returning({ id: creditsBatch.id });

  if (updatedBatches.length > 0) {
    await processExpiredBatches();
  }
}

/**
 * 续费顺延订阅积分批次有效期（系统设置 CREDITS_RENEWAL_EXTENDS_EXPIRY 开启时由支付回调调用）。
 *
 * 语义：把该用户名下【未到期、到期日早于新周期结束日】的订阅类（sourceType=
 * "subscription"）active 批次 expiresAt 统一抬到 newExpiresAt。只延长、不缩短
 * （新发放批次到期日恰为 newExpiresAt，天然被排除）；已过期批次不追溯；积分包/
 * 免费积分等非订阅批次不受影响；Epay 升级路径的旧批次已被作废（status 非 active）
 * 同样不会命中。天然幂等：重复执行无满足条件的行，返回 0。
 *
 * WHY 按 sourceType 而非订阅 id 过滤：credits_batch 无 debitAccount/订阅外键
 * （Epay 批次 sourceRef 是订单号，映射不落批列表）；用户视角"我的订阅积分"本就
 * 不区分是哪一次订阅所发，跨订阅续订顺延在产品语义上成立。
 *
 * @returns 顺延的批次数（供调用方记日志/审计）
 */
export async function extendActiveSubscriptionBatchesExpiry(params: {
  userId: string;
  subscriptionId: string;
  newExpiresAt: Date;
}): Promise<number> {
  const { userId, newExpiresAt } = params;
  if (Number.isNaN(newExpiresAt.getTime())) return 0;
  const now = new Date();

  const extended = await db
    .update(creditsBatch)
    .set({ expiresAt: newExpiresAt, updatedAt: now })
    .where(
      and(
        eq(creditsBatch.userId, userId),
        eq(creditsBatch.sourceType, "subscription"),
        eq(creditsBatch.status, "active"),
        isNotNull(creditsBatch.expiresAt),
        // 只顺延未过期且比新周期结束日更早的批次：不缩短、不碰已过期、不碰新批次
        gt(creditsBatch.expiresAt, now),
        lt(creditsBatch.expiresAt, newExpiresAt)
      )
    )
    .returning({ id: creditsBatch.id, remaining: creditsBatch.remaining });

  return extended.length;
}

/**
 * 发放积分
 *
 * 在事务中执行：
 * 1. 创建积分批次
 * 2. 记录交易（双重记账）
 * 3. 更新余额
 */
export async function grantCredits(params: GrantCreditsParams) {
  const {
    userId,
    sourceType,
    debitAccount,
    transactionType,
    expiresAt,
    sourceRef,
    description,
    metadata,
  } = params;
  const amount = normalizeCreditAmount(params.amount);

  if (amount <= 0) {
    throw new Error("积分数量必须大于 0");
  }

  return await db.transaction(async (tx) => {
    const [balanceRecord] = await tx
      .select()
      .from(creditsBalance)
      .where(eq(creditsBalance.userId, userId))
      .limit(1);

    let currentBalance = balanceRecord;

    if (!currentBalance) {
      const [newBalance] = await tx
        .insert(creditsBalance)
        .values({
          id: crypto.randomUUID(),
          userId,
          balance: 0,
          totalEarned: 0,
          totalSpent: 0,
          status: "active",
        })
        .returning();

      if (!newBalance) {
        throw new Error("创建积分账户失败");
      }

      currentBalance = newBalance;
    }

    if (currentBalance.status === "frozen") {
      throw new AccountFrozenError(userId);
    }

    const issuedAt = new Date();
    const effectiveExpiresAt =
      expiresAt === undefined
        ? sourceType === "bonus"
          ? await getFreeCreditsExpiryDate(issuedAt)
          : await getDefaultCreditsExpiryDate(issuedAt)
        : expiresAt;
    const batchId = crypto.randomUUID();
    const insertedBatch = await tx
      .insert(creditsBatch)
      .values({
        id: batchId,
        userId,
        amount,
        remaining: amount,
        issuedAt,
        expiresAt: effectiveExpiresAt,
        status: "active",
        sourceType,
        sourceRef,
      })
      .onConflictDoNothing({
        target: [creditsBatch.sourceType, creditsBatch.sourceRef],
        where: sql`${creditsBatch.sourceRef} is not null`,
      })
      .returning({ id: creditsBatch.id });

    // 幂等性保障：(sourceType, sourceRef) 唯一索引使重复发放的插入为空。
    // 此时跳过记账与余额累加，避免支付 webhook 重放 / 并发回调 / 注册奖励
    // 重复领取导致的积分双重发放（薅羊毛）。
    if (insertedBatch.length === 0) {
      return {
        batchId: null,
        transactionId: null,
        amount: 0,
        newBalance: currentBalance.balance,
        alreadyGranted: true,
      };
    }

    const transactionId = crypto.randomUUID();
    const creditAccount = `WALLET:${userId}`;

    await tx.insert(creditsTransaction).values({
      id: transactionId,
      userId,
      type: transactionType,
      amount,
      debitAccount,
      creditAccount,
      description,
      metadata: {
        ...metadata,
        batchId,
        sourceRef,
      },
    });

    await tx
      .update(creditsBalance)
      .set({
        balance: sql`${creditsBalance.balance} + ${amount}`,
        totalEarned: sql`${creditsBalance.totalEarned} + ${amount}`,
        updatedAt: new Date(),
      })
      .where(eq(creditsBalance.userId, userId));

    // 注意: newBalance 是基于事务开始时快照的预估值，在并发事务下可能不精确。
    // 需要精确余额的调用方应在事务完成后调用 getCreditsBalance()。
    return {
      batchId,
      transactionId,
      amount,
      newBalance: currentBalance.balance + amount,
      alreadyGranted: false,
    };
  });
}

/**
 * 消费积分 (FIFO)
 *
 * 核心 FIFO 逻辑：
 * 1. 获取所有活跃批次，按过期时间升序排列（最早过期的优先消费）
 * 2. 循环扣除直到满足需求
 * 3. 更新批次状态和余额
 * 4. 记录交易
 */
export async function consumeCredits(
  params: ConsumeCreditsParams
): Promise<ConsumeCreditsResult> {
  const { userId, serviceName, description, metadata, sourceRef } = params;
  const amount = normalizeCreditAmount(params.amount);

  if (amount <= 0) {
    throw new Error("消费数量必须大于 0");
  }

  await processExpiredBatches({ userId });

  try {
    return await db.transaction(async (tx) => {
      // 幂等快路：已存在相同 (userId, consumption, sourceRef) 的交易 → 不重复扣费。
      // 覆盖串行重试场景；并发场景由下方偏唯一索引兜底。
      // WHY 必须按 userId 归属：sourceRef 派生自服务端随机 generationId，理论上全局
      // 唯一；但幂等命中会把命中交易的 amount/metadata（consumedBatches）回放给调用方。
      // 若跨用户碰撞（旧的全局 (type, source_ref) 约束允许同一 sourceRef 仅存在一行，
      // 一旦被他人占用，本人的合法扣费会误命中他人交易并返回其金额/批次明细，造成
      // 越权信息泄露且本人实际未扣费）。加 eq(userId) 后只在本人交易内幂等，配合 0029
      // 收窄到 per-user 偏唯一索引，跨用户相同 sourceRef 互不干扰。
      if (sourceRef) {
        const [existing] = await tx
          .select({
            id: creditsTransaction.id,
            amount: creditsTransaction.amount,
            metadata: creditsTransaction.metadata,
          })
          .from(creditsTransaction)
          .where(
            and(
              eq(creditsTransaction.userId, userId),
              eq(creditsTransaction.type, "consumption"),
              eq(creditsTransaction.sourceRef, sourceRef)
            )
          )
          .limit(1);
        if (existing) {
          const [balance] = await tx
            .select({ balance: creditsBalance.balance })
            .from(creditsBalance)
            .where(eq(creditsBalance.userId, userId))
            .limit(1);
          return {
            success: true,
            consumedAmount: existing.amount,
            remainingBalance: balance?.balance ?? 0,
            transactionId: existing.id,
            consumedBatches: readConsumedBatchesFromMetadata(existing.metadata),
            alreadyConsumed: true,
          };
        }
      }

      const [balanceRecord] = await tx
        .select()
        .from(creditsBalance)
        .where(eq(creditsBalance.userId, userId))
        .limit(1);

      if (!balanceRecord) {
        throw new InsufficientCreditsError(amount, 0);
      }

      if (balanceRecord.status === "frozen") {
        throw new AccountFrozenError(userId);
      }

      if (balanceRecord.balance < amount) {
        throw new InsufficientCreditsError(amount, balanceRecord.balance);
      }

      let remainingToConsume = amount;
      const consumedBatches: Array<{
        batchId: string;
        consumedFromBatch: number;
      }> = [];

      while (remainingToConsume > 0) {
        const now = new Date();
        const [batch] = await tx
          .select()
          .from(creditsBatch)
          .where(
            and(
              eq(creditsBatch.userId, userId),
              eq(creditsBatch.status, "active"),
              gt(creditsBatch.remaining, 0),
              or(isNull(creditsBatch.expiresAt), gt(creditsBatch.expiresAt, now))
            )
          )
          // 扣减顺序:最快到期的批次先扣(在过期作废前尽量用掉),无到期(永久)批次最后扣;
          // 同到期时间再按来源优先级(bonus→subscription→purchase),最后按发放时间。
          .orderBy(
            creditBatchExpiryOrder(),
            asc(creditsBatch.expiresAt),
            creditBatchSourcePriorityOrder(),
            asc(creditsBatch.issuedAt)
          )
          .limit(1);

        if (!batch) {
          break;
        }

        const consumeFromThisBatch = Math.min(
          batch.remaining,
          remainingToConsume
        );
        const newRemainingSql = sql`${creditsBatch.remaining} - ${consumeFromThisBatch}`;
        const nextStatusSql = sql`(CASE WHEN ${newRemainingSql} <= 0 THEN 'consumed' ELSE 'active' END)::credits_batch_status`;

        const [updatedBatch] = await tx
          .update(creditsBatch)
          .set({
            remaining: newRemainingSql,
            status: nextStatusSql,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(creditsBatch.id, batch.id),
              eq(creditsBatch.status, "active"),
              gte(creditsBatch.remaining, consumeFromThisBatch),
              or(isNull(creditsBatch.expiresAt), gt(creditsBatch.expiresAt, now))
            )
          )
          .returning({ id: creditsBatch.id });

        if (!updatedBatch) {
          continue;
        }

        consumedBatches.push({
          batchId: batch.id,
          consumedFromBatch: consumeFromThisBatch,
        });

        remainingToConsume -= consumeFromThisBatch;
      }

      if (remainingToConsume > 0) {
        throw new InsufficientCreditsError(amount, amount - remainingToConsume);
      }

      const transactionId = crypto.randomUUID();
      const debitAccount = `WALLET:${userId}`;
      const creditAccount = `SERVICE:${serviceName}`;

      // 带 sourceRef 写入：偏唯一索引 (type, source_ref) 使并发重复扣费的第二次
      // INSERT 触发唯一冲突，整个事务回滚（批次扣减一并撤销），由外层 catch 重查兜底。
      await tx.insert(creditsTransaction).values({
        id: transactionId,
        userId,
        type: "consumption",
        amount,
        debitAccount,
        creditAccount,
        description: description ?? `消费于 ${serviceName}`,
        sourceRef,
        metadata: {
          ...metadata,
          serviceName,
          consumedBatches,
        },
      });

      const [updatedBalance] = await tx
        .update(creditsBalance)
        .set({
          balance: sql`${creditsBalance.balance} - ${amount}`,
          totalSpent: sql`${creditsBalance.totalSpent} + ${amount}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(creditsBalance.userId, userId),
            gte(creditsBalance.balance, amount)
          )
        )
        .returning({ newBalance: creditsBalance.balance });

      if (!updatedBalance) {
        throw new InsufficientCreditsError(amount, balanceRecord.balance);
      }

      return {
        success: true,
        consumedAmount: amount,
        remainingBalance: updatedBalance.newBalance,
        transactionId,
        consumedBatches,
      };
    });
  } catch (error) {
    // 并发兜底：唯一索引冲突表示已被另一并发请求以相同 sourceRef 扣过 →
    // 重查该交易返回幂等结果，避免双重扣费。
    // WHY 同样按 userId 归属：0029 后偏唯一索引为 (user_id, type, source_ref)，冲突
    // 必来自同一用户的并发重复请求，重查须限定本人交易，否则在跨用户碰撞时会回放他人
    // 金额/批次明细（越权）。与上方快路保持一致。
    if (sourceRef && isUniqueConstraintViolation(error)) {
      const [existing] = await db
        .select({
          id: creditsTransaction.id,
          amount: creditsTransaction.amount,
          metadata: creditsTransaction.metadata,
        })
        .from(creditsTransaction)
        .where(
          and(
            eq(creditsTransaction.userId, userId),
            eq(creditsTransaction.type, "consumption"),
            eq(creditsTransaction.sourceRef, sourceRef)
          )
        )
        .limit(1);
      if (existing) {
        const [balance] = await db
          .select({ balance: creditsBalance.balance })
          .from(creditsBalance)
          .where(eq(creditsBalance.userId, userId))
          .limit(1);
        return {
          success: true,
          consumedAmount: existing.amount,
          remainingBalance: balance?.balance ?? 0,
          transactionId: existing.id,
          consumedBatches: readConsumedBatchesFromMetadata(existing.metadata),
          alreadyConsumed: true,
        };
      }
    }
    throw error;
  }
}

/**
 * 套餐升级后作废旧套餐剩余积分。
 *
 * 只处理 sourceType=subscription 的活跃批次，不影响免费积分和按量购买积分。
 * 重复支付回调不会重复扣减，因为已作废批次不再是 active。
 */
export async function voidActiveSubscriptionCreditsForUpgrade(
  params: VoidSubscriptionCreditsForUpgradeParams
) {
  const {
    userId,
    newBatchSourceRef,
    subscriptionId,
    upgradeFromPriceId,
    upgradeToPriceId,
    issuedBefore,
    description,
    metadata,
  } = params;

  return await db.transaction(async (tx) => {
    const batches = await tx
      .select({
        id: creditsBatch.id,
        amount: creditsBatch.amount,
        remaining: creditsBatch.remaining,
        sourceRef: creditsBatch.sourceRef,
        issuedAt: creditsBatch.issuedAt,
        expiresAt: creditsBatch.expiresAt,
      })
      .from(creditsBatch)
      .where(
        and(
          eq(creditsBatch.userId, userId),
          eq(creditsBatch.sourceType, "subscription"),
          eq(creditsBatch.status, "active"),
          gt(creditsBatch.remaining, 0),
          issuedBefore
            ? lt(creditsBatch.issuedAt, issuedBefore)
            : sql`true`,
          newBatchSourceRef
            ? sql`${creditsBatch.sourceRef} IS DISTINCT FROM ${newBatchSourceRef}`
            : sql`true`
        )
      )
      .orderBy(
        creditBatchExpiryOrder(),
        asc(creditsBatch.expiresAt),
        asc(creditsBatch.issuedAt)
      );

    const voidedBatches: Array<{
      batchId: string;
      voidedAmount: number;
      sourceRef: string | null;
    }> = [];

    for (const batch of batches) {
      const [voidedBatch] = await tx
        .update(creditsBatch)
        .set({
          status: "expired",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(creditsBatch.id, batch.id),
            eq(creditsBatch.status, "active"),
            gt(creditsBatch.remaining, 0)
          )
        )
        .returning({
          id: creditsBatch.id,
          amount: creditsBatch.amount,
          remaining: creditsBatch.remaining,
          sourceRef: creditsBatch.sourceRef,
          issuedAt: creditsBatch.issuedAt,
          expiresAt: creditsBatch.expiresAt,
        });

      if (!voidedBatch) continue;

      await tx.insert(creditsTransaction).values({
        id: crypto.randomUUID(),
        userId,
        type: "expiration",
        amount: voidedBatch.remaining,
        debitAccount: `WALLET:${userId}`,
        creditAccount: "SYSTEM:subscription_upgrade",
        description:
          description ?? `套餐升级作废旧订阅积分批次 ${voidedBatch.id}`,
        metadata: {
          ...metadata,
          reason: "subscription_upgrade",
          batchId: voidedBatch.id,
          sourceRef: voidedBatch.sourceRef,
          originalAmount: voidedBatch.amount,
          voidedAmount: voidedBatch.remaining,
          issuedAt: voidedBatch.issuedAt,
          expiresAt: voidedBatch.expiresAt,
          subscriptionId,
          upgradeFromPriceId,
          upgradeToPriceId,
          newBatchSourceRef,
          issuedBefore,
        },
      });

      voidedBatches.push({
        batchId: voidedBatch.id,
        voidedAmount: voidedBatch.remaining,
        sourceRef: voidedBatch.sourceRef,
      });
    }

    if (voidedBatches.length > 0) {
      const totalVoided = normalizeCreditAmount(
        voidedBatches.reduce((sum, batch) => sum + batch.voidedAmount, 0)
      );

      await tx
        .update(creditsBalance)
        .set({
          balance: sql`GREATEST(0, ${creditsBalance.balance} - ${totalVoided})`,
          updatedAt: new Date(),
        })
        .where(eq(creditsBalance.userId, userId));

      return {
        voidedAmount: totalVoided,
        voidedBatches,
      };
    }

    return {
      voidedAmount: 0,
      voidedBatches,
    };
  });
}

/**
 * 处理过期批次
 *
 * 扫描并标记所有过期的批次，同时更新用户余额。
 * 使用条件更新保证同一批次在并发运行时只会被处理一次。
 */
export async function processExpiredBatches(options?: { userId?: string }) {
  const now = new Date();

  const expiredBatches = await db
    .select({
      id: creditsBatch.id,
    })
    .from(creditsBatch)
    .where(
      and(
        eq(creditsBatch.status, "active"),
        options?.userId ? eq(creditsBatch.userId, options.userId) : sql`true`,
        lt(creditsBatch.expiresAt, now),
        gt(creditsBatch.remaining, 0)
      )
    );

  const results: Array<{
    batchId: string;
    userId: string;
    expiredAmount: number;
  }> = [];

  for (const batch of expiredBatches) {
    await db.transaction(async (tx) => {
      const [expiredBatch] = await tx
        .update(creditsBatch)
        .set({
          status: "expired",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(creditsBatch.id, batch.id),
            eq(creditsBatch.status, "active"),
            gt(creditsBatch.remaining, 0)
          )
        )
        .returning({
          id: creditsBatch.id,
          userId: creditsBatch.userId,
          amount: creditsBatch.amount,
          remaining: creditsBatch.remaining,
          expiresAt: creditsBatch.expiresAt,
        });

      if (!expiredBatch) {
        return;
      }

      const transactionId = crypto.randomUUID();
      await tx.insert(creditsTransaction).values({
        id: transactionId,
        userId: expiredBatch.userId,
        type: "expiration",
        amount: expiredBatch.remaining,
        debitAccount: `WALLET:${expiredBatch.userId}`,
        creditAccount: "SYSTEM:expired",
        description: `批次 ${expiredBatch.id} 过期`,
        metadata: {
          batchId: expiredBatch.id,
          originalAmount: expiredBatch.amount,
          expiredAmount: expiredBatch.remaining,
          expiresAt: expiredBatch.expiresAt,
        },
      });

      await tx
        .update(creditsBalance)
        .set({
          balance: sql`GREATEST(0, ${creditsBalance.balance} - ${expiredBatch.remaining})`,
          updatedAt: new Date(),
        })
        .where(eq(creditsBalance.userId, expiredBatch.userId));

      results.push({
        batchId: expiredBatch.id,
        userId: expiredBatch.userId,
        expiredAmount: expiredBatch.remaining,
      });
    });
  }

  if (results.length > 0) {
    const totalExpired = results.reduce(
      (sum, item) => sum + item.expiredAmount,
      0
    );
    logEvent("credits.expired", {
      count: results.length,
      totalExpired,
    });
  }

  return results;
}

/**
 * 获取用户的活跃批次列表
 */
export async function getUserActiveBatches(userId: string) {
  const now = new Date();

  return await db
    .select()
    .from(creditsBatch)
    .where(
      and(
        eq(creditsBatch.userId, userId),
        eq(creditsBatch.status, "active"),
        gt(creditsBatch.remaining, 0),
        or(isNull(creditsBatch.expiresAt), gt(creditsBatch.expiresAt, now))
      )
    )
    .orderBy(
      creditBatchSourcePriorityOrder(),
      creditBatchExpiryOrder(),
      asc(creditsBatch.expiresAt),
      asc(creditsBatch.issuedAt)
    );
}

/**
 * 获取用户的交易历史
 */
function userTransactionsWhere(
  userId: string,
  types?: CreditsTransactionType[]
) {
  return types?.length
    ? and(
        eq(creditsTransaction.userId, userId),
        inArray(creditsTransaction.type, types)
      )
    : eq(creditsTransaction.userId, userId);
}

export async function getUserTransactions(
  userId: string,
  options?: {
    limit?: number;
    offset?: number;
    types?: CreditsTransactionType[];
  }
) {
  const { limit = 20, offset = 0, types } = options ?? {};

  return await db
    .select()
    .from(creditsTransaction)
    .where(userTransactionsWhere(userId, types))
    .orderBy(sql`${creditsTransaction.createdAt} DESC`)
    .limit(limit)
    .offset(offset);
}

/**
 * 获取用户交易总数
 */
export async function getUserTransactionsCount(
  userId: string,
  options?: { types?: CreditsTransactionType[] }
): Promise<number> {
  const types = options?.types;
  const [result] = await db
    .select({
      count: sql<number>`count(*)`.mapWith(Number),
    })
    .from(creditsTransaction)
    .where(userTransactionsWhere(userId, types));

  return result?.count ?? 0;
}

/**
 * 冻结用户积分账户
 */
export async function freezeCreditsAccount(userId: string) {
  await db
    .update(creditsBalance)
    .set({
      status: "frozen",
      updatedAt: new Date(),
    })
    .where(eq(creditsBalance.userId, userId));
}

/**
 * 解冻用户积分账户
 */
export async function unfreezeCreditsAccount(userId: string) {
  await db
    .update(creditsBalance)
    .set({
      status: "active",
      updatedAt: new Date(),
    })
    .where(eq(creditsBalance.userId, userId));
}
