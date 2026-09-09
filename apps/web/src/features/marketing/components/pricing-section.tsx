"use client";

import { getPlanPrice, paymentConfig } from "@repo/shared/config/payment";
import {
  PLAN_RANK,
  SUBSCRIPTION_PLANS,
  type SubscriptionPlan,
} from "@repo/shared/config/subscription-plan";
import {
  getLocalizedCreditPackageDescription,
  getLocalizedCreditPackageName,
} from "@repo/shared/credits/config";
import type { RuntimeCreditPackage } from "@repo/shared/credits/packages";
import type { PaymentConfig } from "@repo/shared/payment/types";
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
import { cn } from "@repo/ui/utils";
import { motion, useReducedMotion } from "framer-motion";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Coins,
  ImageIcon,
  Loader2,
  ShoppingCart,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { useCurrentSession } from "@/features/auth/hooks/use-current-session";
import {
  getImageBaseCreditPricing,
  getImageCreditCostBreakdown,
  IMAGE_MODERATION_PRICE_CNY,
  type ImageBaseCreditPricing,
  REFERENCE_CREDIT_PRICE_CNY,
  TEXT_MODERATION_PRICE_CNY,
} from "@/features/image-generation/resolution";
import {
  createCheckoutSession,
  getUserSubscription,
} from "@/features/payment/actions";
import { PlanInterval } from "@/features/payment/types";
import { useRouter } from "@/i18n/routing";

import type { ImageRetentionPolicy } from "../image-retention-policy";
import { buildPlanPresentation } from "../plan-presentation";
import { AnimatedPrice } from "./animated-price";
import { folioNumeral } from "./folio-numeral";
import { InkReveal, InkRevealBoundary, InkRule } from "./ink-reveal";
import {
  type PlanGalleryItem,
  PlanGalleryStage,
} from "./pricing-plan-gallery";

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
 * 计划配置（用于获取价格等非翻译数据）
 */
const PLAN_IDS = ["free", "starter", "pro", "ultra", "enterprise"] as const;
type PricingPlanId = (typeof PLAN_IDS)[number];

const PLAN_ID_SET: ReadonlySet<string> = new Set(PLAN_IDS);

function isPricingPlanId(value: string): value is PricingPlanId {
  return PLAN_ID_SET.has(value);
}

/**
 * 价格计划组件属性
 */
interface PricingSectionProps {
  /** 用户当前订阅的价格 ID */
  currentPriceId?: string | null;
  payment?: PaymentConfig & { yearlyEnabled?: boolean };
  capabilityMatrix: PlanCapabilityMatrix;
  creditPackages?: RuntimeCreditPackage[];
  creditPackageExpiryDays?: number;
  imageBasePricing?: ImageBaseCreditPricing;
  imageRetentionPolicy: ImageRetentionPolicy;
}

/**
 * 价格计划展示组件
 */
