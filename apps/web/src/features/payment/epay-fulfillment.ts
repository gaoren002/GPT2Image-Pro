/** 易支付履约；升级走订单、预留、订阅、账本同事务，普通购买以持久 lease 和冻结计划恢复独立幂等步骤。 */

import { db } from "@repo/database";
import {
  creditsBatch,
  creditsTransaction,
  subscription,
} from "@repo/database/schema";
import {
  findRuntimePlanByPriceId,
  getSubscriptionMonthlyCredits,
  type PaidPlanId,
} from "@repo/shared/config/payment-runtime";
import {
  getPlanFromPriceId,
  isPlanAtLeast,
  isSubscriptionPlan,
} from "@repo/shared/config/subscription-plan";
import {
  CREDIT_CONFIG_DEFAULTS,
  ENTERPRISE_RESOURCE_PACKAGE_ID,
} from "@repo/shared/credits/config";
import {
  extendActiveSubscriptionBatchesExpiry,
  grantCredits,
} from "@repo/shared/credits/core";
import {
  getCreditPackagePriceForPlan,
  getRuntimeCreditPackageById,
} from "@repo/shared/credits/packages";
import { logEvent, logger } from "@repo/shared/logger";
import {
  claimEpayOrderForFulfillment,
  decodeEpayMetadata,
  type EpayFulfillmentLease,
  type EpayFulfillmentPlan,
  type EpayMetadata,
  type EpayVerifyResult,
  finalizeEpayOrderFulfillment,
  getEpayOrderMetadata,
  listRecoverableEpayPayments,
  moneyToCents,
  releaseEpayFulfillmentLease,
  renewEpayFulfillmentLease,
  saveEpayFulfillmentPlan,
  updateEpayOrderStatus,
} from "@repo/shared/payment/epay";
import { settleUpgradePayment } from "@repo/shared/payment/upgrade-reservation";
import { getUserPlanType } from "@repo/shared/subscription/services/user-plan";
import {
  getRuntimeSettingBoolean,
  getRuntimeSettingNumber,
} from "@repo/shared/system-settings";
import { and, eq, sql } from "drizzle-orm";

interface FulfillEpayPaymentResult {
  metadata: EpayMetadata;
}

type EpayFulfillmentSource = "epay-webhook" | "epay-return";

// 进程内只合并同实例请求；持久 lease、冻结计划和批次唯一键负责跨实例恢复。
const inFlightFulfillments = new Map<
  string,
  Promise<FulfillEpayPaymentResult>
>();

async function getCreditPackExpiresAt(paidAt: Date) {
  const expiryDays = await getRuntimeSettingNumber(
    "CREDITS_EXPIRY_DAYS",
    CREDIT_CONFIG_DEFAULTS.creditsExpiryDays,
    { nonNegative: true }
  );
  return expiryDays > 0
    ? new Date(paidAt.getTime() + expiryDays * 24 * 60 * 60 * 1000)
    : null;
}

// 网关回传金额与期望金额（均换算为分）做反欺诈比对，阻止低价/篡改金额套取
// 高价套餐。允许实付不低于期望，且不超出期望 EPAY_AMOUNT_TOLERANCE_CENTS 分，
// 容忍上游四舍五入/手续费导致的轻微多付；任一侧解析为 NaN 视为不匹配。
// 导出以便 DB-free 单测锁定该金额门闩。
const EPAY_AMOUNT_TOLERANCE_CENTS = 10;

export function isExpectedEpayAmount(
  verifyInfo: EpayVerifyResult,
  expectedAmount: number
) {
  const expectedCents = moneyToCents(expectedAmount);
  const paidCents = moneyToCents(verifyInfo.money);
  if (!Number.isFinite(expectedCents) || !Number.isFinite(paidCents)) {
    return false;
  }

  return (
    paidCents >= expectedCents &&
    paidCents <= expectedCents + EPAY_AMOUNT_TOLERANCE_CENTS
  );
}

