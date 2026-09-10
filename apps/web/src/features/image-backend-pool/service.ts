/** 后端池服务：在套餐和主分组边界内选择可用成员，并管理租约、重试及成员状态。 */
import { createHash } from "node:crypto";
import { db } from "@repo/database";
import {
  externalApiKey,
  imageBackendAccount,
  imageBackendAccountGroup,
  imageBackendAdobe,
  imageBackendAdobeGroup,
  imageBackendApi,
  imageBackendApiGroup,
  imageBackendGroup,
  imageBackendInflightLease,
  imageBackendSchedulerMetric,
  imageBackendStickyBinding,
  systemSetting,
  userImageBackendPreference,
} from "@repo/database/schema";
import {
  isPlanAtLeast,
  normalizeSubscriptionPlan,
  type SubscriptionPlan,
} from "@repo/shared/config/subscription-plan";
import { validateNestedGroupConfig } from "@repo/shared/image-backend/nested-groups";
import { logWarn } from "@repo/shared/logger";
import { canUsePlanCapability } from "@repo/shared/subscription/services/plan-capabilities";
import { getUserPlan } from "@repo/shared/subscription/services/user-plan";
import {
  clearSystemSettingsCache,
  getRuntimeSettingJson,
  getRuntimeSettingNumber,
  getRuntimeSettingString,
} from "@repo/shared/system-settings";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNull,
  lt,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { nanoid } from "nanoid";
import { Pool } from "pg";

import {
  type ChatGptWebAccountInfo,
  getChatGptWebAccountInfo,
} from "@/features/image-generation/chatgpt-web";
import {
  isContentSafetyRejection,
  USER_INPUT_LIMIT_PATTERNS,
  USER_INVALID_IMAGE_PATTERNS,
} from "@/features/image-generation/sla-classification";
import type { ApiConfig } from "@/features/image-generation/types";

import {
  imageBackendApiInterfaceAllowsRequest,
  normalizeChatCompletionsUpstreamMode,
  normalizeImageBackendApiInterfaceMode,
  normalizeImagesUpstreamMode,
} from "./api-interface-mode";
import {
  getEffectiveBillingMultiplierForSelectedGroup,
  getGroupBillingMultiplier,
} from "./group-billing";
import {
  checkImageBackendApiHealth,
  type ImageApiHealthResult,
} from "./health-check";
import { parseImportTokensText } from "./import-token-parser";
import { resolvePoolModelRouting } from "./model-routing";
import type {
  AdminImageBackendAccountListOptions,
  AdminImageBackendAccountStatusFilter,
  AdminImageBackendAccountSummary,
  ChatCompletionsUpstreamMode,
  ContentSafetyOverride,
  ImageBackendAccountBackend,
  ImageBackendAccountPlanFilter,
  ImageBackendApiInterfaceMode,
  ImageBackendGroupBackendType,
  ImageBackendGroupSummary,
  ImageBackendPreferenceMode,
  ImageBackendRequestKind,
  ImagesUpstreamMode,
} from "./types";
import {
  chatGptAccountIdFromAccessToken,
  mergeChatGptAccountIdMetadata,
} from "./web-account-metadata";

const MANUAL_TOKEN_IMPORT_LIMIT = 10_000;
const IMAGE_BACKEND_INFLIGHT_LEASE_TTL_MS = 30 * 60_000;
const MAX_BACKEND_STALE_SELECTION_RETRIES = 100;
// 满并发短等(仅 web 偏好阶段):真·web 成员(非常驻 web 账号/API)仅因并发占满而暂不可用
// 时,短延迟后重选、给它让出并发槽再试的机会,避免 web 车道尚未轮询完就回退 codex。两参数
// 经 env 覆盖(默认 3 次 ×300ms ≈ 0.9s 上限)。
const MAX_WEB_CAPACITY_WAIT_RETRIES = readPositiveIntEnv(
  "IMAGE_BACKEND_WEB_CAPACITY_WAIT_RETRIES",
  3
);
const WEB_CAPACITY_WAIT_DELAY_MS = readPositiveIntEnv(
  "IMAGE_BACKEND_WEB_CAPACITY_WAIT_DELAY_MS",
  300
);
const STICKY_PREVIOUS_RESPONSE_TTL_MS = 24 * 60 * 60_000;
const STICKY_SESSION_TTL_MS = 60 * 60_000;

// 读取正整数 env,缺失或非法回退默认值。
function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// 短延迟工具(满并发短等用)。
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type BackendLeaseTx = Pick<
  typeof db,
  "delete" | "execute" | "insert" | "select" | "update"
>;

type BackendLeaseAcquireResult = "acquired" | "full" | "stale";

type ResolveBackendOptions = {
  userId: string;
  apiKeyId?: string;
  requestKind: ImageBackendRequestKind;
  // 请求模型：纯 Web 主组的图片请求统一用 GPT Image 2.5；其他组保留 Firefly 前缀路由。
  // chat 的顶层模型是文本模型，不随图片型号归一而更改。
  requestedModel?: string;
  preferredMemberId?: string;
  preferredMemberType?: "api" | "account" | "adobe";
  stickyPreviousResponseId?: string;
  stickySessionKey?: string;
  accountBackendPreference?: ImageBackendAccountBackend;
  accountBackendPreferenceMode?: ImageBackendPreferenceMode;
  // 账号 plan 过滤(opt-in,默认 "any" 不过滤)。"paid" 仅选付费级账号,供 PPT/PSD
  // 可编辑文件生成用(代码解释器限付费)。只作用于 account 候选,不影响 api/adobe。
  accountPlanFilter?: ImageBackendAccountPlanFilter;
  // 非纯 Web 主组可强制走 Adobe；纯 Web 主组固定图片型号的规则优先于此标志。
  forceFirefly?: boolean;
  allowAnyResponsesBackend?: boolean;
  // 跨组选真 web 账号(忽略 apiKeyId/用户偏好的分组作用域):PPT/PSD 可编辑文件生成必须用
  // ChatGPT 网页(付费)账号,而付费 web 账号集中在专用分组(如 Pro-Web),外部 API key 绑定
  // 的分组往往够不到。开启后遍历全部启用分组、只取 accountBackend==="web" 的成员(配合
  // accountPlanFilter="paid"),使 editable-file 像站内 UI 一样稳定命中付费 web,不受 key 分组限制。
  spanGroupsForWeb?: boolean;
};

type StickyBindingMember = {
  type: "api" | "account" | "adobe";
  id: string;
  groupId?: string | null;
  accountBackend?: "web" | "responses";
};

type SchedulerSelectionLayer =
  | "previous_response_id"
  | "session_hash"
  | "preferred"
  | "load_balance";

type PoolMember =
  | {
      type: "api";
      id: string;
      alwaysActive: boolean;
      groupId: string | null;
      groupIds: string[];
      groupMetadata: Record<string, unknown> | null;
      groupContentSafetyEnabled: boolean | null;
      name: string;
      baseUrl: string;
      apiKey: string;
      model: string | null;
      interfaceMode: ImageBackendApiInterfaceMode;
      chatCompletionsUpstreamMode: ChatCompletionsUpstreamMode;
      imagesUpstreamMode: ImagesUpstreamMode;
      useStream: boolean;
      // Adobe 来源：上游实为 Adobe 的 gpt 格式 api。开启后计费套用下方 billingMultiplier
      // （与分组倍率相乘，复用 Adobe 伪账号倍率链），并参与 firefly 候选（含反向转换）。
      adobeSourced: boolean;
      // 计费倍率（仅当 adobeSourced 时生效）。
      billingMultiplier: number;
      contentSafetyEnabled: boolean;
      priority: number;
      concurrency: number;
      leaseId?: string;
      leasePersisted?: boolean;
      leaseTouchedMember?: boolean;
      schedulerLayer?: SchedulerSelectionLayer;
      lastUsedAt: Date | null;
      lastAcquiredAt: Date | null;
      createdAt: Date;
      metadata: Record<string, unknown> | null;
    }
  | {
      type: "account";
      id: string;
      alwaysActive: boolean;
      groupId: string | null;
      groupIds: string[];
      groupMetadata: Record<string, unknown> | null;
      groupContentSafetyEnabled: boolean | null;
      name: string;
      accessToken: string;
      model: string | null;
      implementationMode: string;
      contentSafetyEnabled: boolean;
      priority: number;
      concurrency: number;
      leaseId?: string;
      leasePersisted?: boolean;
      leaseTouchedMember?: boolean;
      schedulerLayer?: SchedulerSelectionLayer;
      lastUsedAt: Date | null;
      lastAcquiredAt: Date | null;
      createdAt: Date;
      metadata: Record<string, unknown> | null;
    }
  | {
      // Adobe Firefly（adobe2api）后端成员。与 api 类似（baseUrl + apiKey），但请求/
      // 响应走 adobe 适配器（model id 编码宽高比/分辨率、产物为 URL 需 re-host）。
      type: "adobe";
      id: string;
      alwaysActive: boolean;
      groupId: string | null;
      groupIds: string[];
      groupMetadata: Record<string, unknown> | null;
      groupContentSafetyEnabled: boolean | null;
      name: string;
      // gateway：外部 adobe2api；direct：本仓库直连 Firefly。
      mode: string;
      baseUrl: string;
      apiKey: string;
      enabledModels: string[] | null;
      defaultRatio: string;
      defaultResolution: string;
      gptImageQuality: string;
      // 本 Adobe 后端的计费倍率（图像+视频统一）；与分组倍率相乘。
      billingMultiplier: number;
      supportsVideo: boolean;
      contentSafetyEnabled: boolean;
      priority: number;
      concurrency: number;
      leaseId?: string;
      leasePersisted?: boolean;
      leaseTouchedMember?: boolean;
      schedulerLayer?: SchedulerSelectionLayer;
      lastUsedAt: Date | null;
      lastAcquiredAt: Date | null;
      createdAt: Date;
      metadata: Record<string, unknown> | null;
    };

export type ResolvedImageBackendPoolConfig = {
  config: ApiConfig;
  groupId: string | null;
  memberId: string;
  memberType: "api" | "account" | "adobe";
  contentSafetyEnabled: boolean;
  schedulerLayer?: SchedulerSelectionLayer;
};

export class ImageBackendPoolUnavailableError extends Error {
  constructor(message = "当前生图后端分组没有可用账号或 API") {
    super(message);
    this.name = "ImageBackendPoolUnavailableError";
  }
}

export type ImageBackendReportResultInput = {
  memberType?: "api" | "account" | "adobe";
  memberId?: string;
  success: boolean;
  error?: string | null;
  upstreamResetAt?: string | Date | null;
  retryAfterSeconds?: number | null;
  durationMs?: number | null;
};

export type ImageBackendReportResultOutcome = {
  success: boolean;
  status?: string;
  cooldownUntil?: Date | null;
  retryable: boolean;
  switchable: boolean;
};

type WebAccountRuntimeMetadata = ChatGptWebAccountInfo & {
  refreshedAt?: string;
};

type BackendMetadata = Record<string, unknown> & {
  source?: string;
  chatgptAccountId?: string;
  webAccount?: Partial<WebAccountRuntimeMetadata>;
  scheduler?: BackendSchedulerMetadata;
};

type BackendSchedulerMetadata = {
  errorEwma?: number;
  durationMsEwma?: number;
  successStreak?: number;
  failStreak?: number;
  lastObservedAt?: string;
};

type ImageBackendGroupMetadata = Record<string, unknown> & {
  minPlan?: unknown;
  backendType?: unknown;
  childGroupIds?: unknown;
  billingMultiplier?: unknown;
  creditMultiplier?: unknown;
  costMultiplier?: unknown;
};

type SelectableGroupContext = {
  id: string;
  metadata: Record<string, unknown> | null;
  contentSafetyEnabled: boolean | null;
};

const CHATGPT_CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex";
const CODEX_CLI_VERSION = "0.125.0";
const CODEX_CLI_USER_AGENT = `codex_cli_rs/${CODEX_CLI_VERSION}`;
const OPENAI_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_PLATFORM_OAUTH_CLIENT_ID = "app_2SKx67EdpoN0G6j64rFvigXD";
const OPENAI_MOBILE_RT_CLIENT_ID = "app_LlGpXReQgckcGGUo2JrYvtJK";
const OPENAI_REFRESH_SCOPES = "openid profile email";
const AUTO_SUB2API_SYNC_STATE_KEY = "SUB2API_AUTO_SYNC_STATE";
const AUTO_SUB2API_SYNC_TASKS_KEY = "SUB2API_AUTO_SYNC_TASKS";
const DEFAULT_BACKEND_COOLDOWN_MINUTES = 15;
// 工具级限流(ChatGPT image_gen.text2im)默认冷却分钟:滚动限流恢复快,比通用兜底更短。
const DEFAULT_TOOL_RATE_LIMIT_COOLDOWN_MINUTES = 3;
const MAX_PARSED_RESET_COOLDOWN_DAYS = 14;
// 冷却地板:上游/源给的重置时间若过短(典型:per-min 429 的 "try again in 15ms"),
// 直接采纳会让冷却≈0、账号被立刻重选再撞限流。低于地板一律抬到地板。真·用量限制
// (5h/7d)重置远大于地板,不受影响。
const MIN_RESET_COOLDOWN_MS = 60_000;

// 全量同步进度(进程内):同一时刻只跑一个全量同步,故用单槽即可;startedAt 供前端
// 区分是否为本次发起。best-effort,绝不影响同步本身。前端轮询取不到时回退渐进动画。
let sub2ApiSyncProgress: {
  processed: number;
  total: number;
  startedAt: number;
} | null = null;

export function readSub2ApiSyncProgress() {
  return sub2ApiSyncProgress;
}
// 健康度 EWMA 平滑系数:近期结果权重。0.4 比旧 0.2 反应快一倍——对账号"变差/恢复"
// 双向都更实时(一次失败即把 errorEwma 明显抬高、一次成功也更快回落),代价是轻微抖动,
// 由冷却(硬失败)与下方时间衰减共同兜底,可接受。
const BACKEND_SCHEDULER_EWMA_ALPHA = 0.4;
// 健康惩罚按"距上次观测时长"做指数衰减的半衰期(毫秒):age=半衰期时惩罚减半。
// 让久未观测的旧惩罚淡出,疑似已恢复/闲置的号重新参与轮换、定期复探,提升实时性。
const BACKEND_HEALTH_PENALTY_HALF_LIFE_MS = 180_000;
const DEFAULT_UNRECOVERABLE_BACKEND_ERROR_KEYWORDS = [
  "refresh token",
  "invalid refresh token",
  "invalid_refresh_token",
  "invalid_grant",
  "authentication",
  "authentication failed",
  "token_invalidated",
  "token_revoked",
  "account deactivated",
  "deactivated account",
  "deactivated_workspace",
  "workspace deactivated",
  "organization has been disabled",
  "identity verification is required",
];
const backendInflight = new Map<string, number>();

export function resetImageBackendInflightForTests() {
  if (process.env.NODE_ENV === "test") {
    backendInflight.clear();
  }
}

function isMissingBackendLeaseTableError(error: unknown) {
  const code =
    typeof error === "object" && error && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  const message = error instanceof Error ? error.message : String(error);
  return code === "42P01" || message.includes("image_backend_inflight_lease");
}

function isMissingBackendStickyTableError(error: unknown) {
  const code =
    typeof error === "object" && error && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  const message = error instanceof Error ? error.message : String(error);
  return code === "42P01" || message.includes("image_backend_sticky_binding");
}

function isMissingBackendSchedulerMetricTableError(error: unknown) {
  const code =
    typeof error === "object" && error && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  const message = error instanceof Error ? error.message : String(error);
  return code === "42P01" || message.includes("image_backend_scheduler_metric");
}

function normalizeAccountBackend(
  value?: string | null
): ImageBackendAccountBackend {
  return value === "responses" ? "responses" : "web";
}

function normalizeGroupBackendType(
  value?: unknown
): ImageBackendGroupBackendType {
  return value === "web" || value === "responses" ? value : "mixed";
}

function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

export function hashBackendCredential(value: string) {
  return createHash("sha256").update(value.trim()).digest("hex");
}

export function fromSafetyOverride(value: ContentSafetyOverride) {
  if (value === "enabled") return true;
  if (value === "disabled") return false;
  return null;
}

function effectiveContentSafety(
  groupValue: boolean | null,
  memberValue: boolean
) {
  return groupValue ?? memberValue;
}

function asGroupMetadata(
  metadata: Record<string, unknown> | null | undefined
): ImageBackendGroupMetadata {
  return metadata && typeof metadata === "object" ? metadata : {};
}

function getGroupMinPlan(
  metadata: Record<string, unknown> | null | undefined
): SubscriptionPlan {
  return normalizeSubscriptionPlan(asGroupMetadata(metadata).minPlan, "free");
}

function getGroupBackendType(
  metadata: Record<string, unknown> | null | undefined
) {
  return normalizeGroupBackendType(asGroupMetadata(metadata).backendType);
}

// 池成员(api / account / adobe)按其所在分组的 backendType 决定参与哪个"车道阶段"。
// 阶段(web / codex)参与与否【纯由车道决定】,与"该后端能否服务某请求类型(images vs
// responses 端点)"是两件独立的事——后者由 requestKind 维度的接口判定负责,绝不在此用
// 阶段去卡(否则 codex 阶段会误把 images 端点的 API 挡在门外)。
// - mixed 分组(直接挂在混合分组):不区分车道,任何偏好阶段都参与(谁都可请求);
// - web 分组:仅当请求当前偏好为 web 时参与;responses(codex)分组:仅 codex 阶段参与;
// - firefly 请求(fireflyOnly,必走 adobe)或请求无偏好时:不受车道限制。
export function memberAllowedForPhase(
  groupBackendType: ImageBackendGroupBackendType,
  effectivePreference: ImageBackendAccountBackend | undefined,
  fireflyOnly: boolean
): boolean {
  return (
    fireflyOnly ||
    !effectivePreference ||
    groupBackendType === "mixed" ||
    groupBackendType === effectivePreference
  );
}

// 满并发短等候选判定(纯函数,便于 DB-free 单测)。仅当:web 偏好阶段 + 非常驻 + 是 web
// 账号或 web API + 当前正因并发占满(atCapacity)而暂不可用时,才值得"短等"——给它让出并发
// 槽再试的机会,避免真·web 车道未轮询完就回退 codex。
// 常驻刻意排除:常驻永不冷却/下线、几乎恒在场,其满并发不构成"web 仍有可用候选",不为它
// 推迟回退(否则会被常驻永久卡住回退,详见车道兜底设计)。冷却成员不在调用方传入的集合里
// (已被 DB WHERE 滤除并视作"已尝试"),天然不参与短等。
export function isWebCapacityWaitCandidate(
  member: { type: "api" | "account" | "adobe"; alwaysActive: boolean },
  effectivePreference: ImageBackendAccountBackend | undefined,
  atCapacity: boolean
): boolean {
  return (
    effectivePreference === "web" &&
    (member.type === "api" || member.type === "account") &&
    !member.alwaysActive &&
    atCapacity
  );
}

function normalizeGroupChildGroupIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean)
    )
  );
}

function getGroupChildGroupIds(
  metadata: Record<string, unknown> | null | undefined
) {
  return normalizeGroupChildGroupIds(asGroupMetadata(metadata).childGroupIds);
}

function normalizeAccountGroupIds(
  groupIds?: readonly (string | null | undefined)[] | null
) {
  if (!groupIds) return [];
  return Array.from(
    new Set(
      groupIds
        .map((groupId) => (typeof groupId === "string" ? groupId.trim() : ""))
        .filter((groupId) => groupId && groupId !== "default")
    )
  );
}

function accountGroupIdsFromInput(input: {
  groupId?: string | null;
  groupIds?: string[] | null;
}) {
  if (input.groupIds !== undefined) {
    return normalizeAccountGroupIds(input.groupIds);
  }
  return normalizeAccountGroupIds(input.groupId ? [input.groupId] : []);
}

function groupBackendAllowsRequest(
  metadata: Record<string, unknown> | null | undefined,
  requestKind: ImageBackendRequestKind
) {
  const backendType = getGroupBackendType(metadata);
  if (requestKind === "responses") {
    return backendType === "responses" || backendType === "mixed";
  }
  return true;
}

function groupBackendAllowsAccount(
  metadata: Record<string, unknown> | null | undefined,
  backend: ImageBackendAccountBackend
) {
  const backendType = getGroupBackendType(metadata);
  return backendType === "mixed" || backendType === backend;
}

function resolveEffectiveAccountBackendPreference(
  metadata: Record<string, unknown> | null | undefined,
  preference?: ImageBackendAccountBackend,
  mode?: ImageBackendPreferenceMode
) {
  if (!preference) return undefined;
  if (mode === "mixed-only" && getGroupBackendType(metadata) !== "mixed") {
    return undefined;
  }
  return preference;
}

function accountBackendAllowsRequest(
  backend: ImageBackendAccountBackend,
  requestKind: ImageBackendRequestKind
) {
  if (requestKind === "responses") return backend === "responses";
  return true;
}

function canUseBackendGroupForPlan(
  metadata: Record<string, unknown> | null | undefined,
  plan: SubscriptionPlan
) {
  return isPlanAtLeast(plan, getGroupMinPlan(metadata));
}

function memberTimestamp(value: Date | string | null | undefined) {
  if (!value) return 0;
  return new Date(value).getTime();
}

function healthBucket(member: PoolMember) {
  return Math.floor(backendHealthPenalty(member) * 100);
}

function parseDurationMs(value: string) {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  if (/^\d+(?:\.\d+)?\s*ms$/.test(trimmed)) {
    return Number.parseFloat(trimmed) || null;
  }
  if (/^\d+(?:\.\d+)?\s*s$/.test(trimmed)) {
    return Number.parseFloat(trimmed) * 1000;
  }
  if (/^\d+(?:\.\d+)?\s*m$/.test(trimmed)) {
    return Number.parseFloat(trimmed) * 60_000;
  }
  if (/^\d+(?:\.\d+)?\s*h$/.test(trimmed)) {
    return Number.parseFloat(trimmed) * 60 * 60_000;
  }
  if (/^\d+(?:\.\d+)?\s*d(?:ay|ays)?$/.test(trimmed)) {
    return Number.parseFloat(trimmed) * 24 * 60 * 60_000;
  }
  const parts = [
    ...trimmed.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|day|days)/g),
  ];
  if (!parts.length) return null;
  const total = parts.reduce((sum, match) => {
    const amount = Number.parseFloat(match[1] || "0");
    const unit = match[2];
    if (unit === "ms") return sum + amount;
    if (unit === "s") return sum + amount * 1000;
    if (unit === "m") return sum + amount * 60_000;
    if (unit === "h") return sum + amount * 60 * 60_000;
    if (unit === "d" || unit === "day" || unit === "days") {
      return sum + amount * 24 * 60 * 60_000;
    }
    return sum;
  }, 0);
  return total > 0 ? total : null;
}

function backendKey(member: Pick<PoolMember, "type" | "id">) {
  return `${member.type}:${member.id}`;
}

function stickyScope(layer: "previous_response_id" | "session_hash") {
  return layer;
}

function normalizeStickyBindingMember(
  value: StickyBindingMember | undefined
): StickyBindingMember | undefined {
  if (!value?.id) return undefined;
  if (value.type !== "api" && value.type !== "account") return undefined;
  return {
    type: value.type,
    id: value.id,
    groupId: value.groupId ?? null,
    accountBackend: value.accountBackend,
  };
}

