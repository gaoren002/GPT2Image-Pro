"use client";

import type { SubscriptionPlan } from "@repo/shared/config/subscription-plan";
import { formatDateInTimeZone } from "@repo/shared/time-zone";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { Checkbox } from "@repo/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/dialog";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import { Progress } from "@repo/ui/components/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select";
import { Switch } from "@repo/ui/components/switch";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/ui/components/tabs";
import { Textarea } from "@repo/ui/components/textarea";
import { cn } from "@repo/ui/utils";
import {
  Activity,
  Ban,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleOff,
  Database,
  ExternalLink,
  FolderTree,
  Infinity as InfinityIcon,
  Loader2,
  Pencil,
  Plug,
  RefreshCw,
  Search,
  Server,
  TimerReset,
  Trash2,
  UserRound,
} from "lucide-react";
import { useAction } from "next-safe-action/hooks";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

import {
  bulkDeleteImageBackendAccountsAction,
  bulkUpdateImageBackendAccountsAction,
  deleteAdobeAccountAction,
  deleteAllErrorImageBackendAccountsAction,
  deleteImageBackendGroupAction,
  deleteImageBackendMemberAction,
  deleteSub2ApiAutoSyncTaskAction,
  getAdminImageBackendAccountsAction,
  getAdminImageBackendPoolAction,
  getAdobeModelMultipliersAction,
  getSub2ApiAutoSyncTasksAction,
  getSub2ApiSourceGroupsAction,
  getSub2ApiSyncProgressAction,
  getSub2ApiSyncStatusAction,
  importAdobeAccountAction,
  importAdobeAccountsAction,
  importImageBackendAccountsFromRefreshTokensAction,
  importImageBackendWebAccountsFromAccessTokensAction,
  listAdobeAccountsAction,
  refreshImageBackendAccountInfoAction,
  refreshImageBackendAccountsInfoAction,
  runSub2ApiAutoSyncTaskNowAction,
  runSub2ApiManualSyncAction,
  saveImageBackendAccountAction,
  saveImageBackendAdobeAction,
  saveImageBackendApiAction,
  saveImageBackendGroupAction,
  setAdobeAccountEnabledAction,
  setAdobeModelMultipliersAction,
  setImageBackendAccountAlwaysActiveAction,
  setImageBackendAdobeAlwaysActiveAction,
  setImageBackendAdobeEnabledAction,
  setImageBackendApiAlwaysActiveAction,
  setImageBackendApiEnabledAction,
  setSub2ApiAutoSyncTaskEnabledAction,
  setSub2ApiAutoSyncTaskOverwriteLocalUnavailableStateAction,
  testImageBackendApiAction,
  updateSub2ApiAutoSyncTaskOptionsAction,
} from "./actions";
import { ChatgptRegisterTab } from "./chatgpt-register-tab";
import { parseImportTokensText } from "./import-token-parser";
import type {
  AdminImageBackendAccountSummary,
  ImageBackendApiInterfaceMode,
  ImageBackendGroupBackendType,
  ImagesUpstreamMode,
} from "./types";

type Group = {
  id: string;
  name: string;
  description: string | null;
  isEnabled: boolean;
  isDefault: boolean;
  isUserSelectable: boolean;
  contentSafetyEnabled: boolean | null;
  backendType: ImageBackendGroupBackendType;
  minPlan: SubscriptionPlan;
  billingMultiplier: number;
  childGroupIds: string[];
  priority: number;
  apiCount: number;
  accountCount: number;
};

type Account = {
  id: string;
  groupId: string | null;
  groupIds: string[];
  name: string;
  email: string | null;
  implementationMode: string;
  model: string | null;
  contentSafetyEnabled: boolean;
  isEnabled: boolean;
  alwaysActive: boolean;
  priority: number;
  concurrency: number;
  status: string;
  successCount: number;
  failCount: number;
  lastUsedAt: Date | string | null;
  cooldownUntil: Date | string | null;
  lastError: string | null;
  lastErrorAt: Date | string | null;
  metadata: {
    source?: string;
    sourceAccountId?: string;
    tokenSource?: string;
    webAccount?: {
      email?: string | null;
      userId?: string | null;
      type?: string;
      quota?: number;
      defaultModelSlug?: string | null;
      restoreAt?: string | null;
      status?: "active" | "limited";
      refreshedAt?: string;
    };
  } | null;
};

type Api = {
  id: string;
  groupId: string | null;
  groupIds: string[];
  name: string;
  baseUrl: string;
  model: string | null;
  interfaceMode: ImageBackendApiInterfaceMode;
  chatCompletionsUpstreamMode: ChatCompletionsUpstreamModeFormValue;
  imagesUpstreamMode: ImagesUpstreamModeFormValue;
  useStream: boolean;
  contentSafetyEnabled: boolean;
  isEnabled: boolean;
  alwaysActive: boolean;
  failureCooldownEnabled: boolean;
  priority: number;
  concurrency: number;
  adobeSourced: boolean;
  billingMultiplier: number;
  status: string;
  successCount: number;
  failCount: number;
  lastUsedAt: Date | string | null;
  cooldownUntil: Date | string | null;
  lastError: string | null;
  lastErrorAt: Date | string | null;
};

type Adobe = {
  id: string;
  groupId: string | null;
  groupIds: string[];
  name: string;
  mode: "gateway" | "direct";
  baseUrl: string;
  enabledModels: string[] | null;
  defaultRatio: string;
  defaultResolution: string;
  gptImageQuality: string;
  // list 接口把 numeric 列回传为字符串。
  billingMultiplier: number | string;
  supportsVideo: boolean;
  contentSafetyEnabled: boolean;
  isEnabled: boolean;
  alwaysActive: boolean;
  failureCooldownEnabled: boolean;
  priority: number;
  concurrency: number;
  status: string;
  successCount: number;
  failCount: number;
  lastUsedAt: Date | string | null;
  cooldownUntil: Date | string | null;
  lastError: string | null;
  lastErrorAt: Date | string | null;
};

type AdobeAccountRow = {
  id: string;
  name: string;
  displayName: string | null;
  email: string | null;
  isEnabled: boolean;
  status: string;
  lastRefreshAt: Date | string | null;
  lastRefreshError: string | null;
  consecutiveFailures: number;
  creditsTotal: number | null;
  creditsUsed: number | null;
  creditsAvailable: number | null;
  creditsUpdatedAt: Date | string | null;
  creditsError: string | null;
};

type ContentSafetyFormValue = "inherit" | "enabled" | "disabled";
type AccountBackendFormValue = "web" | "responses";
type GroupBackendTypeFormValue = ImageBackendGroupBackendType;
type ApiInterfaceModeFormValue = ImageBackendApiInterfaceMode;
type ChatCompletionsUpstreamModeFormValue =
  | "responses"
  | "chat_completions"
  | "images";
type ImagesUpstreamModeFormValue = ImagesUpstreamMode;
type TokenSyncMode = "web" | "responses" | "both";
type Sub2ApiPlanFilter = "all" | "free" | "plus" | "pro" | "non_free";

type Sub2ApiSourceGroup = {
  id: string;
  name: string;
  platform: string | null;
  accountCount: number;
};

type Sub2ApiAutoSyncTask = {
  id: string;
  enabled: boolean;
  sourceGroupId: string | null;
  sourceGroupName?: string | null;
  webGroupId?: string | null;
  responsesGroupId?: string | null;
  syncMode: TokenSyncMode;
  allowMobileRtImport: boolean;
  contentSafetyEnabled: boolean;
  overwriteLocalUnavailableState: boolean;
  planFilter: Sub2ApiPlanFilter;
  intervalMinutes: number;
  createdAt?: string;
  updatedAt?: string;
  lastRunAt?: string;
  managedAccountCount: number;
  lastResult?: {
    sourceCount: number;
    totalSourceCount: number;
    syncedCount: number;
    skipped: { web: number; responses: number };
    failed: number;
    failedByMode: { web: number; responses: number };
    syncedByMode: { web: number; responses: number };
    deletedCount: number;
  };
};

type BackendPoolTab =
  | "groups"
  | "accounts"
  | "apis"
  | "adobe"
  | "import"
  | "register";

type SyncProgressState = {
  status: "idle" | "running" | "success" | "error";
  value: number;
  message: string;
};

const MANUAL_TOKEN_IMPORT_LIMIT = 10_000;
const MANUAL_RT_IMPORT_BATCH_SIZE = 50;

// Adobe per-model 计费倍率：图像/视频两套模型族行（与后端 family 枚举一一对应）。
const ADOBE_IMAGE_MULTIPLIER_FAMILIES = [
  "gpt-image-2",
  "gpt-image-1.5",
  "nano-banana",
  "nano-banana2",
  "nano-banana-pro",
] as const;
const ADOBE_VIDEO_MULTIPLIER_FAMILIES = [
  "sora2",
  "sora2-pro",
  "veo31",
  "veo31-ref",
  "veo31-fast",
  "kling-o3",
  "kling3",
] as const;

/** 把 family→倍率 的 map 转成"输入框字符串"草稿；缺省/非正显示为空（即默认 1）。 */
function multipliersToDraft(
  families: readonly string[],
  map: Record<string, number>
): Record<string, string> {
  const draft: Record<string, string> = {};
  for (const family of families) {
    const value = map[family];
    draft[family] =
      typeof value === "number" && Number.isFinite(value) && value > 0
        ? String(value)
        : "";
  }
  return draft;
}

/** 把"输入框字符串"草稿收窄回 family→正数 的 map；空白/非正/非法项不写入（回退默认 1）。 */
function draftToMultipliers(
  draft: Record<string, string>
): Record<string, number> {
  const map: Record<string, number> = {};
  for (const [family, raw] of Object.entries(draft)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric > 0) map[family] = numeric;
  }
  return map;
}

type BulkAccountForm = {
  selectionGroupId: string;
  selectionMode: "all" | AccountBackendFormValue;
  statusFilter: "all" | "active" | "limited" | "error" | "disabled" | "cooling";
  search: string;
  pageSize: number;
  setGroup: boolean;
  groupId: string;
  setMode: boolean;
  implementationMode: AccountBackendFormValue;
  setEnabled: boolean;
  isEnabled: boolean;
  setContentSafety: boolean;
  contentSafetyEnabled: boolean;
  setPriority: boolean;
  priority: number;
  setConcurrency: boolean;
  concurrency: number;
  deleteSelected: boolean;
};

const PLAN_OPTIONS: Array<{ value: SubscriptionPlan; label: string }> = [
  { value: "free", label: "不限门槛" },
  { value: "starter", label: "入门版" },
  { value: "pro", label: "专业版" },
  { value: "ultra", label: "旗舰版" },
  { value: "enterprise", label: "企业版" },
];

const GROUP_BACKEND_TYPE_OPTIONS: Array<{
  value: GroupBackendTypeFormValue;
  label: string;
  detail: string;
}> = [
  {
    value: "mixed",
    label: "混合",
    detail: "Web 与 Codex/Responses 账号均可调度，参数全部显示。",
  },
  {
    value: "web",
    label: "仅 Web",
    detail: "只调度 Web 账号，界面隐藏 Codex/Responses 独有参数。",
  },
  {
    value: "responses",
    label: "仅 Codex/Responses",
    detail: "只调度 Codex/Responses 账号，界面隐藏 Web 独有提示。",
  },
];

const API_INTERFACE_MODE_OPTIONS: Array<{
  value: ApiInterfaceModeFormValue;
  label: string;
  detail: string;
}> = [
  {
    value: "mixed",
    label: "混合 API",
    detail:
      "该上游同时支持 /images/* 和 /responses；具体使用哪个由下方两个上游开关决定。",
  },
  {
    value: "images",
    label: "仅 Images",
    detail: "只用于文生图和图生图，调用 /v1/images/generations 或 /edits。",
  },
  {
    value: "responses",
    label: "仅 Responses",
    detail:
      "该上游只支持 /responses；可承接 Chat/Agent/Responses，也可在下方开启 Images 转 Responses。",
  },
];

const IMAGES_UPSTREAM_MODE_OPTIONS: Array<{
  value: ImagesUpstreamModeFormValue;
  label: string;
  detail: string;
}> = [
  {
    value: "images",
    label: "原生 Images",
    detail:
      "命中文生图/图生图时请求上游 /images/generations 或 /images/edits。默认推荐。",
  },
  {
    value: "responses",
    label: "转换为 Responses",
    detail:
      "命中文生图/图生图时转换为上游 /responses + image_generation tool，适合只提供 Responses 的上游。",
  },
];

const CHAT_COMPLETIONS_UPSTREAM_MODE_OPTIONS: Array<{
  value: ChatCompletionsUpstreamModeFormValue;
  label: string;
  detail: string;
}> = [
  {
    value: "responses",
    label: "Responses 生图模式",
    detail:
      "命中该上游时，本站 /v1/chat/completions 会请求它的 /responses + image_generation tool，保留生图能力。默认推荐。",
  },
  {
    value: "chat_completions",
    label: "原生 Chat Completions",
    detail:
      "命中该上游时，本站 /v1/chat/completions 会请求它的 /chat/completions；适合纯聊天兼容，是否能返回图片取决于上游。",
  },
  {
    value: "images",
    label: "原生 Images",
    detail:
      "命中该上游时，本站 /v1/chat/completions 会转换为 /images/generations 或 /images/edits；适合只提供生图接口的上游，不支持多轮对话。",
  },
];

const ACCOUNT_STATUS_FILTER_OPTIONS: Array<{
  value: BulkAccountForm["statusFilter"];
  label: string;
}> = [
  { value: "all", label: "全部状态" },
  { value: "active", label: "可用" },
  { value: "limited", label: "限流" },
  { value: "error", label: "错误" },
  { value: "disabled", label: "停用" },
  { value: "cooling", label: "冷却中" },
];

// 指标卡配色走语义 token：可用=success，限流/冷却=warning（暂时降级），错误=destructive，
// 停用=muted；总数与额度为中性 foreground，不再使用花色。
const ACCOUNT_METRIC_CARDS = [
  {
    key: "total",
    label: "账号总数",
    color: "text-foreground",
    icon: UserRound,
  },
  {
    key: "active",
    label: "可用账号",
    color: "text-success",
    icon: CheckCircle2,
  },
  {
    key: "limited",
    label: "限流账号",
    color: "text-warning",
    icon: CircleAlert,
  },
  {
    key: "cooling",
    label: "冷却中账号",
    color: "text-warning",
    icon: TimerReset,
  },
  {
    key: "error",
    label: "错误账号",
    color: "text-destructive",
    icon: CircleOff,
  },
  {
    key: "disabled",
    label: "停用账号",
    color: "text-muted-foreground",
    icon: Ban,
  },
  {
    key: "quota",
    label: "Web 剩余额度",
    color: "text-foreground",
    icon: RefreshCw,
  },
] as const;

function groupName(groups: Group[], groupId: string | null) {
  return groups.find((group) => group.id === groupId)?.name || "未分组";
}

function normalizeAccountGroupIds(groupIds?: string[] | null) {
  return Array.from(
    new Set((groupIds || []).map((groupId) => groupId.trim()).filter(Boolean))
  );
}

function accountGroupIds(account: Account) {
  const groupIds = normalizeAccountGroupIds(account.groupIds);
  if (groupIds.length) return groupIds;
  return account.groupId ? [account.groupId] : [];
}

function apiGroupIds(api: Api) {
  const groupIds = normalizeAccountGroupIds(api.groupIds);
  if (groupIds.length) return groupIds;
  return api.groupId ? [api.groupId] : [];
}

function groupNames(groups: Group[], groupIds: string[]) {
  const normalized = normalizeAccountGroupIds(groupIds);
  if (!normalized.length) return "未分组";
  return normalized.map((groupId) => groupName(groups, groupId)).join("、");
}

function planLabel(plan: SubscriptionPlan) {
  return PLAN_OPTIONS.find((option) => option.value === plan)?.label || plan;
}

function safetyLabel(value: boolean | null) {
  if (value === true) return "内容安全强制开启";
  if (value === false) return "内容安全强制关闭";
  return "内容安全继承成员";
}

function groupBackendTypeLabel(value: ImageBackendGroupBackendType) {
  if (value === "web") return "仅 Web";
  if (value === "responses") return "仅 Codex";
  return "混合";
}

function apiInterfaceModeLabel(value: ImageBackendApiInterfaceMode) {
  return (
    API_INTERFACE_MODE_OPTIONS.find((option) => option.value === value)
      ?.label || "仅 Images"
  );
}

function childGroupNames(groups: Group[], childGroupIds: string[]) {
  if (!childGroupIds.length) return "无子分组";
  return childGroupIds
    .map(
      (childGroupId) =>
        groups.find((group) => group.id === childGroupId)?.name || childGroupId
    )
    .join("、");
}

function formatDate(value: Date | string | null, timeZone?: string) {
  if (!value) return "从未使用";
  return formatDateInTimeZone(
    value,
    "zh",
    {
      dateStyle: "medium",
      timeStyle: "short",
    },
    timeZone
  );
}

function formatOptionalDate(value: Date | string | null, timeZone?: string) {
  if (!value) return "无";
  return formatDate(value, timeZone);
}

function isCoolingDown(value: Date | string | null) {
  return value ? new Date(value).getTime() > Date.now() : false;
}

// 后端成员状态 Badge 配色（纯展示）：active=success、limited=warning、error=destructive，
// 其余中性。outline 边框 + 语义色文字，替代花色底块。
function backendStatusBadgeClass(status: string) {
  if (status === "active") return "border-success/40 text-success";
  if (status === "limited") return "border-warning/40 text-warning";
  if (status === "error") return "border-destructive/40 text-destructive";
  return "";
}

function ApiOperationalStatusBadge({ api }: { api: Api }) {
  const cooling = api.isEnabled && isCoolingDown(api.cooldownUntil);
  const effectiveStatus = !api.isEnabled
    ? "disabled"
    : cooling
      ? "limited"
      : api.status;
  const label = !api.isEnabled
    ? "已停用"
    : cooling
      ? "冷却中"
      : api.status === "active"
        ? "可用"
        : api.status === "limited"
          ? "受限"
          : api.status === "error"
            ? "错误"
            : api.status;

  return (
    <Badge
      variant={api.isEnabled ? "outline" : "secondary"}
      className={backendStatusBadgeClass(effectiveStatus)}
    >
      {api.isEnabled &&
        (effectiveStatus === "active" || effectiveStatus === "limited") && (
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none"
          />
        )}
      {label}
    </Badge>
  );
}

