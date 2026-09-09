"use client";

import { Database, Download, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { useAction } from "next-safe-action/hooks";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select";
import { Switch } from "@repo/ui/components/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@repo/ui/components/tabs";
import { Textarea } from "@repo/ui/components/textarea";
import { formatDateInTimeZone } from "../../time-zone";

import {
  getSystemSettingsAction,
  importSystemSettingsFromEnvAction,
  initializeSystemSettingsDefaultsAction,
  updateSystemSettingsAction,
} from "../actions";
import { SETTING_CATEGORIES } from "../definitions";
import type {
  SettingCategory,
  SettingDefinition,
  SettingKey,
} from "../definitions";

type SettingSnapshotItem = SettingDefinition & {
  value: string;
  configured: boolean;
  stored: boolean;
  fromEnv: boolean;
  updatedAt: string | null;
};

type DraftValue = string | number | boolean | unknown;
type SettingUpdate = {
  key: string;
  value?: DraftValue;
  clear?: boolean;
};

const PLAN_OPTIONS = [
  { value: "free", label: "Free" },
  { value: "starter", label: "Starter" },
  { value: "pro", label: "Pro" },
  { value: "ultra", label: "Ultra" },
  { value: "enterprise", label: "Enterprise" },
] as const;

const PLAN_REQUIREMENT_OPTIONS = [
  { value: "none", label: "不限制" },
  ...PLAN_OPTIONS,
] as const;

const QUEUE_PRIORITY_OPTIONS = [
  { value: "normal", label: "普通" },
  { value: "priority", label: "优先" },
  { value: "highest", label: "最高" },
] as const;

const MODERATION_LEVEL_OPTIONS = [
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
] as const;

const FEATURE_ROWS = [
  {
    key: "imageGeneration.text",
    label: "文生图",
    description: "页面/API 文本生成图片",
  },
  {
    key: "imageGeneration.edit",
    label: "图生图/编辑",
    description: "上传参考图、编辑图片",
  },
  {
    key: "imageGeneration.chat",
    label: "普通对话",
    description: "页面 Chat：连续对话式生图，不默认注入 Agent 工具",
  },
  {
    key: "imageGeneration.agent",
    label: "Agent 模式",
    description: "页面 Agent：联网、工具调用、附件上下文和自动迭代",
  },
  {
    key: "imageGeneration.waterfall",
    label: "瀑布流",
    description: "页面 Waterfall：同一提示词连续生成多张",
  },
  {
    key: "imageGeneration.batch",
    label: "批量生成",
    description: "一次请求生成多张",
  },
  {
    key: "export.ppt",
    label: "导出 PPT",
    description: "对话式生成可编辑 PPT 文件（gpt-5-5-thinking + 代码解释器）",
  },
  {
    key: "export.psd",
    label: "导出 PSD",
    description: "对话式生成可编辑 PSD 文件（gpt-5-5-thinking + 代码解释器）",
  },
  {
    key: "promptOptimization.control",
    label: "关闭提示词优化",
    description: "允许用户控制 prompt_optimization",
  },
  {
    key: "models.premium",
    label: "旗舰文本模型",
    description: "允许选择 GPT-6 Astra、GPT-5.6 Sol、Terra 和 Luna",
  },
  {
    key: "customApi.configure",
    label: "接入其他站 API",
    description: "用户配置自己的上游 API",
  },
  {
    key: "backendGroups.select",
    label: "选择后端分组",
    description: "允许选择平台后端分组",
  },
  {
    key: "externalApi.keys.manage",
    label: "管理外接 API Key",
    description: "本站对外 API Key 管理",
  },
  {
    key: "externalApi.models.list",
    label: "外接 /v1/models",
    description: "允许模型列表接口",
  },
  {
    key: "externalApi.chat.completions",
    label: "外接 Chat",
    description: "允许 /v1/chat/completions",
  },
  {
    key: "externalApi.images.generate",
    label: "外接文生图",
    description: "允许 /v1/images/generations",
  },
  {
    key: "externalApi.images.edit",
    label: "外接图片编辑",
    description: "允许 /v1/images/edits",
  },
  {
    key: "externalApi.responses",
    label: "外接 Responses",
    description: "允许 /v1/responses，通常要求 Pro+",
  },
  {
    key: "externalApi.agent",
    label: "外接 Agent 生图",
    description: "允许 /v1/agents/images，默认要求 Ultra+",
  },
  {
    key: "externalApi.streaming",
    label: "外接流式",
    description: "允许 stream=true",
  },
  {
    key: "externalApi.relay",
    label: "纯中转 Key",
    description: "允许将 API Key 设为纯中转（不记录/不存储），默认要求 Pro+",
  },
  {
    key: "moderation.blocking",
    label: "审核拦截",
    description: "本站内容审核是否对该套餐生效",
  },
  {
    key: "moderation.onlyFailureSettlement",
    label: "审核失败只扣审核积分",
    description: "审核拦截后只结算审核成本",
  },
] as const;

const LIMIT_ROWS = [
  {
    key: "monthlyCredits",
    label: "月积分配额",
    description: "Free 为一次性额度，订阅为每月额度",
    inputMode: "numeric",
  },
  {
    key: "imageGenerationConcurrency",
    label: "生图并发",
    description: "单用户图片生成并发上限",
    inputMode: "numeric",
  },
  {
    key: "maxFileMb",
    label: "单文件大小 MB",
    description: "单个上传文件大小上限",
    inputMode: "decimal",
  },
  {
    key: "maxUploadMb",
    label: "单次上传总量 MB",
    description: "一次编辑/对话请求的总上传上限",
    inputMode: "decimal",
  },
  {
    key: "maxBatchCount",
    label: "批量张数",
    description: "n/count 最大值",
    inputMode: "numeric",
  },
  {
    key: "maxEditImages",
    label: "编辑参考图数",
    description: "图生图/编辑最多参考图数量",
    inputMode: "numeric",
  },
  {
    key: "maxChatImages",
    label: "对话参考图数",
    description: "对话生图最多参考图数量",
    inputMode: "numeric",
  },
  {
    key: "maxChatContextChars",
    label: "对话上下文字符",
    description: "对话历史和当前输入的字符上限",
    inputMode: "numeric",
  },
  {
    key: "queuePriority",
    label: "队列优先级",
    description: "调度队列优先级",
    inputMode: "select",
  },
] as const;

const MODERATION_ROWS = [
  {
    key: "defaultBlockRiskLevel",
    label: "默认拦截等级",
    description: "用户未选择时使用",
  },
  {
    key: "maxBlockRiskLevel",
    label: "最高可选等级",
    description: "用户可选择的最高拦截强度",
  },
] as const;

const BILLING_ROWS = [
  {
    key: "chatRoundCredits",
    label: "Chat 每轮积分",
    description: "页面普通对话每次请求/每轮基础积分，不含图片输出积分",
  },
  {
    key: "agentRoundCredits",
    label: "Agent 每轮积分",
    description: "页面 Agent 自动迭代每轮基础积分，不含图片输出积分",
  },
] as const;

type PlanValue = (typeof PLAN_OPTIONS)[number]["value"];
type PlanRequirementValue = (typeof PLAN_REQUIREMENT_OPTIONS)[number]["value"];
type QueuePriorityValue = (typeof QUEUE_PRIORITY_OPTIONS)[number]["value"];
type ModerationLevelValue = (typeof MODERATION_LEVEL_OPTIONS)[number]["value"];
type FeatureKey = (typeof FEATURE_ROWS)[number]["key"];
type LimitKey = (typeof LIMIT_ROWS)[number]["key"];
type ModerationKey = (typeof MODERATION_ROWS)[number]["key"];
type BillingKey = (typeof BILLING_ROWS)[number]["key"];

type CapabilityMatrixDraft = {
  version: 1;
  features: Record<FeatureKey, PlanValue>;
  limits: Record<PlanValue, Record<LimitKey, string | number>>;
  moderation: Record<PlanValue, Record<ModerationKey, ModerationLevelValue>>;
  billing: Record<PlanValue, Record<BillingKey, number>>;
};

type CreditPackageDraft = {
  draftKey: string;
  id: string;
  name: string;
  nameZh: string;
  description: string;
  descriptionZh: string;
  credits: number;
  price: number;
  popular: boolean;
  visible: boolean;
  requiresPlan: PlanRequirementValue;
  allowQuantity: boolean;
  maxQuantity: number;
  creemProductId: string;
  pricesByPlan: Record<PlanValue, number>;
  creemProductIdsByPlan: Record<PlanValue, string>;
};

type CreditPackageMatrixDraft = {
  packages: CreditPackageDraft[];
};

function formatJsonExample(value: unknown) {
  return JSON.stringify(value ?? {}, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function recordValue(
  record: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  const value = record[key];
  return isRecord(value) ? value : {};
}

function parseJsonDraft(value: DraftValue) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function asPlan(value: unknown, fallback: PlanValue): PlanValue {
  return PLAN_OPTIONS.some((option) => option.value === value)
    ? (value as PlanValue)
    : fallback;
}

function asPlanRequirement(
  value: unknown,
  fallback: PlanRequirementValue
): PlanRequirementValue {
  return PLAN_REQUIREMENT_OPTIONS.some((option) => option.value === value)
    ? (value as PlanRequirementValue)
    : fallback;
}

function asQueuePriority(
  value: unknown,
  fallback: QueuePriorityValue
): QueuePriorityValue {
  return QUEUE_PRIORITY_OPTIONS.some((option) => option.value === value)
    ? (value as QueuePriorityValue)
    : fallback;
}

function asModerationLevel(
  value: unknown,
  fallback: ModerationLevelValue
): ModerationLevelValue {
  return MODERATION_LEVEL_OPTIONS.some((option) => option.value === value)
    ? (value as ModerationLevelValue)
    : fallback;
}

function numberValue(value: unknown, fallback: number) {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizePlanNumberMap(
  value: unknown,
  fallbackValue: unknown,
  fallbackNumber: number
) {
  const raw = isRecord(value) ? value : {};
  const fallback = isRecord(fallbackValue) ? fallbackValue : {};

  return Object.fromEntries(
    PLAN_OPTIONS.map((plan) => [
      plan.value,
      numberValue(
        raw[plan.value],
        numberValue(fallback[plan.value], fallbackNumber)
      ),
    ])
  ) as Record<PlanValue, number>;
}

function normalizePlanStringMap(value: unknown, fallbackValue: unknown) {
  const raw = isRecord(value) ? value : {};
  const fallback = isRecord(fallbackValue) ? fallbackValue : {};

  return Object.fromEntries(
    PLAN_OPTIONS.map((plan) => [
      plan.value,
      stringValue(raw[plan.value], stringValue(fallback[plan.value])),
    ])
  ) as Record<PlanValue, string>;
}

function normalizeCapabilityMatrixDraft(
  rawValue: DraftValue,
  fallbackValue: unknown
): CapabilityMatrixDraft {
  const parsedRaw = parseJsonDraft(rawValue);
  const raw = isRecord(parsedRaw) ? parsedRaw : {};
  const fallback = isRecord(fallbackValue) ? fallbackValue : {};
  const rawFeatures = isRecord(raw.features) ? raw.features : {};
  const fallbackFeatures = isRecord(fallback.features) ? fallback.features : {};
  const rawLimits = isRecord(raw.limits) ? raw.limits : {};
  const fallbackLimits = isRecord(fallback.limits) ? fallback.limits : {};
  const rawModeration = isRecord(raw.moderation) ? raw.moderation : {};
  const fallbackModeration = isRecord(fallback.moderation)
    ? fallback.moderation
    : {};
  const rawBilling = isRecord(raw.billing) ? raw.billing : {};
  const fallbackBilling = isRecord(fallback.billing) ? fallback.billing : {};

  const features = Object.fromEntries(
    FEATURE_ROWS.map((row) => [
      row.key,
      asPlan(rawFeatures[row.key], asPlan(fallbackFeatures[row.key], "free")),
    ])
  ) as CapabilityMatrixDraft["features"];

  const limits = Object.fromEntries(
    PLAN_OPTIONS.map((plan) => {
      const rawPlanLimits = recordValue(rawLimits, plan.value);
      const fallbackPlanLimits = recordValue(fallbackLimits, plan.value);

      const entries = LIMIT_ROWS.map((row) => {
        if (row.key === "queuePriority") {
          return [
            row.key,
            asQueuePriority(
              rawPlanLimits[row.key],
              asQueuePriority(fallbackPlanLimits[row.key], "normal")
            ),
          ] as const;
        }

        return [
          row.key,
          numberValue(
            rawPlanLimits[row.key],
            numberValue(fallbackPlanLimits[row.key], 1)
          ),
        ] as const;
      });

      return [plan.value, Object.fromEntries(entries)] as const;
    })
  ) as CapabilityMatrixDraft["limits"];

  const moderation = Object.fromEntries(
    PLAN_OPTIONS.map((plan) => {
      const rawPlanModeration = recordValue(rawModeration, plan.value);
      const fallbackPlanModeration = recordValue(
        fallbackModeration,
        plan.value
      );

      return [
        plan.value,
        {
          defaultBlockRiskLevel: asModerationLevel(
            rawPlanModeration.defaultBlockRiskLevel,
            asModerationLevel(
              fallbackPlanModeration.defaultBlockRiskLevel,
              "low"
            )
          ),
          maxBlockRiskLevel: asModerationLevel(
            rawPlanModeration.maxBlockRiskLevel,
            asModerationLevel(fallbackPlanModeration.maxBlockRiskLevel, "low")
          ),
        },
      ] as const;
    })
  ) as CapabilityMatrixDraft["moderation"];

  const billing = Object.fromEntries(
    PLAN_OPTIONS.map((plan) => {
      const rawPlanBilling = recordValue(rawBilling, plan.value);
      const fallbackPlanBilling = recordValue(fallbackBilling, plan.value);

      return [
        plan.value,
        Object.fromEntries(
          BILLING_ROWS.map((row) => [
            row.key,
            numberValue(
              rawPlanBilling[row.key],
              numberValue(
                fallbackPlanBilling[row.key],
                row.key === "agentRoundCredits" ? 3 : 1
              )
            ),
          ])
        ),
      ] as const;
    })
  ) as CapabilityMatrixDraft["billing"];

  return {
    version: 1,
    features,
    limits,
    moderation,
    billing,
  };
}

function getRawCreditPackages(value: unknown) {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.packages)) return value.packages;
  return [];
}

function normalizeCreditPackageMatrixDraft(
  rawValue: DraftValue,
  fallbackValue: unknown
): CreditPackageMatrixDraft {
  const parsedRaw = parseJsonDraft(rawValue);
  const rawPackages = getRawCreditPackages(parsedRaw);
  const fallbackPackages = getRawCreditPackages(fallbackValue);
  const hasRawPackages =
    Array.isArray(parsedRaw) ||
    (isRecord(parsedRaw) && Array.isArray(parsedRaw.packages));
  const fallbackById = new Map(
    fallbackPackages
      .filter(isRecord)
      .map((pkg) => [stringValue(pkg.id), pkg] as const)
      .filter(([id]) => Boolean(id))
  );
  const sourcePackages = hasRawPackages ? rawPackages : fallbackPackages;

  return {
    packages: sourcePackages
      .map((rawPackage, index) => {
        if (!isRecord(rawPackage)) return null;
        const fallback = fallbackById.get(stringValue(rawPackage.id)) ?? {};
        // Keep an empty ID in the draft so the field can be cleared and retyped.
        const id = stringValue(rawPackage.id, stringValue(fallback.id)).trim();
        const price = numberValue(
          rawPackage.price,
          numberValue(fallback.price, 1)
        );
        const fallbackRequiresPlan = asPlanRequirement(
          fallback.requiresPlan,
          "none"
        );
        const requiresPlan = asPlanRequirement(
          rawPackage.requiresPlan,
          fallbackRequiresPlan
        );

        return {
          draftKey: `credit-package-${index}`,
          id,
          name: stringValue(rawPackage.name, stringValue(fallback.name, id)),
          nameZh: stringValue(rawPackage.nameZh, stringValue(fallback.nameZh)),
          description: stringValue(
            rawPackage.description,
            stringValue(fallback.description)
          ),
          descriptionZh: stringValue(
            rawPackage.descriptionZh,
            stringValue(fallback.descriptionZh)
          ),
          credits: numberValue(
            rawPackage.credits,
            numberValue(fallback.credits, 1)
          ),
          price,
          popular: booleanValue(rawPackage.popular, Boolean(fallback.popular)),
          visible: booleanValue(
            rawPackage.visible,
            fallback.visible === undefined ? true : Boolean(fallback.visible)
          ),
          requiresPlan,
          allowQuantity: booleanValue(
            rawPackage.allowQuantity,
            Boolean(fallback.allowQuantity)
          ),
          maxQuantity: numberValue(
            rawPackage.maxQuantity,
            numberValue(fallback.maxQuantity, 1)
          ),
          creemProductId: stringValue(
            rawPackage.creemProductId,
            stringValue(fallback.creemProductId)
          ),
          pricesByPlan: normalizePlanNumberMap(
            rawPackage.pricesByPlan,
            fallback.pricesByPlan,
            price
          ),
          creemProductIdsByPlan: normalizePlanStringMap(
            rawPackage.creemProductIdsByPlan,
            fallback.creemProductIdsByPlan
          ),
          sortIndex: index,
        };
      })
      .filter((pkg): pkg is CreditPackageDraft & { sortIndex: number } =>
        Boolean(pkg)
      )
      .sort((a, b) => a.sortIndex - b.sortIndex)
      .map(({ sortIndex: _sortIndex, ...pkg }) => pkg),
  };
}

function compactCreditPackageMatrixDraft(matrix: CreditPackageMatrixDraft) {
  return {
    packages: matrix.packages.map((pkg) => {
      const pricesByPlan = Object.fromEntries(
        PLAN_OPTIONS.map((plan) => [plan.value, pkg.pricesByPlan[plan.value]])
      );
      const creemProductIdsByPlan = Object.fromEntries(
        PLAN_OPTIONS.map((plan) => [
          plan.value,
          pkg.creemProductIdsByPlan[plan.value].trim(),
        ]).filter(([, value]) => Boolean(value))
      );

      return {
        id: pkg.id.trim(),
        name: pkg.name.trim() || pkg.id.trim(),
        nameZh: pkg.nameZh.trim() || pkg.name.trim() || pkg.id.trim(),
        description: pkg.description,
        descriptionZh: pkg.descriptionZh.trim()
          ? pkg.descriptionZh
          : pkg.description,
        credits: Number(pkg.credits) || 1,
        price: Number(pkg.price) || 1,
        popular: pkg.popular,
        visible: pkg.visible,
        ...(pkg.requiresPlan !== "none" ? { requiresPlan: pkg.requiresPlan } : {}),
        allowQuantity: pkg.allowQuantity,
        maxQuantity: Number(pkg.maxQuantity) || 1,
        ...(pkg.creemProductId.trim()
          ? { creemProductId: pkg.creemProductId.trim() }
          : {}),
        pricesByPlan,
        ...(Object.keys(creemProductIdsByPlan).length > 0
          ? { creemProductIdsByPlan }
          : {}),
      };
    }),
  };
}

function validateCreditPackageMatrix(value: unknown) {
  const packages = getRawCreditPackages(value);
  const seenIds = new Set<string>();

  for (const [index, rawPackage] of packages.entries()) {
    if (!isRecord(rawPackage)) {
      throw new Error(`第 ${index + 1} 个积分包格式无效`);
    }
    const id = stringValue(rawPackage.id).trim();
    if (!id) {
      throw new Error(`第 ${index + 1} 个积分包必须填写包 ID`);
    }
    if (seenIds.has(id)) {
      throw new Error(`积分包 ID 不能重复：${id}`);
    }
    seenIds.add(id);
  }
}

function getJsonSettingHint(key: string) {
  if (key === "PLAN_CAPABILITY_MATRIX") {
    return "留空表示使用代码默认矩阵，并继续兼容旧上传/月积分配置。后台矩阵保存后会写入 JSON；功能门槛按最低套餐生效，高级套餐自动包含低级套餐能力。";
  }
  if (key === "CREDIT_PACKAGE_MATRIX") {
    return "留空表示使用代码默认积分包。占位内容只是示例，填写 JSON 后保存才会启用自定义积分包；pricesByPlan 可按套餐配置不同价格，Creem 按套餐定价时需配置对应产品 ID。";
  }
  return "留空表示使用代码默认值。占位内容只是示例，填写 JSON 后保存才会启用自定义配置。";
}

function normalizeDraftValue(setting: SettingSnapshotItem): DraftValue {
  if (setting.valueType === "boolean") {
    if (setting.stored) return setting.value === "true";
    return Boolean(setting.defaultValue);
  }
  if (setting.valueType === "number") {
    if (setting.stored && setting.value !== "") return Number(setting.value);
    return typeof setting.defaultValue === "number" ? setting.defaultValue : "";
  }
  if (setting.valueType === "json") {
    if (setting.value) return setting.value;
    if (typeof setting.defaultValue === "string") return setting.defaultValue;
    if (setting.defaultValue !== undefined) {
      return formatJsonExample(setting.defaultValue);
    }
    return "";
  }
  return setting.value || "";
}

function toSubmitValue(setting: SettingSnapshotItem, value: DraftValue) {
  if (setting.valueType === "boolean") return Boolean(value);
  if (setting.valueType === "number") return Number(value);
  if (setting.valueType === "json") {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (!trimmed) return "";
    const parsed = JSON.parse(trimmed) as unknown;
    if (setting.key === "CREDIT_PACKAGE_MATRIX") {
      validateCreditPackageMatrix(parsed);
    }
    return parsed;
  }
  return String(value ?? "");
}

function SettingInput({
  setting,
  value,
  disabled,
  onChange,
}: {
  setting: SettingSnapshotItem;
  value: DraftValue;
  disabled: boolean;
  onChange: (value: DraftValue) => void;
}) {
  if (setting.key === "PLAN_CAPABILITY_MATRIX") {
    return (
      <PlanCapabilityMatrixInput
        value={value}
        fallbackValue={setting.exampleValue}
        disabled={disabled}
        onChange={onChange}
      />
    );
  }

  if (setting.key === "CREDIT_PACKAGE_MATRIX") {
    return (
      <CreditPackageMatrixInput
        value={value}
        fallbackValue={setting.exampleValue}
        disabled={disabled}
        onChange={onChange}
      />
    );
  }

  if (setting.key === "REGISTRATION_EMAIL_ALLOWED_DOMAINS") {
    return (
      <Textarea
        value={String(value ?? "")}
        rows={3}
        className="min-h-20 resize-y font-mono text-sm"
        placeholder="163.com, 126.com, qq.com, gmail.com"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  if (setting.valueType === "boolean") {
    return (
      <Switch
        checked={Boolean(value)}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    );
  }

  if (setting.valueType === "select") {
    return (
      <Select
        value={String(value || "")}
        disabled={disabled}
        onValueChange={onChange}
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder="请选择" />
        </SelectTrigger>
        <SelectContent>
          {(setting.options ?? []).map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (setting.valueType === "json") {
    const placeholder =
      setting.exampleValue !== undefined
        ? formatJsonExample(setting.exampleValue)
        : "{}";
    return (
      <Textarea
        value={String(value ?? "")}
        rows={18}
        className="min-h-72 resize-y font-mono text-xs"
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  return (
    <Input
      type={setting.valueType === "number" ? "number" : "text"}
      value={String(value)}
      placeholder={setting.secret && setting.configured ? "已配置，留空不修改" : ""}
      disabled={disabled}
      onChange={(event) =>
        onChange(
          setting.valueType === "number"
            ? event.target.value
            : event.target.value
        )
      }
    />
  );
}

function MatrixSelect({
  value,
  options,
  disabled,
  onChange,
}: {
  value: string;
  options: readonly { value: string; label: string }[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} disabled={disabled} onValueChange={onChange}>
      <SelectTrigger className="h-9 min-w-24">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function PlanCapabilityMatrixInput({
  value,
  fallbackValue,
  disabled,
  onChange,
}: {
  value: DraftValue;
  fallbackValue: unknown;
  disabled: boolean;
  onChange: (value: DraftValue) => void;
}) {
  const matrix = useMemo(
    () => normalizeCapabilityMatrixDraft(value, fallbackValue),
    [value, fallbackValue]
  );
  const preview = useMemo(() => JSON.stringify(matrix, null, 2), [matrix]);

  const updateMatrix = (next: CapabilityMatrixDraft) => {
    onChange(JSON.stringify(next, null, 2));
  };

  const updateFeature = (key: FeatureKey, plan: PlanValue) => {
    updateMatrix({
      ...matrix,
      features: {
        ...matrix.features,
        [key]: plan,
      },
    });
  };

  const updateLimit = (
    plan: PlanValue,
    key: LimitKey,
    nextValue: string
  ) => {
    updateMatrix({
      ...matrix,
      limits: {
        ...matrix.limits,
        [plan]: {
          ...matrix.limits[plan],
          [key]: key === "queuePriority" ? nextValue : Number(nextValue),
        },
      },
    });
  };

  const updateModeration = (
    plan: PlanValue,
    key: ModerationKey,
    nextValue: ModerationLevelValue
  ) => {
    updateMatrix({
      ...matrix,
      moderation: {
        ...matrix.moderation,
        [plan]: {
          ...matrix.moderation[plan],
          [key]: nextValue,
        },
      },
    });
  };

  const updateBilling = (
    plan: PlanValue,
    key: BillingKey,
    nextValue: string
  ) => {
    updateMatrix({
      ...matrix,
      billing: {
        ...matrix.billing,
        [plan]: {
          ...matrix.billing[plan],
          [key]: Number(nextValue),
        },
      },
    });
  };

  return (
    <div className="space-y-5">
      <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        按最低套餐配置功能门槛；Starter/Pro/Ultra/Enterprise 自动包含更低套餐能力。并发、上传大小、月积分、批量张数、参考图数量、审核等级和 Chat/Agent 每轮计费都在这里统一配置。
      </div>

      <section className="space-y-2">
        <div>
          <h4 className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">功能门槛</h4>
          <p className="text-xs text-muted-foreground">
            选择启用某项能力所需的最低套餐。
          </p>
        </div>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="border-b border-border/60 text-[11px] uppercase tracking-widest text-muted-foreground">
              <tr>
                <th className="w-56 px-3 py-2 text-left font-medium">能力</th>
                <th className="px-3 py-2 text-left font-medium">说明</th>
                <th className="w-36 px-3 py-2 text-left font-medium">
                  最低套餐
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {FEATURE_ROWS.map((row) => (
                <tr key={row.key}>
                  <td className="px-3 py-2 font-medium">{row.label}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {row.description}
                  </td>
                  <td className="px-3 py-2">
                    <MatrixSelect
                      value={matrix.features[row.key]}
                      options={PLAN_OPTIONS}
                      disabled={disabled}
                      onChange={(nextValue) =>
                        updateFeature(row.key, nextValue as PlanValue)
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-2">
        <div>
          <h4 className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">对话计费</h4>
          <p className="text-xs text-muted-foreground">
            配置页面 Chat/Agent 的每轮基础积分；生成图片时还会按实际成品图尺寸和数量追加图片积分。
          </p>
        </div>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="border-b border-border/60 text-[11px] uppercase tracking-widest text-muted-foreground">
              <tr>
                <th className="w-52 px-3 py-2 text-left font-medium">计费项</th>
                {PLAN_OPTIONS.map((plan) => (
                  <th
                    key={plan.value}
                    className="w-36 px-3 py-2 text-left font-medium"
                  >
                    {plan.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {BILLING_ROWS.map((row) => (
                <tr key={row.key}>
                  <td className="px-3 py-2">
                    <div className="font-medium">{row.label}</div>
                    <div className="text-xs text-muted-foreground">
                      {row.description}
                    </div>
                  </td>
                  {PLAN_OPTIONS.map((plan) => (
                    <td key={plan.value} className="px-3 py-2 align-top">
                      <Input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={String(matrix.billing[plan.value][row.key])}
                        disabled={disabled}
                        className="h-9 min-w-28"
                        onChange={(event) =>
                          updateBilling(
                            plan.value,
                            row.key,
                            event.target.value
                          )
                        }
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-2">
        <div>
          <h4 className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">套餐限制</h4>
          <p className="text-xs text-muted-foreground">
            管理 Ultra 等套餐的并发、上传大小、月积分和请求数量限制。
          </p>
        </div>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="border-b border-border/60 text-[11px] uppercase tracking-widest text-muted-foreground">
              <tr>
                <th className="w-52 px-3 py-2 text-left font-medium">限制项</th>
                {PLAN_OPTIONS.map((plan) => (
                  <th
                    key={plan.value}
                    className="w-36 px-3 py-2 text-left font-medium"
                  >
                    {plan.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {LIMIT_ROWS.map((row) => (
                <tr key={row.key}>
                  <td className="px-3 py-2">
                    <div className="font-medium">{row.label}</div>
                    <div className="text-xs text-muted-foreground">
                      {row.description}
                    </div>
                  </td>
                  {PLAN_OPTIONS.map((plan) => {
                    const currentValue = matrix.limits[plan.value][row.key];
                    return (
                      <td key={plan.value} className="px-3 py-2 align-top">
                        {row.key === "queuePriority" ? (
                          <MatrixSelect
                            value={String(currentValue)}
                            options={QUEUE_PRIORITY_OPTIONS}
                            disabled={disabled}
                            onChange={(nextValue) =>
                              updateLimit(plan.value, row.key, nextValue)
                            }
                          />
                        ) : (
                          <Input
                            type="number"
                            min="1"
                            step={row.inputMode === "decimal" ? "0.1" : "1"}
                            value={String(currentValue)}
                            disabled={disabled}
                            className="h-9 min-w-28"
                            onChange={(event) =>
                              updateLimit(
                                plan.value,
                                row.key,
                                event.target.value
                              )
                            }
                          />
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-2">
        <div>
          <h4 className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">审核策略</h4>
          <p className="text-xs text-muted-foreground">
            配置各套餐默认审核拦截等级和用户/API Key 可选择的最高等级。
          </p>
        </div>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="border-b border-border/60 text-[11px] uppercase tracking-widest text-muted-foreground">
              <tr>
                <th className="w-52 px-3 py-2 text-left font-medium">策略</th>
                {PLAN_OPTIONS.map((plan) => (
                  <th
                    key={plan.value}
                    className="w-36 px-3 py-2 text-left font-medium"
                  >
                    {plan.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {MODERATION_ROWS.map((row) => (
                <tr key={row.key}>
                  <td className="px-3 py-2">
                    <div className="font-medium">{row.label}</div>
                    <div className="text-xs text-muted-foreground">
                      {row.description}
                    </div>
                  </td>
                  {PLAN_OPTIONS.map((plan) => (
                    <td key={plan.value} className="px-3 py-2 align-top">
                      <MatrixSelect
                        value={matrix.moderation[plan.value][row.key]}
                        options={MODERATION_LEVEL_OPTIONS}
                        disabled={disabled}
                        onChange={(nextValue) =>
                          updateModeration(
                            plan.value,
                            row.key,
                            nextValue as ModerationLevelValue
                          )
                        }
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <details className="rounded-md border bg-muted/20 p-3">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
          查看当前 JSON 预览
        </summary>
        <Textarea
          value={preview}
          rows={12}
          readOnly
          className="mt-3 resize-y font-mono text-xs"
        />
      </details>
    </div>
  );
}

function CreditPackageMatrixInput({
  value,
  fallbackValue,
  disabled,
  onChange,
}: {
  value: DraftValue;
  fallbackValue: unknown;
  disabled: boolean;
  onChange: (value: DraftValue) => void;
}) {
  const matrix = useMemo(
    () => normalizeCreditPackageMatrixDraft(value, fallbackValue),
    [value, fallbackValue]
  );
  const compactMatrix = useMemo(
    () => compactCreditPackageMatrixDraft(matrix),
    [matrix]
  );
  const preview = useMemo(
    () => JSON.stringify(compactMatrix, null, 2),
    [compactMatrix]
  );

  const updateMatrix = (next: CreditPackageMatrixDraft) => {
    onChange(JSON.stringify(compactCreditPackageMatrixDraft(next), null, 2));
  };

  const updatePackage = (
    index: number,
    patch: Partial<CreditPackageDraft>
  ) => {
    updateMatrix({
      packages: matrix.packages.map((pkg, currentIndex) =>
        currentIndex === index ? { ...pkg, ...patch } : pkg
      ),
    });
  };

  const updatePlanPrice = (index: number, plan: PlanValue, price: string) => {
    const pkg = matrix.packages[index];
    if (!pkg) return;
    updatePackage(index, {
      pricesByPlan: {
        ...pkg.pricesByPlan,
        [plan]: Number(price),
      },
    });
  };

  const updatePlanCreemProductId = (
    index: number,
    plan: PlanValue,
    productId: string
  ) => {
    const pkg = matrix.packages[index];
    if (!pkg) return;
    updatePackage(index, {
      creemProductIdsByPlan: {
        ...pkg.creemProductIdsByPlan,
        [plan]: productId,
      },
    });
  };

  const addPackage = () => {
    let nextIndex = matrix.packages.length + 1;
    while (matrix.packages.some((pkg) => pkg.id === `custom_${nextIndex}`)) {
      nextIndex += 1;
    }
    const id = `custom_${nextIndex}`;
    updateMatrix({
      packages: [
        ...matrix.packages,
        {
          draftKey: `credit-package-${nextIndex}`,
          id,
          name: `Custom ${nextIndex}`,
          nameZh: `自定义积分包 ${nextIndex}`,
          description: "",
          descriptionZh: "",
          credits: 1000,
          price: 10,
          popular: false,
          visible: true,
          requiresPlan: "none",
          allowQuantity: false,
          maxQuantity: 1,
          creemProductId: "",
          pricesByPlan: Object.fromEntries(
            PLAN_OPTIONS.map((plan) => [plan.value, 10])
          ) as Record<PlanValue, number>,
          creemProductIdsByPlan: Object.fromEntries(
            PLAN_OPTIONS.map((plan) => [plan.value, ""])
          ) as Record<PlanValue, string>,
        },
      ],
    });
  };

  const removePackage = (index: number) => {
    updateMatrix({
      packages: matrix.packages.filter(
        (_, currentIndex) => currentIndex !== index
      ),
    });
  };

  return (
    <div className="space-y-5">
      <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        管理一次性购买积分包。Epay 使用站内价格；Creem 如需按套餐定价，需要在对应套餐列填写预建产品 ID。
      </div>

      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={addPackage}
        >
          <Plus className="mr-2 h-4 w-4" />
          新增积分包
        </Button>
      </div>

      {matrix.packages.map((pkg, index) => (
        <section
          key={pkg.draftKey}
          className="space-y-3 rounded-md border p-3"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h4 className="text-sm font-medium">
                {pkg.nameZh || pkg.name || pkg.id || "未命名积分包"}
              </h4>
              <p className="text-xs text-muted-foreground">
                ID: {pkg.id || "未填写"}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="icon"
              disabled={disabled}
              title="删除积分包"
              onClick={() => removePackage(index)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-widest text-muted-foreground">包 ID</Label>
              <Input
                value={pkg.id}
                disabled={disabled}
                onChange={(event) =>
                  updatePackage(index, { id: event.target.value })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-widest text-muted-foreground">显示名称（英文）</Label>
              <Input
                value={pkg.name}
                disabled={disabled}
                onChange={(event) =>
                  updatePackage(index, { name: event.target.value })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-widest text-muted-foreground">显示名称（中文）</Label>
              <Input
                value={pkg.nameZh}
                disabled={disabled}
                onChange={(event) =>
                  updatePackage(index, { nameZh: event.target.value })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-widest text-muted-foreground">积分数</Label>
              <Input
                type="number"
                min="1"
                step="1"
                value={String(pkg.credits)}
                disabled={disabled}
                onChange={(event) =>
                  updatePackage(index, { credits: Number(event.target.value) })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-widest text-muted-foreground">兜底价格</Label>
              <Input
                type="number"
                min="0.01"
                step="0.01"
                value={String(pkg.price)}
                disabled={disabled}
                onChange={(event) =>
                  updatePackage(index, { price: Number(event.target.value) })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-widest text-muted-foreground">最低可购买套餐</Label>
              <MatrixSelect
                value={pkg.requiresPlan}
                options={PLAN_REQUIREMENT_OPTIONS}
                disabled={disabled}
                onChange={(nextValue) =>
                  updatePackage(index, {
                    requiresPlan: nextValue as PlanRequirementValue,
                  })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-widest text-muted-foreground">最大购买数量</Label>
              <Input
                type="number"
                min="1"
                step="1"
                value={String(pkg.maxQuantity)}
                disabled={disabled || !pkg.allowQuantity}
                onChange={(event) =>
                  updatePackage(index, {
                    maxQuantity: Number(event.target.value),
                  })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-widest text-muted-foreground">Creem 兜底产品 ID</Label>
              <Input
                value={pkg.creemProductId}
                disabled={disabled}
                placeholder={`credits_${pkg.id || "package"}`}
                onChange={(event) =>
                  updatePackage(index, { creemProductId: event.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label className="text-[11px] uppercase tracking-widest text-muted-foreground">开关</Label>
              {/* Radix Switch 渲染为 button,biome 不识别包裹式 label,
                  用 htmlFor/id 显式关联(按 index 唯一化) */}
              <div className="flex flex-wrap gap-4 rounded-md border px-3 py-2">
                <label
                  htmlFor={`pkg-${index}-visible`}
                  className="flex items-center gap-2 text-sm"
                >
                  <Switch
                    id={`pkg-${index}-visible`}
                    checked={pkg.visible}
                    disabled={disabled}
                    onCheckedChange={(checked) =>
                      updatePackage(index, { visible: checked })
                    }
                  />
                  显示
                </label>
                <label
                  htmlFor={`pkg-${index}-popular`}
                  className="flex items-center gap-2 text-sm"
                >
                  <Switch
                    id={`pkg-${index}-popular`}
                    checked={pkg.popular}
                    disabled={disabled}
                    onCheckedChange={(checked) =>
                      updatePackage(index, { popular: checked })
                    }
                  />
                  推荐
                </label>
                <label
                  htmlFor={`pkg-${index}-allow-quantity`}
                  className="flex items-center gap-2 text-sm"
                >
                  <Switch
                    id={`pkg-${index}-allow-quantity`}
                    checked={pkg.allowQuantity}
                    disabled={disabled}
                    onCheckedChange={(checked) =>
                      updatePackage(index, {
                        allowQuantity: checked,
                        maxQuantity: checked ? pkg.maxQuantity : 1,
                      })
                    }
                  />
                  允许数量购买
                </label>
              </div>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-widest text-muted-foreground">说明（英文）</Label>
              <Textarea
                value={pkg.description}
                rows={2}
                disabled={disabled}
                className="resize-y"
                onChange={(event) =>
                  updatePackage(index, { description: event.target.value })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-widest text-muted-foreground">说明（中文）</Label>
              <Textarea
                value={pkg.descriptionZh}
                rows={2}
                disabled={disabled}
                className="resize-y"
                onChange={(event) =>
                  updatePackage(index, { descriptionZh: event.target.value })
                }
              />
            </div>
          </div>

          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="border-b border-border/60 text-[11px] uppercase tracking-widest text-muted-foreground">
                <tr>
                  <th className="w-40 px-3 py-2 text-left font-medium">套餐</th>
                  {PLAN_OPTIONS.map((plan) => (
                    <th
                      key={plan.value}
                      className="w-40 px-3 py-2 text-left font-medium"
                    >
                      {plan.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                <tr>
                  <td className="px-3 py-2 font-medium">价格</td>
                  {PLAN_OPTIONS.map((plan) => (
                    <td key={plan.value} className="px-3 py-2">
                      <Input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={String(pkg.pricesByPlan[plan.value])}
                        disabled={disabled}
                        className="h-9 min-w-28"
                        onChange={(event) =>
                          updatePlanPrice(index, plan.value, event.target.value)
                        }
                      />
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    <div className="font-medium">Creem 产品 ID</div>
                    <div className="text-xs text-muted-foreground">
                      Epay 可留空
                    </div>
                  </td>
                  {PLAN_OPTIONS.map((plan) => (
                    <td key={plan.value} className="px-3 py-2">
                      <Input
                        value={pkg.creemProductIdsByPlan[plan.value]}
                        disabled={disabled}
                        className="h-9 min-w-36"
                        placeholder="可选"
                        onChange={(event) =>
                          updatePlanCreemProductId(
                            index,
                            plan.value,
                            event.target.value
                          )
                        }
                      />
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      ))}

      <details className="rounded-md border bg-muted/20 p-3">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
          查看当前 JSON 预览
        </summary>
        <Textarea
          value={preview}
          rows={12}
          readOnly
          className="mt-3 resize-y font-mono text-xs"
        />
      </details>
    </div>
  );
}

export function SystemSettingsPanel() {
  const [settings, setSettings] = useState<SettingSnapshotItem[]>([]);
  const [drafts, setDrafts] = useState<Record<string, DraftValue>>({});
  const [clearKeys, setClearKeys] = useState<Record<string, boolean>>({});

  const {
    execute: loadSettings,
    result: settingsResult,
    isPending: isLoading,
  } = useAction(getSystemSettingsAction);
  const { execute: saveSettings, isPending: isSaving } = useAction(
    updateSystemSettingsAction,
    {
      onSuccess: ({ data }) => {
        if (data?.message) toast.success(data.message);
        loadSettings();
      },
      onError: ({ error }) => {
        toast.error(error.serverError || "系统设置保存失败");
      },
    }
  );
  const { execute: importEnvSettings, isPending: isImporting } = useAction(
    importSystemSettingsFromEnvAction,
    {
      onSuccess: ({ data }) => {
        if (data?.message) toast.success(data.message);
        loadSettings();
      },
      onError: ({ error }) => {
        toast.error(error.serverError || "导入环境变量失败");
      },
    }
  );
  const { execute: initializeDefaults, isPending: isInitializing } = useAction(
    initializeSystemSettingsDefaultsAction,
    {
      onSuccess: ({ data }) => {
        if (data?.message) toast.success(data.message);
        loadSettings();
      },
      onError: ({ error }) => {
        toast.error(error.serverError || "初始化默认配置失败");
      },
    }
  );

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    const loaded = (settingsResult.data?.settings ?? []) as SettingSnapshotItem[];
    if (!loaded.length) return;
    setSettings(loaded);
    setDrafts(
      Object.fromEntries(
        loaded.map((setting) => [setting.key, normalizeDraftValue(setting)])
      )
    );
    setClearKeys({});
  }, [settingsResult.data?.settings]);

  const settingsByCategory = useMemo(() => {
    const map = new Map<SettingCategory, SettingSnapshotItem[]>();
    for (const category of SETTING_CATEGORIES) {
      map.set(category.id, []);
    }
    for (const setting of settings) {
      // 模型计费倍率由 Adobe 后端 tab 的「模型计费倍率」表格编辑,系统设置面板里隐藏,
      // 避免同一份数据出现两个入口造成"重复倍率"的误解。
      if (
        setting.key === "IMAGE_MODEL_MULTIPLIERS" ||
        setting.key === "VIDEO_MODEL_MULTIPLIERS"
      ) {
        continue;
      }
      // 注册机相关配置（moemail、代理、IP 刷新、号池维持）统一在生图池后端的
      // 「注册机」tab 内编辑，系统设置面板里隐藏，避免双入口。
      if (setting.key.startsWith("CHATGPT_REGISTER_")) {
        continue;
      }
      map.get(setting.category)?.push(setting);
    }
    return map;
  }, [settings]);
  const configuredTimeZone =
    settings.find((setting) => setting.key === "APP_TIME_ZONE")?.value || "UTC";

  const handleSave = () => {
    const payload: SettingUpdate[] = [];
    try {
      for (const setting of settings) {
        // 见上:模型计费倍率不在本面板编辑,跳过,避免覆盖 Adobe tab 的改动。
        if (
          setting.key === "IMAGE_MODEL_MULTIPLIERS" ||
          setting.key === "VIDEO_MODEL_MULTIPLIERS"
        ) {
          continue;
        }
        if (clearKeys[setting.key]) {
          payload.push({ key: setting.key, clear: true });
          continue;
        }
        const value = drafts[setting.key];
        if (
          setting.secret &&
          typeof value === "string" &&
          value.trim() === ""
        ) {
          continue;
        }
        payload.push({
          key: setting.key,
          value: toSubmitValue(setting, value ?? ""),
        });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "配置格式错误");
      return;
    }

    if (payload.length === 0) {
      toast.info("没有需要保存的改动");
      return;
    }

    saveSettings({ settings: payload });
  };

  const updateDraft = (key: SettingKey, value: DraftValue) => {
    setDrafts((current) => ({ ...current, [key]: value }));
    setClearKeys((current) => ({ ...current, [key]: false }));
  };

  const markClear = (key: SettingKey) => {
    setDrafts((current) => ({ ...current, [key]: "" }));
    setClearKeys((current) => ({ ...current, [key]: true }));
  };

  const disabled = isLoading || isSaving || isImporting || isInitializing;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 animate-in fade-in slide-in-from-bottom-2 duration-400 motion-reduce:animate-none">
        <div>
          <h2 className="font-serif text-2xl font-medium tracking-tight">
            系统设置
          </h2>
          <p className="text-sm text-muted-foreground">
            管理审核、登录、支付、套餐、模型、存储和邮件等全局配置。密钥不会在页面回显。
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => initializeDefaults()}
            disabled={disabled}
          >
            {isInitializing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Database className="mr-2 h-4 w-4" />
            )}
            初始化默认配置
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => importEnvSettings({ overwrite: true })}
            disabled={disabled}
          >
            {isImporting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            导入当前环境变量
          </Button>
          <Button onClick={handleSave} disabled={disabled || settings.length === 0}>
            {isSaving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            保存设置
          </Button>
        </div>
      </div>

      {/* 提示条统一配方:rounded-md + bg-muted/30 + p-3(与 admin 面板同语言) */}
      <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
        已保存配置优先于环境变量；未保存时继续使用环境变量兜底。标记为“需重启”或“需重新构建”的配置，保存后要重启服务或重新部署后才完整生效。
      </div>

      <Tabs defaultValue={SETTING_CATEGORIES[0]?.id ?? "general"} className="w-full">
        {/* Tab 语言收敛到全站胶囊规格(TabsList 默认类) */}
        <TabsList className="h-auto flex-wrap justify-start">
          {SETTING_CATEGORIES.map((category) => (
            <TabsTrigger key={category.id} value={category.id}>
              {category.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {SETTING_CATEGORIES.map((category) => {
          const categorySettings = settingsByCategory.get(category.id) ?? [];
          return (
            <TabsContent
              key={category.id}
              value={category.id}
              className="mt-6 space-y-4"
            >
              <div>
                <h3 className="font-serif text-lg font-medium">
                  {category.label}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {category.description}
                </p>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                {categorySettings.map((setting) => (
                  <Card
                    key={setting.key}
                    className={
                      setting.key === "PLAN_CAPABILITY_MATRIX" ||
                      setting.key === "CREDIT_PACKAGE_MATRIX"
                        ? "rounded-lg lg:col-span-2"
                        : "rounded-lg"
                    }
                  >
                    <CardHeader className="space-y-2">
                      <div className="flex items-start justify-between gap-3">
                        <CardTitle className="text-base">
                          {setting.label}
                        </CardTitle>
                        <div className="flex flex-wrap justify-end gap-1">
                          {setting.secret && (
                            <Badge variant="secondary">密钥</Badge>
                          )}
                          {setting.stored ? (
                            <Badge>后台</Badge>
                          ) : setting.fromEnv ? (
                            <Badge variant="secondary">环境变量</Badge>
                          ) : (
                            <Badge variant="outline">未配置</Badge>
                          )}
                          {setting.requiresRestart && (
                            <Badge variant="outline">需重启</Badge>
                          )}
                          {setting.requiresRebuild && (
                            <Badge variant="outline">需重新构建</Badge>
                          )}
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {setting.description}
                      </p>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="space-y-2">
                        <Label
                          htmlFor={`setting-${setting.key}`}
                          className="text-[11px] uppercase tracking-widest text-muted-foreground"
                        >
                          {setting.key}
                        </Label>
                        <div className="flex items-center gap-2">
                          <div
                            id={`setting-${setting.key}`}
                            className="flex-1"
                          >
                            <SettingInput
                              setting={setting}
                              value={drafts[setting.key] ?? ""}
                              disabled={disabled}
                              onChange={(value) =>
                                updateDraft(setting.key, value)
                              }
                            />
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            disabled={disabled || !setting.configured}
                            title="清空后台配置"
                            onClick={() => markClear(setting.key)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                      {clearKeys[setting.key] && (
                        <p className="text-xs text-destructive">
                          保存后将清空此项的后台配置，环境变量兜底仍可能生效。
                        </p>
                      )}
                      {setting.valueType === "json" &&
                        setting.exampleValue !== undefined &&
                        !setting.configured && (
                          <p className="text-xs text-muted-foreground">
                            {getJsonSettingHint(setting.key)}
                          </p>
                        )}
                      {setting.updatedAt && (
                        <p className="text-xs text-muted-foreground">
                          最近更新:{" "}
                          {formatDateInTimeZone(
                            setting.updatedAt,
                            "zh",
                            {
                              year: "numeric",
                              month: "2-digit",
                              day: "2-digit",
                              hour: "2-digit",
                              minute: "2-digit",
                            },
                            configuredTimeZone
                          )}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            </TabsContent>
          );
        })}
      </Tabs>
    </div>
  );
}
