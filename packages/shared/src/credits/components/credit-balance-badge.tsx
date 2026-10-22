"use client";

/**
 * 积分余额徽章组件
 *
 * 显示在侧边栏中，展示用户当前可用积分
 */

import { Badge } from "@repo/ui/components/badge";
import { Coins } from "lucide-react";
import { useAction } from "next-safe-action/hooks";
import { useEffect } from "react";
import { getMyCreditsBalance } from "../actions";
import { formatCredits } from "../format";

/**
 * 积分余额徽章
 *
 * 特性:
 * - 自动获取用户积分余额
 * - 显示为闪电图标 + 数字格式
 * - 支持 Tooltip 显示详情
 */
export function CreditBalanceBadge({
  initialBalance,
}: {
  /** SSR 预取余额:有值时直出数字,不再挂载即拉(侧边栏零等待)。 */
  initialBalance?: number;
}) {
  const { execute, result, isPending } = useAction(getMyCreditsBalance);

  // 有 SSR 预取值时跳过挂载拉取;无值(旧调用方/余额变更后显式刷新)才请求。
  useEffect(() => {
    if (initialBalance === undefined) {
      execute();
    }
  }, [execute, initialBalance]);

  const balance = result.data?.balance ?? initialBalance ?? 0;

  // 加载状态(仅无预取值的调用方会经历)
  if (isPending && initialBalance === undefined) {
    return (
      <Badge variant="secondary" className="gap-1 px-2 py-1">
        <Coins className="h-3 w-3" />
        <span className="text-xs">...</span>
      </Badge>
    );
  }

  return (
    <Badge
      variant="secondary"
      className="gap-1 px-2 py-1 bg-warning/15 text-warning hover:bg-warning/25"
      title="Available Credits"
    >
      <Coins className="h-3 w-3" />
      <span className="text-xs font-medium">{formatCredits(balance)}</span>
    </Badge>
  );
}
