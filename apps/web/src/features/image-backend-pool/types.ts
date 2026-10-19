import type { SubscriptionPlan } from "@repo/shared/config/subscription-plan";

export type ImageBackendRequestKind =
  | "image_generation"
  | "image_edit"
  | "chat"
  | "responses";
export type ImageBackendAccountBackend = "web" | "responses";
export type ImageBackendGroupBackendType = "mixed" | "web" | "responses";
// 分组分辨率档位（存 metadata.sizeTier）："full"=全参(最高 3840x2160)；
// "standard"=仅约 1.2K(1248)。仅对非 Web 车道分组有意义，用于选组处展示，
// 不参与调度判定。
export type ImageBackendGroupSizeTier = "standard" | "full";
export type ImageBackendApiInterfaceMode = "images" | "responses" | "mixed";
export type ChatCompletionsUpstreamMode =
  | "responses"
  | "chat_completions"
  | "images";
export type ImagesUpstreamMode = "images" | "responses";
export type ImageBackendPreferenceMode = "always" | "mixed-only";
// 账号 plan 级别过滤(opt-in):"any"=不过滤(默认,主图像管线用);
// "paid"=仅 metadata.planType 为付费级(plus/pro/team/enterprise)的账号——
// 供 PPT/PSD 可编辑文件生成用(需代码解释器,免费账号不可用)。
export type ImageBackendAccountPlanFilter = "any" | "paid";
export type ImageBackendMemberType = "api" | "account";
export type ContentSafetyOverride = "inherit" | "enabled" | "disabled";

export type AdminImageBackendAccountStatusFilter =
  | "all"
  | "active"
  | "limited"
  | "error"
  | "disabled"
  | "cooling";

export type AdminImageBackendAccountListOptions = {
  page?: number;
  pageSize?: number;
  groupId?: string;
  implementationMode?: "all" | ImageBackendAccountBackend;
  status?: AdminImageBackendAccountStatusFilter;
  search?: string;
};

export type AdminImageBackendAccountSummary = {
  total: number;
  active: number;
  limited: number;
  cooling: number;
  error: number;
  disabled: number;
  quota: number;
};

export type ImageBackendGroupSummary = {
  id: string;
  name: string;
  description: string | null;
  isEnabled: boolean;
  isDefault: boolean;
  isUserSelectable: boolean;
  contentSafetyEnabled: boolean | null;
  backendType: ImageBackendGroupBackendType;
  sizeTier: ImageBackendGroupSizeTier;
  minPlan: SubscriptionPlan;
  billingMultiplier: number;
  childGroupIds: string[];
  priority: number;
  apiCount: number;
  accountCount: number;
};
