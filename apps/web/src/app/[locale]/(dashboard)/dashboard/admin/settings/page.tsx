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
import { AdminSettingsTabs } from "./admin-settings-tabs";
import { LazyImageBackendPoolAdminPanel } from "./lazy-pool-panel";

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
    return <LazyImageBackendPoolAdminPanel readOnly timeZone={timeZone} />;
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

  // 系统设置面板元素只在超管分支构造;后端池面板由 tab 外壳经 lazy-pool-panel
  // 按需加载(不进本页首屏入口,见该文件说明)。
  return (
    <AdminSettingsTabs
      timeZone={timeZone}
      canManageSystemSettings={canManageSystemSettings}
      systemPanel={
        systemSettings ? (
          <SystemSettingsPanel initialSettings={systemSettings} />
        ) : null
      }
    />
  );
}
