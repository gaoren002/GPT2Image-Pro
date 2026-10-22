"use server";

/**
 * 积分系统 Server Actions
 *
 * 提供积分系统的前端调用接口
 */

import { db } from "@repo/database";
import { creditsTransaction, externalApiKey } from "@repo/database/schema";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getBaseUrl } from "../config/payment";
import {
  isPlanAtLeast,
  type SubscriptionPlan,
} from "../config/subscription-plan";
import { logEvent } from "../logger/index";
import { creem } from "../payment/creem";
import {
  createRuntimeEpayPurchase,
  isRuntimeEpayPaymentProvider,
  saveEpayOrder,
} from "../payment/epay";
import { protectedAction } from "../safe-action";
import { getUserPlanType } from "../subscription/services/user-plan";
import { getRuntimeSettingNumber } from "../system-settings";

import { CREDIT_CONFIG_DEFAULTS, isCreditPackageVisible } from "./config";
import {
  AccountFrozenError,
  consumeCredits,
  ensureRegistrationBonusExpiry,
  getCreditsBalance,
  getSidebarCreditsBalance,
  getUserActiveBatches,
  getUserTransactions,
  getUserTransactionsCount,
  grantCredits,
  InsufficientCreditsError,
} from "./core";
import {
  getCreditPackageCreemProductIdForPlan,
  getCreditPackagePriceForPlan,
  getRuntimeCreditPackageById,
  getRuntimeCreditPackages,
} from "./packages";

const withProtectedCreditsAction = (name: string) =>
  protectedAction.metadata({ action: `credits.${name}` });

const CREDIT_PACKAGE_MAX_QUANTITY = 999;
const creditsTransactionTypeSchema = z.enum([
  "purchase",
  "consumption",
  "monthly_grant",
  "registration_bonus",
  "admin_grant",
  "expiration",
  "refund",
]);

async function getRuntimeRegistrationBonusCredits() {
  return getRuntimeSettingNumber(
    "REGISTRATION_BONUS_CREDITS",
    CREDIT_CONFIG_DEFAULTS.registrationBonusCredits,
    { positive: true }
  );
}

async function getRuntimeFreeCreditsExpiryDays() {
  return getRuntimeSettingNumber(
    "FREE_CREDITS_EXPIRY_DAYS",
    CREDIT_CONFIG_DEFAULTS.freeCreditsExpiryDays,
    { positive: true }
  );
}

function getExpiryDate(expiryDays: number) {
  return expiryDays
    ? new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000)
    : null;
}

async function getUserPlanForCreditsAction(
  userId: string
): Promise<SubscriptionPlan> {
  return getUserPlanType(userId);
}

// ============================================
// 受保护 Actions（需要登录）
// ============================================

/**
 * 注册奖励积分
 *
 * 需要登录，且每个用户只能领取一次
 */
export const grantRegistrationBonus = withProtectedCreditsAction(
  "grantRegistrationBonus"
)
  .schema(z.object({}))
  .action(async ({ ctx }) => {
    const { userId } = ctx;

    // 幂等性检查：查询是否已发放过注册奖励
    const existing = await db
      .select({ id: creditsTransaction.id })
      .from(creditsTransaction)
      .where(
        and(
          eq(creditsTransaction.userId, userId),
          eq(creditsTransaction.type, "registration_bonus")
        )
      )
      .limit(1);

    if (existing.length > 0) {
      await ensureRegistrationBonusExpiry(userId);
      return { success: true, alreadyGranted: true };
    }

    const bonusCredits = await getRuntimeRegistrationBonusCredits();
    const freeExpiryDays = await getRuntimeFreeCreditsExpiryDays();

    const result = await grantCredits({
      userId,
      amount: bonusCredits,
      sourceType: "bonus",
      debitAccount: "SYSTEM:registration_bonus",
      transactionType: "registration_bonus",
      expiresAt: getExpiryDate(freeExpiryDays),
      sourceRef: `registration_bonus:${userId}`,
      description: "新用户注册奖励",
      metadata: {
        bonusType: "registration",
      },
    });

    return {
      success: true,
      ...result,
    };
  });

/**
 * 获取当前用户积分余额
 *
 * 包含懒加载注册奖励机制:
 * 首次调用时，如果用户没有领过注册奖励，会自动发放注册奖励
 */
export const getMyCreditsBalance = withProtectedCreditsAction(
  "getMyCreditsBalance"
).action(async ({ ctx }) => {
  const { userId } = ctx;

  // 注册奖励兜底 + 余额(与 dashboard SSR 预取共用同一语义)
  const balance = await getSidebarCreditsBalance(userId);

  return {
    balance: balance.balance,
    totalEarned: balance.totalEarned,
    totalSpent: balance.totalSpent,
    status: balance.status,
  };
});

/**
 * 获取当前用户活跃批次
 */
