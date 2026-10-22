import { and, eq } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { Avatar, AvatarFallback, AvatarImage } from "@repo/ui/components/avatar";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@repo/ui/components/card";
import { db } from "@repo/database";
import {
  ticket,
  ticketAttachment,
  ticketMessage,
  user,
} from "@repo/database/schema";
import { AdminTicketReplyForm } from "@repo/shared/support/components/admin-ticket-reply-form";
import { AdminTicketStatusSelect } from "@repo/shared/support/components/admin-ticket-status-select";
import { TicketMessageForm } from "@repo/shared/support/components/ticket-message-form";
import {
  ticketCategories,
  ticketPriorities,
  ticketStatuses,
} from "@repo/shared/support/schemas";
import { getServerSession } from "@repo/shared/auth/server";
import { getUserRoleById } from "@repo/shared/auth/role-server";
import { isAdminRole } from "@repo/shared/auth/roles";
import { formatDateInTimeZone } from "@repo/shared/time-zone";
import { getAppTimeZone } from "@repo/shared/time-zone/server";
import { SidebarUnreadSync } from "@/features/dashboard/components/sidebar-unread-sync";

interface TicketDetailPageProps {
  params: Promise<{
    id: string;
  }>;
}

/**
 * 工单详情页面
 *
 * 展示工单信息和消息历史，允许用户回复
 */
