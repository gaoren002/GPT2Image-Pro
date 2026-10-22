"use server";

/**
 * 全局状态页的 server actions。
 *
 * 全局状态聚合用 unstable_cache 按 tag "admin-global-status" 缓存(见 page.tsx)。
 * 手动刷新即失效该 tag,使下次渲染同步重算最新数据(全站累计走按日汇总、窗口统计
 * 每行只解析一次 metadata,重算为亚秒级)。仅管理员可用。
 */

import { adminAction } from "@repo/shared/safe-action";
import { updateTag } from "next/cache";

import { GLOBAL_STATUS_CACHE_TAG } from "./cache-tag";

export const refreshGlobalStatusAction = adminAction
  .metadata({ action: "adminStatus.refresh" })
  .action(async () => {
    // Next 16:updateTag 是 server action 内单参失效缓存 tag 的 API(read-your-own
    // -writes);失效后客户端 router.refresh() 重渲染即拿到重算的最新聚合。
    updateTag(GLOBAL_STATUS_CACHE_TAG);
    return { ok: true };
  });
