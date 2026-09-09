"use client";

/**
 * 购买积分套餐视图组件
 *
 * 展示积分套餐列表，允许用户选择并购买
 * 设计风格：GPT2IMAGE 黑白简约
 */

import {
  createCreditsPurchaseCheckout,
  getCreditPackages,
} from "@repo/shared/credits/actions";
import {
  CREDIT_PACKAGES,
  getLocalizedCreditPackageDescription,
  getLocalizedCreditPackageName,
  isCreditPackageVisible,
} from "@repo/shared/credits/config";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@repo/ui/components/card";
import { Input } from "@repo/ui/components/input";
import { Separator } from "@repo/ui/components/separator";
import { cn } from "@repo/ui/utils";
import { ArrowLeft, Check, Loader2, Minus, Plus } from "lucide-react";
import { useLocale } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import { useAction } from "next-safe-action/hooks";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

type CreditPackageCard = {
  id: string;
  name: string;
  nameZh?: string;
  credits: number;
  price: number;
  description: string;
  descriptionZh?: string;
  popular: boolean;
  allowQuantity?: boolean;
  maxQuantity?: number;
};

const FALLBACK_PACKAGES: CreditPackageCard[] = CREDIT_PACKAGES.filter(
  isCreditPackageVisible
).map((pkg) => ({
  id: pkg.id,
  name: pkg.name,
  nameZh: pkg.nameZh,
  credits: pkg.credits,
  price: pkg.price,
  description: pkg.description,
  descriptionZh: pkg.descriptionZh,
  popular: "popular" in pkg ? pkg.popular : false,
  allowQuantity:
    "allowQuantity" in pkg ? Boolean(pkg.allowQuantity) : false,
  maxQuantity:
    "maxQuantity" in pkg && typeof pkg.maxQuantity === "number"
      ? pkg.maxQuantity
      : 1,
}));

const DEFAULT_MAX_PACKAGE_QUANTITY = 999;

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

/**
 * 购买积分套餐视图
 */