export async function fulfillSuccessfulEpayPayment(
  verifyInfo: EpayVerifyResult,
  source: EpayFulfillmentSource
): Promise<FulfillEpayPaymentResult> {
  const runningFulfillment = inFlightFulfillments.get(verifyInfo.outTradeNo);
  if (runningFulfillment) {
    return runningFulfillment;
  }

  const fulfillment = fulfillSuccessfulEpayPaymentInner(verifyInfo, source);
  inFlightFulfillments.set(verifyInfo.outTradeNo, fulfillment);

  try {
    return await fulfillment;
  } finally {
    if (inFlightFulfillments.get(verifyInfo.outTradeNo) === fulfillment) {
      inFlightFulfillments.delete(verifyInfo.outTradeNo);
    }
  }
}

async function fulfillSuccessfulEpayPaymentInner(
  verifyInfo: EpayVerifyResult,
  source: EpayFulfillmentSource
): Promise<FulfillEpayPaymentResult> {
  const metadata =
    (await getEpayOrderMetadata(verifyInfo.outTradeNo)) ??
    decodeEpayMetadata(verifyInfo.param);
  if (!metadata || metadata.outTradeNo !== verifyInfo.outTradeNo) {
    await updateEpayOrderStatus(verifyInfo.outTradeNo, "failed");
    throw new Error("Invalid or mismatched Epay metadata");
  }

  if (metadata.checkoutMode === "upgrade") {
    const result = await settleUpgradePayment(verifyInfo);
    return { metadata: result.metadata as unknown as EpayMetadata };
  }

  const claim = await claimEpayOrderForFulfillment(
    verifyInfo.outTradeNo,
    verifyInfo
  );
  if (claim.state === "fulfilled") return { metadata };
  if (claim.state === "busy")
    throw new Error("Epay fulfillment is in progress");
  const { lease } = claim;
  try {
    if (metadata.type === "credit_purchase") {
      await handleCreditPurchase(metadata, verifyInfo, source, lease);
    } else {
      await handleSubscription(metadata, verifyInfo, source, lease);
    }
    await finalizeEpayOrderFulfillment(verifyInfo.outTradeNo, lease.token);
  } catch (error) {
    await releaseEpayFulfillmentLease(verifyInfo.outTradeNo, lease.token);
    throw error;
  }

  return { metadata };
}

