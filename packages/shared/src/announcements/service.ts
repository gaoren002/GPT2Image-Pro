/**
 * 公告服务函数（server-only，非 Server Action）。
 *
 * 使用方：公告 Server Actions（./actions.ts）、Server Components（dashboard 布局与
 * 公告页）、UOL operations（uol/operations/support.ts）。
 *
 * WHY 独立于 actions.ts：Next 会把 "use server" 文件的**每一个导出**都注册成可远程
 * 调用的 Server Action。这些函数按传入的 userId 读写数据，没有自己的身份与角色校验
 * （调用方负责），一旦随 actions.ts 被注册，取得当次构建的 Action ID 即可直接调用，
 * 绕过公告管理员入口读未发布公告、或替任意用户写已读。放在不带 "use server" 的模块里
 * 即不会进入 Server Action manifest；对外入口只保留 ./actions.ts 中带
 * protectedAction / adminAction 的包装。
 *
 * 身份约定：本模块所有函数都把 userId 当作"调用方已校验过的身份"，不做鉴权。
 */

import { db } from "@repo/database";
import {
  announcement,
  announcementRead,
} from "@repo/database/schema";
import { and, desc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";

/** 管理端公告列表项（已序列化时间，便于跨 RSC 边界传递）。 */
export type AdminAnnouncementItem = {
  id: string;
  title: string;
  content: string;
  severity: string;
  isPublished: boolean;
  isPinned: boolean;
  priority: number;
  publishedAt: string | null;
  expiresAt: string | null;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

/** 用户可见公告的过滤条件：已发布、已到发布时间、未过期。 */
export const activeAnnouncementFilter = () => {
  const now = new Date();
  return and(
    eq(announcement.isPublished, true),
    or(isNull(announcement.publishedAt), lte(announcement.publishedAt, now)),
    or(isNull(announcement.expiresAt), sql`${announcement.expiresAt} > ${now}`)
  );
};

/** 公告排序：置顶、优先级、发布时间、创建时间。 */
export const announcementOrder = [
  desc(announcement.isPinned),
  desc(announcement.priority),
  desc(announcement.publishedAt),
  desc(announcement.createdAt),
];

/** 未读判定：没有已读记录，或公告在上次已读之后又被更新。 */
export const unreadAnnouncementFilter = () =>
  or(
    isNull(announcementRead.id),
    lt(announcementRead.readAt, announcement.updatedAt)
  );

/**
 * 把公告行序列化为管理端列表项。
 */
export function serializeAdminAnnouncement(
  row: typeof announcement.$inferSelect
): AdminAnnouncementItem {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    severity: row.severity,
    isPublished: row.isPublished,
    isPinned: row.isPinned,
    priority: row.priority,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdByUserId: row.createdByUserId,
    updatedByUserId: row.updatedByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * 列出指定用户可见的公告，附带其已读时间。
 *
 * @param userId 调用方已校验的用户 ID。
 */
export async function listActiveAnnouncementsForUser(userId: string) {
  return db
    .select({
      id: announcement.id,
      title: announcement.title,
      content: announcement.content,
      severity: announcement.severity,
      isPinned: announcement.isPinned,
      priority: announcement.priority,
      publishedAt: announcement.publishedAt,
      expiresAt: announcement.expiresAt,
      createdAt: announcement.createdAt,
      updatedAt: announcement.updatedAt,
      readAt: announcementRead.readAt,
    })
    .from(announcement)
    .leftJoin(
      announcementRead,
      and(
        eq(announcementRead.announcementId, announcement.id),
        eq(announcementRead.userId, userId)
      )
    )
    .where(activeAnnouncementFilter())
    .orderBy(...announcementOrder);
}

/**
 * 统计指定用户的未读公告数。
 *
 * @param userId 调用方已校验的用户 ID。
 */
export async function countUnreadAnnouncementsForUser(userId: string) {
  const [row] = await db
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(announcement)
    .leftJoin(
      announcementRead,
      and(
        eq(announcementRead.announcementId, announcement.id),
        eq(announcementRead.userId, userId)
      )
    )
    .where(and(activeAnnouncementFilter(), unreadAnnouncementFilter()));

  return row?.count ?? 0;
}

/**
 * 把一批公告标记为指定用户已读（重复标记按最新时间覆盖）。
 *
 * @param userId 调用方已校验的用户 ID。
 * @param announcementIds 公告 ID 列表，内部去重并忽略空值。
 * @returns 实际标记的公告数量。
 */
export async function markAnnouncementIdsReadForUser(
  userId: string,
  announcementIds: string[]
) {
  const uniqueIds = Array.from(new Set(announcementIds)).filter(Boolean);
  if (uniqueIds.length === 0) {
    return 0;
  }

  await db
    .insert(announcementRead)
    .values(
      uniqueIds.map((announcementId) => ({
        id: crypto.randomUUID(),
        announcementId,
        userId,
      }))
    )
    .onConflictDoUpdate({
      target: [announcementRead.userId, announcementRead.announcementId],
      set: { readAt: new Date() },
    });

  return uniqueIds.length;
}

/**
 * 列出全部公告（含未发布稿），供管理端使用。
 *
 * @remarks 返回未发布内容，调用方必须先完成管理员鉴权。
 */
export async function listAnnouncementsForAdmin() {
  return db
    .select()
    .from(announcement)
    .orderBy(desc(announcement.isPinned), desc(announcement.updatedAt));
}