function formatCooldown(value: Date | string | null, timeZone?: string) {
  if (!value) return "无";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "无";

  const remainingMs = date.getTime() - Date.now();
  if (remainingMs <= 0) return `${formatDate(value, timeZone)} · 已到期`;

  const totalMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days}天`);
  if (hours) parts.push(`${hours}小时`);
  if (minutes || !parts.length) parts.push(`${minutes}分钟`);

  return `${formatDate(value, timeZone)} · 剩余 ${parts.slice(0, 2).join("")}`;
}

function formatCompactNumber(value: number) {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

function getWebAccountInfo(account: Account) {
  return account.implementationMode === "web"
    ? account.metadata?.webAccount
    : undefined;
}

function formatWebQuota(account: Account) {
  const info = getWebAccountInfo(account);
  if (!info) return "未刷新";
  return String(Math.max(0, Number(info.quota || 0)));
}

function formatWebStatus(account: Account) {
  const info = getWebAccountInfo(account);
  if (!info) return null;
  return info.status === "limited" ? "额度受限" : "额度正常";
}

function safetyValue(value: boolean | null): ContentSafetyFormValue {
  if (value === true) return "enabled";
  if (value === false) return "disabled";
  return "inherit";
}

function normalizeBackendFormValue(value: string): AccountBackendFormValue {
  return value === "responses" ? "responses" : "web";
}

function accountSourceLabel(account: Account) {
  const source = account.metadata?.source;
  if (source === "sub2api_postgres") return "Sub2API";
  if (source === "manual_refresh_token") return "手工 RT";
  if (
    source === "manual_web_access_token" ||
    source === "manual_auth_session_access_token"
  ) {
    return "Web AT";
  }
  return "本站";
}

function isSub2ApiAccount(account: Account | undefined) {
  return account?.metadata?.source === "sub2api_postgres";
}

function formatModeStats(
  label: string,
  stats: { synced: number; skipped: number; failed: number }
) {
  return `${label} 写入 ${stats.synced}，跳过 ${stats.skipped}，失败 ${stats.failed}`;
}

function tokenSyncModeLabel(value: TokenSyncMode) {
  if (value === "both") return "Web + Codex";
  if (value === "web") return "Web";
  return "Codex/Responses";
}

function sub2ApiPlanFilterLabel(value: Sub2ApiPlanFilter) {
  if (value === "non_free") return "排除 free";
  if (value === "plus") return "plus";
  if (value === "pro") return "pro";
  if (value === "free") return "free";
  return "全部套餐";
}

export function ImageBackendPoolAdminPanel({
  readOnly = false,
  timeZone,
}: {
  readOnly?: boolean;
  timeZone?: string;
}) {
  const [activeTab, setActiveTab] = useState<BackendPoolTab>(
    readOnly ? "accounts" : "groups"
  );
  const [groups, setGroups] = useState<Group[]>([]);
  const [sub2ApiSourceGroups, setSub2ApiSourceGroups] = useState<
    Sub2ApiSourceGroup[]
  >([]);
  const [sub2ApiSyncTasks, setSub2ApiSyncTasks] = useState<
    Sub2ApiAutoSyncTask[]
  >([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountSummary, setAccountSummary] =
    useState<AdminImageBackendAccountSummary>({
      total: 0,
      active: 0,
      limited: 0,
      cooling: 0,
      error: 0,
      disabled: 0,
      quota: 0,
    });
  const [accountTotal, setAccountTotal] = useState(0);
  const [accountTotalPages, setAccountTotalPages] = useState(1);
  const accountRequestKeyRef = useRef<string | null>(null);
  const loadedAccountQueryKeyRef = useRef<string | null>(null);
  const [apis, setApis] = useState<Api[]>([]);
  const [adobes, setAdobes] = useState<Adobe[]>([]);
  const [groupForm, setGroupForm] = useState({
    id: "",
    name: "",
    description: "",
    isEnabled: true,
    isDefault: false,
    isUserSelectable: true,
    contentSafety: "inherit" as ContentSafetyFormValue,
    backendType: "mixed" as GroupBackendTypeFormValue,
    minPlan: "free" as SubscriptionPlan,
    billingMultiplier: 1,
    childGroupIds: [] as string[],
    priority: 50,
  });
  const [accountForm, setAccountForm] = useState({
    id: "",
    groupId: "default",
    groupIds: [] as string[],
    name: "",
    email: "",
    accessToken: "",
    refreshToken: "",
    implementationMode: "web" as AccountBackendFormValue,
    model: "",
    contentSafetyEnabled: true,
    isEnabled: true,
    alwaysActive: false,
    priority: 50,
    concurrency: 1,
  });
  const [apiForm, setApiForm] = useState({
    id: "",
    groupId: "default",
    groupIds: [] as string[],
    name: "",
    baseUrl: "",
    apiKey: "",
    model: "",
    interfaceMode: "mixed" as ApiInterfaceModeFormValue,
    chatCompletionsUpstreamMode:
      "responses" as ChatCompletionsUpstreamModeFormValue,
    imagesUpstreamMode: "images" as ImagesUpstreamModeFormValue,
    useStream: false,
    contentSafetyEnabled: true,
    isEnabled: true,
    alwaysActive: false,
    failureCooldownEnabled: false,
    priority: 50,
    concurrency: 10,
    // Adobe 来源：上游实为 Adobe 的 gpt 格式 api（计费吃成员倍率 + 进 firefly 候选）。
    adobeSourced: false,
    // 成员计费倍率（仅 adobeSourced 时生效），字符串便于输入框编辑。
    billingMultiplier: "1",
  });
  const [adobeForm, setAdobeForm] = useState({
    id: "",
    groupId: "default",
    groupIds: [] as string[],
    name: "",
    mode: "gateway" as "gateway" | "direct",
    baseUrl: "",
    apiKey: "",
    // 逗号分隔的 Firefly 模型家族（如 gpt-image,nano-banana-pro）；空=不限制。
    enabledModels: "",
    defaultRatio: "1x1",
    defaultResolution: "2k",
    gptImageQuality: "high" as "low" | "medium" | "high",
    billingMultiplier: "1",
    supportsVideo: false,
    contentSafetyEnabled: true,
    isEnabled: true,
    alwaysActive: false,
    failureCooldownEnabled: false,
    priority: 50,
    concurrency: 10,
  });
  const [bulkAccountForm, setBulkAccountForm] = useState<BulkAccountForm>({
    selectionGroupId: "all",
    selectionMode: "all" as "all" | AccountBackendFormValue,
    statusFilter: "all",
    search: "",
    pageSize: 20,
    setGroup: false,
    groupId: "default",
    setMode: false,
    implementationMode: "responses" as AccountBackendFormValue,
    setEnabled: false,
    isEnabled: true,
    setContentSafety: false,
    contentSafetyEnabled: true,
    setPriority: false,
    priority: 50,
    setConcurrency: false,
    concurrency: 1,
    deleteSelected: false,
  } satisfies BulkAccountForm);
  const [manualImportForm, setManualImportForm] = useState({
    refreshTokensText: "",
    webGroupId: "default",
    responsesGroupId: "default",
    syncMode: "responses" as TokenSyncMode,
    useMobileRt: false,
    namePrefix: "手工导入",
    model: "",
    contentSafetyEnabled: true,
    priority: 50,
    concurrency: 1,
  });
  const [webAtImportForm, setWebAtImportForm] = useState({
    accessTokensText: "",
    webGroupId: "default",
    namePrefix: "Web AT 导入",
    model: "",
    contentSafetyEnabled: true,
    priority: 50,
    concurrency: 1,
  });
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [accountPage, setAccountPage] = useState(1);
  const [isManualImportOpen, setIsManualImportOpen] = useState(false);
  const [isWebAtImportOpen, setIsWebAtImportOpen] = useState(false);
  const [sub2ApiConfigured, setSub2ApiConfigured] = useState<boolean | null>(
    null
  );
  const [importForm, setImportForm] = useState({
    sourceGroupId: "default",
    webGroupId: "default",
    responsesGroupId: "default",
    syncMode: "responses" as TokenSyncMode,
    allowMobileRtImport: false,
    planFilter: "non_free" as Sub2ApiPlanFilter,
    createSyncTask: true,
    contentSafetyEnabled: true,
    overwriteLocalUnavailableState: true,
    intervalMinutes: 720,
    limit: 100,
  });
  const [editingSyncTask, setEditingSyncTask] =
    useState<Sub2ApiAutoSyncTask | null>(null);
  const [syncTaskForm, setSyncTaskForm] = useState({
    taskId: "",
    enabled: true,
    webGroupId: "default",
    responsesGroupId: "default",
    syncMode: "responses" as TokenSyncMode,
    allowMobileRtImport: false,
    planFilter: "non_free" as Sub2ApiPlanFilter,
    contentSafetyEnabled: true,
    overwriteLocalUnavailableState: true,
    intervalMinutes: 720,
  });
  const [runningSub2ApiSyncTaskId, setRunningSub2ApiSyncTaskId] = useState<
    string | null
  >(null);
  const [syncProgress, setSyncProgress] = useState<SyncProgressState>({
    status: "idle",
    value: 0,
    message: "等待开始同步",
  });
  const [manualImportProgress, setManualImportProgress] =
    useState<SyncProgressState>({
      status: "idle",
      value: 0,
      message: "等待开始导入",
    });
  const [isImportingManualRefreshTokens, setIsImportingManualRefreshTokens] =
    useState(false);

  const groupOptions = useMemo(
    () => [
      { id: "default", name: "未分组" },
      ...groups.map((group) => ({ id: group.id, name: group.name })),
    ],
    [groups]
  );
  const childGroupOptions = useMemo(
    () =>
      groups.filter(
        (group) =>
          group.backendType !== "mixed" &&
          group.id !== groupForm.id &&
          !(group.childGroupIds || []).length
      ),
    [groups, groupForm.id]
  );
  const selectedAccountIdSet = useMemo(
    () => new Set(selectedAccountIds),
    [selectedAccountIds]
  );
  const selectedAccounts = useMemo(
    () => accounts.filter((account) => selectedAccountIdSet.has(account.id)),
    [accounts, selectedAccountIdSet]
  );
  const deferredSearch = useDeferredValue(bulkAccountForm.search);
  const accountPageSize = Math.max(10, bulkAccountForm.pageSize || 20);
  const accountFilterKey = [
    bulkAccountForm.selectionGroupId,
    bulkAccountForm.selectionMode,
    bulkAccountForm.statusFilter,
    deferredSearch,
    bulkAccountForm.pageSize,
  ].join("|");
  const previousAccountFilterKeyRef = useRef(accountFilterKey);
  const accountQuery = useMemo(
    () => ({
      page: accountPage,
      pageSize: accountPageSize,
      groupId: bulkAccountForm.selectionGroupId,
      implementationMode: bulkAccountForm.selectionMode,
      status: bulkAccountForm.statusFilter,
      search: deferredSearch.trim(),
    }),
    [
      accountPage,
      accountPageSize,
      bulkAccountForm.selectionGroupId,
      bulkAccountForm.selectionMode,
      bulkAccountForm.statusFilter,
      deferredSearch,
    ]
  );
  const accountQueryKey = JSON.stringify(accountQuery);
  const pagedAccounts = accounts;
  const safeAccountPage = accountPage;
  const pagedAccountIds = pagedAccounts.map((account) => account.id);
  const selectedSub2ApiAccountCount = selectedAccounts.filter((account) =>
    isSub2ApiAccount(account)
  ).length;
  const selectedManualAccountCount =
    selectedAccounts.length - selectedSub2ApiAccountCount;
  const selectedAccountCount = selectedAccountIds.length;
  const selectedWebAccountIds = useMemo(
    () =>
      selectedAccounts
        .filter((account) => account.implementationMode === "web")
        .map((account) => account.id),
    [selectedAccounts]
  );
  const currentPageWebAccountIds = useMemo(
    () =>
      accounts
        .filter((account) => account.implementationMode === "web")
        .map((account) => account.id),
    [accounts]
  );
  const allAccountsSelected =
    pagedAccountIds.length > 0 &&
    pagedAccountIds.every((id) => selectedAccountIdSet.has(id));
  const hasBulkAccountOperation =
    bulkAccountForm.setGroup ||
    bulkAccountForm.setMode ||
    bulkAccountForm.setEnabled ||
    bulkAccountForm.setContentSafety ||
    bulkAccountForm.setPriority ||
    bulkAccountForm.setConcurrency ||
    bulkAccountForm.deleteSelected;
  const editingAccount = accountForm.id
    ? accounts.find((account) => account.id === accountForm.id)
    : undefined;
  const editingSub2ApiAccount = isSub2ApiAccount(editingAccount);
  const effectiveImportSyncMode = importForm.allowMobileRtImport
    ? importForm.syncMode
    : ("responses" as TokenSyncMode);
  const effectiveManualImportSyncMode = manualImportForm.useMobileRt
    ? manualImportForm.syncMode
    : ("responses" as TokenSyncMode);
  const isSub2ApiSyncUnavailable = sub2ApiConfigured !== true;
  const sub2ApiUnavailableMessage =
    sub2ApiConfigured === false
      ? "未配置 SUB2API_POSTGRES_URL，不能同步 Sub2API 账号。"
      : "正在检查 Sub2API 连接配置。";
  const authSessionUrl = "https://chatgpt.com/api/auth/session";

  const resetGroupForm = () =>
    setGroupForm({
      id: "",
      name: "",
      description: "",
      isEnabled: true,
      isDefault: false,
      isUserSelectable: true,
      contentSafety: "inherit" as ContentSafetyFormValue,
      backendType: "mixed" as GroupBackendTypeFormValue,
      minPlan: "free" as SubscriptionPlan,
      billingMultiplier: 1,
      childGroupIds: [] as string[],
      priority: 50,
    });

  const resetAccountForm = () =>
    setAccountForm({
      id: "",
      groupId: "default",
      groupIds: [],
      name: "",
      email: "",
      accessToken: "",
      refreshToken: "",
      implementationMode: "web" as AccountBackendFormValue,
      model: "",
      contentSafetyEnabled: true,
      isEnabled: true,
      alwaysActive: false,
      priority: 50,
      concurrency: 1,
    });

  const resetApiForm = () =>
    setApiForm({
      id: "",
      groupId: "default",
      groupIds: [],
      name: "",
      baseUrl: "",
      apiKey: "",
      model: "",
      interfaceMode: "mixed" as ApiInterfaceModeFormValue,
      chatCompletionsUpstreamMode:
        "responses" as ChatCompletionsUpstreamModeFormValue,
      imagesUpstreamMode: "images" as ImagesUpstreamModeFormValue,
      useStream: false,
      contentSafetyEnabled: true,
      isEnabled: true,
      alwaysActive: false,
      failureCooldownEnabled: false,
      priority: 50,
      concurrency: 10,
      adobeSourced: false,
      billingMultiplier: "1",
    });

  const resetManualImportForm = () => {
    setManualImportForm({
      refreshTokensText: "",
      webGroupId: "default",
      responsesGroupId: "default",
      syncMode: "responses" as TokenSyncMode,
      useMobileRt: false,
      namePrefix: "手工导入",
      model: "",
      contentSafetyEnabled: true,
      priority: 50,
      concurrency: 1,
    });
    setManualImportProgress({
      status: "idle",
      value: 0,
      message: "等待开始导入",
    });
  };

  const resetWebAtImportForm = () =>
    setWebAtImportForm({
      accessTokensText: "",
      webGroupId: "default",
      namePrefix: "Web AT 导入",
      model: "",
      contentSafetyEnabled: true,
      priority: 50,
      concurrency: 1,
    });

  const openSyncTaskEditor = (task: Sub2ApiAutoSyncTask) => {
    setEditingSyncTask(task);
    setSyncTaskForm({
      taskId: task.id,
      enabled: task.enabled,
      webGroupId: task.webGroupId || "default",
      responsesGroupId: task.responsesGroupId || "default",
      syncMode: task.allowMobileRtImport ? task.syncMode : "responses",
      allowMobileRtImport: task.allowMobileRtImport,
      planFilter: task.planFilter,
      contentSafetyEnabled: task.contentSafetyEnabled,
      overwriteLocalUnavailableState: task.overwriteLocalUnavailableState,
      intervalMinutes: task.intervalMinutes || 720,
    });
  };

  const editGroup = (group: Group) => {
    setGroupForm({
      id: group.id,
      name: group.name,
      description: group.description || "",
      isEnabled: group.isEnabled,
      isDefault: group.isDefault,
      isUserSelectable: group.isUserSelectable,
      contentSafety: safetyValue(group.contentSafetyEnabled),
      backendType: group.backendType || "mixed",
      minPlan: group.minPlan || "free",
      billingMultiplier: group.billingMultiplier || 1,
      childGroupIds: group.childGroupIds || [],
      priority: group.priority,
    });
  };

  const editAccount = (account: Account) => {
    const selectedGroupIds = accountGroupIds(account);
    setAccountForm({
      id: account.id,
      groupId: selectedGroupIds[0] || "default",
      groupIds: selectedGroupIds,
      name: account.name,
      email: account.email || "",
      accessToken: "",
      refreshToken: "",
      implementationMode: normalizeBackendFormValue(account.implementationMode),
      model: account.model || "",
      contentSafetyEnabled: account.contentSafetyEnabled,
      isEnabled: account.isEnabled,
      alwaysActive: account.alwaysActive,
      priority: account.priority,
      concurrency: account.concurrency,
    });
  };

  const toggleAccountFormGroup = (groupId: string, checked: boolean) => {
    setAccountForm((current) => {
      const currentGroupIds = normalizeAccountGroupIds(current.groupIds);
      const nextGroupIds = checked
        ? normalizeAccountGroupIds([...currentGroupIds, groupId])
        : currentGroupIds.filter((id) => id !== groupId);
      return {
        ...current,
        groupIds: nextGroupIds,
        groupId: nextGroupIds[0] || "default",
      };
    });
  };

  const toggleApiFormGroup = (groupId: string, checked: boolean) => {
    setApiForm((current) => {
      const currentGroupIds = normalizeAccountGroupIds(current.groupIds);
      const nextGroupIds = checked
        ? normalizeAccountGroupIds([...currentGroupIds, groupId])
        : currentGroupIds.filter((id) => id !== groupId);
      return {
        ...current,
        groupIds: nextGroupIds,
        groupId: nextGroupIds[0] || "default",
      };
    });
  };

  const toggleAccountSelection = (accountId: string, checked: boolean) => {
    setSelectedAccountIds((current) =>
      checked
        ? Array.from(new Set([...current, accountId]))
        : current.filter((id) => id !== accountId)
    );
  };

  const toggleAllAccounts = (checked: boolean) => {
    setSelectedAccountIds((current) => {
      if (checked) return Array.from(new Set([...current, ...pagedAccountIds]));
      const pageIdSet = new Set(pagedAccountIds);
      return current.filter((id) => !pageIdSet.has(id));
    });
  };

  const editApi = (api: Api) => {
    const selectedGroupIds = apiGroupIds(api);
    setApiForm({
      id: api.id,
      groupId: selectedGroupIds[0] || "default",
      groupIds: selectedGroupIds,
      name: api.name,
      baseUrl: api.baseUrl,
      apiKey: "",
      model: api.model || "",
      interfaceMode: api.interfaceMode || "images",
      chatCompletionsUpstreamMode:
        api.chatCompletionsUpstreamMode || "responses",
      imagesUpstreamMode: api.imagesUpstreamMode || "images",
      useStream: api.useStream,
      contentSafetyEnabled: api.contentSafetyEnabled,
      isEnabled: api.isEnabled,
      alwaysActive: api.alwaysActive,
      failureCooldownEnabled: api.failureCooldownEnabled,
      priority: api.priority,
      concurrency: api.concurrency,
      adobeSourced: api.adobeSourced ?? false,
      billingMultiplier: String(api.billingMultiplier ?? "1"),
    });
  };

  const resetAdobeForm = () =>
    setAdobeForm({
      id: "",
      groupId: "default",
      groupIds: [],
      name: "",
      mode: "gateway",
      baseUrl: "",
      apiKey: "",
      enabledModels: "",
      defaultRatio: "1x1",
      defaultResolution: "2k",
      gptImageQuality: "high",
      billingMultiplier: "1",
      supportsVideo: false,
      contentSafetyEnabled: true,
      isEnabled: true,
      alwaysActive: false,
      failureCooldownEnabled: false,
      priority: 50,
      concurrency: 10,
    });

  const toggleAdobeFormGroup = (groupId: string, checked: boolean) => {
    setAdobeForm((current) => {
      const currentGroupIds = normalizeAccountGroupIds(current.groupIds);
      const nextGroupIds = checked
        ? normalizeAccountGroupIds([...currentGroupIds, groupId])
        : currentGroupIds.filter((id) => id !== groupId);
      return {
        ...current,
        groupIds: nextGroupIds,
        groupId: nextGroupIds[0] || "default",
      };
    });
  };

  const editAdobe = (adobe: Adobe) => {
    const selectedGroupIds = normalizeAccountGroupIds(adobe.groupIds);
    setAdobeForm({
      id: adobe.id,
      groupId: selectedGroupIds[0] || "default",
      groupIds: selectedGroupIds,
      name: adobe.name,
      mode: adobe.mode === "direct" ? "direct" : "gateway",
      baseUrl: adobe.baseUrl,
      apiKey: "",
      enabledModels: (adobe.enabledModels || []).join(","),
      defaultRatio: adobe.defaultRatio || "1x1",
      defaultResolution: adobe.defaultResolution || "2k",
      gptImageQuality:
        (adobe.gptImageQuality as "low" | "medium" | "high") || "high",
      billingMultiplier: String(adobe.billingMultiplier ?? "1"),
      supportsVideo: adobe.supportsVideo,
      contentSafetyEnabled: adobe.contentSafetyEnabled,
      isEnabled: adobe.isEnabled,
      alwaysActive: adobe.alwaysActive,
      failureCooldownEnabled: adobe.failureCooldownEnabled,
      priority: adobe.priority,
      concurrency: adobe.concurrency,
    });
    // 编辑表单是内联卡片(非弹窗),点击后滚动到它,避免"点了没反应"的观感。
    if (typeof document !== "undefined") {
      document
        .getElementById("adobe-backend-form")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const { execute: loadPool, isPending: isLoading } = useAction(
    getAdminImageBackendPoolAction,
    {
      onSuccess: ({ data }) => {
        setGroups((data?.groups || []) as Group[]);
        setApis((data?.apis || []) as Api[]);
        setAdobes((data?.adobes || []) as Adobe[]);
      },
      onError: ({ error }) =>
        toast.error(error.serverError || "加载生图后端池失败"),
    }
  );

  const { executeAsync: loadAccounts, isPending: isLoadingAccounts } =
    useAction(getAdminImageBackendAccountsAction);

  const requestAccountPage = useCallback(async () => {
    const requestKey = accountQueryKey;
    accountRequestKeyRef.current = requestKey;
    const result = await loadAccounts(accountQuery);
    if (accountRequestKeyRef.current !== requestKey) return;
    const data = result?.data;
    if (!data) {
      toast.error(result?.serverError || "加载账号列表失败");
      return;
    }

    const nextAccounts = (data.accounts || []) as Account[];
    setAccounts(nextAccounts);
    setAccountPage(data.accountPage.page);
    setAccountTotal(data.accountPage.total);
    setAccountTotalPages(data.accountPage.totalPages);
    setAccountSummary(data.accountSummary);
    setSelectedAccountIds((current) => {
      const availableIds = new Set(nextAccounts.map((account) => account.id));
      return current.filter((id) => availableIds.has(id));
    });
    loadedAccountQueryKeyRef.current = requestKey;
  }, [accountQuery, accountQueryKey, loadAccounts]);

  const reload = () => {
    loadPool();
    if (activeTab === "accounts") {
      loadedAccountQueryKeyRef.current = null;
      void requestAccountPage();
    }
  };

  const { execute: loadSub2ApiSyncStatus } = useAction(
    getSub2ApiSyncStatusAction,
    {
      onSuccess: ({ data }) => {
        const configured = Boolean(data?.configured);
        setSub2ApiConfigured(configured);
        if (!configured) {
          setSub2ApiSourceGroups([]);
        }
      },
      onError: () => setSub2ApiConfigured(false),
    }
  );

  const { execute: loadSub2ApiSourceGroups, isPending: isLoadingSourceGroups } =
    useAction(getSub2ApiSourceGroupsAction, {
      onSuccess: ({ data }) => {
        setSub2ApiSourceGroups((data?.groups || []) as Sub2ApiSourceGroup[]);
        setSub2ApiConfigured(true);
      },
      onError: ({ error }) => {
        const message = error.serverError || "加载 Sub2API 来源分组失败";
        if (message.includes("SUB2API_POSTGRES_URL")) {
          setSub2ApiConfigured(false);
          setSub2ApiSourceGroups([]);
          return;
        }
        toast.error(message);
      },
    });

  const { execute: loadSub2ApiSyncTasks, isPending: isLoadingSyncTasks } =
    useAction(getSub2ApiAutoSyncTasksAction, {
      onSuccess: ({ data }) => {
        setSub2ApiSyncTasks((data?.tasks || []) as Sub2ApiAutoSyncTask[]);
      },
      onError: ({ error }) =>
        toast.error(error.serverError || "加载 Sub2API 自动同步任务失败"),
    });

  const { execute: saveGroup, isPending: isSavingGroup } = useAction(
    saveImageBackendGroupAction,
    {
      onSuccess: () => {
        toast.success("分组已保存");
        resetGroupForm();
        reload();
      },
      onError: ({ error }) => toast.error(error.serverError || "保存分组失败"),
    }
  );

  const { execute: saveAccount, isPending: isSavingAccount } = useAction(
    saveImageBackendAccountAction,
    {
      onSuccess: () => {
        toast.success("账号已保存");
        resetAccountForm();
        reload();
      },
      onError: ({ error }) => toast.error(error.serverError || "保存账号失败"),
    }
  );

  const { execute: bulkUpdateAccounts, isPending: isBulkUpdatingAccounts } =
    useAction(bulkUpdateImageBackendAccountsAction, {
      onSuccess: ({ data }) => {
        toast.success(
          `批量操作完成：成功 ${data?.updatedCount || 0} 个，失败 ${
            data?.failedCount || 0
          } 个`
        );
        setSelectedAccountIds([]);
        reload();
      },
      onError: ({ error }) =>
        toast.error(error.serverError || "批量操作账号失败"),
    });

  const { execute: bulkDeleteAccounts, isPending: isBulkDeletingAccounts } =
    useAction(bulkDeleteImageBackendAccountsAction, {
      onSuccess: ({ data }) => {
        toast.success(`已删除 ${data?.deletedCount || 0} 个账号`);
        setSelectedAccountIds([]);
        reload();
      },
      onError: ({ error }) =>
        toast.error(error.serverError || "批量删除账号失败"),
    });

  const {
    execute: deleteAllErrorAccounts,
    isPending: isDeletingAllErrorAccounts,
  } = useAction(deleteAllErrorImageBackendAccountsAction, {
    onSuccess: ({ data }) => {
      toast.success(`已移除 ${data?.deletedCount || 0} 个错误账号`);
      setSelectedAccountIds([]);
      reload();
    },
    onError: ({ error }) =>
      toast.error(error.serverError || "移除错误账号失败"),
  });

  const { executeAsync: importManualRefreshTokensBatch } = useAction(
    importImageBackendAccountsFromRefreshTokensAction
  );

  const {
    execute: importWebAccessTokens,
    isPending: isImportingWebAccessTokens,
  } = useAction(importImageBackendWebAccountsFromAccessTokensAction, {
    onSuccess: ({ data }) => {
      const sourceCount = data?.sourceCount || 0;
      const synced = data?.syncedCount || 0;
      const failed = data?.failed || 0;
      // 一个都没解析出来:只显示诊断信息(rt_ 误粘/非 JWT 等),不追加"写入0/失败0"
      // 以免误导成写库失败;红色提示,且保留弹窗与已粘内容方便修正。
      if (sourceCount === 0) {
        toast.error(data?.message || "未识别到可导入的 Web AT");
        return;
      }
      const note = data?.message ? `${data.message} ` : "";
      const firstError = (data as { firstError?: string } | undefined)
        ?.firstError;
      const detail = `识别 ${sourceCount} 个，写入 ${synced} 个，失败 ${failed} 个${
        failed && firstError ? `；首个错误：${firstError}` : ""
      }`;
      // 解析出了但全部写入失败:同样红色提示、保留弹窗。
      if (synced === 0) {
        toast.error(`${note}${detail}`);
        return;
      }
      toast.success(`${note}${detail}`);
      setIsWebAtImportOpen(false);
      resetWebAtImportForm();
      reload();
    },
    onError: ({ error }) =>
      toast.error(error.serverError || "导入 Web AT 失败"),
  });

  const { execute: saveApi, isPending: isSavingApi } = useAction(
    saveImageBackendApiAction,
    {
      onSuccess: () => {
        toast.success("API 后端已保存");
        resetApiForm();
        reload();
      },
      onError: ({ error }) =>
        toast.error(error.serverError || "保存 API 后端失败"),
    }
  );

  const { execute: setApiEnabled, isPending: isSettingApiEnabled } = useAction(
    setImageBackendApiEnabledAction,
    {
      onSuccess: () => {
        toast.success("API 后端状态已更新");
        reload();
      },
      onError: ({ error }) =>
        toast.error(error.serverError || "更新 API 后端状态失败"),
    }
  );

  const { execute: setApiAlwaysActive, isPending: isSettingApiAlwaysActive } =
    useAction(setImageBackendApiAlwaysActiveAction, {
      onSuccess: () => {
        toast.success("已更新「遇错仍可用」设置");
        reload();
      },
      onError: ({ error }) =>
        toast.error(error.serverError || "更新「遇错仍可用」失败"),
    });

  const { execute: saveAdobe, isPending: isSavingAdobe } = useAction(
    saveImageBackendAdobeAction,
    {
      onSuccess: () => {
        toast.success("Adobe 后端已保存");
        resetAdobeForm();
        reload();
      },
      onError: ({ error }) =>
        toast.error(error.serverError || "保存 Adobe 后端失败"),
    }
  );

  const { execute: setAdobeEnabled, isPending: isSettingAdobeEnabled } =
    useAction(setImageBackendAdobeEnabledAction, {
      onSuccess: () => {
        toast.success("Adobe 后端状态已更新");
        reload();
      },
      onError: ({ error }) =>
        toast.error(error.serverError || "更新 Adobe 后端状态失败"),
    });

  const {
    execute: setAdobeAlwaysActive,
    isPending: isSettingAdobeAlwaysActive,
  } = useAction(setImageBackendAdobeAlwaysActiveAction, {
    onSuccess: () => {
      toast.success("已更新「遇错仍可用」设置");
      reload();
    },
    onError: ({ error }) =>
      toast.error(error.serverError || "更新「遇错仍可用」失败"),
  });

  // ===== Adobe 直连账号（mode=direct）=====
  const [adobeAccounts, setAdobeAccounts] = useState<AdobeAccountRow[]>([]);
  const [adobeCookieInput, setAdobeCookieInput] = useState("");

  // ===== Adobe 模型计费倍率（图像/视频 per-model）=====
  // 草稿态用字符串保存输入框原始值（含空白），保存时再收窄成 family→正数 的 map。
  const [imageMultiplierDraft, setImageMultiplierDraft] = useState<
    Record<string, string>
  >(() => multipliersToDraft(ADOBE_IMAGE_MULTIPLIER_FAMILIES, {}));
  const [videoMultiplierDraft, setVideoMultiplierDraft] = useState<
    Record<string, string>
  >(() => multipliersToDraft(ADOBE_VIDEO_MULTIPLIER_FAMILIES, {}));

  const { execute: loadModelMultipliers } = useAction(
    getAdobeModelMultipliersAction,
    {
      onSuccess: ({ data }) => {
        setImageMultiplierDraft(
          multipliersToDraft(
            ADOBE_IMAGE_MULTIPLIER_FAMILIES,
            data?.image ?? {}
          )
        );
        setVideoMultiplierDraft(
          multipliersToDraft(
            ADOBE_VIDEO_MULTIPLIER_FAMILIES,
            data?.video ?? {}
          )
        );
      },
      onError: ({ error }) =>
        toast.error(error.serverError || "加载模型计费倍率失败"),
    }
  );

  const { execute: saveModelMultipliers, isPending: isSavingMultipliers } =
    useAction(setAdobeModelMultipliersAction, {
      onSuccess: () => {
        toast.success("模型计费倍率已保存");
        loadModelMultipliers();
      },
      onError: ({ error }) =>
        toast.error(error.serverError || "保存模型计费倍率失败"),
    });
  const [adobeAccountName, setAdobeAccountName] = useState("");

  const { execute: loadAdobeAccounts } = useAction(listAdobeAccountsAction, {
    onSuccess: ({ data }) =>
      setAdobeAccounts((data?.accounts || []) as AdobeAccountRow[]),
    onError: ({ error }) =>
      toast.error(error.serverError || "加载 Adobe 账号失败"),
  });

  const { execute: importAdobeAccountExec, isPending: isImportingAdobeAccount } =
    useAction(importAdobeAccountAction, {
      onSuccess: () => {
        toast.success("Adobe 账号已导入并验证");
        setAdobeCookieInput("");
        setAdobeAccountName("");
        if (adobeForm.id) loadAdobeAccounts({ adobeId: adobeForm.id });
      },
      onError: ({ error }) =>
        toast.error(error.serverError || "导入 Adobe 账号失败"),
    });

  const [adobeBatchSummary, setAdobeBatchSummary] = useState("");
  const {
    execute: importAdobeAccountsExec,
    isPending: isImportingAdobeAccounts,
  } = useAction(importAdobeAccountsAction, {
    onSuccess: ({ data }) => {
      const result = data?.result;
      if (!result) return;
      const summary = `共 ${result.total}：导入 ${result.imported}，跳过 ${result.skipped}，失败 ${result.failed}${
        result.failed && result.firstError
          ? `；首个错误：${result.firstError}`
          : ""
      }`;
      setAdobeBatchSummary(summary);
      // 有失败则保留文本便于修正后重试（已导入项会按身份自动跳过）；全部成功才清空。
      if (result.failed > 0) {
        toast.error(summary);
      } else {
        toast.success(summary);
        setAdobeCookieInput("");
        setAdobeAccountName("");
      }
      if (adobeForm.id) loadAdobeAccounts({ adobeId: adobeForm.id });
    },
    onError: ({ error }) =>
      toast.error(error.serverError || "批量导入 Adobe 账号失败"),
  });

  const { execute: deleteAdobeAccountExec } = useAction(
    deleteAdobeAccountAction,
    {
      onSuccess: () => {
        toast.success("账号已删除");
        if (adobeForm.id) loadAdobeAccounts({ adobeId: adobeForm.id });
      },
      onError: ({ error }) => toast.error(error.serverError || "删除账号失败"),
    }
  );

  const { execute: setAdobeAccountEnabledExec } = useAction(
    setAdobeAccountEnabledAction,
    {
      onSuccess: () => {
        if (adobeForm.id) loadAdobeAccounts({ adobeId: adobeForm.id });
      },
      onError: ({ error }) =>
        toast.error(error.serverError || "更新账号状态失败"),
    }
  );

  useEffect(() => {
    if (adobeForm.id && adobeForm.mode === "direct") {
      loadAdobeAccounts({ adobeId: adobeForm.id });
    } else {
      setAdobeAccounts([]);
    }
    // loadAdobeAccounts 来自 useAction，引用稳定。
  }, [adobeForm.id, adobeForm.mode, loadAdobeAccounts]);

  const {
    execute: setAccountAlwaysActive,
    isPending: isSettingAccountAlwaysActive,
  } = useAction(setImageBackendAccountAlwaysActiveAction, {
    onSuccess: () => {
      toast.success("已更新「遇错仍可用」设置");
      reload();
    },
    onError: ({ error }) =>
      toast.error(error.serverError || "更新「遇错仍可用」失败"),
  });

  // 测活：记录正在测试的成员 id，仅该行显示加载态；结果按状态提示并刷新列表。
  const [testingApiId, setTestingApiId] = useState<string | null>(null);
  const { execute: testApi } = useAction(testImageBackendApiAction, {
    onSuccess: ({ data }) => {
      setTestingApiId(null);
      const result = data?.result;
      const name = data?.name ?? "";
      if (result?.ok) {
        toast.success(
          `测活成功：${name} 真实返回了图片（${result.latencyMs}ms）`
        );
      } else {
        const detail =
          result?.status === "no_image"
            ? "连接成功但未返回图片（可能模型不支持出图）"
            : result?.status === "auth_failed"
              ? "密钥被拒绝"
              : result?.status === "unreachable"
                ? "无法连接或超时"
                : "出图失败";
        toast.error(`测活失败：${name} ${detail}`);
      }
      reload();
    },
    onError: ({ error }) => {
      setTestingApiId(null);
      toast.error(error.serverError || "测活失败");
    },
  });

  const { executeAsync: runSub2ApiManualSync } = useAction(
    runSub2ApiManualSyncAction
  );
  const { executeAsync: fetchSub2ApiSyncProgress } = useAction(
    getSub2ApiSyncProgressAction
  );
  const [isSyncingSub2Api, setIsSyncingSub2Api] = useState(false);

  const {
    execute: runSub2ApiAutoSyncTaskNow,
    isPending: isRunningSub2ApiSyncTask,
  } = useAction(runSub2ApiAutoSyncTaskNowAction, {
    onSuccess: ({ data }) => {
      toast.success(
        `立即同步完成：写入 ${data?.syncedCount || 0} 个，失败 ${
          data?.failed || 0
        } 个${data?.deletedCount ? `，删除 ${data.deletedCount} 个` : ""}`
      );
      setRunningSub2ApiSyncTaskId(null);
      loadSub2ApiSyncTasks();
      reload();
    },
    onError: ({ error }) => {
      setRunningSub2ApiSyncTaskId(null);
      toast.error(error.serverError || "立即运行自动同步任务失败");
    },
  });

  const { execute: setSub2ApiTaskEnabled, isPending: isUpdatingSyncTask } =
    useAction(setSub2ApiAutoSyncTaskEnabledAction, {
      onSuccess: () => {
        toast.success("自动同步任务已更新");
        loadSub2ApiSyncTasks();
      },
      onError: ({ error }) =>
        toast.error(error.serverError || "更新自动同步任务失败"),
    });

  const {
    execute: setSub2ApiTaskOverwriteLocalUnavailableState,
    isPending: isUpdatingSyncTaskOverwrite,
  } = useAction(setSub2ApiAutoSyncTaskOverwriteLocalUnavailableStateAction, {
    onSuccess: () => {
      toast.success("自动同步任务已更新");
      loadSub2ApiSyncTasks();
    },
    onError: ({ error }) =>
      toast.error(error.serverError || "更新自动同步任务失败"),
  });

  const { execute: updateSub2ApiSyncTask, isPending: isSavingSyncTask } =
    useAction(updateSub2ApiAutoSyncTaskOptionsAction, {
      onSuccess: () => {
        toast.success("自动同步任务已保存");
        setEditingSyncTask(null);
        loadSub2ApiSyncTasks();
      },
      onError: ({ error }) =>
        toast.error(error.serverError || "保存自动同步任务失败"),
    });

  const { execute: deleteSub2ApiTask, isPending: isDeletingSyncTask } =
    useAction(deleteSub2ApiAutoSyncTaskAction, {
      onSuccess: () => {
        toast.success("自动同步任务已删除");
        loadSub2ApiSyncTasks();
      },
      onError: ({ error }) =>
        toast.error(error.serverError || "删除自动同步任务失败"),
    });

  const { execute: deleteGroup, isPending: isDeletingGroup } = useAction(
    deleteImageBackendGroupAction,
    {
      onSuccess: () => {
        toast.success("分组已删除");
        reload();
      },
      onError: ({ error }) => toast.error(error.serverError || "删除分组失败"),
    }
  );

  const { execute: deleteMember, isPending: isDeletingMember } = useAction(
    deleteImageBackendMemberAction,
    {
      onSuccess: () => {
        toast.success("后端已删除");
        reload();
      },
      onError: ({ error }) => toast.error(error.serverError || "删除后端失败"),
    }
  );

  const { execute: refreshAccountInfo, isPending: isRefreshingAccount } =
    useAction(refreshImageBackendAccountInfoAction, {
      onSuccess: ({ data }) => {
        const quota = String(data?.info?.quota ?? 0);
        toast.success(`账号信息已刷新，图片额度 ${quota}`);
        reload();
      },
      onError: ({ error }) =>
        toast.error(error.serverError || "刷新账号远端信息失败"),
    });

  const { execute: refreshAccountsInfo, isPending: isRefreshingAccounts } =
    useAction(refreshImageBackendAccountsInfoAction, {
      onSuccess: ({ data }) => {
        const firstError = data?.errors?.[0]?.error;
        const message = `刷新完成：成功 ${data?.refreshedCount || 0} 个，跳过 ${
          data?.skippedCount || 0
        } 个，失败 ${data?.failedCount || 0} 个`;
        if (data?.failedCount) {
          toast.error(
            firstError ? `${message}；首个错误：${firstError}` : message
          );
        } else {
          toast.success(message);
        }
        reload();
      },
      onError: ({ error }) =>
        toast.error(error.serverError || "批量刷新账号远端信息失败"),
    });

  const runManualRefreshTokenImport = async () => {
    if (isImportingManualRefreshTokens) return;

    const parsedTokens = parseImportTokensText(
      manualImportForm.refreshTokensText,
      { plainFallback: "refresh" }
    );
    const parsedCount = parsedTokens.refreshTokens.length;
    const refreshTokens = parsedTokens.refreshTokens.slice(
      0,
      MANUAL_TOKEN_IMPORT_LIMIT
    );

    if (!refreshTokens.length) {
      toast.error(
        "未提取到可导入的 RT。请粘贴 RT 列表，或包含 refresh_token/refreshToken 的 Auth Session。"
      );
      return;
    }

    const importBatchId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `manual-rt-${Date.now()}`;
    const batchSize = MANUAL_RT_IMPORT_BATCH_SIZE;
    const totalBatches = Math.ceil(refreshTokens.length / batchSize);
    let syncedCount = 0;
    let failedCount = 0;
    let rotatedCount = 0;
    const synced = { web: 0, responses: 0 };
    const skipped = { web: 0, responses: 0 };
    const failed = { web: 0, responses: 0 };

    setIsImportingManualRefreshTokens(true);
    setManualImportProgress({
      status: "running",
      value: 1,
      message: `准备导入 ${refreshTokens.length}/${parsedCount} 个 RT`,
    });

    try {
      for (let offset = 0; offset < refreshTokens.length; offset += batchSize) {
        const batchIndex = Math.floor(offset / batchSize) + 1;
        const batch = refreshTokens.slice(offset, offset + batchSize);
        setManualImportProgress({
          status: "running",
          value: Math.max(1, Math.round((offset / refreshTokens.length) * 100)),
          message: `正在导入第 ${batchIndex}/${totalBatches} 批，已处理 ${offset}/${refreshTokens.length}`,
        });

        const result = await importManualRefreshTokensBatch({
          ...manualImportForm,
          refreshTokensText: batch.join("\n"),
          syncMode: effectiveManualImportSyncMode,
          importBatchId,
          startIndex: offset,
        });

        if (result?.serverError) {
          throw new Error(result.serverError);
        }
        if (!result?.data?.success) {
          throw new Error("手工 RT 导入失败");
        }

        const data = result.data;
        syncedCount += data.syncedCount || 0;
        failedCount += data.failed || 0;
        rotatedCount += data.refreshTokenRotatedCount || 0;
        synced.web += data.syncedByMode?.web || 0;
        synced.responses += data.syncedByMode?.responses || 0;
        skipped.web += data.skipped?.web || 0;
        skipped.responses += data.skipped?.responses || 0;
        failed.web += data.failedByMode?.web || 0;
        failed.responses += data.failedByMode?.responses || 0;

        const processed = Math.min(offset + batch.length, refreshTokens.length);
        setManualImportProgress({
          status: "running",
          value: Math.min(
            99,
            Math.round((processed / refreshTokens.length) * 100)
          ),
          message: `已处理 ${processed}/${refreshTokens.length}；写入 ${syncedCount}，失败 ${failedCount}`,
        });
      }

      const skippedCount = skipped.web + skipped.responses;
      const truncatedText =
        parsedCount > refreshTokens.length
          ? `；超过 ${MANUAL_TOKEN_IMPORT_LIMIT} 的 ${parsedCount - refreshTokens.length} 个已跳过`
          : "";
      setManualImportProgress({
        status: "success",
        value: 100,
        message: `完成：写入 ${syncedCount}，跳过 ${skippedCount}，失败 ${failedCount}${truncatedText}`,
      });
      toast.success(
        `RT 导入完成：提取 ${parsedCount} 个，写入 ${syncedCount} 个，跳过 ${skippedCount} 个，失败 ${failedCount} 个，刷新 RT ${rotatedCount} 个${truncatedText}`
      );
      setIsManualImportOpen(false);
      resetManualImportForm();
      reload();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "手工 RT 导入失败";
      setManualImportProgress({
        status: "error",
        value: 100,
        message,
      });
      toast.error(message);
    } finally {
      setIsImportingManualRefreshTokens(false);
    }
  };

  const runSub2ApiSync = async () => {
    if (isSyncingSub2Api) return;
    if (sub2ApiConfigured === false) {
      toast.error("未配置 SUB2API_POSTGRES_URL，不能同步 Sub2API 账号");
      return;
    }
    setIsSyncingSub2Api(true);

    setSyncProgress({
      status: "running",
      value: 5,
      message: "正在按任务配置全量同步 Sub2API 账号",
    });

    // 渐进动画兜底:全量同步是单次后端调用(后端还做 cleanup/建任务等原子操作,不宜
    // 客户端分批),没有真实进度时进度条平滑爬向 ~90% 表示"在跑",完成跳 100%。
    const syncStartedAt = Date.now();
    let progressTimer: ReturnType<typeof setInterval> | null = setInterval(
      () => {
        setSyncProgress((prev) =>
          prev.status === "running" && prev.value < 90
            ? {
                ...prev,
                value: Math.min(
                  90,
                  prev.value + Math.max(1, Math.round((90 - prev.value) / 12))
                ),
              }
            : prev
        );
      },
      700
    );
    // 真实进度:轮询服务端进程内进度槽(逐账号),拿到就覆盖动画、显示真实百分比与计数。
    // startedAt 用于过滤上一次同步的残留进度。轮询取不到(如打到别的实例)时退回动画。
    let pollTimer: ReturnType<typeof setInterval> | null = setInterval(
      async () => {
        try {
          const res = await fetchSub2ApiSyncProgress();
          const p = res?.data?.progress;
          if (p && p.total > 0 && p.startedAt >= syncStartedAt - 3000) {
            const pct = Math.min(95, Math.round((p.processed / p.total) * 95));
            setSyncProgress((prev) =>
              prev.status === "running"
                ? {
                    ...prev,
                    value: Math.max(prev.value, pct),
                    message: `正在同步账号 ${p.processed}/${p.total}`,
                  }
                : prev
            );
          }
        } catch {
          // 轮询失败忽略,继续用动画兜底。
        }
      },
      900
    );
    const stopSyncProgressTimer = () => {
      if (progressTimer) {
        clearInterval(progressTimer);
        progressTimer = null;
      }
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    try {
      const sourceGroupName =
        sub2ApiSourceGroups.find(
          (group) => group.id === importForm.sourceGroupId
        )?.name || undefined;
      const result = await runSub2ApiManualSync({
        sourceGroupId: importForm.sourceGroupId,
        sourceGroupName,
        webGroupId: importForm.webGroupId,
        responsesGroupId: importForm.responsesGroupId,
        syncMode: effectiveImportSyncMode,
        allowMobileRtImport: importForm.allowMobileRtImport,
        planFilter: importForm.planFilter,
        createSyncTask: importForm.createSyncTask,
        contentSafetyEnabled: importForm.contentSafetyEnabled,
        overwriteLocalUnavailableState:
          importForm.overwriteLocalUnavailableState,
        intervalMinutes: importForm.intervalMinutes,
        limit: importForm.limit,
      });

      if (result?.serverError) {
        throw new Error(result.serverError);
      }
      if (!result?.data?.success) {
        throw new Error("从 Sub2API 同步账号失败");
      }

      const data = result.data;
      const skippedCount =
        (data.skipped?.web || 0) + (data.skipped?.responses || 0);
      const codexText = formatModeStats("Codex", {
        synced: data.syncedByMode?.responses || 0,
        skipped: data.skipped?.responses || 0,
        failed: data.failedByMode?.responses || 0,
      });
      const webText = formatModeStats("Web", {
        synced: data.syncedByMode?.web || 0,
        skipped: data.skipped?.web || 0,
        failed: data.failedByMode?.web || 0,
      });
      const sourceText =
        data.sourceCount === data.totalSourceCount
          ? `${data.sourceCount}`
          : `${data.sourceCount}/${data.totalSourceCount}`;

      setSyncProgress({
        status: "success",
        value: 100,
        message: `完成：来源账号 ${sourceText} 个；${codexText}；${webText}${
          data.deletedCount ? `；删除 ${data.deletedCount}` : ""
        }`,
      });
      toast.success(
        `同步完成：写入 ${data.syncedCount || 0} 个，跳过 ${skippedCount} 个，失败 ${
          data.failed || 0
        } 个${data.deletedCount ? `，删除 ${data.deletedCount} 个` : ""}`
      );
      loadSub2ApiSyncTasks();
      reload();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "从 Sub2API 同步账号失败";
      setSyncProgress({
        status: "error",
        value: 100,
        message,
      });
      toast.error(message);
    } finally {
      stopSyncProgressTimer();
      setIsSyncingSub2Api(false);
    }
  };

  const runBulkAccountOperation = () => {
    if (!selectedAccountIds.length) {
      toast.error("请先选择账号");
      return;
    }
    if (!hasBulkAccountOperation) {
      toast.error("请选择至少一个批量操作");
      return;
    }
    if (
      bulkAccountForm.deleteSelected &&
      !window.confirm(
        `确定删除 ${selectedAccountIds.length} 个账号？这只会删除本站后端池记录，不会删除 Sub2API 源库账号。`
      )
    ) {
      return;
    }
    if (bulkAccountForm.setMode && selectedSub2ApiAccountCount > 0) {
      toast.error("Sub2API 同步账号不能在本站批量切换 Web/Responses");
      return;
    }
    if (bulkAccountForm.deleteSelected) {
      bulkDeleteAccounts({ accountIds: selectedAccountIds });
      return;
    }

    bulkUpdateAccounts({
      accountIds: selectedAccountIds,
      ...(bulkAccountForm.setGroup ? { groupId: bulkAccountForm.groupId } : {}),
      ...(bulkAccountForm.setMode
        ? { implementationMode: bulkAccountForm.implementationMode }
        : {}),
      ...(bulkAccountForm.setEnabled
        ? { isEnabled: bulkAccountForm.isEnabled }
        : {}),
      ...(bulkAccountForm.setContentSafety
        ? { contentSafetyEnabled: bulkAccountForm.contentSafetyEnabled }
        : {}),
      ...(bulkAccountForm.setPriority
        ? { priority: bulkAccountForm.priority }
        : {}),
      ...(bulkAccountForm.setConcurrency
        ? { concurrency: bulkAccountForm.concurrency }
        : {}),
    });
  };

  const runResetSelectedAccounts = () => {
    if (!selectedAccountIds.length) {
      toast.error("请先选择账号");
      return;
    }
    bulkUpdateAccounts({
      accountIds: selectedAccountIds,
      resetAvailability: true,
    });
  };

  const runBulkRefreshAccountInfo = (
    accountIds: string[],
    emptyMessage: string
  ) => {
    if (!accountIds.length) {
      toast.error(emptyMessage);
      return;
    }
    refreshAccountsInfo({ accountIds });
  };

  const runDeleteErrorAccounts = () => {
    if (
      !window.confirm(
        "确定移除当前分组、接口和搜索条件下的所有错误账号（包括其他分页）？这只会删除本站后端池记录，不会删除 Sub2API 源库账号。"
      )
    ) {
      return;
    }
    deleteAllErrorAccounts({
      groupId: bulkAccountForm.selectionGroupId,
      implementationMode: bulkAccountForm.selectionMode,
      search: deferredSearch.trim(),
    });
  };

  const runDeleteSub2ApiSyncTask = (task: Sub2ApiAutoSyncTask) => {
    if (
      !window.confirm(
        `确定删除自动同步任务 ${task.sourceGroupName || task.sourceGroupId || "全部 Sub2API OpenAI 账号"}？这只会删除任务配置，不会删除已导入账号。`
      )
    ) {
      return;
    }
    deleteSub2ApiTask({ taskId: task.id });
  };

  const runSub2ApiSyncTaskNow = (task: Sub2ApiAutoSyncTask) => {
    if (sub2ApiConfigured === false) {
      toast.error("未配置 SUB2API_POSTGRES_URL，不能运行自动同步任务");
      return;
    }
    if (isRunningSub2ApiSyncTask) return;
    setRunningSub2ApiSyncTaskId(task.id);
    runSub2ApiAutoSyncTaskNow({ taskId: task.id });
  };

  useEffect(() => {
    loadPool();
    if (!readOnly) {
      loadSub2ApiSyncStatus();
      loadSub2ApiSyncTasks();
      loadModelMultipliers();
    }
  }, [
    loadPool,
    loadSub2ApiSyncStatus,
    loadSub2ApiSyncTasks,
    loadModelMultipliers,
    readOnly,
  ]);

  useEffect(() => {
    if (sub2ApiConfigured) {
      loadSub2ApiSourceGroups();
    }
  }, [loadSub2ApiSourceGroups, sub2ApiConfigured]);

  useEffect(() => {
    if (
      activeTab !== "accounts" ||
      loadedAccountQueryKeyRef.current === accountQueryKey
    ) {
      return;
    }
    void requestAccountPage();
  }, [accountQueryKey, activeTab, requestAccountPage]);

  useEffect(() => {
    if (previousAccountFilterKeyRef.current === accountFilterKey) return;
    previousAccountFilterKeyRef.current = accountFilterKey;
    setAccountPage(1);
  }, [accountFilterKey]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 animate-in fade-in slide-in-from-bottom-2 duration-400 motion-reduce:animate-none">
        <div>
          <h2 className="font-serif text-2xl font-medium tracking-tight">
            生图后端池
          </h2>
          <p className="text-sm text-muted-foreground">
            {readOnly
              ? "只读查看自有账号池和系统后端 API。观察管理员不能新增、编辑、删除、同步或刷新账号。"
              : "管理自有账号池和系统后端 API。API 直连不转协议；Web 账号仅支持图片生成/编辑；Responses 账号支持 /responses，并可承接 images 到 responses 的转换。"}
          </p>
        </div>
        <Button variant="outline" onClick={reload} disabled={isLoading}>
          {isLoading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          刷新
        </Button>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          const nextTab =
            value === "accounts" ||
            value === "apis" ||
            value === "adobe" ||
            value === "import" ||
            value === "register" ||
            value === "groups"
              ? value
              : readOnly
                ? "accounts"
                : "groups";
          if (readOnly && (nextTab === "import" || nextTab === "register")) return;
          setActiveTab(nextTab);
        }}
        className="w-full"
      >
        <TabsList className="h-auto flex-wrap justify-start bg-transparent p-0">
          <TabsTrigger value="groups">分组</TabsTrigger>
          <TabsTrigger value="accounts">账号池</TabsTrigger>
          <TabsTrigger value="apis">API 后端</TabsTrigger>
          <TabsTrigger value="adobe">Adobe 后端</TabsTrigger>
          {!readOnly && <TabsTrigger value="import">同步 Sub2API</TabsTrigger>}
          {!readOnly && <TabsTrigger value="register">注册机</TabsTrigger>}
        </TabsList>

        <TabsContent
          value="groups"
          className={cn(
            "mt-6 grid gap-4",
            readOnly ? "lg:grid-cols-1" : "lg:grid-cols-[360px_1fr]"
          )}
        >
          {!readOnly && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {groupForm.id ? "编辑分组" : "新增分组"}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Input
                  placeholder="分组名称"
                  value={groupForm.name}
                  onChange={(event) =>
                    setGroupForm((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                />
                <Textarea
                  placeholder="说明"
                  value={groupForm.description}
                  onChange={(event) =>
                    setGroupForm((current) => ({
                      ...current,
                      description: event.target.value,
                    }))
                  }
                />
                <div className="grid grid-cols-2 gap-3">
                  <Label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={groupForm.isEnabled}
                      onCheckedChange={(checked) =>
                        setGroupForm((current) => ({
                          ...current,
                          isEnabled: Boolean(checked),
                        }))
                      }
                    />
                    启用
                  </Label>
                  <Label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={groupForm.isDefault}
                      onCheckedChange={(checked) =>
                        setGroupForm((current) => ({
                          ...current,
                          isDefault: Boolean(checked),
                        }))
                      }
                    />
                    默认
                  </Label>
                  <Label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={groupForm.isUserSelectable}
                      onCheckedChange={(checked) =>
                        setGroupForm((current) => ({
                          ...current,
                          isUserSelectable: Boolean(checked),
                        }))
                      }
                    />
                    用户可选
                  </Label>
                </div>
                <div className="space-y-2">
                  <Label>内容安全</Label>
                  <Select
                    value={groupForm.contentSafety}
                    onValueChange={(value) =>
                      setGroupForm((current) => ({
                        ...current,
                        contentSafety: value as ContentSafetyFormValue,
                      }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="inherit">继承成员</SelectItem>
                      <SelectItem value="enabled">强制开启</SelectItem>
                      <SelectItem value="disabled">强制关闭</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>分组类型</Label>
                  <Select
                    value={groupForm.backendType}
                    onValueChange={(value) =>
                      setGroupForm((current) => ({
                        ...current,
                        backendType: value as GroupBackendTypeFormValue,
                        childGroupIds:
                          value === "mixed" ? current.childGroupIds : [],
                      }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {GROUP_BACKEND_TYPE_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {
                      GROUP_BACKEND_TYPE_OPTIONS.find(
                        (option) => option.value === groupForm.backendType
                      )?.detail
                    }
                  </p>
                </div>
                <div
                  className={cn(
                    "space-y-2 rounded-md border p-3",
                    groupForm.backendType !== "mixed" &&
                      "bg-muted/30 text-muted-foreground"
                  )}
                >
                  <div className="flex items-center gap-2">
                    <FolderTree className="h-4 w-4 text-muted-foreground" />
                    <Label>嵌套子分组</Label>
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    仅 mixed 分组可嵌套一层子分组，子分组必须是仅 Web 或仅
                    Codex/Responses。调度时会先进入 mixed
                    父组，再按请求类型筛选父组和子组内的可用成员。
                  </p>
                  {groupForm.backendType === "mixed" ? (
                    childGroupOptions.length ? (
                      <div className="grid max-h-52 gap-2 overflow-y-auto pr-1">
                        {childGroupOptions.map((group) => (
                          <Label
                            key={group.id}
                            className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
                          >
                            <span className="min-w-0">
                              <span className="block truncate">
                                {group.name}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {groupBackendTypeLabel(group.backendType)} ·
                                账号 {group.accountCount} · API {group.apiCount}
                              </span>
                            </span>
                            <Checkbox
                              checked={groupForm.childGroupIds.includes(
                                group.id
                              )}
                              onCheckedChange={(checked) =>
                                setGroupForm((current) => ({
                                  ...current,
                                  childGroupIds: checked
                                    ? Array.from(
                                        new Set([
                                          ...current.childGroupIds,
                                          group.id,
                                        ])
                                      )
                                    : current.childGroupIds.filter(
                                        (childGroupId) =>
                                          childGroupId !== group.id
                                      ),
                                }))
                              }
                            />
                          </Label>
                        ))}
                      </div>
                    ) : (
                      <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                        暂无可嵌套的非 mixed 分组。
                      </div>
                    )
                  ) : (
                    <div className="rounded-md border border-dashed p-3 text-xs">
                      当前分组类型不能嵌套子分组。
                    </div>
                  )}
                </div>
                <div className="space-y-2">
                  <Label>最低套餐</Label>
                  <Select
                    value={groupForm.minPlan}
                    onValueChange={(value) =>
                      setGroupForm((current) => ({
                        ...current,
                        minPlan: value as SubscriptionPlan,
                      }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PLAN_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    用户套餐低于该档位时不可选择此后端分组，外接 API Key
                    也不能绑定。
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label>计费倍率</Label>
                  <Input
                    type="number"
                    min={0.01}
                    max={100}
                    step={0.01}
                    value={groupForm.billingMultiplier}
                    onChange={(event) =>
                      setGroupForm((current) => ({
                        ...current,
                        billingMultiplier: Number(event.target.value),
                      }))
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    该分组被用户选中或设为默认时，本站积分按此倍率结算；mixed
                    父分组调度到子分组成员时，父分组倍率和实际命中的子分组倍率会相乘生效。
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label>分组优先级</Label>
                  <Input
                    type="number"
                    min={0}
                    value={groupForm.priority}
                    onChange={(event) =>
                      setGroupForm((current) => ({
                        ...current,
                        priority: Number(event.target.value),
                      }))
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    数字越小，默认分组候选和分组列表越靠前；账号调度仍会继续比较账号优先级和负载。
                  </p>
                </div>
                <Button
                  className="w-full"
                  onClick={() => saveGroup(groupForm)}
                  disabled={isSavingGroup || !groupForm.name}
                >
                  {isSavingGroup && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  保存分组
                </Button>
                {groupForm.id && (
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={resetGroupForm}
                  >
                    取消编辑
                  </Button>
                )}
              </CardContent>
            </Card>
          )}

          <div className="grid gap-3">
            {groups.map((group) => (
              <Card key={group.id}>
                <CardContent className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{group.name}</span>
                      {group.isDefault && <Badge>默认</Badge>}
                      {!group.isEnabled && (
                        <Badge variant="secondary">停用</Badge>
                      )}
                      {group.isUserSelectable && (
                        <Badge variant="outline">用户可选</Badge>
                      )}
                      <Badge variant="outline">
                        最低 {planLabel(group.minPlan)}
                      </Badge>
                      <Badge variant="outline">
                        {groupBackendTypeLabel(group.backendType)}
                      </Badge>
                      {group.billingMultiplier !== 1 && (
                        <Badge variant="secondary">
                          计费 x{group.billingMultiplier}
                        </Badge>
                      )}
                      {group.childGroupIds.length > 0 && (
                        <Badge variant="secondary">
                          子分组 {group.childGroupIds.length}
                        </Badge>
                      )}
                      <Badge
                        variant={
                          group.contentSafetyEnabled === false
                            ? "secondary"
                            : "outline"
                        }
                      >
                        {safetyLabel(group.contentSafetyEnabled)}
                      </Badge>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {group.description || "无说明"} · 优先级 {group.priority}{" "}
                      · 计费倍率 x{group.billingMultiplier} · 账号{" "}
                      {group.accountCount} · API {group.apiCount}
                    </p>
                    {group.childGroupIds.length > 0 && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        嵌套：{childGroupNames(groups, group.childGroupIds)}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    {!readOnly && (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => editGroup(group)}
                        >
                          <Pencil className="mr-2 h-4 w-4" />
                          编辑
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={isDeletingGroup}
                          onClick={() => deleteGroup({ id: group.id })}
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          删除
                        </Button>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        <TabsContent
          value="accounts"
          className={cn(
            "mt-6 grid gap-4",
            readOnly ? "lg:grid-cols-1" : "lg:grid-cols-[360px_1fr]"
          )}
        >
          {!readOnly && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {accountForm.id ? "编辑账号" : "新增账号"}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Input
                  placeholder="名称"
                  value={accountForm.name}
                  onChange={(event) =>
                    setAccountForm((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                />
                <Input
                  placeholder="邮箱"
                  value={accountForm.email}
                  onChange={(event) =>
                    setAccountForm((current) => ({
                      ...current,
                      email: event.target.value,
                    }))
                  }
                />
                <Textarea
                  placeholder={
                    accountForm.id
                      ? "Access Token，留空不修改"
                      : "Access Token，可选；优先使用 RT 自动换取"
                  }
                  value={accountForm.accessToken}
                  onChange={(event) =>
                    setAccountForm((current) => ({
                      ...current,
                      accessToken: event.target.value,
                    }))
                  }
                />
                {!editingSub2ApiAccount ? (
                  <Textarea
                    placeholder={
                      accountForm.id
                        ? "Refresh Token，留空不修改；填写后会重新换取 AT"
                        : "Refresh Token，推荐填写；保存时自动换取 AT"
                    }
                    value={accountForm.refreshToken}
                    onChange={(event) =>
                      setAccountForm((current) => ({
                        ...current,
                        refreshToken: event.target.value,
                      }))
                    }
                  />
                ) : (
                  <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                    Sub2API 来源账号的 RT 由 Sub2API 管理，本站不允许修改。
                  </div>
                )}
                <div className="space-y-2 rounded-md border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <Label>所属分组</Label>
                    <span className="text-xs text-muted-foreground">
                      可多选
                    </span>
                  </div>
                  <div className="grid max-h-40 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
                    {groups.map((group) => (
                      <Label
                        key={group.id}
                        className="flex min-h-9 items-center gap-2 rounded-md border px-2 text-sm"
                      >
                        <Checkbox
                          checked={accountForm.groupIds.includes(group.id)}
                          onCheckedChange={(checked) =>
                            toggleAccountFormGroup(group.id, Boolean(checked))
                          }
                        />
                        <span className="truncate">{group.name}</span>
                      </Label>
                    ))}
                    {!groups.length && (
                      <p className="text-xs text-muted-foreground">
                        还没有可选分组。
                      </p>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    取消全部分组即为未分组；同一账号可同时被多个分组调度。
                  </p>
                </div>
                <Select
                  value={accountForm.implementationMode}
                  onValueChange={(value) =>
                    setAccountForm((current) => ({
                      ...current,
                      implementationMode: value as AccountBackendFormValue,
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="web">Web 账号</SelectItem>
                    <SelectItem value="responses">
                      Codex/Responses 账号
                    </SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  placeholder="模型，可选"
                  value={accountForm.model}
                  onChange={(event) =>
                    setAccountForm((current) => ({
                      ...current,
                      model: event.target.value,
                    }))
                  }
                />
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>优先级</Label>
                    <Input
                      type="number"
                      min={0}
                      value={accountForm.priority}
                      onChange={(event) =>
                        setAccountForm((current) => ({
                          ...current,
                          priority: Number(event.target.value),
                        }))
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      数字越小越先调度；同优先级再看当前负载、运行中数量和最近使用时间。
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label>最大并发数</Label>
                    <Input
                      type="number"
                      min={1}
                      max={100}
                      value={accountForm.concurrency}
                      onChange={(event) =>
                        setAccountForm((current) => ({
                          ...current,
                          concurrency: Number(event.target.value),
                        }))
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      作为负载分母：运行中请求数 /
                      最大并发数。值越大，同优先级下越容易分到更多请求。
                    </p>
                  </div>
                </div>
                <div className="flex items-center justify-between rounded-md border p-3">
                  <Label>接入内容安全审核</Label>
                  <Switch
                    checked={accountForm.contentSafetyEnabled}
                    onCheckedChange={(checked) =>
                      setAccountForm((current) => ({
                        ...current,
                        contentSafetyEnabled: checked,
                      }))
                    }
                  />
                </div>
                <div className="flex items-center justify-between gap-4 rounded-md border p-3">
                  <div>
                    <Label>遇错仍保持可用（永不冷却）</Label>
                    <p className="text-xs text-muted-foreground">
                      开启后该账号不会因失败被自动下线或冷却，始终参与调度；失败仍会
                      记录并切换到其他后端。需与「是否启用」同时开启才生效。
                    </p>
                  </div>
                  <Switch
                    checked={accountForm.alwaysActive}
                    onCheckedChange={(checked) =>
                      setAccountForm((current) => ({
                        ...current,
                        alwaysActive: checked,
                      }))
                    }
                  />
                </div>
                <Button
                  className="w-full"
                  onClick={() =>
                    saveAccount({
                      ...accountForm,
                      groupId: accountForm.groupIds[0] || "default",
                      groupIds: accountForm.groupIds,
                    })
                  }
                  disabled={
                    isSavingAccount ||
                    !accountForm.name ||
                    (!accountForm.id &&
                      !accountForm.accessToken &&
                      !accountForm.refreshToken)
                  }
                >
                  {isSavingAccount && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  保存账号
                </Button>
                {accountForm.id && (
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={resetAccountForm}
                  >
                    取消编辑
                  </Button>
                )}
              </CardContent>
            </Card>
          )}

          <div className="grid gap-3">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-7">
              {ACCOUNT_METRIC_CARDS.map((item, index) => {
                const Icon = item.icon;
                const rawValue = accountSummary[item.key];
                const value =
                  item.key === "quota"
                    ? formatCompactNumber(Number(rawValue))
                    : rawValue;
                return (
                  // 入场错峰放外层包裹,hover 过渡放卡片:两者 duration 工具类
                  // 共享同一 CSS 变量,同元素叠加会互相覆盖。
                  <div
                    key={item.key}
                    className="animate-in fade-in slide-in-from-bottom-2 duration-400 motion-reduce:animate-none"
                    style={{
                      animationDelay: `${index * 50}ms`,
                      animationFillMode: "backwards",
                    }}
                  >
                    <Card className="h-full lift-hover">
                      <CardContent className="p-4">
                        <div className="mb-3 flex items-center justify-between gap-2">
                          <span className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                            {item.label}
                          </span>
                          <Icon className="h-4 w-4 text-muted-foreground" />
                        </div>
                        <div
                          className={cn(
                            "font-serif text-2xl font-medium tracking-tight",
                            item.color
                          )}
                        >
                          {value}
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                );
              })}
            </div>
            <Card>
              <CardContent className="space-y-3 p-4">
                <div className="rounded-md border bg-muted/30 p-3 text-sm">
                  <div className="font-medium">调度规则</div>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    调度会先排除停用、错误、限流/冷却、分组类型或请求类型不匹配的账号；剩余后端按优先级从小到大选择。同优先级比较当前负载率（运行中请求数
                    / 最大并发数），再比较运行中请求数和最近使用时间。账号与 API
                    后端均可各自配置最大并发数（整池可并发 =
                    各后端最大并发数之和）。
                  </p>
                </div>
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <Label className="flex items-center gap-2 text-sm">
                    {!readOnly && (
                      <Checkbox
                        checked={allAccountsSelected}
                        onCheckedChange={(checked) =>
                          toggleAllAccounts(Boolean(checked))
                        }
                      />
                    )}
                    {readOnly
                      ? `账号 ${accounts.length} / ${accountTotal} 个`
                      : `已选 ${selectedAccountCount} 个账号`}
                    {isLoadingAccounts && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    )}
                    {!readOnly && selectedAccountCount > 0 && (
                      <span className="text-muted-foreground">
                        Sub2API {selectedSub2ApiAccountCount} · 手工/本站{" "}
                        {selectedManualAccountCount}
                      </span>
                    )}
                  </Label>
                  {!readOnly && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setIsManualImportOpen(true)}
                      >
                        导入 RT
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setIsWebAtImportOpen(true)}
                      >
                        导入 Web AT
                      </Button>
                    </div>
                  )}
                </div>
                <div className="grid gap-3 md:grid-cols-[minmax(220px,1.5fr)_1fr_1fr_1fr_auto]">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      className="pl-9"
                      placeholder="搜索名称、邮箱、来源、错误"
                      value={bulkAccountForm.search}
                      onChange={(event) =>
                        setBulkAccountForm((current) => ({
                          ...current,
                          search: event.target.value,
                        }))
                      }
                    />
                  </div>
                  <Select
                    value={bulkAccountForm.selectionGroupId}
                    onValueChange={(value) =>
                      setBulkAccountForm((current) => ({
                        ...current,
                        selectionGroupId: value,
                      }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="按分组选择" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部分组</SelectItem>
                      {groupOptions.map((group) => (
                        <SelectItem key={group.id} value={group.id}>
                          {group.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={bulkAccountForm.selectionMode}
                    onValueChange={(value) =>
                      setBulkAccountForm((current) => ({
                        ...current,
                        selectionMode: value as "all" | AccountBackendFormValue,
                      }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="按接口选择" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部接口</SelectItem>
                      <SelectItem value="web">Web</SelectItem>
                      <SelectItem value="responses">Codex/Responses</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select
                    value={bulkAccountForm.statusFilter}
                    onValueChange={(value) =>
                      setBulkAccountForm((current) => ({
                        ...current,
                        statusFilter: value as BulkAccountForm["statusFilter"],
                      }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="按状态筛选" />
                    </SelectTrigger>
                    <SelectContent>
                      {ACCOUNT_STATUS_FILTER_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={String(bulkAccountForm.pageSize)}
                    onValueChange={(value) =>
                      setBulkAccountForm((current) => ({
                        ...current,
                        pageSize: Number(value),
                      }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="每页数量" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="10">每页 10 个</SelectItem>
                      <SelectItem value="20">每页 20 个</SelectItem>
                      <SelectItem value="50">每页 50 个</SelectItem>
                      <SelectItem value="100">每页 100 个</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-2 text-xs text-muted-foreground md:flex-row md:items-center md:justify-between">
                  <span>
                    当前显示 {pagedAccounts.length} 个，匹配 {accountTotal} /
                    全部 {accountSummary.total} 个
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    {!readOnly && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          runBulkRefreshAccountInfo(
                            selectedWebAccountIds,
                            "请先选择 Web 账号"
                          )
                        }
                        disabled={
                          selectedWebAccountIds.length === 0 ||
                          isRefreshingAccounts
                        }
                      >
                        {isRefreshingAccounts ? (
                          <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                        ) : (
                          <RefreshCw className="mr-1 h-4 w-4" />
                        )}
                        刷新选中额度
                      </Button>
                    )}
                    {!readOnly && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          runBulkRefreshAccountInfo(
                            currentPageWebAccountIds,
                            "当前页没有 Web 账号"
                          )
                        }
                        disabled={
                          currentPageWebAccountIds.length === 0 ||
                          isRefreshingAccounts
                        }
                      >
                        {isRefreshingAccounts ? (
                          <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                        ) : (
                          <RefreshCw className="mr-1 h-4 w-4" />
                        )}
                        刷新当前页 Web
                      </Button>
                    )}
                    {!readOnly && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="text-destructive"
                        onClick={runDeleteErrorAccounts}
                        disabled={isDeletingAllErrorAccounts}
                      >
                        {isDeletingAllErrorAccounts ? (
                          <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="mr-1 h-4 w-4" />
                        )}
                        移除错误账号（所有）
                      </Button>
                    )}
                    {!readOnly && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={runResetSelectedAccounts}
                        disabled={
                          selectedAccountCount === 0 || isBulkUpdatingAccounts
                        }
                      >
                        {isBulkUpdatingAccounts ? (
                          <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                        ) : (
                          <CheckCircle2 className="mr-1 h-4 w-4" />
                        )}
                        重置为可用
                      </Button>
                    )}
                    {!readOnly && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setSelectedAccountIds([])}
                        disabled={selectedAccountCount === 0}
                      >
                        清空选择
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setAccountPage((page) => page - 1)}
                      disabled={safeAccountPage <= 1 || isLoadingAccounts}
                    >
                      <ChevronLeft className="mr-1 h-4 w-4" />
                      上一页
                    </Button>
                    <span>
                      第 {safeAccountPage} / {accountTotalPages} 页
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setAccountPage((page) => page + 1)}
                      disabled={
                        safeAccountPage >= accountTotalPages ||
                        isLoadingAccounts
                      }
                    >
                      下一页
                      <ChevronRight className="ml-1 h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Web 额度探测与 chatgpt2api 对齐：请求
                  /backend-api/conversation/init，读取 limits_progress 中
                  image_gen 的 remaining/reset_after；同时读取 /backend-api/me
                  和 accounts/check 获取邮箱、套餐与默认模型。
                </p>
                {!readOnly && (
                  <div className="grid gap-3 md:grid-cols-[1fr_auto]">
                    <div className="grid gap-3 md:grid-cols-2">
                      <Label className="flex min-h-10 items-center gap-2 rounded-md border px-3 text-sm">
                        <Checkbox
                          checked={bulkAccountForm.setGroup}
                          disabled={bulkAccountForm.deleteSelected}
                          onCheckedChange={(checked) =>
                            setBulkAccountForm((current) => ({
                              ...current,
                              setGroup: Boolean(checked),
                            }))
                          }
                        />
                        改分组
                        <Select
                          value={bulkAccountForm.groupId}
                          disabled={!bulkAccountForm.setGroup}
                          onValueChange={(value) =>
                            setBulkAccountForm((current) => ({
                              ...current,
                              groupId: value,
                            }))
                          }
                        >
                          <SelectTrigger className="ml-auto w-36">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {groupOptions.map((group) => (
                              <SelectItem key={group.id} value={group.id}>
                                {group.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Label>
                      <Label className="flex min-h-10 items-center gap-2 rounded-md border px-3 text-sm">
                        <Checkbox
                          checked={bulkAccountForm.setMode}
                          disabled={bulkAccountForm.deleteSelected}
                          onCheckedChange={(checked) =>
                            setBulkAccountForm((current) => ({
                              ...current,
                              setMode: Boolean(checked),
                            }))
                          }
                        />
                        切接口
                        <Select
                          value={bulkAccountForm.implementationMode}
                          disabled={!bulkAccountForm.setMode}
                          onValueChange={(value) =>
                            setBulkAccountForm((current) => ({
                              ...current,
                              implementationMode:
                                value as AccountBackendFormValue,
                            }))
                          }
                        >
                          <SelectTrigger className="ml-auto w-40">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="web">Web 账号</SelectItem>
                            <SelectItem value="responses">
                              Codex/Responses
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </Label>
                      <Label className="flex min-h-10 items-center gap-2 rounded-md border px-3 text-sm">
                        <Checkbox
                          checked={bulkAccountForm.setEnabled}
                          disabled={bulkAccountForm.deleteSelected}
                          onCheckedChange={(checked) =>
                            setBulkAccountForm((current) => ({
                              ...current,
                              setEnabled: Boolean(checked),
                            }))
                          }
                        />
                        启停
                        <Select
                          value={
                            bulkAccountForm.isEnabled ? "enabled" : "disabled"
                          }
                          disabled={!bulkAccountForm.setEnabled}
                          onValueChange={(value) =>
                            setBulkAccountForm((current) => ({
                              ...current,
                              isEnabled: value === "enabled",
                            }))
                          }
                        >
                          <SelectTrigger className="ml-auto w-28">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="enabled">启用</SelectItem>
                            <SelectItem value="disabled">停用</SelectItem>
                          </SelectContent>
                        </Select>
                      </Label>
                      <Label className="flex min-h-10 items-center gap-2 rounded-md border px-3 text-sm">
                        <Checkbox
                          checked={bulkAccountForm.setContentSafety}
                          disabled={bulkAccountForm.deleteSelected}
                          onCheckedChange={(checked) =>
                            setBulkAccountForm((current) => ({
                              ...current,
                              setContentSafety: Boolean(checked),
                            }))
                          }
                        />
                        内容安全
                        <Select
                          value={
                            bulkAccountForm.contentSafetyEnabled
                              ? "enabled"
                              : "disabled"
                          }
                          disabled={!bulkAccountForm.setContentSafety}
                          onValueChange={(value) =>
                            setBulkAccountForm((current) => ({
                              ...current,
                              contentSafetyEnabled: value === "enabled",
                            }))
                          }
                        >
                          <SelectTrigger className="ml-auto w-28">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="enabled">开启</SelectItem>
                            <SelectItem value="disabled">关闭</SelectItem>
                          </SelectContent>
                        </Select>
                      </Label>
                      <Label className="flex min-h-10 items-center gap-2 rounded-md border px-3 text-sm">
                        <Checkbox
                          checked={bulkAccountForm.setPriority}
                          disabled={bulkAccountForm.deleteSelected}
                          onCheckedChange={(checked) =>
                            setBulkAccountForm((current) => ({
                              ...current,
                              setPriority: Boolean(checked),
                            }))
                          }
                        />
                        改优先级
                        <Input
                          className="ml-auto w-24"
                          type="number"
                          min={0}
                          max={10000}
                          step={1}
                          value={bulkAccountForm.priority}
                          disabled={!bulkAccountForm.setPriority}
                          onChange={(event) =>
                            setBulkAccountForm((current) => ({
                              ...current,
                              priority: Number(event.target.value),
                            }))
                          }
                        />
                      </Label>
                      <Label className="flex min-h-10 items-center gap-2 rounded-md border px-3 text-sm">
                        <Checkbox
                          checked={bulkAccountForm.setConcurrency}
                          disabled={bulkAccountForm.deleteSelected}
                          onCheckedChange={(checked) =>
                            setBulkAccountForm((current) => ({
                              ...current,
                              setConcurrency: Boolean(checked),
                            }))
                          }
                        />
                        改最大并发数
                        <Input
                          className="ml-auto w-24"
                          type="number"
                          min={1}
                          max={100}
                          step={1}
                          value={bulkAccountForm.concurrency}
                          disabled={!bulkAccountForm.setConcurrency}
                          onChange={(event) =>
                            setBulkAccountForm((current) => ({
                              ...current,
                              concurrency: Number(event.target.value),
                            }))
                          }
                        />
                      </Label>
                      <Label className="flex min-h-10 items-center gap-2 rounded-md border border-destructive/40 px-3 text-sm text-destructive md:col-span-2">
                        <Checkbox
                          checked={bulkAccountForm.deleteSelected}
                          onCheckedChange={(checked) =>
                            setBulkAccountForm((current) => ({
                              ...current,
                              deleteSelected: Boolean(checked),
                              setGroup: checked ? false : current.setGroup,
                              setMode: checked ? false : current.setMode,
                              setEnabled: checked ? false : current.setEnabled,
                              setContentSafety: checked
                                ? false
                                : current.setContentSafety,
                              setPriority: checked
                                ? false
                                : current.setPriority,
                              setConcurrency: checked
                                ? false
                                : current.setConcurrency,
                            }))
                          }
                        />
                        删除选中账号
                        <span className="text-xs text-muted-foreground">
                          只删除本站后端池记录，不删除 Sub2API 源库账号。
                        </span>
                      </Label>
                    </div>
                    <Button
                      onClick={runBulkAccountOperation}
                      disabled={
                        selectedAccountCount === 0 ||
                        !hasBulkAccountOperation ||
                        isBulkUpdatingAccounts ||
                        isBulkDeletingAccounts
                      }
                      variant={
                        bulkAccountForm.deleteSelected
                          ? "destructive"
                          : "default"
                      }
                    >
                      {(isBulkUpdatingAccounts || isBulkDeletingAccounts) && (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      )}
                      执行
                    </Button>
                  </div>
                )}
                {bulkAccountForm.setMode && selectedSub2ApiAccountCount > 0 && (
                  <p className="text-xs text-destructive">
                    Sub2API 来源账号不能在本站批量切换
                    Web/Responses；手工导入账号会使用保存的 RT 重新换取目标模式
                    AT。
                  </p>
                )}
              </CardContent>
            </Card>
            {isLoadingAccounts && pagedAccounts.length === 0 && (
              <div className="flex min-h-24 items-center justify-center rounded-md border text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                加载当前页账号
              </div>
            )}
            {!isLoadingAccounts && pagedAccounts.length === 0 && (
              <div className="flex min-h-24 items-center justify-center rounded-md border text-sm text-muted-foreground">
                没有匹配的账号
              </div>
            )}
            {pagedAccounts.map((account) => (
              <Card key={account.id}>
                <CardContent className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      {!readOnly && (
                        <Checkbox
                          checked={selectedAccountIdSet.has(account.id)}
                          onCheckedChange={(checked) =>
                            toggleAccountSelection(account.id, Boolean(checked))
                          }
                        />
                      )}
                      <Server className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium">{account.name}</span>
                      <Badge variant="outline">
                        {account.implementationMode === "responses"
                          ? "Codex/Responses"
                          : "Web"}
                      </Badge>
                      <Badge variant="secondary">
                        {accountSourceLabel(account)}
                      </Badge>
                      <Badge
                        variant="outline"
                        className={backendStatusBadgeClass(account.status)}
                      >
                        {account.status === "active" && (
                          // 在线状态点:CSS 呼吸,尊重减动效偏好。
                          <span
                            aria-hidden="true"
                            className="h-1.5 w-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none"
                          />
                        )}
                        {account.status}
                      </Badge>
                      {formatWebStatus(account) && (
                        <Badge
                          variant="outline"
                          className={
                            getWebAccountInfo(account)?.status === "limited"
                              ? "border-warning/40 text-warning"
                              : ""
                          }
                        >
                          {formatWebStatus(account)}
                        </Badge>
                      )}
                      {isCoolingDown(account.cooldownUntil) && (
                        <Badge
                          variant="outline"
                          className="border-warning/40 text-warning"
                        >
                          {/* 冷却状态点:CSS 呼吸,尊重减动效偏好。 */}
                          <span
                            aria-hidden="true"
                            className="h-1.5 w-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none"
                          />
                          冷却中
                        </Badge>
                      )}
                      {account.alwaysActive && (
                        <Badge variant="outline">遇错常驻</Badge>
                      )}
                      {!account.isEnabled && (
                        <Badge variant="secondary">停用</Badge>
                      )}
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {account.email ||
                        getWebAccountInfo(account)?.email ||
                        "无邮箱"}{" "}
                      · {groupNames(groups, accountGroupIds(account))} · 优先级{" "}
                      {account.priority} · 最大并发数 {account.concurrency} ·{" "}
                      {formatDate(account.lastUsedAt, timeZone)}
                    </p>
                    {account.metadata?.sourceAccountId && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        来源账号 {account.metadata.sourceAccountId} ·{" "}
                        {account.metadata.tokenSource || "未知 token 来源"}
                      </p>
                    )}
                    <p className="mt-1 text-xs text-muted-foreground">
                      成功 {account.successCount} · 失败 {account.failCount} ·
                      冷却至 {formatCooldown(account.cooldownUntil, timeZone)}
                    </p>
                    {account.implementationMode === "web" && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Web 套餐 {getWebAccountInfo(account)?.type || "未刷新"}{" "}
                        · 图片额度 {formatWebQuota(account)} · 恢复{" "}
                        {formatOptionalDate(
                          getWebAccountInfo(account)?.restoreAt || null,
                          timeZone
                        )}{" "}
                        · 刷新{" "}
                        {formatOptionalDate(
                          getWebAccountInfo(account)?.refreshedAt || null,
                          timeZone
                        )}
                      </p>
                    )}
                    {account.lastError && (
                      <p className="mt-1 line-clamp-2 text-xs text-destructive">
                        {formatOptionalDate(account.lastErrorAt, timeZone)} ·{" "}
                        {account.lastError}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    {!readOnly && account.implementationMode === "web" && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={isRefreshingAccount}
                        onClick={() => refreshAccountInfo({ id: account.id })}
                      >
                        {isRefreshingAccount ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <RefreshCw className="mr-2 h-4 w-4" />
                        )}
                        刷新额度
                      </Button>
                    )}
                    {!readOnly && (
                      <>
                        <Button
                          variant={
                            account.alwaysActive ? "secondary" : "outline"
                          }
                          size="sm"
                          disabled={isSettingAccountAlwaysActive}
                          onClick={() =>
                            setAccountAlwaysActive({
                              id: account.id,
                              alwaysActive: !account.alwaysActive,
                            })
                          }
                          title="开启后该账号遇错也不下线、永不冷却，始终参与调度"
                        >
                          <InfinityIcon className="mr-2 h-4 w-4" />
                          {account.alwaysActive ? "取消常驻" : "遇错常驻"}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => editAccount(account)}
                        >
                          <Pencil className="mr-2 h-4 w-4" />
                          编辑
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={isDeletingMember}
                          onClick={() =>
                            deleteMember({ type: "account", id: account.id })
                          }
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          删除
                        </Button>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        <TabsContent
          value="apis"
          className={cn(
            "mt-6 grid gap-4",
            readOnly ? "lg:grid-cols-1" : "lg:grid-cols-[360px_1fr]"
          )}
        >
          {!readOnly && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {apiForm.id ? "编辑 API 后端" : "新增 API 后端"}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Input
                  placeholder="名称"
                  value={apiForm.name}
                  onChange={(event) =>
                    setApiForm((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                />
                <Input
                  placeholder="https://api.openai.com/v1"
                  value={apiForm.baseUrl}
                  onChange={(event) =>
                    setApiForm((current) => ({
                      ...current,
                      baseUrl: event.target.value,
                    }))
                  }
                />
                <Input
                  type="password"
                  placeholder={apiForm.id ? "API Key，留空不修改" : "API Key"}
                  value={apiForm.apiKey}
                  onChange={(event) =>
                    setApiForm((current) => ({
                      ...current,
                      apiKey: event.target.value,
                    }))
                  }
                />
                <div className="space-y-2 rounded-md border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <Label>所属分组</Label>
                    <span className="text-xs text-muted-foreground">
                      可多选
                    </span>
                  </div>
                  <div className="grid max-h-40 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
                    {groups.map((group) => (
                      <Label
                        key={group.id}
                        className="flex min-h-9 items-center gap-2 rounded-md border px-2 text-sm"
                      >
                        <Checkbox
                          checked={apiForm.groupIds.includes(group.id)}
                          onCheckedChange={(checked) =>
                            toggleApiFormGroup(group.id, Boolean(checked))
                          }
                        />
                        <span className="truncate">{group.name}</span>
                      </Label>
                    ))}
                    {!groups.length && (
                      <p className="text-xs text-muted-foreground">
                        还没有可选分组。
                      </p>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    取消全部分组即为未分组；同一 API 可同时被多个分组调度。
                  </p>
                </div>
                <Input
                  placeholder="默认模型，可选"
                  value={apiForm.model}
                  onChange={(event) =>
                    setApiForm((current) => ({
                      ...current,
                      model: event.target.value,
                    }))
                  }
                />
                <div className="space-y-2">
                  <Label>接口类型</Label>
                  <Select
                    value={apiForm.interfaceMode}
                    onValueChange={(value) =>
                      setApiForm((current) => ({
                        ...current,
                        interfaceMode: value as ApiInterfaceModeFormValue,
                      }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {API_INTERFACE_MODE_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {
                      API_INTERFACE_MODE_OPTIONS.find(
                        (option) => option.value === apiForm.interfaceMode
                      )?.detail
                    }
                  </p>
                </div>
                <div className="space-y-2">
                  <Label>Images 上游</Label>
                  <Select
                    value={apiForm.imagesUpstreamMode}
                    onValueChange={(value) =>
                      setApiForm((current) => ({
                        ...current,
                        imagesUpstreamMode:
                          value as ImagesUpstreamModeFormValue,
                      }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {IMAGES_UPSTREAM_MODE_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {
                      IMAGES_UPSTREAM_MODE_OPTIONS.find(
                        (option) => option.value === apiForm.imagesUpstreamMode
                      )?.detail
                    }
                  </p>
                </div>
                <div className="space-y-2">
                  <Label>Chat Completions 上游</Label>
                  <Select
                    value={apiForm.chatCompletionsUpstreamMode}
                    onValueChange={(value) =>
                      setApiForm((current) => ({
                        ...current,
                        chatCompletionsUpstreamMode:
                          value as ChatCompletionsUpstreamModeFormValue,
                      }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CHAT_COMPLETIONS_UPSTREAM_MODE_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {
                      CHAT_COMPLETIONS_UPSTREAM_MODE_OPTIONS.find(
                        (option) =>
                          option.value === apiForm.chatCompletionsUpstreamMode
                      )?.detail
                    }
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label>优先级</Label>
                  <Input
                    type="number"
                    min={0}
                    value={apiForm.priority}
                    onChange={(event) =>
                      setApiForm((current) => ({
                        ...current,
                        priority: Number(event.target.value),
                      }))
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    数字越小越先调度；同优先级下再按最大并发数（负载权重）比较负载。
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label>最大并发数</Label>
                  <Input
                    type="number"
                    min={1}
                    max={10000}
                    value={apiForm.concurrency}
                    onChange={(event) =>
                      setApiForm((current) => ({
                        ...current,
                        concurrency: Number(event.target.value),
                      }))
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    单后端最大同时在飞请求数（1-100）。同时也是同优先级下的负载权重：
                    值越大越能分到更多请求。整池可并发 =
                    各后端最大并发数之和；后端少时
                    务必调大，否则高并发会被挡成「无可用账号或 API」。
                  </p>
                </div>
                <div className="flex items-center justify-between rounded-md border p-3">
                  <Label>流式调用</Label>
                  <Switch
                    checked={apiForm.useStream}
                    onCheckedChange={(checked) =>
                      setApiForm((current) => ({
                        ...current,
                        useStream: checked,
                      }))
                    }
                  />
                </div>
                <div className="flex items-center justify-between rounded-md border p-3">
                  <Label>是否启用</Label>
                  <Switch
                    checked={apiForm.isEnabled}
                    onCheckedChange={(checked) =>
                      setApiForm((current) => ({
                        ...current,
                        isEnabled: checked,
                      }))
                    }
                  />
                </div>
                <div className="flex items-center justify-between gap-4 rounded-md border p-3">
                  <div>
                    <Label>遇错仍保持可用（永不冷却）</Label>
                    <p className="text-xs text-muted-foreground">
                      开启后该 API
                      不会因失败被自动下线或冷却，始终参与调度；失败仍会
                      记录并切换到其他后端。需与「是否启用」同时开启才生效。
                    </p>
                  </div>
                  <Switch
                    checked={apiForm.alwaysActive}
                    onCheckedChange={(checked) =>
                      setApiForm((current) => ({
                        ...current,
                        alwaysActive: checked,
                      }))
                    }
                  />
                </div>
                <div className="flex items-center justify-between gap-4 rounded-md border p-3">
                  <div>
                    <Label>失败进入冷却</Label>
                    <p className="text-xs text-muted-foreground">
                      开启后该 API
                      的瞬时/可恢复失败（5xx、超时、限流等）会进入定时
                      冷却、暂时下线，到点自动恢复。关闭（默认）则不冷却，只有确定性
                      错误（凭证废、缺图像工具、中转坏）会被踢出。常驻开启时本项无效。
                    </p>
                  </div>
                  <Switch
                    checked={apiForm.failureCooldownEnabled}
                    onCheckedChange={(checked) =>
                      setApiForm((current) => ({
                        ...current,
                        failureCooldownEnabled: checked,
                      }))
                    }
                  />
                </div>
                <div className="flex items-center justify-between gap-4 rounded-md border p-3">
                  <div>
                    <Label>Adobe 来源（按 Adobe 计费 + 进 firefly 调度）</Label>
                    <p className="text-xs text-muted-foreground">
                      上游实为 Adobe 的 gpt 格式 api。开启后：计费吃下方成员倍率
                      （命中组倍率 × 成员倍率，与 Adobe 伪账号同口径）；调度上参与
                      firefly 候选，firefly-* 请求自动反向转换成 gpt 请求后由本后端处理。
                    </p>
                  </div>
                  <Switch
                    checked={apiForm.adobeSourced}
                    onCheckedChange={(checked) =>
                      setApiForm((current) => ({
                        ...current,
                        adobeSourced: checked,
                      }))
                    }
                  />
                </div>
                {apiForm.adobeSourced && (
                  <div className="space-y-1.5">
                    <Label>计费倍率（成员）</Label>
                    <Input
                      type="number"
                      min={0.01}
                      max={100}
                      step={0.01}
                      value={apiForm.billingMultiplier}
                      onChange={(event) =>
                        setApiForm((current) => ({
                          ...current,
                          billingMultiplier: event.target.value,
                        }))
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      仅「Adobe 来源」开启时生效。最终扣费 = 向上保留两位(向上保留两位
                      (基础价 + 审核附加) × 模型倍率 × 命中组倍率 × 本成员倍率)。
                    </p>
                    {(() => {
                      // 实时算例：以 nano-banana-pro · 1024×1024 为例，套上方输入的成员
                      // 倍率，与"含分组倍率示例"同口径（基础价 6 + 审核附加 0.04 + 嵌套
                      // ceil2），再叠模型倍率（线上 IMAGE_MODEL_MULTIPLIERS：
                      // nano-banana-pro x1.5）与示例组倍率。香蕉 pro 是"多一些乘数"的典型。
                      const member = Number(apiForm.billingMultiplier) || 1;
                      const sampleGroup = 1.2;
                      const modelMultiplier = 1.5;
                      const ceil2 = (v: number) =>
                        Math.ceil(v * 100 - 1e-9) / 100;
                      const final = ceil2(
                        ceil2(6.04) * modelMultiplier * sampleGroup * member
                      );
                      return (
                        <div className="space-y-1 rounded-md border bg-muted/30 p-3 text-xs">
                          <div className="font-medium">
                            算例：nano-banana-pro · 1024×1024
                          </div>
                          <div className="text-muted-foreground">
                            模型 x{modelMultiplier} · 组 x{sampleGroup}（示例） ·
                            成员 x{member}
                          </div>
                          <div className="text-muted-foreground">
                            向上保留两位(向上保留两位(6 基础价 + 0.04 审核附加) x{" "}
                            {modelMultiplier} x {sampleGroup} x {member})
                          </div>
                          <div className="font-medium text-foreground">
                            = {final} 积分/张
                          </div>
                          <p className="text-muted-foreground">
                            模型倍率（如 nano-banana-pro x1.5）按 IMAGE_MODEL_MULTIPLIERS
                            配置、与本成员倍率叠乘；关闭「Adobe 来源」则成员 x1（同普通 api）。
                          </p>
                        </div>
                      );
                    })()}
                  </div>
                )}
                <Button
                  className="w-full"
                  onClick={() =>
                    saveApi({
                      ...apiForm,
                      groupId: apiForm.groupIds[0] || "default",
                      groupIds: apiForm.groupIds,
                    })
                  }
                  disabled={
                    isSavingApi ||
                    !apiForm.name ||
                    !apiForm.baseUrl ||
                    (!apiForm.id && !apiForm.apiKey)
                  }
                >
                  {isSavingApi && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  保存 API 后端
                </Button>
                {apiForm.id && (
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={resetApiForm}
                  >
                    取消编辑
                  </Button>
                )}
              </CardContent>
            </Card>
          )}

          <div className="grid gap-3">
            {apis.map((api) => (
              <Card key={api.id}>
                <CardContent className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Plug className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium">{api.name}</span>
                      <Badge variant="outline">
                        {apiInterfaceModeLabel(api.interfaceMode)}
                      </Badge>
                      <Badge variant="outline">
                        Chat:{" "}
                        {api.chatCompletionsUpstreamMode === "chat_completions"
                          ? "原生"
                          : api.chatCompletionsUpstreamMode === "images"
                            ? "Images"
                            : "Responses"}
                      </Badge>
                      <Badge variant="outline">
                        Images:{" "}
                        {api.imagesUpstreamMode === "responses"
                          ? "Responses"
                          : "原生"}
                      </Badge>
                      <ApiOperationalStatusBadge api={api} />
                      {api.isEnabled && api.alwaysActive && (
                        <Badge variant="outline">遇错常驻</Badge>
                      )}
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {api.baseUrl} · {groupNames(groups, apiGroupIds(api))} ·{" "}
                      优先级 {api.priority} · 最大并发数 {api.concurrency} ·{" "}
                      {formatDate(api.lastUsedAt, timeZone)}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {api.interfaceMode === "mixed"
                        ? `混合接口；文生图/图生图走 ${api.imagesUpstreamMode === "responses" ? "Responses" : "Images"}，Chat 按独立开关调度。`
                        : api.interfaceMode === "responses"
                          ? `仅 Responses；${api.imagesUpstreamMode === "responses" ? "可承接文生图/图生图转换" : "默认不承接文生图/图生图"}。`
                          : "仅 Images；只用于文生图/图生图，不参与 Chat/Agent/Responses 调度。"}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      成功 {api.successCount} · 失败 {api.failCount} · 冷却至{" "}
                      {formatCooldown(api.cooldownUntil, timeZone)}
                    </p>
                    {api.lastError && (
                      <p className="mt-1 line-clamp-2 text-xs text-destructive">
                        {formatOptionalDate(api.lastErrorAt, timeZone)} ·{" "}
                        {api.lastError}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {!readOnly && (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={testingApiId === api.id}
                          onClick={() => {
                            setTestingApiId(api.id);
                            testApi({ id: api.id });
                          }}
                        >
                          {testingApiId === api.id ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <Activity className="mr-2 h-4 w-4" />
                          )}
                          测活
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={isSettingApiEnabled}
                          onClick={() =>
                            setApiEnabled({
                              id: api.id,
                              isEnabled: !api.isEnabled,
                            })
                          }
                        >
                          {api.isEnabled ? (
                            <>
                              <Ban className="mr-2 h-4 w-4" />
                              停用
                            </>
                          ) : (
                            <>
                              <CheckCircle2 className="mr-2 h-4 w-4" />
                              启用
                            </>
                          )}
                        </Button>
                        <Button
                          variant={api.alwaysActive ? "secondary" : "outline"}
                          size="sm"
                          disabled={isSettingApiAlwaysActive}
                          onClick={() =>
                            setApiAlwaysActive({
                              id: api.id,
                              alwaysActive: !api.alwaysActive,
                            })
                          }
                          title="开启后该 API 遇错也不下线、永不冷却，始终参与调度"
                        >
                          <InfinityIcon className="mr-2 h-4 w-4" />
                          {api.alwaysActive ? "取消常驻" : "遇错常驻"}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => editApi(api)}
                        >
                          <Pencil className="mr-2 h-4 w-4" />
                          编辑
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={isDeletingMember}
                          onClick={() =>
                            deleteMember({ type: "api", id: api.id })
                          }
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          删除
                        </Button>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        <TabsContent
          value="adobe"
          className={cn(
            "mt-6 grid gap-4",
            readOnly ? "lg:grid-cols-1" : "lg:grid-cols-[360px_1fr]"
          )}
        >
          {!readOnly && (
            <Card
              id="adobe-backend-form"
              className={
                adobeForm.id
                  ? "ring-2 ring-primary transition-shadow"
                  : "transition-shadow"
              }
            >
              <CardHeader>
                <CardTitle className="text-base">
                  {adobeForm.id ? "正在编辑 Adobe 后端" : "新增 Adobe 后端"}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Input
                  placeholder="名称"
                  value={adobeForm.name}
                  onChange={(event) =>
                    setAdobeForm((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                />
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">
                    接入模式
                  </Label>
                  <Select
                    value={adobeForm.mode}
                    onValueChange={(value) =>
                      setAdobeForm((current) => ({
                        ...current,
                        mode: value === "direct" ? "direct" : "gateway",
                      }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="gateway">
                        网关（外部 adobe2api）
                      </SelectItem>
                      <SelectItem value="direct">
                        直连（本仓库逆向 + Adobe 账号）
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    直连模式凭据为下方导入的 Adobe cookie 账号，经 TLS 旁路直连
                    Firefly，无需外部 adobe2api。
                  </p>
                </div>
                {adobeForm.mode === "gateway" && (
                  <>
                    <Input
                      placeholder="adobe2api 地址，如 http://127.0.0.1:6001"
                      value={adobeForm.baseUrl}
                      onChange={(event) =>
                        setAdobeForm((current) => ({
                          ...current,
                          baseUrl: event.target.value,
                        }))
                      }
                    />
                    <Input
                      type="password"
                      placeholder={
                        adobeForm.id
                          ? "Service API Key，留空不修改"
                          : "Service API Key"
                      }
                      value={adobeForm.apiKey}
                      onChange={(event) =>
                        setAdobeForm((current) => ({
                          ...current,
                          apiKey: event.target.value,
                        }))
                      }
                    />
                  </>
                )}
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">
                    启用模型家族（逗号分隔，留空不限制）
                  </Label>
                  <Input
                    placeholder="gpt-image,nano-banana-pro"
                    value={adobeForm.enabledModels}
                    onChange={(event) =>
                      setAdobeForm((current) => ({
                        ...current,
                        enabledModels: event.target.value,
                      }))
                    }
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">
                      默认宽高比
                    </Label>
                    <Select
                      value={adobeForm.defaultRatio}
                      onValueChange={(value) =>
                        setAdobeForm((current) => ({
                          ...current,
                          defaultRatio: value,
                        }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="1x1">1x1</SelectItem>
                        <SelectItem value="16x9">16x9</SelectItem>
                        <SelectItem value="9x16">9x16</SelectItem>
                        <SelectItem value="4x3">4x3</SelectItem>
                        <SelectItem value="3x4">3x4</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">
                      默认分辨率
                    </Label>
                    <Select
                      value={adobeForm.defaultResolution}
                      onValueChange={(value) =>
                        setAdobeForm((current) => ({
                          ...current,
                          defaultResolution: value,
                        }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="1k">1k</SelectItem>
                        <SelectItem value="2k">2k</SelectItem>
                        <SelectItem value="4k">4k</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">
                    GPT Image 质量（auto 映射）
                  </Label>
                  <Select
                    value={adobeForm.gptImageQuality}
                    onValueChange={(value) =>
                      setAdobeForm((current) => ({
                        ...current,
                        gptImageQuality: value as "low" | "medium" | "high",
                      }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="low">low</SelectItem>
                      <SelectItem value="medium">medium</SelectItem>
                      <SelectItem value="high">high</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    用户选 auto 时映射到此质量；显式选 low/medium/high 则按用户的来。
                  </p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">
                    计费倍率（整个 Adobe 后端，图像+视频）
                  </Label>
                  <Input
                    type="number"
                    step="0.1"
                    min="0"
                    value={adobeForm.billingMultiplier}
                    onChange={(event) =>
                      setAdobeForm((current) => ({
                        ...current,
                        billingMultiplier: event.target.value,
                      }))
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    对 adobe 图像与视频积分成本统一乘以此倍率;与分组倍率叠加。
                  </p>
                </div>
                <div className="space-y-2 rounded-md border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <Label>所属分组</Label>
                    <span className="text-xs text-muted-foreground">可多选</span>
                  </div>
                  <div className="grid max-h-40 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
                    {groups.map((group) => (
                      <Label
                        key={group.id}
                        className="flex min-h-9 items-center gap-2 rounded-md border px-2 text-sm"
                      >
                        <Checkbox
                          checked={adobeForm.groupIds.includes(group.id)}
                          onCheckedChange={(checked) =>
                            toggleAdobeFormGroup(group.id, Boolean(checked))
                          }
                        />
                        <span className="truncate">{group.name}</span>
                      </Label>
                    ))}
                    {!groups.length && (
                      <p className="text-xs text-muted-foreground">
                        还没有可选分组。
                      </p>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">
                      优先级
                    </Label>
                    <Input
                      type="number"
                      value={adobeForm.priority}
                      onChange={(event) =>
                        setAdobeForm((current) => ({
                          ...current,
                          priority: Number(event.target.value) || 0,
                        }))
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">并发</Label>
                    <Input
                      type="number"
                      value={adobeForm.concurrency}
                      onChange={(event) =>
                        setAdobeForm((current) => ({
                          ...current,
                          concurrency: Number(event.target.value) || 1,
                        }))
                      }
                    />
                  </div>
                </div>
                <div className="flex items-center justify-between gap-4 rounded-md border p-3">
                  <Label>启用</Label>
                  <Switch
                    checked={adobeForm.isEnabled}
                    onCheckedChange={(checked) =>
                      setAdobeForm((current) => ({
                        ...current,
                        isEnabled: checked,
                      }))
                    }
                  />
                </div>
                <div className="flex items-center justify-between gap-4 rounded-md border p-3">
                  <div>
                    <Label>遇错仍可用（常驻）</Label>
                    <p className="text-xs text-muted-foreground">
                      无视冷却/临时故障始终入选；终态错误（鉴权失效等）仍下线。
                    </p>
                  </div>
                  <Switch
                    checked={adobeForm.alwaysActive}
                    onCheckedChange={(checked) =>
                      setAdobeForm((current) => ({
                        ...current,
                        alwaysActive: checked,
                      }))
                    }
                  />
                </div>
                <div className="flex items-center justify-between gap-4 rounded-md border p-3">
                  <Label>失败进入冷却</Label>
                  <Switch
                    checked={adobeForm.failureCooldownEnabled}
                    onCheckedChange={(checked) =>
                      setAdobeForm((current) => ({
                        ...current,
                        failureCooldownEnabled: checked,
                      }))
                    }
                  />
                </div>
                <div className="flex items-center justify-between gap-4 rounded-md border p-3">
                  <Label>内容审核</Label>
                  <Switch
                    checked={adobeForm.contentSafetyEnabled}
                    onCheckedChange={(checked) =>
                      setAdobeForm((current) => ({
                        ...current,
                        contentSafetyEnabled: checked,
                      }))
                    }
                  />
                </div>
                <div className="flex items-center justify-between gap-4 rounded-md border p-3">
                  <div>
                    <Label>允许视频模型</Label>
                    <p className="text-xs text-muted-foreground">
                      Phase 1 仅图像；视频后续支持。
                    </p>
                  </div>
                  <Switch
                    checked={adobeForm.supportsVideo}
                    onCheckedChange={(checked) =>
                      setAdobeForm((current) => ({
                        ...current,
                        supportsVideo: checked,
                      }))
                    }
                  />
                </div>
                <Button
                  className="w-full"
                  onClick={() =>
                    saveAdobe({
                      ...adobeForm,
                      groupId: adobeForm.groupIds[0] || "default",
                      groupIds: adobeForm.groupIds,
                      enabledModels: adobeForm.enabledModels
                        .split(",")
                        .map((value) => value.trim())
                        .filter(Boolean),
                    })
                  }
                  disabled={
                    isSavingAdobe ||
                    !adobeForm.name ||
                    (adobeForm.mode === "gateway" &&
                      (!adobeForm.baseUrl ||
                        (!adobeForm.id && !adobeForm.apiKey)))
                  }
                >
                  {isSavingAdobe && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  保存 Adobe 后端
                </Button>
                {adobeForm.mode === "direct" && (
                  <div className="space-y-3 rounded-md border p-3">
                    <div>
                      <Label>Adobe 账号（cookie）</Label>
                      <p className="text-xs text-muted-foreground">
                        {adobeForm.id
                          ? "粘贴 Adobe 浏览器 cookie 或插件导出的 JSON；导入时会刷新一次以验证。批量导入支持每行一个 cookie 或 JSON 数组，逐条验证、按 Adobe 账号身份去重。可用仓库 tools/adobe-cookie-exporter/ 浏览器扩展导出（含 HttpOnly cookie）。"
                          : "请先保存后端，再导入 Adobe 账号。"}
                      </p>
                    </div>
                    {adobeForm.id && (
                      <>
                        <Input
                          placeholder="账号备注名（单条）/ 名称前缀（批量，自动加序号）"
                          value={adobeAccountName}
                          onChange={(event) =>
                            setAdobeAccountName(event.target.value)
                          }
                        />
                        <Textarea
                          placeholder="单条：粘贴一个 cookie 或 JSON；批量：每行一个 cookie，或粘贴 JSON 数组"
                          value={adobeCookieInput}
                          rows={4}
                          onChange={(event) =>
                            setAdobeCookieInput(event.target.value)
                          }
                        />
                        <Button
                          variant="secondary"
                          className="w-full"
                          disabled={
                            isImportingAdobeAccount || !adobeCookieInput.trim()
                          }
                          onClick={() =>
                            importAdobeAccountExec({
                              adobeId: adobeForm.id,
                              name: adobeAccountName.trim() || undefined,
                              cookie: adobeCookieInput.trim(),
                            })
                          }
                        >
                          {isImportingAdobeAccount && (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          )}
                          导入并验证账号
                        </Button>
                        <Button
                          variant="secondary"
                          className="w-full"
                          disabled={
                            isImportingAdobeAccounts ||
                            !adobeCookieInput.trim()
                          }
                          onClick={() =>
                            importAdobeAccountsExec({
                              adobeId: adobeForm.id,
                              cookiesText: adobeCookieInput,
                              namePrefix:
                                adobeAccountName.trim() || undefined,
                            })
                          }
                        >
                          {isImportingAdobeAccounts && (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          )}
                          批量导入（每行一个 cookie / JSON 数组）
                        </Button>
                        {adobeBatchSummary && (
                          <p className="text-xs text-muted-foreground">
                            {adobeBatchSummary}
                          </p>
                        )}
                        <div className="space-y-2">
                          {!adobeAccounts.length && (
                            <p className="text-xs text-muted-foreground">
                              还没有账号。
                            </p>
                          )}
                          {adobeAccounts.map((account) => (
                            <div
                              key={account.id}
                              className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5"
                            >
                              <div className="min-w-0">
                                <p className="truncate text-sm">
                                  {account.displayName ||
                                    account.email ||
                                    account.name}
                                </p>
                                <p className="truncate text-xs text-muted-foreground">
                                  {account.status}
                                  {account.lastRefreshError
                                    ? ` · ${account.lastRefreshError}`
                                    : ""}
                                </p>
                                <p className="truncate text-xs text-muted-foreground">
                                  {account.creditsError
                                    ? `余额读取失败: ${account.creditsError}`
                                    : account.creditsAvailable !== null ||
                                        account.creditsTotal !== null
                                      ? `Firefly 余额 ${account.creditsAvailable ?? "?"} / ${account.creditsTotal ?? "?"}`
                                      : "余额未知（刷新后获取）"}
                                </p>
                              </div>
                              <div className="flex shrink-0 items-center gap-2">
                                <Switch
                                  checked={account.isEnabled}
                                  onCheckedChange={(checked) =>
                                    setAdobeAccountEnabledExec({
                                      id: account.id,
                                      isEnabled: checked,
                                    })
                                  }
                                />
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() =>
                                    deleteAdobeAccountExec({ id: account.id })
                                  }
                                >
                                  删除
                                </Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}
                {adobeForm.id && (
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={resetAdobeForm}
                  >
                    取消编辑
                  </Button>
                )}
              </CardContent>
            </Card>
          )}

          <div className="space-y-3">
            {!adobes.length && (
              <p className="text-sm text-muted-foreground">
                还没有 Adobe 后端。新增一个 adobe2api 实例即可被调度。
              </p>
            )}
            {adobes.map((adobe) => (
              <Card key={adobe.id}>
                <CardContent className="space-y-2 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{adobe.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {adobe.mode === "direct"
                          ? "直连模式（Adobe 账号）"
                          : adobe.baseUrl}
                      </p>
                    </div>
                    <span
                      className={cn(
                        "flex shrink-0 items-center gap-1.5 rounded-sm px-2 py-0.5 text-xs",
                        adobe.status === "error"
                          ? "bg-destructive/10 text-destructive"
                          : adobe.isEnabled
                            ? "bg-success/10 text-success"
                            : "bg-muted text-muted-foreground"
                      )}
                    >
                      {adobe.isEnabled && adobe.status !== "error" && (
                        // 在线状态点:CSS 呼吸,尊重减动效偏好。
                        <span
                          aria-hidden="true"
                          className="h-1.5 w-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none"
                        />
                      )}
                      {adobe.isEnabled ? adobe.status : "已停用"}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    模型：
                    {adobe.enabledModels?.length
                      ? adobe.enabledModels.join(", ")
                      : "不限"}
                    {" · 默认 "}
                    {adobe.defaultResolution}/{adobe.defaultRatio}
                    {" · 优先级 "}
                    {adobe.priority}
                    {" · 并发 "}
                    {adobe.concurrency}
                    {" · 成功 "}
                    {adobe.successCount}
                    {" / 失败 "}
                    {adobe.failCount}
                  </p>
                  {adobe.lastError && (
                    <p className="truncate text-xs text-destructive">
                      最近错误：{adobe.lastError}
                    </p>
                  )}
                  {!readOnly && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => editAdobe(adobe)}
                      >
                        编辑
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={isSettingAdobeEnabled}
                        onClick={() =>
                          setAdobeEnabled({
                            id: adobe.id,
                            isEnabled: !adobe.isEnabled,
                          })
                        }
                      >
                        {adobe.isEnabled ? "停用" : "启用"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={isSettingAdobeAlwaysActive}
                        onClick={() =>
                          setAdobeAlwaysActive({
                            id: adobe.id,
                            alwaysActive: !adobe.alwaysActive,
                          })
                        }
                      >
                        {adobe.alwaysActive ? "取消常驻" : "设为常驻"}
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={isDeletingMember}
                        onClick={() =>
                          deleteMember({ type: "adobe", id: adobe.id })
                        }
                      >
                        删除
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}

            {!readOnly && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">模型计费倍率</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <p className="text-xs text-muted-foreground">
                    最终积分 = 基础(图像按尺寸/视频按秒) × 模型倍率 × 整个 Adobe
                    倍率 × 分组倍率。留空表示该模型不加倍率（默认 1）。
                  </p>

                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">
                      图像模型倍率
                    </Label>
                    <div className="space-y-2">
                      {ADOBE_IMAGE_MULTIPLIER_FAMILIES.map((family) => (
                        <div
                          key={family}
                          className="grid grid-cols-[1fr_120px] items-center gap-2"
                        >
                          <span className="truncate text-sm">{family}</span>
                          <Input
                            type="number"
                            inputMode="decimal"
                            min="0"
                            step="0.01"
                            placeholder="1"
                            value={imageMultiplierDraft[family] ?? ""}
                            onChange={(event) =>
                              setImageMultiplierDraft((current) => ({
                                ...current,
                                [family]: event.target.value,
                              }))
                            }
                          />
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">
                      视频模型倍率
                    </Label>
                    <div className="space-y-2">
                      {ADOBE_VIDEO_MULTIPLIER_FAMILIES.map((family) => (
                        <div
                          key={family}
                          className="grid grid-cols-[1fr_120px] items-center gap-2"
                        >
                          <span className="truncate text-sm">{family}</span>
                          <Input
                            type="number"
                            inputMode="decimal"
                            min="0"
                            step="0.01"
                            placeholder="1"
                            value={videoMultiplierDraft[family] ?? ""}
                            onChange={(event) =>
                              setVideoMultiplierDraft((current) => ({
                                ...current,
                                [family]: event.target.value,
                              }))
                            }
                          />
                        </div>
                      ))}
                    </div>
                  </div>

                  <Button
                    size="sm"
                    disabled={isSavingMultipliers}
                    onClick={() =>
                      saveModelMultipliers({
                        image: draftToMultipliers(imageMultiplierDraft),
                        video: draftToMultipliers(videoMultiplierDraft),
                      })
                    }
                  >
                    {isSavingMultipliers ? "保存中…" : "保存模型倍率"}
                  </Button>
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>

        {!readOnly && (
          <TabsContent value="import" className="mt-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Database className="h-4 w-4" />
                  同步 Sub2API 账号
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  连接 Sub2API Postgres，只同步 OpenAI OAuth 账号。默认排除 free
                  套餐并只同步 Codex/Responses，复用 Sub2API 当前
                  access_token；勾选 Mobile RT 后才会把 Sub 中 mobile client
                  的当前 AT 同步为 Web/同时账号，不刷新也不回写 Sub2API 的 RT。
                </p>
                {isSub2ApiSyncUnavailable && (
                  <div className="flex gap-2 rounded-md border border-dashed border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
                    <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{sub2ApiUnavailableMessage}</span>
                  </div>
                )}
                <div className="grid gap-3 md:grid-cols-[1fr_auto]">
                  <Select
                    value={importForm.sourceGroupId}
                    onValueChange={(value) =>
                      setImportForm((current) => ({
                        ...current,
                        sourceGroupId: value,
                      }))
                    }
                    disabled={isSub2ApiSyncUnavailable}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Sub2API 来源分组" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">
                        全部 Sub2API OpenAI 账号
                      </SelectItem>
                      {sub2ApiSourceGroups.map((group) => (
                        <SelectItem key={group.id} value={group.id}>
                          {group.name} · {group.accountCount} 个账号
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => loadSub2ApiSourceGroups()}
                    disabled={isSub2ApiSyncUnavailable || isLoadingSourceGroups}
                  >
                    {isLoadingSourceGroups ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCw className="mr-2 h-4 w-4" />
                    )}
                    刷新来源
                  </Button>
                </div>
                <div className="flex items-start justify-between gap-3 rounded-md border p-3">
                  <div>
                    <Label>Mobile RT 同步</Label>
                    <p className="mt-1 text-xs text-muted-foreground">
                      仅用于 Sub 中由 Mobile RT client
                      同步的账号。关闭时强制只同步 Codex/Responses，避免误用普通
                      Codex RT。
                    </p>
                  </div>
                  <Switch
                    checked={importForm.allowMobileRtImport}
                    disabled={isSub2ApiSyncUnavailable}
                    onCheckedChange={(checked) =>
                      setImportForm((current) => ({
                        ...current,
                        allowMobileRtImport: checked,
                        syncMode: checked ? current.syncMode : "responses",
                      }))
                    }
                  />
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <Select
                    value={importForm.planFilter}
                    onValueChange={(value) =>
                      setImportForm((current) => ({
                        ...current,
                        planFilter: value as Sub2ApiPlanFilter,
                      }))
                    }
                    disabled={isSub2ApiSyncUnavailable}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="套餐筛选" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="non_free">排除 free</SelectItem>
                      <SelectItem value="plus">只导入 plus</SelectItem>
                      <SelectItem value="pro">只导入 pro</SelectItem>
                      <SelectItem value="free">只导入 free</SelectItem>
                      <SelectItem value="all">全部套餐</SelectItem>
                    </SelectContent>
                  </Select>
                  <div className="rounded-md border px-3 py-2 text-xs text-muted-foreground">
                    默认排除 Sub2API 中 plan_type=free 的账号，避免将 team
                    分组里的 free 账号再次导入生图站。
                  </div>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <Select
                    value={effectiveImportSyncMode}
                    onValueChange={(value) =>
                      setImportForm((current) => ({
                        ...current,
                        syncMode: value as TokenSyncMode,
                      }))
                    }
                    disabled={
                      isSub2ApiSyncUnavailable ||
                      !importForm.allowMobileRtImport
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="both">
                        同时同步 Web 和 Codex AT
                      </SelectItem>
                      <SelectItem value="web">只同步 Web AT</SelectItem>
                      <SelectItem value="responses">
                        只同步 Codex/Responses AT
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <div className="flex items-center justify-between rounded-md border px-3">
                    <Label>接入内容安全审核</Label>
                    <Switch
                      checked={importForm.contentSafetyEnabled}
                      disabled={isSub2ApiSyncUnavailable}
                      onCheckedChange={(checked) =>
                        setImportForm((current) => ({
                          ...current,
                          contentSafetyEnabled: checked,
                        }))
                      }
                    />
                  </div>
                  <div className="flex items-start justify-between gap-3 rounded-md border p-3">
                    <div>
                      <Label>覆盖本站异常状态</Label>
                      <p className="mt-1 text-xs text-muted-foreground">
                        同步时以 Sub2API
                        当前状态为准，覆盖本站账号池里的错误、限流和冷却状态。
                      </p>
                    </div>
                    <Switch
                      checked={importForm.overwriteLocalUnavailableState}
                      disabled={isSub2ApiSyncUnavailable}
                      onCheckedChange={(checked) =>
                        setImportForm((current) => ({
                          ...current,
                          overwriteLocalUnavailableState: checked,
                        }))
                      }
                    />
                  </div>
                </div>
                <div className="flex items-start justify-between gap-3 rounded-md border p-3">
                  <div>
                    <Label>创建自动同步任务</Label>
                    <p className="mt-1 text-xs text-muted-foreground">
                      开启后，本次手动同步会先创建或更新任务，再按任务 runner
                      全量执行；Cron
                      和“立即运行”使用同一配置同步新增、状态变化、移出分组或删除的账号。
                    </p>
                  </div>
                  <Switch
                    checked={importForm.createSyncTask}
                    disabled={isSub2ApiSyncUnavailable}
                    onCheckedChange={(checked) =>
                      setImportForm((current) => ({
                        ...current,
                        createSyncTask: checked,
                      }))
                    }
                  />
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <Select
                    value={importForm.webGroupId}
                    onValueChange={(value) =>
                      setImportForm((current) => ({
                        ...current,
                        webGroupId: value,
                      }))
                    }
                    disabled={
                      isSub2ApiSyncUnavailable ||
                      effectiveImportSyncMode === "responses"
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Web 账号分组" />
                    </SelectTrigger>
                    <SelectContent>
                      {groupOptions.map((group) => (
                        <SelectItem key={group.id} value={group.id}>
                          Web：{group.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={importForm.responsesGroupId}
                    onValueChange={(value) =>
                      setImportForm((current) => ({
                        ...current,
                        responsesGroupId: value,
                      }))
                    }
                    disabled={
                      isSub2ApiSyncUnavailable ||
                      effectiveImportSyncMode === "web"
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Codex/Responses 账号分组" />
                    </SelectTrigger>
                    <SelectContent>
                      {groupOptions.map((group) => (
                        <SelectItem key={group.id} value={group.id}>
                          Codex：{group.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-1">
                    <Label>每批扫描数量</Label>
                    <Input
                      type="number"
                      min={1}
                      max={500}
                      value={importForm.limit}
                      disabled={isSub2ApiSyncUnavailable}
                      onChange={(event) =>
                        setImportForm((current) => ({
                          ...current,
                          limit: Number(event.target.value),
                        }))
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      服务端分页批大小，不是同步总数上限。
                    </p>
                  </div>
                  <div className="space-y-1">
                    <Label>自动同步间隔（分钟）</Label>
                    <Input
                      type="number"
                      min={1}
                      value={importForm.intervalMinutes}
                      disabled={
                        isSub2ApiSyncUnavailable || !importForm.createSyncTask
                      }
                      onChange={(event) =>
                        setImportForm((current) => ({
                          ...current,
                          intervalMinutes: Number(event.target.value),
                        }))
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      仅创建任务时保存；内置调度器到点后按任务间隔判断是否运行。
                    </p>
                  </div>
                </div>
                <div className="space-y-3">
                  <Button
                    onClick={runSub2ApiSync}
                    disabled={isSub2ApiSyncUnavailable || isSyncingSub2Api}
                  >
                    {isSyncingSub2Api && (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    )}
                    同步账号
                  </Button>
                  {(isSyncingSub2Api || syncProgress.status !== "idle") && (
                    <div className="space-y-2 rounded-md border p-3">
                      <div className="flex items-center justify-between gap-3 text-sm">
                        <span>{syncProgress.message}</span>
                        <span className="text-muted-foreground">
                          {isSyncingSub2Api ? "同步中" : "已结束"}
                        </span>
                      </div>
                      <Progress
                        value={isSyncingSub2Api ? syncProgress.value : 100}
                      />
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
            <Card className="mt-4">
              <CardHeader>
                <CardTitle className="flex items-center justify-between gap-3 text-base">
                  <span className="flex items-center gap-2">
                    <TimerReset className="h-4 w-4" />
                    自动同步任务
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => loadSub2ApiSyncTasks()}
                    disabled={isLoadingSyncTasks}
                  >
                    {isLoadingSyncTasks ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCw className="mr-2 h-4 w-4" />
                    )}
                    刷新
                  </Button>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  任务由上方同步时创建。Cron
                  会按任务保存的来源分组和筛选条件同步新增、状态变化和删除；删除任务只停止后续管理，不会删除已导入账号。
                </p>
                {!sub2ApiSyncTasks.length ? (
                  <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                    暂无自动同步任务。
                  </div>
                ) : (
                  <div className="space-y-3">
                    {sub2ApiSyncTasks.map((task) => {
                      const sourceLabel =
                        task.sourceGroupName ||
                        task.sourceGroupId ||
                        "全部 Sub2API OpenAI 账号";
                      const isTaskRunning =
                        runningSub2ApiSyncTaskId === task.id &&
                        isRunningSub2ApiSyncTask;
                      return (
                        <div key={task.id} className="rounded-md border p-3">
                          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                            <div className="min-w-0 space-y-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="break-all font-medium">
                                  {sourceLabel}
                                </span>
                                <Badge
                                  variant={
                                    task.enabled ? "default" : "secondary"
                                  }
                                >
                                  {task.enabled ? "启用" : "停用"}
                                </Badge>
                                <Badge variant="outline">
                                  {tokenSyncModeLabel(task.syncMode)}
                                </Badge>
                                <Badge variant="outline">
                                  {sub2ApiPlanFilterLabel(task.planFilter)}
                                </Badge>
                              </div>
                              <p className="break-all text-xs text-muted-foreground">
                                任务 {task.id} · 目标 Codex{" "}
                                {groupName(
                                  groups,
                                  task.responsesGroupId || null
                                )}{" "}
                                · 目标 Web{" "}
                                {groupName(groups, task.webGroupId || null)}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                管理账号 {task.managedAccountCount} · Mobile RT{" "}
                                {task.allowMobileRtImport ? "允许" : "关闭"} ·
                                审核{" "}
                                {task.contentSafetyEnabled ? "开启" : "关闭"} ·
                                覆盖异常{" "}
                                {task.overwriteLocalUnavailableState
                                  ? "开启"
                                  : "关闭"}{" "}
                                · 间隔 {task.intervalMinutes || 720} 分钟 ·
                                上次运行{" "}
                                {formatOptionalDate(
                                  task.lastRunAt || null,
                                  timeZone
                                )}
                              </p>
                              {task.lastResult && (
                                <p className="text-xs text-muted-foreground">
                                  上次结果：来源 {task.lastResult.sourceCount}/
                                  {task.lastResult.totalSourceCount} · 写入{" "}
                                  {task.lastResult.syncedCount} · 失败{" "}
                                  {task.lastResult.failed} · 删除{" "}
                                  {task.lastResult.deletedCount}
                                </p>
                              )}
                            </div>
                            <div className="flex shrink-0 flex-col gap-2 text-xs text-muted-foreground">
                              <Label className="flex items-center justify-between gap-3">
                                启用
                                <Switch
                                  checked={task.enabled}
                                  disabled={isUpdatingSyncTask}
                                  onCheckedChange={(checked) =>
                                    setSub2ApiTaskEnabled({
                                      taskId: task.id,
                                      enabled: checked,
                                    })
                                  }
                                />
                              </Label>
                              <Label className="flex items-center justify-between gap-3">
                                覆盖异常
                                <Switch
                                  checked={task.overwriteLocalUnavailableState}
                                  disabled={isUpdatingSyncTaskOverwrite}
                                  onCheckedChange={(checked) =>
                                    setSub2ApiTaskOverwriteLocalUnavailableState(
                                      {
                                        taskId: task.id,
                                        overwriteLocalUnavailableState: checked,
                                      }
                                    )
                                  }
                                />
                              </Label>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={
                                  isSub2ApiSyncUnavailable ||
                                  isRunningSub2ApiSyncTask
                                }
                                onClick={() => runSub2ApiSyncTaskNow(task)}
                              >
                                {isTaskRunning ? (
                                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                ) : (
                                  <RefreshCw className="mr-2 h-4 w-4" />
                                )}
                                立即运行
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => openSyncTaskEditor(task)}
                              >
                                <Pencil className="mr-2 h-4 w-4" />
                                编辑
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={isDeletingSyncTask}
                                onClick={() => runDeleteSub2ApiSyncTask(task)}
                              >
                                <Trash2 className="mr-2 h-4 w-4" />
                                删除
                              </Button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        )}
        {!readOnly && (
          <TabsContent value="register" className="mt-6">
            <ChatgptRegisterTab
              groups={groups.map((g) => ({ id: g.id, name: g.name }))}
            />
          </TabsContent>
        )}
      </Tabs>

      {!readOnly && (
        <Dialog open={isManualImportOpen} onOpenChange={setIsManualImportOpen}>
          <DialogContent className="flex max-h-[88vh] w-[calc(100vw-2rem)] max-w-3xl flex-col overflow-hidden p-0">
            <DialogHeader>
              <DialogTitle className="px-6 pt-6">批量导入 RT</DialogTitle>
            </DialogHeader>
            <div className="min-w-0 flex-1 space-y-4 overflow-y-auto px-6 pb-6">
              <p className="break-words text-sm text-muted-foreground">
                支持直接粘贴 RT 列表，每行一个；也可以粘贴包含
                refresh_token/refreshToken 的 Auth Session JSON。只有
                accessToken 的 Auth Session 不会在这里导入，请使用“导入 Web
                AT”。默认按 Codex CLI RT 导入；勾选 Mobile RT 后由本站使用
                mobile client_id 换取 AT，并保存刷新后的
                RT。这里导入的账号可在本站继续更新 RT，不会写入
                Sub2API。最多处理前 {MANUAL_TOKEN_IMPORT_LIMIT.toLocaleString()}{" "}
                条， 会按 {MANUAL_RT_IMPORT_BATCH_SIZE} 条一批导入，避免大批量
                RT 换取 AT 时单次请求超时。
              </p>
              <p className="break-words text-sm text-muted-foreground">
                获取 Auth Session 可打开{" "}
                <a
                  className="inline-flex items-center gap-1 text-foreground underline underline-offset-4"
                  href={authSessionUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  Auth Session 接口
                  <ExternalLink className="h-3 w-3" />
                </a>{" "}
                并粘贴页面返回的整段内容。
              </p>
              <Textarea
                className="h-44 min-h-44 max-w-full resize-y overflow-x-hidden whitespace-pre-wrap break-all font-mono text-xs"
                wrap="soft"
                placeholder={`rt_...
