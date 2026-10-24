"use client";

/** Dashboard 导航与账号菜单；会话变更及成功登出时撤销旧账号聊天写入资格。 */

import { getMyUnreadAnnouncementCountAction } from "@repo/shared/announcements/actions";
import { signOut } from "@repo/shared/auth/client";
import { isAdminRole, isObserverAdminRole } from "@repo/shared/auth/roles";
import { ModeToggle } from "@repo/shared/components";
import { dashboardConfig } from "@repo/shared/config";
import { CreditBalanceBadge } from "@repo/shared/credits/components";
import { getMyPlanAction } from "@repo/shared/subscription/actions/get-user-plan";
import {
  PlanBadge,
  type PlanType,
} from "@repo/shared/subscription/components/plan-badge";
import { getMyUnreadTicketCountAction } from "@repo/shared/support/actions/ticket";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/ui/components/avatar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/ui/components/popover";
import { Separator } from "@repo/ui/components/separator";
import { Sheet, SheetContent, SheetTitle } from "@repo/ui/components/sheet";
import { cn } from "@repo/ui/utils";
import {
  Activity,
  ChevronsUpDown,
  LogOut,
  Megaphone,
  Server,
  Settings,
  Shield,
  Users,
} from "lucide-react";
import Image from "next/image";
import Link, { useLinkStatus } from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  type CurrentSession,
  useCurrentSession,
} from "@/features/auth/hooks/use-current-session";
import { SidebarNavigationLink } from "@/features/dashboard/components/sidebar-navigation-link";
import { SIDEBAR_UNREAD_CHANGED_EVENT } from "@/features/dashboard/components/sidebar-unread-sync";
import { useSidebar } from "@/features/dashboard/context";
import { revokeChatStorageScope } from "@/features/image-generation/components/chat-persistence";
import { useCreateRuntimeState } from "@/features/image-generation/create-runtime-store";

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
export type SidebarPrefetch = {
  /** 积分余额(SSR 直出,徽章零等待)。 */
  balance: number;
  /** 套餐标识(PlanBadge 直出)。 */
  plan: PlanType;
  /** 未读工单数(初始值,仍支持 action 刷新)。 */
  unreadTickets: number;
  /** 未读公告数(初始值,仍支持 action 刷新)。 */
  unreadAnnouncements: number;
};

type DashboardSidebarProps = {
  initialSession?: CurrentSession;
  /** 服务端预取的侧边栏数据;缺省时回退客户端 action(兼容旧调用方)。 */
  prefetch?: SidebarPrefetch | null;
};

/**
 * 侧栏链接的"导航中"指示:点击后立即在该项显示脉动竖线,直到新页面提交。
 *
 * 必须渲染在 <Link> 内部(useLinkStatus 读取的是所在 Link 发起的导航)。预取命中时
 * 导航几乎瞬时提交,指示一闪而过;未命中(慢网络、预取未完成)时它让用户确认点击已
 * 生效,避免"没反应再点一次"。
 */
function SidebarLinkPendingIndicator() {
  const { pending } = useLinkStatus();
  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-foreground transition-opacity duration-150",
        pending
          ? "animate-pulse opacity-100 motion-reduce:animate-none"
          : "opacity-0"
      )}
    />
  );
}

/** 切页后延迟多久刷新未读角标(让出页面自身的请求)。 */
const UNREAD_REFRESH_DELAY_MS = 3000;
/** 切页触发的角标刷新最短间隔(读页面的事件刷新不受此限)。 */
const UNREAD_REFRESH_MIN_INTERVAL_MS = 60_000;

