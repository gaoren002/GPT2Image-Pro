"use client";

/**
 * 生图后端池面板(features/image-backend-pool/admin-panel,约 5000 行)的懒加载入口。
 *
 * WHY:Next App Router 会把页面模块图里**静态导入**的全部客户端组件打进该页首屏
 * 入口 chunk,与是否实际渲染无关。admin/settings 的页面与 tab 外壳因此都只经这里
 * 引用面板:超管停在系统设置时面板代码不下载;需要时由 next/dynamic 按需加载
 * (服务端渲染时随 HTML 预加载,软导航时渲染到才下载)。
 *
 * 使用方:./page.tsx(观察员只读分支)、./admin-settings-tabs.tsx。
 */

import dynamic from "next/dynamic";

/** 加载面板模块。import() 幂等,预取与 dynamic 的加载器命中同一 chunk,不会重复下载。 */
export function loadImageBackendPoolAdminPanel() {
  return import("@/features/image-backend-pool/admin-panel").then(
    (m) => m.ImageBackendPoolAdminPanel
  );
}

/** 面板加载中的占位,与路由级 loading.tsx 同一套骨架样式。 */
export function PanelSkeleton() {
  return (
    <div className="animate-pulse space-y-4 motion-reduce:animate-none">
      <div className="h-9 w-48 rounded bg-muted" />
      <div className="h-40 w-full rounded-md bg-muted" />
      <div className="h-40 w-full rounded-md bg-muted" />
    </div>
  );
}

export const LazyImageBackendPoolAdminPanel = dynamic(
  loadImageBackendPoolAdminPanel,
  { loading: PanelSkeleton }
);
