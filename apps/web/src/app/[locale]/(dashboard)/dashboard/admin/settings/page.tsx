import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";

import { getUserRoleById } from "@repo/shared/auth/role-server";
import {
  canAccessAdminArea,
  canManageUserPermissions,
  canViewImageBackendPool,
} from "@repo/shared/auth/roles";
import { getServerSession } from "@repo/shared/auth/server";
import { getAdminSystemSettingsSnapshot } from "@repo/shared/system-settings";
import { SystemSettingsPanel } from "@repo/shared/system-settings/components";
import { getAppTimeZone } from "@repo/shared/time-zone/server";
import { ImageBackendPoolAdminPanel } from "@/features/image-backend-pool";
import { AdminSettingsTabs } from "./admin-settings-tabs";

export default async function DashboardAdminSettingsPage() {
  const session = await getServerSession();
  const locale = await getLocale();
  if (!session?.user) {
    redirect(`/${locale}/sign-in`);
  }

  const role = await getUserRoleById(session.user.id);
  if (!canViewImageBackendPool(role)) {
    redirect(`/${locale}/dashboard`);
  }

  if (!canAccessAdminArea(role)) {
    const timeZone = await getAppTimeZone();
    return <ImageBackendPoolAdminPanel readOnly timeZone={timeZone} />;
  }

  // 系统设置面板可写入 BETTER_AUTH_SECRET 等密钥，必须限制为超管，
  // 否则普通 admin 可改写认证密钥伪造会话实现账号接管（见审计 S-C1）。
  const canManageSystemSettings = canManageUserPermissions(role);
  // 超管首屏直接带上配置快照(与 getSystemSettingsAction 同一函数、同一超管守卫,
  // 密钥不回显),省掉客户端挂载后再发 action 的一次串行往返。非超管不取。
  const [timeZone, systemSettings] = await Promise.all([
    getAppTimeZone(),
    canManageSystemSettings ? getAdminSystemSettingsSnapshot() : null,
  ]);

  // 面板元素按角色在服务端构造:只有被构造的面板会进入 RSC 负载,其 chunk 与导航
  // 同一波下载;未构造的面板代码不会下发(超管的后端池面板由 tab 外壳按需懒加载)。
  return (
    <AdminSettingsTabs
      timeZone={timeZone}
      canManageSystemSettings={canManageSystemSettings}
      systemPanel={
        systemSettings ? (
          <SystemSettingsPanel initialSettings={systemSettings} />
        ) : null
      }
      poolPanel={
        canManageSystemSettings ? null : (
          <ImageBackendPoolAdminPanel timeZone={timeZone} />
        )
      }
    />
  );
}