export function DashboardSidebar({
  initialSession,
  prefetch,
}: DashboardSidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const locale = useLocale();
  const { isCollapsed, isMobileOpen, setMobileOpen, toggleSidebar } =
    useSidebar();
  const t = useTranslations("Dashboard");

  // 获取当前用户会话
  const { data: session, isPending: isSessionPending } =
    useCurrentSession(initialSession);
  const user = session?.user;
  const [, setChatAccountUserId] = useCreateRuntimeState<
    string | null | undefined
  >("chatAccountUserId", undefined);
  const previousChatUserIdRef = useRef(user?.id);
  const signedOutChatUserIdRef = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (!user && isSessionPending) return;
    // 成功登出后的旧会话响应不能重新开放同一账号，等待新身份或布局重新挂载。
    if (user?.id && user.id === signedOutChatUserIdRef.current) return;
    if (user?.id) signedOutChatUserIdRef.current = undefined;
    if (previousChatUserIdRef.current !== user?.id) {
      revokeChatStorageScope(previousChatUserIdRef.current);
      previousChatUserIdRef.current = user?.id;
    }
    setChatAccountUserId(user?.id ?? null);
  }, [user, isSessionPending, setChatAccountUserId]);
  const isAdmin = isAdminRole(user?.role);
  const isObserverAdmin = isObserverAdminRole(user?.role);

  // Popover 开关状态
  const [open, setOpen] = useState(false);

  // 获取用户订阅计划:预取值直出,action 仅在无预取时兜底
  const { execute: fetchPlan, result: planResult } = useAction(getMyPlanAction);
  const userPlan =
    prefetch?.plan ?? ((planResult.data?.plan as PlanType) || "free");
  const { execute: fetchUnreadTickets, result: unreadTicketsResult } =
    useAction(getMyUnreadTicketCountAction);
  const {
    execute: fetchUnreadAnnouncements,
    result: unreadAnnouncementsResult,
  } = useAction(getMyUnreadAnnouncementCountAction);
  const unreadTicketCount = Math.max(
    0,
    Number(unreadTicketsResult.data?.count ?? prefetch?.unreadTickets ?? 0)
  );
  const unreadAnnouncementCount = Math.max(
    0,
    Number(
      unreadAnnouncementsResult.data?.count ??
        prefetch?.unreadAnnouncements ??
        0
    )
  );

  // 用户登录后获取计划(有预取值时跳过:省一次 action RTT)
  useEffect(() => {
    if (user && !prefetch?.plan) {
      fetchPlan();
    }
  }, [user, prefetch?.plan, fetchPlan]);

  // 未读角标刷新。侧栏在共享布局里,软导航不重渲染,首屏值来自服务端预取:
  // - 首次挂载:有预取则直接用,不发请求(无预取的旧调用方立即拉取);
  // - 之后切页:延迟刷新以捕捉新回复 / 新公告,且至多每分钟一次。WHY 延迟与限频:
  //   刷新是两次 server action,在高延迟链路上会与紧接着的切页请求争抢带宽;
  //   读取即已读的页面另有事件立即刷新(见下),这里只需兜底新消息。
  // 无预取时 lastUnreadRefreshAtRef 为 0,首次立即拉取。
  const lastUnreadRefreshAtRef = useRef(prefetch ? Date.now() : 0);
  useEffect(() => {
    if (!user) return;
    const sinceLast = Date.now() - lastUnreadRefreshAtRef.current;
    if (sinceLast < UNREAD_REFRESH_MIN_INTERVAL_MS) return;
    const timer = window.setTimeout(
      () => {
        lastUnreadRefreshAtRef.current = Date.now();
        fetchUnreadTickets();
        fetchUnreadAnnouncements();
      },
      prefetch ? UNREAD_REFRESH_DELAY_MS : 0
    );
    return () => window.clearTimeout(timer);
  }, [user, pathname, prefetch, fetchUnreadTickets, fetchUnreadAnnouncements]);

  // "打开即已读"的页面(公告、工单详情)挂载后派发事件,立即刷新角标(见 SidebarUnreadSync)。
  useEffect(() => {
    if (!user) return;
    const refresh = () => {
      lastUnreadRefreshAtRef.current = Date.now();
      fetchUnreadTickets();
      fetchUnreadAnnouncements();
    };
    window.addEventListener(SIDEBAR_UNREAD_CHANGED_EVENT, refresh);
    return () =>
      window.removeEventListener(SIDEBAR_UNREAD_CHANGED_EVENT, refresh);
  }, [user, fetchUnreadTickets, fetchUnreadAnnouncements]);

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
          signedOutChatUserIdRef.current = user?.id;
          revokeChatStorageScope(user?.id);
          setChatAccountUserId(null);
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

  // 导航完全交给 <Link> 软导航。WHY 不拦截:Next 16 的路由动作队列里,新导航会
  // 把进行中的导航标记为丢弃并立即开始(app-router-instance dispatchAction),无需
  // 浏览器层面打断。旧实现在导航挂起时 window.stop() + location.assign() 整页跳转:
  // stop 会掐断进行中的 RSC 请求,而 Next 对失败的导航兜底整页跳回其原目标,于是
  // "没反应再点另一个 tab"会整页重载并停在上一个 tab(限速实测 60s 未到达新 tab)。
  const handleNavigationClick = (mobile: boolean) => {
    if (mobile) setMobileOpen(false);
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
                    item.href === "/dashboard/support" && unreadTicketCount > 0;
                  const unreadCount =
                    item.href === "/dashboard/announcements"
                      ? unreadAnnouncementCount
                      : showSupportUnread
                        ? unreadTicketCount
                        : 0;
                  const showUnread = unreadCount > 0;
                  // 保留 Next 默认 AUTO 与 loading 边界；薄包装在真实导航时提前加载
                  // 页面客户端模块，保留骨架反馈和原有数据读取流程。
                  return (
                    <SidebarNavigationLink
                      key={item.href}
                      href={localizedHref(item.href)}
                      title={collapsed ? translatedTitle : undefined}
                      onClick={() => handleNavigationClick(mobile)}
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
                      {!isActive && <SidebarLinkPendingIndicator />}
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
                    </SidebarNavigationLink>
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
                            <CreditBalanceBadge
                              key={user.id}
                              initialBalance={prefetch?.balance}
                            />
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
