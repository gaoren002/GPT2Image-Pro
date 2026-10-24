// 公告模块入口（客户端组件也会 import 本文件）。
// 这里只暴露带鉴权包装的 Server Actions、类型与 schema：无鉴权的服务函数在
// ./service（server-only，直接 import @repo/database），经 barrel 暴露会被
// 客户端打包链拉入 pg 等 Node 模块，故服务端调用方一律用
// @repo/shared/announcements/service 深路径导入。
export {
  createAnnouncementAction,
  deleteAnnouncementAction,
  getAdminAnnouncementsAction,
  getMyUnreadAnnouncementCountAction,
  markAllAnnouncementsReadAction,
  markAnnouncementReadAction,
  toggleAnnouncementPublishAction,
  updateAnnouncementAction,
} from "./actions";
export type { AdminAnnouncementItem } from "./service";
export {
  announcementIdSchema,
  announcementSeverities,
  type AnnouncementSeverity,
  type CreateAnnouncementInput,
  createAnnouncementSchema,
  type UpdateAnnouncementInput,
  updateAnnouncementSchema,
} from "./schemas";
