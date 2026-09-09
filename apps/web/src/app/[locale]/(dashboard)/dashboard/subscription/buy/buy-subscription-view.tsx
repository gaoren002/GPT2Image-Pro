"use client";

import type {
  PaidPlanId,
  RuntimePaymentConfig,
} from "@repo/shared/config/payment-runtime";
import {
  PLAN_RANK,
  type SubscriptionPlan,
} from "@repo/shared/config/subscription-plan";
import type { PlanCapabilityMatrix } from "@repo/shared/subscription/services/plan-capabilities";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { Separator } from "@repo/ui/components/separator";
import { cn } from "@repo/ui/utils";
import {
  ArrowLeft,
  Check,
  Coins,
  Loader2,
  RefreshCw,
  ShoppingCart,
  Sparkles,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import type { ImageRetentionPolicy } from "@/features/marketing/image-retention-policy";
import { buildPlanPresentation } from "@/features/marketing/plan-presentation";
import { createCheckoutSession } from "@/features/payment/actions";
import { PlanInterval } from "@/features/payment/types";

const PAID_PLANS: PaidPlanId[] = ["starter", "pro", "ultra", "enterprise"];

type CurrentPlan = {
  plan: SubscriptionPlan;
  priceId: string | null;
  hasActiveSubscription: boolean;
  cancelAtPeriodEnd: boolean;
};

function submitEpayForm(url: string, params: Record<string, string>) {
  const form = document.createElement("form");
  form.action = url;
  form.method = "POST";
  form.style.display = "none";
  for (const [key, value] of Object.entries(params)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = key;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
  document.body.removeChild(form);
}

export function BuySubscriptionView({
  payment,
  currentPlan,
  capabilityMatrix,
  imageRetentionPolicy,
}: {
  payment: RuntimePaymentConfig;
  currentPlan: CurrentPlan;
  capabilityMatrix: PlanCapabilityMatrix;
  imageRetentionPolicy: ImageRetentionPolicy;
}) {
  const locale = useLocale();
  const isZh = locale.startsWith("zh");
  const t = useTranslations("Pricing");
  const router = useRouter();
  const [loadingPlan, setLoadingPlan] = useState<PaidPlanId | null>(null);
  const [isPending, startTransition] = useTransition();
  const copy = (en: string, zh: string) => (isZh ? zh : en);

  const currentPrice = PAID_PLANS.flatMap(
    (planId) => payment.plans[planId]?.prices ?? []
  ).find((price) => price.priceId === currentPlan.priceId);
  const currentInterval =
    currentPrice?.interval === PlanInterval.YEAR
      ? PlanInterval.YEAR
      : PlanInterval.MONTH;
  const [interval, setInterval] = useState<PlanInterval>(currentInterval);
  const intervalLocked =
    currentPlan.hasActiveSubscription && Boolean(currentPlan.priceId);

  const formatMoney = (amount: number) =>
    new Intl.NumberFormat(locale, {
      style: "currency",
      currency: payment.currency,
      maximumFractionDigits: 2,
    }).format(amount);

  const handleCheckout = (planId: PaidPlanId) => {
    const plan = payment.plans[planId];
    const price = plan?.prices?.find((item) => item.interval === interval);
    if (!price?.priceId) {
      toast.error(
        copy(
          "This billing option is temporarily unavailable.",
          "该计费选项暂时不可购买。"
        )
      );
      return;
    }

    setLoadingPlan(planId);
    startTransition(async () => {
      try {
        const result = await createCheckoutSession({
          priceId: price.priceId,
          type: price.type,
        });
        if (result?.serverError) {
          toast.error(result.serverError);
        } else if (result?.data?.url) {
          if (result.data.method === "POST" && result.data.params) {
            submitEpayForm(result.data.url, result.data.params);
          } else {
            window.location.href = result.data.url;
          }
        } else {
          toast.error(
            copy(
              "Failed to create checkout session. Please try again.",
              "创建支付订单失败，请重试。"
            )
          );
        }
      } catch (error) {
        console.error("Failed to create subscription checkout:", error);
        toast.error(
          copy(
            "Failed to create checkout session. Please try again.",
            "创建支付订单失败，请重试。"
          )
        );
      } finally {
        setLoadingPlan(null);
      }
    });
  };

  return (
    <div className="mx-auto max-w-6xl space-y-8 px-4 py-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <h1 className="font-serif text-3xl font-medium tracking-tight">
            {copy("Choose a Plan", "购买或升级套餐")}
          </h1>
          <p className="max-w-2xl text-muted-foreground">
            {copy(
              "Choose a subscription without leaving the dashboard. Epay subscriptions can renew the current plan or upgrade by paying the prorated difference.",
              "直接在控制台选择订阅套餐；易支付订阅可续购当前套餐，或按当前周期补差升级。"
            )}
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => router.push(`/${locale}/dashboard/credits/buy`)}
        >
          <ShoppingCart className="mr-2 h-4 w-4" />
          {copy("Buy credit packages", "购买积分包")}
        </Button>
      </div>

      <Separator />

      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium">
            {copy("Billing cycle", "计费周期")}
          </p>
          <p className="text-xs text-muted-foreground">
            {intervalLocked
              ? copy(
                  "Upgrades use the same billing cycle as your current subscription.",
                  "升级须沿用当前订阅的计费周期。"
                )
              : copy(
                  "You can choose monthly or yearly billing.",
                  "可选择月付或年付。"
                )}
          </p>
        </div>
        <div className="flex rounded-md border border-border p-1">
          <Button
            size="sm"
            variant={interval === PlanInterval.MONTH ? "default" : "ghost"}
            disabled={intervalLocked}
            onClick={() => setInterval(PlanInterval.MONTH)}
          >
            {copy("Monthly", "月付")}
          </Button>
          {payment.yearlyEnabled && (
            <Button
              size="sm"
              variant={interval === PlanInterval.YEAR ? "default" : "ghost"}
              disabled={intervalLocked}
              onClick={() => setInterval(PlanInterval.YEAR)}
            >
              {copy("Yearly", "年付")}
              {!intervalLocked && payment.yearlyDiscount > 0 && (
                <Badge variant="secondary" className="ml-2">
                  -{payment.yearlyDiscount}%
                </Badge>
              )}
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
        {PAID_PLANS.map((planId) => {
          const plan = payment.plans[planId];
          const price = plan?.prices?.find(
            (item) => item.interval === interval
          );
          const isCurrent =
            currentPlan.hasActiveSubscription && currentPlan.plan === planId;
          const canUpgrade =
            currentPlan.hasActiveSubscription &&
            PLAN_RANK[planId] > PLAN_RANK[currentPlan.plan];
          const canRenew = isCurrent && payment.provider === "epay";
          const canPurchase =
            !currentPlan.hasActiveSubscription || canUpgrade || canRenew;
          const isLoading = loadingPlan === planId;
          const popular = Boolean(plan?.popular);
          const presentation = buildPlanPresentation({
            planId,
            capabilityMatrix,
            imageRetentionPolicy,
            locale,
          });

          return (
            <Card
              key={planId}
              className={cn(
                "relative flex h-full flex-col border-border lift-hover motion-reduce:transition-none",
                popular && "border-foreground/40 shadow-whisper",
                isCurrent && "ring-2 ring-foreground"
              )}
            >
              {(isCurrent || popular) && (
                <Badge
                  className="absolute -top-3 left-1/2 -translate-x-1/2"
                  variant={isCurrent ? "default" : "secondary"}
                >
                  {isCurrent
                    ? copy("Current plan", "当前套餐")
                    : copy("Best value", "性价比最高")}
                </Badge>
              )}

              <CardHeader className="pt-7">
                <CardTitle className="font-serif text-xl">
                  {t(`plans.${planId}.name`)}
                </CardTitle>
                <p className="text-sm text-muted-foreground">
                  {presentation.description}
                </p>
              </CardHeader>

              <CardContent className="flex flex-1 flex-col gap-5">
                <div>
                  <div className="flex items-end gap-1">
                    <span className="font-serif text-4xl font-medium">
                      {price ? formatMoney(price.amount) : "—"}
                    </span>
                    <span className="pb-1 text-sm text-muted-foreground">
                      {interval === PlanInterval.YEAR
                        ? copy("/year", "/年")
                        : copy("/month", "/月")}
                    </span>
                  </div>
                </div>

                <div className="rounded-lg border border-border bg-muted/30 px-3 py-3">
                  <div className="flex items-center gap-2">
                    <Coins className="h-4 w-4" />
                    <span className="font-serif text-lg font-medium">
                      {presentation.monthlyCredits.toLocaleString(locale)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {copy("credits / month", "积分 / 月")}
                    </span>
                  </div>
                </div>

                <ul className="space-y-2.5 text-sm text-muted-foreground">
                  {presentation.features.map((feature) => (
                    <li key={feature} className="flex gap-2">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-foreground" />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>

              <CardFooter>
                <Button
                  className="w-full"
                  variant={popular ? "default" : "outline"}
                  disabled={!canPurchase || !price || isLoading || isPending}
                  onClick={() => handleCheckout(planId)}
                >
                  {isLoading ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : canUpgrade ? (
                    <Sparkles className="mr-2 h-4 w-4" />
                  ) : canRenew ? (
                    <RefreshCw className="mr-2 h-4 w-4" />
                  ) : null}
                  {isCurrent
                    ? canRenew
                      ? copy("Renew current plan", "续购当前套餐")
                      : copy("Current plan", "当前套餐")
                    : canUpgrade
                      ? copy("Upgrade plan", "补差升级")
                      : currentPlan.hasActiveSubscription
                        ? copy("Downgrade unavailable", "暂不支持降级")
                        : copy("Subscribe", "立即订阅")}
                </Button>
              </CardFooter>
            </Card>
          );
        })}
      </div>

      {currentPlan.cancelAtPeriodEnd && (
        <p className="rounded-md border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
          {copy(
            "Your current subscription is scheduled to end after this billing period. Benefits remain active until then.",
            "当前订阅已设置为周期结束后取消，在到期前权益仍然有效。"
          )}
        </p>
      )}

      <div className="flex justify-center">
        <Button
          variant="ghost"
          size="sm"
          className="gap-2 text-muted-foreground"
          onClick={() => router.push(`/${locale}/dashboard/billing`)}
        >
          <ArrowLeft className="h-4 w-4" />
          {copy("Back to Billing & Usage", "返回账单与用量")}
        </Button>
      </div>
    </div>
  );
}
