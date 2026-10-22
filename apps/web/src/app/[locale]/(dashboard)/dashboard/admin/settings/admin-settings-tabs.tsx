"use client";

/**
 * 后台设置页的 tab 外壳:系统设置(仅超管)与生图后端池。
 *
 * 面板元素由服务端按角色构造后传入(page.tsx),本组件只管切换与按需挂载:
 * - 超管:系统设置面板连同配置快照随导航同一波下发;后端池面板不随首屏下发,
 *   切到该 tab 时才经 next/dynamic 懒加载,并在首屏空闲后预取其 chunk。
 * - 非超管:后端池面板随首屏下发,系统设置面板的代码与数据都不会到达客户端。
 * 面板都很重(各自独立 chunk),这样首屏只付当前 tab 的代价,且不比静态导入多出往返。
 */

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/ui/components/tabs";
import dynamic from "next/dynamic";
import { type ReactNode, useEffect, useState } from "react";

/** 懒加载面板的占位,与路由级 loading.tsx 同一套骨架样式。 */
function PanelSkeleton() {
  return (
    <div className="animate-pulse space-y-4 motion-reduce:animate-none">
      <div className="h-9 w-48 rounded bg-muted" />
      <div className="h-40 w-full rounded-md bg-muted" />
      <div className="h-40 w-full rounded-md bg-muted" />
    </div>
  );
}

function loadImageBackendPoolAdminPanel() {
  return import("@/features/image-backend-pool/admin-panel").then(
    (m) => m.ImageBackendPoolAdminPanel
  );
}

const LazyImageBackendPoolAdminPanel = dynamic(loadImageBackendPoolAdminPanel, {
  loading: PanelSkeleton,
});

/** 首屏渲染后多久预取后端池面板(让出首屏解析与水合,再在后台取)。 */
const POOL_PANEL_PREFETCH_DELAY_MS = 1500;

type AdminSettingsTabsProps = {
  timeZone: string;
  // 是否允许管理系统设置（含 BETTER_AUTH_SECRET 等密钥）。仅超管为 true；
  // 普通 admin 仅能管理生图后端池，不应看到/进入系统设置 tab（见审计 S-C1）。
  canManageSystemSettings: boolean;
  // 服务端仅在超管鉴权通过后构造(带预取的配置快照);非超管恒为 null。
  systemPanel: ReactNode | null;
  // 服务端预先构造的后端池面板(非超管的默认 tab);超管为 null,走懒加载。
  poolPanel: ReactNode | null;
};

type AdminSettingsTab = "system" | "image-backends";

export function AdminSettingsTabs({
  timeZone,
  canManageSystemSettings,
  systemPanel,
  poolPanel,
}: AdminSettingsTabsProps) {
  const showSystemTab = canManageSystemSettings && systemPanel !== null;
  const defaultTab: AdminSettingsTab = showSystemTab
    ? "system"
    : "image-backends";
  const [activeTab, setActiveTab] = useState<AdminSettingsTab>(defaultTab);
  const [mountedTabs, setMountedTabs] = useState<Set<AdminSettingsTab>>(
    () => new Set([defaultTab])
  );
  const hasPoolPanel = poolPanel !== null;

  // 后端池面板未随首屏下发时,空闲后预取其 chunk:切到该 tab 时通常已在缓存里。
  // import() 幂等,与 dynamic 的加载器命中同一模块,不会重复下载。
  useEffect(() => {
    if (hasPoolPanel) return;
    const timer = window.setTimeout(() => {
      void loadImageBackendPoolAdminPanel();
    }, POOL_PANEL_PREFETCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [hasPoolPanel]);

  const handleTabChange = (value: string) => {
    // 非超管禁止进入系统设置，强制回落到后端池。
    const nextTab: AdminSettingsTab =
      value === "system" && showSystemTab ? "system" : "image-backends";
    setActiveTab(nextTab);
    setMountedTabs((current) => {
      if (current.has(nextTab)) return current;
      const next = new Set(current);
      next.add(nextTab);
      return next;
    });
  };

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
      {/* Tab 语言收敛到全站胶囊规格(TabsList 默认类) */}
      <TabsList className="h-auto flex-wrap justify-start">
        {showSystemTab ? (
          <TabsTrigger value="system">系统设置</TabsTrigger>
        ) : null}
        <TabsTrigger value="image-backends">生图后端池</TabsTrigger>
      </TabsList>
      {showSystemTab ? (
        <TabsContent value="system" className="mt-6">
          {mountedTabs.has("system") ? systemPanel : null}
        </TabsContent>
      ) : null}
      <TabsContent value="image-backends" className="mt-6">
        {mountedTabs.has("image-backends")
          ? (poolPanel ?? (
              <LazyImageBackendPoolAdminPanel timeZone={timeZone} />
            ))
          : null}
      </TabsContent>
    </Tabs>
  );
}
