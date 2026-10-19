"use client";

import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import { Label } from "@repo/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select";
import { Loader2, RefreshCw } from "lucide-react";
import { useAction } from "next-safe-action/hooks";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import {
  getSelectableImageBackendGroupsAction,
  setUserImageBackendPreferenceAction,
} from "./actions";
import type {
  ImageBackendGroupBackendType,
  ImageBackendGroupSizeTier,
} from "./types";

type GroupOption = {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  contentSafetyEnabled: boolean | null;
  backendType: ImageBackendGroupBackendType;
  sizeTier?: ImageBackendGroupSizeTier;
  billingMultiplier: number;
};

function safetyLabel(value: boolean | null) {
  if (value === true) return "内容审核开启";
  if (value === false) return "内容审核关闭";
  return "内容审核按成员配置";
}

function backendTypeLabel(value: ImageBackendGroupBackendType) {
  if (value === "web") return "仅 Web";
  if (value === "responses") return "非 Web";
  return "混合";
}

function sizeTierLabel(value: ImageBackendGroupSizeTier | undefined) {
  return value === "full" ? "全参 4K" : "仅 1.2K";
}

function formatBillingMultiplier(value: number | null | undefined) {
  const multiplier = Number(value ?? 1);
  if (!Number.isFinite(multiplier) || multiplier <= 0) return "1";
  return Number(multiplier.toFixed(4)).toString();
}

function groupOptionLabel(group: GroupOption) {
  // Web 车道出图分辨率由 Web 端决定，不标档位；非 Web 车道标注上游真实能力。
  const sizePart =
    group.backendType === "web" ? "" : ` · ${sizeTierLabel(group.sizeTier)}`;
  return `${group.name}${group.isDefault ? "（默认）" : ""} · ${backendTypeLabel(
    group.backendType
  )}${sizePart} · ${safetyLabel(group.contentSafetyEnabled)} · 计费 x${formatBillingMultiplier(
    group.billingMultiplier
  )}`;
}

export function ImageBackendPreferenceSection() {
  const [groups, setGroups] = useState<GroupOption[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState("default");
  const defaultGroup = groups.find((group) => group.isDefault) ?? null;
  const selectedGroup =
    selectedGroupId === "default"
      ? defaultGroup
      : groups.find((group) => group.id === selectedGroupId) ?? null;

  const { execute: loadGroups, isPending: isLoading } = useAction(
    getSelectableImageBackendGroupsAction,
    {
      onSuccess: ({ data }) => {
        setGroups((data?.groups || []) as GroupOption[]);
        setSelectedGroupId(data?.selectedGroupId || "default");
      },
      onError: ({ error }) => toast.error(error.serverError || "加载生图分组失败"),
    }
  );

  const { execute: savePreference, isPending: isSaving } = useAction(
    setUserImageBackendPreferenceAction,
    {
      onSuccess: () => toast.success("生图后端分组已保存"),
      onError: ({ error }) => toast.error(error.serverError || "保存生图分组失败"),
    }
  );

  useEffect(() => {
    loadGroups();
  }, [loadGroups]);

  return (
    <div className="space-y-4 rounded-lg border border-border p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h4 className="text-sm font-medium">生图后端分组</h4>
          <p className="text-xs text-muted-foreground">
            只影响网页端创作；外接 API Key 在 API Key 列表中单独选择分组，Key 未绑定时使用平台默认分组。
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => loadGroups()}
          disabled={isLoading}
          aria-label="刷新生图分组"
        >
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
        </Button>
      </div>

      {/* 表单行 hover 微提亮：负外边距抵消内边距，背景外扩而内容不位移 */}
      <div className="-mx-2 grid gap-2 rounded-md px-2 py-2 transition-colors duration-150 hover:bg-muted/30 sm:grid-cols-[1fr_auto]">
        <div className="space-y-2">
          <Label
            htmlFor="image-backend-group"
            className="text-xs uppercase tracking-[0.6px] text-muted-foreground"
          >
            分组
          </Label>
          <Select value={selectedGroupId} onValueChange={setSelectedGroupId}>
            <SelectTrigger id="image-backend-group">
              <SelectValue placeholder="网页端默认分组" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">
                {defaultGroup
                  ? `网页端默认分组 · ${groupOptionLabel(defaultGroup)}`
                  : "网页端默认分组"}
              </SelectItem>
              {groups.map((group) => (
                <SelectItem key={group.id} value={group.id}>
                  {groupOptionLabel(group)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectedGroup && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>{groupOptionLabel(selectedGroup)}</span>
              <Badge variant="outline" className="rounded-full">
                计费 x{formatBillingMultiplier(selectedGroup.billingMultiplier)}
              </Badge>
            </div>
          )}
        </div>
        <Button
          type="button"
          className="self-end"
          onClick={() => savePreference({ groupId: selectedGroupId })}
          disabled={isSaving}
        >
          {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          保存
        </Button>
      </div>
    </div>
  );
}
