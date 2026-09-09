"use client";

import { useState } from "react";

import { SystemSettingsPanel } from "@repo/shared/system-settings/components";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@repo/ui/components/tabs";

import { ImageBackendPoolAdminPanel } from "@/features/image-backend-pool";

type AdminSettingsTabsProps = {
  timeZone: string;
  // 是否允许管理系统设置（含 BETTER_AUTH_SECRET 等密钥）。仅超管为 true；
  // 普通 admin 仅能管理生图后端池，不应看到/进入系统设置 tab（见审计 S-C1）。
  canManageSystemSettings: boolean;
};

type AdminSettingsTab = "system" | "image-backends";

export function AdminSettingsTabs({
  timeZone,
  canManageSystemSettings,
}: AdminSettingsTabsProps) {
  const defaultTab: AdminSettingsTab = canManageSystemSettings
    ? "system"
    : "image-backends";
  const [activeTab, setActiveTab] = useState<AdminSettingsTab>(defaultTab);
  const [mountedTabs, setMountedTabs] = useState<Set<AdminSettingsTab>>(
    () => new Set([defaultTab])
  );

  const handleTabChange = (value: string) => {
    // 非超管禁止进入系统设置，强制回落到后端池。
    const nextTab: AdminSettingsTab =
      value === "system" && canManageSystemSettings ? "system" : "image-backends";
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
        {canManageSystemSettings ? (
          <TabsTrigger value="system">系统设置</TabsTrigger>
        ) : null}
        <TabsTrigger value="image-backends">生图后端池</TabsTrigger>
      </TabsList>
      {canManageSystemSettings ? (
        <TabsContent value="system" className="mt-6">
          {mountedTabs.has("system") ? <SystemSettingsPanel /> : null}
        </TabsContent>
      ) : null}
      <TabsContent value="image-backends" className="mt-6">
        {mountedTabs.has("image-backends") ? (
          <ImageBackendPoolAdminPanel timeZone={timeZone} />
        ) : null}
      </TabsContent>
    </Tabs>
  );
}
