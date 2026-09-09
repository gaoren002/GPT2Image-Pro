"use client";

/**
 * 账单设置组件
 *
 * Settings > Billing Tab 的主要内容
 * 包含:
 * - 当前订阅计划
 * - 支付方式
 * - 账单历史
 */

import {
  findPlanByPriceId,
  paymentConfig,
} from "@repo/shared/config/payment";
import {
  PLAN_PRIVILEGES,
  type SubscriptionPlan,
} from "@repo/shared/config/subscription-plan";
import { getMyTransactions } from "@repo/shared/credits/actions";
import { formatCredits } from "@repo/shared/credits/format";
import { getMyPlanAction } from "@repo/shared/subscription/actions/get-user-plan";
import {
  PlanBadge,
  type PlanType,
} from "@repo/shared/subscription/components/plan-badge";
import { formatDateInTimeZone } from "@repo/shared/time-zone";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@repo/ui/components/alert-dialog";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import { Separator } from "@repo/ui/components/separator";
import {
  AlertCircle,
  Loader2,
  Receipt,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useEffect, useMemo, useState, useTransition } from "react";
import { cancelSubscription } from "@/features/payment/actions";
import { Link } from "@/i18n/routing";

type BillingTransaction = {
  id: string;
  type: string;
  amount: number;
  description: string | null;
  metadata: Record<string, unknown> | null;
  /** 该笔消耗对应的外部 API Key 名称(issue #26),非 API Key 消耗或历史记录为 null。 */
  apiKeyName?: string | null;
  createdAt: Date | string;
};

function formatCurrency(amount: number | string | undefined) {
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount)) return "-";

  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: paymentConfig.currency,
    maximumFractionDigits: 2,
  }).format(numericAmount);
}

function formatDate(date: Date | string, locale: string, timeZone: string) {
  return formatDateInTimeZone(date, locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }, timeZone);
}

function getBillingAmount(tx: BillingTransaction) {
  const meta = tx.metadata;
  const paidMoney = meta?.paidMoney;
  if (typeof paidMoney === "string" || typeof paidMoney === "number") {
    return formatCurrency(paidMoney);
  }

  const priceId = typeof meta?.priceId === "string" ? meta.priceId : "";
  if (priceId) {
    const { price } = findPlanByPriceId(priceId);
    if (price) return formatCurrency(price.amount);
  }

  return `${formatCredits(tx.amount)} credits`;
}

function getBillingDescription(tx: BillingTransaction, locale: string) {
  const meta = tx.metadata;
  const provider = typeof meta?.provider === "string" ? meta.provider : "";
  const paymentProvider = provider ? provider.toUpperCase() : "Payment";

  if (tx.type === "purchase") {
    const packageId = typeof meta?.packageId === "string" ? meta.packageId : "";
    const quantity =
      typeof meta?.quantity === "number" && meta.quantity > 1
        ? meta.quantity
        : null;
    if (packageId === "payg_starter") {
      return locale === "zh"
        ? `${paymentProvider} 按量付费积分购买`
        : `${paymentProvider} pay-as-you-go credit purchase`;
    }
    if (packageId === "enterprise_resource") {
      const quantitySuffix = quantity
        ? locale === "zh"
          ? ` x ${quantity} 份`
          : ` x ${quantity}`
        : "";
      return locale === "zh"
        ? `${paymentProvider} 企业资源包购买${quantitySuffix}`
        : `${paymentProvider} enterprise resource pack purchase${quantitySuffix}`;
    }

    const packageSuffix = packageId ? ` (${packageId})` : "";
    return locale === "zh"
      ? `${paymentProvider} 积分包购买${packageSuffix}`
      : `${paymentProvider} credit pack purchase${packageSuffix}`;
  }

  if (tx.type === "monthly_grant") {
    const planType = typeof meta?.planType === "string" ? meta.planType : "";
    const interval = meta?.interval === "year" ? "yearly" : "monthly";
    const isUpgrade = meta?.checkoutMode === "upgrade";
    const isRenewal = meta?.checkoutMode === "renewal";
    const plan = planType
      ? `${planType.charAt(0).toUpperCase()}${planType.slice(1)}`
      : "Subscription";
    const checkoutLabel = isUpgrade
      ? locale === "zh"
        ? "补差升级"
        : "upgrade"
      : isRenewal
        ? locale === "zh"
          ? "续购"
          : "renewal"
        : locale === "zh"
          ? "订阅"
          : "subscription";
    return locale === "zh"
      ? `${paymentProvider} ${plan} ${interval === "yearly" ? "年付" : "月付"}${checkoutLabel}`
      : `${paymentProvider} ${plan} ${interval} ${checkoutLabel}`;
  }

  return tx.description ?? "-";
}

