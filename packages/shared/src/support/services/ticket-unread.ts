/**
 * 工单未读统计服务（server-only，非 Server Action）。
 *
 * 使用方：工单 Server Actions（../actions/ticket.ts 的薄封装）、dashboard 布局预取、
 * UOL operations。
 *
 * WHY 独立于 actions/ticket.ts：Next 会把 "use server" 文件的**每一个导出**注册成可
 * 远程调用的 Server Action。本函数按传入 userId 统计未读，自身不校验调用者身份，
 * 随动作模块注册即可被直接调用以读取任意用户的未读计数。放在不带 "use server" 的
 * 模块里即不会进入 Server Action manifest。
 */

import { db } from "@repo/database";
import { ticket } from "@repo/database/schema";
import { eq, sql } from "drizzle-orm";
import { getUserRoleById } from "../../auth/role-server";
import { isAdminRole } from "../../auth/roles";

/** 普通用户未读：管理员最后活动晚于本人最后查看。 */
export const unreadTicketCountSql =
  sql<number>`count(*) filter (where ${ticket.lastAdminActivityAt} > ${ticket.userLastSeenAt})`.mapWith(
    Number
  );

/** 管理员未读：用户有新活动且管理员未看过或看过更早的版本。 */
export const adminUnreadTicketCountSql =
  sql<number>`count(*) filter (where ${ticket.lastUserActivityAt} is not null and (${ticket.adminLastSeenAt} is null or ${ticket.lastUserActivityAt} > ${ticket.adminLastSeenAt}))`.mapWith(
    Number
  );

/**
 * 统计未读工单动态数量。管理员看全站未读，普通用户看本人未读。
 *
 * @param userId 调用方已校验的用户 ID；角色按该 ID 现查，不接受外部传入。
 */
export async function countUnreadTicketsForUser(userId: string) {
  const role = await getUserRoleById(userId);
  if (isAdminRole(role)) {
    const rows = await db
      .select({ count: adminUnreadTicketCountSql })
      .from(ticket);

    return rows[0]?.count ?? 0;
  }

  const rows = await db
    .select({ count: unreadTicketCountSql })
    .from(ticket)
    .where(eq(ticket.userId, userId));

  return rows[0]?.count ?? 0;
}
