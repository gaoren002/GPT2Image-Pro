"use client";

/**
 * 后台设置页的 tab 外壳:系统设置(仅超管)与生图后端池。
 *
 * - 系统设置:面板元素由服务端在超管鉴权通过后构造(带预取的配置快照)传入,
 *   随导航同一波下发,首屏即有内容;非超管拿不到该元素,也看不到该 tab。
 * - 生图后端池:面板很重,经 ./lazy-pool-panel 懒加载,不进本页首屏入口。超管默认
 *   停在系统设置,首屏渲染后延迟预取其 chunk,切到该 tab 时通常已在缓存里。
 */

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/ui/components/tabs";
import { type ReactNode, useEffect, useState } from "react";

import {
  LazyImageBackendPoolAdminPanel,
  loadImageBackendPoolAdminPanel,
} from "./lazy-pool-panel";

/** 首屏渲染后多久预取后端池面板(让出首屏解析与水合,再在后台取)。 */
const POOL_PANEL_PREFETCH_DELAY_MS = 1500;

type AdminSettingsTabsProps = {
  timeZone: string;
  // 是否允许管理系统设置（含 BETTER_AUTH_SECRET 等密钥）。仅超管为 true；
  // 普通 admin 仅能管理生图后端池，不应看到/进入系统设置 tab（见审计 S-C1）。
  canManageSystemSettings: boolean;
  // 服务端仅在超管鉴权通过后构造(带预取的配置快照);非超管恒为 null。
  systemPanel: ReactNode | null;
};

type AdminSettingsTab = "system" | "image-backends";

export function AdminSettingsTabs({
  timeZone,
  canManageSystemSettings,
  systemPanel,
}: AdminSettingsTabsProps) {
  const showSystemTab = canManageSystemSettings && systemPanel !== null;
  const defaultTab: AdminSettingsTab = showSystemTab
    ? "system"
    : "image-backends";
  const [activeTab, setActiveTab] = useState<AdminSettingsTab>(defaultTab);
  const [mountedTabs, setMountedTabs] = useState<Set<AdminSettingsTab>>(
    () => new Set([defaultTab])
  );

  // 后端池不是默认 tab 时,首屏后延迟预取其 chunk;是默认 tab 时它会立刻渲染并自行加载。
  useEffect(() => {
    if (!showSystemTab) return;
    const timer = window.setTimeout(() => {
      void loadImageBackendPoolAdminPanel();
    }, POOL_PANEL_PREFETCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [showSystemTab]);

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
        {mountedTabs.has("image-backends") ? (
          <LazyImageBackendPoolAdminPanel timeZone={timeZone} />
        ) : null}
      </TabsContent>
    </Tabs>
  );
}
