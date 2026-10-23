import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";

import { getUserRoleById } from "@repo/shared/auth/role-server";
import {
  canAccessAdminArea,
  canManageUserPermissions,
} from "@repo/shared/auth/roles";
import { getServerSession } from "@repo/shared/auth/server";
import { AdminUsersManagement } from "@repo/shared/support/components/admin-users-management";
import { getAppTimeZone } from "@repo/shared/time-zone/server";
import { getAdminUsersListSnapshot } from "@repo/shared/support/services/admin-users-list";

/** 用户管理首屏：完成会话和角色校验后，并行预取默认列表与时区。 */
export default async function DashboardAdminUsersPage() {
  const session = await getServerSession();
  const locale = await getLocale();
  if (!session?.user || (session.user as { banned?: boolean | null }).banned) {
    redirect(`/${locale}/sign-in`);
  }

  const role = await getUserRoleById(session.user.id);
  if (!canAccessAdminArea(role)) {
    redirect(`/${locale}/dashboard`);
  }

  const [timeZone, initialData] = await Promise.all([
    getAppTimeZone(),
    getAdminUsersListSnapshot(undefined, role),
  ]);

  return (
    <AdminUsersManagement
      canManageRoles={canManageUserPermissions(role)}
      timeZone={timeZone}
      initialData={initialData}
    />
  );
}
