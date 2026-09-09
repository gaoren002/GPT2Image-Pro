"use client";

import { Menu, PanelLeft, PanelLeftClose } from "lucide-react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

import { useSidebar } from "@/features/dashboard/context";
import { cn } from "@repo/ui/utils";

/**
 * 从路径名获取页面标题翻译键
 */
function getPageTitleKey(pathname: string): string {
  const path = pathname.replace(/^\/[a-z]{2}\//, "/");
  const keyMap: Record<string, string> = {
    "/dashboard": "dashboard",
    "/dashboard/create": "create",
    "/dashboard/gallery": "gallery",
    "/dashboard/history": "history",
    "/dashboard/generate": "generate",
    "/dashboard/tasks": "tasks",
    "/dashboard/decks": "myDecks",
    "/dashboard/credits/buy": "creditsBuy",
    "/dashboard/support": "support",
    "/dashboard/support/new": "newTicket",
    "/dashboard/announcements": "announcements",
    "/dashboard/backend-help": "backendHelp",
    "/dashboard/external-api": "externalApi",
    "/dashboard/billing": "billing",
    "/dashboard/settings": "settings",
    "/dashboard/admin/users": "userManagement",
    "/dashboard/admin/announcements": "announcementManagement",
    "/dashboard/admin/settings": "systemSettings",
    "/dashboard/admin/status": "globalStatus",
    "/dashboard/settings/profile": "profile",
    "/dashboard/settings/security": "security",
    "/dashboard/settings/notifications": "notifications",
  };

  // 精确匹配
  if (keyMap[path]) {
    return keyMap[path];
  }

  // 动态路由匹配 (如 /dashboard/decks/[id], /dashboard/support/[id])
  if (path.startsWith("/dashboard/decks/")) {
    return "deckDetails";
  }
  if (path.startsWith("/dashboard/support/")) {
    return "ticketDetails";
  }

  return "dashboard";
}

/**
 * Dashboard 主内容区域包装器
 *
 * 根据侧边栏折叠状态动态调整左边距
 * 内容区域为卡片样式，包含 Header 和内容
 */
export function DashboardMainWrapper({
  children,
}: {
  children: React.ReactNode;
}) {
  const { isCollapsed, toggleSidebar, toggleMobile } = useSidebar();
  const pathname = usePathname();
  const t = useTranslations("Dashboard.pages");
  const pageTitleKey = getPageTitleKey(pathname);
  const pageTitle = t(pageTitleKey);

  return (
    <main
      className={cn(
        // 仅过渡左边距,与侧栏宽度动画同步且不波及其它属性
        "p-2.5 min-h-screen transition-[margin] duration-300",
        isCollapsed ? "md:ml-16" : "md:ml-64"
      )}
    >
      {/* 卡片容器 - Linear style: clean background, subtle border */}
      <div className="min-h-[calc(100vh-20px)] rounded-lg bg-background border border-border flex flex-col">
        {/* 悬浮玻璃顶栏:sticky 停驻在卡片原顶位(main 上内边距 10px 处),
            半透明底 + backdrop-blur 让内容滚过其后仍可读;rounded-t-lg 与卡片圆角贴合。
            before 伪元素以页面底色(bg-muted)填补停驻后顶栏上方 10px 的缝隙,
            高度取 9px 而非 10px,是为了未滚动时不遮住卡片自身 1px 的顶边框 */}
        {/* 悬浮玻璃顶栏:sticky 停驻在卡片原顶位(main 上内边距 10px 处),
            半透明底 + backdrop-blur 让内容滚过其后仍可读;rounded-t-lg 与卡片圆角贴合。
            before 伪元素以页面底色(bg-muted)填补停驻后顶栏上方 10px 的缝隙,
            高度取 9px 而非 10px,是为了未滚动时不遮住卡片自身 1px 的顶边框。
            阴影对齐全站浮动卡面语言(whisper),与创作页 sticky 头同规格 */}
        <header className="sticky top-2.5 z-30 flex h-12 shrink-0 items-center gap-3 rounded-t-lg border-b border-border/60 bg-background/95 px-4 shadow-whisper backdrop-blur before:absolute before:-inset-x-px before:-top-2.5 before:h-[9px] before:bg-muted">
          {/* 移动端汉堡按钮 */}
          <button
            type="button"
            onClick={toggleMobile}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors duration-150 md:hidden"
          >
            <Menu className="h-4 w-4 pointer-events-none" />
          </button>

          {/* 桌面端侧边栏折叠按钮 */}
          <button
            type="button"
            onClick={toggleSidebar}
            className="hidden h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors duration-150 md:flex"
          >
            {isCollapsed ? (
              <PanelLeft className="h-4 w-4 pointer-events-none" />
            ) : (
              <PanelLeftClose className="h-4 w-4 pointer-events-none" />
            )}
          </button>

          {/* 分割线 - 与文字等高，淡色 */}
          <div className="h-4 w-px bg-border" />

          {/* 页面标题 */}
          <span className="font-serif text-sm font-medium tracking-tight text-foreground">
            {pageTitle}
          </span>
        </header>

        {/* 内容区域 */}
        <div className="min-w-0 flex-1 overflow-x-auto p-6">{children}</div>
      </div>
    </main>
  );
}
