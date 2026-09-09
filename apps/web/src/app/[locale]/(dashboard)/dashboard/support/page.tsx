import { desc, eq, sql } from "drizzle-orm";
import { Plus, Ticket } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@repo/ui/components/card";
import { db } from "@repo/database";
import { ticket, user } from "@repo/database/schema";
import { getUserRoleById } from "@repo/shared/auth/role-server";
import { isAdminRole } from "@repo/shared/auth/roles";
import { getServerSession } from "@repo/shared/auth/server";
import { formatDateInTimeZone } from "@repo/shared/time-zone";
import { getAppTimeZone } from "@repo/shared/time-zone/server";

const userUnreadTicketSql =
  sql<boolean>`${ticket.lastAdminActivityAt} > ${ticket.userLastSeenAt}`.mapWith(
    Boolean
  );
const adminUnreadTicketSql =
  sql<boolean>`${ticket.lastUserActivityAt} is not null and (${ticket.adminLastSeenAt} is null or ${ticket.lastUserActivityAt} > ${ticket.adminLastSeenAt})`.mapWith(
    Boolean
  );

/**
 * 用户工单列表页面
 *
 * 展示用户提交的所有支持工单
 */
export default async function SupportPage() {
  // 获取当前用户会话
  const session = await getServerSession();
  const locale = await getLocale();
  if (!session?.user) {
    redirect(`/${locale}/sign-in`);
  }

  const [t, role, timeZone] = await Promise.all([
    getTranslations("Support"),
    getUserRoleById(session.user.id),
    getAppTimeZone(),
  ]);
  const isAdmin = isAdminRole(role);
  const unreadSql = isAdmin ? adminUnreadTicketSql : userUnreadTicketSql;

  const tickets = isAdmin
    ? await db
        .select({
          id: ticket.id,
          userId: ticket.userId,
          subject: ticket.subject,
          category: ticket.category,
          priority: ticket.priority,
          status: ticket.status,
          createdAt: ticket.createdAt,
          updatedAt: ticket.updatedAt,
          user: {
            name: user.name,
            email: user.email,
          },
          unread: unreadSql,
        })
        .from(ticket)
        .leftJoin(user, eq(ticket.userId, user.id))
        .orderBy(desc(ticket.createdAt))
    : await db
        .select({
          id: ticket.id,
          userId: ticket.userId,
          subject: ticket.subject,
          category: ticket.category,
          priority: ticket.priority,
          status: ticket.status,
          createdAt: ticket.createdAt,
          updatedAt: ticket.updatedAt,
          user: {
            name: user.name,
            email: user.email,
          },
          unread: unreadSql,
        })
        .from(ticket)
        .leftJoin(user, eq(ticket.userId, user.id))
        .where(eq(ticket.userId, session.user.id))
        .orderBy(desc(ticket.createdAt));

  /**
   * 获取状态徽章样式：单色 outline + uppercase 小字，进行中以实心前景色强调
   */
  const getStatusBadge = (status: string) => {
    const classMap: Record<string, string> = {
      open: "border-foreground/40 text-foreground",
      in_progress: "border-transparent bg-foreground text-background",
      resolved: "text-muted-foreground",
      closed: "text-muted-foreground/70",
    };
    return (
      <Badge
        variant="outline"
        className={`text-[10px] uppercase tracking-wider ${classMap[status] || classMap.closed}`}
      >
        {t(`statuses.${status}` as Parameters<typeof t>[0])}
      </Badge>
    );
  };

  /**
   * 获取优先级徽章样式：单色为主，高优先级用 destructive 语义色
   */
  const getPriorityBadge = (priority: string) => {
    const classMap: Record<string, string> = {
      low: "text-muted-foreground/70",
      medium: "text-muted-foreground",
      high: "border-destructive/40 text-destructive",
    };
    return (
      <Badge
        variant="outline"
        className={`text-[10px] uppercase tracking-wider ${classMap[priority] || classMap.medium}`}
      >
        {t(`priorities.${priority}` as Parameters<typeof t>[0])}
      </Badge>
    );
  };

  /**
   * 获取类别标签
   */
  const getCategoryLabel = (category: string) => {
    return t(`categories.${category}` as Parameters<typeof t>[0]);
  };

  return (
    <div className="space-y-6">
      {/* 页面标题 */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-serif text-2xl font-medium tracking-tight">
            {t("title")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {isAdmin ? t("adminSubtitle") : t("subtitle")}
          </p>
        </div>
        <Link href={`/${locale}/dashboard/support/new`}>
          <Button>
            <Plus className="mr-2 h-4 w-4" />
            {t("newTicket")}
          </Button>
        </Link>
      </div>

      {/* 工单列表 */}
      {tickets.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Ticket className="mb-4 h-12 w-12 text-muted-foreground/50" />
            <h3 className="font-serif text-lg font-medium">{t("noTickets")}</h3>
            <p className="text-muted-foreground mb-4">
              {t("noTicketsDescription")}
            </p>
            <Link href={`/${locale}/dashboard/support/new`}>
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                {t("createFirst")}
              </Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {tickets.map((tkt, index) => (
            <Link
              key={tkt.id}
              href={`/${locale}/dashboard/support/${tkt.id}`}
              className="block"
            >
              {/*
                工单行入场错峰：按索引 50ms 递增（12 个一轮回），fill-mode 用
                backwards 保证延迟期间停留在动画首帧（透明）；入场时长走内联
                属性（400ms），不影响 hover 抬升过渡的 duration-250。
              */}
              <Card
                className="cursor-pointer animate-in fade-in slide-in-from-bottom-2 lift-hover motion-reduce:animate-none motion-reduce:transition-none"
                style={{
                  animationDelay: `${(index % 12) * 50}ms`,
                  animationDuration: "400ms",
                  animationFillMode: "backwards",
                }}
              >
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between">
                    <div className="space-y-1">
                      <CardTitle className="flex items-center gap-2 font-serif text-base font-medium">
                        {tkt.unread && (
                          <span className="h-2 w-2 rounded-full bg-destructive" />
                        )}
                        <span>{tkt.subject}</span>
                        {tkt.unread && (
                          <Badge
                            variant="destructive"
                            className="text-[10px] uppercase tracking-wider"
                          >
                            新动态
                          </Badge>
                        )}
                      </CardTitle>
                      <p className="text-sm text-muted-foreground">
                        {getCategoryLabel(tkt.category)} ·{" "}
                        {formatDateInTimeZone(
                          tkt.createdAt,
                          locale,
                          {
                            year: "numeric",
                            month: "2-digit",
                            day: "2-digit",
                          },
                          timeZone
                        )}
                        {isAdmin && tkt.user?.email
                          ? ` · ${tkt.user.name || t("unknownUser")} (${tkt.user.email})`
                          : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {getPriorityBadge(tkt.priority)}
                      {getStatusBadge(tkt.status)}
                    </div>
                  </div>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