/** 积分包计划先持久化再独立 grant；重放不重算有效期或改变已接受的套餐。 */
async function handleCreditPurchase(
  metadata: EpayMetadata,
  verifyInfo: EpayVerifyResult,
  source: EpayFulfillmentSource,
  lease: EpayFulfillmentLease
) {
  const { userId, packageId } = metadata;
  if (!packageId) throw new Error("Missing credit package ID");
  const sourceRef = `epay:${verifyInfo.outTradeNo}`;
  const [existingBatch] = await db
    .select({ id: creditsBatch.id })
    .from(creditsBatch)
    .where(
      and(
        eq(creditsBatch.sourceRef, sourceRef),
        eq(creditsBatch.sourceType, "purchase")
      )
    )
    .limit(1);
  const receipt = existingBatch
    ? null
    : await findPaymentGrantReceipt(userId, sourceRef, "purchase");
  if (existingBatch || receipt) return;
  let plan = lease.plan;
  if (!plan) {
    const currentPlan = await getUserPlanType(userId);
    const purchasePlan = isSubscriptionPlan(metadata.creditPlan)
      ? metadata.creditPlan
      : currentPlan;
    const pkg = await getRuntimeCreditPackageById(packageId, {
      includeHidden: true,
      plan: purchasePlan,
    });
    if (!pkg) throw new Error(`Unknown credit package: ${packageId}`);
    if (
      (packageId === ENTERPRISE_RESOURCE_PACKAGE_ID &&
        !isPlanAtLeast(currentPlan, "enterprise")) ||
      (pkg.requiresPlan && !isPlanAtLeast(currentPlan, pkg.requiresPlan))
    ) {
      throw new Error("Credit package purchase requires a higher plan");
    }
    const quantity =
      Number.isInteger(metadata.quantity) && (metadata.quantity ?? 0) > 0
        ? (metadata.quantity ?? 1)
        : 1;
    if (
      !isExpectedEpayAmount(
        verifyInfo,
        getCreditPackagePriceForPlan(pkg, purchasePlan) * quantity
      )
    ) {
      throw new Error("Epay amount does not match credit package price");
    }
    const expiresAt = await getCreditPackExpiresAt(lease.paidAt);
    plan = await saveEpayFulfillmentPlan(verifyInfo.outTradeNo, lease.token, {
      credits: pkg.credits * quantity,
      monthlyCredits: 0,
      unitPrice: getCreditPackagePriceForPlan(pkg, purchasePlan),
      periodStart: lease.paidAt.toISOString(),
      periodEnd: null,
      expiresAt: expiresAt?.toISOString() ?? null,
      extendExpiry: false,
    });
  }
  await renewEpayFulfillmentLease(verifyInfo.outTradeNo, lease.token);
  await grantCredits({
    userId,
    amount: plan.credits,
    sourceType: "purchase",
    debitAccount: `PAYMENT:${verifyInfo.outTradeNo}`,
    transactionType: "purchase",
    expiresAt: plan.expiresAt ? new Date(plan.expiresAt) : null,
    sourceRef,
    description: `Epay credit pack purchase: ${plan.credits} credits (${packageId})`,
    metadata: {
      provider: "epay",
      outTradeNo: verifyInfo.outTradeNo,
      tradeNo: verifyInfo.tradeNo,
      paymentMethod: verifyInfo.type,
      packageId,
      quantity: metadata.quantity ?? 1,
      unitCredits: plan.credits / (metadata.quantity ?? 1),
      unitPrice: plan.unitPrice,
      paidMoney: verifyInfo.money,
    },
  });
  logEvent("credits.purchased", {
    userId,
    amount: plan.credits,
    paymentId: verifyInfo.outTradeNo,
    source: "epay",
    packageId,
    quantity: metadata.quantity ?? 1,
  });
  logger.info({ source, userId, sourceRef }, "Epay credit purchase fulfilled");
}