export function BuyCreditPackagesView() {
  const locale = useLocale();
  const isZh = locale.startsWith("zh");
  const router = useRouter();
  const searchParams = useSearchParams();
  const canceled = searchParams.get("canceled");
  const selectedPackageId = searchParams.get("package");
  const copy = useCallback((en: string, zh: string) => (isZh ? zh : en), [isZh]);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const {
    execute: fetchPackages,
    result: packagesResult,
    isPending: isPackagesLoading,
  } = useAction(getCreditPackages);

  // 创建 Checkout Session
  const { execute, isPending } = useAction(createCreditsPurchaseCheckout, {
    onSuccess: ({ data }) => {
      if (data?.url) {
        if (data.method === "POST" && data.params) {
          submitEpayForm(data.url, data.params);
        } else {
          window.location.href = data.url;
        }
      }
    },
    onError: ({ error }) => {
      toast.error(
        error.serverError ??
          copy("Failed to create checkout session", "创建支付订单失败")
      );
    },
  });

  useEffect(() => {
    fetchPackages();
  }, [fetchPackages]);

  // 显示取消提示
  useEffect(() => {
    if (canceled) {
      toast.info(copy("Payment canceled", "支付已取消"));
      router.replace(`/${locale}/dashboard/credits/buy`);
    }
  }, [canceled, copy, locale, router]);

  /**
   * 处理购买按钮点击
   */
  const handlePurchase = (packageId: string) => {
    execute({
      packageId,
      quantity:
        packages.find((pkg) => pkg.id === packageId)?.allowQuantity
          ? (quantities[packageId] ?? 1)
          : 1,
    });
  };

  const packages = useMemo(
    () =>
      (packagesResult.data ?? FALLBACK_PACKAGES) as CreditPackageCard[],
    [packagesResult.data]
  );

  useEffect(() => {
    if (
      !selectedPackageId ||
      isPackagesLoading ||
      packagesResult.data === undefined
    ) {
      return;
    }
    const selectedPackage = packages.find(
      (pkg) => pkg.id === selectedPackageId
    );
    if (!selectedPackage) {
      toast.error(
        copy(
          "This credit package is not available for your current plan.",
          "该积分包不适用于您当前的套餐。"
        )
      );
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      document
        .getElementById(`credit-package-${selectedPackage.id}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    copy,
    isPackagesLoading,
    packages,
    packagesResult.data,
    selectedPackageId,
  ]);

  const normalizedQuantities = useMemo(
    () =>
      Object.fromEntries(
        packages.map((pkg) => [
          pkg.id,
          Math.min(
            pkg.maxQuantity ?? DEFAULT_MAX_PACKAGE_QUANTITY,
            Math.max(1, Math.trunc(quantities[pkg.id] ?? 1))
          ),
        ])
      ) as Record<string, number>,
    [packages, quantities]
  );
  const setPackageQuantity = (packageId: string, value: number) => {
    setQuantities((current) => ({
      ...current,
      [packageId]: Math.min(
        packages.find((pkg) => pkg.id === packageId)?.maxQuantity ??
          DEFAULT_MAX_PACKAGE_QUANTITY,
        Math.max(1, Math.trunc(Number.isFinite(value) ? value : 1))
      ),
    }));
  };

  return (
    <div className="mx-auto max-w-3xl space-y-10 px-4 py-8">
      {/* 页面标题 */}
      <div className="space-y-2">
        <h1 className="font-serif text-3xl font-medium tracking-tight">
          {copy("Buy Credits", "购买积分")}
        </h1>
        <p className="text-muted-foreground">
          {copy(
            "One-time credit packages. No subscription required. Credits follow the issued batch expiry shown on your usage page.",
            "一次性积分包，无需订阅。积分按发放批次有效期计算，可在用量页查看到期时间。"
          )}
        </p>
      </div>

      <Separator />

      {/* 套餐列表 */}
      <div
        className={cn(
          "grid gap-6",
          packages.length === 1
            ? "mx-auto max-w-md"
            : "sm:grid-cols-2 lg:grid-cols-3"
        )}
      >
        {packages.map((pkg, index) => {
          const isPopular = pkg.popular;
          const allowQuantity = Boolean(pkg.allowQuantity);
          const quantity = normalizedQuantities[pkg.id] ?? 1;
          const totalCredits = pkg.credits * quantity;
          const totalPrice = pkg.price * quantity;
          const perCredit = (pkg.price / pkg.credits).toFixed(4);

          return (
            // 套餐卡：hover 统一抬升（-translate-y-0.5 + whisper 阴影），入场按索引
            // 50ms 错峰；入场时长走内联属性（400ms），不影响 hover 过渡 duration-250。
            <Card
              key={pkg.id}
              id={`credit-package-${pkg.id}`}
              className={cn(
                "relative flex flex-col rounded-lg border lift-hover motion-reduce:transition-none animate-in fade-in slide-in-from-bottom-2 motion-reduce:animate-none",
                selectedPackageId === pkg.id
                  ? "border-foreground ring-2 ring-foreground/20 shadow-whisper"
                  : isPopular
                  ? "border-foreground shadow-whisper"
                  : "border-border hover:border-foreground/30"
              )}
              style={{
                animationDelay: `${(index % 12) * 50}ms`,
                animationDuration: "400ms",
                animationFillMode: "backwards",
              }}
            >
              {/* 热门标签 */}
              {isPopular && (
                <Badge className="absolute -top-3 left-1/2 -translate-x-1/2 bg-foreground text-background text-[10px] uppercase tracking-wider">
                  {copy("Best Value", "最划算")}
                </Badge>
              )}

              <CardHeader className="pb-3 pt-6 text-center">
                <p className="text-xs font-medium uppercase tracking-[1.2px] text-muted-foreground">
                  {getLocalizedCreditPackageName(pkg, locale)}
                </p>
              </CardHeader>

              <CardContent className="flex flex-1 flex-col items-center space-y-4 px-6">
                {/* 积分数量 */}
                <div className="text-center">
                  <span className="font-serif text-5xl font-medium tracking-tight">
                    {totalCredits.toLocaleString()}
                  </span>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {allowQuantity
                      ? copy(
                          `${pkg.credits.toLocaleString()} credits x ${quantity}`,
                          `${pkg.credits.toLocaleString()} 积分 x ${quantity}`
                        )
                      : copy("credits", "积分")}
                  </p>
                </div>

                <Separator />

                {/* 价格 */}
                <div className="text-center">
                  <span className="font-serif text-3xl font-medium">
                    ¥{totalPrice}
                  </span>
                  <span className="ml-1 text-sm text-muted-foreground">
                    {copy("CNY", "元")}
                  </span>
                </div>

                {allowQuantity && (
                  <div className="w-full space-y-2">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>{copy("Quantity", "购买数量")}</span>
                      <span>
                        {copy(
                          `${quantity} pack${quantity > 1 ? "s" : ""}`,
                          `${quantity} 份`
                        )}
                      </span>
                    </div>
                    <div className="flex h-9 items-center overflow-hidden rounded-md border border-border">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 rounded-none"
                        disabled={
                          quantity <= 1 || isPending || isPackagesLoading
                        }
                        onClick={() =>
                          setPackageQuantity(pkg.id, quantity - 1)
                        }
                      >
                        <Minus className="h-4 w-4" />
                      </Button>
                      <Input
                        type="number"
                        min={1}
                        max={pkg.maxQuantity ?? DEFAULT_MAX_PACKAGE_QUANTITY}
                        value={quantity}
                        className="h-8 border-0 text-center shadow-none focus-visible:ring-0"
                        disabled={isPending || isPackagesLoading}
                        onChange={(event) =>
                          setPackageQuantity(
                            pkg.id,
                            Number(event.target.value)
                          )
                        }
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 rounded-none"
                        disabled={
                          quantity >=
                            (pkg.maxQuantity ?? DEFAULT_MAX_PACKAGE_QUANTITY) ||
                          isPending ||
                          isPackagesLoading
                        }
                        onClick={() =>
                          setPackageQuantity(pkg.id, quantity + 1)
                        }
                      >
                        <Plus className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}

                {/* 描述 + 每积分价格 */}
                <p className="text-center text-xs text-muted-foreground">
                  {getLocalizedCreditPackageDescription(pkg, locale)}
                </p>

                {/* 特性列表 */}
                <ul className="w-full space-y-2 text-sm">
                  <li className="flex items-center gap-2 text-muted-foreground">
                    <Check className="h-3.5 w-3.5 shrink-0 text-foreground" />
                    {copy("Instant delivery", "立即到账")}
                  </li>
                  <li className="flex items-center gap-2 text-muted-foreground">
                    <Check className="h-3.5 w-3.5 shrink-0 text-foreground" />
                    {copy("Batch expiry shown in Usage", "有效期可在用量页查看")}
                  </li>
                  <li className="flex items-center gap-2 text-muted-foreground">
                    <Check className="h-3.5 w-3.5 shrink-0 text-foreground" />¥
                    {copy(`${perCredit} per credit`, `每积分 ${perCredit} 元`)}
                  </li>
                </ul>
              </CardContent>

              <CardFooter className="px-6 pb-6 pt-2">
                <Button
                  className="w-full"
                  variant={isPopular ? "default" : "outline"}
                  disabled={isPending || isPackagesLoading}
                  onClick={() => handlePurchase(pkg.id)}
                >
                  {isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      {copy("Processing...", "处理中...")}
                    </>
                  ) : (
                    copy(
                      `Buy ${totalCredits.toLocaleString()} Credits`,
                      `购买 ${totalCredits.toLocaleString()} 积分`
                    )
                  )}
                </Button>
              </CardFooter>
            </Card>
          );
        })}
      </div>

      {/* 返回链接 */}
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
