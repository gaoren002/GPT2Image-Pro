"use client";

import { cn } from "../utils";

/**
 * 统一骨架屏组件(全站加载态单一来源)。
 *
 * 用途:内容加载期间的占位,替代散落各页的"加载中..."文字。
 * 样式:muted 底 + 前景微光横向扫过(shimmer),黑白墨纸风内保持克制。
 * 用法:<Skeleton className="h-4 w-32" /> 组合出目标布局的轮廓。
 *
 * 参数:className 追加尺寸/圆角(默认 rounded-md);其余属性透传至 div。
 * 动效:遵守 prefers-reduced-motion(reduce 时静置不扫光)。
 */
function Skeleton({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("skeleton-shimmer rounded-md", className)}
      {...props}
    />
  );
}

export { Skeleton };