export const getMyActiveBatches = withProtectedCreditsAction(
  "getMyActiveBatches"
).action(async ({ ctx }) => {
  const { userId } = ctx;
  const batches = await getUserActiveBatches(userId);

  return batches.map((batch) => ({
    id: batch.id,
    amount: batch.amount,
    remaining: batch.remaining,
    issuedAt: batch.issuedAt,
    expiresAt: batch.expiresAt,
    sourceType: batch.sourceType,
  }));
});

/**
 * 获取当前用户交易历史
 */
export const getMyTransactions = withProtectedCreditsAction("getMyTransactions")
  .schema(
    z
      .object({
        limit: z.number().min(1).max(100).optional(),
        offset: z.number().min(0).optional(),
        types: z.array(creditsTransactionTypeSchema).min(1).max(7).optional(),
      })
      .optional()
  )
  .action(async ({ parsedInput, ctx }) => {
    const { userId } = ctx;
    const limit = parsedInput?.limit;
    const offset = parsedInput?.offset;
    const types = parsedInput?.types;

    const [transactions, totalCount] = await Promise.all([
      getUserTransactions(userId, {
        ...(limit !== undefined && { limit }),
        ...(offset !== undefined && { offset }),
        ...(types !== undefined && { types }),
      }),
      getUserTransactionsCount(userId, {
        ...(types !== undefined && { types }),
      }),
    ]);

    // 解析每条交易是哪个外部 API Key 消耗的(issue #26):从 metadata.externalApiKeyId 收集后批量查
    // external_api_key(限定本人,防越权读他人 key),映射成"名称 (••后四位)"。历史无此字段的记录不显示。
    const apiKeyIds = Array.from(
      new Set(
        transactions
          .map((tx) => {
            const id = (tx.metadata as Record<string, unknown> | null)
              ?.externalApiKeyId;
            return typeof id === "string" ? id : null;
          })
          .filter((id): id is string => Boolean(id))
      )
    );
    const apiKeyNameById = new Map<string, string>();
    if (apiKeyIds.length > 0) {
      const keys = await db
        .select({
          id: externalApiKey.id,
          name: externalApiKey.name,
          lastFour: externalApiKey.lastFour,
        })
        .from(externalApiKey)
        .where(
          and(
            eq(externalApiKey.userId, userId),
            inArray(externalApiKey.id, apiKeyIds)
          )
        );
      for (const key of keys) {
        apiKeyNameById.set(key.id, `${key.name} (••${key.lastFour})`);
      }
    }

    return {
      transactions: transactions.map((tx) => {
        const metadata = tx.metadata as Record<string, unknown> | null;
        const apiKeyId = metadata?.externalApiKeyId;
        const apiKeyName =
          typeof apiKeyId === "string"
            ? (apiKeyNameById.get(apiKeyId) ?? null)
            : null;
        return {
          id: tx.id,
          type: tx.type,
          amount: tx.amount,
          debitAccount: tx.debitAccount,
          creditAccount: tx.creditAccount,
          description: tx.description,
          metadata,
          apiKeyName,
          createdAt: tx.createdAt,
        };
      }),
      totalCount,
    };
  });

/**
 * 消费积分
 *
 * 用于 AI 服务等需要消费积分的场景
 */
export const useCredits = withProtectedCreditsAction("useCredits")
  .schema(
    z.object({
      amount: z.number().positive(),
      serviceName: z.string().min(1),
      description: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    })
  )
  .action(async ({ parsedInput, ctx }) => {
    const { userId } = ctx;
    const { amount, serviceName, description, metadata } = parsedInput;

    try {
      const result = await consumeCredits({
        userId,
        amount,
        serviceName,
        ...(description !== undefined && { description }),
        ...(metadata !== undefined && { metadata }),
      });

      logEvent("credits.consumed", {
        userId,
        amount,
        serviceName,
      });

      return {
        success: true,
        consumedAmount: result.consumedAmount,
        remainingBalance: result.remainingBalance,
        transactionId: result.transactionId,
      };
    } catch (error) {
      if (error instanceof InsufficientCreditsError) {
        return {
          success: false,
          error: "insufficient_credits",
          message: error.message,
          required: error.required,
          available: error.available,
        };
      }
      if (error instanceof AccountFrozenError) {
        return {
          success: false,
          error: "account_frozen",
          message: error.message,
        };
      }
      throw error;
    }
  });

/**
 * 检查用户是否有足够积分
 */
export const checkCreditsAvailable = withProtectedCreditsAction(
  "checkCreditsAvailable"
)
  .schema(
    z.object({
      amount: z.number().positive(),
    })
  )
  .action(async ({ parsedInput, ctx }) => {
    const { userId } = ctx;
    const { amount } = parsedInput;

    const balance = await getCreditsBalance(userId);

    // balance 由 ensureCreditsBalance 保证不为 undefined
    return {
      available: balance.balance >= amount && balance.status === "active",
      currentBalance: balance.balance,
      required: amount,
      status: balance.status,
    };
  });

// ============================================
// 积分购买 Checkout
// ============================================

/**
 * 创建积分购买 Checkout Session
 *
 * 创建 Creem Checkout Session 用于购买积分套餐
 * metadata 中包含 type: 'credit_purchase' 和 credits 数量
 * Webhook 会根据这些信息发放积分
 */