/** 冻结首收款周期；已有批次仅代表 grant 完成，不能跳过顺延和订阅投影。 */
async function handleSubscription(
  metadata: EpayMetadata,
  verifyInfo: EpayVerifyResult,
  source: EpayFulfillmentSource,
  lease: EpayFulfillmentLease
) {
  const { userId, priceId } = metadata;
  if (!priceId) throw new Error("Missing subscription price ID");
  const planType = getPlanFromPriceId(priceId);
  if (!planType || planType === "free")
    throw new Error(`Unknown subscription price ID: ${priceId}`);
  const subscriptionId = `epay_${verifyInfo.outTradeNo}`;
  const sourceRef = `epay_subscription:${verifyInfo.outTradeNo}`;
  const [existingBatch] = await db
    .select({
      id: creditsBatch.id,
      amount: creditsBatch.amount,
      issuedAt: creditsBatch.issuedAt,
      expiresAt: creditsBatch.expiresAt,
    })
    .from(creditsBatch)
    .where(
      and(
        eq(creditsBatch.sourceRef, sourceRef),
        eq(creditsBatch.sourceType, "subscription")
      )
    )
    .limit(1);
  const receipt =
    !lease.plan || !existingBatch
      ? await findPaymentGrantReceipt(userId, sourceRef, "monthly_grant")
      : null;
  let plan = lease.plan;
  if (!plan && (existingBatch || receipt)) {
    // 旧 success 的 batch 或财务账本均可证明 grant 提交；不因批次清理而重新发放。
    // 原始 metadata 周期优先于 expiresAt，后者可能已被后来的续费延长。
    const savedStart = receipt?.metadata?.periodStart;
    const savedEnd = receipt?.metadata?.periodEnd;
    const start =
      typeof savedStart === "string"
        ? new Date(savedStart)
        : (existingBatch?.issuedAt ?? receipt?.createdAt);
    const end =
      typeof savedEnd === "string"
        ? new Date(savedEnd)
        : existingBatch?.expiresAt;
    if (
      !start ||
      !end ||
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime())
    ) {
      throw new Error("Legacy Epay subscription period missing");
    }
    plan = await saveEpayFulfillmentPlan(verifyInfo.outTradeNo, lease.token, {
      credits: existingBatch?.amount ?? receipt?.amount ?? 0,
      monthlyCredits: 0,
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
      expiresAt: end.toISOString(),
      extendExpiry: await getRuntimeSettingBoolean(
        "CREDITS_RENEWAL_EXTENDS_EXPIRY"
      ),
    });
  }
  if (!plan) {
    const { plan: configuredPlan, price } =
      await findRuntimePlanByPriceId(priceId);
    if (!configuredPlan || !price)
      throw new Error(`Unknown subscription price ID: ${priceId}`);
    if (
      !isExpectedEpayAmount(verifyInfo, metadata.expectedAmount ?? price.amount)
    ) {
      throw new Error("Epay amount does not match subscription price");
    }
    const monthlyCredits = (await getSubscriptionMonthlyCredits())[
      planType as PaidPlanId
    ];
    const periodEnd = new Date(lease.paidAt);
    if (price.interval === "yearly")
      periodEnd.setFullYear(periodEnd.getFullYear() + 1);
    else periodEnd.setMonth(periodEnd.getMonth() + 1);
    plan = await saveEpayFulfillmentPlan(verifyInfo.outTradeNo, lease.token, {
      credits:
        price.interval === "yearly" ? monthlyCredits * 12 : monthlyCredits,
      monthlyCredits,
      periodStart: lease.paidAt.toISOString(),
      periodEnd: periodEnd.toISOString(),
      expiresAt: periodEnd.toISOString(),
      extendExpiry: await getRuntimeSettingBoolean(
        "CREDITS_RENEWAL_EXTENDS_EXPIRY"
      ),
    });
  }
  if (!plan.periodEnd || !plan.expiresAt)
    throw new Error("Invalid subscription fulfillment plan");
  await renewEpayFulfillmentLease(verifyInfo.outTradeNo, lease.token);
  if (!existingBatch && !receipt) {
    await grantCredits({
      userId,
      amount: plan.credits,
      sourceType: "subscription",
      debitAccount: `SUBSCRIPTION:${subscriptionId}`,
      transactionType: "monthly_grant",
      expiresAt: new Date(plan.expiresAt),
      sourceRef,
      description: `${planType} Epay subscription credits`,
      metadata: {
        provider: "epay",
        subscriptionId,
        priceId,
        planType,
        monthlyCredits: plan.monthlyCredits,
        interval:
          new Date(plan.periodEnd).getTime() -
            new Date(plan.periodStart).getTime() >
          180 * 86400000
            ? "year"
            : "month",
        periodStart: plan.periodStart,
        periodEnd: plan.periodEnd,
        outTradeNo: verifyInfo.outTradeNo,
        paymentMethod: verifyInfo.type,
        paidMoney: verifyInfo.money,
        checkoutMode: metadata.checkoutMode ?? "new_subscription",
        originalAmount: metadata.originalAmount,
        prorationCredit: metadata.prorationCredit ?? 0,
      },
    });
  }
  if (plan.extendExpiry) {
    await renewEpayFulfillmentLease(verifyInfo.outTradeNo, lease.token);
    await extendActiveSubscriptionBatchesExpiry({
      userId,
      subscriptionId,
      newExpiresAt: new Date(plan.expiresAt),
    });
  }
  await renewEpayFulfillmentLease(verifyInfo.outTradeNo, lease.token);
  await projectSubscription(userId, subscriptionId, priceId, plan);
  logEvent("payment.checkout.completed", {
    userId,
    source,
    provider: "epay",
    subscriptionId,
    priceId,
    checkoutMode: metadata.checkoutMode ?? "new_subscription",
  });
}

/**
 * 只包订阅投影自己的事务，绝不把 grant/extend service 包在其中。
 * 与 R08 使用相同用户锁；同套餐按期末优先收敛，跨套餐不能用较低权益延长较高权益。
 */
