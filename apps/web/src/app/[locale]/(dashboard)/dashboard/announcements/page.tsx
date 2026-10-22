import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { CheckCircle2, Megaphone, Pin } from "lucide-react";

import {
  listActiveAnnouncementsForUser,
  markAnnouncementIdsReadForUser,
} from "@repo/shared/announcements";
import { getServerSession } from "@repo/shared/auth/server";
import { formatDateInTimeZone } from "@repo/shared/time-zone";
import { getAppTimeZone } from "@repo/shared/time-zone/server";
import { Badge } from "@repo/ui/components/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { cn } from "@repo/ui/utils";

import { SidebarUnreadSync } from "@/features/dashboard/components/sidebar-unread-sync";

/**
 * 公告级别视觉映射：单色为主，仅 success/warning/critical 用语义色 token
 * （--color-success/--color-warning 已入 @theme，直接用标准工具类）。
 */
function getSeverityMeta(severity: string) {
  switch (severity) {
    case "success":
      return {
        label: "更新",
        badgeClassName: "border-success/40 text-success",
        borderClassName: "border-l-success",
      };
    case "warning":
      return {
        label: "重要",
        badgeClassName: "border-warning/40 text-warning",
        borderClassName: "border-l-warning",
      };
    case "critical":
      return {
        label: "紧急",
        badgeClassName: "border-destructive/40 text-destructive",
        borderClassName: "border-l-destructive",
      };
    default:
      return {
        label: "公告",
        badgeClassName: "text-muted-foreground",
        borderClassName: "border-l-foreground/30",
      };
  }
}

function formatDateTime(
  value: Date | string | null | undefined,
  locale: string,
  timeZone: string
) {
  return formatDateInTimeZone(
    value,
    locale,
    {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    },
    timeZone
  );
}

export default async function DashboardAnnouncementsPage() {
  const [session, locale, timeZone] = await Promise.all([
    getServerSession(),
    getLocale(),
    getAppTimeZone(),
  ]);

  if (!session?.user) {
    redirect(`/${locale}/sign-in`);
  }

  const announcements = await listActiveAnnouncementsForUser(session.user.id);
  const unreadIds = announcements
    .filter((item) => !item.readAt || item.readAt < item.updatedAt)
    .map((item) => item.id);

  if (unreadIds.length > 0) {
    await markAnnouncementIdsReadForUser(session.user.id, unreadIds);
  }

  const isZh = locale === "zh";
  const copy = (en: string, zh: string) => (isZh ? zh : en);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      {/* 上面已把可见公告标记为已读:挂载后通知侧栏刷新未读角标 */}
      <SidebarUnreadSync />
      <div>
        <h2 className="font-serif text-2xl font-medium tracking-tight">
          {copy("Announcements", "公告")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {copy(
            "System updates, maintenance notices, and platform messages.",
            "系统更新、维护通知和平台消息会集中展示在这里。"
          )}
        </p>
      </div>

      {announcements.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <Megaphone className="h-10 w-10 text-muted-foreground" />
            <div>
              <p className="font-serif font-medium">
                {copy("No active announcements", "暂无生效公告")}
              </p>
              <p className="text-sm text-muted-foreground">
                {copy(
                  "New notices will appear here when published.",
                  "有新公告发布后会显示在这里。"
                )}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {announcements.map((item, index) => {
            const meta = getSeverityMeta(item.severity);
            const wasUnread = unreadIds.includes(item.id);

            return (
              // 公告卡入场错峰：按索引 50ms 递增（12 个一轮回），fill-mode 用
              // backwards 保证延迟期间停留在动画首帧（透明），避免闪现跳变。
              <Card
                key={item.id}
                className={cn(
                  "border-l-4 animate-in fade-in slide-in-from-bottom-2 duration-400 motion-reduce:animate-none",
                  meta.borderClassName,
                  wasUnread && "bg-muted/30"
                )}
                style={{
                  animationDelay: `${(index % 12) * 50}ms`,
                  animationFillMode: "backwards",
                }}
              >
                <CardHeader className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[10px] uppercase tracking-wider",
                        meta.badgeClassName
                      )}
                    >
                      {meta.label}
                    </Badge>
                    {item.isPinned && (
                      <Badge
                        variant="outline"
                        className="text-[10px] uppercase tracking-wider text-muted-foreground"
                      >
                        <Pin className="mr-1 h-3 w-3" />
                        {copy("Pinned", "置顶")}
                      </Badge>
                    )}
                    {wasUnread ? (
                      <Badge
                        variant="default"
                        className="text-[10px] uppercase tracking-wider"
                      >
                        {copy("New", "未读")}
                      </Badge>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        {copy("Read", "已读")}
                      </span>
                    )}
                  </div>
                  <div>
                    <CardTitle className="font-serif text-xl font-medium leading-snug">
                      {item.title}
                    </CardTitle>
                    <p className="mt-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                      {copy("Published", "发布于")}{" "}
                      {formatDateTime(
                        item.publishedAt ?? item.createdAt,
                        locale,
                        timeZone
                      )}
                      {item.expiresAt
                        ? ` · ${copy("Expires", "过期于")} ${formatDateTime(
                            item.expiresAt,
                            locale,
                            timeZone
                          )}`
                        : ""}
                    </p>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                    {item.content}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
