"use client";

import {
  Activity,
  ChevronsUpDown,
  LogOut,
  Megaphone,
  Server,
  Shield,
  Settings,
  Users,
} from "lucide-react";
import Image from "next/image";
import Link, { useLinkStatus } from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useLocale } from "next-intl";
import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import {
  type MouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@repo/ui/components/avatar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/ui/components/popover";
import { Separator } from "@repo/ui/components/separator";
import { Sheet, SheetContent, SheetTitle } from "@repo/ui/components/sheet";
import { dashboardConfig } from "@repo/shared/config";
import { CreditBalanceBadge } from "@repo/shared/credits/components";
import {
  isAdminRole,
  isObserverAdminRole,
} from "@repo/shared/auth/roles";
import { useSidebar } from "@/features/dashboard/context";
import { ModeToggle } from "@repo/shared/components";
import { getMyUnreadAnnouncementCountAction } from "@repo/shared/announcements/actions";
import { getMyPlanAction } from "@repo/shared/subscription/actions/get-user-plan";
import { getMyUnreadTicketCountAction } from "@repo/shared/support/actions/ticket";
import {
  PlanBadge,
  type PlanType,
} from "@repo/shared/subscription/components/plan-badge";
import { signOut } from "@repo/shared/auth/client";
import { cn } from "@repo/ui/utils";
import {
  useCurrentSession,
  type CurrentSession,
} from "@/features/auth/hooks/use-current-session";

/**
 * Dashboard 侧边栏组件
 *
 * 功能:
 * - 导航菜单 (从配置读取)
 * - 用户信息弹出菜单
 * - 主题切换
 * - 设置入口
 * - 登出功能
 * - 支持折叠/展开
 */
type DashboardSidebarProps = {
  initialSession?: CurrentSession;
};

function SidebarNavigationStatus({
  onPendingChange,
}: {
  onPendingChange: (token: symbol, pending: boolean) => void;
}) {
  const { pending } = useLinkStatus();
  const tokenRef = useRef(Symbol("sidebar-navigation"));

  useEffect(() => {
    const token = tokenRef.current;
    onPendingChange(token, pending);
    return () => onPendingChange(token, false);
  }, [onPendingChange, pending]);

  return null;
}

export function DashboardSidebar({ initialSession }: DashboardSidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const locale = useLocale();
  const { isCollapsed, isMobileOpen, setMobileOpen, toggleSidebar } =
    useSidebar();
  const t = useTranslations("Dashboard");

  // 获取当前用户会话
  const { data: session } = useCurrentSession(initialSession);
  const user = session?.user;
  const isAdmin = isAdminRole(user?.role);
  const isObserverAdmin = isObserverAdminRole(user?.role);

  // Popover 开关状态
  const [open, setOpen] = useState(false);
  const navigationIntentRef = useRef<string | null>(null);
  const pendingNavigationTokensRef = useRef(new Set<symbol>());
  const handleNavigationPendingChange = useCallback(
    (token: symbol, pending: boolean) => {
      if (pending) {
        pendingNavigationTokensRef.current.add(token);
      } else {
        pendingNavigationTokensRef.current.delete(token);
        if (pendingNavigationTokensRef.current.size === 0) {
          navigationIntentRef.current = null;
        }
      }
    },
    []
  );

  // 获取用户订阅计划
  const { execute: fetchPlan, result: planResult } = useAction(getMyPlanAction);
  const userPlan = (planResult.data?.plan as PlanType) || "free";
  const {
    execute: fetchUnreadTickets,
    result: unreadTicketsResult,
  } = useAction(getMyUnreadTicketCountAction);
  const {
    execute: fetchUnreadAnnouncements,
    result: unreadAnnouncementsResult,
  } = useAction(getMyUnreadAnnouncementCountAction);
  const unreadTicketCount = Math.max(
    0,
    Number(unreadTicketsResult.data?.count ?? 0)
  );
  const unreadAnnouncementCount = Math.max(
    0,
    Number(unreadAnnouncementsResult.data?.count ?? 0)
  );

  // 用户登录后获取计划
  useEffect(() => {
    if (user) {
      fetchPlan();
    }
  }, [user, fetchPlan]);

  useEffect(() => {
    if (user) {
      fetchUnreadTickets();
      fetchUnreadAnnouncements();
    }
  }, [user, pathname, fetchUnreadTickets, fetchUnreadAnnouncements]);

  /**
   * 导航项标题映射到翻译键
   */
  const getNavTitle = (title: string): string => {
    const titleMap: Record<string, string> = {
      Create: t("nav.create"),
      Dashboard: t("nav.dashboard"),
      Gallery: t("nav.gallery"),
      History: t("nav.history"),
      "System Docs": t("nav.backendHelp"),
      "External API": t("nav.externalApi"),
      "Billing & Usage": t("nav.billing"),
      "Subscription Plans": t("nav.subscriptionPlans"),
      Announcements: t("nav.announcements"),
      Settings: t("nav.settings"),
      "System Settings": t("nav.systemSettings"),
      "Global Status": t("nav.globalStatus"),
      "Announcement Management": t("nav.announcementManagement"),
      "Image Backend Pool": t("nav.imageBackendPool"),
      Support: t("nav.support"),
      "New Ticket": t("nav.newTicket"),
      "User Management": t("nav.userManagement"),
    };
    return titleMap[title] || title;
  };

  /**
   * 获取用户名首字母作为头像回退
   */
  const getInitials = (name: string) => {
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  };

  /**
   * 处理登出
   */
  const handleSignOut = async () => {
    setOpen(false);
    await signOut({
      fetchOptions: {
        onSuccess: () => {
          router.push("/");
        },
      },
    });
  };

  /**
   * 处理设置点击
   */
  const handleSettingsClick = () => {
    setOpen(false);
    router.push(`/${locale}/dashboard/settings`);
  };

  const localizedHref = (href: string) =>
    href.startsWith("/") ? `/${locale}${href}` : href;

  const handleNavigationClick = (
    event: MouseEvent<HTMLAnchorElement>,
    href: string,
    mobile: boolean
  ) => {
    if (mobile) setMobileOpen(false);
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }

    const target = localizedHref(href);
    if (target === pathname) return;

    const previousTarget = navigationIntentRef.current;
    navigationIntentRef.current = target;
    if (
      pendingNavigationTokensRef.current.size > 0 ||
      (previousTarget && previousTarget !== target)
    ) {
      // App Router cannot cancel an in-flight RSC navigation. Stop it at the
      // browser level so the newly clicked destination takes over immediately.
      event.preventDefault();
      window.stop();
      window.location.assign(target);
    }
  };

  /**
   * 渲染侧边栏内容（桌面和移动端共用）
   * mobile 参数控制是否为移动端模式（始终展开，点击关闭）
   */
  const renderSidebarContent = (mobile: boolean) => {
    const collapsed = mobile ? false : isCollapsed;

    return (
      <>
        {/* 品牌区:px-5 与导航图标列(nav p-3 + item px-2.5)近似对齐,
            折叠态(w-16)下图标中心恰落在 20 + 12 = 32px,即侧栏水平中点 */}
        <div className="flex h-14 items-center px-5">
          <Link
            href={`/${locale}`}
            prefetch={false}
            className="flex items-center gap-2.5"
            onClick={(e) => {
              if (mobile) {
                setMobileOpen(false);
              } else if (collapsed) {
                e.preventDefault();
                toggleSidebar();
              }
            }}
          >
            <Image
              src="/assets/icon.png"
              alt="GPT2IMAGE"
              width={24}
              height={24}
              className="shrink-0"
            />
            <span
              className={cn(
                "font-serif text-lg font-medium tracking-tight transition-opacity duration-150",
                collapsed && "opacity-0"
              )}
            >
              GPT2IMAGE
            </span>
          </Link>
        </div>

        {/* 导航菜单 */}
        <nav className="flex-1 space-y-4 overflow-y-auto p-3">
          {dashboardConfig.sidebarNav.map((group) => (
            <div key={group.title}>
              {/* Group Label - 折叠时隐藏 */}
              {!collapsed && (
                <p className="mb-2 px-2.5 text-[11px] font-medium uppercase tracking-widest text-muted-foreground/70">
                  {getNavTitle(group.title)}
                </p>
              )}
              <div className="space-y-0.5">
                {[
                  ...group.items,
                  ...(isAdmin
                    ? [
                        {
                          title: "Global Status",
                          href: "/dashboard/admin/status",
                          icon: Activity,
                        },
                        {
                          title: "User Management",
                          href: "/dashboard/admin/users",
                          icon: Users,
                        },
                        {
                          title: "Announcement Management",
                          href: "/dashboard/admin/announcements",
                          icon: Megaphone,
                        },
                        {
                          title: "System Settings",
                          href: "/dashboard/admin/settings",
                          icon: Shield,
                        },
                      ]
                    : isObserverAdmin
                      ? [
                          {
                            title: "Global Status",
                            href: "/dashboard/admin/status",
                            icon: Activity,
                          },
                          {
                            title: "Image Backend Pool",
                            href: "/dashboard/admin/settings",
                            icon: Server,
                          },
                        ]
                      : []),
                ].map((item) => {
                  // 去掉 locale 前缀后比较路径
                  const normalizedPath = pathname.replace(/^\/[a-z]{2}\//, "/");
                  const isActive =
                    normalizedPath === item.href ||
                    (item.href !== "/dashboard" &&
                      normalizedPath.startsWith(`${item.href}/`));
                  const Icon = item.icon;
                  const translatedTitle = getNavTitle(item.title);
                  const showSupportUnread =
                    item.href === "/dashboard/support" &&
                    unreadTicketCount > 0;
                  const unreadCount =
                    item.href === "/dashboard/announcements"
                      ? unreadAnnouncementCount
                      : showSupportUnread
                        ? unreadTicketCount
                        : 0;
                  const showUnread = unreadCount > 0;
                  return (
                    <Link
                      key={item.href}
                      href={localizedHref(item.href)}
                      prefetch={false}
                      title={collapsed ? translatedTitle : undefined}
                      onClick={(event) =>
                        handleNavigationClick(event, item.href, mobile)
                      }
                      className={cn(
                        // 激活/hover 均取 sidebar 专属 token:侧栏底色与 secondary/muted
                        // 同值,通用灰阶在此不可见,sidebar-accent 才能在明暗两态浮出
                        "relative flex items-center gap-3 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors duration-150",
                        isActive
                          ? "bg-sidebar-accent text-sidebar-accent-foreground"
                          : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
                        collapsed && "justify-center px-0"
                      )}
                    >
                      <SidebarNavigationStatus
                        onPendingChange={handleNavigationPendingChange}
                      />
                      {/* 激活指示竖线:淡入 + 纵向展开;非激活时保留元素,靠 opacity/scale 过渡 */}
                      <span
                        aria-hidden="true"
                        className={cn(
                          "absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-foreground transition-[opacity,scale] duration-150",
                          isActive
                            ? "scale-y-100 opacity-100"
                            : "scale-y-50 opacity-0"
                        )}
                      />
                      {Icon && (
                        <span className="relative inline-flex shrink-0">
                          <Icon className="h-4 w-4" />
                          {showUnread && (
                            <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-destructive ring-2 ring-sidebar" />
                          )}
                        </span>
                      )}
                      {!collapsed && (
                        <>
                          <span className="flex-1">{translatedTitle}</span>
                          {showUnread && (
                            <span className="min-w-5 rounded-full bg-destructive px-1.5 py-0.5 text-center text-[10px] font-medium leading-none text-white">
                              {unreadCount > 99 ? "99+" : unreadCount}
                            </span>
                          )}
                        </>
                      )}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* 用户信息区域 */}
        <div
          className="border-t border-sidebar-border p-3"
          key={user?.id || "session-loading"}
        >
          {user ? (
            <Popover key={user.id} open={open} onOpenChange={setOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    // 卡片化用户区:细边框 + 轻底色,hover 同步提亮边框与底色;
                    // 折叠态空间不足,退化为无边框纯图标
                    "flex w-full items-center gap-3 rounded-md border border-sidebar-border/60 bg-sidebar-accent/20 px-2.5 py-2 transition-colors duration-150 hover:border-sidebar-border hover:bg-sidebar-accent/50",
                    collapsed &&
                      "justify-center border-transparent bg-transparent px-0 hover:border-transparent"
                  )}
                >
                  <Avatar className="h-8 w-8 shrink-0">
                    <AvatarImage
                      key={user.image || user.id}
                      src={user.image || undefined}
                      alt={user.name}
                    />
                    <AvatarFallback className="bg-foreground text-background text-xs">
                      {getInitials(user.name)}
                    </AvatarFallback>
                  </Avatar>
                  {!collapsed && (
                    <>
                      <div className="min-w-0 flex-1 text-left">
                        {/* 名字可截断,积分徽章 shrink-0 防止长用户名将其挤出可视区 */}
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-medium">
                            {user.name}
                          </p>
                          <span className="shrink-0">
                            <CreditBalanceBadge key={user.id} />
                          </span>
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          {user.email}
                        </p>
                      </div>
                      <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                    </>
                  )}
                </button>
              </PopoverTrigger>

              <PopoverContent
                side="top"
                align="start"
                sideOffset={8}
                className="w-64 p-0"
              >
                {/* 用户信息头部 */}
                <div className="flex items-center gap-3 p-4">
                  <Avatar className="h-10 w-10">
                    <AvatarImage
                      key={user.image || user.id}
                      src={user.image || undefined}
                      alt={user.name}
                    />
                    <AvatarFallback className="bg-foreground text-background">
                      {getInitials(user.name)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate font-medium">{user.name}</p>
                      <span className="shrink-0">
                        <PlanBadge plan={userPlan} size="xs" />
                      </span>
                    </div>
                    <p className="truncate text-sm text-muted-foreground">
                      {user.email}
                    </p>
                  </div>
                </div>

                <Separator />

                {/* 主题切换 - 使用共享 ModeToggle 组件 */}
                <div className="flex items-center justify-center p-3">
                  <ModeToggle variant="inline" />
                </div>

                <Separator />

                {/* 菜单项 */}
                <div className="p-2">
                  {/* 设置 */}
                  <button
                    type="button"
                    onClick={handleSettingsClick}
                    className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-muted transition-colors duration-150"
                  >
                    <Settings className="h-4 w-4" />
                    {t("sidebar.settings")}
                  </button>

                  {/* 登出 */}
                  <button
                    type="button"
                    onClick={handleSignOut}
                    className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-muted transition-colors duration-150"
                  >
                    <LogOut className="h-4 w-4" />
                    {t("sidebar.logout")}
                  </button>
                </div>
              </PopoverContent>
            </Popover>
          ) : (
            // 加载状态
            <div
              className={cn(
                "flex items-center gap-3 rounded-md border border-sidebar-border/60 px-2.5 py-2",
                collapsed && "justify-center border-transparent px-0"
              )}
            >
              <div className="h-8 w-8 animate-pulse rounded-full bg-sidebar-accent shrink-0" />
              {!collapsed && (
                <div className="flex-1 space-y-1">
                  <div className="h-4 w-20 animate-pulse rounded bg-sidebar-accent" />
                  <div className="h-3 w-32 animate-pulse rounded bg-sidebar-accent" />
                </div>
              )}
            </div>
          )}
        </div>
      </>
    );
  };

  return (
    <>
      {/* 桌面端侧边栏 */}
      <aside
        className={cn(
          // 仅过渡宽度,避免 transition-all 连带过渡颜色等无关属性
          "fixed left-0 top-0 z-40 hidden h-screen flex-col bg-sidebar border-r border-sidebar-border transition-[width] duration-300 md:flex",
          isCollapsed ? "w-16" : "w-64"
        )}
      >
        {renderSidebarContent(false)}
      </aside>

      {/* 移动端 Sheet 侧边栏 */}
      <Sheet open={isMobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent
          side="left"
          className="w-64 bg-sidebar p-0 md:hidden [&>button:last-child]:hidden"
        >
          <SheetTitle className="sr-only">{t("nav.dashboard")}</SheetTitle>
          <div className="flex h-full flex-col">
            {renderSidebarContent(true)}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