或粘贴包含 "refresh_token" / "refreshToken" 的 Auth Session JSON`}
                value={manualImportForm.refreshTokensText}
                onChange={(event) =>
                  setManualImportForm((current) => ({
                    ...current,
                    refreshTokensText: event.target.value,
                  }))
                }
              />
              {(isImportingManualRefreshTokens ||
                manualImportProgress.status !== "idle") && (
                <div className="space-y-2 rounded-md border p-3">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span>{manualImportProgress.message}</span>
                    <span className="text-muted-foreground">
                      {isImportingManualRefreshTokens ? "导入中" : "已结束"}
                    </span>
                  </div>
                  <Progress
                    value={
                      isImportingManualRefreshTokens
                        ? manualImportProgress.value
                        : 100
                    }
                  />
                </div>
              )}
              <div className="flex items-start justify-between gap-3 rounded-md border p-3">
                <div>
                  <Label>Mobile RT 导入</Label>
                  <p className="mt-1 text-xs text-muted-foreground">
                    使用 mobile client_id 获取 AT。关闭时强制只导入
                    Codex/Responses，避免普通 Codex RT 被误用于 Web。
                  </p>
                </div>
                <Switch
                  checked={manualImportForm.useMobileRt}
                  onCheckedChange={(checked) =>
                    setManualImportForm((current) => ({
                      ...current,
                      useMobileRt: checked,
                      syncMode: checked ? current.syncMode : "responses",
                    }))
                  }
                />
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <Select
                  value={effectiveManualImportSyncMode}
                  onValueChange={(value) =>
                    setManualImportForm((current) => ({
                      ...current,
                      syncMode: value as TokenSyncMode,
                    }))
                  }
                  disabled={!manualImportForm.useMobileRt}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="responses">
                      只导入 Codex/Responses
                    </SelectItem>
                    <SelectItem value="web">只导入 Web</SelectItem>
                    <SelectItem value="both">同时导入 Web 和 Codex</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  placeholder="名称前缀"
                  value={manualImportForm.namePrefix}
                  onChange={(event) =>
                    setManualImportForm((current) => ({
                      ...current,
                      namePrefix: event.target.value,
                    }))
                  }
                />
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <Select
                  value={manualImportForm.webGroupId}
                  onValueChange={(value) =>
                    setManualImportForm((current) => ({
                      ...current,
                      webGroupId: value,
                    }))
                  }
                  disabled={effectiveManualImportSyncMode === "responses"}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Web 账号分组" />
                  </SelectTrigger>
                  <SelectContent>
                    {groupOptions.map((group) => (
                      <SelectItem key={group.id} value={group.id}>
                        Web：{group.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={manualImportForm.responsesGroupId}
                  onValueChange={(value) =>
                    setManualImportForm((current) => ({
                      ...current,
                      responsesGroupId: value,
                    }))
                  }
                  disabled={effectiveManualImportSyncMode === "web"}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Codex/Responses 账号分组" />
                  </SelectTrigger>
                  <SelectContent>
                    {groupOptions.map((group) => (
                      <SelectItem key={group.id} value={group.id}>
                        Codex：{group.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-3 md:grid-cols-3">
                <div className="space-y-1.5">
                  <Label className="text-[11px] uppercase tracking-widest text-muted-foreground">
                    模型
                  </Label>
                  <Input
                    placeholder="可选"
                    value={manualImportForm.model}
                    onChange={(event) =>
                      setManualImportForm((current) => ({
                        ...current,
                        model: event.target.value,
                      }))
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[11px] uppercase tracking-widest text-muted-foreground">
                    优先级
                  </Label>
                  <Input
                    type="number"
                    min={0}
                    value={manualImportForm.priority}
                    onChange={(event) =>
                      setManualImportForm((current) => ({
                        ...current,
                        priority: Number(event.target.value),
                      }))
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    数字越小越先调度。
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[11px] uppercase tracking-widest text-muted-foreground">
                    最大并发数
                  </Label>
                  <Input
                    type="number"
                    min={1}
                    max={100}
                    value={manualImportForm.concurrency}
                    onChange={(event) =>
                      setManualImportForm((current) => ({
                        ...current,
                        concurrency: Number(event.target.value),
                      }))
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    作为负载分母，值越大越能分摊请求。
                  </p>
                </div>
              </div>
              <div className="flex items-center justify-between rounded-md border p-3">
                <Label>接入内容安全审核</Label>
                <Switch
                  checked={manualImportForm.contentSafetyEnabled}
                  onCheckedChange={(checked) =>
                    setManualImportForm((current) => ({
                      ...current,
                      contentSafetyEnabled: checked,
                    }))
                  }
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setIsManualImportOpen(false)}
                  disabled={isImportingManualRefreshTokens}
                >
                  取消
                </Button>
                <Button
                  type="button"
                  onClick={runManualRefreshTokenImport}
                  disabled={
                    isImportingManualRefreshTokens ||
                    !manualImportForm.refreshTokensText.trim()
                  }
                >
                  {isImportingManualRefreshTokens && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  导入并获取 AT
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {!readOnly && (
        <Dialog open={isWebAtImportOpen} onOpenChange={setIsWebAtImportOpen}>
          <DialogContent className="flex max-h-[88vh] w-[calc(100vw-2rem)] max-w-3xl flex-col overflow-hidden p-0">
            <DialogHeader>
              <DialogTitle className="px-6 pt-6">批量导入 Web AT</DialogTitle>
            </DialogHeader>
            <div className="min-w-0 flex-1 space-y-4 overflow-y-auto px-6 pb-6">
              <p className="break-words text-sm text-muted-foreground">
                支持粘贴 Web accessToken、Bearer token，或打开{" "}
                <a
                  className="inline-flex items-center gap-1 text-foreground underline underline-offset-4"
                  href={authSessionUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  Auth Session 接口
                  <ExternalLink className="h-3 w-3" />
                </a>{" "}
                后粘贴完整 JSON。Web AT 没有对应
                RT，过期后需要重新导入；该入口只创建 Web 账号，不会创建
                Codex/Responses 账号。
              </p>
              <Textarea
                className="h-44 min-h-44 max-w-full resize-y overflow-x-hidden whitespace-pre-wrap break-all font-mono text-xs"
                wrap="soft"
                placeholder={`Bearer eyJ...
