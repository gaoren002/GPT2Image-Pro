"use server";

/** 支付动作薄适配；升级下单及取消通过 UOL 事务预留接口。 */
import "@repo/shared/payment/upgrade-reservation-operations";
import { db } from "@repo/database";
import { subscription } from "@repo/database/schema";
import { getBaseUrl, paymentConfig } from "@repo/shared/config/payment";
import { findRuntimePlanByPriceId } from "@repo/shared/config/payment-runtime";
import { logEvent } from "@repo/shared/logger";
import {
  createRuntimeEpayPurchase,
  isRuntimeEpayPaymentProvider,
  saveEpayOrder,
} from "@repo/shared/payment/epay";
import { protectedAction } from "@repo/shared/safe-action";
import { invokeOperation } from "@repo/shared/uol";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { PaymentType } from "@/features/payment/types";

import { creem } from "./creem";
import {
  createSubscriptionCheckoutQuote,
  isEpayCurrentPlanRenewal,
} from "./subscription-upgrade";

/**
 * 创建 Creem Checkout Session
 *
 * 支持订阅支付和一次性支付两种模式
 */
export const createCheckoutSession = protectedAction
  .metadata({ action: "payment.createCheckoutSession" })
  .schema(
    z.object({
      priceId: z.string().min(1, "价格 ID 不能为空"),
      clientRequestId: z.string().min(1).max(128).optional(),
      type: z.nativeEnum(PaymentType).optional(),
      successUrl: z.string().optional(),
      cancelUrl: z.string().optional(),
    })
  )
  .action(async ({ parsedInput, ctx }) => {
    const { priceId, successUrl } = parsedInput;
    const { userId } = ctx;

    // 检查是否已有活跃订阅
    const [existingSub] = await db
      .select({
        userId: subscription.userId,
        priceId: subscription.priceId,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
        status: subscription.status,
      })
      .from(subscription)
      .where(eq(subscription.userId, userId))
      .limit(1);

    // 查找计划和价格信息
    const { plan, price } = await findRuntimePlanByPriceId(priceId);
    if (!plan || !price) {
      throw new Error("无效的价格 ID");
    }

    const baseUrl = getBaseUrl();
    const useEpay = await isRuntimeEpayPaymentProvider();
    const activeSubscription =
      existingSub && isSubscriptionCurrentlyActive(existingSub)
        ? existingSub
        : null;
    const hasActiveSub = Boolean(activeSubscription);
    const isRenewal = isEpayCurrentPlanRenewal(
      activeSubscription?.priceId,
      priceId,
      useEpay
    );
    if (useEpay && activeSubscription && !isRenewal) {
      return invokeOperation<{
        url: string;
        params: Record<string, string>;
        method: "POST";
        outTradeNo: string;
        amountDue: number;
        expiresAt: string;
      }>(
        "subscription.reserveUpgrade",
        {
          targetPriceId: priceId,
          clientRequestId: parsedInput.clientRequestId ?? crypto.randomUUID(),
        },
        { type: "user", userId, role: "user" }
      );
    }
    const upgradeQuote =
      activeSubscription && !isRenewal
        ? await createSubscriptionCheckoutQuote(activeSubscription, priceId)
        : null;
    const checkoutMode = isRenewal
      ? ("renewal" as const)
      : upgradeQuote
        ? ("upgrade" as const)
        : ("new_subscription" as const);

    logEvent("payment.checkout.started", {
      userId,
      priceId,
      planId: plan.id,
      provider: useEpay ? "epay" : "creem",
      checkoutMode,
      amountDue: upgradeQuote?.amountDue ?? price.amount,
      prorationCredit: upgradeQuote?.prorationCredit,
    });

    if (useEpay) {
      const outTradeNo = `SUB${Date.now()}${crypto.randomUUID().slice(0, 8)}`;
      const amountDue = upgradeQuote?.amountDue ?? price.amount;
      const metadata = {
        type: "subscription" as const,
        userId,
        outTradeNo,
        priceId,
        planId: plan.id,
        checkoutMode,
        expectedAmount: amountDue,
        originalAmount: upgradeQuote?.originalAmount ?? price.amount,
        ...(upgradeQuote && {
          prorationCredit: upgradeQuote.prorationCredit,
          remainingDays: upgradeQuote.remainingDays,
          periodDays: upgradeQuote.periodDays,
          upgradeFromPriceId: upgradeQuote.upgradeFromPriceId,
        }),
      };
      await saveEpayOrder(metadata, amountDue);
      const checkout = await createRuntimeEpayPurchase({
        outTradeNo,
        name:
          checkoutMode === "upgrade"
            ? `GPT2IMAGE upgrade to ${plan.name} ${price.interval ?? "subscription"}`
            : checkoutMode === "renewal"
              ? `GPT2IMAGE renew ${plan.name} ${price.interval ?? "subscription"}`
              : `GPT2IMAGE ${plan.name} ${price.interval ?? "subscription"}`,
        money: amountDue,
      });

      return {
        url: checkout.url,
        params: checkout.params,
        method: "POST" as const,
      };
    }

    if (hasActiveSub) {
      throw new Error("当前支付通道暂不支持自动补差升级，请联系管理员处理");
    }

    // 创建 Creem Checkout
    const checkout = await creem.createCheckout({
      product_id: priceId,
      success_url:
        successUrl ??
        `${baseUrl}${paymentConfig.redirectAfterCheckout}?success=true`,
      request_id: `${userId}_${Date.now()}`,
      metadata: {
        userId,
        planId: plan?.id ?? "unknown",
      },
    });

    return { url: checkout.checkout_url };
  });