async function projectSubscription(
  userId: string,
  subscriptionId: string,
  priceId: string,
  plan: EpayFulfillmentPlan
) {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(20261025, hashtext(${userId}))`
    );
    const [existing] = await tx
      .select()
      .from(subscription)
      .where(eq(subscription.userId, userId))
      .limit(1)
      .for("update");
    const start = new Date(plan.periodStart);
    const end = new Date(plan.periodEnd ?? plan.periodStart);
    if (existing?.subscriptionId === subscriptionId) return;
    if (existing) {
      const currentPlan = getPlanFromPriceId(existing.priceId);
      const incomingPlan = getPlanFromPriceId(priceId);
      const currentEnd = existing.currentPeriodEnd;
      const currentStart = existing.currentPeriodStart;
      if (currentPlan && currentPlan === incomingPlan) {
        // 同套餐已付周期按期末优先；早收款年单可晚于月单恢复，不能因旧起点漏投影。
        // 同期末才按起点、订单ID稳定裁决，重投顺序不能改变最终结果。
        if (currentEnd && currentEnd > end) return;
        if (
          currentEnd?.getTime() === end.getTime() &&
          ((currentStart && currentStart > start) ||
            (currentStart?.getTime() === start.getTime() &&
              existing.subscriptionId >= subscriptionId))
        )
          return;
      } else if (currentEnd && currentEnd <= start) {
        // 前一套餐在本单收款前已结束，不存在重叠权益，可切换到本单原始周期。
      } else if (currentStart && end <= currentStart) {
        return;
      } else {
        // 不同tier的预创建普通单可达。只能选同时覆盖等级和期末的一方，不能把
        // 低价长单的期末接到高级套餐上；不可比较时抛错保留paid/pending供后续处理。
        if (!currentPlan || !incomingPlan || !currentEnd) {
          throw new Error("Epay subscription tier/period conflict");
        }
        if (isPlanAtLeast(currentPlan, incomingPlan) && currentEnd >= end)
          return;
        if (!isPlanAtLeast(incomingPlan, currentPlan) || end < currentEnd) {
          throw new Error("Epay subscription tier/period conflict");
        }
      }
    }
    const values = {
      subscriptionId,
      priceId,
      status: "canceled",
      currentPeriodStart: start,
      currentPeriodEnd: end,
      cancelAtPeriodEnd: true,
      updatedAt: new Date(),
    };
    if (existing)
      await tx
        .update(subscription)
        .set(values)
        .where(eq(subscription.id, existing.id));
    else
      await tx
        .insert(subscription)
        .values({ id: crypto.randomUUID(), userId, ...values });
  });
}

/** 发放账本是财务真相；同时兼容 source_ref 列和旧 metadata 幂等键。 */
async function findPaymentGrantReceipt(
  userId: string,
  sourceRef: string,
  type: "purchase" | "monthly_grant"
) {
  const [receipt] = await db
    .select({
      metadata: creditsTransaction.metadata,
      amount: creditsTransaction.amount,
      createdAt: creditsTransaction.createdAt,
    })
    .from(creditsTransaction)
    .where(
      and(
        eq(creditsTransaction.userId, userId),
        eq(creditsTransaction.type, type),
        sql`(${creditsTransaction.sourceRef} = ${sourceRef} OR ${creditsTransaction.metadata}->>'sourceRef' = ${sourceRef})`
      )
    )
    .limit(1);
  return receipt ?? null;
}

/** 有界重放收款事实；单笔故障不阻塞其他订单，失败保留在持久队列。 */
export async function recoverEpayFulfillments(limit = 100) {
  const payments = await listRecoverableEpayPayments(limit);
  let fulfilled = 0;
  let failed = 0;
  for (const payment of payments) {
    try {
      await fulfillSuccessfulEpayPayment(payment, "epay-webhook");
      fulfilled++;
    } catch (error) {
      failed++;
      logger.warn(
        {
          outTradeNo: payment.outTradeNo,
          error: error instanceof Error ? error.message : "unknown",
        },
        "Epay recovery deferred"
      );
    }
  }
  return { scanned: payments.length, fulfilled, failed };
}