function getReceiptReference(tx: BillingTransaction) {
  const meta = tx.metadata;
  const value =
    meta?.outTradeNo ?? meta?.tradeNo ?? meta?.orderId ?? meta?.subscriptionId;
  if (typeof value !== "string" || !value) return "-";
  return value.slice(-8);
}

/**
 * 账单设置组件
 */
export function BillingSection({ timeZone }: { timeZone: string }) {
  const t = useTranslations("Settings.billing");
  const locale = useLocale();

  // 获取用户订阅计划
  const { execute: fetchPlan, result: planResult } = useAction(getMyPlanAction);
  const {
    execute: fetchTransactions,
    result: transactionsResult,
    isPending: isTransactionsPending,
    hasErrored: hasTransactionsErrored,
  } = useAction(getMyTransactions);
  const userPlan = (planResult.data?.plan as PlanType) || "free";
  const planConfig = PLAN_PRIVILEGES[userPlan as SubscriptionPlan];
  const monthlyCredits =
    planResult.data?.capabilities?.limits.monthlyCredits ??
    planConfig.monthlyCredits;
  const isCancelPending = planResult.data?.cancelAtPeriodEnd ?? false;

  // 取消订阅
  const [isCancelling, startCancelTransition] = useTransition();
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);

  // 计算续期日期和价格
  const renewalDate = useMemo(() => {
    const iso = planResult.data?.currentPeriodEnd;
    if (!iso) return null;
    return new Date(iso);
  }, [planResult.data?.currentPeriodEnd]);

  const formattedRenewalDate = renewalDate
    ? formatDateInTimeZone(renewalDate, locale, {
        year: "numeric",
        month: "short",
        day: "numeric",
      }, timeZone)
    : null;

  const [priceDisplay, setPriceDisplay] = useState("-");
  const [priceInterval, setPriceInterval] = useState("");

  useEffect(() => {
    let cancelled = false;
    if (userPlan === "free") {
      setPriceDisplay(formatCurrency(0));
      setPriceInterval(t("currentPlan.perMonth"));
      return;
    }
    const priceId = planResult.data?.priceId;
    if (!priceId) {
      setPriceDisplay("-");
      setPriceInterval("");
      return;
    }

    const { price } = findPlanByPriceId(priceId);
    if (cancelled) return;
    if (!price) {
      setPriceDisplay("-");
      setPriceInterval("");
      return;
    }
    setPriceDisplay(formatCurrency(price.amount));
    setPriceInterval(
      price.interval === "yearly"
        ? t("currentPlan.perYear")
        : t("currentPlan.perMonth")
    );

    return () => {
      cancelled = true;
    };
  }, [userPlan, planResult.data?.priceId, t]);

  // 组件挂载时获取计划
  useEffect(() => {
    fetchPlan();
    fetchTransactions({
      limit: 50,
      types: ["purchase", "monthly_grant"],
    });
  }, [fetchPlan, fetchTransactions]);

  const billingTransactions = useMemo(
    () =>
      (transactionsResult.data?.transactions ?? []).filter((tx) =>
        ["purchase", "monthly_grant"].includes(tx.type)
      ),
    [transactionsResult.data?.transactions]
  );

  // 处理取消订阅
  const handleCancelSubscription = () => {
    startCancelTransition(async () => {
      try {
        await cancelSubscription();
        setCancelDialogOpen(false);
        fetchPlan(); // 刷新状态
      } catch (error) {
        console.error("Failed to cancel subscription:", error);
      }
    });
  };

  return (
    <div className="space-y-8">
      {/* 当前计划 */}
      <section className="space-y-6">
        <div className="space-y-2">
          <div className="border-b border-border/60 pb-2">
            <h2 className="text-xs font-medium uppercase tracking-[1.2px] text-muted-foreground">
              {t("currentPlan.title")}
            </h2>
          </div>
          <p className="text-sm text-muted-foreground">
            {t("currentPlan.description")}
          </p>
        </div>

        {/* 当前计划概览卡：与仪表盘统计卡一致的 hover 抬升手感 */}
        <div className="rounded-lg border border-border p-6 lift-hover motion-reduce:transition-none">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-4">
              <PlanBadge plan={userPlan} size="lg" showLabel={false} />
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-serif text-lg font-medium">
                    {planResult.data?.planName ?? planConfig.name} Plan
                  </h3>
                  <Badge
                    variant="outline"
                    className="text-[10px] uppercase tracking-wider text-muted-foreground"
                  >
                    {t("currentPlan.current")}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  {userPlan === "free"
                    ? t("currentPlan.basicFeatures")
                    : t("currentPlan.premiumFeatures")}
                </p>
              </div>
            </div>
            {userPlan === "free" && (
              <Button asChild>
                <Link href="/dashboard/subscription/buy">
                  <Sparkles className="mr-2 h-4 w-4" />
                  {t("currentPlan.upgradePlan")}
                </Link>
              </Button>
            )}
            {userPlan !== "free" && (
              <div className="flex items-center gap-2">
                <Button asChild size="sm">
                  <Link href="/dashboard/subscription/buy">
                    <Sparkles className="mr-2 h-4 w-4" />
                    {t("currentPlan.upgradePlan")}
                  </Link>
                </Button>
                {isCancelPending ? (
                  // 警告态徽章统一色底配方(bg-warning/10),与 admin 面板状态徽章同语言
                  <Badge className="bg-warning/10 text-warning">
                    {t("currentPlan.cancelPending", {
                      date: formattedRenewalDate ?? "",
                    })}
                  </Badge>
                ) : (
                  <AlertDialog
                    open={cancelDialogOpen}
                    onOpenChange={setCancelDialogOpen}
                  >
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-muted-foreground"
                      >
                        {t("currentPlan.cancelSubscription")}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          {t("currentPlan.cancelDialog.title")}
                        </AlertDialogTitle>
                        <AlertDialogDescription className="space-y-2">
                          <span className="block">
                            {t("currentPlan.cancelDialog.description", {
                              date: formattedRenewalDate ?? "",
                            })}
                          </span>
                          <span className="block font-medium text-foreground">
                            {t("currentPlan.cancelDialog.keepBenefits", {
                              date: formattedRenewalDate ?? "",
                            })}
                          </span>
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>
                          {t("currentPlan.cancelDialog.cancel")}
                        </AlertDialogCancel>
                        <AlertDialogAction
                          onClick={handleCancelSubscription}
                          disabled={isCancelling}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                          {isCancelling && (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          )}
                          {t("currentPlan.cancelDialog.confirm")}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>
            )}
          </div>

          <Separator className="my-4" />

          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <p className="text-xs uppercase tracking-[0.6px] text-muted-foreground">
                {t("currentPlan.monthlyCredits")}
              </p>
              <p className="mt-1 font-serif text-lg font-medium">
                {monthlyCredits.toLocaleString("en-US")}{" "}
                <span className="text-sm font-normal text-muted-foreground">
                  credits
                </span>
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.6px] text-muted-foreground">
                {t("currentPlan.renewalDate")}
              </p>
              <p
                className={`mt-1 font-serif text-lg font-medium ${isCancelPending ? "text-warning" : ""}`}
              >
                {formattedRenewalDate ?? t("currentPlan.notApplicable")}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.6px] text-muted-foreground">
                {t("currentPlan.price")}
              </p>
              <p className="mt-1 font-serif text-lg font-medium">
                {priceDisplay}
                {priceInterval && (
                  <span className="text-sm font-normal text-muted-foreground">
                    {" "}
                    /{priceInterval}
                  </span>
                )}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* 账单历史 */}
      <section className="space-y-6">
        <div className="space-y-2">
          <div className="border-b border-border/60 pb-2">
            <h2 className="text-xs font-medium uppercase tracking-[1.2px] text-muted-foreground">
              {t("history.title")}
            </h2>
          </div>
          <p className="text-sm text-muted-foreground">
            {t("history.description")}
          </p>
        </div>

        {/* 表格 */}
        <div className="overflow-hidden rounded-lg border border-border">
          {/* 表头 */}
          <div className="grid grid-cols-12 gap-4 bg-muted/50 px-4 py-3 text-xs font-medium uppercase tracking-[0.6px] text-muted-foreground">
            <div className="col-span-3">{t("history.date")}</div>
            <div className="col-span-4">{t("history.historyDescription")}</div>
            <div className="col-span-2 text-right">{t("history.amount")}</div>
            <div className="col-span-2 text-center">{t("history.status")}</div>
            <div className="col-span-1 text-center">{t("history.invoice")}</div>
          </div>

          <Separator />

          {isTransactionsPending ? (
            <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("history.loading")}
            </div>
          ) : hasTransactionsErrored ? (
            <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
              <AlertCircle className="h-10 w-10 text-destructive/70" />
              <p className="text-sm text-muted-foreground">
                {t("history.loadFailed")}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  fetchTransactions({
                    limit: 50,
                    types: ["purchase", "monthly_grant"],
                  })
                }
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                {t("history.retry")}
              </Button>
            </div>
          ) : billingTransactions.length > 0 ? (
            <div className="divide-y divide-border/60">
              {billingTransactions.map((tx) => (
                <div
                  key={tx.id}
                  className="grid grid-cols-12 gap-4 px-4 py-3 text-sm transition-colors duration-150 even:bg-muted/40 hover:bg-muted/60"
                >
                  <div className="col-span-3 text-muted-foreground">
                    {formatDate(tx.createdAt, locale, timeZone)}
                  </div>
                  <div className="col-span-4 min-w-0">
                    <div
                      className="truncate"
                      title={getBillingDescription(tx, locale)}
                    >
                      {getBillingDescription(tx, locale)}
                    </div>
                    {tx.apiKeyName ? (
                      <div
                        className="truncate text-xs text-muted-foreground"
                        title={tx.apiKeyName}
                      >
                        API Key: {tx.apiKeyName}
                      </div>
                    ) : null}
                  </div>
                  <div className="col-span-2 text-right font-serif font-medium">
                    {getBillingAmount(tx)}
                  </div>
                  <div className="col-span-2 text-center">
                    <Badge
                      variant="outline"
                      className="text-[10px] uppercase tracking-wider text-muted-foreground"
                    >
                      {t("history.paid")}
                    </Badge>
                  </div>
                  <div className="col-span-1 text-center text-xs text-muted-foreground">
                    {getReceiptReference(tx)}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Receipt className="h-12 w-12 text-muted-foreground/50 mb-4" />
              <p className="text-muted-foreground">{t("history.noHistory")}</p>
              <p className="text-sm text-muted-foreground/70">
                {t("history.noHistoryHint")}
              </p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
