// 直接从各模块导入(不经 barrel index.ts):barrel re-export 多个卡片组件,经它导入会把
// 这些组件及其依赖一并拖进每页必载的公共 bundle(tree-shaking 被 barrel 破坏)。

import { countUnreadAnnouncementsForUser } from "@repo/shared/announcements/service";
import { getUserRoleById } from "@repo/shared/auth/role-server";
import { getServerSession } from "@repo/shared/auth/server";
import { getSidebarCreditsBalance } from "@repo/shared/credits/core";
import { getUserPlan } from "@repo/shared/subscription/services/user-plan";
import { countUnreadTicketsForUser } from "@repo/shared/support/services/ticket-unread";
import { DashboardMainWrapper } from "@/features/dashboard/components/main-wrapper";
import { DashboardSidebar } from "@/features/dashboard/components/sidebar";
import { SidebarProvider } from "@/features/dashboard/context";
import { CreateRuntimeProvider } from "@/features/image-generation/create-runtime-store";

/**
 * 服务端预取侧边栏数据:积分徽章/套餐/未读数此前由客户端挂载后发
 * 4 个 server action(串行等水合 + 各一轮 RTT),表现为每次进页面左下角
 * "加载一会"。layout 服务端取好后作 props 注入,SSR HTML 直出真实值;
 * 未读数保留 action 客户端刷新(工单回复/公告发布后仍会实时更新)。
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const serverSession = await getServerSession();
  const userId = serverSession?.user?.id;
  // 余额/套餐/未读数并行预取(与 getUserRoleById 互不依赖);
  // 未登录时全空,走登录页重定向,不阻塞。
  const [initialSession, sidebarPrefetch] = await Promise.all([
    userId
      ? getUserRoleById(userId).then((role) => ({
          user: {
            id: userId,
            name: serverSession.user.name || "",
            email: serverSession.user.email || "",
            image: serverSession.user.image,
            role,
          },
        }))
      : Promise.resolve(null),
    userId
      ? Promise.all([
          getSidebarCreditsBalance(userId).then((b) => b.balance),
          getUserPlan(userId).then((p) => p.plan),
          countUnreadTicketsForUser(userId).then((n) => Math.max(0, Number(n))),
          countUnreadAnnouncementsForUser(userId).then((n) =>
            Math.max(0, Number(n))
          ),
        ]).then(([balance, plan, unreadTickets, unreadAnnouncements]) => ({
          balance,
          plan,
          unreadTickets,
          unreadAnnouncements,
        }))
      : Promise.resolve(null),
  ]);

  return (
    <SidebarProvider>
      <CreateRuntimeProvider>
        <div className="min-h-screen bg-muted">
          <DashboardSidebar
            initialSession={initialSession}
            prefetch={sidebarPrefetch}
          />
          <DashboardMainWrapper>{children}</DashboardMainWrapper>
        </div>
      </CreateRuntimeProvider>
    </SidebarProvider>
  );
}