export default async function TicketDetailPage({
  params,
}: TicketDetailPageProps) {
  const { id } = await params;

  // 获取当前用户会话
  const session = await getServerSession();
  const locale = await getLocale();
  if (!session?.user) {
    redirect(`/${locale}/sign-in`);
  }
  const [role, timeZone] = await Promise.all([
    getUserRoleById(session.user.id),
    getAppTimeZone(),
  ]);
  const isAdmin = isAdminRole(role);

  // 获取工单信息
  const ticketResult = isAdmin
    ? await db
        .select({
          ticket,
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            image: user.image,
          },
        })
        .from(ticket)
        .leftJoin(user, eq(ticket.userId, user.id))
        .where(eq(ticket.id, id))
        .limit(1)
    : await db
        .select({
          ticket,
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            image: user.image,
          },
        })
        .from(ticket)
        .leftJoin(user, eq(ticket.userId, user.id))
        .where(and(eq(ticket.id, id), eq(ticket.userId, session.user.id)))
        .limit(1);

  const ticketRecord = ticketResult[0];
  if (!ticketRecord) {
    notFound();
  }
  const ticketData = ticketRecord.ticket;
  const ticketUser = ticketRecord.user;

  if (!isAdmin) {
    const now = new Date();
    await db
      .update(ticket)
      .set({ userLastSeenAt: now })
      .where(and(eq(ticket.id, id), eq(ticket.userId, session.user.id)));
    ticketData.userLastSeenAt = now;
  } else {
    const now = new Date();
    await db
      .update(ticket)
      .set({ adminLastSeenAt: now })
      .where(eq(ticket.id, id));
    ticketData.adminLastSeenAt = now;
  }

  // 获取消息列表
  const [messages, attachments] = await Promise.all([
    db
      .select({
        id: ticketMessage.id,
        content: ticketMessage.content,
        isAdminResponse: ticketMessage.isAdminResponse,
        createdAt: ticketMessage.createdAt,
        user: {
          id: user.id,
          name: user.name,
          image: user.image,
        },
      })
      .from(ticketMessage)
      .leftJoin(user, eq(ticketMessage.userId, user.id))
      .where(eq(ticketMessage.ticketId, id))
      .orderBy(ticketMessage.createdAt),
    db
      .select({
        id: ticketAttachment.id,
        messageId: ticketAttachment.messageId,
        fileName: ticketAttachment.fileName,
      })
      .from(ticketAttachment)
      .where(eq(ticketAttachment.ticketId, id))
      .orderBy(ticketAttachment.createdAt),
  ]);
  const messagesWithAttachments = messages.map((message) => ({
    ...message,
    attachments: attachments.filter(
      (attachment) => attachment.messageId === message.id
    ),
  }));

  /**
   * 获取状态徽章样式：单色 outline + uppercase 小字，进行中以实心前景色强调
   */
  const getStatusBadge = (status: string) => {
    const statusConfig = ticketStatuses.find((s) => s.value === status);
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
        {statusConfig?.label || status}
      </Badge>
    );
  };

  /**
   * 获取优先级徽章样式：单色为主，高优先级用 destructive 语义色
   */
  const getPriorityBadge = (priority: string) => {
    const priorityConfig = ticketPriorities.find((p) => p.value === priority);
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
        {priorityConfig?.label || priority}
      </Badge>
    );
  };

  /**
   * 获取类别标签
   */
  const getCategoryLabel = (category: string) => {
    const categoryConfig = ticketCategories.find((c) => c.value === category);
    return categoryConfig?.label || category;
  };

  /**
   * 获取用户名首字母
   */
  const getInitials = (name: string) => {
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  };

  const isClosed = ticketData.status === "closed";

  return (
    <div className="space-y-6">
      {/* 上面已更新本工单的已读时间:挂载后通知侧栏刷新未读角标 */}
      <SidebarUnreadSync />
      {/* 页面标题 */}
      <div className="flex items-center gap-4">
        <Link href={`/${locale}/dashboard/support`}>
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <h2 className="font-serif text-2xl font-medium tracking-tight">
            {ticketData.subject}
          </h2>
          <p className="text-sm text-muted-foreground">
            {getCategoryLabel(ticketData.category)} · 创建于{" "}
            {formatDateInTimeZone(
              ticketData.createdAt,
              locale,
              {
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
              },
              timeZone
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {getPriorityBadge(ticketData.priority)}
          {getStatusBadge(ticketData.status)}
        </div>
      </div>

      {isAdmin && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-xs font-medium uppercase tracking-[1.2px] text-muted-foreground">
                用户信息
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-4">
                <Avatar className="h-12 w-12">
                  <AvatarImage
                    src={ticketUser?.image || undefined}
                    alt={ticketUser?.name || "用户"}
                  />
                  <AvatarFallback className="bg-foreground text-background">
                    {ticketUser?.name ? getInitials(ticketUser.name) : "U"}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <p className="font-medium">{ticketUser?.name || "未知用户"}</p>
                  <p className="text-sm text-muted-foreground">
                    {ticketUser?.email}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-xs font-medium uppercase tracking-[1.2px] text-muted-foreground">
                工单状态
              </CardTitle>
            </CardHeader>
            <CardContent>
              <AdminTicketStatusSelect
                ticketId={ticketData.id}
                currentStatus={ticketData.status}
              />
            </CardContent>
          </Card>
        </div>
      )}

      {/* 消息线程：用户消息右对齐 bg-secondary 气泡，客服回复左对齐描边气泡 */}
      <section className="space-y-4">
        <div className="border-b border-border/60 pb-2">
          <h3 className="text-xs font-medium uppercase tracking-[1.2px] text-muted-foreground">
            对话记录
          </h3>
        </div>
        <div className="space-y-4">
          {messagesWithAttachments.map((msg, index) => (
            // 消息入场错峰：按索引 50ms 递增，封顶 8 档避免长对话等待过久；
            // fill-mode 用 backwards 保证延迟期间停留在透明首帧。
            <div
              key={msg.id}
              className={`flex gap-3 animate-in fade-in slide-in-from-bottom-2 duration-400 motion-reduce:animate-none ${
                msg.isAdminResponse ? "" : "flex-row-reverse"
              }`}
              style={{
                animationDelay: `${Math.min(index, 8) * 50}ms`,
                animationFillMode: "backwards",
              }}
            >
              <Avatar className="h-8 w-8 shrink-0">
                <AvatarImage
                  src={msg.user?.image || undefined}
                  alt={msg.user?.name || "用户"}
                />
                <AvatarFallback className="bg-foreground text-xs text-background">
                  {msg.user?.name ? getInitials(msg.user.name) : "U"}
                </AvatarFallback>
              </Avatar>
              <div
                className={`flex max-w-[85%] flex-col gap-1 sm:max-w-[70%] ${
                  msg.isAdminResponse ? "items-start" : "items-end"
                }`}
              >
                <div className="flex items-center gap-2 px-1">
                  <span className="text-xs font-medium">
                    {msg.user?.name || "用户"}
                  </span>
                  {msg.isAdminResponse && (
                    <Badge
                      variant="outline"
                      className="text-[10px] uppercase tracking-wider text-muted-foreground"
                    >
                      客服
                    </Badge>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {formatDateInTimeZone(
                      msg.createdAt,
                      locale,
                      {
                        year: "numeric",
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      },
                      timeZone
                    )}
                  </span>
                </div>
                <div
                  className={
                    msg.isAdminResponse
                      ? "rounded-lg border border-border bg-background px-4 py-3"
                      : "rounded-lg rounded-br-[5px] bg-secondary px-4 py-3"
                  }
                >
                  <p className="whitespace-pre-wrap text-sm leading-relaxed">
                    {msg.content}
                  </p>
                  {msg.attachments.length > 0 && (
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      {msg.attachments.map((attachment) => (
                        <a
                          key={attachment.id}
                          href={`/api/support/attachments/${attachment.id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="block w-28 overflow-hidden rounded-md border bg-muted sm:w-36"
                          title={attachment.fileName}
                        >
                          {/* biome-ignore lint/performance/noImgElement: authenticated attachment URLs are not compatible with next/image optimization */}
                          <img
                            src={`/api/support/attachments/${attachment.id}`}
                            alt={attachment.fileName}
                            loading="lazy"
                            className="aspect-square h-auto w-full object-cover"
                          />
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 回复表单 */}
      {isAdmin ? (
        <AdminTicketReplyForm ticketId={id} isClosed={isClosed} />
      ) : isClosed ? (
        <Card className="border-dashed">
          <CardContent className="py-6 text-center text-sm text-muted-foreground">
            此工单已关闭，无法添加新消息
          </CardContent>
        </Card>
      ) : (
        <TicketMessageForm ticketId={id} />
      )}
    </div>
  );
}
