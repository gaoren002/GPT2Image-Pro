"use client";

/**
 * 通知侧栏刷新未读角标(工单 / 公告)。
 *
 * 侧栏属于共享的 dashboard 布局,软导航不会重新渲染,其未读数来自布局首屏的服务端
 * 预取。"打开即标记已读"的页面(公告列表、工单详情)渲染本组件:页面内容挂载时服务端
 * 已完成标记,此时让侧栏重新拉取才能拿到新值,否则红点会一直留到整页刷新。
 *
 * 使用方:dashboard/announcements/page.tsx、dashboard/support/[id]/page.tsx;
 * 监听方:./sidebar.tsx。
 */

import { useEffect } from "react";

/** 侧栏监听的窗口事件名(仅本站内部使用)。 */
export const SIDEBAR_UNREAD_CHANGED_EVENT = "gpt2image:sidebar-unread-changed";

/** 挂载时派发一次未读变更事件;不渲染任何内容。 */
export function SidebarUnreadSync() {
  useEffect(() => {
    window.dispatchEvent(new Event(SIDEBAR_UNREAD_CHANGED_EVENT));
  }, []);
  return null;
}
