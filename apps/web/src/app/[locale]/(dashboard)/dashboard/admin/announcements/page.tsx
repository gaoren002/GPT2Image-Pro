import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";

import { listAnnouncementsForAdmin } from "@repo/shared/announcements/service";
import { getUserRoleById } from "@repo/shared/auth/role-server";
import { canAccessAdminArea } from "@repo/shared/auth/roles";
import { getServerSession } from "@repo/shared/auth/server";
import { getAppTimeZone } from "@repo/shared/time-zone/server";
import { AdminAnnouncementsManagement } from "@/features/announcements/admin-announcements-management";

export default async function DashboardAdminAnnouncementsPage() {
  const [session, locale] = await Promise.all([getServerSession(), getLocale()]);
  if (!session?.user) {
    redirect(`/${locale}/sign-in`);
  }

  const role = await getUserRoleById(session.user.id);
  if (!canAccessAdminArea(role)) {
    redirect(`/${locale}/dashboard`);
  }

  const [announcements, timeZone] = await Promise.all([
    listAnnouncementsForAdmin(),
    getAppTimeZone(),
  ]);

  return (
    <AdminAnnouncementsManagement
      initialAnnouncements={announcements.map((item) => ({
        id: item.id,
        title: item.title,
        content: item.content,
        severity: item.severity,
        isPublished: item.isPublished,
        isPinned: item.isPinned,
        priority: item.priority,
        publishedAt: item.publishedAt?.toISOString() ?? null,
        expiresAt: item.expiresAt?.toISOString() ?? null,
        createdByUserId: item.createdByUserId,
        updatedByUserId: item.updatedByUserId,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      }))}
      timeZone={timeZone}
    />
  );
}
