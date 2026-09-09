"use client";

/**
 * 订阅等级徽章组件
 *
 * 根据用户订阅等级显示不同样式的徽章。
 * 黑白单色设计语言:等级差异用"墨色浓度 + 图标 + 微动效"表达,不引入彩色。
 * - Free: 浅灰静态
 * - Starter: 中灰 + 微光扫过
 * - Pro: 深灰 + 流光扫过
 * - Ultra: 近黑反白 + 呼吸光晕
 * - Enterprise: 纯黑反白 + 高光扫过
 */

import "./plan-badge.css";

import { Building2, Crown, Gem, Sparkles, User } from "lucide-react";
import { useTranslations } from "next-intl";

import type { SubscriptionPlan } from "../../config/subscription-plan";
import { cn } from "@repo/ui/utils";

/**
 * 订阅计划类型
 *
 * 直接复用 SubscriptionPlan 作为单一真相来源，避免本地联合类型与套餐定义
 * 静默漂移：新增套餐时 planConfig（Record<SubscriptionPlan>）会因缺键而在
 * 类型检查阶段报错，而非运行时取到 undefined 崩溃。保留 PlanType 别名是为了
 * 不破坏既有按名导入该类型的调用方。
 */
export type PlanType = SubscriptionPlan;

/**
 * 徽章尺寸
 */
export type BadgeSize = "xs" | "sm" | "md" | "lg";

/**
 * PlanBadge 组件属性
 */
interface PlanBadgeProps {
  /** 订阅计划类型 */
  plan: PlanType;
  /** 徽章尺寸 */
  size?: BadgeSize;
  /** 是否显示文字标签 */
  showLabel?: boolean;
  /** 自定义类名 */
  className?: string;
}

/**
 * 尺寸配置
 */
const sizeConfig: Record<
  BadgeSize,
  { badge: string; icon: string; text: string }
> = {
  xs: { badge: "h-5 px-1.5 gap-0.5", icon: "h-3 w-3", text: "text-[10px]" },
  sm: { badge: "h-6 px-2 gap-1", icon: "h-3.5 w-3.5", text: "text-xs" },
  md: { badge: "h-7 px-2.5 gap-1.5", icon: "h-4 w-4", text: "text-sm" },
  lg: { badge: "h-8 px-3 gap-2", icon: "h-5 w-5", text: "text-base" },
};

/**
 * 计划配置
 *
 * WHY 不用彩色:全站为黑白墨纸风,彩色徽章在界面中过度抢眼;等级感改用
 * 墨色浓度递进(free 最浅 -> enterprise 最深)与克制的黑白微动效表达。
 */
const planConfig: Record<
  PlanType,
  {
    icon: typeof User;
    labelKey: string;
    baseStyles: string;
    animationClass: string;
  }
> = {
  free: {
    icon: User,
    labelKey: "free",
    baseStyles:
      "bg-muted text-muted-foreground border border-border/60",
    animationClass: "",
  },
  starter: {
    icon: Sparkles,
    labelKey: "starter",
    baseStyles:
      "bg-secondary text-secondary-foreground border border-border/60",
    animationClass: "plan-badge-sweep",
  },
  pro: {
    icon: Crown,
    labelKey: "pro",
    baseStyles:
      "bg-foreground/85 text-background border border-foreground/85",
    animationClass: "plan-badge-sweep",
  },
  ultra: {
    icon: Gem,
    labelKey: "ultra",
    baseStyles:
      "bg-foreground text-background border border-foreground plan-badge-breathe",
    animationClass: "",
  },
  enterprise: {
    icon: Building2,
    labelKey: "enterprise",
    baseStyles:
      "bg-foreground text-background border border-foreground plan-badge-glint",
    animationClass: "",
  },
};

/**
 * 订阅等级徽章组件
 */
export function PlanBadge({
  plan,
  size = "sm",
  showLabel = true,
  className,
}: PlanBadgeProps) {
  const t = useTranslations("Subscription");
  const config = planConfig[plan];
  const sizeStyles = sizeConfig[size];
  const Icon = config.icon;

  return (
    <div
      className={cn(
        "relative inline-flex items-center justify-center rounded-full font-medium overflow-hidden",
        sizeStyles.badge,
        config.baseStyles,
        config.animationClass,
        className
      )}
    >
      {/* 内容层 */}
      <Icon className={cn("relative z-10", sizeStyles.icon)} />
      {showLabel && (
        <span
          className={cn(
            "relative z-10 font-semibold uppercase tracking-wide",
            sizeStyles.text
          )}
        >
          {t(`plans.${config.labelKey}`)}
        </span>
      )}
    </div>
  );
}