export async function bindImageBackendStickyMember(input: {
  layer: "previous_response_id" | "session_hash";
  key?: string | null;
  member?: StickyBindingMember;
  ttlMs?: number;
  metadata?: Record<string, unknown> | null;
}) {
  const key = input.key?.trim();
  const member = normalizeStickyBindingMember(input.member);
  if (!key || !member) return;
  const now = new Date();
  const ttlMs =
    input.ttlMs ??
    (input.layer === "previous_response_id"
      ? STICKY_PREVIOUS_RESPONSE_TTL_MS
      : STICKY_SESSION_TTL_MS);
  const expiresAt = new Date(now.getTime() + Math.max(60_000, ttlMs));
  try {
    await db
      .insert(imageBackendStickyBinding)
      .values({
        id: nanoid(),
        scope: stickyScope(input.layer),
        bindingKey: key,
        memberType: member.type,
        memberId: member.id,
        groupId: member.groupId ?? null,
        accountBackend: member.accountBackend ?? null,
        expiresAt,
        metadata: input.metadata ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          imageBackendStickyBinding.scope,
          imageBackendStickyBinding.bindingKey,
        ],
        set: {
          memberType: member.type,
          memberId: member.id,
          groupId: member.groupId ?? null,
          accountBackend: member.accountBackend ?? null,
          expiresAt,
          metadata: input.metadata ?? null,
          updatedAt: now,
        },
      });
  } catch (error) {
    if (isMissingBackendStickyTableError(error)) return;
    logWarn("写入生图后端粘性映射失败", {
      layer: input.layer,
      memberType: member.type,
      memberId: member.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function resolveStickyBinding(input: {
  layer: "previous_response_id" | "session_hash";
  key?: string | null;
}): Promise<StickyBindingMember | null> {
  const key = input.key?.trim();
  if (!key) return null;
  const now = new Date();
  try {
    const [row] = await db
      .select({
        memberType: imageBackendStickyBinding.memberType,
        memberId: imageBackendStickyBinding.memberId,
        groupId: imageBackendStickyBinding.groupId,
        accountBackend: imageBackendStickyBinding.accountBackend,
      })
      .from(imageBackendStickyBinding)
      .where(
        and(
          eq(imageBackendStickyBinding.scope, stickyScope(input.layer)),
          eq(imageBackendStickyBinding.bindingKey, key),
          gt(imageBackendStickyBinding.expiresAt, now)
        )
      )
      .limit(1);
    if (!row) return null;
    const member = normalizeStickyBindingMember({
      type: row.memberType === "api" ? "api" : "account",
      id: row.memberId,
      groupId: row.groupId,
      accountBackend:
        row.accountBackend === "web" || row.accountBackend === "responses"
          ? row.accountBackend
          : undefined,
    });
    if (!member) return null;
    await db
      .update(imageBackendStickyBinding)
      .set({
        lastHitAt: now,
        hitCount: sql`${imageBackendStickyBinding.hitCount} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(imageBackendStickyBinding.scope, stickyScope(input.layer)),
          eq(imageBackendStickyBinding.bindingKey, key)
        )
      );
    return member;
  } catch (error) {
    if (isMissingBackendStickyTableError(error)) return null;
    logWarn("读取生图后端粘性映射失败", {
      layer: input.layer,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function schedulerMetricBucket(date = new Date()) {
  const bucket = new Date(date);
  bucket.setMinutes(0, 0, 0);
  return bucket;
}

async function recordSchedulerMetric(input: {
  requestKind?: ImageBackendRequestKind;
  layer: SchedulerSelectionLayer | "switch";
  memberType?: "api" | "account" | "adobe" | null;
  memberId?: string | null;
  groupId?: string | null;
  candidateCount?: number;
  latencyMs?: number;
  switchCount?: number;
}) {
  const now = new Date();
  const requestKind = input.requestKind || "image_generation";
  const selectedLayer = input.layer;
  const stickyPreviousHitCount =
    selectedLayer === "previous_response_id" ? 1 : 0;
  const stickySessionHitCount = selectedLayer === "session_hash" ? 1 : 0;
  const loadBalanceCount = selectedLayer === "load_balance" ? 1 : 0;
  const switchCount = Math.max(0, Math.trunc(input.switchCount || 0));
  const selectCount = selectedLayer === "switch" ? 0 : 1;
  const candidateCount = Math.max(0, Math.trunc(input.candidateCount || 0));
  const latencyMs = Math.max(0, Math.trunc(input.latencyMs || 0));
  const memberType = input.memberType ?? "";
  const memberId = input.memberId ?? "";
  const groupId = input.groupId ?? "";
  try {
    await db
      .insert(imageBackendSchedulerMetric)
      .values({
        id: nanoid(),
        bucketStartedAt: schedulerMetricBucket(now),
        requestKind,
        selectedLayer,
        memberType,
        memberId,
        groupId,
        selectCount,
        stickyPreviousHitCount,
        stickySessionHitCount,
        loadBalanceCount,
        switchCount,
        candidateCountTotal: candidateCount,
        latencyMsTotal: latencyMs,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          imageBackendSchedulerMetric.bucketStartedAt,
          imageBackendSchedulerMetric.requestKind,
          imageBackendSchedulerMetric.selectedLayer,
          imageBackendSchedulerMetric.memberType,
          imageBackendSchedulerMetric.memberId,
          imageBackendSchedulerMetric.groupId,
        ],
        set: {
          selectCount: sql`${imageBackendSchedulerMetric.selectCount} + ${selectCount}`,
          stickyPreviousHitCount: sql`${imageBackendSchedulerMetric.stickyPreviousHitCount} + ${stickyPreviousHitCount}`,
          stickySessionHitCount: sql`${imageBackendSchedulerMetric.stickySessionHitCount} + ${stickySessionHitCount}`,
          loadBalanceCount: sql`${imageBackendSchedulerMetric.loadBalanceCount} + ${loadBalanceCount}`,
          switchCount: sql`${imageBackendSchedulerMetric.switchCount} + ${switchCount}`,
          candidateCountTotal: sql`${imageBackendSchedulerMetric.candidateCountTotal} + ${candidateCount}`,
          latencyMsTotal: sql`${imageBackendSchedulerMetric.latencyMsTotal} + ${latencyMs}`,
          updatedAt: now,
        },
      });
  } catch (error) {
    if (isMissingBackendSchedulerMetricTableError(error)) return;
    logWarn("记录生图后端调度指标失败", {
      requestKind,
      selectedLayer,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function recordImageBackendSchedulerSwitch(input: {
  requestKind?: ImageBackendRequestKind;
  memberType?: "api" | "account" | "adobe" | null;
  memberId?: string | null;
  groupId?: string | null;
}) {
  await recordSchedulerMetric({
    ...input,
    layer: "switch",
    switchCount: 1,
  });
}

function backendInflightCount(member: Pick<PoolMember, "type" | "id">) {
  return backendInflight.get(backendKey(member)) || 0;
}

function backendConcurrency(member: Pick<PoolMember, "concurrency">) {
  return Math.max(1, Math.floor(member.concurrency || 1));
}

function finiteNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeSchedulerMetadata(
  metadata: Record<string, unknown> | null | undefined
): BackendSchedulerMetadata {
  const raw =
    metadata && typeof metadata.scheduler === "object" && metadata.scheduler
      ? (metadata.scheduler as Record<string, unknown>)
      : {};
  const errorEwma = finiteNumber(raw.errorEwma);
  const durationMsEwma = finiteNumber(raw.durationMsEwma);
  const successStreak = finiteNumber(raw.successStreak);
  const failStreak = finiteNumber(raw.failStreak);
  return {
    ...(errorEwma !== null
      ? { errorEwma: Math.max(0, Math.min(1, errorEwma)) }
      : {}),
    ...(durationMsEwma !== null
      ? { durationMsEwma: Math.max(0, durationMsEwma) }
      : {}),
    ...(successStreak !== null
      ? { successStreak: Math.max(0, Math.trunc(successStreak)) }
      : {}),
    ...(failStreak !== null
      ? { failStreak: Math.max(0, Math.trunc(failStreak)) }
      : {}),
    ...(typeof raw.lastObservedAt === "string"
      ? { lastObservedAt: raw.lastObservedAt }
      : {}),
  };
}

function ewma(previous: number | undefined, sample: number) {
  if (previous === undefined || !Number.isFinite(previous)) return sample;
  return (
    previous * (1 - BACKEND_SCHEDULER_EWMA_ALPHA) +
    sample * BACKEND_SCHEDULER_EWMA_ALPHA
  );
}

function nextSchedulerMetadataAfterResult(
  metadata: Record<string, unknown> | null | undefined,
  input: Pick<ImageBackendReportResultInput, "success" | "durationMs">,
  now: Date
): Record<string, unknown> {
  const base =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? { ...metadata }
      : {};
  const previous = normalizeSchedulerMetadata(base);
  const durationMs =
    typeof input.durationMs === "number" && Number.isFinite(input.durationMs)
      ? Math.max(0, input.durationMs)
      : undefined;
  const next: BackendSchedulerMetadata = {
    errorEwma: ewma(previous.errorEwma, input.success ? 0 : 1),
    successStreak: input.success ? (previous.successStreak || 0) + 1 : 0,
    failStreak: input.success ? 0 : (previous.failStreak || 0) + 1,
    lastObservedAt: now.toISOString(),
    ...(durationMs !== undefined
      ? { durationMsEwma: ewma(previous.durationMsEwma, durationMs) }
      : previous.durationMsEwma !== undefined
        ? { durationMsEwma: previous.durationMsEwma }
        : {}),
  };
  return {
    ...base,
    scheduler: next,
  };
}

// 按距上次观测的时长对惩罚做指数衰减:刚观测(age≈0)≈1 全额;久未观测逐步趋 0。
// 无 lastObservedAt(从未观测)或时间异常时不衰减(返回 1),保持旧行为。
function recencyDecay(lastObservedAt: string | undefined) {
  if (!lastObservedAt) return 1;
  const observedMs = new Date(lastObservedAt).getTime();
  if (!Number.isFinite(observedMs)) return 1;
  const ageMs = Date.now() - observedMs;
  if (ageMs <= 0) return 1;
  return 0.5 ** (ageMs / BACKEND_HEALTH_PENALTY_HALF_LIFE_MS);
}

function backendHealthPenalty(member: PoolMember) {
  const scheduler = normalizeSchedulerMetadata(member.metadata);
  const errorPenalty = (scheduler.errorEwma || 0) * 100;
  const durationMs = scheduler.durationMsEwma || 0;
  const durationPenalty = Math.min(25, durationMs / 10_000);
  const failStreakPenalty = Math.min(20, (scheduler.failStreak || 0) * 3);
  const successRecovery = Math.min(8, (scheduler.successStreak || 0) * 0.5);
  const raw =
    errorPenalty + durationPenalty + failStreakPenalty - successRecovery;
  // 实时性:刚失败的号全额计入惩罚(立即降级);久未观测的旧惩罚指数淡出,让疑似已
  // 恢复/闲置的号重新进轮换、定期复探,评分反映"当前"而非"陈年"状态。
  return raw * recencyDecay(scheduler.lastObservedAt);
}

function hasBackendCapacity(member: PoolMember) {
  return backendInflightCount(member) < backendConcurrency(member);
}

function sameMemberTimestamp(
  left: Date | string | null | undefined,
  right: Date | string | null | undefined
) {
  return memberTimestamp(left) === memberTimestamp(right);
}

async function pruneExpiredBackendLeases(
  tx: BackendLeaseTx,
  member: Pick<PoolMember, "type" | "id">,
  now: Date
) {
  await tx
    .delete(imageBackendInflightLease)
    .where(
      and(
        eq(imageBackendInflightLease.memberType, member.type),
        eq(imageBackendInflightLease.memberId, member.id),
        lt(imageBackendInflightLease.expiresAt, now)
      )
    );
}

async function acquirePoolMemberInflightLease(
  member: PoolMember,
  options?: { enforceLastAcquiredSnapshot?: boolean }
): Promise<BackendLeaseAcquireResult> {
  if (!hasBackendCapacity(member)) return "full";
  const leaseId = nanoid();
  let persisted = false;
  let touchedMember = false;
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + IMAGE_BACKEND_INFLIGHT_LEASE_TTL_MS
  );
  if (typeof db.transaction !== "function") {
    acquireImageBackendInflight({
      memberType: member.type,
      memberId: member.id,
    });
    member.leaseId = leaseId;
    member.leasePersisted = false;
    member.leaseTouchedMember = false;
    return "acquired";
  }

  try {
    const acquired = await db.transaction(async (tx) => {
      let lockedLastAcquiredAt: Date | string | null | undefined;
      if (member.type === "api") {
        const [locked] = await tx
          .select({ lastAcquiredAt: imageBackendApi.lastAcquiredAt })
          .from(imageBackendApi)
          .where(eq(imageBackendApi.id, member.id))
          .for("update");
        lockedLastAcquiredAt = locked?.lastAcquiredAt;
        if (!locked) return "full";
        if (
          options?.enforceLastAcquiredSnapshot &&
          !sameMemberTimestamp(lockedLastAcquiredAt, member.lastAcquiredAt)
        ) {
          return "stale";
        }
      } else if (member.type === "adobe") {
        const [locked] = await tx
          .select({ lastAcquiredAt: imageBackendAdobe.lastAcquiredAt })
          .from(imageBackendAdobe)
          .where(eq(imageBackendAdobe.id, member.id))
          .for("update");
        lockedLastAcquiredAt = locked?.lastAcquiredAt;
        if (!locked) return "full";
        if (
          options?.enforceLastAcquiredSnapshot &&
          !sameMemberTimestamp(lockedLastAcquiredAt, member.lastAcquiredAt)
        ) {
          return "stale";
        }
      } else {
        const [locked] = await tx
          .select({ lastAcquiredAt: imageBackendAccount.lastAcquiredAt })
          .from(imageBackendAccount)
          .where(eq(imageBackendAccount.id, member.id))
          .for("update");
        lockedLastAcquiredAt = locked?.lastAcquiredAt;
        if (!locked) return "full";
        if (
          options?.enforceLastAcquiredSnapshot &&
          !sameMemberTimestamp(lockedLastAcquiredAt, member.lastAcquiredAt)
        ) {
          return "stale";
        }
      }
      await pruneExpiredBackendLeases(tx, member, now);
      const [activeLeaseCount] = await tx
        .select({ value: count() })
        .from(imageBackendInflightLease)
        .where(
          and(
            eq(imageBackendInflightLease.memberType, member.type),
            eq(imageBackendInflightLease.memberId, member.id),
            gt(imageBackendInflightLease.expiresAt, now)
          )
        );
      const activeCount = Number(activeLeaseCount?.value || 0);
      if (activeCount >= backendConcurrency(member)) return "full";
      await tx.insert(imageBackendInflightLease).values({
        id: leaseId,
        memberType: member.type,
        memberId: member.id,
        expiresAt,
        createdAt: now,
      });
      if (member.type === "api") {
        await tx
          .update(imageBackendApi)
          .set({
            status: "active",
            cooldownUntil: null,
            lastUsedAt: now,
            lastAcquiredAt: now,
            updatedAt: now,
          })
          .where(eq(imageBackendApi.id, member.id));
      } else if (member.type === "adobe") {
        await tx
          .update(imageBackendAdobe)
          .set({
            status: "active",
            cooldownUntil: null,
            lastUsedAt: now,
            lastAcquiredAt: now,
            updatedAt: now,
          })
          .where(eq(imageBackendAdobe.id, member.id));
      } else {
        await tx
          .update(imageBackendAccount)
          .set({
            status: "active",
            cooldownUntil: null,
            lastUsedAt: now,
            lastAcquiredAt: now,
            updatedAt: now,
          })
          .where(eq(imageBackendAccount.id, member.id));
      }
      touchedMember = true;
      persisted = true;
      return "acquired";
    });
    if (acquired === "acquired") {
      acquireImageBackendInflight({
        memberType: member.type,
        memberId: member.id,
      });
      member.leaseId = leaseId;
      member.leasePersisted = persisted;
      member.leaseTouchedMember = touchedMember;
      member.lastAcquiredAt = now;
      member.lastUsedAt = now;
    }
    return acquired;
  } catch (error) {
    if (isMissingBackendLeaseTableError(error)) {
      logWarn("生图后端并发租约表不存在，退回进程内并发控制", {
        memberType: member.type,
        memberId: member.id,
      });
    } else {
      logWarn("生图后端并发租约获取失败", {
        memberType: member.type,
        memberId: member.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  acquireImageBackendInflight({
    memberType: member.type,
    memberId: member.id,
  });
  member.leaseId = leaseId;
  member.leasePersisted = false;
  member.leaseTouchedMember = false;
  return "acquired";
}

function splitKeywordList(value?: string | null) {
  return (value || "")
    .split(/[\n,;，；]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

async function getUnrecoverableBackendErrorKeywords() {
  const configured = await getRuntimeSettingString(
    "IMAGE_BACKEND_UNRECOVERABLE_ERROR_KEYWORDS"
  );
  const keywords = splitKeywordList(configured);
  return keywords.length
    ? keywords
    : DEFAULT_UNRECOVERABLE_BACKEND_ERROR_KEYWORDS;
}

async function isUnrecoverableBackendError(error?: string | null) {
  const normalized = (error || "").toLowerCase();
  if (!normalized) return false;
  const keywords = await getUnrecoverableBackendErrorKeywords();
  return keywords.some((keyword) => normalized.includes(keyword));
}

export function acquireImageBackendInflight(input: {
  memberType?: "api" | "account" | "adobe";
  memberId?: string;
}) {
  if (!input.memberType || !input.memberId) return;
  const key = `${input.memberType}:${input.memberId}`;
  backendInflight.set(key, (backendInflight.get(key) || 0) + 1);
}

export function releaseImageBackendInflight(input: {
  memberType?: "api" | "account" | "adobe";
  memberId?: string;
}) {
  if (!input.memberType || !input.memberId) return;
  const key = `${input.memberType}:${input.memberId}`;
  const current = backendInflight.get(key) || 0;
  if (current <= 1) {
    backendInflight.delete(key);
    return;
  }
  backendInflight.set(key, current - 1);
}

export async function releaseImageBackendInflightLease(input: {
  memberType?: "api" | "account" | "adobe";
  memberId?: string;
  leaseId?: string | null;
  leasePersisted?: boolean | null;
}) {
  releaseImageBackendInflight(input);
  if (!input.leaseId || input.leasePersisted !== true) return;
  try {
    await db
      .delete(imageBackendInflightLease)
      .where(eq(imageBackendInflightLease.id, input.leaseId));
  } catch (error) {
    logWarn("生图后端并发租约释放失败", {
      memberType: input.memberType,
      memberId: input.memberId,
      leaseId: input.leaseId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function isRecoverableBackendError(error?: string | null) {
  const normalized = (error || "").toLowerCase();
  return (
    isUnsupportedModelBackendError(error) ||
    isTransientNetworkBackendError(error) ||
    isChatGptWebTemporalBackendError(error) ||
    isToolRateLimitBackendError(error) ||
    normalized.includes("429") ||
    normalized.includes("529") ||
    normalized.includes("rate limit") ||
    normalized.includes("too many requests") ||
    normalized.includes("usage limit") ||
    normalized.includes("usage_limit") ||
    normalized.includes("limit has been reached") ||
    normalized.includes("limit_reached") ||
    normalized.includes("rate_limit_exceeded") ||
    normalized.includes("no available image quota") ||
    normalized.includes("quota exhausted") ||
    normalized.includes("quota_exhausted") ||
    normalized.includes("daily quota exceeded") ||
    normalized.includes("account quota exceeded") ||
    normalized.includes("quota has been exceeded") ||
    normalized.includes("quota exceeded") ||
    normalized.includes("quota_exceeded") ||
    normalized.includes("insufficient_quota") ||
    normalized.includes("insufficient credit") ||
    normalized.includes("insufficient credits") ||
    normalized.includes("not enough credit") ||
    normalized.includes("not enough credits") ||
    normalized.includes("credit exhausted") ||
    normalized.includes("credits exhausted") ||
    normalized.includes("resource has been exhausted") ||
    normalized.includes("minimumcreditamountforusage") ||
    normalized.includes("minimum credit amount for usage") ||
    normalized.includes("minimum credit") ||
    normalized.includes("billing_hard_limit") ||
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("econnreset") ||
    normalized.includes("fetch failed") ||
    normalized.includes("empty non-json") ||
    normalized.includes("empty response") ||
    normalized.includes("non-json responses api response") ||
    normalized.includes("non-json images api response") ||
    normalized.includes("upstream returned no image output") ||
    normalized.includes("returned no image output") ||
    normalized.includes("returned input image as output") ||
    normalized.includes("api returned no image data") ||
    normalized.includes("http 500") ||
    normalized.includes("status_code=500") ||
    normalized.includes("status code 500") ||
    normalized.includes('"status":500') ||
    normalized.includes("internal server error") ||
    normalized.includes("server_error") ||
    normalized.includes("something seems to have gone wrong") ||
    normalized.includes("an error occurred while processing your request") ||
    normalized.includes("502") ||
    normalized.includes("503") ||
    normalized.includes("504") ||
    normalized.includes("server overloaded") ||
    normalized.includes("overloaded") ||
    normalized.includes("temporarily unavailable") ||
    normalized.includes("temporary unavailable") ||
    normalized.includes("service unavailable") ||
    // 我方算 token 下载图片因 429/限流/超时/5xx 失败属瞬时，可切后端重试。
    (isTokenCountDownloadFailure(normalized) &&
      isTransientFileDownloadFailure(normalized))
  );
}

function isChatGptWebTemporalBackendError(error?: string | null) {
  const normalized = (error || "").toLowerCase();
  return (
    (normalized.includes("rpcerror") &&
      normalized.includes("temporalio.service.rpcerror")) ||
    (normalized.includes("rpcerror encountered exception") &&
      normalized.includes("temporalio"))
  );
}

function isTransientNetworkBackendError(error?: string | null) {
  const normalized = (error || "").toLowerCase();
  return (
    normalized === "terminated" ||
    normalized.includes("typeerror: terminated") ||
    normalized.includes("request aborted") ||
    normalized.includes("operation was aborted") ||
    normalized.includes("socket closed") ||
    normalized.includes("socket hang up") ||
    normalized.includes("other side closed") ||
    normalized.includes("connection closed") ||
    normalized.includes("connection terminated") ||
    normalized.includes("connection reset") ||
    normalized.includes("econnreset") ||
    (normalized.includes("undici") && normalized.includes("terminated"))
  );
}

function isLocalAbortTimeoutError(error?: string | null) {
  const normalized = (error || "").toLowerCase();
  return (
    normalized.includes("operation was aborted") &&
    normalized.includes("timeout")
  );
}

/**
 * 识别"上游模型缺少 image_generation 工具 / 不具备出图能力"导致只回文字的错误。
 *
 * WHY 单列：这类响应往往以"抱歉…我无法…"开头，会被内容安全拒绝启发式
 * （isApologyRefusal）误判为"用户内容被拒"，从而既不切换后端、也不惩罚后端，
 * 导致请求当场失败、坏后端长期留在轮换里。但它本质是后端配错（模型没有图像
 * 工具 / 环境未提供该工具），应当：可切换到别的后端 + 把该后端标记为 error。
 *
 * 为避免误伤"真正的内容拒绝"（如「图像生成请求被系统拒绝」），要求同时命中
 * "image_generation 工具 / 图像生成工具"字样与"未提供/不可用"语义。
 *
 * @param error 上游或本站包装后的错误文本。
 * @returns 是否为"后端缺少出图能力"类错误。
 */
export function isMissingImageToolBackendError(error?: string | null) {
  const normalized = (error || "").toLowerCase();
  const mentionsImageTool =
    normalized.includes("图像生成工具") ||
    (normalized.includes("image_generation") &&
      (normalized.includes("工具") || normalized.includes("tool")));
  if (!mentionsImageTool) return false;
  return (
    normalized.includes("未提供") ||
    normalized.includes("没有提供") ||
    normalized.includes("没有可调用") ||
    normalized.includes("未提供可调用") ||
    normalized.includes("无法调用") ||
    normalized.includes("不可用") ||
    normalized.includes("不支持") ||
    normalized.includes("not available") ||
    normalized.includes("isn't available") ||
    normalized.includes("is not available") ||
    normalized.includes("not provided") ||
    normalized.includes("not enabled") ||
    normalized.includes("does not have") ||
    normalized.includes("doesn't have") ||
    normalized.includes("no image_generation") ||
    normalized.includes("unavailable")
  );
}

/**
 * 识别"中转本身坏掉/不可用"的确定性错误，按用户判定升级为 error（粘性下线）。
 *
 * - "没有可用token"：中转无上游额度/令牌（如 sub2api 中转池空）。
 * - "html response body"：端点返回 HTML（源站宕机/网关错误页/baseUrl 配错），
 *   非 OpenAI 兼容 JSON。
 * - "service temporarily unavailable"：中转上游 502/服务不可用（典型
 *   "Upstream service temporarily unavailable"）。按运维要求标 error 踢出轮换（持续不可用
 *   的中转不自愈），由测活/重新启用复活；当次请求仍换号重试（文案含 502/temporarily
 *   unavailable，被 isRecoverableBackendError 判为可切换）。
 * 这类不会自愈，应踢出轮换直到管理员处理（测活/重新启用/常驻）。
 * 注意副作用：firefly-* / nano-banana 仅由 Adobe / adobe_sourced 后端出图，若这些后端因本
 * 错误被全部踢出，firefly 请求将无后端可解析——此时由 getEffectiveConfig 给出「无可用 Adobe
 * 后端」的明确报错（而非泛化的"默认后端缺失"），便于运维定位是后端被踢空而非模型问题。
 */
function isDeadRelayBackendError(error?: string | null) {
  const normalized = (error || "").toLowerCase();
  return (
    normalized.includes("没有可用token") ||
    normalized.includes("没有可用 token") ||
    normalized.includes("html response body") ||
    normalized.includes("service temporarily unavailable")
  );
}

// "failed to download file" 专指我方（如上游 new-api 为算 token）下载图片失败，
// 与 "error while downloading file"（上游下载用户提供的 url）区分：
// 后者是用户链接问题（终态、不切换），前者若是 429/超时/5xx 则属瞬时、可切后端。
function isTokenCountDownloadFailure(normalized: string) {
  return normalized.includes("failed to download file");
}

// 文件下载失败是否属于瞬时/可重试原因（429/限流/超时/5xx），而非客户端坏链接。
function isTransientFileDownloadFailure(normalized: string) {
  return (
    normalized.includes("429") ||
    normalized.includes("rate limit") ||
    normalized.includes("too many requests") ||
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    /status code:\s*5\d\d/.test(normalized)
  );
}

/**
 * 识别"该后端/分组未开通图像生成"(HTTP 403 permission_error)的确定性坏配置错误。
 * 不会自愈，应可切换到别的后端 + 把该后端标记为 error 踢出轮换，
 * 等管理员开通/测活后再启用，避免请求一直被路由到坏后端而当场失败。
 */
export function isImageGenDisabledBackendError(error?: string | null) {
  const normalized = (error || "").toLowerCase();
  return (
    normalized.includes("image generation is not enabled") ||
    normalized.includes("image_generation is not enabled") ||
    (normalized.includes("permission_error") &&
      normalized.includes("image generation"))
  );
}

/**
 * 识别"API Key 所属分组被上游停用"(HTTP 403 GROUP_DISABLED)的确定性坏配置错误。
 *
 * WHY 单列：中转把整组 Key 停用后，该后端的一切请求都会 403 且不会自愈。
 * 2026-06-10 事故：该文案不命中任何白名单 → 不切换当场失败，叠加 always_active
 * 不下线，形成"持续吃流量、每次都失败"的黑洞。应当：可切换到别的后端 +
 * 把该后端标记为 error 踢出轮换，等管理员处理(测活/重新启用)后再回来。
 */
export function isGroupDisabledBackendError(error?: string | null) {
  const normalized = (error || "").toLowerCase();
  return (
    normalized.includes("group_disabled") ||
    normalized.includes("分组已停用") ||
    normalized.includes("分组已禁用")
  );
}

function isUserRequestBackendError(error?: string | null) {
  // 缺图像工具是后端能力问题（非用户内容拒绝）：放行去走"可切换 + 标记 error"，
  // 否则会被下方 isApologyRefusal 误判成用户拒绝而当场失败、不切换。
  if (isMissingImageToolBackendError(error)) return false;
  const normalized = (error || "").toLowerCase();
  return (
    isContentSafetyRejection(error) ||
    normalized.includes("moderation_blocked") ||
    normalized.includes("image_generation_user_error") ||
    normalized.includes("user_error") ||
    normalized.includes("content_policy") ||
    normalized.includes("policy_violation") ||
    // 用户输入超限(提示词过长 / 参考图超数 / 输入图过大):切后端也救不了 → 不重试、直接报。
    // 与 SLA 侧共用 USER_INPUT_LIMIT_PATTERNS(sla-classification.ts),码 + 中英文案兜底,避免
    // 两处分类器漂移;限流类(rate limit/concurrency/too many requests)不在表内,仍可切换。
    USER_INPUT_LIMIT_PATTERNS.some((pattern) => normalized.includes(pattern)) ||
    normalized.includes("error while downloading file") ||
    normalized.includes("unable to download content from the provided url") ||
    normalized.includes("file urls cannot be larger than") ||
    normalized.includes("transparent background is not supported") ||
    // 分辨率/尺寸不对（用户给的 size/分辨率/蒙版尺寸不符）：切后端也救不了，算用户错。
    normalized.includes("unsupported size") ||
    normalized.includes("invalid size") ||
    normalized.includes("size is not supported") ||
    normalized.includes("size not supported") ||
    normalized.includes("invalid resolution") ||
    normalized.includes("unsupported resolution") ||
    normalized.includes("resolution is not supported") ||
    normalized.includes("invalid dimensions") ||
    normalized.includes("unsupported dimensions") ||
    normalized.includes("does not match image size") ||
    // 无效图像（用户提供的图片本身无法识别/格式不对）：同理算用户错。
    USER_INVALID_IMAGE_PATTERNS.some((pattern) =>
      normalized.includes(pattern)
    ) ||
    // 我方为算 token 下载图片失败（failed to download file）默认算用户错（坏链接/非图片/403/404），
    // 但若是 429/限流/超时/5xx 等瞬时原因（典型：上游为算 token 下载我方图片被限流），
    // 不算用户错，放行给 isRecoverableBackendError 走"切后端 + 冷却"。
    (isTokenCountDownloadFailure(normalized) &&
      !isTransientFileDownloadFailure(normalized))
  );
}

export function isImageBackendSwitchableError(error?: string | null) {
  return Boolean(
    error &&
      !isUserRequestBackendError(error) &&
      !isLocalAbortTimeoutError(error) &&
      (isRecoverableBackendError(error) ||
        isInvalidBackendCredentialError(error) ||
        isImageGenDisabledBackendError(error) ||
        isGroupDisabledBackendError(error))
  );
}

/**
 * 识别"未被任何已知规则记录"的未知后端错误：非用户请求错误、非本地超时
 * abort，也不命中任何可切换白名单。
 *
 * WHY 单列：isImageBackendSwitchableError 是白名单制，首次出现的新形态平台
 * 错误(上游新增的错误文案)默认不可切换，会当场失败砸在用户头上(GROUP_DISABLED
 * 事故即此类)。重试循环对这类错误允许有限次切换后端兜底，见
 * image-generation/service.ts 的 retryPoolBackendResult。
 */
export function isUnclassifiedBackendError(error?: string | null) {
  return Boolean(
    error &&
      !isUserRequestBackendError(error) &&
      !isLocalAbortTimeoutError(error) &&
      !isImageBackendSwitchableError(error)
  );
}

function isClassifiedFailureRecoverable(
  error: string | null,
  failure: { status?: string; cooldownUntil?: Date | null }
) {
  return Boolean(
    error &&
      !isUserRequestBackendError(error) &&
      isRecoverableBackendError(error) &&
      failure.status !== "error"
  );
}

function isInvalidBackendCredentialError(error?: string | null) {
  const normalized = (error || "").toLowerCase();
  return (
    normalized.includes("401") ||
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden") ||
    normalized.includes("invalid api key") ||
    normalized.includes("invalid_api_key") ||
    normalized.includes("invalid access token") ||
    normalized.includes("invalid_access_token") ||
    normalized.includes("invalid auth") ||
    normalized.includes("invalid authentication") ||
    normalized.includes("authentication token has been invalidated") ||
    normalized.includes("token has been invalidated") ||
    normalized.includes("token expired") ||
    normalized.includes("expired token") ||
    normalized.includes("token is expired") ||
    normalized.includes("access token expired") ||
    normalized.includes("signing in again") ||
    normalized.includes("please sign in again") ||
    normalized.includes("please try signing in again")
  );
}

function isUsageLimitBackendError(error?: string | null) {
  const normalized = (error || "").toLowerCase();
  return (
    normalized.includes("usage limit") ||
    normalized.includes("usage_limit") ||
    normalized.includes("limit has been reached") ||
    normalized.includes("limit_reached") ||
    normalized.includes("no available image quota") ||
    normalized.includes("quota exhausted") ||
    normalized.includes("quota_exhausted") ||
    normalized.includes("daily quota exceeded") ||
    normalized.includes("account quota exceeded") ||
    normalized.includes("insufficient_quota") ||
    normalized.includes("quota has been exceeded") ||
    normalized.includes("quota exceeded") ||
    normalized.includes("quota_exceeded") ||
    normalized.includes("insufficient credit") ||
    normalized.includes("insufficient credits") ||
    normalized.includes("not enough credit") ||
    normalized.includes("not enough credits") ||
    normalized.includes("credit exhausted") ||
    normalized.includes("credits exhausted") ||
    normalized.includes("resource has been exhausted") ||
    normalized.includes("minimumcreditamountforusage") ||
    normalized.includes("minimum credit amount for usage") ||
    normalized.includes("minimum credit") ||
    normalized.includes("billing_hard_limit")
  );
}

/**
 * 识别 ChatGPT 账号侧"画图工具被限流"——image_gen.text2im 工具级 RateLimitException。
 *
 * WHY 单列:ChatGPT 在该账号画图额度用满时不会返回图片,而是回一条
 * content_type=system_error、name=ChatGPTAgentToolRateLimitException 的消息
 * (chatgpt-web.ts 的 extractWebSystemError 已把它从 o/v 流里抽成错误文案)。它是
 * 账号级的滚动限流、恢复快,必须按限流处理(短冷却 + 换号重试),不能被当成
 * 通用 "no image output" 落进 15 分钟临时桶,也利于 SLA 把它归类为限流而非平台故障。
 * "ratelimitexception"(小写)即可命中 ChatGPTAgentToolRateLimitException。
 */
function isToolRateLimitBackendError(error?: string | null) {
  const normalized = (error || "").toLowerCase();
  return (
    normalized.includes("ratelimitexception") ||
    (normalized.includes("image_gen.text2im") &&
      (normalized.includes("right now") || normalized.includes("rate limit")))
  );
}

function isResetAwareLimitedBackendError(error?: string | null) {
  const normalized = (error || "").toLowerCase();
  return (
    isUsageLimitBackendError(error) ||
    isToolRateLimitBackendError(error) ||
    normalized.includes("429") ||
    normalized.includes("rate limit") ||
    normalized.includes("too many requests")
  );
}

function isOverloadBackendError(error?: string | null) {
  const normalized = (error || "").toLowerCase();
  return (
    normalized.includes("529") ||
    normalized.includes("overloaded") ||
    normalized.includes("server overloaded") ||
    normalized.includes("http 500") ||
    normalized.includes("status_code=500") ||
    normalized.includes("status code 500") ||
    normalized.includes('"status":500') ||
    normalized.includes("internal server error") ||
    normalized.includes("server_error") ||
    normalized.includes("something seems to have gone wrong") ||
    normalized.includes("an error occurred while processing your request") ||
    normalized.includes("empty non-json") ||
    normalized.includes("empty response") ||
    normalized.includes("temporarily unavailable") ||
    normalized.includes("temporary unavailable") ||
    normalized.includes("service unavailable") ||
    normalized.includes("capacity") ||
    normalized.includes("try again later")
  );
}

function isUnsupportedModelBackendError(error?: string | null) {
  const normalized = (error || "").toLowerCase();
  return (
    normalized.includes("unsupported model") ||
    normalized.includes("model not supported") ||
    normalized.includes("model is not supported") ||
    normalized.includes("model_not_supported") ||
    normalized.includes("unsupported_model") ||
    normalized.includes("model_not_found") ||
    normalized.includes("model_not_available") ||
    normalized.includes("does not support this model") ||
    normalized.includes("not support this model") ||
    normalized.includes("tool choice 'image_generation' not found") ||
    normalized.includes("tool choice image_generation not found") ||
    (normalized.includes("image_generation") &&
      normalized.includes("not found in") &&
      normalized.includes("tools")) ||
    normalized.includes("not allowed to use model") ||
    normalized.includes("not have access to the model") ||
    normalized.includes("account does not support") ||
    normalized.includes("账户不支持此模型") ||
    normalized.includes("不支持此模型") ||
    normalized.includes("不支持该模型")
  );
}

function parseDateValue(value: string | Date | null | undefined) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const trimmed = value.trim();
  if (!trimmed) return null;

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0) {
    const milliseconds = numeric > 10_000_000_000 ? numeric : numeric * 1000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const durationMs = parseDurationMs(trimmed);
  if (durationMs) {
    return new Date(Date.now() + durationMs);
  }

  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
}

function clampResetDate(date: Date | null, now: Date) {
  if (!date || date.getTime() <= now.getTime()) return null;
  // 地板:亚秒级/过短的上游重置抬到至少 MIN_RESET_COOLDOWN_MS,避免冷却形同虚设。
  const min = now.getTime() + MIN_RESET_COOLDOWN_MS;
  const max = now.getTime() + MAX_PARSED_RESET_COOLDOWN_DAYS * 24 * 60 * 60_000;
  return new Date(Math.min(Math.max(date.getTime(), min), max));
}

function parseResetDateFromError(error?: string | null) {
  if (!error) return null;
  const normalized = error.replace(/\\"/g, '"');
  const retryAfter = normalized.match(/retry-after["'\s:=]+(\d{1,8})/i)?.[1];
  if (retryAfter) {
    return new Date(Date.now() + Number(retryAfter) * 1000);
  }
  const retryAfterSeconds = normalized.match(
    /(?:retryAfterSeconds|retry_after_seconds|retry_after|retryAfter|reset_after_seconds|resets_in_seconds|quotaResetDelay)["'\s:=]+([^"',}\]\s]+)/i
  )?.[1];
  if (retryAfterSeconds) {
    const numeric = Number(retryAfterSeconds);
    if (Number.isFinite(numeric) && numeric > 0) {
      return new Date(Date.now() + numeric * 1000);
    }
    const durationMs = parseDurationMs(retryAfterSeconds);
    if (durationMs) return new Date(Date.now() + durationMs);
  }

  const relativeResetMatch = normalized.match(
    /(?:reset_after|resetAfter|restore_after|restoreAfter)["'\s:=]+([^"',}\]\s]+)/i
  )?.[1];
  if (relativeResetMatch) {
    const numeric = Number(relativeResetMatch);
    if (Number.isFinite(numeric) && numeric > 0) {
      return new Date(Date.now() + numeric * 1000);
    }
    const durationMs = parseDurationMs(relativeResetMatch);
    if (durationMs) return new Date(Date.now() + durationMs);
  }

  const resetMatch = normalized.match(
    /(?:x-ratelimit-reset(?:-[a-z0-9_-]+)?|upstreamResetAt|upstream_reset_at|resetAt|reset_at|resetsAt|resets_at|restore_at|restoreAt)["'\s:=]+([^"',}\]\s]+)/i
  )?.[1];
  if (resetMatch) {
    const parsed = parseDateValue(resetMatch);
    if (parsed) return parsed;
  }

  const proseMatch = normalized.match(
    /(?:reset|resets|restore|available again|try again)(?:\s+\w+){0,4}\s+(?:at|after|on|in)[:\s]+([^"',}\]\n]+)/i
  )?.[1];
  return parseDateValue(proseMatch);
}

function resolveCooldownDate(
  error: string | null,
  fallback: Date | null,
  input?: Pick<
    ImageBackendReportResultInput,
    "upstreamResetAt" | "retryAfterSeconds"
  >,
  options?: { useUpstreamReset?: boolean }
) {
  if (!options?.useUpstreamReset) return fallback;

  const now = new Date();
  const retryAfter = Number(input?.retryAfterSeconds);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    const parsed = clampResetDate(
      new Date(now.getTime() + retryAfter * 1000),
      now
    );
    if (parsed) return parsed;
  }
  const explicitReset = clampResetDate(
    parseDateValue(input?.upstreamResetAt),
    now
  );
  if (explicitReset) return explicitReset;
  const bodyReset = clampResetDate(parseResetDateFromError(error), now);
  if (bodyReset) return bodyReset;
  return fallback;
}

function cooldownFromMinutes(minutes: number) {
  return new Date(Date.now() + Math.max(1, minutes) * 60_000);
}

function isMeaningfulSourceCooldownForError(
  error: string | null,
  cooldownUntil: Date | null
) {
  return Boolean(
    cooldownUntil &&
      cooldownUntil.getTime() > Date.now() &&
      isResetAwareLimitedBackendError(error)
  );
}

async function getBackendCooldownMinutes(
  key:
    | "IMAGE_BACKEND_DEFAULT_COOLDOWN_MINUTES"
    | "IMAGE_BACKEND_RATE_LIMIT_COOLDOWN_MINUTES"
    | "IMAGE_BACKEND_TOOL_RATE_LIMIT_COOLDOWN_MINUTES"
    | "IMAGE_BACKEND_OVERLOAD_COOLDOWN_MINUTES"
    | "IMAGE_BACKEND_USAGE_LIMIT_COOLDOWN_MINUTES"
    | "IMAGE_BACKEND_UNSUPPORTED_MODEL_COOLDOWN_MINUTES"
    | "IMAGE_BACKEND_TEMPORARY_ERROR_COOLDOWN_MINUTES"
) {
  const defaultMinutes = await getRuntimeSettingNumber(
    "IMAGE_BACKEND_DEFAULT_COOLDOWN_MINUTES",
    DEFAULT_BACKEND_COOLDOWN_MINUTES,
    { positive: true }
  );
  if (key === "IMAGE_BACKEND_DEFAULT_COOLDOWN_MINUTES") {
    return defaultMinutes;
  }
  // 工具级限流恢复快,未配置时用比通用兜底更短的默认值(3 分钟),而非沿用 15 分钟兜底。
  const keyFallback =
    key === "IMAGE_BACKEND_TOOL_RATE_LIMIT_COOLDOWN_MINUTES"
      ? DEFAULT_TOOL_RATE_LIMIT_COOLDOWN_MINUTES
      : defaultMinutes;
  return await getRuntimeSettingNumber(key, keyFallback, { positive: true });
}

export async function classifyFailure(
  error?: string | null,
  input?: Pick<
    ImageBackendReportResultInput,
    "upstreamResetAt" | "retryAfterSeconds"
  >
): Promise<{
  status?: string;
  cooldownUntil?: Date | null;
}> {
  const normalized = (error || "").toLowerCase();
  if (isUserRequestBackendError(error)) {
    return {};
  }
  // 后端缺少出图能力（只回文字/无 image_generation 工具）：标记 error 踢出轮换，
  // 与 isImageBackendSwitchableError 配合实现"本次切换到别的后端 + 后续不再选它"。
  if (isMissingImageToolBackendError(error)) {
    return { status: "error", cooldownUntil: null };
  }
  // 中转坏掉（无 token / 返回 HTML）：确定性不可用，按用户判定升级为 error 踢出。
  if (isDeadRelayBackendError(error)) {
    return { status: "error", cooldownUntil: null };
  }
  // 该后端/分组未开通图像生成(403 permission)：确定性坏配置，标记 error 踢出轮换。
  if (isImageGenDisabledBackendError(error)) {
    return { status: "error", cooldownUntil: null };
  }
  // API Key 所属分组被上游停用(403 GROUP_DISABLED)：确定性坏配置，标记 error 踢出轮换。
  if (isGroupDisabledBackendError(error)) {
    return { status: "error", cooldownUntil: null };
  }
  if (
    (await isUnrecoverableBackendError(error)) ||
    isInvalidBackendCredentialError(error)
  ) {
    return { status: "error", cooldownUntil: null };
  }
  // ChatGPT 画图工具级限流(image_gen.text2im / ChatGPTAgentToolRateLimitException):
  // 账号级滚动限流、恢复快,按限流标 limited(管理后台可见)+ 独立短冷却(默认 3 分钟),
  // 上游若给出 reset 时间则优先。仍属可切换错误(见 isRecoverableBackendError),换号重试。
  // 放在 usage-limit 之前:即便文案同时带通用 "limit" 字样,也走 3 分钟工具桶而非 15 分钟额度桶。
  if (isToolRateLimitBackendError(error)) {
    const minutes = await getBackendCooldownMinutes(
      "IMAGE_BACKEND_TOOL_RATE_LIMIT_COOLDOWN_MINUTES"
    );
    return {
      status: "limited",
      cooldownUntil: resolveCooldownDate(
        error || null,
        cooldownFromMinutes(minutes),
        input,
        { useUpstreamReset: true }
      ),
    };
  }
  if (isUsageLimitBackendError(error)) {
    const minutes = await getBackendCooldownMinutes(
      "IMAGE_BACKEND_USAGE_LIMIT_COOLDOWN_MINUTES"
    );
    return {
      status: "limited",
      cooldownUntil: resolveCooldownDate(
        error || null,
        cooldownFromMinutes(minutes),
        input,
        { useUpstreamReset: true }
      ),
    };
  }
  if (isUnsupportedModelBackendError(error)) {
    const minutes = await getBackendCooldownMinutes(
      "IMAGE_BACKEND_UNSUPPORTED_MODEL_COOLDOWN_MINUTES"
    );
    return {
      status: "active",
      cooldownUntil: resolveCooldownDate(
        error || null,
        cooldownFromMinutes(minutes),
        input
      ),
    };
  }
  if (
    normalized.includes("429") ||
    normalized.includes("rate limit") ||
    normalized.includes("too many requests")
  ) {
    const minutes = await getBackendCooldownMinutes(
      "IMAGE_BACKEND_RATE_LIMIT_COOLDOWN_MINUTES"
    );
    return {
      status: "active",
      cooldownUntil: resolveCooldownDate(
        error || null,
        cooldownFromMinutes(minutes),
        input,
        { useUpstreamReset: true }
      ),
    };
  }
  if (isOverloadBackendError(error)) {
    const minutes = await getBackendCooldownMinutes(
      "IMAGE_BACKEND_OVERLOAD_COOLDOWN_MINUTES"
    );
    return {
      status: "active",
      cooldownUntil: resolveCooldownDate(
        error || null,
        cooldownFromMinutes(minutes),
        input
      ),
    };
  }
  if (isRecoverableBackendError(error)) {
    const minutes = await getBackendCooldownMinutes(
      "IMAGE_BACKEND_TEMPORARY_ERROR_COOLDOWN_MINUTES"
    );
    return {
      status: "active",
      cooldownUntil: resolveCooldownDate(
        error || null,
        cooldownFromMinutes(minutes),
        input
      ),
    };
  }
  const minutes = await getBackendCooldownMinutes(
    "IMAGE_BACKEND_DEFAULT_COOLDOWN_MINUTES"
  );
  return {
    status: "active",
    cooldownUntil: cooldownFromMinutes(minutes),
  };
}

/**
 * 把分类结果按"该后端是否启用失败冷却"收敛。
 *
 * 账号永远按分类结果走。API 后端由各自的 `failureCooldownEnabled` 决定（取代旧
 * 的全局开关）：关闭时丢弃一切冷却/限流结果，仅保留确定性 `error`（不可恢复/
 * 凭证废/缺图像工具/中转坏）。
 */
function resolveEffectiveFailureForMember(
  memberType: "api" | "account" | "adobe",
  failure: {
    status?: string;
    cooldownUntil?: Date | null;
  },
  apiFailureCooldownEnabled: boolean
) {
  // adobe 与 api 同属"中转型"后端，受各自 failureCooldownEnabled 门控；account 永远按
  // 分类结果走。
  if (
    (memberType !== "api" && memberType !== "adobe") ||
    apiFailureCooldownEnabled
  ) {
    return failure;
  }
  return {
    status: failure.status === "error" ? failure.status : undefined,
    cooldownUntil:
      failure.status === "error" ? failure.cooldownUntil : undefined,
  };
}

// always_active（遇错常驻）的失败处置：常驻后端遇【任何】失败都不自动下线——返回空对象
// 表示"不改 status、不进冷却，仅由调用方记 lastError/failCount"。含 502/HTML、dead-relay、
// 凭证/分组等终态错误：运营勾了"遇错常驻"即要求它永不被自动标 error 踢出。
// WHY 含终态：曾经只豁免临时错误、对 status='error' 仍踢出，导致常驻 relay 撞到
// 「HTTP 502: HTML response body」这类 dead-relay 错误被标 error 踢空，进而触发「没有可用的
// 默认生图后端」。代价：真·死号会持续被选中、每次浪费一次尝试后换号，需人工停用——这是
// "常驻"语义的固有取舍，由运营自行承担。非常驻后端不走此函数，按 classifyFailure 的判定
// （临时冷却 / status='error' 粘性踢出）。
export function resolveAlwaysActiveFailure(
  alwaysActive: boolean,
  effectiveFailure: { status?: string; cooldownUntil?: Date | null }
): { status?: string; cooldownUntil?: Date | null } {
  return alwaysActive ? {} : effectiveFailure;
}

function isBackendAvailableStatus(
  statusColumn:
    | typeof imageBackendAccount.status
    | typeof imageBackendApi.status
    | typeof imageBackendAdobe.status,
  cooldownColumn:
    | typeof imageBackendAccount.cooldownUntil
    | typeof imageBackendApi.cooldownUntil
    | typeof imageBackendAdobe.cooldownUntil,
  now: Date
) {
  return or(
    eq(statusColumn, "active"),
    and(eq(statusColumn, "limited"), sql`${cooldownColumn} <= ${now}`)
  );
}

function truncateError(value?: string | null) {
  if (!value) return null;
  return value.length > 2000 ? value.slice(0, 2000) : value;
}

function asBackendMetadata(value: unknown): BackendMetadata {
  return value && typeof value === "object" && !Array.isArray(value)
    ? ({ ...(value as Record<string, unknown>) } as BackendMetadata)
    : {};
}

function metadataString(
  metadata: Record<string, unknown> | null | undefined,
  key: string
) {
  const value = asBackendMetadata(metadata)[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function isSub2ApiBackedMetadata(
  metadata: Record<string, unknown> | null | undefined
) {
  return asBackendMetadata(metadata).source === "sub2api_postgres";
}

function normalizeWebAccountMetadata(
  metadata: Record<string, unknown> | null | undefined
): WebAccountRuntimeMetadata | null {
  const raw = asBackendMetadata(metadata).webAccount;
  if (!raw || typeof raw !== "object") return null;
  const quota = Number(raw.quota);
  const type = String(raw.type || "free");
  return {
    email: typeof raw.email === "string" ? raw.email : null,
    userId: typeof raw.userId === "string" ? raw.userId : null,
    type,
    quota: Number.isFinite(quota) ? Math.max(0, Math.trunc(quota)) : 0,
    limitsProgress: Array.isArray(raw.limitsProgress) ? raw.limitsProgress : [],
    defaultModelSlug:
      typeof raw.defaultModelSlug === "string" ? raw.defaultModelSlug : null,
    restoreAt: typeof raw.restoreAt === "string" ? raw.restoreAt : null,
    status: raw.status === "limited" ? "limited" : "active",
    refreshedAt:
      typeof raw.refreshedAt === "string" ? raw.refreshedAt : undefined,
  };
}

function mergeWebAccountMetadata(
  metadata: Record<string, unknown> | null | undefined,
  accountInfo: ChatGptWebAccountInfo
): BackendMetadata {
  return {
    ...asBackendMetadata(metadata),
    webAccount: {
      ...accountInfo,
      refreshedAt: new Date().toISOString(),
    },
  };
}

function parseMetadataDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isWebAccountQuotaAvailable(
  backend: ImageBackendAccountBackend,
  metadata: Record<string, unknown> | null | undefined,
  now: Date
) {
  if (backend !== "web") return true;
  const webAccount = normalizeWebAccountMetadata(metadata);
  if (!webAccount) return true;
  if (webAccount.quota > 0) return true;
  const restoreAt = parseMetadataDate(webAccount.restoreAt);
  return Boolean(restoreAt && restoreAt <= now);
}

function nextWebAccountMetadataAfterSuccess(
  metadata: Record<string, unknown> | null | undefined
) {
  const webAccount = normalizeWebAccountMetadata(metadata);
  if (!webAccount) {
    return {
      metadata: metadata ?? null,
      status: "active",
      cooldownUntil: null as Date | null,
    };
  }

  const nextQuota = Math.max(0, webAccount.quota - 1);
  const nextMetadataStatus = nextQuota === 0 ? "limited" : "active";
  const restoreAt = parseMetadataDate(webAccount.restoreAt);
  return {
    metadata: {
      ...asBackendMetadata(metadata),
      webAccount: {
        ...webAccount,
        quota: nextQuota,
        status: nextMetadataStatus,
      },
    },
    status: "active",
    cooldownUntil: nextMetadataStatus === "limited" ? restoreAt : null,
  };
}

async function getDefaultGroupId() {
  const [defaultGroup] = await db
    .select({ id: imageBackendGroup.id })
    .from(imageBackendGroup)
    .where(
      and(
        eq(imageBackendGroup.isEnabled, true),
        eq(imageBackendGroup.isDefault, true)
      )
    )
    .orderBy(asc(imageBackendGroup.priority), asc(imageBackendGroup.createdAt))
    .limit(1);

  if (defaultGroup) return defaultGroup.id;

  const [firstGroup] = await db
    .select({ id: imageBackendGroup.id })
    .from(imageBackendGroup)
    .where(eq(imageBackendGroup.isEnabled, true))
    .orderBy(asc(imageBackendGroup.priority), asc(imageBackendGroup.createdAt))
    .limit(1);

  return firstGroup?.id ?? null;
}

async function resolveRequestedGroup(
  options: ResolveBackendOptions,
  plan: SubscriptionPlan
): Promise<{ groupId: string | null; explicit: boolean }> {
  if (options.apiKeyId) {
    const [key] = await db
      .select({ groupId: externalApiKey.generationGroupId })
      .from(externalApiKey)
      .where(eq(externalApiKey.id, options.apiKeyId))
      .limit(1);
    if (key?.groupId) return { groupId: key.groupId, explicit: true };
    return { groupId: await getDefaultGroupId(), explicit: false };
  }

  const preferenceGroupId = await getUserImageBackendPreference(
    options.userId,
    plan
  );
  if (preferenceGroupId) {
    return { groupId: preferenceGroupId, explicit: true };
  }

  return { groupId: await getDefaultGroupId(), explicit: false };
}

async function ensureGroupUsable(
  groupId: string | null,
  plan: SubscriptionPlan
) {
  if (!groupId) return null;
  const [group] = await db
    .select()
    .from(imageBackendGroup)
    .where(
      and(
        eq(imageBackendGroup.id, groupId),
        eq(imageBackendGroup.isEnabled, true)
      )
    )
    .limit(1);
  if (group && !canUseBackendGroupForPlan(group.metadata, plan)) {
    return null;
  }
  return group ?? null;
}

async function listSelectableGroupContexts(
  group: {
    id: string;
    metadata: Record<string, unknown> | null;
    contentSafetyEnabled: boolean | null;
  },
  plan: SubscriptionPlan,
  requestKind: ImageBackendRequestKind
): Promise<SelectableGroupContext[]> {
  const contexts: SelectableGroupContext[] = [
    {
      id: group.id,
      metadata: group.metadata,
      contentSafetyEnabled: group.contentSafetyEnabled,
    },
  ];
  if (getGroupBackendType(group.metadata) !== "mixed") return contexts;

  const childGroupIds = getGroupChildGroupIds(group.metadata).filter(
    (childGroupId) => childGroupId !== group.id
  );
  if (!childGroupIds.length) return contexts;

  const childGroups = await db
    .select({
      id: imageBackendGroup.id,
      metadata: imageBackendGroup.metadata,
      contentSafetyEnabled: imageBackendGroup.contentSafetyEnabled,
    })
    .from(imageBackendGroup)
    .where(
      and(
        inArray(imageBackendGroup.id, childGroupIds),
        eq(imageBackendGroup.isEnabled, true)
      )
    );
  const childGroupMap = new Map(childGroups.map((child) => [child.id, child]));

  for (const childGroupId of childGroupIds) {
    const child = childGroupMap.get(childGroupId);
    if (!child) continue;
    if (!canUseBackendGroupForPlan(child.metadata, plan)) continue;
    if (getGroupBackendType(child.metadata) === "mixed") continue;
    if (getGroupChildGroupIds(child.metadata).length) continue;
    if (!groupBackendAllowsRequest(child.metadata, requestKind)) continue;
    contexts.push({
      id: child.id,
      metadata: child.metadata,
      contentSafetyEnabled: child.contentSafetyEnabled,
    });
  }

  return contexts;
}

async function selectPoolMember(
  groupId: string | null,
  groupMetadata?: Record<string, unknown> | null,
  groupContentSafetyEnabled?: boolean | null,
  groupContexts?: SelectableGroupContext[],
  requestKind?: ImageBackendRequestKind,
  excluded?: Set<string>,
  preferredMemberId?: string,
  preferredMemberType?: "api" | "account" | "adobe",
  stickyPreviousMember?: StickyBindingMember | null,
  stickySessionMember?: StickyBindingMember | null,
  accountBackendPreference?: ImageBackendAccountBackend,
  accountBackendPreferenceMode?: ImageBackendPreferenceMode,
  requestedModel?: string,
  forceFirefly = false,
  staleRetryCount = 0,
  capacityWaitCount = 0,
  accountPlanFilter: ImageBackendAccountPlanFilter = "any"
): Promise<PoolMember | null> {
  // 只看目标主组；mixed 组选中 Web 子组时仍保留其原始模型与 Adobe 路由规则。
  const modelRouting = resolvePoolModelRouting({
    groupBackendType: getGroupBackendType(groupMetadata),
    requestKind,
    requestedModel,
    forceFirefly,
  });
  const fireflyOnly = modelRouting.fireflyOnly;
  const selectionStartedAt = Date.now();
  const contexts = groupContexts?.length
    ? groupContexts
    : groupId
      ? [
          {
            id: groupId,
            metadata: groupMetadata ?? null,
            contentSafetyEnabled: groupContentSafetyEnabled ?? null,
          },
        ]
      : [];
  const contextMap = new Map(contexts.map((context) => [context.id, context]));
  const groupIds = contexts.map((context) => context.id);
  const effectiveContextPreferences = new Map(
    contexts.map((context) => [
      context.id,
      resolveEffectiveAccountBackendPreference(
        context.metadata,
        accountBackendPreference,
        accountBackendPreferenceMode
      ),
    ])
  );
  const primaryContext = groupId ? contextMap.get(groupId) : undefined;
  const effectiveAccountBackendPreference = groupId
    ? resolveEffectiveAccountBackendPreference(
        primaryContext?.metadata ?? groupMetadata ?? null,
        accountBackendPreference,
        accountBackendPreferenceMode
      )
    : accountBackendPreferenceMode === "mixed-only"
      ? undefined
      : accountBackendPreference;
  const requiredAccountBackend =
    requestKind === "responses"
      ? "responses"
      : effectiveAccountBackendPreference;
  const accountBackendFilter = requiredAccountBackend
    ? eq(imageBackendAccount.implementationMode, requiredAccountBackend)
    : sql`true`;
  // opt-in plan 过滤:仅 "paid" 时把账号候选收敛到付费级账号。默认 "any" 不加约束——主图像管线
  // 行为不变。付费判定读两处(任一命中即付费,兼容两种落库来源):
  //   ① metadata.planType —— 手工按分组回填(Pro-Web=pro)写的顶层字段;
  //   ② metadata.webAccount.type —— refreshImageBackendAccountInfo 实时查 ChatGPT 落的嵌套字段
  //      (导入后跑"刷新账号信息"即写入)。二者都为空 → 视作非付费,保守排除。
  const accountPlanWhere =
    accountPlanFilter === "paid"
      ? sql`(
          LOWER(COALESCE(${imageBackendAccount.metadata}->>'planType', '')) IN ('plus', 'pro', 'team', 'enterprise')
          OR LOWER(COALESCE(${imageBackendAccount.metadata}->'webAccount'->>'type', '')) IN ('plus', 'pro', 'team', 'enterprise')
        )`
      : sql`true`;
  const now = new Date();
  const accountBaseWhere = and(
    eq(imageBackendAccount.isEnabled, true),
    accountBackendFilter,
    accountPlanWhere,
    // always_active 的账号无视 cooldown 与临时故障始终入选,但 status="error"（终态/鉴权类:
    // 死号/封号/凭据失效）仍踢出轮换——避免死号常驻形成黑洞。其余维持原"健康且未冷却"判定。
    or(
      and(
        eq(imageBackendAccount.alwaysActive, true),
        sql`${imageBackendAccount.status} <> 'error'`
      ),
      and(
        isBackendAvailableStatus(
          imageBackendAccount.status,
          imageBackendAccount.cooldownUntil,
          now
        ),
        or(
          sql`${imageBackendAccount.cooldownUntil} IS NULL`,
          sql`${imageBackendAccount.cooldownUntil} <= ${now}`
        )
      )
    )
  );
  const accountRowsPromise = groupIds.length
    ? db
        .select({
          matchedGroupId: imageBackendAccountGroup.groupId,
          id: imageBackendAccount.id,
          alwaysActive: imageBackendAccount.alwaysActive,
          groupId: imageBackendAccount.groupId,
          name: imageBackendAccount.name,
          accessToken: imageBackendAccount.accessToken,
          model: imageBackendAccount.model,
          implementationMode: imageBackendAccount.implementationMode,
          contentSafetyEnabled: imageBackendAccount.contentSafetyEnabled,
          priority: imageBackendAccount.priority,
          concurrency: imageBackendAccount.concurrency,
          lastUsedAt: imageBackendAccount.lastUsedAt,
          lastAcquiredAt: imageBackendAccount.lastAcquiredAt,
          createdAt: imageBackendAccount.createdAt,
          metadata: imageBackendAccount.metadata,
        })
        .from(imageBackendAccount)
        .innerJoin(
          imageBackendAccountGroup,
          eq(imageBackendAccountGroup.accountId, imageBackendAccount.id)
        )
        .where(
          and(
            accountBaseWhere,
            inArray(imageBackendAccountGroup.groupId, groupIds)
          )
        )
        .orderBy(
          asc(imageBackendAccount.priority),
          asc(imageBackendAccount.lastUsedAt),
          asc(imageBackendAccount.createdAt)
        )
    : db
        .select({
          matchedGroupId: imageBackendAccount.groupId,
          id: imageBackendAccount.id,
          alwaysActive: imageBackendAccount.alwaysActive,
          groupId: imageBackendAccount.groupId,
          name: imageBackendAccount.name,
          accessToken: imageBackendAccount.accessToken,
          model: imageBackendAccount.model,
          implementationMode: imageBackendAccount.implementationMode,
          contentSafetyEnabled: imageBackendAccount.contentSafetyEnabled,
          priority: imageBackendAccount.priority,
          concurrency: imageBackendAccount.concurrency,
          lastUsedAt: imageBackendAccount.lastUsedAt,
          lastAcquiredAt: imageBackendAccount.lastAcquiredAt,
          createdAt: imageBackendAccount.createdAt,
          metadata: imageBackendAccount.metadata,
        })
        .from(imageBackendAccount)
        .where(
          and(
            accountBaseWhere,
            groupId ? eq(imageBackendAccount.groupId, groupId) : sql`true`
          )
        )
        .orderBy(
          asc(imageBackendAccount.priority),
          asc(imageBackendAccount.lastUsedAt),
          asc(imageBackendAccount.createdAt)
        );
  const apiBaseWhere = and(
    eq(imageBackendApi.isEnabled, true),
    // always_active 的 API 无视 cooldown 与临时故障始终入选,但 status="error"（终态）仍踢出
    // 轮换。其余维持原"健康且未冷却"判定。
    or(
      and(
        eq(imageBackendApi.alwaysActive, true),
        sql`${imageBackendApi.status} <> 'error'`
      ),
      and(
        isBackendAvailableStatus(
          imageBackendApi.status,
          imageBackendApi.cooldownUntil,
          now
        ),
        or(
          sql`${imageBackendApi.cooldownUntil} IS NULL`,
          sql`${imageBackendApi.cooldownUntil} <= ${now}`
        )
      )
    )
  );
  // groupIds 命中时经 imageBackendApiGroup join 取出该 API 所属的全部分组，
  // matchedGroupId 为本次命中的分组（供下游分组上下文解析）；未指定分组时退回
  // 主分组 groupId（matchedGroupId 直接取自 imageBackendApi.groupId）。
  const apiRowsPromise = groupIds.length
    ? db
        .select({
          matchedGroupId: imageBackendApiGroup.groupId,
          id: imageBackendApi.id,
          alwaysActive: imageBackendApi.alwaysActive,
          groupId: imageBackendApi.groupId,
          name: imageBackendApi.name,
          baseUrl: imageBackendApi.baseUrl,
          apiKey: imageBackendApi.apiKey,
          model: imageBackendApi.model,
          interfaceMode: imageBackendApi.interfaceMode,
          chatCompletionsUpstreamMode:
            imageBackendApi.chatCompletionsUpstreamMode,
          imageUpstreamMode: imageBackendApi.imageUpstreamMode,
          useStream: imageBackendApi.useStream,
          adobeSourced: imageBackendApi.adobeSourced,
          billingMultiplier: imageBackendApi.billingMultiplier,
          contentSafetyEnabled: imageBackendApi.contentSafetyEnabled,
          priority: imageBackendApi.priority,
          concurrency: imageBackendApi.concurrency,
          lastUsedAt: imageBackendApi.lastUsedAt,
          lastAcquiredAt: imageBackendApi.lastAcquiredAt,
          createdAt: imageBackendApi.createdAt,
          metadata: imageBackendApi.metadata,
        })
        .from(imageBackendApi)
        .innerJoin(
          imageBackendApiGroup,
          eq(imageBackendApiGroup.apiId, imageBackendApi.id)
        )
        .where(
          and(apiBaseWhere, inArray(imageBackendApiGroup.groupId, groupIds))
        )
        .orderBy(
          asc(imageBackendApi.priority),
          asc(imageBackendApi.lastUsedAt),
          asc(imageBackendApi.createdAt)
        )
    : db
        .select({
          matchedGroupId: imageBackendApi.groupId,
          id: imageBackendApi.id,
          alwaysActive: imageBackendApi.alwaysActive,
          groupId: imageBackendApi.groupId,
          name: imageBackendApi.name,
          baseUrl: imageBackendApi.baseUrl,
          apiKey: imageBackendApi.apiKey,
          model: imageBackendApi.model,
          interfaceMode: imageBackendApi.interfaceMode,
          chatCompletionsUpstreamMode:
            imageBackendApi.chatCompletionsUpstreamMode,
          imageUpstreamMode: imageBackendApi.imageUpstreamMode,
          useStream: imageBackendApi.useStream,
          adobeSourced: imageBackendApi.adobeSourced,
          billingMultiplier: imageBackendApi.billingMultiplier,
          contentSafetyEnabled: imageBackendApi.contentSafetyEnabled,
          priority: imageBackendApi.priority,
          concurrency: imageBackendApi.concurrency,
          lastUsedAt: imageBackendApi.lastUsedAt,
          lastAcquiredAt: imageBackendApi.lastAcquiredAt,
          createdAt: imageBackendApi.createdAt,
          metadata: imageBackendApi.metadata,
        })
        .from(imageBackendApi)
        .where(
          and(
            apiBaseWhere,
            groupId ? eq(imageBackendApi.groupId, groupId) : sql`true`
          )
        )
        .orderBy(
          asc(imageBackendApi.priority),
          asc(imageBackendApi.lastUsedAt),
          asc(imageBackendApi.createdAt)
        );

  // adobe（Firefly）候选：与 api 同构的入选条件（always_active 仅豁免临时故障，
  // status="error" 终态仍踢出）。
  const adobeBaseWhere = and(
    eq(imageBackendAdobe.isEnabled, true),
    or(
      and(
        eq(imageBackendAdobe.alwaysActive, true),
        sql`${imageBackendAdobe.status} <> 'error'`
      ),
      and(
        isBackendAvailableStatus(
          imageBackendAdobe.status,
          imageBackendAdobe.cooldownUntil,
          now
        ),
        or(
          sql`${imageBackendAdobe.cooldownUntil} IS NULL`,
          sql`${imageBackendAdobe.cooldownUntil} <= ${now}`
        )
      )
    )
  );
  const adobeSelection = {
    matchedGroupId: imageBackendAdobe.groupId,
    id: imageBackendAdobe.id,
    alwaysActive: imageBackendAdobe.alwaysActive,
    groupId: imageBackendAdobe.groupId,
    name: imageBackendAdobe.name,
    mode: imageBackendAdobe.mode,
    baseUrl: imageBackendAdobe.baseUrl,
    apiKey: imageBackendAdobe.apiKey,
    enabledModels: imageBackendAdobe.enabledModels,
    defaultRatio: imageBackendAdobe.defaultRatio,
    defaultResolution: imageBackendAdobe.defaultResolution,
    gptImageQuality: imageBackendAdobe.gptImageQuality,
    billingMultiplier: imageBackendAdobe.billingMultiplier,
    supportsVideo: imageBackendAdobe.supportsVideo,
    contentSafetyEnabled: imageBackendAdobe.contentSafetyEnabled,
    priority: imageBackendAdobe.priority,
    concurrency: imageBackendAdobe.concurrency,
    lastUsedAt: imageBackendAdobe.lastUsedAt,
    lastAcquiredAt: imageBackendAdobe.lastAcquiredAt,
    createdAt: imageBackendAdobe.createdAt,
    metadata: imageBackendAdobe.metadata,
  };
  // adobe 作为特殊 firefly account 成员，按分组归属参与调度（与 api/account 同源）：只从
  // 本次请求命中的分组拉取 adobe 后端，不再全局忽略分组。挂低优先级即天然成为兜底。
  const adobeRowsPromise = groupIds.length
    ? db
        .select({
          ...adobeSelection,
          matchedGroupId: imageBackendAdobeGroup.groupId,
        })
        .from(imageBackendAdobe)
        .innerJoin(
          imageBackendAdobeGroup,
          eq(imageBackendAdobeGroup.adobeId, imageBackendAdobe.id)
        )
        .where(
          and(adobeBaseWhere, inArray(imageBackendAdobeGroup.groupId, groupIds))
        )
        .orderBy(
          asc(imageBackendAdobe.priority),
          asc(imageBackendAdobe.lastUsedAt),
          asc(imageBackendAdobe.createdAt)
        )
    : db
        .select(adobeSelection)
        .from(imageBackendAdobe)
        .where(
          and(
            adobeBaseWhere,
            groupId ? eq(imageBackendAdobe.groupId, groupId) : sql`true`
          )
        )
        .orderBy(
          asc(imageBackendAdobe.priority),
          asc(imageBackendAdobe.lastUsedAt),
          asc(imageBackendAdobe.createdAt)
        );

  const [apiRows, accountRows, adobeRows] = await Promise.all([
    apiRowsPromise,
    accountRowsPromise,
    adobeRowsPromise,
  ]);

  const apiMembers: PoolMember[] = apiRows
    .filter((row) => {
      const matchedGroupId = row.matchedGroupId || row.groupId;
      const context = matchedGroupId ? contextMap.get(matchedGroupId) : null;
      const metadata = context?.metadata ?? groupMetadata;
      const effectiveRequestKind = requestKind || "image_generation";
      return (
        // fireflyOnly（force_firefly 或 firefly-* 模型）时通用 API 不参与、只走 adobe；
        // 但「Adobe 来源」api（上游即 Adobe）参与 firefly 候选：force_firefly 直接以 gpt
        // 格式服务，显式 firefly-* 由下游反向转换成 gpt 请求后服务。
        (!modelRouting.excludeAdobeBackends || !row.adobeSourced) &&
        (!fireflyOnly || row.adobeSourced) &&
        // 阶段参与纯按车道:web 偏好只取 web/mixed 分组的 API、codex 偏好只取 codex/mixed
        // 分组的 API（mixed 谁都可请求）。是否经 responses 端点出图属于"能否服务该
        // requestKind"的独立维度,交由下方 imageBackendApiInterfaceAllowsRequest 按请求
        // 类型筛(images-only API 对 responses/chat 请求自然返回 false),不在此用阶段去卡。
        memberAllowedForPhase(
          getGroupBackendType(metadata),
          effectiveAccountBackendPreference,
          fireflyOnly
        ) &&
        groupBackendAllowsRequest(metadata, effectiveRequestKind) &&
        imageBackendApiInterfaceAllowsRequest(
          row.interfaceMode,
          effectiveRequestKind,
          row.imageUpstreamMode,
          row.chatCompletionsUpstreamMode
        )
      );
    })
    .map((row) => {
      const matchedGroupId = row.matchedGroupId || row.groupId;
      const context = matchedGroupId ? contextMap.get(matchedGroupId) : null;
      return {
        type: "api",
        id: row.id,
        alwaysActive: row.alwaysActive,
        groupId: matchedGroupId,
        groupIds: normalizeAccountGroupIds([row.groupId, row.matchedGroupId]),
        groupMetadata: context?.metadata ?? groupMetadata ?? null,
        groupContentSafetyEnabled:
          context?.contentSafetyEnabled ?? groupContentSafetyEnabled ?? null,
        name: row.name,
        baseUrl: row.baseUrl,
        apiKey: row.apiKey,
        model: row.model,
        interfaceMode: normalizeImageBackendApiInterfaceMode(row.interfaceMode),
        chatCompletionsUpstreamMode: normalizeChatCompletionsUpstreamMode(
          row.chatCompletionsUpstreamMode
        ),
        imagesUpstreamMode: normalizeImagesUpstreamMode(row.imageUpstreamMode),
        useStream: row.useStream,
        adobeSourced: row.adobeSourced,
        billingMultiplier: Number(row.billingMultiplier) || 1,
        contentSafetyEnabled: row.contentSafetyEnabled,
        priority: row.priority,
        concurrency: row.concurrency,
        lastUsedAt: row.lastUsedAt,
        lastAcquiredAt: row.lastAcquiredAt,
        createdAt: row.createdAt,
        metadata: row.metadata,
      };
    });

  const accountMembers: PoolMember[] = accountRows
    .filter((row) => {
      const backend = normalizeAccountBackend(row.implementationMode);
      const matchedGroupId = row.matchedGroupId || row.groupId;
      const context = matchedGroupId ? contextMap.get(matchedGroupId) : null;
      const metadata = context?.metadata ?? groupMetadata;
      const rowPreference = matchedGroupId
        ? effectiveContextPreferences.get(matchedGroupId)
        : effectiveAccountBackendPreference;
      return (
        // fireflyOnly（force_firefly 或 firefly-* 模型）时只走 adobe，codex/web 账号不参与。
        !fireflyOnly &&
        // 账号的"车道"由其自身 implementationMode（web / responses）天然决定:web 账号属 web
        // 车道、responses 账号属 codex 车道。故按「该分组生效偏好 rowPreference == 账号
        // implementationMode」过滤即已实现 web/codex 阶段隔离——mixed 分组 web 阶段只取 web
        // 账号,responses 账号留待回退后的 codex 阶段(届时 rowPreference="responses" 命中)。
        // 这与 api/adobe 不同:后者无固有类型,用 memberAllowedForPhase 按【分组】车道判定;此处
        // 刻意不套 memberAllowedForPhase,否则会把 responses 账号误放进 web 阶段、破坏 web 先行。
        (!rowPreference || rowPreference === backend) &&
        groupBackendAllowsAccount(metadata, backend) &&
        accountBackendAllowsRequest(
          backend,
          requestKind || "image_generation"
        ) &&
        isWebAccountQuotaAvailable(backend, row.metadata, now)
      );
    })
    .map((row) => ({
      type: "account",
      id: row.id,
      alwaysActive: row.alwaysActive,
      groupId: row.matchedGroupId || row.groupId,
      groupIds: normalizeAccountGroupIds([row.groupId, row.matchedGroupId]),
      groupMetadata:
        (row.matchedGroupId
          ? contextMap.get(row.matchedGroupId)?.metadata
          : null) ??
        groupMetadata ??
        null,
      groupContentSafetyEnabled:
        (row.matchedGroupId
          ? contextMap.get(row.matchedGroupId)?.contentSafetyEnabled
          : null) ??
        groupContentSafetyEnabled ??
        null,
      name: row.name,
      accessToken: row.accessToken,
      model: row.model,
      implementationMode: row.implementationMode,
      contentSafetyEnabled: row.contentSafetyEnabled,
      priority: row.priority,
      concurrency: row.concurrency,
      lastUsedAt: row.lastUsedAt,
      lastAcquiredAt: row.lastAcquiredAt,
      createdAt: row.createdAt,
      metadata: row.metadata,
    }));

  // 非纯 Web 主组中，Adobe 对生成/编辑请求作为同池候选；纯 Web 固定 2.5 时排除
  // 会改回旧型号的 Adobe，避免已授权的组路由在实际出站时失效。
  const adobeMembers: PoolMember[] = adobeRows
    .filter((row) => {
      const matchedGroupId = row.matchedGroupId || row.groupId;
      const context = matchedGroupId ? contextMap.get(matchedGroupId) : null;
      const metadata = context?.metadata ?? groupMetadata;
      const effectiveRequestKind = requestKind || "image_generation";
      return (
        !modelRouting.excludeAdobeBackends &&
        (effectiveRequestKind === "image_generation" ||
          effectiveRequestKind === "image_edit") &&
        groupBackendAllowsRequest(metadata, effectiveRequestKind) &&
        // adobe 按所在分组的 backendType 充当该车道兜底:web 偏好请求不再漏到 codex
        // 等非 web 车道的 adobe(挂在混合分组的不限车道,谁都可请求）。
        memberAllowedForPhase(
          getGroupBackendType(metadata),
          effectiveAccountBackendPreference,
          fireflyOnly
        )
      );
    })
    .map((row) => {
      const matchedGroupId = row.matchedGroupId || row.groupId;
      const context = matchedGroupId ? contextMap.get(matchedGroupId) : null;
      return {
        type: "adobe" as const,
        id: row.id,
        alwaysActive: row.alwaysActive,
        groupId: matchedGroupId,
        groupIds: normalizeAccountGroupIds([row.groupId, row.matchedGroupId]),
        groupMetadata: context?.metadata ?? groupMetadata ?? null,
        groupContentSafetyEnabled:
          context?.contentSafetyEnabled ?? groupContentSafetyEnabled ?? null,
        name: row.name,
        mode: row.mode,
        baseUrl: row.baseUrl,
        apiKey: row.apiKey,
        enabledModels: row.enabledModels ?? null,
        defaultRatio: row.defaultRatio,
        defaultResolution: row.defaultResolution,
        gptImageQuality: row.gptImageQuality,
        // DB numeric 取回为字符串，强转并兜底 1。
        billingMultiplier: Number(row.billingMultiplier) || 1,
        supportsVideo: row.supportsVideo,
        contentSafetyEnabled: row.contentSafetyEnabled,
        priority: row.priority,
        concurrency: row.concurrency,
        lastUsedAt: row.lastUsedAt,
        lastAcquiredAt: row.lastAcquiredAt,
        createdAt: row.createdAt,
        metadata: row.metadata,
      };
    });

  const notExcludedCandidates = [
    ...apiMembers,
    ...accountMembers,
    ...adobeMembers,
  ].filter((member) => !excluded?.has(backendKey(member)));
  const availableCandidates = notExcludedCandidates.filter(hasBackendCapacity);
  // 仅因并发占满、值得"短等"的真·web 成员(非常驻 web 账号/API)。冷却成员已被 DB WHERE
  // 滤除、不在 notExcludedCandidates 内,天然不计入;常驻由判定排除。
  const webCapacityWaitCandidates = notExcludedCandidates.filter((member) =>
    isWebCapacityWaitCandidate(
      member,
      effectiveAccountBackendPreference,
      !hasBackendCapacity(member)
    )
  );
  const stickyPreviousCandidates = stickyPreviousMember
    ? availableCandidates
        .filter(
          (member) =>
            member.type === stickyPreviousMember.type &&
            member.id === stickyPreviousMember.id
        )
        .map((member) => ({
          ...member,
          schedulerLayer: "previous_response_id" as const,
        }))
    : [];
  const stickySessionCandidates = stickySessionMember
    ? availableCandidates
        .filter(
          (member) =>
            member.type === stickySessionMember.type &&
            member.id === stickySessionMember.id &&
            !stickyPreviousCandidates.some(
              (stickyMember) => backendKey(stickyMember) === backendKey(member)
            )
        )
        .map((member) => ({
          ...member,
          schedulerLayer: "session_hash" as const,
        }))
    : [];
  const preferredCandidates =
    preferredMemberId || preferredMemberType
      ? availableCandidates.filter(
          (member) =>
            (!preferredMemberId || member.id === preferredMemberId) &&
            (!preferredMemberType || member.type === preferredMemberType) &&
            !stickyPreviousCandidates.some(
              (stickyMember) => backendKey(stickyMember) === backendKey(member)
            ) &&
            !stickySessionCandidates.some(
              (stickyMember) => backendKey(stickyMember) === backendKey(member)
            )
        )
      : [];
  const markedPreferredCandidates = preferredCandidates.map((member) => ({
    ...member,
    schedulerLayer: "preferred" as const,
  }));
  const ordinaryCandidatePool = availableCandidates.filter(
    (member) =>
      !stickyPreviousCandidates.some(
        (stickyMember) => backendKey(stickyMember) === backendKey(member)
      ) &&
      !stickySessionCandidates.some(
        (stickyMember) => backendKey(stickyMember) === backendKey(member)
      ) &&
      !preferredCandidates.includes(member)
  );
  const ordinaryCandidateGroups = new Map<string, PoolMember[]>();
  const ordinaryGroupOrder: string[] = [];
  for (const member of ordinaryCandidatePool) {
    const key = [member.priority, healthBucket(member)].join(":");
    if (!ordinaryCandidateGroups.has(key)) {
      ordinaryCandidateGroups.set(key, []);
      ordinaryGroupOrder.push(key);
    }
    ordinaryCandidateGroups.get(key)?.push(member);
  }
  ordinaryGroupOrder.sort((leftKey, rightKey) => {
    const left = ordinaryCandidateGroups.get(leftKey)?.[0];
    const right = ordinaryCandidateGroups.get(rightKey)?.[0];
    if (!left || !right) return 0;
    const priorityDiff = left.priority - right.priority;
    if (priorityDiff !== 0) return priorityDiff;
    return healthBucket(left) - healthBucket(right);
  });
  const ordinaryCandidates = ordinaryGroupOrder
    .flatMap((groupKey) => {
      const group = ordinaryCandidateGroups.get(groupKey) || [];
      const sortedGroup = group.sort((left, right) => {
        const acquiredDiff =
          memberTimestamp(left.lastAcquiredAt) -
          memberTimestamp(right.lastAcquiredAt);
        if (acquiredDiff !== 0) return acquiredDiff;
        const lastUsedDiff =
          memberTimestamp(left.lastUsedAt) - memberTimestamp(right.lastUsedAt);
        if (lastUsedDiff !== 0) return lastUsedDiff;
        return (
          memberTimestamp(left.createdAt) - memberTimestamp(right.createdAt)
        );
      });
      return sortedGroup;
    })
    .map((member) => ({
      ...member,
      schedulerLayer: "load_balance" as const,
    }));
  const candidates = [
    ...stickyPreviousCandidates,
    ...stickySessionCandidates,
    ...markedPreferredCandidates,
    ...ordinaryCandidates,
  ];

  let sawStaleCandidate = false;
  for (const member of candidates) {
    const leaseResult = await acquirePoolMemberInflightLease(member, {
      enforceLastAcquiredSnapshot:
        (member.schedulerLayer || "load_balance") === "load_balance",
    });
    if (leaseResult === "stale") {
      sawStaleCandidate = true;
      continue;
    }
    if (leaseResult === "acquired") {
      await recordSchedulerMetric({
        requestKind,
        layer: member.schedulerLayer || "load_balance",
        memberType: member.type,
        memberId: member.id,
        groupId: member.groupId,
        candidateCount: availableCandidates.length,
        latencyMs: Date.now() - selectionStartedAt,
      });
      return member;
    }
  }

  if (
    sawStaleCandidate &&
    staleRetryCount < MAX_BACKEND_STALE_SELECTION_RETRIES
  ) {
    return selectPoolMember(
      groupId,
      groupMetadata,
      groupContentSafetyEnabled,
      groupContexts,
      requestKind,
      excluded,
      preferredMemberId,
      preferredMemberType,
      stickyPreviousMember,
      stickySessionMember,
      accountBackendPreference,
      accountBackendPreferenceMode,
      modelRouting.requestedModel,
      modelRouting.forceFirefly,
      staleRetryCount + 1,
      capacityWaitCount,
      accountPlanFilter
    );
  }

  // 满并发短等(仅 web 偏好阶段):真·web 车道仍有成员(非常驻 web 账号/API)仅因并发占满
  // 而暂不可用时,短延迟后重选,给它让出并发槽再试的机会——避免 web 车道尚未轮询完就回退
  // codex。冷却成员已被 DB WHERE 滤除并视作"已尝试"(不在此等待);常驻不计入(其满并发不
  // 构成"web 仍可用")。预算耗尽仍无可用 → 返回 null → 上层据此判"web 已轮询完"回退。
  if (
    webCapacityWaitCandidates.length > 0 &&
    capacityWaitCount < MAX_WEB_CAPACITY_WAIT_RETRIES
  ) {
    await sleep(WEB_CAPACITY_WAIT_DELAY_MS);
    return selectPoolMember(
      groupId,
      groupMetadata,
      groupContentSafetyEnabled,
      groupContexts,
      requestKind,
      excluded,
      preferredMemberId,
      preferredMemberType,
      stickyPreviousMember,
      stickySessionMember,
      accountBackendPreference,
      accountBackendPreferenceMode,
      modelRouting.requestedModel,
      modelRouting.forceFirefly,
      staleRetryCount,
      capacityWaitCount + 1,
      accountPlanFilter
    );
  }

  return null;
}

async function touchSelectedMember(member: PoolMember) {
  const now = new Date();
  if (member.type === "api") {
    await db
      .update(imageBackendApi)
      .set({
        status: "active",
        cooldownUntil: null,
        lastUsedAt: now,
        lastAcquiredAt: now,
        updatedAt: now,
      })
      .where(eq(imageBackendApi.id, member.id));
    return;
  }

  if (member.type === "adobe") {
    await db
      .update(imageBackendAdobe)
      .set({
        status: "active",
        cooldownUntil: null,
        lastUsedAt: now,
        lastAcquiredAt: now,
        updatedAt: now,
      })
      .where(eq(imageBackendAdobe.id, member.id));
    return;
  }

  await db
    .update(imageBackendAccount)
    .set({
      status: "active",
      cooldownUntil: null,
      lastUsedAt: now,
      lastAcquiredAt: now,
      updatedAt: now,
    })
    .where(eq(imageBackendAccount.id, member.id));
}

function toResolvedPoolConfig(
  fallbackGroupId: string,
  member: PoolMember,
  options: ResolveBackendOptions,
  billingGroupMetadata?: Record<string, unknown> | null
): ResolvedImageBackendPoolConfig {
  const groupId = member.groupId || fallbackGroupId;
  const billingMultiplier = getEffectiveBillingMultiplierForSelectedGroup({
    selectedGroupId: fallbackGroupId,
    selectedGroupMetadata: billingGroupMetadata,
    selectedMemberGroupId: member.groupId,
    selectedMemberGroupMetadata: member.groupMetadata,
  });
  const contentSafetyEnabled = effectiveContentSafety(
    member.groupContentSafetyEnabled,
    member.contentSafetyEnabled
  );
  // 目标(主)分组 backendType:供换号重试循环判定 web→codex 回退是否适用(仅 mixed 分组
  // 才"web 先行→轮询完→回退 codex";纯 web/codex 分组各自闭环不跨车道回退)。
  const groupBackendType = getGroupBackendType(billingGroupMetadata);

  if (member.type === "api") {
    return {
      config: {
        baseUrl: stripTrailingSlash(member.baseUrl),
        apiKey: member.apiKey,
        model: member.model || undefined,
        useStream: member.useStream,
        contentSafetyEnabled,
        backend: {
          type: "pool-api",
          id: member.id,
          groupId,
          groupBackendType,
          userId: options.userId,
          apiKeyId: options.apiKeyId,
          requestKind: options.requestKind,
          apiInterfaceMode: member.interfaceMode,
          chatCompletionsUpstreamMode: member.chatCompletionsUpstreamMode,
          imagesUpstreamMode: member.imagesUpstreamMode,
          apiForceResponsesEndpoint:
            options.accountBackendPreference === "responses",
          adobeSourced: member.adobeSourced,
          billingGroupId: fallbackGroupId,
          // Adobe 来源 api：组倍率 × 本后端倍率（复用 Adobe 伪账号同一倍率链）；
          // 普通 api 不套成员倍率，仅组倍率。
          billingMultiplier: member.adobeSourced
            ? billingMultiplier * (member.billingMultiplier || 1)
            : billingMultiplier,
          reportResult: true,
          inflightLease: true,
          inflightLeaseId: member.leaseId,
          inflightLeasePersisted: member.leasePersisted,
        },
      },
      groupId,
      memberId: member.id,
      memberType: "api",
      contentSafetyEnabled,
      schedulerLayer: member.schedulerLayer,
    };
  }

  if (member.type === "adobe") {
    return {
      config: {
        baseUrl: stripTrailingSlash(member.baseUrl),
        apiKey: member.apiKey,
        contentSafetyEnabled,
        backend: {
          type: "pool-adobe",
          id: member.id,
          groupId,
          groupBackendType,
          userId: options.userId,
          apiKeyId: options.apiKeyId,
          requestKind: options.requestKind,
          adobeMode: member.mode === "direct" ? "direct" : "gateway",
          adobeEnabledModels: member.enabledModels,
          adobeDefaultRatio: member.defaultRatio,
          adobeDefaultResolution: member.defaultResolution,
          adobeGptImageQuality: member.gptImageQuality,
          adobeSupportsVideo: member.supportsVideo,
          billingGroupId: fallbackGroupId,
          // 组倍率 × 本 Adobe 后端倍率（叠加），作用于图像与视频扣费。
          billingMultiplier:
            billingMultiplier * (member.billingMultiplier || 1),
          reportResult: true,
          inflightLease: true,
          inflightLeaseId: member.leaseId,
          inflightLeasePersisted: member.leasePersisted,
        },
      },
      groupId,
      memberId: member.id,
      memberType: "adobe",
      contentSafetyEnabled,
      schedulerLayer: member.schedulerLayer,
    };
  }

  const implementationMode = normalizeAccountBackend(member.implementationMode);
  const isResponsesBackend = implementationMode === "responses";
  const chatgptAccountId =
    (implementationMode === "web"
      ? chatGptAccountIdFromAccessToken(member.accessToken)
      : "") || metadataString(member.metadata, "chatgptAccountId");

  return {
    config: {
      baseUrl: isResponsesBackend
        ? CHATGPT_CODEX_RESPONSES_URL
        : "https://chatgpt.com",
      apiKey: member.accessToken,
      model: member.model || undefined,
      useStream: isResponsesBackend ? true : undefined,
      contentSafetyEnabled,
      headers: isResponsesBackend
        ? {
            "OpenAI-Beta": "responses=experimental",
            originator: "codex_cli_rs",
            Version: CODEX_CLI_VERSION,
            "User-Agent": CODEX_CLI_USER_AGENT,
            ...(chatgptAccountId
              ? { "chatgpt-account-id": chatgptAccountId }
              : {}),
          }
        : chatgptAccountId
          ? { "ChatGPT-Account-Id": chatgptAccountId }
          : undefined,
      backend: {
        type: "pool-account",
        id: member.id,
        groupId,
        groupBackendType,
        userId: options.userId,
        apiKeyId: options.apiKeyId,
        requestKind: options.requestKind,
        accountBackend: implementationMode,
        billingGroupId: fallbackGroupId,
        billingMultiplier,
        reportResult: true,
        inflightLease: true,
        inflightLeaseId: member.leaseId,
        inflightLeasePersisted: member.leasePersisted,
      },
    },
    groupId,
    memberId: member.id,
    memberType: "account",
    contentSafetyEnabled,
    schedulerLayer: member.schedulerLayer,
  };
}

async function resolvePoolMember(
  options: ResolveBackendOptions & { excluded?: Set<string> }
) {
  const userPlan = await getUserPlan(options.userId);
  // PPT/PSD:跨组直取付费 web,绕过 apiKeyId/偏好的分组作用域(像站内 UI 一样命中付费 web)。
  if (options.spanGroupsForWeb) {
    return await resolveAnyWebPoolMember(options, userPlan.plan);
  }
  const requestedGroup = await resolveRequestedGroup(options, userPlan.plan);
  const canFallbackToAnyResponses =
    options.allowAnyResponsesBackend && options.requestKind === "responses";
  const resolveAnyResponsesMember = async () => {
    if (!canFallbackToAnyResponses) return null;
    return await resolveAnyResponsesPoolMember(options, userPlan.plan);
  };
  const requestedGroupId = requestedGroup.groupId;
  const group = await ensureGroupUsable(requestedGroupId, userPlan.plan);
  if (!group) {
    const fallback = await resolveAnyResponsesMember();
    if (fallback) return fallback;
    if (requestedGroup.explicit) {
      throw new ImageBackendPoolUnavailableError(
        "选择的生图后端分组不可用或当前套餐不可用"
      );
    }
    return null;
  }

  if (!groupBackendAllowsRequest(group.metadata, options.requestKind)) {
    const fallback = await resolveAnyResponsesMember();
    if (fallback) return fallback;
    if (requestedGroup.explicit) {
      throw new ImageBackendPoolUnavailableError(
        `生图后端分组「${group.name}」不支持当前请求类型`
      );
    }
    return null;
  }

  const [stickyPreviousMember, stickySessionMember] = await Promise.all([
    resolveStickyBinding({
      layer: "previous_response_id",
      key: options.stickyPreviousResponseId,
    }),
    resolveStickyBinding({
      layer: "session_hash",
      key: options.stickySessionKey,
    }),
  ]);

  const modelRouting = resolvePoolModelRouting({
    groupBackendType: getGroupBackendType(group.metadata),
    requestKind: options.requestKind,
    requestedModel: options.requestedModel,
    forceFirefly: options.forceFirefly,
  });
  const member = await selectPoolMember(
    group.id,
    group.metadata,
    group.contentSafetyEnabled,
    await listSelectableGroupContexts(
      group,
      userPlan.plan,
      options.requestKind
    ),
    options.requestKind,
    options.excluded,
    options.preferredMemberId,
    options.preferredMemberType,
    stickyPreviousMember,
    stickySessionMember,
    options.accountBackendPreference,
    options.accountBackendPreferenceMode,
    modelRouting.requestedModel,
    modelRouting.forceFirefly,
    0,
    0,
    options.accountPlanFilter ?? "any"
  );
  if (!member) {
    const fallback = await resolveAnyResponsesMember();
    if (fallback) return fallback;
    // 默认 Web 组同样保留已验权的组上下文，避免上层按被忽略的 Firefly 名称误报 Adobe 故障。
    if (
      requestedGroup.explicit ||
      getGroupBackendType(group.metadata) === "web"
    ) {
      throw new ImageBackendPoolUnavailableError(
        `生图后端分组「${group.name}」没有可用账号或 API`
      );
    }
    return null;
  }

  return { group, member };
}

/**
 * 跨组选一个真 web 账号(accountBackend==="web"),忽略 apiKeyId/用户偏好的分组作用域。
 * 供 PPT/PSD 可编辑文件生成用:付费 web 账号集中在专用分组,外部 key 绑定组常够不到;这里
 * 遍历全部启用分组(按 priority),对每组按 web 偏好选号,只接受真 web 成员;选到非 web(混合组
 * 里的 api/responses)则释放其租约、继续下一组,避免占着不放。
 */
async function resolveAnyWebPoolMember(
  options: ResolveBackendOptions & { excluded?: Set<string> },
  plan: SubscriptionPlan
) {
  const groups = await db
    .select()
    .from(imageBackendGroup)
    .where(eq(imageBackendGroup.isEnabled, true))
    .orderBy(asc(imageBackendGroup.priority), asc(imageBackendGroup.createdAt));

  for (const group of groups) {
    if (!canUseBackendGroupForPlan(group.metadata, plan)) continue;
    if (!groupBackendAllowsRequest(group.metadata, options.requestKind)) {
      continue;
    }
    const modelRouting = resolvePoolModelRouting({
      groupBackendType: getGroupBackendType(group.metadata),
      requestKind: options.requestKind,
      requestedModel: options.requestedModel,
      forceFirefly: options.forceFirefly,
    });
    const member = await selectPoolMember(
      group.id,
      group.metadata,
      group.contentSafetyEnabled,
      await listSelectableGroupContexts(group, plan, options.requestKind),
      options.requestKind,
      options.excluded,
      options.preferredMemberId,
      options.preferredMemberType,
      null,
      null,
      "web",
      options.accountBackendPreferenceMode,
      modelRouting.requestedModel,
      modelRouting.forceFirefly,
      0,
      0,
      options.accountPlanFilter ?? "any"
    );
    if (!member) continue;
    if (member.type === "account" && member.implementationMode === "web") {
      return { group, member };
    }
    // 非 web 成员(混合组里的 api/responses、或非 web 的 account):释放租约后试下一组。
    await releaseImageBackendInflightLease({
      memberType: member.type,
      memberId: member.id,
      leaseId: member.leaseId,
      leasePersisted: member.leasePersisted,
    }).catch(() => {});
  }

  return null;
}

async function resolveAnyResponsesPoolMember(
  options: ResolveBackendOptions & { excluded?: Set<string> },
  plan: SubscriptionPlan
) {
  const groups = await db
    .select()
    .from(imageBackendGroup)
    .where(eq(imageBackendGroup.isEnabled, true))
    .orderBy(asc(imageBackendGroup.priority), asc(imageBackendGroup.createdAt));

  for (const group of groups) {
    if (!canUseBackendGroupForPlan(group.metadata, plan)) continue;
    if (!groupBackendAllowsRequest(group.metadata, "responses")) continue;
    const [stickyPreviousMember, stickySessionMember] = await Promise.all([
      resolveStickyBinding({
        layer: "previous_response_id",
        key: options.stickyPreviousResponseId,
      }),
      resolveStickyBinding({
        layer: "session_hash",
        key: options.stickySessionKey,
      }),
    ]);
    const modelRouting = resolvePoolModelRouting({
      groupBackendType: getGroupBackendType(group.metadata),
      requestKind: "responses",
      requestedModel: options.requestedModel,
      forceFirefly: options.forceFirefly,
    });
    const member = await selectPoolMember(
      group.id,
      group.metadata,
      group.contentSafetyEnabled,
      await listSelectableGroupContexts(group, plan, "responses"),
      "responses",
      options.excluded,
      options.preferredMemberId,
      options.preferredMemberType,
      stickyPreviousMember,
      stickySessionMember,
      "responses",
      options.accountBackendPreferenceMode,
      modelRouting.requestedModel,
      modelRouting.forceFirefly,
      0,
      0,
      options.accountPlanFilter ?? "any"
    );
    if (member) return { group, member };
  }

  return null;
}

export async function resolveImageBackendPoolConfig(
  options: ResolveBackendOptions & { excludedMemberKeys?: string[] }
): Promise<ResolvedImageBackendPoolConfig | null> {
  const resolved = await resolvePoolMember({
    ...options,
    excluded: new Set(options.excludedMemberKeys || []),
  });
  if (!resolved) return null;
  try {
    if (!resolved.member.leaseTouchedMember) {
      await touchSelectedMember(resolved.member);
    }
    const result = toResolvedPoolConfig(
      resolved.group.id,
      resolved.member,
      options,
      resolved.group.metadata
    );
    // 与选号使用同一主组策略；纯 Web 组不得在写回时恢复原始 Firefly 意图。
    if (result?.config.backend) {
      result.config.backend.fireflyOnly = resolvePoolModelRouting({
        groupBackendType: getGroupBackendType(resolved.group.metadata),
        requestKind: options.requestKind,
        requestedModel: options.requestedModel,
        forceFirefly: options.forceFirefly,
      }).fireflyOnly;
    }
    return result;
  } catch (error) {
    await releaseImageBackendInflightLease({
      memberType: resolved.member.type,
      memberId: resolved.member.id,
      leaseId: resolved.member.leaseId,
      leasePersisted: resolved.member.leasePersisted,
    });
    throw error;
  }
}

export async function reportImageBackendResult(
  input: ImageBackendReportResultInput
): Promise<ImageBackendReportResultOutcome> {
  if (!input.memberId || !input.memberType) {
    return { success: input.success, retryable: false, switchable: false };
  }
  const now = new Date();
  const error = truncateError(input.error);
  const failure = input.success ? {} : await classifyFailure(error, input);

  if (input.memberType === "api") {
    const [api] = await db
      .select({
        metadata: imageBackendApi.metadata,
        alwaysActive: imageBackendApi.alwaysActive,
        status: imageBackendApi.status,
        failureCooldownEnabled: imageBackendApi.failureCooldownEnabled,
      })
      .from(imageBackendApi)
      .where(eq(imageBackendApi.id, input.memberId))
      .limit(1);
    const alwaysActive = api?.alwaysActive ?? false;
    const effectiveFailure = input.success
      ? failure
      : resolveEffectiveFailureForMember(
          "api",
          failure,
          api?.failureCooldownEnabled ?? false
        );
    const outcome = {
      success: input.success,
      status: effectiveFailure.status,
      cooldownUntil: effectiveFailure.cooldownUntil,
      retryable:
        !input.success &&
        isClassifiedFailureRecoverable(error, effectiveFailure),
      switchable: !input.success && isImageBackendSwitchableError(error),
    };
    const metadata = nextSchedulerMetadataAfterResult(
      api?.metadata,
      input,
      now
    );
    // always_active：常驻后端遇任何失败（含 502/HTML 等 dead-relay 终态错误）都不自动下线，
    // 仅记 lastError/failCount，详见 resolveAlwaysActiveFailure。
    const apiFailure = resolveAlwaysActiveFailure(
      alwaysActive,
      effectiveFailure
    );
    // error 粘性：非常驻后端一旦被置 error，成功不再复活它（高并发下成功多来自
    // 早已在飞的兄弟请求）。只由 测活/手动重新启用/编辑保存/常驻 清除 error。
    const stickyError = api?.status === "error" && !alwaysActive;
    await db
      .update(imageBackendApi)
      .set(
        input.success
          ? stickyError
            ? {
                successCount: sql`${imageBackendApi.successCount} + 1`,
                metadata,
                updatedAt: now,
              }
            : {
                successCount: sql`${imageBackendApi.successCount} + 1`,
                metadata,
                status: "active",
                lastError: null,
                lastErrorAt: null,
                cooldownUntil: null,
                updatedAt: now,
              }
          : {
              failCount: sql`${imageBackendApi.failCount} + 1`,
              metadata,
              ...(apiFailure.status ? { status: apiFailure.status } : {}),
              ...(apiFailure.cooldownUntil !== undefined
                ? { cooldownUntil: apiFailure.cooldownUntil }
                : {}),
              lastError: error,
              lastErrorAt: now,
              updatedAt: now,
            }
      )
      .where(eq(imageBackendApi.id, input.memberId));
    if (!input.success) {
      logWarn("生图 API 后端失败，已更新调度状态", {
        memberType: input.memberType,
        memberId: input.memberId,
        status: effectiveFailure.status || "unchanged",
        cooldownUntil: effectiveFailure.cooldownUntil
          ? effectiveFailure.cooldownUntil.toISOString()
          : null,
        retryable: outcome.retryable,
        switchable: outcome.switchable,
        error,
      });
    }
    return outcome;
  }

  if (input.memberType === "adobe") {
    const [adobe] = await db
      .select({
        metadata: imageBackendAdobe.metadata,
        alwaysActive: imageBackendAdobe.alwaysActive,
        status: imageBackendAdobe.status,
        failureCooldownEnabled: imageBackendAdobe.failureCooldownEnabled,
      })
      .from(imageBackendAdobe)
      .where(eq(imageBackendAdobe.id, input.memberId))
      .limit(1);
    const alwaysActive = adobe?.alwaysActive ?? false;
    const effectiveFailure = input.success
      ? failure
      : resolveEffectiveFailureForMember(
          "adobe",
          failure,
          adobe?.failureCooldownEnabled ?? false
        );
    const outcome = {
      success: input.success,
      status: effectiveFailure.status,
      cooldownUntil: effectiveFailure.cooldownUntil,
      retryable:
        !input.success &&
        isClassifiedFailureRecoverable(error, effectiveFailure),
      switchable: !input.success && isImageBackendSwitchableError(error),
    };
    const metadata = nextSchedulerMetadataAfterResult(
      adobe?.metadata,
      input,
      now
    );
    // 与 api 同款：always_active 常驻后端遇任何失败都不自动下线（含终态 502/HTML），
    // 详见 resolveAlwaysActiveFailure。
    const adobeFailure = resolveAlwaysActiveFailure(
      alwaysActive,
      effectiveFailure
    );
    const stickyError = adobe?.status === "error" && !alwaysActive;
    await db
      .update(imageBackendAdobe)
      .set(
        input.success
          ? stickyError
            ? {
                successCount: sql`${imageBackendAdobe.successCount} + 1`,
                metadata,
                updatedAt: now,
              }
            : {
                successCount: sql`${imageBackendAdobe.successCount} + 1`,
                metadata,
                status: "active",
                lastError: null,
                lastErrorAt: null,
                cooldownUntil: null,
                updatedAt: now,
              }
          : {
              failCount: sql`${imageBackendAdobe.failCount} + 1`,
              metadata,
              ...(adobeFailure.status ? { status: adobeFailure.status } : {}),
              ...(adobeFailure.cooldownUntil !== undefined
                ? { cooldownUntil: adobeFailure.cooldownUntil }
                : {}),
              lastError: error,
              lastErrorAt: now,
              updatedAt: now,
            }
      )
      .where(eq(imageBackendAdobe.id, input.memberId));
    if (!input.success) {
      logWarn("生图 Adobe 后端失败，已更新调度状态", {
        memberType: input.memberType,
        memberId: input.memberId,
        status: effectiveFailure.status || "unchanged",
        cooldownUntil: effectiveFailure.cooldownUntil
          ? effectiveFailure.cooldownUntil.toISOString()
          : null,
        retryable: outcome.retryable,
        switchable: outcome.switchable,
        error,
      });
    }
    return outcome;
  }

  const effectiveFailure = input.success
    ? failure
    : resolveEffectiveFailureForMember("account", failure, false);
  const outcome = {
    success: input.success,
    status: effectiveFailure.status,
    cooldownUntil: effectiveFailure.cooldownUntil,
    retryable:
      !input.success && isClassifiedFailureRecoverable(error, effectiveFailure),
    switchable: !input.success && isImageBackendSwitchableError(error),
  };

  const [account] = await db
    .select({
      implementationMode: imageBackendAccount.implementationMode,
      metadata: imageBackendAccount.metadata,
      alwaysActive: imageBackendAccount.alwaysActive,
    })
    .from(imageBackendAccount)
    .where(eq(imageBackendAccount.id, input.memberId))
    .limit(1);
  const alwaysActive = account?.alwaysActive ?? false;
  // always_active：遇【临时】错误不下线——不改 status、不进冷却（仅记 lastError/failCount）。
  // 例外：终态/鉴权类错误（status="error"，如 token 失效、401/403、凭据失效、封号、
  // GROUP_DISABLED）必须照样标 error——死号无法靠常驻自愈,否则常驻入选→必失败→再入选,
  // 形成持续吃流量的黑洞。临时错误（overload/5xx，status=active+cooldown）仍受常驻豁免。
  const accountFailure =
    alwaysActive && failure?.status !== "error" ? {} : failure;
  const backend = normalizeAccountBackend(account?.implementationMode);
  const webSuccess =
    input.success && backend === "web"
      ? nextWebAccountMetadataAfterSuccess(account?.metadata)
      : null;
  const metadata = nextSchedulerMetadataAfterResult(
    webSuccess?.metadata ?? account?.metadata,
    input,
    now
  );

  await db
    .update(imageBackendAccount)
    .set(
      input.success
        ? {
            successCount: sql`${imageBackendAccount.successCount} + 1`,
            metadata,
            status: webSuccess?.status || "active",
            lastError: null,
            lastErrorAt: null,
            cooldownUntil: webSuccess ? webSuccess.cooldownUntil : null,
            updatedAt: now,
          }
        : {
            failCount: sql`${imageBackendAccount.failCount} + 1`,
            metadata,
            ...(accountFailure.status ? { status: accountFailure.status } : {}),
            ...(accountFailure.cooldownUntil !== undefined
              ? { cooldownUntil: accountFailure.cooldownUntil }
              : {}),
            lastError: error,
            lastErrorAt: now,
            updatedAt: now,
          }
    )
    .where(eq(imageBackendAccount.id, input.memberId));
  if (!input.success) {
    logWarn("生图账号后端失败，已更新调度状态", {
      memberType: input.memberType,
      memberId: input.memberId,
      backend,
      status: failure.status || "unchanged",
      cooldownUntil: failure.cooldownUntil
        ? failure.cooldownUntil.toISOString()
        : null,
      retryable: outcome.retryable,
      switchable: outcome.switchable,
      error,
    });
  }
  return outcome;
}

export async function refreshImageBackendAccountInfo(accountId: string) {
  const [account] = await db
    .select({
      id: imageBackendAccount.id,
      email: imageBackendAccount.email,
      accessToken: imageBackendAccount.accessToken,
      implementationMode: imageBackendAccount.implementationMode,
      model: imageBackendAccount.model,
      metadata: imageBackendAccount.metadata,
    })
    .from(imageBackendAccount)
    .where(eq(imageBackendAccount.id, accountId))
    .limit(1);

  if (!account) {
    throw new Error("账号不存在");
  }

  if (normalizeAccountBackend(account.implementationMode) !== "web") {
    throw new Error("只有 Web 账号支持远端额度刷新");
  }

  const now = new Date();
  const chatgptAccountId =
    chatGptAccountIdFromAccessToken(account.accessToken) ||
    metadataString(account.metadata, "chatgptAccountId");
  try {
    const info = await getChatGptWebAccountInfo({
      baseUrl: "https://chatgpt.com",
      apiKey: account.accessToken,
      model: account.model || undefined,
      headers: chatgptAccountId
        ? { "ChatGPT-Account-Id": chatgptAccountId }
        : undefined,
      backend: {
        type: "pool-account",
        id: account.id,
        accountBackend: "web",
      },
    });
    await db
      .update(imageBackendAccount)
      .set({
        email: info.email || account.email,
        metadata: mergeWebAccountMetadata(
          mergeChatGptAccountIdMetadata(
            account.metadata,
            account.accessToken,
            "web"
          ),
          info
        ),
        status: "active",
        cooldownUntil:
          info.quota === 0 ? parseMetadataDate(info.restoreAt) : null,
        lastError: null,
        lastErrorAt: null,
        updatedAt: now,
      })
      .where(eq(imageBackendAccount.id, account.id));
    return info;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "刷新账号远端信息失败";
    const failure = await classifyFailure(message);
    await db
      .update(imageBackendAccount)
      .set({
        failCount: sql`${imageBackendAccount.failCount} + 1`,
        ...(failure.status ? { status: failure.status } : {}),
        ...(failure.cooldownUntil !== undefined
          ? { cooldownUntil: failure.cooldownUntil }
          : {}),
        lastError: truncateError(message),
        lastErrorAt: now,
        updatedAt: now,
      })
      .where(eq(imageBackendAccount.id, account.id));
    throw error;
  }
}

export async function refreshImageBackendAccountsInfo(accountIds: string[]) {
  const ids = Array.from(
    new Set(accountIds.map((id) => id.trim()).filter(Boolean))
  );
  if (!ids.length) throw new Error("请选择账号");

  const rows = await db
    .select({
      id: imageBackendAccount.id,
      implementationMode: imageBackendAccount.implementationMode,
    })
    .from(imageBackendAccount)
    .where(inArray(imageBackendAccount.id, ids));

  const knownIds = new Set(rows.map((row) => row.id));
  const webIds = rows
    .filter((row) => normalizeAccountBackend(row.implementationMode) === "web")
    .map((row) => row.id);
  const skippedCount =
    ids.filter((id) => !knownIds.has(id)).length +
    (rows.length - webIds.length);

  let refreshedCount = 0;
  let failedCount = 0;
  const errors: Array<{ id: string; error: string }> = [];
  const results: Array<{
    id: string;
    success: boolean;
    quota?: number;
    error?: string;
  }> = [];

  const maxWorkers = Math.min(10, Math.max(1, webIds.length));
  let cursor = 0;
  await Promise.all(
    Array.from({ length: maxWorkers }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        const id = webIds[index];
        if (!id) break;
        try {
          const info = await refreshImageBackendAccountInfo(id);
          refreshedCount++;
          results.push({
            id,
            success: true,
            quota: info.quota,
          });
        } catch (error) {
          failedCount++;
          const message =
            error instanceof Error ? error.message : "刷新账号远端信息失败";
          errors.push({ id, error: message });
          results.push({
            id,
            success: false,
            error: message,
          });
        }
      }
    })
  );

  return {
    requestedCount: ids.length,
    processedCount: webIds.length,
    refreshedCount,
    failedCount,
    skippedCount,
    errors,
    results,
  };
}

export async function listImageBackendGroupOptions(options?: {
  userSelectableOnly?: boolean;
  plan?: SubscriptionPlan;
}) {
  const plan = options?.plan;
  const rows = await db
    .select({
      id: imageBackendGroup.id,
      name: imageBackendGroup.name,
      description: imageBackendGroup.description,
      isDefault: imageBackendGroup.isDefault,
      isUserSelectable: imageBackendGroup.isUserSelectable,
      isEnabled: imageBackendGroup.isEnabled,
      contentSafetyEnabled: imageBackendGroup.contentSafetyEnabled,
      priority: imageBackendGroup.priority,
      metadata: imageBackendGroup.metadata,
    })
    .from(imageBackendGroup)
    .where(
      options?.userSelectableOnly
        ? and(
            eq(imageBackendGroup.isEnabled, true),
            eq(imageBackendGroup.isUserSelectable, true)
          )
        : eq(imageBackendGroup.isEnabled, true)
    )
    .orderBy(asc(imageBackendGroup.priority), asc(imageBackendGroup.createdAt));
  return rows
    .filter((group) =>
      plan ? canUseBackendGroupForPlan(group.metadata, plan) : true
    )
    .map(({ metadata, ...group }) => ({
      ...group,
      minPlan: getGroupMinPlan(metadata),
      backendType: getGroupBackendType(metadata),
      billingMultiplier: getGroupBillingMultiplier(metadata),
      childGroupIds: getGroupChildGroupIds(metadata),
    }));
}

export async function listSelectableImageBackendGroups(
  plan?: SubscriptionPlan
) {
  if (plan && !(await canUsePlanCapability(plan, "backendGroups.select"))) {
    return [];
  }
  return await listImageBackendGroupOptions({ userSelectableOnly: true, plan });
}

export async function getUserImageBackendPreference(
  userId: string,
  plan?: SubscriptionPlan
) {
  const [preference] = await db
    .select({ groupId: userImageBackendPreference.groupId })
    .from(userImageBackendPreference)
    .where(eq(userImageBackendPreference.userId, userId))
    .limit(1);
  if (!preference?.groupId) return null;

  const [group] = await db
    .select({
      id: imageBackendGroup.id,
      isEnabled: imageBackendGroup.isEnabled,
      isUserSelectable: imageBackendGroup.isUserSelectable,
      metadata: imageBackendGroup.metadata,
    })
    .from(imageBackendGroup)
    .where(eq(imageBackendGroup.id, preference.groupId))
    .limit(1);

  return group?.id === preference.groupId &&
    group.isEnabled &&
    group.isUserSelectable &&
    (!plan || canUseBackendGroupForPlan(group.metadata, plan))
    ? preference.groupId
    : null;
}

export async function setUserImageBackendPreference(
  userId: string,
  groupId: string | null,
  plan: SubscriptionPlan
) {
  if (groupId && !(await canUsePlanCapability(plan, "backendGroups.select"))) {
    throw new Error("当前套餐不可手动选择生图分组");
  }
  if (groupId) {
    const [group] = await db
      .select({
        id: imageBackendGroup.id,
        metadata: imageBackendGroup.metadata,
      })
      .from(imageBackendGroup)
      .where(
        and(
          eq(imageBackendGroup.id, groupId),
          eq(imageBackendGroup.isEnabled, true),
          eq(imageBackendGroup.isUserSelectable, true)
        )
      )
      .limit(1);
    if (!group || !canUseBackendGroupForPlan(group.metadata, plan)) {
      throw new Error("生图分组不存在、不可选择或当前套餐不可用");
    }
  }

  const [existing] = await db
    .select({ id: userImageBackendPreference.id })
    .from(userImageBackendPreference)
    .where(eq(userImageBackendPreference.userId, userId))
    .limit(1);

  if (existing) {
    await db
      .update(userImageBackendPreference)
      .set({ groupId, updatedAt: new Date() })
      .where(eq(userImageBackendPreference.id, existing.id));
  } else {
    await db.insert(userImageBackendPreference).values({
      id: nanoid(),
      userId,
      groupId,
    });
  }
}

type UpsertGroupInput = {
  id?: string;
  name: string;
  description?: string | null;
  isEnabled: boolean;
  isDefault: boolean;
  isUserSelectable: boolean;
  contentSafetyEnabled: boolean | null;
  backendType: ImageBackendGroupBackendType;
  minPlan: SubscriptionPlan;
  billingMultiplier: number;
  childGroupIds?: string[];
  priority: number;
};

async function normalizeUpsertGroupChildGroupIds(input: UpsertGroupInput) {
  const groups = await db
    .select({
      id: imageBackendGroup.id,
      name: imageBackendGroup.name,
      metadata: imageBackendGroup.metadata,
    })
    .from(imageBackendGroup)
    .orderBy(asc(imageBackendGroup.createdAt));
  const result = validateNestedGroupConfig({
    groupId: input.id,
    backendType: input.backendType,
    childGroupIds: input.childGroupIds,
    groups: groups.map((group) => ({
      id: group.id,
      name: group.name,
      backendType: getGroupBackendType(group.metadata),
      childGroupIds: getGroupChildGroupIds(group.metadata),
    })),
  });
  if (!result.ok) throw new Error(result.error);

  return result.childGroupIds;
}

export async function upsertImageBackendGroup(input: UpsertGroupInput) {
  const childGroupIds = await normalizeUpsertGroupChildGroupIds(input);

  if (input.isDefault) {
    await db.update(imageBackendGroup).set({
      isDefault: false,
      updatedAt: new Date(),
    });
  }

  if (input.id) {
    const [existing] = await db
      .select({ metadata: imageBackendGroup.metadata })
      .from(imageBackendGroup)
      .where(eq(imageBackendGroup.id, input.id))
      .limit(1);
    const metadata = {
      ...asGroupMetadata(existing?.metadata),
      minPlan: input.minPlan,
      backendType: input.backendType,
      billingMultiplier: input.billingMultiplier,
      childGroupIds,
    };
    await db
      .update(imageBackendGroup)
      .set({
        name: input.name,
        description: input.description || null,
        isEnabled: input.isEnabled,
        isDefault: input.isDefault,
        isUserSelectable: input.isUserSelectable,
        contentSafetyEnabled: input.contentSafetyEnabled,
        metadata,
        priority: input.priority,
        updatedAt: new Date(),
      })
      .where(eq(imageBackendGroup.id, input.id));
    return input.id;
  }

  const id = nanoid();
  await db.insert(imageBackendGroup).values({
    id,
    name: input.name,
    description: input.description || null,
    isEnabled: input.isEnabled,
    isDefault: input.isDefault,
    isUserSelectable: input.isUserSelectable,
    contentSafetyEnabled: input.contentSafetyEnabled,
    metadata: {
      minPlan: input.minPlan,
      backendType: input.backendType,
      billingMultiplier: input.billingMultiplier,
      childGroupIds,
    },
    priority: input.priority,
  });
  return id;
}

export async function deleteImageBackendGroup(groupId: string) {
  await db.delete(imageBackendGroup).where(eq(imageBackendGroup.id, groupId));
}

type UpsertAccountInput = {
  id?: string;
  groupId?: string | null;
  groupIds?: string[] | null;
  mergeGroupIds?: boolean;
  name: string;
  email?: string | null;
  accessToken?: string;
  refreshToken?: string | null;
  implementationMode: ImageBackendAccountBackend;
  model?: string | null;
  contentSafetyEnabled: boolean;
  isEnabled: boolean;
  alwaysActive?: boolean;
  priority: number;
  concurrency: number;
  status?: string;
  cooldownUntil?: Date | null;
  lastError?: string | null;
  lastErrorAt?: Date | null;
  metadata?: Record<string, unknown> | null;
};

async function setImageBackendAccountGroups(input: {
  accountId: string;
  groupIds: string[];
  replace: boolean;
}) {
  const groupIds = normalizeAccountGroupIds(input.groupIds);
  if (input.replace) {
    await db
      .delete(imageBackendAccountGroup)
      .where(eq(imageBackendAccountGroup.accountId, input.accountId));
  }
  if (!groupIds.length) return;

  await db
    .insert(imageBackendAccountGroup)
    .values(
      groupIds.map((groupId) => ({
        id: `${input.accountId}:${groupId}`,
        accountId: input.accountId,
        groupId,
      }))
    )
    .onConflictDoNothing();
}

function clientIdForAccountBackend(backend: ImageBackendAccountBackend) {
  return backend === "responses"
    ? OPENAI_CODEX_OAUTH_CLIENT_ID
    : OPENAI_PLATFORM_OAUTH_CLIENT_ID;
}

function tokenSourceForRefreshClient(
  clientId: string,
  backend: ImageBackendAccountBackend
) {
  if (clientId === OPENAI_MOBILE_RT_CLIENT_ID) {
    return "openai.oauth.mobile_refresh";
  }
  return backend === "responses"
    ? "openai.oauth.codex_refresh"
    : "openai.oauth.platform_refresh";
}

async function refreshAccessTokenForBackend(
  refreshToken: string,
  backend: ImageBackendAccountBackend,
  clientId = clientIdForAccountBackend(backend)
) {
  return await refreshOpenAIAccessToken(refreshToken, clientId);
}

export async function upsertImageBackendAccount(input: UpsertAccountInput) {
  const implementationMode = normalizeAccountBackend(input.implementationMode);
  const groupIds = accountGroupIdsFromInput(input);
  const primaryGroupId = groupIds[0] || null;
  let accessToken = input.accessToken?.trim() || "";
  let refreshToken =
    input.refreshToken === undefined
      ? undefined
      : input.refreshToken?.trim() || null;
  let existingPrimaryGroupId: string | null | undefined;
  let existingMetadata: Record<string, unknown> | null | undefined;

  if (input.id) {
    const [existingAccount] = await db
      .select({
        groupId: imageBackendAccount.groupId,
        metadata: imageBackendAccount.metadata,
      })
      .from(imageBackendAccount)
      .where(eq(imageBackendAccount.id, input.id))
      .limit(1);
    existingPrimaryGroupId = existingAccount?.groupId ?? null;
    existingMetadata = existingAccount?.metadata;
    if (
      refreshToken !== undefined &&
      isSub2ApiBackedMetadata(existingAccount?.metadata)
    ) {
      throw new Error("Sub2API 同步账号的 RT 由 Sub2API 管理，不能在这里修改");
    }
  }

  if (!accessToken && refreshToken) {
    const refreshed = await refreshAccessTokenForBackend(
      refreshToken,
      implementationMode
    );
    if (!refreshed?.accessToken) {
      throw new Error("Refresh Token 无法换取 Access Token");
    }
    accessToken = refreshed.accessToken;
    refreshToken = refreshed.refreshToken || refreshToken;
  }

  const mergedInputMetadata = mergeChatGptAccountIdMetadata(
    input.metadata !== undefined ? input.metadata : existingMetadata,
    accessToken,
    implementationMode
  );
  const shouldWriteMetadata =
    input.metadata !== undefined || mergedInputMetadata !== existingMetadata;

  const updateBase = {
    name: input.name,
    email: input.email || null,
    implementationMode,
    model: input.model || null,
    contentSafetyEnabled: input.contentSafetyEnabled,
    isEnabled: input.isEnabled,
    ...(input.alwaysActive !== undefined
      ? { alwaysActive: input.alwaysActive }
      : {}),
    priority: input.priority,
    concurrency: input.concurrency,
    status: input.status || "active",
    ...(input.cooldownUntil !== undefined
      ? { cooldownUntil: input.cooldownUntil }
      : {}),
    ...(input.lastError !== undefined
      ? { lastError: truncateError(input.lastError) }
      : {}),
    ...(input.lastErrorAt !== undefined
      ? { lastErrorAt: input.lastErrorAt }
      : {}),
    ...(shouldWriteMetadata ? { metadata: mergedInputMetadata } : {}),
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    updatedAt: new Date(),
  };

  if (input.id) {
    const update = {
      ...updateBase,
      groupId: input.mergeGroupIds
        ? existingPrimaryGroupId || primaryGroupId
        : primaryGroupId,
    };
    await db
      .update(imageBackendAccount)
      .set(
        accessToken
          ? {
              ...update,
              accessToken,
              credentialHash: hashBackendCredential(accessToken),
            }
          : update
      )
      .where(eq(imageBackendAccount.id, input.id));
    await setImageBackendAccountGroups({
      accountId: input.id,
      groupIds,
      replace: !input.mergeGroupIds,
    });
    return input.id;
  }

  if (!accessToken) {
    throw new Error("accessToken is required");
  }

  const credentialHash = hashBackendCredential(accessToken);
  const [existing] = await db
    .select({
      id: imageBackendAccount.id,
      groupId: imageBackendAccount.groupId,
      metadata: imageBackendAccount.metadata,
    })
    .from(imageBackendAccount)
    .where(
      and(
        eq(imageBackendAccount.credentialHash, credentialHash),
        eq(imageBackendAccount.implementationMode, implementationMode)
      )
    )
    .limit(1);
  if (existing) {
    const duplicateMetadata = mergeChatGptAccountIdMetadata(
      input.metadata !== undefined ? input.metadata : existing.metadata,
      accessToken,
      implementationMode
    );
    const update = {
      ...updateBase,
      ...(duplicateMetadata !== existing.metadata
        ? { metadata: duplicateMetadata }
        : {}),
      groupId: input.mergeGroupIds
        ? existing.groupId || primaryGroupId
        : primaryGroupId,
    };
    await db
      .update(imageBackendAccount)
      .set({
        ...update,
        accessToken,
        credentialHash,
      })
      .where(eq(imageBackendAccount.id, existing.id));
    await setImageBackendAccountGroups({
      accountId: existing.id,
      groupIds,
      replace: !input.mergeGroupIds,
    });
    return existing.id;
  }

  const id = nanoid();
  const update = {
    ...updateBase,
    groupId: primaryGroupId,
  };
  await db.insert(imageBackendAccount).values({
    id,
    ...update,
    refreshToken: refreshToken || null,
    accessToken,
    credentialHash,
  });
  await setImageBackendAccountGroups({
    accountId: id,
    groupIds,
    replace: true,
  });
  return id;
}

type BulkUpdateAccountsInput = {
  accountIds: string[];
  groupId?: string | null;
  implementationMode?: ImageBackendAccountBackend | null;
  contentSafetyEnabled?: boolean | null;
  isEnabled?: boolean | null;
  status?: string | null;
  resetAvailability?: boolean | null;
  priority?: number | null;
  concurrency?: number | null;
};

export async function bulkUpdateImageBackendAccounts(
  input: BulkUpdateAccountsInput
) {
  const accountIds = Array.from(new Set(input.accountIds.filter(Boolean)));
  if (!accountIds.length) throw new Error("请选择账号");

  const baseUpdate: Partial<typeof imageBackendAccount.$inferInsert> = {
    updatedAt: new Date(),
  };
  const targetMode = input.implementationMode
    ? normalizeAccountBackend(input.implementationMode)
    : null;
  const bulkGroupIds =
    input.groupId !== undefined
      ? normalizeAccountGroupIds(input.groupId ? [input.groupId] : [])
      : null;
  if (
    input.contentSafetyEnabled !== undefined &&
    input.contentSafetyEnabled !== null
  ) {
    baseUpdate.contentSafetyEnabled = input.contentSafetyEnabled;
  }
  if (input.isEnabled !== undefined && input.isEnabled !== null) {
    baseUpdate.isEnabled = input.isEnabled;
  }
  if (input.status !== undefined && input.status !== null) {
    baseUpdate.status = input.status || "active";
  }
  if (input.priority !== undefined && input.priority !== null) {
    baseUpdate.priority = Math.max(0, Math.min(10000, input.priority));
  }
  if (input.concurrency !== undefined && input.concurrency !== null) {
    baseUpdate.concurrency = Math.max(1, Math.min(100, input.concurrency));
  }
  if (input.resetAvailability) {
    baseUpdate.status = "active";
    baseUpdate.isEnabled = true;
    baseUpdate.cooldownUntil = null;
    baseUpdate.lastError = null;
    baseUpdate.lastErrorAt = null;
  }

  if (
    Object.keys(baseUpdate).length <= 1 &&
    !targetMode &&
    bulkGroupIds === null
  ) {
    throw new Error("请选择要批量修改的内容");
  }

  let updatedCount = 0;
  let failedCount = 0;
  for (const accountId of accountIds) {
    try {
      const update = { ...baseUpdate };
      if (bulkGroupIds) {
        update.groupId = bulkGroupIds[0] || null;
      }
      if (targetMode) {
        const [account] = await db
          .select({
            implementationMode: imageBackendAccount.implementationMode,
            refreshToken: imageBackendAccount.refreshToken,
            metadata: imageBackendAccount.metadata,
          })
          .from(imageBackendAccount)
          .where(eq(imageBackendAccount.id, accountId))
          .limit(1);
        if (!account) throw new Error("账号不存在");
        if (
          normalizeAccountBackend(account.implementationMode) !== targetMode
        ) {
          if (isSub2ApiBackedMetadata(account.metadata)) {
            throw new Error("Sub2API 同步账号不能在本站切换接口模式");
          }
          if (!account.refreshToken) {
            throw new Error("账号没有保存 RT，无法刷新目标接口模式的 AT");
          }
          const refreshed = await refreshAccessTokenForBackend(
            account.refreshToken,
            targetMode
          );
          if (!refreshed?.accessToken) {
            throw new Error("Refresh Token 无法换取目标模式 Access Token");
          }
          update.implementationMode = targetMode;
          update.accessToken = refreshed.accessToken;
          update.credentialHash = hashBackendCredential(refreshed.accessToken);
          update.refreshToken = refreshed.refreshToken || account.refreshToken;
          update.metadata = mergeChatGptAccountIdMetadata(
            account.metadata,
            refreshed.accessToken,
            targetMode
          );
        }
      }
      await db
        .update(imageBackendAccount)
        .set(update)
        .where(eq(imageBackendAccount.id, accountId));
      if (bulkGroupIds) {
        await setImageBackendAccountGroups({
          accountId,
          groupIds: bulkGroupIds,
          replace: true,
        });
      }
      updatedCount++;
    } catch (error) {
      failedCount++;
      logWarn("批量更新生图账号失败，已跳过", {
        accountId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { updatedCount, failedCount };
}

async function importAccessTokens(
  input: {
    accessTokens: string[];
    webGroupId?: string | null;
    namePrefix?: string | null;
    model?: string | null;
    contentSafetyEnabled: boolean;
    priority: number;
    concurrency: number;
  },
  counters: {
    syncedByMode: Record<ImageBackendAccountBackend, number>;
    failedByMode: Record<ImageBackendAccountBackend, number>;
    importedIds: string[];
    firstError?: string;
  },
  importBatchId: string
) {
  for (const [index, accessToken] of input.accessTokens.entries()) {
    try {
      const id = await upsertImageBackendAccount({
        groupId: input.webGroupId,
        mergeGroupIds: true,
        name: `${input.namePrefix?.trim() || "Auth Session 导入"} ${
          index + 1
        } / Web`,
        email: null,
        accessToken,
        refreshToken: null,
        implementationMode: "web",
        model: input.model || null,
        contentSafetyEnabled: input.contentSafetyEnabled,
        isEnabled: true,
        priority: input.priority,
        concurrency: Math.max(1, Math.min(100, input.concurrency)),
        status: "active",
        metadata: {
          source: "manual_web_access_token",
          importBatchId,
          importIndex: index + 1,
          syncedAt: new Date().toISOString(),
          tokenSource: "chatgpt.web_access_token",
        },
      });
      counters.importedIds.push(id);
      counters.syncedByMode.web++;
    } catch (error) {
      counters.failedByMode.web++;
      const reason = error instanceof Error ? error.message : String(error);
      if (!counters.firstError) counters.firstError = reason;
      logWarn("手工 Web AT 导入生图账号失败，已跳过", {
        index: index + 1,
        error: reason,
      });
    }
  }
}

function emptyRefreshTokenImportResult(message: string) {
  return {
    sourceCount: 0,
    syncedCount: 0,
    syncedByMode: { web: 0, responses: 0 },
    skipped: { web: 0, responses: 0 },
    failed: 0,
    failedByMode: { web: 0, responses: 0 },
    refreshTokenRotatedCount: 0,
    message,
  };
}

function emptyAccessTokenImportResult(message: string) {
  return {
    sourceCount: 0,
    syncedCount: 0,
    syncedByMode: { web: 0, responses: 0 },
    skipped: { web: 0, responses: 0 },
    failed: 0,
    failedByMode: { web: 0, responses: 0 },
    message,
  };
}

/**
 * 导入后自动刷新账号信息(实时查 ChatGPT /accounts/check 拿 plan_type + 额度,落 metadata.webAccount)。
 * WHY:web 账号导入时无 plan_type,PPT/PSD 调度按 metadata.webAccount.type 判付费级
 *   (见 accountPlanFilter);导入即刷新,新账号无需人工点"刷新"就能被正确归类/纳入调度。
 * fire-and-forget:本服务是常驻进程(非 serverless),后台 promise 随进程存活;best-effort——
 *   不阻塞导入响应、不因刷新失败影响导入结果。refreshImageBackendAccountsInfo 内部 10 并发、
 *   逐账号容错、只刷 web 账号。
 */
function triggerPostImportAccountRefresh(accountIds: string[]) {
  const ids = accountIds.filter(Boolean);
  if (!ids.length) return;
  void refreshImageBackendAccountsInfo(ids)
    .then((result) => {
      logWarn("导入后自动刷新账号信息完成", {
        requested: result.requestedCount,
        processed: result.processedCount,
        refreshed: result.refreshedCount,
        failed: result.failedCount,
        skipped: result.skippedCount,
      });
    })
    .catch((error) => {
      logWarn("导入后自动刷新账号信息异常", {
        requested: ids.length,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

export async function importImageBackendWebAccountsFromAccessTokens(input: {
  accessTokensText: string;
  webGroupId?: string | null;
  namePrefix?: string | null;
  model?: string | null;
  contentSafetyEnabled: boolean;
  priority: number;
  concurrency: number;
}) {
  const parsedTokens = parseImportTokensText(input.accessTokensText, {
    plainFallback: "access",
  });
  const parsedAccessTokenCount = parsedTokens.accessTokens.length;
  const accessTokens = parsedTokens.accessTokens.slice(
    0,
    MANUAL_TOKEN_IMPORT_LIMIT
  );
  const syncedByMode: Record<ImageBackendAccountBackend, number> = {
    web: 0,
    responses: 0,
  };
  const failedByMode: Record<ImageBackendAccountBackend, number> = {
    web: 0,
    responses: 0,
  };
  const skipped: Record<ImageBackendAccountBackend, number> = {
    web: 0,
    responses: 0,
  };
  const importedIds: string[] = [];
  const importBatchId = nanoid();

  if (!accessTokens.length) {
    const rtCount = parsedTokens.refreshTokens.length;
    return emptyAccessTokenImportResult(
      rtCount
        ? `未识别到 access token，但检测到 ${rtCount} 个 refresh token（rt_ 开头）。这些是「导入 RT」用的——请改用「导入 RT」按钮，不要在「导入 Web AT」里粘 rt_。`
        : "未识别到任何 access token（写入 0、失败 0 表示根本没解析出可导入的 token，并非写库失败）。Web AT 应为 eyJ 开头的 JWT（或 Bearer eyJ...、或含 accessToken 字段的 Auth Session JSON）；请确认粘的不是 cookie、session id、账号密码或 rt_。多个 token 用换行分隔。"
    );
  }

  const importState: {
    syncedByMode: Record<ImageBackendAccountBackend, number>;
    failedByMode: Record<ImageBackendAccountBackend, number>;
    importedIds: string[];
    firstError?: string;
  } = { syncedByMode, failedByMode, importedIds };
  await importAccessTokens(
    {
      accessTokens,
      webGroupId: input.webGroupId,
      namePrefix: input.namePrefix,
      model: input.model,
      contentSafetyEnabled: input.contentSafetyEnabled,
      priority: input.priority,
      concurrency: input.concurrency,
    },
    importState,
    importBatchId
  );

  // 导入后自动刷新一次(拿 plan_type 落 metadata.webAccount,供 PPT/PSD 付费过滤)。
  triggerPostImportAccountRefresh(importedIds);

  return {
    sourceCount: parsedAccessTokenCount,
    syncedCount: importedIds.length,
    syncedByMode,
    skipped,
    failed: failedByMode.web + failedByMode.responses,
    failedByMode,
    ...(importState.firstError ? { firstError: importState.firstError } : {}),
    message:
      parsedAccessTokenCount > accessTokens.length
        ? `已导入前 ${accessTokens.length} 个 Web AT，超出 ${MANUAL_TOKEN_IMPORT_LIMIT} 个的部分已跳过。该类账号没有 RT，AT 过期后需要重新导入。`
        : "已导入 Web AT。该类账号没有 RT，AT 过期后需要重新导入。",
  };
}

export async function importImageBackendAccountsFromRefreshTokens(input: {
  refreshTokensText: string;
  webGroupId?: string | null;
  responsesGroupId?: string | null;
  syncMode: Sub2ApiTokenSyncMode;
  useMobileRt?: boolean;
  namePrefix?: string | null;
  model?: string | null;
  contentSafetyEnabled: boolean;
  priority: number;
  concurrency: number;
  importBatchId?: string | null;
  startIndex?: number;
}) {
  const parsedTokens = parseImportTokensText(input.refreshTokensText, {
    plainFallback: "refresh",
  });
  const parsedRefreshTokenCount = parsedTokens.refreshTokens.length;
  const refreshTokens = parsedTokens.refreshTokens.slice(
    0,
    MANUAL_TOKEN_IMPORT_LIMIT
  );

  const effectiveSyncMode = input.useMobileRt ? input.syncMode : "responses";
  const modes =
    effectiveSyncMode === "both"
      ? (["web", "responses"] as const)
      : ([effectiveSyncMode] as const);
  const syncedByMode: Record<ImageBackendAccountBackend, number> = {
    web: 0,
    responses: 0,
  };
  const failedByMode: Record<ImageBackendAccountBackend, number> = {
    web: 0,
    responses: 0,
  };
  const skipped: Record<ImageBackendAccountBackend, number> = {
    web: 0,
    responses: 0,
  };
  let refreshTokenRotatedCount = 0;
  const importedIds: string[] = [];
  const importBatchId = input.importBatchId || nanoid();
  const startIndex = Math.max(0, Math.trunc(input.startIndex || 0));

  if (!refreshTokens.length) {
    return emptyRefreshTokenImportResult(
      "未提取到可导入的 RT。请粘贴 RT 列表，或粘贴包含 refresh_token/refreshToken 的 Auth Session；如果只有 accessToken，请使用“导入 Web AT”。"
    );
  }

  for (const [index, originalRefreshToken] of refreshTokens.entries()) {
    const importIndex = startIndex + index + 1;
    let currentRefreshToken = originalRefreshToken;
    const currentTokenImportedIds: string[] = [];
    if (input.useMobileRt) {
      try {
        const refreshed = await refreshOpenAIAccessToken(
          currentRefreshToken,
          OPENAI_MOBILE_RT_CLIENT_ID
        );
        if (!refreshed?.accessToken) {
          for (const mode of modes) skipped[mode]++;
          continue;
        }
        const nextRefreshToken = refreshed.refreshToken || currentRefreshToken;
        if (nextRefreshToken !== currentRefreshToken) {
          refreshTokenRotatedCount++;
          currentRefreshToken = nextRefreshToken;
        }

        for (const mode of modes) {
          const id = await upsertImageBackendAccount({
            groupId:
              mode === "responses" ? input.responsesGroupId : input.webGroupId,
            mergeGroupIds: true,
            name: `${
              input.namePrefix?.trim() || "Mobile RT 导入"
            } ${importIndex} / ${mode === "responses" ? "Codex" : "Web"}`,
            email: null,
            accessToken: refreshed.accessToken,
            refreshToken: currentRefreshToken,
            implementationMode: mode,
            model: input.model || null,
            contentSafetyEnabled: input.contentSafetyEnabled,
            isEnabled: true,
            priority: input.priority,
            concurrency: Math.max(1, Math.min(100, input.concurrency)),
            status: "active",
            metadata: {
              source: "manual_refresh_token",
              importBatchId,
              importIndex,
              syncedAt: new Date().toISOString(),
              tokenSource: tokenSourceForRefreshClient(
                OPENAI_MOBILE_RT_CLIENT_ID,
                mode
              ),
              oauthClientId: OPENAI_MOBILE_RT_CLIENT_ID,
              mobileRtImport: true,
              refreshTokenRotated: nextRefreshToken !== originalRefreshToken,
            },
          });
          importedIds.push(id);
          currentTokenImportedIds.push(id);
          syncedByMode[mode]++;
        }

        if (currentTokenImportedIds.length) {
          await db
            .update(imageBackendAccount)
            .set({
              refreshToken: currentRefreshToken,
              updatedAt: new Date(),
            })
            .where(inArray(imageBackendAccount.id, currentTokenImportedIds));
        }
      } catch (error) {
        for (const mode of modes) failedByMode[mode]++;
        logWarn("手工 Mobile RT 导入生图账号失败，已跳过", {
          index: importIndex,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }

    for (const mode of modes) {
      try {
        const clientId = clientIdForAccountBackend(mode);
        const refreshed = await refreshAccessTokenForBackend(
          currentRefreshToken,
          mode,
          clientId
        );
        if (!refreshed?.accessToken) {
          skipped[mode]++;
          continue;
        }
        const nextRefreshToken = refreshed.refreshToken || currentRefreshToken;
        if (nextRefreshToken !== currentRefreshToken) {
          refreshTokenRotatedCount++;
          currentRefreshToken = nextRefreshToken;
        }

        const id = await upsertImageBackendAccount({
          groupId:
            mode === "responses" ? input.responsesGroupId : input.webGroupId,
          mergeGroupIds: true,
          name: `${input.namePrefix?.trim() || "手工导入"} ${importIndex} / ${
            mode === "responses" ? "Codex" : "Web"
          }`,
          email: null,
          accessToken: refreshed.accessToken,
          refreshToken: currentRefreshToken,
          implementationMode: mode,
          model: input.model || null,
          contentSafetyEnabled: input.contentSafetyEnabled,
          isEnabled: true,
          priority: input.priority,
          concurrency: Math.max(1, Math.min(100, input.concurrency)),
          status: "active",
          metadata: {
            source: "manual_refresh_token",
            importBatchId,
            importIndex,
            syncedAt: new Date().toISOString(),
            tokenSource: tokenSourceForRefreshClient(clientId, mode),
            oauthClientId: clientId,
            mobileRtImport: false,
            refreshTokenRotated: nextRefreshToken !== originalRefreshToken,
          },
        });
        importedIds.push(id);
        currentTokenImportedIds.push(id);
        syncedByMode[mode]++;
      } catch (error) {
        failedByMode[mode]++;
        logWarn("手工 RT 导入生图账号失败，已跳过", {
          mode,
          index: importIndex,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (currentTokenImportedIds.length) {
      await db
        .update(imageBackendAccount)
        .set({
          refreshToken: currentRefreshToken,
          updatedAt: new Date(),
        })
        .where(inArray(imageBackendAccount.id, currentTokenImportedIds));
    }
  }

  // 导入后自动刷新一次(只刷其中的 web 账号,拿 plan_type 落 metadata.webAccount)。
  triggerPostImportAccountRefresh(importedIds);

  return {
    sourceCount: parsedRefreshTokenCount,
    syncedCount: importedIds.length,
    syncedByMode,
    skipped,
    failed: failedByMode.web + failedByMode.responses,
    failedByMode,
    refreshTokenRotatedCount,
    message:
      parsedRefreshTokenCount > refreshTokens.length
        ? `已导入前 ${refreshTokens.length} 个 RT，超出 ${MANUAL_TOKEN_IMPORT_LIMIT} 个的部分已跳过。`
        : (null as string | null),
  };
}

type Sub2ApiTokenSyncMode = "web" | "responses" | "both";

export type Sub2ApiSourceGroupSummary = {
  id: string;
  name: string;
  platform: string | null;
  accountCount: number;
};

type Sub2ApiAccountRow = {
  id: number | string;
  name: string | null;
  platform: string | null;
  type: string | null;
  status: string | null;
  schedulable: boolean | null;
  error_message?: string | null;
  rate_limit_reset_at?: Date | string | null;
  overload_until?: Date | string | null;
  temp_unschedulable_until?: Date | string | null;
  temp_unschedulable_reason?: string | null;
  session_window_status?: string | null;
  session_window_end?: Date | string | null;
  credentials: Record<string, unknown> | null;
  priority: number | null;
  concurrency: number | null;
  group_names: string[] | null;
  row_data: Record<string, unknown> | null;
};

export type Sub2ApiTokenAccount = {
  sourceId: string;
  name: string | null;
  email: string | null;
  chatgptAccountId: string | null;
  codexAccessToken: string | null;
  refreshToken: string | null;
  clientId: string | null;
  oauthFamily: string | null;
  oauthType: string | null;
  priority: number | null;
  concurrency: number | null;
  planType: string | null;
  groupNames: string[];
  sourceStatus: string | null;
  sourceSchedulable: boolean | null;
  sourceError: string | null;
  sourceStatusCode: string | null;
  sourceRateLimitResetAt: Date | null;
  sourceOverloadUntil: Date | null;
  sourceTempUnschedulableUntil: Date | null;
  sourceCooldownUntil: Date | null;
  sourceUpdatedAt: Date | null;
};

type Sub2ApiPlanFilter = "all" | "free" | "plus" | "pro" | "non_free";
type Sub2ApiAutoSyncTask = {
  id: string;
  enabled: boolean;
  sourceGroupId: string | null;
  sourceGroupName?: string | null;
  webGroupId?: string | null;
  responsesGroupId?: string | null;
  syncMode: Sub2ApiTokenSyncMode;
  allowMobileRtImport: boolean;
  contentSafetyEnabled: boolean;
  overwriteLocalUnavailableState: boolean;
  planFilter: Sub2ApiPlanFilter;
  intervalMinutes: number;
  createdAt?: string;
  updatedAt?: string;
  lastRunAt?: string;
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

export type Sub2ApiAutoSyncTaskSummary = Sub2ApiAutoSyncTask & {
  managedAccountCount: number;
};

type AutoSub2ApiSyncMetadata = {
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastSuccessAt?: string;
  lastSkippedAt?: string;
  lastErrorAt?: string;
  lastStatus?: "success" | "error" | "skipped";
  lastError?: string;
  lastResult?: {
    sourceCount: number;
    totalSourceCount: number;
    syncedCount: number;
    skipped: { web: number; responses: number };
    failed: number;
    failedByMode: { web: number; responses: number };
    syncedByMode: { web: number; responses: number };
    deletedCount?: number;
    tasks?: Array<{
      id: string;
      sourceGroupId: string | null;
      sourceGroupName?: string | null;
      sourceCount: number;
      totalSourceCount: number;
      syncedCount: number;
      failed: number;
      deletedCount: number;
    }>;
  };
};

type Sub2ApiSourceGroupRow = {
  id: number | string;
  name: string;
  platform: string | null;
  account_count: number | string | null;
};

function credentialString(
  credentials: Record<string, unknown> | null | undefined,
  keys: string[]
) {
  for (const key of keys) {
    const value = credentials?.[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function mergedSub2ApiData(
  row: Sub2ApiAccountRow,
  credentials: Record<string, unknown>
) {
  return {
    ...(row.row_data || {}),
    error_message: row.error_message ?? row.row_data?.error_message,
    rate_limit_reset_at:
      row.rate_limit_reset_at ?? row.row_data?.rate_limit_reset_at,
    overload_until: row.overload_until ?? row.row_data?.overload_until,
    temp_unschedulable_until:
      row.temp_unschedulable_until ?? row.row_data?.temp_unschedulable_until,
    temp_unschedulable_reason:
      row.temp_unschedulable_reason ?? row.row_data?.temp_unschedulable_reason,
    session_window_status:
      row.session_window_status ?? row.row_data?.session_window_status,
    session_window_end:
      row.session_window_end ?? row.row_data?.session_window_end,
    ...credentials,
  };
}

function credentialValue(
  credentials: Record<string, unknown> | null | undefined,
  keys: string[]
) {
  for (const key of keys) {
    const value = credentials?.[key];
    if (value !== undefined && value !== null) return value;
  }
  return null;
}

function credentialDate(
  credentials: Record<string, unknown> | null | undefined,
  keys: string[]
) {
  for (const key of keys) {
    const value = credentials?.[key];
    if (value === undefined || value === null) continue;
    const normalizedKey = key.toLowerCase();
    const isRelativeSeconds =
      normalizedKey.includes("retry") ||
      normalizedKey.includes("reset_after") ||
      normalizedKey.includes("restore_after");
    if (value instanceof Date) return parseDateValue(value);
    if (typeof value === "number" && Number.isFinite(value)) {
      return isRelativeSeconds
        ? new Date(Date.now() + value * 1000)
        : parseDateValue(String(value));
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      const numeric = Number(trimmed);
      if (isRelativeSeconds && Number.isFinite(numeric) && numeric > 0) {
        return new Date(Date.now() + numeric * 1000);
      }
      return parseDateValue(trimmed);
    }
  }
  return null;
}

function isFutureDate(value?: Date | null) {
  return Boolean(value && value.getTime() > Date.now());
}

function compactSub2ApiErrorParts(parts: Array<unknown>) {
  const text = parts
    .map((part) => {
      if (typeof part === "string" || typeof part === "number") {
        return String(part).trim();
      }
      if (part && typeof part === "object") {
        try {
          return JSON.stringify(part).slice(0, 600);
        } catch {
          return "";
        }
      }
      return "";
    })
    .filter(Boolean)
    .join(" | ");
  return truncateError(text || null);
}

function asStringArray(value: unknown) {
  return Array.isArray(value)
    ? value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean)
    : [];
}

function isSub2ApiOpenAIOAuthRow(row: Sub2ApiAccountRow) {
  return (
    row.platform?.trim().toLowerCase() === "openai" &&
    row.type?.trim().toLowerCase() === "oauth"
  );
}

function mapSub2ApiAccountRow(
  row: Sub2ApiAccountRow
): Sub2ApiTokenAccount | null {
  if (!isSub2ApiOpenAIOAuthRow(row)) return null;

  const credentials = row.credentials || {};
  const sourceData = mergedSub2ApiData(row, credentials);
  const codexAccessToken = credentialString(credentials, [
    "access_token",
    "accessToken",
    "token",
  ]);
  const refreshToken = credentialString(credentials, [
    "refresh_token",
    "refreshToken",
  ]);
  if (!codexAccessToken && !refreshToken) return null;

  const clientId = credentialString(credentials, ["client_id", "clientId"]);
  const oauthFamily = credentialString(credentials, [
    "oauth_family",
    "oauthFamily",
    "token_family",
    "tokenFamily",
    "token_source",
    "tokenSource",
    "source",
  ]);
  const oauthType = credentialString(credentials, [
    "oauth_type",
    "oauthType",
    "auth_type",
    "authType",
  ]);
  const email = credentialString(credentials, [
    "email",
    "account_email",
    "username",
  ]);
  const chatgptAccountId = credentialString(credentials, [
    "chatgpt_account_id",
    "chatgptAccountId",
  ]);
  const planType = credentialString(sourceData, ["plan_type", "planType"]);
  const sourceStatusCode =
    credentialString(sourceData, [
      "status_code",
      "statusCode",
      "error_status",
      "errorStatus",
      "http_status",
      "httpStatus",
      "last_status_code",
      "lastStatusCode",
    ]) || null;
  const sourceError = compactSub2ApiErrorParts([
    sourceStatusCode ? `status_code=${sourceStatusCode}` : null,
    credentialValue(sourceData, [
      "last_error",
      "lastError",
      "error",
      "error_message",
      "errorMessage",
      "status_message",
      "statusMessage",
      "message",
      "detail",
      "reason",
      "disabled_reason",
      "disabledReason",
    ]),
  ]);
  const sourceRateLimitResetAt = credentialDate(sourceData, [
    "rate_limit_reset_at",
    "rateLimitResetAt",
  ]);
  const sourceOverloadUntil = credentialDate(sourceData, [
    "overload_until",
    "overloadUntil",
  ]);
  const sourceTempUnschedulableUntil = credentialDate(sourceData, [
    "temp_unschedulable_until",
    "tempUnschedulableUntil",
  ]);
  const sourceGenericCooldownUntil = credentialDate(sourceData, [
    "cooldown_until",
    "cooldownUntil",
    "cooldown_at",
    "cooldownAt",
    "rate_limit_reset_at",
    "rateLimitResetAt",
    "reset_at",
    "resetAt",
    "restore_at",
    "restoreAt",
    "retry_after",
    "retryAfter",
    "retry_after_seconds",
    "retryAfterSeconds",
  ]);
  const sourceCooldownUntil =
    [
      sourceRateLimitResetAt,
      sourceOverloadUntil,
      sourceTempUnschedulableUntil,
      sourceGenericCooldownUntil,
    ].find(isFutureDate) ||
    sourceRateLimitResetAt ||
    sourceOverloadUntil ||
    sourceTempUnschedulableUntil ||
    sourceGenericCooldownUntil;
  const sourceUpdatedAt = credentialDate(sourceData, [
    "updated_at",
    "updatedAt",
  ]);
  const sourceId = String(row.id);
  const name = row.name?.trim() || email || `Sub2API 账号 ${sourceId}`;

  return {
    sourceId,
    name,
    email: email || null,
    chatgptAccountId: chatgptAccountId || null,
    codexAccessToken: codexAccessToken || null,
    refreshToken: refreshToken || null,
    clientId: clientId || null,
    oauthFamily: oauthFamily || null,
    oauthType: oauthType || null,
    priority: row.priority,
    concurrency: row.concurrency,
    planType: planType || null,
    groupNames: asStringArray(row.group_names),
    sourceStatus: row.status?.trim() || null,
    sourceSchedulable: row.schedulable,
    sourceError,
    sourceStatusCode,
    sourceRateLimitResetAt,
    sourceOverloadUntil,
    sourceTempUnschedulableUntil,
    sourceCooldownUntil,
    sourceUpdatedAt,
  };
}

function isSub2ApiMobileRtAccount(account: Sub2ApiTokenAccount) {
  const markers = [account.clientId, account.oauthFamily, account.oauthType]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.trim().toLowerCase());
  return (
    markers.includes(OPENAI_MOBILE_RT_CLIENT_ID.toLowerCase()) ||
    markers.some(
      (value) =>
        value.includes("mobile") ||
        value.includes("ios") ||
        value.includes("iphone")
    )
  );
}

function isSub2ApiLimitedStatus(status?: string | null) {
  const normalized = status?.trim().toLowerCase() || "";
  return (
    normalized === "limited" ||
    normalized === "rate_limited" ||
    normalized === "rate-limited" ||
    normalized === "quota_exceeded" ||
    normalized === "quota-exceeded" ||
    normalized === "cooldown" ||
    normalized === "cooling" ||
    normalized === "cooling_down" ||
    normalized === "cooling-down"
  );
}

function isSub2ApiErrorStatus(status?: string | null) {
  const normalized = status?.trim().toLowerCase() || "";
  return (
    normalized === "error" ||
    normalized === "failed" ||
    normalized === "invalid" ||
    normalized === "invalidated" ||
    normalized === "token_invalidated" ||
    normalized === "token-invalidated" ||
    normalized === "revoked" ||
    normalized === "token_revoked" ||
    normalized === "token-revoked" ||
    normalized === "unauthorized" ||
    normalized === "auth_error" ||
    normalized === "auth-error" ||
    normalized === "auth_failed" ||
    normalized === "auth-failed" ||
    // 终态封禁/删除仍算上游错误(账号确实不可用,非临时暂停);
    // disabled/inactive/deactivated 属"上游停用"(enable 轴),不在此判错、不同步。
    normalized === "deleted" ||
    normalized === "banned"
  );
}

function sub2ApiStatusCodeNumber(value?: string | null) {
  const match = value?.match(/\d{3}/)?.[0];
  return match ? Number(match) : null;
}

function buildSub2ApiHealthMessage(account: Sub2ApiTokenAccount) {
  const parts = [
    account.sourceStatus ? `sub_status=${account.sourceStatus}` : null,
    account.sourceSchedulable === false ? "sub_schedulable=false" : null,
    account.sourceStatusCode ? `status_code=${account.sourceStatusCode}` : null,
    account.sourceError,
  ];
  return compactSub2ApiErrorParts(parts);
}

// 导出供单测:验证"上游 enable/可调度态不同步、仅同步错误/限流"的健康映射。
export async function getSub2ApiHealthOverride(
  account: Sub2ApiTokenAccount
): Promise<{
  // 同步只回写"健康/可用性",绝不产生 disabled 状态、也不回写 isEnabled——
  // 启用/停用是本站管理员的本地控制,不随上游(Sub2API)同步。
  status: "active" | "limited" | "error" | null;
  cooldownUntil?: Date | null;
  lastError?: string | null;
}> {
  const message = buildSub2ApiHealthMessage(account);
  const combined = [
    account.sourceStatus,
    account.sourceStatusCode,
    account.sourceError,
  ]
    .filter(Boolean)
    .join(" ");
  const lowerCombined = combined.toLowerCase();
  const statusCode = sub2ApiStatusCodeNumber(account.sourceStatusCode);
  const futureRateLimitReset = isFutureDate(account.sourceRateLimitResetAt);
  const futureOverloadUntil = isFutureDate(account.sourceOverloadUntil);
  const futureTempUnschedulableUntil = isFutureDate(
    account.sourceTempUnschedulableUntil
  );

  // 上游"启用/可调度"属于 enable 轴(本站管理员自控),不作为健康信号同步:
  // disabled/inactive/schedulable=false 一律不在此处判态,落到末尾 status:null,
  // 由本地 isEnabled 决定是否参与轮换;真不可用会经实际请求失败被打成 error/limited。
  // 这里只同步两件真实健康信号:上游错误(凭据失效/封禁/明确 error)与限流。
  if (isInvalidBackendCredentialError(combined)) {
    return {
      status: "error",
      cooldownUntil: null,
      lastError: message || "Sub2API 标记账号错误",
    };
  }

  if (
    isSub2ApiLimitedStatus(account.sourceStatus) ||
    isUsageLimitBackendError(combined) ||
    futureRateLimitReset ||
    statusCode === 429 ||
    /(?:^|\D)429(?:\D|$)/.test(combined) ||
    lowerCombined.includes("rate limit")
  ) {
    const minutes = await getBackendCooldownMinutes(
      isUsageLimitBackendError(combined)
        ? "IMAGE_BACKEND_USAGE_LIMIT_COOLDOWN_MINUTES"
        : "IMAGE_BACKEND_RATE_LIMIT_COOLDOWN_MINUTES"
    );
    const fallbackCooldown = cooldownFromMinutes(minutes);
    return {
      status: "limited",
      cooldownUntil:
        account.sourceRateLimitResetAt ||
        (isMeaningfulSourceCooldownForError(
          message,
          account.sourceCooldownUntil
        )
          ? account.sourceCooldownUntil
          : fallbackCooldown),
      lastError: message || "Sub2API 标记账号限流",
    };
  }

  if (
    isSub2ApiErrorStatus(account.sourceStatus) ||
    isInvalidBackendCredentialError(combined) ||
    isUnsupportedModelBackendError(combined) ||
    statusCode === 401 ||
    statusCode === 403
  ) {
    return {
      status: "error",
      cooldownUntil: null,
      lastError: message || "Sub2API 标记账号错误",
    };
  }

  if (
    statusCode === 500 ||
    statusCode === 502 ||
    statusCode === 503 ||
    statusCode === 504 ||
    statusCode === 529 ||
    isOverloadBackendError(combined) ||
    isRecoverableBackendError(combined)
  ) {
    const minutes = await getBackendCooldownMinutes(
      isOverloadBackendError(combined) || statusCode === 529
        ? "IMAGE_BACKEND_OVERLOAD_COOLDOWN_MINUTES"
        : "IMAGE_BACKEND_TEMPORARY_ERROR_COOLDOWN_MINUTES"
    );
    return {
      status: "active",
      cooldownUntil:
        (futureOverloadUntil
          ? account.sourceOverloadUntil
          : futureTempUnschedulableUntil
            ? account.sourceTempUnschedulableUntil
            : null) || cooldownFromMinutes(minutes),
      lastError: message || "Sub2API 标记账号临时不可用",
    };
  }

  // schedulable=false 属于 enable 轴,不同步(见函数开头说明);落到 status:null。
  return {
    status: null,
  };
}

async function getExistingSub2ApiSyncedAccountState(
  sourceAccountId: string,
  mode: ImageBackendAccountBackend
) {
  const [existing] = await db
    .select({
      id: imageBackendAccount.id,
      status: imageBackendAccount.status,
      cooldownUntil: imageBackendAccount.cooldownUntil,
      lastError: imageBackendAccount.lastError,
      lastErrorAt: imageBackendAccount.lastErrorAt,
      isEnabled: imageBackendAccount.isEnabled,
      // 优先级与最大并发是本地自定义参数，同步时要保留本地值，见下方 upsert。
      priority: imageBackendAccount.priority,
      concurrency: imageBackendAccount.concurrency,
    })
    .from(imageBackendAccount)
    .where(
      and(
        eq(imageBackendAccount.implementationMode, mode),
        sql`${imageBackendAccount.metadata}->>'source' = 'sub2api_postgres'`,
        sql`${imageBackendAccount.metadata}->>'sourceAccountId' = ${sourceAccountId}`
      )
    )
    .limit(1);
  return existing ?? null;
}

async function deleteDuplicateSub2ApiSyncedAccounts(
  sourceAccountId: string,
  mode: ImageBackendAccountBackend,
  keepId: string
) {
  const duplicates = await db
    .select({ id: imageBackendAccount.id })
    .from(imageBackendAccount)
    .where(
      and(
        eq(imageBackendAccount.implementationMode, mode),
        sql`${imageBackendAccount.metadata}->>'source' = 'sub2api_postgres'`,
        sql`${imageBackendAccount.metadata}->>'sourceAccountId' = ${sourceAccountId}`
      )
    );
  const duplicateIds = duplicates
    .map((row) => row.id)
    .filter((id) => id !== keepId);
  if (!duplicateIds.length) return 0;
  const deleted = await db
    .delete(imageBackendAccount)
    .where(inArray(imageBackendAccount.id, duplicateIds))
    .returning({ id: imageBackendAccount.id });
  return deleted.length;
}

async function shouldPreserveLocalUnavailableState(
  existing?: {
    status: string;
    cooldownUntil: Date | null;
    isEnabled: boolean;
    lastError?: string | null;
  } | null
) {
  if (!existing) return false;
  if (!existing.isEnabled) return true;
  if (existing.status === "error" || existing.status === "limited") {
    return true;
  }
  if (
    !existing.cooldownUntil ||
    existing.cooldownUntil.getTime() <= Date.now()
  ) {
    return false;
  }

  const error = existing.lastError || "";
  if (!error) return true;
  if (isResetAwareLimitedBackendError(error)) return true;

  const cooldownKey = isUnsupportedModelBackendError(error)
    ? "IMAGE_BACKEND_UNSUPPORTED_MODEL_COOLDOWN_MINUTES"
    : isOverloadBackendError(error)
      ? "IMAGE_BACKEND_OVERLOAD_COOLDOWN_MINUTES"
      : isRecoverableBackendError(error)
        ? "IMAGE_BACKEND_TEMPORARY_ERROR_COOLDOWN_MINUTES"
        : null;
  if (!cooldownKey) return true;

  const minutes = await getBackendCooldownMinutes(cooldownKey);
  const graceMs = 60_000;
  return (
    existing.cooldownUntil.getTime() <=
    Date.now() + Math.max(1, minutes) * 60_000 + graceMs
  );
}

async function normalizeSyncedAccountCooldown(input: {
  status: string;
  cooldownUntil: Date | null;
  lastError?: string | null;
}) {
  if (input.status !== "limited") {
    return input.cooldownUntil;
  }

  // 同步路径(sub2api)的 limited 冷却可能直接来自源 sourceRateLimitResetAt——
  // 同样可能是亚秒级(per-min 429)。已有冷却则抬到地板;无冷却则用配置分钟数(≥地板)。
  if (input.cooldownUntil) {
    const floor = Date.now() + MIN_RESET_COOLDOWN_MS;
    return input.cooldownUntil.getTime() < floor
      ? new Date(floor)
      : input.cooldownUntil;
  }

  const error = input.lastError || "";
  const key = isUsageLimitBackendError(error)
    ? "IMAGE_BACKEND_USAGE_LIMIT_COOLDOWN_MINUTES"
    : "IMAGE_BACKEND_RATE_LIMIT_COOLDOWN_MINUTES";
  const minutes = await getBackendCooldownMinutes(key);
  return cooldownFromMinutes(minutes);
}

async function resolveSyncedAccountHealth(
  account: Sub2ApiTokenAccount,
  existing?: {
    status: string;
    cooldownUntil: Date | null;
    lastError: string | null;
    lastErrorAt: Date | null;
    isEnabled: boolean;
  } | null,
  options?: { overwriteLocalUnavailableState?: boolean }
) {
  const sourceHealth = await getSub2ApiHealthOverride(account);
  const overwriteLocalUnavailableState =
    options?.overwriteLocalUnavailableState !== false;
  const now = new Date();
  const existingUnavailable = Boolean(
    existing &&
      (!existing.isEnabled ||
        existing.status === "error" ||
        existing.status === "limited" ||
        (existing.cooldownUntil &&
          existing.cooldownUntil.getTime() > now.getTime()))
  );
  const localErrorIsNewerThanSource = Boolean(
    existing?.lastErrorAt &&
      (!account.sourceUpdatedAt ||
        existing.lastErrorAt.getTime() > account.sourceUpdatedAt.getTime())
  );
  const preserveNewerLocalInvalidCredential =
    !sourceHealth.status &&
    existingUnavailable &&
    localErrorIsNewerThanSource &&
    isInvalidBackendCredentialError(existing?.lastError);
  const preserveLocalUnavailable =
    !sourceHealth.status &&
    (preserveNewerLocalInvalidCredential ||
      (!overwriteLocalUnavailableState &&
        (await shouldPreserveLocalUnavailableState(existing))));
  const rawUpdate = sourceHealth.status
    ? {
        // 同步不回写启停:始终保留本地 isEnabled(管理员控制),仅新账号默认启用。
        status: sourceHealth.status,
        isEnabled: existing?.isEnabled ?? true,
        cooldownUntil: sourceHealth.cooldownUntil ?? null,
        lastError: sourceHealth.lastError ?? null,
        lastErrorAt: sourceHealth.lastError ? now : null,
      }
    : preserveLocalUnavailable
      ? {
          status: existing!.status,
          isEnabled: existing!.isEnabled,
          cooldownUntil: existing!.cooldownUntil,
          lastError: existing!.lastError,
          lastErrorAt: existing!.lastErrorAt,
        }
      : {
          // 上游健康:恢复为 active,但同样保留本地 isEnabled——不因上游正常就把
          // 管理员本地停用的账号强行重新启用(启停不随上游同步)。新账号默认启用。
          status: "active",
          isEnabled: existing?.isEnabled ?? true,
          cooldownUntil: null,
          lastError: null,
          lastErrorAt: null,
        };
  const cooldownUntil = await normalizeSyncedAccountCooldown(rawUpdate);
  return { ...rawUpdate, cooldownUntil, preserveLocalUnavailable };
}

function buildSub2ApiAccountMetadata(
  account: Sub2ApiTokenAccount,
  mode: ImageBackendAccountBackend,
  tokenSource: string | null,
  allowMobileRtImport: boolean | undefined,
  preserveLocalUnavailable: boolean,
  syncTaskId?: string | null
) {
  return {
    source: "sub2api_postgres",
    sourceAccountId: account.sourceId,
    chatgptAccountId: account.chatgptAccountId,
    sourceGroups: account.groupNames,
    planType: account.planType,
    syncedAt: new Date().toISOString(),
    sub2apiStatus: account.sourceStatus,
    sub2apiSchedulable: account.sourceSchedulable,
    sub2apiStatusCode: account.sourceStatusCode,
    sub2apiError: account.sourceError,
    sub2apiRateLimitResetAt: account.sourceRateLimitResetAt
      ? account.sourceRateLimitResetAt.toISOString()
      : null,
    sub2apiOverloadUntil: account.sourceOverloadUntil
      ? account.sourceOverloadUntil.toISOString()
      : null,
    sub2apiTempUnschedulableUntil: account.sourceTempUnschedulableUntil
      ? account.sourceTempUnschedulableUntil.toISOString()
      : null,
    sub2apiCooldownUntil: account.sourceCooldownUntil
      ? account.sourceCooldownUntil.toISOString()
      : null,
    sub2apiUpdatedAt: account.sourceUpdatedAt
      ? account.sourceUpdatedAt.toISOString()
      : null,
    localUnavailablePreserved: preserveLocalUnavailable,
    tokenSource,
    sub2apiClientId: account.clientId,
    sub2apiOauthFamily: account.oauthFamily,
    sub2apiOauthType: account.oauthType,
    sub2apiSyncTaskId: syncTaskId || null,
    mobileRtImport: Boolean(allowMobileRtImport && mode === "web"),
    oauthClientId:
      mode === "web"
        ? OPENAI_MOBILE_RT_CLIENT_ID
        : account.clientId || OPENAI_CODEX_OAUTH_CLIENT_ID,
    refreshTokenWrittenBack: false,
  };
}

async function applySub2ApiHealthToExistingAccount(
  existingId: string,
  account: Sub2ApiTokenAccount,
  mode: ImageBackendAccountBackend,
  tokenSource: string | null,
  allowMobileRtImport: boolean | undefined,
  healthUpdate: Awaited<ReturnType<typeof resolveSyncedAccountHealth>>,
  syncTaskId?: string | null
) {
  await db
    .update(imageBackendAccount)
    .set({
      isEnabled: healthUpdate.isEnabled,
      status: healthUpdate.status,
      cooldownUntil: healthUpdate.cooldownUntil,
      lastError: truncateError(healthUpdate.lastError),
      lastErrorAt: healthUpdate.lastErrorAt,
      metadata: buildSub2ApiAccountMetadata(
        account,
        mode,
        tokenSource,
        allowMobileRtImport,
        healthUpdate.preserveLocalUnavailable,
        syncTaskId
      ),
      updatedAt: new Date(),
    })
    .where(eq(imageBackendAccount.id, existingId));
}

async function deleteSub2ApiAccountsMissingFromTask(input: {
  syncTaskId: string;
  modes: readonly ImageBackendAccountBackend[];
  currentSourceIds: string[];
}) {
  const sourceIdExpr = sql<string>`${imageBackendAccount.metadata}->>'sourceAccountId'`;
  const conditions = [
    sql`${imageBackendAccount.metadata}->>'source' = 'sub2api_postgres'`,
    sql`${imageBackendAccount.metadata}->>'sub2apiSyncTaskId' = ${input.syncTaskId}`,
    inArray(imageBackendAccount.implementationMode, [...input.modes]),
    input.currentSourceIds.length
      ? notInArray(sourceIdExpr, input.currentSourceIds)
      : undefined,
  ].filter(Boolean);

  const deleted = await db
    .delete(imageBackendAccount)
    .where(and(...conditions))
    .returning({ id: imageBackendAccount.id });
  return deleted.length;
}

async function getOptionalSub2ApiPostgresConnectionString() {
  const connectionString =
    (await getRuntimeSettingString("SUB2API_POSTGRES_URL")) ||
    process.env.SUB2API_POSTGRES_URL?.trim();
  return connectionString || "";
}

export async function isSub2ApiPostgresConfigured() {
  return Boolean(await getOptionalSub2ApiPostgresConnectionString());
}

async function getSub2ApiPostgresConnectionString() {
  const connectionString = await getOptionalSub2ApiPostgresConnectionString();
  if (!connectionString) {
    throw new Error("请先配置 SUB2API_POSTGRES_URL");
  }
  return connectionString;
}

function createSub2ApiPool(connectionString: string) {
  return new Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 5_000,
  });
}

async function listSub2ApiCurrentAccessTokens(
  pool: Pool,
  options: {
    limit: number;
    offset?: number;
    sourceGroupId?: string | null;
    planFilter?: Sub2ApiPlanFilter;
  }
) {
  const sourceGroupId = options.sourceGroupId
    ? Number(options.sourceGroupId)
    : null;
  if (options.sourceGroupId && !Number.isFinite(sourceGroupId)) {
    throw new Error("Sub2API 来源分组无效");
  }
  const planFilter = normalizeSub2ApiPlanFilter(options.planFilter);
  const offset = Math.max(0, Math.trunc(options.offset || 0));
  const result = await pool.query<Sub2ApiAccountRow>(
    `
      SELECT
        a.id,
        a.name,
        a.platform,
        a.type,
        a.status,
        a.schedulable,
        a.error_message,
        a.rate_limit_reset_at,
        a.overload_until,
        a.temp_unschedulable_until,
        a.temp_unschedulable_reason,
        a.session_window_status,
        a.session_window_end,
        a.credentials,
        a.priority,
        a.concurrency,
        to_jsonb(a) - 'credentials' AS row_data,
        COALESCE(
          ARRAY_AGG(g.name ORDER BY ag.priority, g.name)
            FILTER (WHERE g.name IS NOT NULL),
          ARRAY[]::text[]
        ) AS group_names
      FROM accounts a
      LEFT JOIN account_groups ag ON ag.account_id = a.id
      LEFT JOIN groups g ON g.id = ag.group_id AND g.deleted_at IS NULL
      WHERE
        a.deleted_at IS NULL
        AND LOWER(a.platform) = 'openai'
        AND LOWER(a.type) = 'oauth'
        AND (
          a.credentials ? 'access_token'
          OR a.credentials ? 'accessToken'
          OR a.credentials ? 'token'
          OR a.credentials ? 'refresh_token'
          OR a.credentials ? 'refreshToken'
        )
        AND ($2::bigint IS NULL OR EXISTS (
          SELECT 1
          FROM account_groups source_ag
          WHERE source_ag.account_id = a.id
            AND source_ag.group_id = $2::bigint
        ))
        AND (
          $4::text = 'all'
          OR ($4::text = 'non_free' AND LOWER(COALESCE(a.credentials->>'plan_type', a.credentials->>'planType', '')) <> 'free')
          OR LOWER(COALESCE(a.credentials->>'plan_type', a.credentials->>'planType', '')) = $4::text
        )
      GROUP BY a.id
      ORDER BY a.priority ASC, a.last_used_at ASC NULLS FIRST, a.id ASC
      LIMIT $1
      OFFSET $3
    `,
    [options.limit, sourceGroupId, offset, planFilter]
  );
  return result.rows
    .map(mapSub2ApiAccountRow)
    .filter((account): account is Sub2ApiTokenAccount => Boolean(account));
}

async function countSub2ApiCurrentAccessTokens(
  pool: Pool,
  options: { sourceGroupId?: string | null; planFilter?: Sub2ApiPlanFilter }
) {
  const sourceGroupId = options.sourceGroupId
    ? Number(options.sourceGroupId)
    : null;
  if (options.sourceGroupId && !Number.isFinite(sourceGroupId)) {
    throw new Error("Sub2API 来源分组无效");
  }
  const planFilter = normalizeSub2ApiPlanFilter(options.planFilter);
  const result = await pool.query<{ value: number | string }>(
    `
      SELECT COUNT(*) AS value
      FROM accounts a
      WHERE
        a.deleted_at IS NULL
        AND LOWER(a.platform) = 'openai'
        AND LOWER(a.type) = 'oauth'
        AND (
          a.credentials ? 'access_token'
          OR a.credentials ? 'accessToken'
          OR a.credentials ? 'token'
          OR a.credentials ? 'refresh_token'
          OR a.credentials ? 'refreshToken'
        )
        AND ($1::bigint IS NULL OR EXISTS (
          SELECT 1
          FROM account_groups source_ag
          WHERE source_ag.account_id = a.id
            AND source_ag.group_id = $1::bigint
        ))
        AND (
          $2::text = 'all'
          OR ($2::text = 'non_free' AND LOWER(COALESCE(a.credentials->>'plan_type', a.credentials->>'planType', '')) <> 'free')
          OR LOWER(COALESCE(a.credentials->>'plan_type', a.credentials->>'planType', '')) = $2::text
        )
    `,
    [sourceGroupId, planFilter]
  );
  return Number(result.rows[0]?.value || 0);
}

async function listSub2ApiCurrentAccessTokenSourceIds(
  pool: Pool,
  options: { sourceGroupId?: string | null; planFilter?: Sub2ApiPlanFilter }
) {
  const sourceGroupId = options.sourceGroupId
    ? Number(options.sourceGroupId)
    : null;
  if (options.sourceGroupId && !Number.isFinite(sourceGroupId)) {
    throw new Error("Sub2API 来源分组无效");
  }
  const planFilter = normalizeSub2ApiPlanFilter(options.planFilter);
  const result = await pool.query<{ id: number | string }>(
    `
      SELECT a.id
      FROM accounts a
      WHERE
        a.deleted_at IS NULL
        AND LOWER(a.platform) = 'openai'
        AND LOWER(a.type) = 'oauth'
        AND (
          a.credentials ? 'access_token'
          OR a.credentials ? 'accessToken'
          OR a.credentials ? 'token'
          OR a.credentials ? 'refresh_token'
          OR a.credentials ? 'refreshToken'
        )
        AND ($1::bigint IS NULL OR EXISTS (
          SELECT 1
          FROM account_groups source_ag
          WHERE source_ag.account_id = a.id
            AND source_ag.group_id = $1::bigint
        ))
        AND (
          $2::text = 'all'
          OR ($2::text = 'non_free' AND LOWER(COALESCE(a.credentials->>'plan_type', a.credentials->>'planType', '')) <> 'free')
          OR LOWER(COALESCE(a.credentials->>'plan_type', a.credentials->>'planType', '')) = $2::text
        )
    `,
    [sourceGroupId, planFilter]
  );
  return result.rows.map((row) => String(row.id));
}

function normalizeSub2ApiPlanFilter(value?: string | null): Sub2ApiPlanFilter {
  return value === "all" ||
    value === "free" ||
    value === "plus" ||
    value === "pro" ||
    value === "non_free"
    ? value
    : "non_free";
}

function asAutoSub2ApiSyncMetadata(
  metadata: Record<string, unknown> | null | undefined
): AutoSub2ApiSyncMetadata {
  return (metadata || {}) as AutoSub2ApiSyncMetadata;
}

function normalizeSub2ApiSyncTask(value: unknown): Sub2ApiAutoSyncTask | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) return null;
  const syncMode =
    raw.syncMode === "web" || raw.syncMode === "both"
      ? raw.syncMode
      : "responses";
  const normalizeGroupId = (value: unknown) =>
    typeof value === "string" && value.trim() && value.trim() !== "default"
      ? value.trim()
      : null;
  return {
    id,
    enabled: raw.enabled !== false,
    sourceGroupId:
      typeof raw.sourceGroupId === "string" && raw.sourceGroupId.trim()
        ? raw.sourceGroupId.trim()
        : null,
    sourceGroupName:
      typeof raw.sourceGroupName === "string" && raw.sourceGroupName.trim()
        ? raw.sourceGroupName.trim()
        : null,
    webGroupId: normalizeGroupId(raw.webGroupId),
    responsesGroupId: normalizeGroupId(raw.responsesGroupId),
    syncMode,
    allowMobileRtImport: Boolean(raw.allowMobileRtImport),
    contentSafetyEnabled: raw.contentSafetyEnabled !== false,
    overwriteLocalUnavailableState:
      raw.overwriteLocalUnavailableState !== false,
    intervalMinutes: normalizeSub2ApiSyncIntervalMinutes(raw.intervalMinutes),
    planFilter: normalizeSub2ApiPlanFilter(
      typeof raw.planFilter === "string" ? raw.planFilter : null
    ),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : undefined,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
    lastRunAt: typeof raw.lastRunAt === "string" ? raw.lastRunAt : undefined,
    lastResult:
      raw.lastResult && typeof raw.lastResult === "object"
        ? (raw.lastResult as Sub2ApiAutoSyncTask["lastResult"])
        : undefined,
  };
}

async function getSub2ApiAutoSyncTasks() {
  const value = await getRuntimeSettingJson("SUB2API_AUTO_SYNC_TASKS");
  const items = Array.isArray(value)
    ? value
    : value &&
        typeof value === "object" &&
        Array.isArray((value as { tasks?: unknown }).tasks)
      ? (value as { tasks: unknown[] }).tasks
      : [];
  return items
    .map(normalizeSub2ApiSyncTask)
    .filter((task): task is Sub2ApiAutoSyncTask => Boolean(task));
}

async function setSub2ApiAutoSyncTasks(tasks: Sub2ApiAutoSyncTask[]) {
  const now = new Date();
  await db
    .insert(systemSetting)
    .values({
      key: AUTO_SUB2API_SYNC_TASKS_KEY,
      value: tasks,
      isSecret: false,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: systemSetting.key,
      set: {
        value: tasks,
        isSecret: false,
        updatedAt: now,
      },
    });
  clearSystemSettingsCache();
}

function buildSub2ApiAutoSyncTaskId(input: {
  sourceGroupId?: string | null;
  syncMode: Sub2ApiTokenSyncMode;
  allowMobileRtImport?: boolean;
  planFilter?: Sub2ApiPlanFilter | null;
}) {
  const key = [
    input.sourceGroupId?.trim() || "all",
    input.allowMobileRtImport ? input.syncMode : "responses",
    input.allowMobileRtImport ? "mobile-allowed" : "codex-only",
    normalizeSub2ApiPlanFilter(input.planFilter),
  ].join("|");
  return `sub2api-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

async function upsertSub2ApiAutoSyncTask(input: {
  sourceGroupId?: string | null;
  sourceGroupName?: string | null;
  webGroupId?: string | null;
  responsesGroupId?: string | null;
  syncMode: Sub2ApiTokenSyncMode;
  allowMobileRtImport?: boolean;
  contentSafetyEnabled: boolean;
  overwriteLocalUnavailableState?: boolean;
  planFilter?: Sub2ApiPlanFilter | null;
  intervalMinutes?: number | null;
}) {
  const now = new Date().toISOString();
  const planFilter = normalizeSub2ApiPlanFilter(input.planFilter);
  const syncMode = input.allowMobileRtImport ? input.syncMode : "responses";
  const id = buildSub2ApiAutoSyncTaskId({
    sourceGroupId: input.sourceGroupId,
    syncMode,
    allowMobileRtImport: input.allowMobileRtImport,
    planFilter,
  });
  const tasks = await getSub2ApiAutoSyncTasks();
  const existing = tasks.find((task) => task.id === id);
  const nextTask: Sub2ApiAutoSyncTask = {
    ...(existing || {}),
    id,
    enabled: true,
    sourceGroupId: input.sourceGroupId?.trim() || null,
    sourceGroupName: input.sourceGroupName?.trim() || null,
    webGroupId:
      input.webGroupId?.trim() && input.webGroupId.trim() !== "default"
        ? input.webGroupId.trim()
        : null,
    responsesGroupId:
      input.responsesGroupId?.trim() &&
      input.responsesGroupId.trim() !== "default"
        ? input.responsesGroupId.trim()
        : null,
    syncMode,
    allowMobileRtImport: Boolean(input.allowMobileRtImport),
    contentSafetyEnabled: input.contentSafetyEnabled,
    overwriteLocalUnavailableState:
      input.overwriteLocalUnavailableState !== false,
    planFilter,
    intervalMinutes: normalizeSub2ApiSyncIntervalMinutes(input.intervalMinutes),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  const nextTasks = existing
    ? tasks.map((task) => (task.id === id ? nextTask : task))
    : [...tasks, nextTask];
  await setSub2ApiAutoSyncTasks(nextTasks);
  return nextTask;
}

async function updateSub2ApiAutoSyncTaskResult(
  taskId: string,
  result: NonNullable<Sub2ApiAutoSyncTask["lastResult"]>
) {
  const tasks = await getSub2ApiAutoSyncTasks();
  const now = new Date().toISOString();
  const nextTasks = tasks.map((task) =>
    task.id === taskId
      ? { ...task, lastRunAt: now, updatedAt: now, lastResult: result }
      : task
  );
  await setSub2ApiAutoSyncTasks(nextTasks);
}

async function countAccountsForSub2ApiSyncTask(taskId: string) {
  const [row] = await db
    .select({ value: count() })
    .from(imageBackendAccount)
    .where(
      and(
        sql`${imageBackendAccount.metadata}->>'source' = 'sub2api_postgres'`,
        sql`${imageBackendAccount.metadata}->>'sub2apiSyncTaskId' = ${taskId}`
      )
    );
  return Number(row?.value || 0);
}

export async function listSub2ApiAutoSyncTasksForAdmin(): Promise<
  Sub2ApiAutoSyncTaskSummary[]
> {
  const tasks = await getSub2ApiAutoSyncTasks();
  const counts = await Promise.all(
    tasks.map((task) => countAccountsForSub2ApiSyncTask(task.id))
  );
  return tasks.map((task, index) => ({
    ...task,
    managedAccountCount: counts[index] || 0,
  }));
}

export async function setSub2ApiAutoSyncTaskEnabled(input: {
  taskId: string;
  enabled: boolean;
}) {
  const taskId = input.taskId.trim();
  const tasks = await getSub2ApiAutoSyncTasks();
  let found = false;
  const now = new Date().toISOString();
  const nextTasks = tasks.map((task) => {
    if (task.id !== taskId) return task;
    found = true;
    return { ...task, enabled: input.enabled, updatedAt: now };
  });
  if (!found) throw new Error("自动同步任务不存在");
  await setSub2ApiAutoSyncTasks(nextTasks);
  return { taskId, enabled: input.enabled };
}

export async function setSub2ApiAutoSyncTaskOverwriteLocalUnavailableState(input: {
  taskId: string;
  overwriteLocalUnavailableState: boolean;
}) {
  const taskId = input.taskId.trim();
  const tasks = await getSub2ApiAutoSyncTasks();
  let found = false;
  const now = new Date().toISOString();
  const nextTasks = tasks.map((task) => {
    if (task.id !== taskId) return task;
    found = true;
    return {
      ...task,
      overwriteLocalUnavailableState: input.overwriteLocalUnavailableState,
      updatedAt: now,
    };
  });
  if (!found) throw new Error("自动同步任务不存在");
  await setSub2ApiAutoSyncTasks(nextTasks);
  return {
    taskId,
    overwriteLocalUnavailableState: input.overwriteLocalUnavailableState,
  };
}

export async function updateSub2ApiAutoSyncTaskOptions(input: {
  taskId: string;
  enabled: boolean;
  webGroupId?: string | null;
  responsesGroupId?: string | null;
  syncMode: Sub2ApiTokenSyncMode;
  allowMobileRtImport?: boolean;
  contentSafetyEnabled: boolean;
  overwriteLocalUnavailableState: boolean;
  planFilter?: Sub2ApiPlanFilter | null;
  intervalMinutes?: number | null;
}) {
  const taskId = input.taskId.trim();
  const tasks = await getSub2ApiAutoSyncTasks();
  let found = false;
  const allowMobileRtImport = Boolean(input.allowMobileRtImport);
  const syncMode = allowMobileRtImport ? input.syncMode : "responses";
  const now = new Date().toISOString();
  const normalizeGroupId = (value?: string | null) =>
    value?.trim() && value.trim() !== "default" ? value.trim() : null;
  const nextTasks = tasks.map((task) => {
    if (task.id !== taskId) return task;
    found = true;
    return {
      ...task,
      enabled: input.enabled,
      webGroupId: normalizeGroupId(input.webGroupId),
      responsesGroupId: normalizeGroupId(input.responsesGroupId),
      syncMode,
      allowMobileRtImport,
      contentSafetyEnabled: input.contentSafetyEnabled,
      overwriteLocalUnavailableState: input.overwriteLocalUnavailableState,
      planFilter: normalizeSub2ApiPlanFilter(input.planFilter),
      intervalMinutes: normalizeSub2ApiSyncIntervalMinutes(
        input.intervalMinutes
      ),
      updatedAt: now,
    };
  });
  if (!found) throw new Error("自动同步任务不存在");
  await setSub2ApiAutoSyncTasks(nextTasks);
  return { taskId };
}

export async function deleteSub2ApiAutoSyncTask(taskIdInput: string) {
  const taskId = taskIdInput.trim();
  const tasks = await getSub2ApiAutoSyncTasks();
  const nextTasks = tasks.filter((task) => task.id !== taskId);
  if (nextTasks.length === tasks.length) {
    throw new Error("自动同步任务不存在");
  }
  await setSub2ApiAutoSyncTasks(nextTasks);
  return { taskId, deleted: true };
}

async function listSub2ApiSourceGroupsFromPool(pool: Pool) {
  const result = await pool.query<Sub2ApiSourceGroupRow>(
    `
      SELECT
        g.id,
        g.name,
        g.platform,
        COUNT(a.id) FILTER (
          WHERE
            a.deleted_at IS NULL
            AND LOWER(a.platform) = 'openai'
            AND LOWER(a.type) = 'oauth'
            AND (
              a.credentials ? 'access_token'
              OR a.credentials ? 'accessToken'
              OR a.credentials ? 'token'
              OR a.credentials ? 'refresh_token'
              OR a.credentials ? 'refreshToken'
            )
        ) AS account_count
      FROM groups g
      LEFT JOIN account_groups ag ON ag.group_id = g.id
      LEFT JOIN accounts a ON a.id = ag.account_id
      WHERE
        g.deleted_at IS NULL
        AND g.status = 'active'
        AND LOWER(g.platform) = 'openai'
      GROUP BY g.id, g.name, g.platform, g.sort_order
      ORDER BY g.sort_order ASC, g.name ASC, g.id ASC
    `
  );

  return result.rows.map((row) => ({
    id: String(row.id),
    name: row.name,
    platform: row.platform,
    accountCount: Number(row.account_count || 0),
  }));
}

export async function listSub2ApiSourceGroups() {
  const connectionString = await getSub2ApiPostgresConnectionString();
  const pool = createSub2ApiPool(connectionString);
  try {
    return await listSub2ApiSourceGroupsFromPool(pool);
  } finally {
    await pool.end();
  }
}

type OpenAITokenRefreshResponse = {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
};

async function refreshOpenAIAccessToken(
  refreshToken: string,
  clientId: string
): Promise<{ accessToken: string; refreshToken: string | null } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const form = new URLSearchParams();
    form.set("grant_type", "refresh_token");
    form.set("refresh_token", refreshToken);
    form.set("client_id", clientId);
    form.set("scope", OPENAI_REFRESH_SCOPES);

    const response = await fetch(OPENAI_OAUTH_TOKEN_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent":
          clientId === OPENAI_CODEX_OAUTH_CLIENT_ID ||
          clientId === OPENAI_MOBILE_RT_CLIENT_ID
            ? "codex-cli/0.91.0"
            : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
      },
      body: form.toString(),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `OpenAI token refresh failed: HTTP ${response.status}${text ? ` ${text.slice(0, 300)}` : ""}`
      );
    }
    const payload = (await response.json()) as OpenAITokenRefreshResponse;
    const accessToken = payload.access_token?.trim();
    if (!accessToken) return null;
    return {
      accessToken,
      refreshToken: payload.refresh_token?.trim() || null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveSub2ApiAccessTokenForMode(
  account: Sub2ApiTokenAccount,
  mode: ImageBackendAccountBackend,
  options?: { allowMobileRtImport?: boolean }
) {
  if (mode === "responses") {
    if (!options?.allowMobileRtImport && isSub2ApiMobileRtAccount(account)) {
      return {
        accessToken: null,
        tokenSource: "sub2api.mobile_rt_disabled",
        refreshTokenWrittenBack: false,
      };
    }
    return {
      accessToken: account.codexAccessToken,
      tokenSource: isSub2ApiMobileRtAccount(account)
        ? "sub2api.credentials.mobile_access_token"
        : "sub2api.credentials.access_token",
      refreshTokenWrittenBack: false,
    };
  }

  if (!options?.allowMobileRtImport) {
    return {
      accessToken: null,
      tokenSource: "sub2api.mobile_rt_disabled",
      refreshTokenWrittenBack: false,
    };
  }

  if (!isSub2ApiMobileRtAccount(account)) {
    return {
      accessToken: null,
      tokenSource: "sub2api.mobile_rt_not_marked",
      refreshTokenWrittenBack: false,
    };
  }

  if (!account.codexAccessToken) {
    return {
      accessToken: null,
      tokenSource: "sub2api.credentials.access_token",
      refreshTokenWrittenBack: false,
    };
  }

  return {
    accessToken: account.codexAccessToken,
    tokenSource: "sub2api.credentials.mobile_access_token",
    refreshTokenWrittenBack: false,
  };
}

export async function syncImageBackendAccountsFromSub2Api(input: {
  webGroupId?: string | null;
  responsesGroupId?: string | null;
  sourceGroupId?: string | null;
  sourceGroupName?: string | null;
  syncMode: Sub2ApiTokenSyncMode;
  allowMobileRtImport?: boolean;
  contentSafetyEnabled: boolean;
  limit?: number | null;
  offset?: number | null;
  planFilter?: Sub2ApiPlanFilter | null;
  createSyncTask?: boolean;
  syncTaskId?: string | null;
  cleanupManagedAccounts?: boolean;
  overwriteLocalUnavailableState?: boolean;
}) {
  const configuredLimit = await getRuntimeSettingNumber(
    "SUB2API_POSTGRES_SYNC_LIMIT",
    100,
    { positive: true }
  );
  const limit = Math.max(
    1,
    Math.min(500, Math.trunc(input.limit || configuredLimit))
  );
  const offset = Math.max(0, Math.trunc(input.offset || 0));
  const planFilter = normalizeSub2ApiPlanFilter(input.planFilter);
  const effectiveSyncMode = input.allowMobileRtImport
    ? input.syncMode
    : "responses";
  const modes =
    effectiveSyncMode === "both"
      ? (["web", "responses"] as const)
      : ([effectiveSyncMode] as const);
  const syncTask = input.createSyncTask
    ? await upsertSub2ApiAutoSyncTask({
        sourceGroupId: input.sourceGroupId,
        sourceGroupName: input.sourceGroupName,
        webGroupId: input.webGroupId,
        responsesGroupId: input.responsesGroupId,
        syncMode: effectiveSyncMode,
        allowMobileRtImport: input.allowMobileRtImport,
        contentSafetyEnabled: input.contentSafetyEnabled,
        overwriteLocalUnavailableState: input.overwriteLocalUnavailableState,
        planFilter,
      })
    : null;
  const syncTaskId = input.syncTaskId || syncTask?.id || null;
  const imported: string[] = [];
  let deletedCount = 0;
  const syncedByMode = {
    web: 0,
    responses: 0,
  };
  const skipped = {
    web: 0,
    responses: 0,
  };
  const failedByMode = {
    web: 0,
    responses: 0,
  };

  const connectionString = await getSub2ApiPostgresConnectionString();
  const pool = createSub2ApiPool(connectionString);
  try {
    const totalSourceCount = await countSub2ApiCurrentAccessTokens(pool, {
      sourceGroupId: input.sourceGroupId,
      planFilter,
    });
    const accounts = await listSub2ApiCurrentAccessTokens(pool, {
      limit,
      offset,
      sourceGroupId: input.sourceGroupId,
      planFilter,
    });
    // 初始化本次同步进度(供前端轮询);处理每个源账号时 +1(粗粒度足够)。
    sub2ApiSyncProgress = {
      processed: 0,
      total: accounts.length,
      startedAt: Date.now(),
    };
    for (const account of accounts) {
      if (sub2ApiSyncProgress) {
        sub2ApiSyncProgress.processed += 1;
      }
      for (const mode of modes) {
        try {
          const existing = await getExistingSub2ApiSyncedAccountState(
            account.sourceId,
            mode
          );
          if (existing?.id) {
            deletedCount += await deleteDuplicateSub2ApiSyncedAccounts(
              account.sourceId,
              mode,
              existing.id
            );
          }
          const preTokenHealth = await resolveSyncedAccountHealth(
            account,
            existing,
            {
              overwriteLocalUnavailableState:
                input.overwriteLocalUnavailableState,
            }
          );
          const { accessToken, tokenSource } =
            await resolveSub2ApiAccessTokenForMode(account, mode, {
              allowMobileRtImport: input.allowMobileRtImport,
            });
          if (!accessToken) {
            if (
              existing?.id &&
              (preTokenHealth.status !== "active" ||
                preTokenHealth.cooldownUntil ||
                preTokenHealth.lastError ||
                preTokenHealth.isEnabled === false)
            ) {
              await applySub2ApiHealthToExistingAccount(
                existing.id,
                account,
                mode,
                tokenSource,
                input.allowMobileRtImport,
                preTokenHealth,
                syncTaskId
              );
              await setImageBackendAccountGroups({
                accountId: existing.id,
                groupIds: accountGroupIdsFromInput({
                  groupId:
                    mode === "responses"
                      ? input.responsesGroupId
                      : input.webGroupId,
                }),
                replace: false,
              });
              imported.push(existing.id);
              syncedByMode[mode]++;
              continue;
            }
            skipped[mode]++;
            continue;
          }
          const healthUpdate = await resolveSyncedAccountHealth(
            account,
            existing,
            {
              overwriteLocalUnavailableState:
                input.overwriteLocalUnavailableState,
            }
          );
          const id = await upsertImageBackendAccount({
            id: existing?.id,
            groupId:
              mode === "responses" ? input.responsesGroupId : input.webGroupId,
            mergeGroupIds: true,
            name:
              mode === "responses"
                ? `${account.name} / Codex`
                : `${account.name} / Web`,
            email: account.email,
            accessToken,
            implementationMode: mode,
            model: null,
            contentSafetyEnabled: input.contentSafetyEnabled,
            isEnabled: healthUpdate.isEnabled,
            // 优先级/最大并发属本地自定义参数，不从 sub2api 同步覆盖：
            // 已存在账号保留本地值，仅新建账号用默认值(50/1)初始化。
            priority: existing?.priority ?? 50,
            concurrency: existing?.concurrency ?? 1,
            status: healthUpdate.status,
            cooldownUntil: healthUpdate.cooldownUntil,
            lastError: healthUpdate.lastError,
            lastErrorAt: healthUpdate.lastErrorAt,
            metadata: buildSub2ApiAccountMetadata(
              account,
              mode,
              tokenSource,
              input.allowMobileRtImport,
              healthUpdate.preserveLocalUnavailable,
              syncTaskId
            ),
          });
          imported.push(id);
          syncedByMode[mode]++;
        } catch (error) {
          failedByMode[mode]++;
          logWarn("Sub2API 账号 AT 同步失败，已跳过", {
            sourceAccountId: account.sourceId,
            mode,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    if (
      syncTaskId &&
      input.cleanupManagedAccounts &&
      offset + accounts.length >= totalSourceCount
    ) {
      const currentSourceIds = await listSub2ApiCurrentAccessTokenSourceIds(
        pool,
        {
          sourceGroupId: input.sourceGroupId,
          planFilter,
        }
      );
      deletedCount = await deleteSub2ApiAccountsMissingFromTask({
        syncTaskId,
        modes,
        currentSourceIds,
      });
    }

    return {
      sourceCount: accounts.length,
      totalSourceCount,
      offset,
      nextOffset: offset + accounts.length,
      hasMore: offset + accounts.length < totalSourceCount,
      syncedCount: imported.length,
      syncedByMode,
      skipped,
      failed: failedByMode.web + failedByMode.responses,
      failedByMode,
      deletedCount,
      syncTaskId,
      refreshTokenWriteBackCount: 0,
    };
  } finally {
    await pool.end();
  }
}

async function getDefaultGroupIdForBackend(
  backend: ImageBackendAccountBackend
) {
  const rows = await db
    .select({
      id: imageBackendGroup.id,
      isDefault: imageBackendGroup.isDefault,
      metadata: imageBackendGroup.metadata,
      priority: imageBackendGroup.priority,
      createdAt: imageBackendGroup.createdAt,
    })
    .from(imageBackendGroup)
    .where(eq(imageBackendGroup.isEnabled, true))
    .orderBy(
      desc(imageBackendGroup.isDefault),
      asc(imageBackendGroup.priority),
      asc(imageBackendGroup.createdAt)
    );
  return (
    rows.find((group) => groupBackendAllowsAccount(group.metadata, backend))
      ?.id ?? null
  );
}

async function getAutoSub2ApiSyncMetadata() {
  const [row] = await db
    .select({ value: systemSetting.value })
    .from(systemSetting)
    .where(eq(systemSetting.key, AUTO_SUB2API_SYNC_STATE_KEY))
    .limit(1);
  return asAutoSub2ApiSyncMetadata(
    row?.value && typeof row.value === "object"
      ? (row.value as Record<string, unknown>)
      : undefined
  );
}

async function setAutoSub2ApiSyncMetadata(metadata: AutoSub2ApiSyncMetadata) {
  const now = new Date();
  await db
    .insert(systemSetting)
    .values({
      key: AUTO_SUB2API_SYNC_STATE_KEY,
      value: metadata,
      isSecret: false,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: systemSetting.key,
      set: {
        value: metadata,
        isSecret: false,
        updatedAt: now,
      },
    });
}

function normalizeSub2ApiSyncIntervalMinutes(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.max(1, Math.trunc(parsed))
    : 720;
}

function shouldRunSub2ApiTask(task: Sub2ApiAutoSyncTask, force: boolean) {
  if (force) return { run: true, nextRunAt: null as string | null };
  const lastRunAt = task.lastRunAt ? Date.parse(task.lastRunAt) : Number.NaN;
  if (!Number.isFinite(lastRunAt)) {
    return { run: true, nextRunAt: null as string | null };
  }
  const nextRunAtMs =
    lastRunAt +
    normalizeSub2ApiSyncIntervalMinutes(task.intervalMinutes) * 60_000;
  if (Date.now() >= nextRunAtMs) {
    return { run: true, nextRunAt: new Date(nextRunAtMs).toISOString() };
  }
  return { run: false, nextRunAt: new Date(nextRunAtMs).toISOString() };
}

function createSub2ApiSyncAggregate() {
  return {
    sourceCount: 0,
    totalSourceCount: 0,
    syncedCount: 0,
    syncedByMode: { web: 0, responses: 0 },
    skipped: { web: 0, responses: 0 },
    failed: 0,
    failedByMode: { web: 0, responses: 0 },
    deletedCount: 0,
    refreshTokenWriteBackCount: 0,
    batches: 0,
  };
}

async function runSub2ApiSyncConfig(input: {
  sourceGroupId?: string | null;
  sourceGroupName?: string | null;
  webGroupId?: string | null;
  responsesGroupId?: string | null;
  syncMode: Sub2ApiTokenSyncMode;
  allowMobileRtImport?: boolean;
  contentSafetyEnabled: boolean;
  planFilter: Sub2ApiPlanFilter;
  limit: number;
  syncTaskId?: string | null;
  cleanupManagedAccounts?: boolean;
  overwriteLocalUnavailableState?: boolean;
}) {
  let offset = 0;
  let hasMore = true;
  const aggregate = createSub2ApiSyncAggregate();

  while (hasMore) {
    const result = await syncImageBackendAccountsFromSub2Api({
      webGroupId: input.webGroupId,
      responsesGroupId: input.responsesGroupId,
      sourceGroupId: input.sourceGroupId,
      sourceGroupName: input.sourceGroupName,
      syncMode: input.syncMode,
      allowMobileRtImport: input.allowMobileRtImport,
      contentSafetyEnabled: input.contentSafetyEnabled,
      planFilter: input.planFilter,
      limit: input.limit,
      offset,
      syncTaskId: input.syncTaskId,
      cleanupManagedAccounts: input.cleanupManagedAccounts,
      overwriteLocalUnavailableState: input.overwriteLocalUnavailableState,
    });
    aggregate.sourceCount += result.sourceCount;
    aggregate.totalSourceCount = result.totalSourceCount;
    aggregate.syncedCount += result.syncedCount;
    aggregate.syncedByMode.web += result.syncedByMode.web;
    aggregate.syncedByMode.responses += result.syncedByMode.responses;
    aggregate.skipped.web += result.skipped.web;
    aggregate.skipped.responses += result.skipped.responses;
    aggregate.failed += result.failed;
    aggregate.failedByMode.web += result.failedByMode.web;
    aggregate.failedByMode.responses += result.failedByMode.responses;
    aggregate.deletedCount += result.deletedCount;
    aggregate.refreshTokenWriteBackCount += result.refreshTokenWriteBackCount;
    aggregate.batches++;
    hasMore = result.hasMore && result.sourceCount > 0;
    offset = result.nextOffset;
  }

  return aggregate;
}

async function getSub2ApiSyncBatchLimit() {
  const configuredLimit = await getRuntimeSettingNumber(
    "SUB2API_POSTGRES_SYNC_LIMIT",
    100,
    {
      positive: true,
    }
  );
  return Math.max(1, Math.min(500, Math.trunc(configuredLimit)));
}

async function runSub2ApiAutoSyncTaskConfig(
  task: Sub2ApiAutoSyncTask,
  limit: number
) {
  const effectiveSyncMode = task.allowMobileRtImport
    ? task.syncMode
    : "responses";
  const [webGroupId, responsesGroupId] = await Promise.all([
    effectiveSyncMode === "web" || effectiveSyncMode === "both"
      ? task.webGroupId || getDefaultGroupIdForBackend("web")
      : Promise.resolve(null),
    effectiveSyncMode === "responses" || effectiveSyncMode === "both"
      ? task.responsesGroupId || getDefaultGroupIdForBackend("responses")
      : Promise.resolve(null),
  ]);

  return runSub2ApiSyncConfig({
    webGroupId,
    responsesGroupId,
    sourceGroupId: task.sourceGroupId,
    sourceGroupName: task.sourceGroupName,
    syncMode: effectiveSyncMode,
    allowMobileRtImport: task.allowMobileRtImport,
    contentSafetyEnabled: task.contentSafetyEnabled,
    planFilter: task.planFilter,
    limit,
    syncTaskId: task.id,
    cleanupManagedAccounts: true,
    overwriteLocalUnavailableState: task.overwriteLocalUnavailableState,
  });
}

function toSub2ApiAutoSyncTaskLastResult(
  result: Awaited<ReturnType<typeof runSub2ApiSyncConfig>>
): NonNullable<Sub2ApiAutoSyncTask["lastResult"]> {
  return {
    sourceCount: result.sourceCount,
    totalSourceCount: result.totalSourceCount,
    syncedCount: result.syncedCount,
    syncedByMode: result.syncedByMode,
    skipped: result.skipped,
    failed: result.failed,
    failedByMode: result.failedByMode,
    deletedCount: result.deletedCount,
  };
}

export async function runSub2ApiAutoSyncTaskNow(taskIdInput: string) {
  if (!(await getOptionalSub2ApiPostgresConnectionString())) {
    throw new Error("请先配置 SUB2API_POSTGRES_URL");
  }

  const taskId = taskIdInput.trim();
  const tasks = await getSub2ApiAutoSyncTasks();
  const task = tasks.find((item) => item.id === taskId);
  if (!task) throw new Error("自动同步任务不存在");

  const limit = await getSub2ApiSyncBatchLimit();
  const result = await runSub2ApiAutoSyncTaskConfig(task, limit);
  const lastResult = toSub2ApiAutoSyncTaskLastResult(result);
  await updateSub2ApiAutoSyncTaskResult(task.id, lastResult);

  return {
    success: true,
    taskId: task.id,
    ...result,
    timestamp: new Date().toISOString(),
  };
}

export async function runSub2ApiManualSync(input: {
  sourceGroupId?: string | null;
  sourceGroupName?: string | null;
  webGroupId?: string | null;
  responsesGroupId?: string | null;
  syncMode: Sub2ApiTokenSyncMode;
  allowMobileRtImport?: boolean;
  contentSafetyEnabled: boolean;
  planFilter: Sub2ApiPlanFilter;
  limit?: number | null;
  createSyncTask?: boolean;
  overwriteLocalUnavailableState?: boolean;
  intervalMinutes?: number | null;
}) {
  if (!(await getOptionalSub2ApiPostgresConnectionString())) {
    throw new Error("请先配置 SUB2API_POSTGRES_URL");
  }

  const configuredLimit = await getSub2ApiSyncBatchLimit();
  const limit = Math.max(
    1,
    Math.min(500, Math.trunc(input.limit || configuredLimit))
  );
  const effectiveSyncMode = input.allowMobileRtImport
    ? input.syncMode
    : "responses";
  const planFilter = normalizeSub2ApiPlanFilter(input.planFilter);

  if (input.createSyncTask) {
    const task = await upsertSub2ApiAutoSyncTask({
      sourceGroupId: input.sourceGroupId,
      sourceGroupName: input.sourceGroupName,
      webGroupId: input.webGroupId,
      responsesGroupId: input.responsesGroupId,
      syncMode: effectiveSyncMode,
      allowMobileRtImport: input.allowMobileRtImport,
      contentSafetyEnabled: input.contentSafetyEnabled,
      overwriteLocalUnavailableState: input.overwriteLocalUnavailableState,
      intervalMinutes: input.intervalMinutes,
      planFilter,
    });
    const result = await runSub2ApiAutoSyncTaskConfig(task, limit);
    const lastResult = toSub2ApiAutoSyncTaskLastResult(result);
    await updateSub2ApiAutoSyncTaskResult(task.id, lastResult);
    return {
      success: true,
      taskId: task.id,
      ...result,
      timestamp: new Date().toISOString(),
    };
  }

  const result = await runSub2ApiSyncConfig({
    webGroupId: input.webGroupId,
    responsesGroupId: input.responsesGroupId,
    sourceGroupId: input.sourceGroupId,
    sourceGroupName: input.sourceGroupName,
    syncMode: effectiveSyncMode,
    allowMobileRtImport: input.allowMobileRtImport,
    contentSafetyEnabled: input.contentSafetyEnabled,
    planFilter,
    limit,
    cleanupManagedAccounts: false,
    overwriteLocalUnavailableState: input.overwriteLocalUnavailableState,
  });

  return {
    success: true,
    taskId: null,
    ...result,
    timestamp: new Date().toISOString(),
  };
}

export async function runAutoSub2ApiAccessTokenSync(options?: {
  force?: boolean;
}) {
  if (!(await getOptionalSub2ApiPostgresConnectionString())) {
    const skippedAt = new Date().toISOString();
    const previousMetadata = await getAutoSub2ApiSyncMetadata();
    await setAutoSub2ApiSyncMetadata({
      ...previousMetadata,
      lastSkippedAt: skippedAt,
      lastStatus: "skipped",
      lastError: undefined,
      lastErrorAt: undefined,
    });
    return {
      success: true,
      jobSkipped: true,
      reason: "sub2api_not_configured",
      intervalMinutes: 0,
      timestamp: skippedAt,
    };
  }

  const previousMetadata = await getAutoSub2ApiSyncMetadata();
  const startedAt = new Date().toISOString();
  await setAutoSub2ApiSyncMetadata({
    ...previousMetadata,
    lastStartedAt: startedAt,
  });

  try {
    const [limit, configuredTasks] = await Promise.all([
      getSub2ApiSyncBatchLimit(),
      getSub2ApiAutoSyncTasks(),
    ]);
    const enabledTasks = configuredTasks.filter((task) => task.enabled);
    const runnableTasks = enabledTasks.filter(
      (task) => shouldRunSub2ApiTask(task, Boolean(options?.force)).run
    );
    const aggregate = createSub2ApiSyncAggregate();
    const taskResults: NonNullable<
      NonNullable<AutoSub2ApiSyncMetadata["lastResult"]>["tasks"]
    > = [];

    if (runnableTasks.length) {
      for (const task of runnableTasks) {
        const result = await runSub2ApiAutoSyncTaskConfig(task, limit);
        aggregate.sourceCount += result.sourceCount;
        aggregate.totalSourceCount += result.totalSourceCount;
        aggregate.syncedCount += result.syncedCount;
        aggregate.syncedByMode.web += result.syncedByMode.web;
        aggregate.syncedByMode.responses += result.syncedByMode.responses;
        aggregate.skipped.web += result.skipped.web;
        aggregate.skipped.responses += result.skipped.responses;
        aggregate.failed += result.failed;
        aggregate.failedByMode.web += result.failedByMode.web;
        aggregate.failedByMode.responses += result.failedByMode.responses;
        aggregate.deletedCount += result.deletedCount;
        aggregate.refreshTokenWriteBackCount +=
          result.refreshTokenWriteBackCount;
        aggregate.batches += result.batches;
        taskResults.push({
          id: task.id,
          sourceGroupId: task.sourceGroupId,
          sourceGroupName: task.sourceGroupName,
          sourceCount: result.sourceCount,
          totalSourceCount: result.totalSourceCount,
          syncedCount: result.syncedCount,
          failed: result.failed,
          deletedCount: result.deletedCount,
        });
        await updateSub2ApiAutoSyncTaskResult(
          task.id,
          toSub2ApiAutoSyncTaskLastResult(result)
        );
      }
    } else {
      const finishedAt = new Date().toISOString();
      const metadata: AutoSub2ApiSyncMetadata = {
        ...previousMetadata,
        lastStartedAt: startedAt,
        lastFinishedAt: finishedAt,
        lastSkippedAt: finishedAt,
        lastStatus: "skipped",
      };
      await setAutoSub2ApiSyncMetadata(metadata);
      return {
        success: true,
        jobSkipped: true,
        reason: enabledTasks.length
          ? "task_interval_not_reached"
          : "no_enabled_tasks",
        taskCount: enabledTasks.length,
        nextRunAt:
          enabledTasks
            .map((task) => shouldRunSub2ApiTask(task, false).nextRunAt)
            .filter((value): value is string => Boolean(value))
            .sort()[0] ?? null,
        timestamp: finishedAt,
      };
    }

    const finishedAt = new Date().toISOString();
    const metadata: AutoSub2ApiSyncMetadata = {
      lastStartedAt: startedAt,
      lastFinishedAt: finishedAt,
      lastSuccessAt: finishedAt,
      lastStatus: "success",
      lastResult: {
        ...aggregate,
        tasks: taskResults,
      },
    };
    await setAutoSub2ApiSyncMetadata(metadata);

    return {
      success: true,
      jobSkipped: false,
      taskCount: enabledTasks.length,
      ranTaskCount: runnableTasks.length,
      ...aggregate,
      tasks: taskResults,
      timestamp: finishedAt,
    };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const message =
      error instanceof Error ? error.message : "Sub2API 自动同步失败";
    await setAutoSub2ApiSyncMetadata({
      ...previousMetadata,
      lastStartedAt: startedAt,
      lastFinishedAt: finishedAt,
      lastErrorAt: finishedAt,
      lastStatus: "error",
      lastError: message,
    });
    throw error;
  }
}

export async function refreshStaleWebBackendAccounts(options?: {
  staleMinutes?: number;
  limit?: number;
}) {
  const staleMinutes = Math.max(1, Math.trunc(options?.staleMinutes ?? 30));
  const limit = Math.max(1, Math.min(200, Math.trunc(options?.limit ?? 20)));
  const threshold = new Date(Date.now() - staleMinutes * 60_000);
  const now = new Date();
  const candidates = await db
    .select({
      id: imageBackendAccount.id,
      metadata: imageBackendAccount.metadata,
      cooldownUntil: imageBackendAccount.cooldownUntil,
      lastErrorAt: imageBackendAccount.lastErrorAt,
    })
    .from(imageBackendAccount)
    .where(
      and(
        eq(imageBackendAccount.implementationMode, "web"),
        eq(imageBackendAccount.isEnabled, true),
        or(
          eq(imageBackendAccount.status, "active"),
          eq(imageBackendAccount.status, "limited")
        ),
        or(
          isNull(imageBackendAccount.cooldownUntil),
          sql`${imageBackendAccount.cooldownUntil} <= ${now}`
        )
      )
    )
    .orderBy(
      asc(imageBackendAccount.lastErrorAt),
      asc(imageBackendAccount.lastUsedAt)
    )
    .limit(limit * 3);

  const selected = candidates
    .filter((account) => {
      const info = normalizeWebAccountMetadata(account.metadata);
      if (!info?.refreshedAt) return true;
      return new Date(info.refreshedAt).getTime() <= threshold.getTime();
    })
    .slice(0, limit);

  const results = [];
  for (const account of selected) {
    try {
      const info = await refreshImageBackendAccountInfo(account.id);
      results.push({
        id: account.id,
        success: true,
        quota: info.quota,
      });
    } catch (error) {
      results.push({
        id: account.id,
        success: false,
        error: error instanceof Error ? error.message : "刷新失败",
      });
    }
  }

  return {
    scanned: candidates.length,
    processed: selected.length,
    results,
  };
}

type UpsertApiInput = {
  id?: string;
  groupId?: string | null;
  groupIds?: string[] | null;
  mergeGroupIds?: boolean;
  name: string;
  baseUrl: string;
  apiKey?: string;
  model?: string | null;
  interfaceMode?: ImageBackendApiInterfaceMode;
  chatCompletionsUpstreamMode?: ChatCompletionsUpstreamMode;
  imagesUpstreamMode?: ImagesUpstreamMode;
  useStream: boolean;
  contentSafetyEnabled: boolean;
  isEnabled: boolean;
  alwaysActive: boolean;
  failureCooldownEnabled: boolean;
  priority: number;
  concurrency: number;
  // Adobe 来源标记 + 成员计费倍率（仅 adobeSourced 时生效）。
  adobeSourced?: boolean;
  billingMultiplier?: number;
  status?: string;
};

// 同步一个 API 直透后端在 image_backend_api_group 中的分组成员关系。
// 镜像 setImageBackendAccountGroups:replace 为真时先删后插全量替换,为假时仅追加;
// 主键 `${apiId}:${groupId}` + onConflictDoNothing 保证幂等、并发重复插入不报错。
async function setImageBackendApiGroups(input: {
  apiId: string;
  groupIds: string[];
  replace: boolean;
}) {
  const groupIds = normalizeAccountGroupIds(input.groupIds);
  if (input.replace) {
    await db
      .delete(imageBackendApiGroup)
      .where(eq(imageBackendApiGroup.apiId, input.apiId));
  }
  if (!groupIds.length) return;

  await db
    .insert(imageBackendApiGroup)
    .values(
      groupIds.map((groupId) => ({
        id: `${input.apiId}:${groupId}`,
        apiId: input.apiId,
        groupId,
      }))
    )
    .onConflictDoNothing();
}

export async function upsertImageBackendApi(input: UpsertApiInput) {
  // groupIds 为多分组真相,primaryGroupId 保留为主分组/向后兼容(取首个分组)。
  const groupIds = accountGroupIdsFromInput(input);
  const primaryGroupId = groupIds[0] || null;
  let existingPrimaryGroupId: string | null | undefined;

  if (input.id) {
    const [existingApi] = await db
      .select({ groupId: imageBackendApi.groupId })
      .from(imageBackendApi)
      .where(eq(imageBackendApi.id, input.id))
      .limit(1);
    existingPrimaryGroupId = existingApi?.groupId ?? null;
  }

  const updateBase = {
    name: input.name,
    baseUrl: stripTrailingSlash(input.baseUrl),
    model: input.model || null,
    interfaceMode: normalizeImageBackendApiInterfaceMode(input.interfaceMode),
    chatCompletionsUpstreamMode: normalizeChatCompletionsUpstreamMode(
      input.chatCompletionsUpstreamMode
    ),
    imageUpstreamMode: normalizeImagesUpstreamMode(input.imagesUpstreamMode),
    useStream: input.useStream,
    contentSafetyEnabled: input.contentSafetyEnabled,
    isEnabled: input.isEnabled,
    alwaysActive: input.alwaysActive,
    failureCooldownEnabled: input.failureCooldownEnabled,
    priority: input.priority,
    concurrency: Math.max(1, Math.min(10000, input.concurrency)),
    adobeSourced: input.adobeSourced ?? false,
    // numeric 列以字符串写入（与 image_backend_adobe.billing_multiplier 一致）。
    billingMultiplier: String(input.billingMultiplier ?? 1),
    status: input.status || "active",
    updatedAt: new Date(),
  };

  if (input.id) {
    // 合并模式保留既有主分组,否则以本次首个分组为主分组。
    const update = {
      ...updateBase,
      groupId: input.mergeGroupIds
        ? existingPrimaryGroupId || primaryGroupId
        : primaryGroupId,
    };
    await db
      .update(imageBackendApi)
      .set(input.apiKey ? { ...update, apiKey: input.apiKey } : update)
      .where(eq(imageBackendApi.id, input.id));
    await setImageBackendApiGroups({
      apiId: input.id,
      groupIds,
      replace: !input.mergeGroupIds,
    });
    return input.id;
  }

  if (!input.apiKey) {
    throw new Error("apiKey is required");
  }

  const id = nanoid();
  const update = {
    ...updateBase,
    groupId: primaryGroupId,
  };
  await db.insert(imageBackendApi).values({
    id,
    ...update,
    apiKey: input.apiKey,
  });
  await setImageBackendApiGroups({
    apiId: id,
    groupIds,
    replace: true,
  });
  return id;
}

// Adobe 后端与分组关系写入（镜像 setImageBackendApiGroups）。
async function setImageBackendAdobeGroups(input: {
  adobeId: string;
  groupIds: string[];
  replace: boolean;
}) {
  const groupIds = normalizeAccountGroupIds(input.groupIds);
  if (input.replace) {
    await db
      .delete(imageBackendAdobeGroup)
      .where(eq(imageBackendAdobeGroup.adobeId, input.adobeId));
  }
  if (!groupIds.length) return;
  await db
    .insert(imageBackendAdobeGroup)
    .values(
      groupIds.map((groupId) => ({
        id: `${input.adobeId}:${groupId}`,
        adobeId: input.adobeId,
        groupId,
      }))
    )
    .onConflictDoNothing();
}

export type UpsertAdobeInput = {
  id?: string;
  groupId?: string | null;
  groupIds?: string[];
  mergeGroupIds?: boolean;
  name: string;
  mode?: "gateway" | "direct";
  baseUrl: string;
  apiKey?: string;
  enabledModels?: string[] | null;
  defaultRatio: string;
  defaultResolution: string;
  gptImageQuality: string;
  billingMultiplier: number;
  supportsVideo: boolean;
  contentSafetyEnabled: boolean;
  isEnabled: boolean;
  alwaysActive: boolean;
  failureCooldownEnabled: boolean;
  priority: number;
  concurrency: number;
  status?: string;
};

/**
 * 新建/更新一个 Adobe（adobe2api）后端。镜像 upsertImageBackendApi：groupIds 为多分组
 * 真相，primaryGroupId（首个）保留为主分组；编辑时仅在传入 apiKey 时才覆写密钥。
 */
export async function upsertImageBackendAdobe(input: UpsertAdobeInput) {
  const groupIds = accountGroupIdsFromInput(input);
  const primaryGroupId = groupIds[0] || null;
  let existingPrimaryGroupId: string | null | undefined;

  if (input.id) {
    const [existing] = await db
      .select({ groupId: imageBackendAdobe.groupId })
      .from(imageBackendAdobe)
      .where(eq(imageBackendAdobe.id, input.id))
      .limit(1);
    existingPrimaryGroupId = existing?.groupId ?? null;
  }

  const mode = input.mode === "direct" ? "direct" : "gateway";
  const updateBase = {
    name: input.name,
    mode,
    baseUrl: stripTrailingSlash(input.baseUrl),
    enabledModels: input.enabledModels ?? null,
    defaultRatio: input.defaultRatio,
    defaultResolution: input.defaultResolution,
    gptImageQuality: input.gptImageQuality,
    // numeric 列要求字符串。
    billingMultiplier: String(input.billingMultiplier),
    supportsVideo: input.supportsVideo,
    contentSafetyEnabled: input.contentSafetyEnabled,
    isEnabled: input.isEnabled,
    alwaysActive: input.alwaysActive,
    failureCooldownEnabled: input.failureCooldownEnabled,
    priority: input.priority,
    concurrency: Math.max(1, Math.min(10000, input.concurrency)),
    status: input.status || "active",
    updatedAt: new Date(),
  };

  if (input.id) {
    const update = {
      ...updateBase,
      groupId: input.mergeGroupIds
        ? existingPrimaryGroupId || primaryGroupId
        : primaryGroupId,
    };
    await db
      .update(imageBackendAdobe)
      .set(input.apiKey ? { ...update, apiKey: input.apiKey } : update)
      .where(eq(imageBackendAdobe.id, input.id));
    await setImageBackendAdobeGroups({
      adobeId: input.id,
      groupIds,
      replace: !input.mergeGroupIds,
    });
    return input.id;
  }

  // direct 模式凭据为 Adobe 账号/cookie（另表），不需要网关 apiKey；gateway 模式必填。
  if (mode === "gateway" && !input.apiKey) {
    throw new Error("apiKey is required");
  }
  const id = nanoid();
  await db.insert(imageBackendAdobe).values({
    id,
    ...updateBase,
    groupId: primaryGroupId,
    apiKey: input.apiKey ?? "",
  });
  await setImageBackendAdobeGroups({ adobeId: id, groupIds, replace: true });
  return id;
}

/** 启用/停用一个 Adobe 后端（镜像 setImageBackendApiEnabled）。 */
export async function setImageBackendAdobeEnabled(input: {
  id: string;
  isEnabled: boolean;
}): Promise<void> {
  await db
    .update(imageBackendAdobe)
    .set({
      isEnabled: input.isEnabled,
      ...(input.isEnabled
        ? {
            status: "active",
            cooldownUntil: null,
            lastError: null,
            lastErrorAt: null,
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(imageBackendAdobe.id, input.id));
}

/** 设置一个 Adobe 后端的 always_active 开关（镜像 api 版）。 */
export async function setImageBackendAdobeAlwaysActive(input: {
  id: string;
  alwaysActive: boolean;
}): Promise<void> {
  await db
    .update(imageBackendAdobe)
    .set({
      alwaysActive: input.alwaysActive,
      ...(input.alwaysActive
        ? {
            status: "active",
            cooldownUntil: null,
            lastError: null,
            lastErrorAt: null,
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(imageBackendAdobe.id, input.id));
}

/**
 * 启用/停用一个 API 直透后端（"是否启用"快速开关）。
 *
 * @param input.id 目标 imageBackendApi 行 id。
 * @param input.isEnabled 目标启用态。
 * @returns void。仅更新 isEnabled 与 updatedAt；停用后调度器不再选中该成员。
 */
export async function setImageBackendApiEnabled(input: {
  id: string;
  isEnabled: boolean;
}): Promise<void> {
  await db
    .update(imageBackendApi)
    .set({
      isEnabled: input.isEnabled,
      // 重新启用＝给次机会：清掉 error/冷却，让粘性 error 的后端回到候选。
      ...(input.isEnabled
        ? {
            status: "active",
            cooldownUntil: null,
            lastError: null,
            lastErrorAt: null,
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(imageBackendApi.id, input.id));
}

/**
 * 设置一个 API 直透后端的"遇错仍可用（always_active）"开关。
 *
 * 开启后（且 isEnabled 为真）：该 API 无视 status/cooldown 始终入选、失败不进
 * 冷却、不被置 error。关闭后恢复常规：失败可被调度器冷却/标 error 排除。
 * 开启时顺手把当前 error/cooldown 清掉，让它立即回到候选。
 *
 * @param input.id 目标 imageBackendApi 行 id。
 * @param input.alwaysActive 目标开关态。
 */
export async function setImageBackendApiAlwaysActive(input: {
  id: string;
  alwaysActive: boolean;
}): Promise<void> {
  await db
    .update(imageBackendApi)
    .set({
      alwaysActive: input.alwaysActive,
      ...(input.alwaysActive ? { status: "active", cooldownUntil: null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(imageBackendApi.id, input.id));
}

/**
 * 设置一个账号后端的"遇错仍可用（always_active）"开关。语义与
 * setImageBackendApiAlwaysActive 一致:开启后(且 isEnabled 为真)该账号无视
 * status/cooldown 始终入选、失败不进冷却、不被置 error;开启时顺手清掉当前
 * error/cooldown 让它立即回到候选。
 *
 * @param input.id 目标 imageBackendAccount 行 id。
 * @param input.alwaysActive 目标开关态。
 */
export async function setImageBackendAccountAlwaysActive(input: {
  id: string;
  alwaysActive: boolean;
}): Promise<void> {
  await db
    .update(imageBackendAccount)
    .set({
      alwaysActive: input.alwaysActive,
      ...(input.alwaysActive ? { status: "active", cooldownUntil: null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(imageBackendAccount.id, input.id));
}

/** 将测活失败结果格式化为中文，写入 lastError 供后台展示。 */
function describeImageHealthFailure(result: ImageApiHealthResult): string {
  switch (result.status) {
    case "no_image":
      return `测活：连接成功但未返回图片（${result.message}）`;
    case "auth_failed":
      return `测活：密钥被拒绝（${result.message}）`;
    case "unreachable":
      return `测活：无法连接或超时（${result.message}）`;
    default:
      return `测活：出图失败（${result.message}）`;
  }
}

/**
 * 测活：对一个 API 直透后端发起一次真实最小生图请求，看是否真的返回图片，
 * 并把结果落到该成员的健康字段。
 *
 * 成功（真返回图片）：清空 lastError/cooldownUntil 并置 status="active"。
 * 失败：写入 lastError/lastErrorAt 供后台展示。其中"出不了图（no_image）/密钥
 * 失效（auth_failed）"属确定性不可用 → 置 status="error" 踢出轮换；瞬时不可达/
 * 超时（unreachable）不擅自下线，仅记录，由管理员决定停用。
 * 复用 generateImage（reportResult=false），不改动 success/fail 计数；但会真实
 * 消耗上游 1 张图额度。
 *
 * @param id 目标 imageBackendApi 行 id。
 * @returns `{ id, name, result }`；成员不存在时抛错。
 */
export async function probeImageBackendApi(id: string): Promise<{
  id: string;
  name: string;
  result: ImageApiHealthResult;
}> {
  const [api] = await db
    .select({
      id: imageBackendApi.id,
      name: imageBackendApi.name,
      baseUrl: imageBackendApi.baseUrl,
      apiKey: imageBackendApi.apiKey,
      model: imageBackendApi.model,
      useStream: imageBackendApi.useStream,
      interfaceMode: imageBackendApi.interfaceMode,
      imageUpstreamMode: imageBackendApi.imageUpstreamMode,
      chatCompletionsUpstreamMode: imageBackendApi.chatCompletionsUpstreamMode,
      alwaysActive: imageBackendApi.alwaysActive,
    })
    .from(imageBackendApi)
    .where(eq(imageBackendApi.id, id))
    .limit(1);

  if (!api) {
    throw new Error("API 后端不存在");
  }

  const result = await checkImageBackendApiHealth({
    baseUrl: api.baseUrl,
    apiKey: api.apiKey,
    model: api.model,
    useStream: api.useStream,
    apiInterfaceMode: normalizeImageBackendApiInterfaceMode(api.interfaceMode),
    imagesUpstreamMode: normalizeImagesUpstreamMode(api.imageUpstreamMode),
    chatCompletionsUpstreamMode: normalizeChatCompletionsUpstreamMode(
      api.chatCompletionsUpstreamMode
    ),
    backendType: "pool-api",
  });

  const now = new Date();
  if (result.ok) {
    await db
      .update(imageBackendApi)
      .set({
        status: "active",
        lastError: null,
        lastErrorAt: null,
        cooldownUntil: null,
        updatedAt: now,
      })
      .where(eq(imageBackendApi.id, id));
  } else {
    // always_active：遇错也不下线——只记录 lastError，不置 error。
    const markError =
      !api.alwaysActive &&
      (result.status === "no_image" || result.status === "auth_failed");
    await db
      .update(imageBackendApi)
      .set({
        lastError: truncateError(describeImageHealthFailure(result)),
        lastErrorAt: now,
        ...(markError ? { status: "error" } : {}),
        updatedAt: now,
      })
      .where(eq(imageBackendApi.id, id));
  }

  return { id: api.id, name: api.name, result };
}

export async function deleteImageBackendMembers(input: {
  accountIds?: string[];
  apiIds?: string[];
  adobeIds?: string[];
}) {
  let deletedAccountCount = 0;
  let deletedApiCount = 0;
  let deletedAdobeCount = 0;
  if (input.accountIds?.length) {
    const accountIds = Array.from(new Set(input.accountIds.filter(Boolean)));
    for (let index = 0; index < accountIds.length; index += 500) {
      const chunk = accountIds.slice(index, index + 500);
      if (!chunk.length) continue;
      await db
        .delete(imageBackendAccount)
        .where(inArray(imageBackendAccount.id, chunk));
      deletedAccountCount += chunk.length;
    }
  }
  if (input.apiIds?.length) {
    const apiIds = Array.from(new Set(input.apiIds.filter(Boolean)));
    for (let index = 0; index < apiIds.length; index += 500) {
      const chunk = apiIds.slice(index, index + 500);
      if (!chunk.length) continue;
      await db
        .delete(imageBackendApi)
        .where(inArray(imageBackendApi.id, chunk));
      deletedApiCount += chunk.length;
    }
  }
  if (input.adobeIds?.length) {
    const adobeIds = Array.from(new Set(input.adobeIds.filter(Boolean)));
    for (let index = 0; index < adobeIds.length; index += 500) {
      const chunk = adobeIds.slice(index, index + 500);
      if (!chunk.length) continue;
      await db
        .delete(imageBackendAdobe)
        .where(inArray(imageBackendAdobe.id, chunk));
      deletedAdobeCount += chunk.length;
    }
  }
  return { deletedAccountCount, deletedApiCount, deletedAdobeCount };
}

function adminAccountStatusCondition(
  status: AdminImageBackendAccountStatusFilter,
  now: Date
) {
  if (status === "disabled") return eq(imageBackendAccount.isEnabled, false);
  if (status === "cooling") return gt(imageBackendAccount.cooldownUntil, now);
  if (status === "limited") {
    return and(
      eq(imageBackendAccount.isEnabled, true),
      or(
        eq(imageBackendAccount.status, "limited"),
        sql`${imageBackendAccount.metadata}->'webAccount'->>'status' = 'limited'`
      )
    );
  }
  if (status === "error") {
    return and(
      eq(imageBackendAccount.isEnabled, true),
      eq(imageBackendAccount.status, "error")
    );
  }
  if (status === "active") {
    return and(
      eq(imageBackendAccount.isEnabled, true),
      eq(imageBackendAccount.status, "active"),
      sql`(${imageBackendAccount.cooldownUntil} IS NULL OR ${imageBackendAccount.cooldownUntil} <= ${now})`,
      sql`COALESCE(${imageBackendAccount.metadata}->'webAccount'->>'status', '') <> 'limited'`
    );
  }
  return undefined;
}

function adminAccountFilterConditions(
  options: AdminImageBackendAccountListOptions
) {
  const conditions = [];
  const groupId = options.groupId?.trim() || "all";
  if (groupId === "default") {
    conditions.push(
      and(
        isNull(imageBackendAccount.groupId),
        sql`NOT EXISTS (
          SELECT 1 FROM ${imageBackendAccountGroup}
          WHERE ${imageBackendAccountGroup.accountId} = ${imageBackendAccount.id}
        )`
      )
    );
  } else if (groupId !== "all") {
    conditions.push(
      or(
        sql`EXISTS (
          SELECT 1 FROM ${imageBackendAccountGroup}
          WHERE ${imageBackendAccountGroup.accountId} = ${imageBackendAccount.id}
            AND ${imageBackendAccountGroup.groupId} = ${groupId}
        )`,
        and(
          eq(imageBackendAccount.groupId, groupId),
          sql`NOT EXISTS (
            SELECT 1 FROM ${imageBackendAccountGroup}
            WHERE ${imageBackendAccountGroup.accountId} = ${imageBackendAccount.id}
          )`
        )
      )
    );
  }

  if (
    options.implementationMode === "web" ||
    options.implementationMode === "responses"
  ) {
    conditions.push(
      eq(imageBackendAccount.implementationMode, options.implementationMode)
    );
  }

  const statusCondition = adminAccountStatusCondition(
    options.status || "all",
    new Date()
  );
  if (statusCondition) conditions.push(statusCondition);

  const search = options.search?.trim();
  if (search) {
    const pattern = `%${search}%`;
    conditions.push(
      or(
        ilike(imageBackendAccount.name, pattern),
        ilike(imageBackendAccount.email, pattern),
        ilike(imageBackendAccount.implementationMode, pattern),
        ilike(imageBackendAccount.model, pattern),
        ilike(imageBackendAccount.status, pattern),
        ilike(imageBackendAccount.lastError, pattern),
        sql`CAST(${imageBackendAccount.metadata} AS TEXT) ILIKE ${pattern}`,
        sql`CASE
          WHEN ${imageBackendAccount.metadata}->>'source' = 'sub2api_postgres' THEN 'Sub2API'
          WHEN ${imageBackendAccount.metadata}->>'source' = 'manual_refresh_token' THEN '手工 RT'
          WHEN ${imageBackendAccount.metadata}->>'source' IN (
            'manual_web_access_token',
            'manual_auth_session_access_token'
          ) THEN 'Web AT'
          ELSE '本站'
        END ILIKE ${pattern}`,
        sql`EXISTS (
          SELECT 1
          FROM ${imageBackendGroup}
          WHERE ${imageBackendGroup.name} ILIKE ${pattern}
            AND (
              EXISTS (
                SELECT 1 FROM ${imageBackendAccountGroup}
                WHERE ${imageBackendAccountGroup.accountId} = ${imageBackendAccount.id}
                  AND ${imageBackendAccountGroup.groupId} = ${imageBackendGroup.id}
              )
              OR (
                ${imageBackendGroup.id} = ${imageBackendAccount.groupId}
                AND NOT EXISTS (
                  SELECT 1 FROM ${imageBackendAccountGroup}
                  WHERE ${imageBackendAccountGroup.accountId} = ${imageBackendAccount.id}
                )
              )
            )
        )`
      )
    );
  }

  return conditions.filter((condition) => condition !== undefined);
}

export async function deleteAllErrorImageBackendAccounts(
  options: Pick<
    AdminImageBackendAccountListOptions,
    "groupId" | "implementationMode" | "search"
  > = {}
) {
  const conditions = adminAccountFilterConditions({
    ...options,
    status: "all",
  });
  conditions.push(eq(imageBackendAccount.status, "error"));

  const deleted = await db
    .delete(imageBackendAccount)
    .where(and(...conditions))
    .returning({ id: imageBackendAccount.id });

  return { deletedAccountCount: deleted.length };
}

export async function listAdminImageBackendAccounts(
  options: AdminImageBackendAccountListOptions = {}
) {
  const pageSize = Math.min(100, Math.max(10, options.pageSize || 20));
  const requestedPage = Math.max(1, options.page || 1);
  const conditions = adminAccountFilterConditions(options);
  const where = conditions.length ? and(...conditions) : undefined;
  const now = new Date();

  const [countRows, summaryRows] = await Promise.all([
    db.select({ value: count() }).from(imageBackendAccount).where(where),
    db
      .select({
        total: count(),
        active: sql<number>`COUNT(*) FILTER (
          WHERE ${imageBackendAccount.isEnabled} = TRUE
            AND ${imageBackendAccount.status} = 'active'
            AND (${imageBackendAccount.cooldownUntil} IS NULL OR ${imageBackendAccount.cooldownUntil} <= ${now})
            AND COALESCE(${imageBackendAccount.metadata}->'webAccount'->>'status', '') <> 'limited'
        )`,
        limited: sql<number>`COUNT(*) FILTER (
          WHERE ${imageBackendAccount.status} = 'limited'
            OR ${imageBackendAccount.metadata}->'webAccount'->>'status' = 'limited'
        )`,
        cooling: sql<number>`COUNT(*) FILTER (
          WHERE ${imageBackendAccount.cooldownUntil} > ${now}
        )`,
        error: sql<number>`COUNT(*) FILTER (
          WHERE ${imageBackendAccount.status} = 'error'
        )`,
        disabled: sql<number>`COUNT(*) FILTER (
          WHERE ${imageBackendAccount.isEnabled} = FALSE
        )`,
        quota: sql<number>`COALESCE(SUM(
          CASE
            WHEN ${imageBackendAccount.implementationMode} = 'web'
              AND COALESCE(${imageBackendAccount.metadata}->'webAccount'->>'quota', '') ~ '^[0-9]+(\\.[0-9]+)?$'
            THEN (${imageBackendAccount.metadata}->'webAccount'->>'quota')::numeric
            ELSE 0
          END
        ), 0)`,
      })
      .from(imageBackendAccount),
  ]);

  const total = Number(countRows[0]?.value || 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const accounts = await db
    .select({
      id: imageBackendAccount.id,
      groupId: imageBackendAccount.groupId,
      name: imageBackendAccount.name,
      email: imageBackendAccount.email,
      implementationMode: imageBackendAccount.implementationMode,
      model: imageBackendAccount.model,
      contentSafetyEnabled: imageBackendAccount.contentSafetyEnabled,
      isEnabled: imageBackendAccount.isEnabled,
      alwaysActive: imageBackendAccount.alwaysActive,
      priority: imageBackendAccount.priority,
      concurrency: imageBackendAccount.concurrency,
      status: imageBackendAccount.status,
      successCount: imageBackendAccount.successCount,
      failCount: imageBackendAccount.failCount,
      lastUsedAt: imageBackendAccount.lastUsedAt,
      cooldownUntil: imageBackendAccount.cooldownUntil,
      lastError: imageBackendAccount.lastError,
      lastErrorAt: imageBackendAccount.lastErrorAt,
      metadata: imageBackendAccount.metadata,
      createdAt: imageBackendAccount.createdAt,
    })
    .from(imageBackendAccount)
    .where(where)
    .orderBy(
      asc(imageBackendAccount.priority),
      desc(imageBackendAccount.createdAt),
      asc(imageBackendAccount.id)
    )
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const accountGroupRows = accounts.length
    ? await db
        .select({
          accountId: imageBackendAccountGroup.accountId,
          groupId: imageBackendAccountGroup.groupId,
        })
        .from(imageBackendAccountGroup)
        .where(
          inArray(
            imageBackendAccountGroup.accountId,
            accounts.map((account) => account.id)
          )
        )
    : [];
  const accountGroupIdMap = new Map<string, string[]>();
  for (const row of accountGroupRows) {
    const current = accountGroupIdMap.get(row.accountId) || [];
    current.push(row.groupId);
    accountGroupIdMap.set(row.accountId, current);
  }
  const rawSummary = summaryRows[0];
  const summary: AdminImageBackendAccountSummary = {
    total: Number(rawSummary?.total || 0),
    active: Number(rawSummary?.active || 0),
    limited: Number(rawSummary?.limited || 0),
    cooling: Number(rawSummary?.cooling || 0),
    error: Number(rawSummary?.error || 0),
    disabled: Number(rawSummary?.disabled || 0),
    quota: Number(rawSummary?.quota || 0),
  };

  return {
    accounts: accounts.map((account) => ({
      ...account,
      groupIds:
        accountGroupIdMap.get(account.id) ||
        normalizeAccountGroupIds(account.groupId ? [account.groupId] : []),
    })),
    accountPage: { page, pageSize, total, totalPages },
    accountSummary: summary,
  };
}

export async function listAdminImageBackendPool() {
  const groups = await db
    .select()
    .from(imageBackendGroup)
    .orderBy(asc(imageBackendGroup.priority), asc(imageBackendGroup.createdAt));
  const accountCounts = await db
    .select({ groupId: imageBackendAccountGroup.groupId, value: count() })
    .from(imageBackendAccountGroup)
    .groupBy(imageBackendAccountGroup.groupId);
  const apiCounts = await db
    .select({ groupId: imageBackendApiGroup.groupId, value: count() })
    .from(imageBackendApiGroup)
    .groupBy(imageBackendApiGroup.groupId);
  const accountCountMap = new Map(
    accountCounts.map((item) => [item.groupId, Number(item.value)])
  );
  const apiCountMap = new Map(
    apiCounts.map((item) => [item.groupId, Number(item.value)])
  );

  const summaries: ImageBackendGroupSummary[] = groups.map((group) => ({
    id: group.id,
    name: group.name,
    description: group.description,
    isEnabled: group.isEnabled,
    isDefault: group.isDefault,
    isUserSelectable: group.isUserSelectable,
    contentSafetyEnabled: group.contentSafetyEnabled,
    backendType: getGroupBackendType(group.metadata),
    minPlan: getGroupMinPlan(group.metadata),
    billingMultiplier: getGroupBillingMultiplier(group.metadata),
    childGroupIds: getGroupChildGroupIds(group.metadata),
    priority: group.priority,
    apiCount: apiCountMap.get(group.id) ?? 0,
    accountCount: accountCountMap.get(group.id) ?? 0,
  }));

  const apis = await db
    .select({
      id: imageBackendApi.id,
      groupId: imageBackendApi.groupId,
      name: imageBackendApi.name,
      baseUrl: imageBackendApi.baseUrl,
      model: imageBackendApi.model,
      interfaceMode: imageBackendApi.interfaceMode,
      chatCompletionsUpstreamMode: imageBackendApi.chatCompletionsUpstreamMode,
      imagesUpstreamMode: imageBackendApi.imageUpstreamMode,
      useStream: imageBackendApi.useStream,
      contentSafetyEnabled: imageBackendApi.contentSafetyEnabled,
      isEnabled: imageBackendApi.isEnabled,
      alwaysActive: imageBackendApi.alwaysActive,
      failureCooldownEnabled: imageBackendApi.failureCooldownEnabled,
      priority: imageBackendApi.priority,
      concurrency: imageBackendApi.concurrency,
      adobeSourced: imageBackendApi.adobeSourced,
      billingMultiplier: imageBackendApi.billingMultiplier,
      status: imageBackendApi.status,
      successCount: imageBackendApi.successCount,
      failCount: imageBackendApi.failCount,
      lastUsedAt: imageBackendApi.lastUsedAt,
      cooldownUntil: imageBackendApi.cooldownUntil,
      lastError: imageBackendApi.lastError,
      lastErrorAt: imageBackendApi.lastErrorAt,
      createdAt: imageBackendApi.createdAt,
    })
    .from(imageBackendApi)
    .orderBy(asc(imageBackendApi.priority), desc(imageBackendApi.createdAt));
  const apiGroupRows = apis.length
    ? await db
        .select({
          apiId: imageBackendApiGroup.apiId,
          groupId: imageBackendApiGroup.groupId,
        })
        .from(imageBackendApiGroup)
        .where(
          inArray(
            imageBackendApiGroup.apiId,
            apis.map((api) => api.id)
          )
        )
    : [];
  const apiGroupIdMap = new Map<string, string[]>();
  for (const row of apiGroupRows) {
    const current = apiGroupIdMap.get(row.apiId) || [];
    current.push(row.groupId);
    apiGroupIdMap.set(row.apiId, current);
  }

  const adobes = await db
    .select({
      id: imageBackendAdobe.id,
      groupId: imageBackendAdobe.groupId,
      name: imageBackendAdobe.name,
      mode: imageBackendAdobe.mode,
      baseUrl: imageBackendAdobe.baseUrl,
      enabledModels: imageBackendAdobe.enabledModels,
      defaultRatio: imageBackendAdobe.defaultRatio,
      defaultResolution: imageBackendAdobe.defaultResolution,
      gptImageQuality: imageBackendAdobe.gptImageQuality,
      billingMultiplier: imageBackendAdobe.billingMultiplier,
      supportsVideo: imageBackendAdobe.supportsVideo,
      contentSafetyEnabled: imageBackendAdobe.contentSafetyEnabled,
      isEnabled: imageBackendAdobe.isEnabled,
      alwaysActive: imageBackendAdobe.alwaysActive,
      failureCooldownEnabled: imageBackendAdobe.failureCooldownEnabled,
      priority: imageBackendAdobe.priority,
      concurrency: imageBackendAdobe.concurrency,
      status: imageBackendAdobe.status,
      successCount: imageBackendAdobe.successCount,
      failCount: imageBackendAdobe.failCount,
      lastUsedAt: imageBackendAdobe.lastUsedAt,
      cooldownUntil: imageBackendAdobe.cooldownUntil,
      lastError: imageBackendAdobe.lastError,
      lastErrorAt: imageBackendAdobe.lastErrorAt,
      createdAt: imageBackendAdobe.createdAt,
    })
    .from(imageBackendAdobe)
    .orderBy(
      asc(imageBackendAdobe.priority),
      desc(imageBackendAdobe.createdAt)
    );
  const adobeGroupRows = adobes.length
    ? await db
        .select({
          adobeId: imageBackendAdobeGroup.adobeId,
          groupId: imageBackendAdobeGroup.groupId,
        })
        .from(imageBackendAdobeGroup)
        .where(
          inArray(
            imageBackendAdobeGroup.adobeId,
            adobes.map((adobe) => adobe.id)
          )
        )
    : [];
  const adobeGroupIdMap = new Map<string, string[]>();
  for (const row of adobeGroupRows) {
    const current = adobeGroupIdMap.get(row.adobeId) || [];
    current.push(row.groupId);
    adobeGroupIdMap.set(row.adobeId, current);
  }

  return {
    groups: summaries,
    apis: apis.map((api) => ({
      ...api,
      // numeric 列回库为字符串，转成数值供前端展示/编辑。
      billingMultiplier: Number(api.billingMultiplier) || 1,
      groupIds:
        apiGroupIdMap.get(api.id) ||
        normalizeAccountGroupIds(api.groupId ? [api.groupId] : []),
    })),
    adobes: adobes.map((adobe) => ({
      ...adobe,
      groupIds:
        adobeGroupIdMap.get(adobe.id) ||
        normalizeAccountGroupIds(adobe.groupId ? [adobe.groupId] : []),
    })),
  };
}

/**
 * 统计某分组内"当前可用"的 web 账号数量。
 *
 * 用途：号池维持定时任务据此判断是否需要补号。可用判定与选号轮换口径一致：
 *   - implementationMode = web 且 isEnabled
 *   - alwaysActive 且 status<>'error'（始终可用、非死号）；或 status='active' 且
 *     未在冷却（cooldownUntil 为空或已过期）
 *   - 通过 junction 表或 legacy groupId 列归属该分组（与选号查询的双口径一致）
 *
 * @param groupId 目标分组 ID
 * @returns 去重后的可用 web 账号数
 */
export async function countAvailableWebAccountsInGroup(
  groupId: string
): Promise<number> {
  const now = new Date();
  const rows = await db
    .select({ id: imageBackendAccount.id })
    .from(imageBackendAccount)
    .leftJoin(
      imageBackendAccountGroup,
      eq(imageBackendAccountGroup.accountId, imageBackendAccount.id)
    )
    .where(
      and(
        eq(imageBackendAccount.implementationMode, "web"),
        eq(imageBackendAccount.isEnabled, true),
        or(
          and(
            eq(imageBackendAccount.alwaysActive, true),
            sql`${imageBackendAccount.status} <> 'error'`
          ),
          and(
            eq(imageBackendAccount.status, "active"),
            sql`(${imageBackendAccount.cooldownUntil} IS NULL OR ${imageBackendAccount.cooldownUntil} <= ${now})`
          )
        ),
        or(
          eq(imageBackendAccountGroup.groupId, groupId),
          eq(imageBackendAccount.groupId, groupId)
        )
      )
    )
    .groupBy(imageBackendAccount.id);
  return rows.length;
}
