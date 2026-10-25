"use server";

/** 画布图片来源的薄 Action；依赖会话中间件和 UOL 服务，不接收客户端参数。 */
import { protectedAction } from "@repo/shared/safe-action";
import { listCanvasImagesForUser } from "./server";

/** 从受保护上下文取得用户身份，返回图片列表；认证或读取失败由统一出口处理。 */
export const getCanvasImagesAction = protectedAction
  .metadata({ action: "canvas.listImages" })
  .action(async ({ ctx }) => listCanvasImagesForUser(ctx.userId));
