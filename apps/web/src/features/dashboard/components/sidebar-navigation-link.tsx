"use client";

/** 保留 Next Link 默认 AUTO 与原导航；仅在真实客户端导航时并行预热页面模块。 */
import Link from "next/link";
import type { MouseEventHandler, ReactNode } from "react";
import { preloadSidebarPageModule } from "@/features/dashboard/sidebar-page-module-preload";

type SidebarNavigationLinkProps = {
  href: string;
  title?: string;
  className?: string;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  children?: ReactNode;
};

/** 透传原链接属性和子树，模块导入不等待、不拦截 Next 的正常软导航。 */
export function SidebarNavigationLink({
  href,
  title,
  className,
  onClick,
  children,
}: SidebarNavigationLinkProps) {
  return (
    <Link
      href={href}
      title={title}
      className={className}
      onClick={onClick}
      onNavigate={() => {
        void preloadSidebarPageModule(href);
      }}
    >
      {children}
    </Link>
  );
}