/**
 * 创建订阅管理链接
 *
 * Creem 不提供类似 Stripe Customer Portal 的功能
 * 用户需要通过 Creem 的订阅管理页面或联系支持来管理订阅
 * 这里返回 null，前端可以显示取消订阅按钮或联系支持链接
 */
export const createCustomerPortal = protectedAction
  .metadata({ action: "payment.createCustomerPortal" })
  .schema(
    z
      .object({
        returnUrl: z.string().optional(),
      })
      .optional()
  )
  .action(async ({ ctx }) => {
    const { userId } = ctx;

    // 查询用户的订阅
    const [userSubscription] = await db
      .select({ subscriptionId: subscription.subscriptionId })
      .from(subscription)
      .where(eq(subscription.userId, userId))
      .limit(1);

    if (!userSubscription?.subscriptionId) {
      throw new Error("您还没有订阅任何计划");
    }

    // Creem 没有 Customer Portal，返回 null
    // 前端可以显示取消订阅按钮或联系支持链接
    return { url: null, subscriptionId: userSubscription.subscriptionId };
  });

/**
 * 取消订阅
 *
 * 调用 Creem API 取消用户的订阅
 */
export const cancelSubscription = protectedAction
  .metadata({ action: "payment.cancelSubscription" })
  .action(async ({ ctx }) => {
    const { userId } = ctx;

    // 查询用户的订阅
    const [userSubscription] = await db
      .select({ subscriptionId: subscription.subscriptionId })
      .from(subscription)
      .where(eq(subscription.userId, userId))
      .limit(1);

    if (!userSubscription?.subscriptionId) {
      throw new Error("您还没有订阅任何计划");
    }

    if (userSubscription.subscriptionId.startsWith("epay_")) {
      throw new Error("易支付订阅不支持自动取消，请等待当前周期结束");
    }

    // 调用 Creem API 取消订阅
    await creem.cancelSubscription(userSubscription.subscriptionId);

    // 更新数据库状态
    await db
      .update(subscription)
      .set({
        cancelAtPeriodEnd: true,
        updatedAt: new Date(),
      })
      .where(eq(subscription.userId, userId));

    logEvent("payment.subscription.canceled", {
      userId,
      subscriptionId: userSubscription.subscriptionId,
    });

    return { success: true };
  });

/**
 * 获取用户当前订阅状态
 *
 * 用于在前端显示用户的订阅信息
 */
export const getUserSubscription = protectedAction
  .metadata({ action: "payment.getUserSubscription" })
  .action(async ({ ctx }) => {
    const { userId } = ctx;

    // 查询用户的订阅信息
    const [userSubscription] = await db
      .select()
      .from(subscription)
      .where(eq(subscription.userId, userId))
      .limit(1);

    if (!userSubscription) {
      return { subscription: null };
    }

    // 检查订阅是否有效
    const isActive = isSubscriptionCurrentlyActive(userSubscription);
    const isTrialing = userSubscription.status === "trialing";

    return {
      subscription: {
        id: userSubscription.id,
        status: userSubscription.status,
        priceId: userSubscription.priceId,
        currentPeriodStart: userSubscription.currentPeriodStart,
        currentPeriodEnd: userSubscription.currentPeriodEnd,
        cancelAtPeriodEnd: userSubscription.cancelAtPeriodEnd,
        isActive,
        isTrialing,
      },
    };
  });

/**
 * 检查用户是否有有效订阅
 */
export const hasActiveSubscription = protectedAction
  .metadata({ action: "payment.hasActiveSubscription" })
  .action(async ({ ctx }) => {
    const { userId } = ctx;

    const [userSubscription] = await db
      .select({
        currentPeriodEnd: subscription.currentPeriodEnd,
        status: subscription.status,
      })
      .from(subscription)
      .where(eq(subscription.userId, userId))
      .limit(1);

    if (!userSubscription) {
      return { hasSubscription: false, status: null };
    }

    const isActive = isSubscriptionCurrentlyActive(userSubscription);

    return {
      hasSubscription: isActive,
      status: userSubscription.status,
    };
  });

function isSubscriptionCurrentlyActive(sub: {
  currentPeriodEnd: Date | null;
  status: string;
}) {
  if (sub.status === "lifetime") {
    return true;
  }

  return (
    (["active", "trialing"].includes(sub.status) &&
      isSubscriptionWithinPeriod(sub)) ||
    isCanceledSubscriptionWithinPeriod(sub)
  );
}

function isSubscriptionWithinPeriod(sub: { currentPeriodEnd: Date | null }) {
  return !sub.currentPeriodEnd || sub.currentPeriodEnd > new Date();
}

function isCanceledSubscriptionWithinPeriod(sub: {
  currentPeriodEnd: Date | null;
  status: string;
}) {
  return (
    sub.status === "canceled" &&
    Boolean(sub.currentPeriodEnd) &&
    isSubscriptionWithinPeriod(sub)
  );
}

/** 取消本人升级订单；已经付款或释放的订单返回原终态，不重复返还。 */
export const cancelUpgradeCheckout = protectedAction
  .metadata({ action: "payment.cancelUpgradeCheckout" })
  .schema(z.object({ outTradeNo: z.string().min(1) }))
  .action(({ parsedInput, ctx }) =>
    invokeOperation<{ state: string }>(
      "subscription.cancelUpgrade",
      parsedInput,
      { type: "user", userId: ctx.userId, role: "user" }
    )
  );