export function PricingSection({
  currentPriceId,
  payment,
  capabilityMatrix,
  creditPackages = [],
  creditPackageExpiryDays,
  imageBasePricing,
  imageRetentionPolicy,
}: PricingSectionProps) {
  const t = useTranslations("Pricing");
  // 影片第五幕"装裱"眉标文案(仅语义包装,定价交互与内容不动)
  const tCinema = useTranslations("Cinema");
  const locale = useLocale();
  const isZh = locale.startsWith("zh");
  const [isPending, startTransition] = useTransition();
  const [loadingPlan, setLoadingPlan] = useState<string | null>(null);
  const router = useRouter();
  const { data: session } = useCurrentSession();

  // 获取用户当前订阅状态
  const [activePriceId, setActivePriceId] = useState<string | null>(
    currentPriceId ?? null
  );

  useEffect(() => {
    if (!session?.user || currentPriceId) return;
    getUserSubscription().then((result) => {
      if (
        result?.data?.subscription?.isActive &&
        result.data.subscription.priceId
      ) {
        setActivePriceId(result.data.subscription.priceId);
      }
    });
  }, [session?.user, currentPriceId]);

  // 首页运行时区块位于 Suspense 中。跨页携带 #pricing 导航时，
  // 浏览器首次尝试滚动时目标节点可能尚未挂载，因此在挂载后补做一次定位。
  useEffect(() => {
    if (window.location.hash !== "#pricing") return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById("pricing")?.scrollIntoView({ block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  /**
   * 获取计划配置
   */
  const getPlanConfig = (planId: string) => {
    const config = payment ?? paymentConfig;
    return config.plans[planId as keyof typeof config.plans];
  };

  /**
   * 获取计划的当前价格
   */
  const getCurrentPrice = (planId: string) => {
    const config = getPlanConfig(planId);
    if (!config || !("prices" in config) || !config.prices) return null;
    return getPlanPrice(
      { ...config, name: "", description: "", features: [], cta: "" },
      PlanInterval.MONTH
    );
  };

  /**
   * 获取显示价格
   */
  const getDisplayPrice = (planId: string): number => {
    if (planId === "free") return 0;
    const price = getCurrentPrice(planId);
    return price?.amount ?? 0;
  };

  /**
   * 获取价格后缀
   */
  const getPriceSuffix = (planId: string): string => {
    if (planId === "free") return "";
    return "/month";
  };

  /**
   * 检查是否为当前订阅
   */
  const isCurrentPlan = (planId: string) => {
    if (!activePriceId) return false;
    const config = getPlanConfig(planId);
    if (!config || !("prices" in config) || !config.prices) return false;
    return config.prices.some((p) => p.priceId === activePriceId);
  };

  const getPlanIdByPriceId = (priceId: string | null) => {
    if (!priceId) return null;
    for (const planId of PLAN_IDS) {
      const config = getPlanConfig(planId);
      if (!config || !("prices" in config) || !config.prices) continue;
      if (config.prices.some((price) => price.priceId === priceId)) {
        return planId;
      }
    }
    return null;
  };

  const getActivePriceInterval = () => {
    if (!activePriceId) return PlanInterval.MONTH;
    const activePlanId = getPlanIdByPriceId(activePriceId);
    const activeConfig = activePlanId ? getPlanConfig(activePlanId) : null;
    const price =
      activeConfig && "prices" in activeConfig
        ? activeConfig.prices?.find((item) => item.priceId === activePriceId)
        : null;
    return price?.interval ?? PlanInterval.MONTH;
  };

  const getCheckoutPrice = (planId: string) => {
    const config = getPlanConfig(planId);
    if (!config || !("prices" in config) || !config.prices) return null;
    return getPlanPrice(
      { ...config, name: "", description: "", features: [], cta: "" },
      getActivePriceInterval()
    );
  };

  const canUpgradeToPlan = (planId: string) => {
    if (!activePriceId || planId === "free") return false;
    const currentPlanId = getPlanIdByPriceId(activePriceId);
    if (!currentPlanId || !(planId in PLAN_RANK)) return false;
    return PLAN_RANK[planId as SubscriptionPlan] > PLAN_RANK[currentPlanId];
  };

  /**
   * 检查用户是否有活跃订阅（任意计划）
   */
  const hasSubscription = !!activePriceId;
  const activePlanId = getPlanIdByPriceId(activePriceId);

  /**
   * 检查是否为热门计划
   */
  const isPopular = (planId: string) => {
    const config = getPlanConfig(planId);
    return config && "popular" in config && config.popular;
  };

  const copy = (en: string, zh: string) => (isZh ? zh : en);
  const formatNumber = (
    value: number,
    options?: Intl.NumberFormatOptions
  ) => new Intl.NumberFormat(locale, options).format(value);
  const formatCredits = (value: number) =>
    formatNumber(value, { maximumFractionDigits: 0 });
  const formatCreditAmount = (value: number) =>
    formatNumber(value, { maximumFractionDigits: 2 });
  const formatMoney = (value: number) =>
    `¥${formatNumber(value, { maximumFractionDigits: 2 })}`;
  const getPlanPresentation = (planId: PricingPlanId) =>
    buildPlanPresentation({
      planId,
      capabilityMatrix,
      imageRetentionPolicy,
      locale,
    });
  const normalizedImageBasePricing = getImageBaseCreditPricing(imageBasePricing);
  const textModerationCredits =
    TEXT_MODERATION_PRICE_CNY / REFERENCE_CREDIT_PRICE_CNY;
  const imageModerationCredits =
    IMAGE_MODERATION_PRICE_CNY / REFERENCE_CREDIT_PRICE_CNY;
  const textTo4kCredits = getImageCreditCostBreakdown("3840x2160", {
    basePricing: normalizedImageBasePricing,
    imageModerationCount: 0,
    textModerationCount: 1,
  }).totalCredits;
  const getEstimated4kCount = (credits: number) =>
    Math.max(0, Math.floor(credits / textTo4kCredits));

  const getRoundCreditSummary = (
    key: "chatRoundCredits" | "agentRoundCredits"
  ) => {
    const entries = PLAN_IDS.map((planId) => ({
      planId,
      value: capabilityMatrix.billing[planId as SubscriptionPlan][key],
    }));
    const uniqueValues = new Set(entries.map((entry) => entry.value));
    if (uniqueValues.size === 1) {
      const firstValue = entries[0]?.value ?? 0;
      return copy(
        `${formatCreditAmount(firstValue)} credits/round for all plans`,
        `所有套餐 ${formatCreditAmount(firstValue)} 积分/轮`
      );
    }
    return entries
      .map(({ planId, value }) =>
        copy(
          `${t(`plans.${planId}.name`)} ${formatCreditAmount(value)}`,
          `${t(`plans.${planId}.name`)} ${formatCreditAmount(value)}`
        )
      )
      .join(copy(", ", "，"));
  };

  const pricingSubtitle = copy(
    `Pay with credits. Subscription credits follow the current plan period; other credits follow the batch expiry shown on the usage page. Base image pricing is loaded from admin settings: 1024×1024 = ${formatCreditAmount(
      normalizedImageBasePricing.base1024Credits
    )} credits, 4K = ${formatCreditAmount(
      normalizedImageBasePricing.base4kCredits
    )} credits, plus ${formatCreditAmount(
      textModerationCredits
    )} text review and ${formatCreditAmount(imageModerationCredits)} image review credits.`,
    `按积分付费，订阅积分按套餐周期有效，其他积分以用量页显示的批次到期时间为准。出图基础价格读取后台配置：1024×1024 = ${formatCreditAmount(
      normalizedImageBasePricing.base1024Credits
    )} 积分，4K = ${formatCreditAmount(
      normalizedImageBasePricing.base4kCredits
    )} 积分，并叠加文本审核 ${formatCreditAmount(
      textModerationCredits
    )}、图片审核 ${formatCreditAmount(imageModerationCredits)} 积分。`
  );

  const billingRuleItems = [
    copy(
      `Base image credits are loaded from admin settings: 1024×1024 = ${formatCreditAmount(
        normalizedImageBasePricing.base1024Credits
      )} credits, 3840×2160 / 2160×3840 = ${formatCreditAmount(
        normalizedImageBasePricing.base4kCredits
      )} credits. Sizes between them are linearly interpolated by output pixels; below 1024×1024 uses the 1024 price floor, and above 4K uses the 4K cap.`,
      `基础出图读取后台配置：1024×1024 = ${formatCreditAmount(
        normalizedImageBasePricing.base1024Credits
      )} 积分，3840×2160 / 2160×3840 = ${formatCreditAmount(
        normalizedImageBasePricing.base4kCredits
      )} 积分；中间尺寸按实际输出像素量线性推算，低于 1024×1024 按 1024 价格封底，高于 4K 按 4K 价格封顶。`
    ),
    copy(
      `Page Chat base round charge comes from the Plan Capability Matrix: ${getRoundCreditSummary(
        "chatRoundCredits"
      )}. If the round generates images, actual image output and review fees are added.`,
      `页面 Chat 基础轮次费读取套餐能力矩阵：${getRoundCreditSummary(
        "chatRoundCredits"
      )}；若本轮生成图片，再叠加实际图片输出和审核费用。`
    ),
    copy(
      `Page Agent base round charge comes from the Plan Capability Matrix: ${getRoundCreditSummary(
        "agentRoundCredits"
      )}. Agent stream previews are not charged as final image outputs; final completed images are billed by actual size and count.`,
      `页面 Agent 基础轮次费读取套餐能力矩阵：${getRoundCreditSummary(
        "agentRoundCredits"
      )}；Agent 流式预览不按成品图单独收费，最终成品图按实际尺寸和数量追加计费。`
    ),
    copy(
      `Text review: ${formatCreditAmount(
        textModerationCredits
      )} credits per request, calculated only from the latest input text.`,
      `文本审核：每次 ${formatCreditAmount(
        textModerationCredits
      )} 积分，只按本次最新输入文本计算。`
    ),
    copy(
      `Image review: ${formatCreditAmount(
        imageModerationCredits
      )} credits for each image in the current input; text-to-image has no image review fee.`,
      `图片审核：本次输入的每张图片 ${formatCreditAmount(
        imageModerationCredits
      )} 积分；文生图无输入图时不收图片审核费。`
    ),
    copy(
      "Final price = Chat/Agent base round credits + base image credits + text review credits + input image review credits, shown and charged with two decimals. Plain text-to-image/image-edit requests do not include Chat/Agent base round credits.",
      "最终价格 = Chat/Agent 每轮基础积分 + 基础出图积分 + 文本审核积分 + 输入图片审核积分，按两位小数展示和扣费。普通文生图/图生图没有 Chat/Agent 每轮基础积分。"
    ),
  ];

  const getPackagePriceForPlan = (
    pkg: RuntimeCreditPackage,
    plan: SubscriptionPlan
  ) => {
    for (let i = PLAN_RANK[plan]; i >= 0; i -= 1) {
      const candidate = SUBSCRIPTION_PLANS.find((item) => PLAN_RANK[item] === i);
      if (candidate && pkg.pricesByPlan?.[candidate]) {
        return pkg.pricesByPlan[candidate]!;
      }
    }
    return pkg.price;
  };

  const getPackagePlanPrices = (pkg: RuntimeCreditPackage) =>
    PLAN_IDS.filter(
      (planId) =>
        !pkg.requiresPlan ||
        PLAN_RANK[planId as SubscriptionPlan] >= PLAN_RANK[pkg.requiresPlan]
    ).map((planId) => ({
      planId,
      price: getPackagePriceForPlan(pkg, planId as SubscriptionPlan),
    }));

  const getPackageExpiryText = () => {
    if (creditPackageExpiryDays === 0) {
      return copy("Credits never expire", "积分永不过期");
    }
    if (typeof creditPackageExpiryDays === "number") {
      return copy(
        `Valid for ${creditPackageExpiryDays} days`,
        `有效期 ${creditPackageExpiryDays} 天`
      );
    }
    return copy("Expiry follows the issued batch", "有效期按发放批次记录");
  };

  /**
   * 处理订阅按钮点击
   */
  const handleSubscribe = async (planId: string) => {
    if (planId === "free") {
      router.push(session?.user ? "/dashboard" : "/sign-up");
      return;
    }

    if (!session?.user) {
      router.push("/sign-in?redirect=/#pricing");
      return;
    }

    const price = getCheckoutPrice(planId);
    if (!price?.priceId) {
      toast.error(
        copy(
          "This plan is temporarily unavailable for purchase.",
          "该套餐暂时无法购买，请稍后重试。"
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
        console.error("Failed to create checkout session:", error);
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

  /**
   * 处理管理订阅按钮点击 — 跳转到账单设置页
   */
  const handleManageSubscription = () => {
    router.push("/dashboard/settings");
  };

  const handleBuyCredits = (packageId?: string) => {
    const buyPath = packageId
      ? `/dashboard/credits/buy?package=${encodeURIComponent(packageId)}`
      : "/dashboard/credits/buy";
    router.push(
      session?.user
        ? buyPath
        : `/sign-in?redirect=${encodeURIComponent(buyPath)}`
    );
  };

  /**
   * 轴身(Card 全体):两轨共用的业务内容,订阅交互与能力清单在内。
   * 签条(推荐/当前)由 renderPlanBadge 单独渲染——廊道轨的展卷裁切
   * 会切掉超出轴顶的部分,签条必须位于裁切层之外,故不在 Card 内。
   */
  const renderPlanCard = (planId: PricingPlanId) => {
    const isCurrent = isCurrentPlan(planId);
    const canUpgrade = canUpgradeToPlan(planId);
    const isLoading = loadingPlan === planId;
    const popular = isPopular(planId);
    const presentation = getPlanPresentation(planId);
    const planCredits = presentation.monthlyCredits;
    return (
      <Card
        className={cn(
          // 轴身:去圆角的纸面,悬停以边色与投影回应(立轴不抬升)。
          // gap-5/py-5:密度收紧,全轴(绳杆地杆含)须容于一屏紧视口
          // duration-200:对齐全站 hover 过渡规格
          "relative flex h-full flex-col gap-5 rounded-none border-border py-5 transition-[border-color,box-shadow] duration-200 hover:border-foreground/30 hover:shadow-whisper",
          // 推荐档:细 ring + 轻阴影,替代粗边框重阴影
          popular && !isCurrent && "ring-1 ring-foreground/20 shadow-whisper",
          // enterprise 卡边框本就更深,悬停保持同深度避免反向变浅
          planId === "enterprise" &&
            "border-foreground/60 bg-muted/20 hover:border-foreground/60",
          isCurrent && "ring-2 ring-foreground"
        )}
      >
        <CardHeader>
          <CardTitle className="text-lg font-medium">
            {t(`plans.${planId}.name`)}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {presentation.description}
          </p>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col">
          <div className="mb-4">
            {/* 价格数字:衬线大号 */}
            <span className="font-serif text-4xl font-medium">
              ¥<AnimatedPrice value={getDisplayPrice(planId)} />
            </span>
            <span className="text-sm text-muted-foreground">
              {getPriceSuffix(planId)}
            </span>
          </div>

          {/* Credits highlight:轴身内的"地纸"块,延续 rounded-none 纸面语言,
              只以底色区分,不再引入圆角盒中盒 */}
          <div className="mb-4 rounded-none bg-muted/40 px-3 py-2.5">
            <div className="flex items-center gap-1.5">
              <Coins className="size-4 text-foreground" />
              <span className="font-serif text-lg font-medium">
                {planId === "free" ? (
                  formatCredits(planCredits)
                ) : (
                  <AnimatedPrice
                    value={planCredits}
                    formatOptions={{
                      useGrouping: true,
                      maximumFractionDigits: 0,
                    }}
                  />
                )}
              </span>
              <span className="text-xs text-muted-foreground">
                {planId === "free"
                  ? copy("credits", "积分")
                  : copy("credits / month", "积分 / 月")}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
              <ImageIcon className="size-3" />
              <span>
                {t("booksNote", {
                  count: formatCredits(getEstimated4kCount(planCredits)),
                })}
              </span>
            </div>
            {planId === "free" && (
              <div className="mt-1 text-xs text-muted-foreground">
                {copy("one-time", "一次性")}
              </div>
            )}
          </div>

          <div className="mb-5">
            {isCurrent && payment?.provider === "epay" ? (
              <Button
                className="w-full"
                variant="outline"
                onClick={() => handleSubscribe(planId)}
                disabled={isLoading || isPending}
              >
                {isLoading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                {copy("Renew current plan", "续购当前套餐")}
              </Button>
            ) : isCurrent ? (
              <Button
                className="w-full"
                variant="outline"
                onClick={handleManageSubscription}
                disabled={isPending}
              >
                {isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                {t("manageSubscription")}
              </Button>
            ) : hasSubscription && planId !== "free" && !canUpgrade ? (
              <Button className="w-full" variant="outline" disabled>
                {t("alreadySubscribed")}
              </Button>
            ) : (
              <Button
                className="w-full"
                variant={popular ? "default" : "outline"}
                onClick={() => handleSubscribe(planId)}
                disabled={isLoading || isPending}
              >
                {isLoading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                {canUpgrade ? t("upgradePlan") : t(`plans.${planId}.cta`)}
              </Button>
            )}
          </div>

          {/* 密度收紧:最长档清单 11 条,全轴(绳杆地杆含)须一屏容纳 */}
          <ul className="flex-1 space-y-1.5">
            {presentation.features.map((feature) => (
              <li key={feature} className="flex items-center gap-2">
                <Check className="h-4 w-4 shrink-0 text-foreground" />
                <span className="text-sm text-muted-foreground">
                  {feature}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    );
  };

  /** 签条:当前订阅优先于推荐;定位与动效由两轨各自包装 */
  const renderPlanBadge = (planId: PricingPlanId) => {
    if (isCurrentPlan(planId)) {
      return (
        <Badge className="bg-foreground text-background">
          {t("currentPlan")}
        </Badge>
      );
    }
    if (isPopular(planId)) {
      return (
        <Badge className="bg-foreground text-background">
          {t("mostPopular")}
        </Badge>
      );
    }
    return null;
  };

  // -- 套餐轮播控制 --
  const plansScrollRef = useRef<HTMLDivElement>(null);
  // 润格立轴垂落入场;减动效偏好下直接呈现终态
  const reduceMotion = useReducedMotion();

  // 展现双轨(v1.0.1 润格廊,v1.1.1 改 CSS 断点显隐):两轨常驻 DOM,
  // lg+ 且非减动效由 media query 显示廊道、隐藏轮播,其余反之。
  // WHY 不用 JS matchMedia 切换:SSR 恒输出单轨时,锚点直达或刷新
  // 恢复滚动位置的用户会看到轮播闪现再突变为廊道(实证缺陷);
  // CSS 在首字节渲染即正确,零切换帧。隐藏轨无布局成本,交互状态
  // (订阅 loading 等)两轨共享同一组件闭包。

  /** 桌面端箭头:按一张卡宽度(含 24px 间距)平滑步进 */
  const scrollPlans = (direction: 1 | -1) => {
    const container = plansScrollRef.current;
    if (!container) return;
    const card = container.querySelector<HTMLElement>("[data-plan-card]");
    const step = (card?.offsetWidth ?? 330) + 24;
    container.scrollBy({ left: direction * step, behavior: "smooth" });
  };

  // 首次挂载把推荐档滚到视口中央(instant,不与入场动画抢戏)。
  // 无依赖数组 + ref 门闩:isPopular 每渲染变身份,进 deps 会反复触发。
  const didCenterPopularRef = useRef(false);
  useEffect(() => {
    if (didCenterPopularRef.current) return;
    didCenterPopularRef.current = true;
    const container = plansScrollRef.current;
    if (!container) return;
    const popularId = PLAN_IDS.find((id) => isPopular(id));
    if (!popularId) return;
    const el = container.querySelector<HTMLElement>(
      `[data-plan-card="${popularId}"]`
    );
    if (!el) return;
    const left = el.offsetLeft - (container.clientWidth - el.offsetWidth) / 2;
    container.scrollTo({ left: Math.max(0, left), behavior: "instant" });
  });

  return (
    <InkRevealBoundary>
    <section id="pricing" className="scroll-mt-16 py-20 md:py-28">
      <div className="container mx-auto max-w-6xl">
        {/* Header 揭幕(v1.0.2):眉标/标题/副标随滚动错落显影,
            标题下装裱横档自中心生长——进入廊道前的开幕一拍 */}
        <div className="mb-12 text-center">
          <InkReveal>
            <p className="mb-3 text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
              {tCinema("framingLabel")}
            </p>
          </InkReveal>
          <InkReveal phase={0.22}>
            {/* 首页谷段 section 标题统一一档:text-3xl -> md:text-4xl(与 FAQ 对齐) */}
            <h2 className="mb-4 text-balance font-serif text-3xl font-medium tracking-tight md:text-4xl">
              {t("title")}
            </h2>
          </InkReveal>
          <InkRule className="mx-auto mb-5 w-24" />
          <InkReveal phase={0.42}>
            <p className="mx-auto max-w-2xl leading-relaxed text-muted-foreground">
              {pricingSubtitle}
            </p>
          </InkReveal>
        </div>
      </div>

      {/* 展现双轨(CSS media query 显隐,SSR 即正确形态):
          - 廊道(lg+ 且非减动效):sticky 舞台,竖滚横移 + 逐轴展卷,
            滚动跟随可倒放——影片镜头语言延伸到谷段
          - 轮播(其余):snap 横向轮播 + 垂落入场,触屏直接滑,
            桌面左右箭头按 1 卡步进,首次挂载推荐档滚到中央 */}
      <div className="hidden lg:motion-safe:block">
        <PlanGalleryStage
          items={PLAN_IDS.map(
            (planId): PlanGalleryItem => ({
              planId,
              popular: !!isPopular(planId) && !isCurrentPlan(planId),
              card: renderPlanCard(planId),
              badge: renderPlanBadge(planId),
            })
          )}
        />
      </div>
      <div className="lg:motion-safe:hidden">
      <div className="relative">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 z-10 w-12 bg-gradient-to-r from-background to-transparent md:w-24"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 z-10 w-12 bg-gradient-to-l from-background to-transparent md:w-24"
        />
        <button
          type="button"
          aria-label={copy("Previous plan", "上一个套餐")}
          onClick={() => scrollPlans(-1)}
          className="absolute left-4 top-1/2 z-20 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-background/90 text-muted-foreground shadow-menu backdrop-blur transition-[color,border-color,scale] duration-150 hover:border-foreground/40 hover:text-foreground active:scale-95 md:flex"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <button
          type="button"
          aria-label={copy("Next plan", "下一个套餐")}
          onClick={() => scrollPlans(1)}
          className="absolute right-4 top-1/2 z-20 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-background/90 text-muted-foreground shadow-menu backdrop-blur transition-[color,border-color,scale] duration-150 hover:border-foreground/40 hover:text-foreground active:scale-95 md:flex"
        >
          <ChevronRight className="h-5 w-5" />
        </button>

        <div
          ref={plansScrollRef}
          className="scrollbar-none flex snap-x snap-mandatory gap-6 overflow-x-auto scroll-smooth px-[max(1.5rem,calc((100vw-72rem)/2))] py-6"
        >
          {PLAN_IDS.map((planId) => {
            const badge = renderPlanBadge(planId);
            return (
              // 润格立轴(轮播轨):每档套餐是一幅挂单的窄长立轴——
              // 上卷杆/下地杆带轴头,入场自上方垂落展开并微摆
              // (书画家挂润格的传统);签条(推荐/当前)挂在卷杆下。
              // 业务交互(订阅/管理/能力清单)在共用轴身内原样保留。
              <motion.div
                key={planId}
                data-plan-card={planId}
                initial={
                  reduceMotion ? false : { opacity: 0, scaleY: 0.08, rotate: 0.8 }
                }
                whileInView={{ opacity: 1, scaleY: 1, rotate: 0 }}
                viewport={{ once: true, margin: "-40px" }}
                transition={{ duration: 0.7, ease: [0.22, 0.8, 0.36, 1] }}
                style={{ transformOrigin: "top center" }}
                className="w-[300px] shrink-0 snap-center sm:w-[330px] lg:w-[350px]"
              >
                <div
                  aria-hidden="true"
                  className="-mx-2 mb-1.5 h-1.5 rounded-full bg-foreground/75"
                />
                <div className="relative">
                  {badge ? (
                    <div className="absolute -top-3 left-1/2 z-10 -translate-x-1/2">
                      {badge}
                    </div>
                  ) : null}
                  {renderPlanCard(planId)}
                </div>
                <div
                  aria-hidden="true"
                  className="relative -mx-3.5 mt-1.5 h-2 rounded-full bg-foreground/85"
                >
                  <span className="absolute -left-1 top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-foreground" />
                  <span className="absolute -right-1 top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-foreground" />
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>
      </div>

      <div className="container mx-auto max-w-6xl">
        {creditPackages.length > 0 && (
          <div className="mt-10">
            <InkReveal>
              <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <h3 className="font-serif text-xl font-medium">
                    {copy("Extra Credit Packages", "额外积分包")}
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {copy(
                      "Top up without changing your subscription. Package names, credits, prices, and plan restrictions come from the admin credit package matrix.",
                      "无需更换订阅即可补充积分。积分包名称、额度、价格和套餐限制均读取后台积分包矩阵。"
                    )}
                  </p>
                </div>
                <Button variant="outline" onClick={() => handleBuyCredits()}>
                  <ShoppingCart className="mr-2 h-4 w-4" />
                  {copy("View packages", "查看积分包")}
                </Button>
              </div>
            </InkReveal>

            {/* 墨笺落案(v1.0.2):积分包是案头便笺——顶部墨标条,
                逐张随滚动带微倾落定(相位按列错落,滚回收起) */}
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {creditPackages.map((pkg, pkgIndex) => {
                const planPrices = getPackagePlanPrices(pkg);
                const prices = planPrices.map((item) => item.price);
                const minPrice = Math.min(...prices);
                const maxPrice = Math.max(...prices);
                const activePackagePrice =
                  activePlanId && isPricingPlanId(activePlanId)
                    ? getPackagePriceForPlan(
                        pkg,
                        activePlanId as SubscriptionPlan
                      )
                    : null;
                const displayPrice =
                  minPrice === maxPrice
                    ? formatMoney(minPrice)
                    : `${formatMoney(minPrice)} - ${formatMoney(maxPrice)}`;
                const packageName = getLocalizedCreditPackageName(pkg, locale);
                const packageDescription =
                  getLocalizedCreditPackageDescription(pkg, locale);

                return (
                  <InkReveal
                    key={pkg.id}
                    phase={(pkgIndex % 3) * 0.18}
                    tilt={pkgIndex % 2 === 0 ? -1.1 : 1.1}
                  >
                  <div
                    aria-hidden="true"
                    className="mx-3 h-1 rounded-full bg-foreground/80"
                  />
                  <Card
                    className={cn(
                      // 与订阅轴同 hover 语言(200ms 过渡),避免同页两套时值
                      "flex h-full flex-col rounded-none border-border transition-[border-color,box-shadow] duration-200 hover:border-foreground/30 hover:shadow-whisper",
                      pkg.popular && "ring-1 ring-foreground/20 shadow-whisper"
                    )}
                  >
                    <CardHeader className="space-y-2">
                      <div className="flex items-start justify-between gap-3">
                        {/* 卡片标题字号与订阅轴对齐(text-lg) */}
                        <CardTitle className="text-lg font-medium">
                          {packageName}
                        </CardTitle>
                        {pkg.popular && (
                          <Badge variant="secondary">
                            {copy("Best value", "最划算")}
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {packageDescription ||
                          copy("One-time credit package", "一次性积分包")}
                      </p>
                    </CardHeader>
                    <CardContent className="flex flex-1 flex-col gap-4">
                      <div>
                        <div className="flex items-end gap-2">
                          <span className="font-serif text-3xl font-medium">
                            {displayPrice}
                          </span>
                          <span className="pb-1 text-sm text-muted-foreground">
                            {copy("CNY", "元")}
                          </span>
                        </div>
                        {activePackagePrice !== null && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {copy(
                              `Your plan price: ${formatMoney(activePackagePrice)}`,
                              `当前套餐价：${formatMoney(activePackagePrice)}`
                            )}
                          </p>
                        )}
                      </div>

                      <ul className="space-y-2 text-sm text-muted-foreground">
                        <li className="flex gap-2">
                          <Check className="mt-0.5 h-4 w-4 shrink-0 text-foreground" />
                          <span>
                            {copy(
                              `${formatCredits(pkg.credits)} credits per pack`,
                              `每份 ${formatCredits(pkg.credits)} 积分`
                            )}
                          </span>
                        </li>
                        <li className="flex gap-2">
                          <Check className="mt-0.5 h-4 w-4 shrink-0 text-foreground" />
                          <span>{getPackageExpiryText()}</span>
                        </li>
                        {pkg.allowQuantity && (
                          <li className="flex gap-2">
                            <Check className="mt-0.5 h-4 w-4 shrink-0 text-foreground" />
                            <span>
                              {copy(
                                `Quantity purchase, up to ${pkg.maxQuantity ?? 999} packs`,
                                `可按数量购买，最多 ${pkg.maxQuantity ?? 999} 份`
                              )}
                            </span>
                          </li>
                        )}
                        {pkg.requiresPlan && (
                          <li className="flex gap-2">
                            <Check className="mt-0.5 h-4 w-4 shrink-0 text-foreground" />
                            <span>
                              {copy(
                                `Available from ${t(`plans.${pkg.requiresPlan}.name`)}`,
                                `${t(`plans.${pkg.requiresPlan}.name`)}及以上可购买`
                              )}
                            </span>
                          </li>
                        )}
                      </ul>

                      <div className="flex flex-wrap gap-2">
                        {planPrices.map(({ planId, price }) => (
                          // 徽章形状走 Badge 默认(rounded-full),不再第三种形状
                          <Badge key={`${pkg.id}-${planId}`} variant="outline">
                            {t(`plans.${planId}.name`)} {formatMoney(price)}
                          </Badge>
                        ))}
                      </div>
                    </CardContent>
                    <CardFooter>
                      <Button
                        className="w-full"
                        variant={pkg.popular ? "default" : "outline"}
                        onClick={() => handleBuyCredits(pkg.id)}
                      >
                        <ShoppingCart className="mr-2 h-4 w-4" />
                        {copy("Buy this package", "购买此积分包")}
                      </Button>
                    </CardFooter>
                  </Card>
                  </InkReveal>
                );
              })}
            </div>
          </div>
        )}

        {/* 例言(v1.0.2):计费规则的书页凡例体——灰底白卡退役,
            标题居中两侧短线,条目衬线序号(一/二/…),随滚动逐条
            显影(相位错落,滚回倒放)。文案与条目内容不动。 */}
        <div className="mt-12 border-y border-border/60 py-8">
          <InkReveal>
            <div className="flex items-center justify-center gap-4">
              <span aria-hidden="true" className="h-px w-10 bg-foreground/30" />
              <h3 className="text-sm font-medium tracking-[0.2em]">
                {t("billingRules.title")}
              </h3>
              <span aria-hidden="true" className="h-px w-10 bg-foreground/30" />
            </div>
          </InkReveal>
          <ul className="mt-6 grid gap-x-10 gap-y-3.5 text-sm leading-relaxed text-muted-foreground md:grid-cols-2">
            {billingRuleItems.map((item, index) => (
              <li key={item}>
                <InkReveal phase={Math.min(0.8, index * 0.14)}>
                  <div className="flex gap-3">
                    <span
                      aria-hidden="true"
                      className="shrink-0 font-serif text-muted-foreground/60"
                    >
                      {folioNumeral(index, isZh)}
                    </span>
                    <span>{item}</span>
                  </div>
                </InkReveal>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
    </InkRevealBoundary>
  );
}