export const createCreditsPurchaseCheckout = withProtectedCreditsAction(
  "createCreditsPurchaseCheckout"
)
  .schema(
    z.object({
      packageId: z.string().min(1),
      quantity: z
        .number()
        .int()
        .min(1)
        .max(CREDIT_PACKAGE_MAX_QUANTITY)
        .optional(),
      successUrl: z.string().optional(),
      cancelUrl: z.string().optional(),
    })
  )
  .action(async ({ parsedInput, ctx }) => {
    const { packageId, successUrl } = parsedInput;
    const { userId } = ctx;
    const requestedQuantity = parsedInput.quantity ?? 1;

    // 查找套餐配置
    const userPlan = await getUserPlanForCreditsAction(userId);
    const pkg = await getRuntimeCreditPackageById(packageId, {
      includeHidden: true,
      plan: userPlan,
    });
    if (!pkg) {
      throw new Error("无效的积分套餐");
    }
    if (!isCreditPackageVisible(pkg) && !pkg.requiresPlan) {
      throw new Error("无效的积分套餐");
    }
    if (pkg.requiresPlan && !isPlanAtLeast(userPlan, pkg.requiresPlan)) {
      throw new Error("当前套餐不可购买该积分包");
    }
    if (!pkg.allowQuantity && requestedQuantity !== 1) {
      throw new Error("该积分包不支持数量购买");
    }

    const quantity = pkg.allowQuantity ? requestedQuantity : 1;
    if (pkg.maxQuantity && quantity > pkg.maxQuantity) {
      throw new Error(`购买数量不能超过 ${pkg.maxQuantity}`);
    }
    const unitPrice = getCreditPackagePriceForPlan(pkg, userPlan);
    const creditsAmount = pkg.credits * quantity;
    const totalPrice = unitPrice * quantity;

    const baseUrl = getBaseUrl();

    const useEpay = await isRuntimeEpayPaymentProvider();
    if (!useEpay && quantity > 1) {
      throw new Error("当前支付通道暂不支持数量购买，请分次购买");
    }

    logEvent("payment.checkout.started", {
      userId,
      packageId: pkg.id,
      credits: creditsAmount,
      quantity,
      provider: useEpay ? "epay" : "creem",
      checkoutType: "credits",
    });

    if (useEpay) {
      const outTradeNo = `CR${Date.now()}${crypto.randomUUID().slice(0, 8)}`;
      const metadata = {
        type: "credit_purchase" as const,
        userId,
        outTradeNo,
        packageId: pkg.id,
        quantity,
        creditPlan: userPlan,
      };
      await saveEpayOrder(metadata, totalPrice);
      const checkout = await createRuntimeEpayPurchase({
        outTradeNo,
        name:
          quantity > 1
            ? `GPT2IMAGE Credits ${pkg.credits} x ${quantity}`
            : `GPT2IMAGE Credits ${pkg.credits}`,
        money: totalPrice,
      });

      return {
        url: checkout.url,
        params: checkout.params,
        method: "POST" as const,
      };
    }

    // 创建 Creem Checkout Session（一次性支付）
    // 注意：Creem 需要预先在后台创建产品，这里使用 packageId 作为 product_id
    // 实际使用时需要在 Creem 后台创建对应的积分产品
    const checkout = await creem.createCheckout({
      product_id: getCreditPackageCreemProductIdForPlan(pkg, userPlan),
      success_url:
        successUrl ??
        `${baseUrl}/dashboard/billing?success=true&credits=${creditsAmount}`,
      request_id: `credit_purchase_${userId}_${Date.now()}`,
      metadata: {
        userId,
        type: "credit_purchase", // 关键: Webhook 用此判断类型
        credits: String(creditsAmount),
        packageId: pkg.id,
        quantity: String(quantity),
        planId: userPlan,
        unitPrice: String(unitPrice),
      },
    });

    return { url: checkout.checkout_url };
  });

/**
 * 获取积分套餐列表
 */
export const getCreditPackages = withProtectedCreditsAction(
  "getCreditPackages"
).action(async ({ ctx }) => {
  const userPlan = await getUserPlanForCreditsAction(ctx.userId);
  const packages = await getRuntimeCreditPackages({
    includeHidden: isPlanAtLeast(userPlan, "enterprise"),
    plan: userPlan,
  });
  return packages
    .filter((pkg) => {
      if (pkg.requiresPlan) return isPlanAtLeast(userPlan, pkg.requiresPlan);
      return isCreditPackageVisible(pkg);
    })
    .map((pkg) => ({
      id: pkg.id,
      name: pkg.name,
      nameZh: pkg.nameZh,
      credits: pkg.credits,
      price: getCreditPackagePriceForPlan(pkg, userPlan),
      description: pkg.description,
      descriptionZh: pkg.descriptionZh,
      popular: "popular" in pkg ? pkg.popular : false,
      allowQuantity: Boolean(pkg.allowQuantity),
      maxQuantity: pkg.maxQuantity ?? 1,
    }));
});