或粘贴 https://chatgpt.com/api/auth/session 返回的完整 JSON`}
                value={webAtImportForm.accessTokensText}
                onChange={(event) =>
                  setWebAtImportForm((current) => ({
                    ...current,
                    accessTokensText: event.target.value,
                  }))
                }
              />
              <div className="grid gap-3 md:grid-cols-2">
                <Select
                  value={webAtImportForm.webGroupId}
                  onValueChange={(value) =>
                    setWebAtImportForm((current) => ({
                      ...current,
                      webGroupId: value,
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Web 账号分组" />
                  </SelectTrigger>
                  <SelectContent>
                    {groupOptions.map((group) => (
                      <SelectItem key={group.id} value={group.id}>
                        Web：{group.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  placeholder="名称前缀"
                  value={webAtImportForm.namePrefix}
                  onChange={(event) =>
                    setWebAtImportForm((current) => ({
                      ...current,
                      namePrefix: event.target.value,
                    }))
                  }
                />
              </div>
              <div className="grid gap-3 md:grid-cols-3">
                <div className="space-y-1.5">
                  <Label className="text-[11px] uppercase tracking-widest text-muted-foreground">
                    模型
                  </Label>
                  <Input
                    placeholder="可选"
                    value={webAtImportForm.model}
                    onChange={(event) =>
                      setWebAtImportForm((current) => ({
                        ...current,
                        model: event.target.value,
                      }))
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[11px] uppercase tracking-widest text-muted-foreground">
                    优先级
                  </Label>
                  <Input
                    type="number"
                    min={0}
                    value={webAtImportForm.priority}
                    onChange={(event) =>
                      setWebAtImportForm((current) => ({
                        ...current,
                        priority: Number(event.target.value),
                      }))
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    数字越小越先调度。
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[11px] uppercase tracking-widest text-muted-foreground">
                    最大并发数
                  </Label>
                  <Input
                    type="number"
                    min={1}
                    max={100}
                    value={webAtImportForm.concurrency}
                    onChange={(event) =>
                      setWebAtImportForm((current) => ({
                        ...current,
                        concurrency: Number(event.target.value),
                      }))
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    作为负载分母，值越大越能分摊请求。
                  </p>
                </div>
              </div>
              <div className="flex items-center justify-between rounded-md border p-3">
                <Label>接入内容安全审核</Label>
                <Switch
                  checked={webAtImportForm.contentSafetyEnabled}
                  onCheckedChange={(checked) =>
                    setWebAtImportForm((current) => ({
                      ...current,
                      contentSafetyEnabled: checked,
                    }))
                  }
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setIsWebAtImportOpen(false)}
                  disabled={isImportingWebAccessTokens}
                >
                  取消
                </Button>
                <Button
                  type="button"
                  onClick={() => importWebAccessTokens(webAtImportForm)}
                  disabled={
                    isImportingWebAccessTokens ||
                    !webAtImportForm.accessTokensText.trim()
                  }
                >
                  {isImportingWebAccessTokens && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  导入 Web AT
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
      {!readOnly && (
        <Dialog
          open={Boolean(editingSyncTask)}
          onOpenChange={(open) => {
            if (!open) setEditingSyncTask(null);
          }}
        >
          <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>编辑自动同步任务</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
                来源范围：
                {editingSyncTask?.sourceGroupName ||
                  editingSyncTask?.sourceGroupId ||
                  "全部 Sub2API OpenAI 账号"}
                。来源分组变化会影响托管账号清理范围，如需更换来源，请删除后重新创建任务。
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="flex items-center justify-between rounded-md border p-3">
                  <Label>启用任务</Label>
                  <Switch
                    checked={syncTaskForm.enabled}
                    onCheckedChange={(checked) =>
                      setSyncTaskForm((current) => ({
                        ...current,
                        enabled: checked,
                      }))
                    }
                  />
                </div>
                <div className="flex items-center justify-between rounded-md border p-3">
                  <Label>Mobile RT 同步</Label>
                  <Switch
                    checked={syncTaskForm.allowMobileRtImport}
                    onCheckedChange={(checked) =>
                      setSyncTaskForm((current) => ({
                        ...current,
                        allowMobileRtImport: checked,
                        syncMode: checked ? current.syncMode : "responses",
                      }))
                    }
                  />
                </div>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <Select
                  value={syncTaskForm.planFilter}
                  onValueChange={(value) =>
                    setSyncTaskForm((current) => ({
                      ...current,
                      planFilter: value as Sub2ApiPlanFilter,
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="non_free">排除 free</SelectItem>
                    <SelectItem value="all">全部套餐</SelectItem>
                    <SelectItem value="plus">只同步 plus</SelectItem>
                    <SelectItem value="pro">只同步 pro</SelectItem>
                    <SelectItem value="free">只同步 free</SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  value={syncTaskForm.syncMode}
                  onValueChange={(value) =>
                    setSyncTaskForm((current) => ({
                      ...current,
                      syncMode: value as TokenSyncMode,
                    }))
                  }
                  disabled={!syncTaskForm.allowMobileRtImport}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="both">同时同步 Web 和 Codex</SelectItem>
                    <SelectItem value="web">只同步 Web</SelectItem>
                    <SelectItem value="responses">
                      只同步 Codex/Responses
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-[11px] uppercase tracking-widest text-muted-foreground">
                  自动同步间隔（分钟）
                </Label>
                <Input
                  type="number"
                  min={1}
                  value={syncTaskForm.intervalMinutes}
                  onChange={(event) =>
                    setSyncTaskForm((current) => ({
                      ...current,
                      intervalMinutes: Number(event.target.value),
                    }))
                  }
                />
                <p className="text-xs text-muted-foreground">
                  内置调度器会定期检查任务；每个任务只在距离上次运行达到该间隔后执行。
                </p>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <Select
                  value={syncTaskForm.webGroupId}
                  onValueChange={(value) =>
                    setSyncTaskForm((current) => ({
                      ...current,
                      webGroupId: value,
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Web 目标分组" />
                  </SelectTrigger>
                  <SelectContent>
                    {groupOptions.map((group) => (
                      <SelectItem key={group.id} value={group.id}>
                        Web：{group.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={syncTaskForm.responsesGroupId}
                  onValueChange={(value) =>
                    setSyncTaskForm((current) => ({
                      ...current,
                      responsesGroupId: value,
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Codex 目标分组" />
                  </SelectTrigger>
                  <SelectContent>
                    {groupOptions.map((group) => (
                      <SelectItem key={group.id} value={group.id}>
                        Codex：{group.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="flex items-center justify-between rounded-md border p-3">
                  <Label>接入内容安全审核</Label>
                  <Switch
                    checked={syncTaskForm.contentSafetyEnabled}
                    onCheckedChange={(checked) =>
                      setSyncTaskForm((current) => ({
                        ...current,
                        contentSafetyEnabled: checked,
                      }))
                    }
                  />
                </div>
                <div className="flex items-start justify-between gap-3 rounded-md border p-3">
                  <div>
                    <Label>覆盖本站异常状态</Label>
                    <p className="mt-1 text-xs text-muted-foreground">
                      同步时使用 Sub2API 当前状态覆盖本站错误、限流和冷却。
                    </p>
                  </div>
                  <Switch
                    checked={syncTaskForm.overwriteLocalUnavailableState}
                    onCheckedChange={(checked) =>
                      setSyncTaskForm((current) => ({
                        ...current,
                        overwriteLocalUnavailableState: checked,
                      }))
                    }
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setEditingSyncTask(null)}
                  disabled={isSavingSyncTask}
                >
                  取消
                </Button>
                <Button
                  type="button"
                  onClick={() => updateSub2ApiSyncTask(syncTaskForm)}
                  disabled={isSavingSyncTask}
                >
                  {isSavingSyncTask && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  保存任务
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
