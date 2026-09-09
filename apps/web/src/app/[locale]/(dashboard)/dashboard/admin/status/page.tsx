import { unstable_cache } from "next/cache";
import { getLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  Coins,
  ImageIcon,
  Server,
  Video,
} from "lucide-react";
import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  lte,
  sql,
  type SQL,
} from "drizzle-orm";

import { db } from "@repo/database";
import {
  creditsBalance,
  creditsBatch,
  creditsTransaction,
  generation,
  imageBackendAccount,
  imageBackendAdobe,
  imageBackendApi,
  imageBackendSchedulerMetric,
  ticket,
  user,
  videoGeneration,
} from "@repo/database/schema";
import { getUserRoleById } from "@repo/shared/auth/role-server";
import { canViewImageBackendPool } from "@repo/shared/auth/roles";
import { getServerSession } from "@repo/shared/auth/server";
import { formatCredits } from "@repo/shared/credits/format";
import {
  formatDateInTimeZone,
  formatDateInputInTimeZone,
  parseDateInputInTimeZone,
} from "@repo/shared/time-zone";
import { getAppTimeZone } from "@repo/shared/time-zone/server";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { Progress } from "@repo/ui/components/progress";
import {
  AUTO_IMAGE_SIZE,
  IMAGE_1K_BASE_EDGE,
  normalizeValidImageSize,
} from "@/features/image-generation/resolution";
import { classifyGenerationError } from "@/features/image-generation/sla";
import { GLOBAL_STATUS_CACHE_TAG } from "./cache-tag";
import { RefreshStatusButton } from "./refresh-status-button";

export const dynamic = "force-dynamic";

const ERROR_PAGE_SIZE = 50;

type ErrorRange = "24h" | "7d" | "30d" | "90d" | "all" | "custom";

interface GlobalStatusPageProps {
  searchParams: Promise<{
    errorRange?: string;
    errorFrom?: string;
    errorTo?: string;
    errorPage?: string;
  }>;
}

type GenerationMetricRow = {
  status: "pending" | "completed" | "failed";
  error: string | null;
  creditsConsumed: number;
  storageKey: string | null;
  size: string;
  createdAt: Date;
  completedAt: Date | null;
  metadata: Record<string, unknown> | null;
};

const RESOLUTION_DURATION_BUCKETS = ["4k", "2k", "1k", "custom"] as const;
const BACKEND_DURATION_BUCKETS = ["web", "codex", "images", "adobe"] as const;

type ResolutionDurationBucket = (typeof RESOLUTION_DURATION_BUCKETS)[number];
type BackendDurationBucket = (typeof BACKEND_DURATION_BUCKETS)[number];
type DurationBucketStats = {
  count: number;
  avgSeconds: number | null;
  p95Seconds: number | null;
};
type DurationBreakdown = Record<
  ResolutionDurationBucket,
  Record<BackendDurationBucket, DurationBucketStats>
>;

type GenerationWindowStats = {
  total: number;
  completed: number;
  failed: number;
  pending: number;
  producedImages: number;
  creditsConsumed: number;
  successRate: number;
  platformSla: number;
  platformErrors: number;
  moderationErrors: number;
  userRequestErrors: number;
  avgSeconds: number | null;
  p95Seconds: number | null;
  durationBreakdown: DurationBreakdown;
  moderationPromptRepair: ModerationPromptRepairStats;
};

type ModerationPromptRepairStats = {
  attempted: number;
  succeeded: number;
  failed: number;
  byAttempt: Array<{
    attempt: number;
    attempted: number;
    succeeded: number;
    failed: number;
  }>;
};

type BackendHealthStats = {
  total: number;
  enabled: number;
  active: number;
  limited: number;
  error: number;
  cooling: number;
  disabled: number;
  successCount: number;
  failCount: number;
  modes: Array<{ mode: string; count: number }>;
};

type SchedulerMetricStats = {
  selectCount: number;
  stickyPreviousHits: number;
  stickySessionHits: number;
  stickyHitRate: number;
  loadBalanceCount: number;
  switchCount: number;
  avgCandidateCount: number | null;
  avgLatencyMs: number | null;
  byLayer: Array<{ layer: string; count: number }>;
};

// 视频生成(Adobe Firefly)是独立管线,记录落在 video_generation 表(非 generation),
// 监控其他区块全部读 generation,因此视频在原有面板里完全不可见。此处单独聚合并展示。
// 模型族顺序固定,与创作页/后端配置一致(sora2 / sora2-pro / veo31 系列 / kling 系列)。
const VIDEO_FAMILIES = [
  "sora2",
  "sora2-pro",
  "veo31",
  "veo31-ref",
  "veo31-fast",
  "kling-o3",
  "kling3",
] as const;

type VideoFamilyStats = {
  family: string;
  total: number;
  completed: number;
  failed: number;
};

type VideoGenerationStats = {
  total: number;
  completed: number;
  failed: number;
  running: number;
  pending: number;
  // 成功率 = 完成 / (完成 + 失败);仅在有终态样本时有意义。
  successRate: number;
  // 已完成视频累计消耗积分。
  creditsConsumed: number;
  // 已完成视频累计时长(秒)。
  totalVideoSeconds: number;
  // 已完成视频平均生成耗时(completedAt - createdAt,秒);无样本为 null。
  avgLatencySeconds: number | null;
  byFamily: VideoFamilyStats[];
};

// video_generation 按 (family, status) 分组的原始聚合行。
type VideoAggregateRow = {
  family: string;
  status: string;
  total: number;
  creditsConsumed: number;
  videoSeconds: number;
  latencySecondsTotal: number;
  latencyCount: number;
};

type HistoricalErrorFilters = {
  range: ErrorRange;
  fromInput: string;
  toInput: string;
  fromDate: Date | null;
  toDate: Date | null;
  page: number;
};

type HistoricalGenerationErrorRow = {
  id: string;
  userId: string;
  userEmail: string | null;
  userName: string | null;
  prompt: string;
  model: string;
  size: string;
  creditsConsumed: number;
  error: string | null;
  createdAt: Date;
  completedAt: Date | null;
  category: "platform" | "moderation" | "user_request";
};

function copy(locale: string, en: string, zh: string) {
  return locale === "zh" ? zh : en;
}

function normalizeErrorRange(value: string | undefined): ErrorRange {
  if (
    value === "24h" ||
    value === "7d" ||
    value === "30d" ||
    value === "90d" ||
    value === "all" ||
    value === "custom"
  ) {
    return value;
  }
  return "7d";
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseDateInput(
  value: string | undefined,
  timeZone: string,
  endOfDay = false
) {
  return parseDateInputInTimeZone(value, { timeZone, endOfDay });
}

function formatDateInput(date: Date, timeZone: string) {
  return formatDateInputInTimeZone(date, timeZone);
}

function parseHistoricalErrorFilters(
  searchParams: GlobalStatusPageProps["searchParams"] extends Promise<infer T>
    ? T
    : never,
  timeZone: string
): HistoricalErrorFilters {
  const range = normalizeErrorRange(searchParams.errorRange);
  const now = new Date();
  const page = parsePositiveInteger(searchParams.errorPage, 1);
  const customFrom = parseDateInput(searchParams.errorFrom, timeZone);
  const customTo = parseDateInput(searchParams.errorTo, timeZone, true);

  if (range === "all") {
    return {
      range,
      fromInput: searchParams.errorFrom ?? "",
      toInput: searchParams.errorTo ?? "",
      fromDate: null,
      toDate: null,
      page,
    };
  }

  if (range === "custom") {
    return {
      range,
      fromInput: searchParams.errorFrom ?? "",
      toInput: searchParams.errorTo ?? "",
      fromDate: customFrom,
      toDate: customTo,
      page,
    };
  }

  const rangeMs =
    range === "24h"
      ? 24 * 60 * 60 * 1000
      : range === "30d"
        ? 30 * 24 * 60 * 60 * 1000
        : range === "90d"
          ? 90 * 24 * 60 * 60 * 1000
          : 7 * 24 * 60 * 60 * 1000;
  const fromDate = new Date(now.getTime() - rangeMs);

  return {
    range,
    fromInput: formatDateInput(fromDate, timeZone),
    toInput: formatDateInput(now, timeZone),
    fromDate,
    toDate: null,
    page,
  };
}

function buildHistoricalErrorWhere(filters: HistoricalErrorFilters) {
  const conditions: SQL[] = [eq(generation.status, "failed")];
  if (filters.fromDate) conditions.push(gte(generation.createdAt, filters.fromDate));
  if (filters.toDate) conditions.push(lte(generation.createdAt, filters.toDate));
  return and(...conditions);
}

function formatDateTime(value: Date | null, locale: string, timeZone: string) {
  if (!value) return copy(locale, "Not recorded", "未记录");
  return formatDateInTimeZone(value, locale, {
    dateStyle: "medium",
    timeStyle: "medium",
  }, timeZone);
}

function truncateText(value: string | null, length: number) {
  const normalized = (value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > length
    ? `${normalized.slice(0, Math.max(0, length - 3))}...`
    : normalized;
}

function buildErrorPageHref(
  filters: HistoricalErrorFilters,
  page: number
) {
  const params = new URLSearchParams();
  params.set("errorRange", filters.range);
  params.set("errorPage", String(page));
  if (filters.range === "custom") {
    if (filters.fromInput) params.set("errorFrom", filters.fromInput);
    if (filters.toInput) params.set("errorTo", filters.toInput);
  }
  return `?${params.toString()}#historical-errors`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberFrom(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringFrom(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const RESOLUTION_RATIO_PRESETS = [
  { width: 1, height: 1 },
  { width: 3, height: 2 },
  { width: 2, height: 3 },
  { width: 16, height: 9 },
  { width: 9, height: 16 },
  { width: 4, height: 3 },
  { width: 3, height: 4 },
  { width: 21, height: 9 },
] as const;

function buildResolutionPresetSizes(edge: number) {
  const sizes = new Set<string>();
  for (const ratio of RESOLUTION_RATIO_PRESETS) {
    const landscape = ratio.width >= ratio.height;
    const rawWidth = landscape
      ? edge
      : (edge * ratio.width) / ratio.height;
    const rawHeight = landscape
      ? (edge * ratio.height) / ratio.width
      : edge;
    sizes.add(normalizeValidImageSize({ width: rawWidth, height: rawHeight }));
  }
  return sizes;
}

const RESOLUTION_PRESET_SIZES: Record<
  Exclude<ResolutionDurationBucket, "custom">,
  Set<string>
> = {
  "1k": buildResolutionPresetSizes(IMAGE_1K_BASE_EDGE),
  "2k": buildResolutionPresetSizes(2048),
  "4k": buildResolutionPresetSizes(3840),
};
for (const legacySize of ["1024x1024", "1536x1024", "1024x1536"]) {
  RESOLUTION_PRESET_SIZES["1k"].add(legacySize);
}

function getModerationPromptRepairAttempts(row: {
  metadata: Record<string, unknown> | null;
}) {
  const repair = asRecord(asRecord(row.metadata)?.moderationPromptRepair);
  const attempts = Array.isArray(repair?.attempts) ? repair.attempts : [];
  return attempts
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item));
}

function createModerationPromptRepairStats(): ModerationPromptRepairStats {
  return {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    byAttempt: [],
  };
}

function accumulateModerationPromptRepairStats(
  stats: ModerationPromptRepairStats,
  row: { metadata: Record<string, unknown> | null }
) {
  const byAttempt = new Map(
    stats.byAttempt.map((item) => [item.attempt, { ...item }])
  );

  for (const attempt of getModerationPromptRepairAttempts(row)) {
    const attemptNumber = Math.max(
      1,
      Math.floor(numberFrom(attempt.attempt) || 1)
    );
    const status = stringFrom(attempt.status);
    stats.attempted += 1;
    if (status === "succeeded") {
      stats.succeeded += 1;
    } else if (status === "failed" || status === "skipped") {
      stats.failed += 1;
    }

    const bucket =
      byAttempt.get(attemptNumber) || {
        attempt: attemptNumber,
        attempted: 0,
        succeeded: 0,
        failed: 0,
      };
    bucket.attempted += 1;
    if (status === "succeeded") {
      bucket.succeeded += 1;
    } else if (status === "failed" || status === "skipped") {
      bucket.failed += 1;
    }
    byAttempt.set(attemptNumber, bucket);
  }

  stats.byAttempt = Array.from(byAttempt.values()).sort(
    (left, right) => left.attempt - right.attempt
  );
}

function isResolutionDurationBucket(
  value: string
): value is ResolutionDurationBucket {
  return (RESOLUTION_DURATION_BUCKETS as readonly string[]).includes(value);
}

function isBackendDurationBucket(value: string): value is BackendDurationBucket {
  return (BACKEND_DURATION_BUCKETS as readonly string[]).includes(value);
}

function emptyDurationBucketStats(): DurationBucketStats {
  return { count: 0, avgSeconds: null, p95Seconds: null };
}

// 全 4x4(分辨率 x 后端)空格子;SQL 分组只回非空组,其余保持空(展示侧渲染"暂无样本")。
function emptyDurationBreakdown(): DurationBreakdown {
  const makeRow = () => ({
    web: emptyDurationBucketStats(),
    codex: emptyDurationBucketStats(),
    images: emptyDurationBucketStats(),
    adobe: emptyDurationBucketStats(),
  });
  return {
    "4k": makeRow(),
    "2k": makeRow(),
    "1k": makeRow(),
    custom: makeRow(),
  };
}

// 按窗口精确统计生图 SLA。所有展示字段都按 24h / 7d 各自窗口直接用 SQL 聚合,不再依赖
// recentGenerationRows 的 10000 行帽子——修复"高峰期 24h 行数即触顶、7d 取样塌缩成与
// 24h 同一批最近行,导致两窗口数值完全一致"的缺陷。
// - 计数 / 时延(avg、P95)/ 产图 / 积分:聚合 SQL。
// - 错误三分类:只取该窗口 failed 行的 error 文本,喂真实的 classifyGenerationError——
//   既精确,又不把 sla-classification.ts 约 150 条模式重写进 SQL 而新增第三处分类漂移。
// - 耗时分布(分辨率 x 后端):分组 SQL;backend / 分辨率桶用 CASE 复刻原 JS 口径,
//   预设尺寸用 RESOLUTION_PRESET_SIZES 作数组参数下推(单一真相源,零漂移)。
// - 审核修剪重试:只取该窗口含 attempts 的少量行,复用现有 JS 累加(零漂移)。
async function loadGenerationWindowStats(
  windowStart: Date
): Promise<GenerationWindowStats> {
  const metaJson = sql`${generation.metadata}::jsonb`;
  // 完成耗时(秒):clamp 非负 + round,对齐 JS 侧 Math.max(0, Math.round(...))。
  const durationExpr = sql`round(greatest(0, extract(epoch from (${generation.completedAt} - ${generation.createdAt}))))`;
  const completedDurationFilter = sql`filter (where ${generation.status} = 'completed' and ${generation.completedAt} is not null)`;
  // 后端桶:先按 backend.type=pool-adobe 识别 Adobe,否则取 accountBackend ??
  // imagesUpstreamMode ?? apiInterfaceMode 映射 web / responses->codex / images。
  const backendBucketExpr = sql`(case when ${metaJson} #>> '{backend,type}' = 'pool-adobe' then 'adobe' else (case coalesce(${metaJson} #>> '{backend,accountBackend}', ${metaJson} #>> '{backend,imagesUpstreamMode}', ${metaJson} #>> '{backend,apiInterfaceMode}') when 'web' then 'web' when 'responses' then 'codex' when 'images' then 'images' else null end) end)`;
  // 请求尺寸:requestedSize -> actualSize -> size 列,统一 lower(trim())。
  const sizeValueExpr = sql`lower(btrim(coalesce(nullif(${metaJson} #>> '{outputImage,requestedSize}', ''), nullif(${metaJson} #>> '{outputImage,actualSize}', ''), ${generation.size})))`;
  // 分辨率桶:web 统一 1k;空 / auto -> custom;否则匹配预设集,余 custom。
  const resolutionBucketExpr = sql`(case when ${backendBucketExpr} = 'web' then '1k' when ${sizeValueExpr} = '' or ${sizeValueExpr} = ${AUTO_IMAGE_SIZE} then 'custom' when ${inArray(sizeValueExpr, [...RESOLUTION_PRESET_SIZES["4k"]])} then '4k' when ${inArray(sizeValueExpr, [...RESOLUTION_PRESET_SIZES["2k"]])} then '2k' when ${inArray(sizeValueExpr, [...RESOLUTION_PRESET_SIZES["1k"]])} then '1k' else 'custom' end)`;

  const [aggregateRows, failedRows, durationBreakdownRows, repairRows] =
    await Promise.all([
      db
        .select({
          total: count(),
          completed:
            sql<number>`sum(case when ${generation.status} = 'completed' then 1 else 0 end)`.mapWith(
              Number
            ),
          failed:
            sql<number>`sum(case when ${generation.status} = 'failed' then 1 else 0 end)`.mapWith(
              Number
            ),
          pending:
            sql<number>`sum(case when ${generation.status} = 'pending' then 1 else 0 end)`.mapWith(
              Number
            ),
          // 与全站 generationTotals.completedImages 同口径:优先 billableImageOutputCount,
          // 缺失时回退 storageKey 是否存在。
          producedImages:
            sql<number>`coalesce(sum(case when ${generation.status} = 'completed' then case when jsonb_typeof(${metaJson} #> '{outputImage,billableImageOutputCount}') = 'number' then (${metaJson} #>> '{outputImage,billableImageOutputCount}')::int when ${generation.storageKey} is not null then 1 else 0 end else 0 end), 0)`.mapWith(
              Number
            ),
          creditsConsumed:
            sql<number>`coalesce(sum(${generation.creditsConsumed}), 0)`.mapWith(
              Number
            ),
          avgSeconds: sql<
            string | null
          >`avg(${durationExpr}) ${completedDurationFilter}`,
          p95Seconds: sql<
            string | null
          >`percentile_disc(0.95) within group (order by ${durationExpr}) ${completedDurationFilter}`,
        })
        .from(generation)
        .where(gte(generation.createdAt, windowStart)),
      db
        .select({ error: generation.error })
        .from(generation)
        .where(
          and(
            gte(generation.createdAt, windowStart),
            eq(generation.status, "failed")
          )
        ),
      db
        .select({
          resolutionBucket: sql<string>`${resolutionBucketExpr}`,
          backendBucket: sql<string>`${backendBucketExpr}`,
          count: count(),
          avgSeconds: sql<string | null>`avg(${durationExpr})`,
          p95Seconds: sql<string | null>`percentile_disc(0.95) within group (order by ${durationExpr})`,
        })
        .from(generation)
        .where(
          and(
            gte(generation.createdAt, windowStart),
            eq(generation.status, "completed"),
            sql`${generation.completedAt} is not null`,
            sql`${backendBucketExpr} is not null`
          )
        )
        // 按 select 第 1、2 列(分辨率桶、后端桶)分组。
        .groupBy(sql`1`, sql`2`),
      db
        .select({ metadata: generation.metadata })
        .from(generation)
        .where(
          and(
            gte(generation.createdAt, windowStart),
            sql`jsonb_typeof(${metaJson} #> '{moderationPromptRepair,attempts}') = 'array'`,
            sql`jsonb_array_length(${metaJson} #> '{moderationPromptRepair,attempts}') > 0`
          )
        ),
    ]);

  const aggregate = aggregateRows[0];

  // 失败行用真实分类器分桶,口径与历史错误列表、后端调度完全一致,零额外漂移。
  let platformErrors = 0;
  let moderationErrors = 0;
  let userRequestErrors = 0;
  for (const row of failedRows) {
    const category = classifyGenerationError(row.error);
    if (category === "moderation") {
      moderationErrors += 1;
    } else if (category === "user_request") {
      userRequestErrors += 1;
    } else {
      platformErrors += 1;
    }
  }

  // 耗时分布:SQL 只回非空(分辨率, 后端)组,填进空网格。
  const durationBreakdown = emptyDurationBreakdown();
  for (const row of durationBreakdownRows) {
    if (
      !isResolutionDurationBucket(row.resolutionBucket) ||
      !isBackendDurationBucket(row.backendBucket)
    ) {
      continue;
    }
    durationBreakdown[row.resolutionBucket][row.backendBucket] = {
      count: Number(row.count) || 0,
      avgSeconds: row.avgSeconds == null ? null : Number(row.avgSeconds),
      p95Seconds: row.p95Seconds == null ? null : Number(row.p95Seconds),
    };
  }

  // 审核修剪重试:复用既有 JS 累加,口径零漂移(行集很小)。
  const moderationPromptRepair = createModerationPromptRepairStats();
  for (const row of repairRows) {
    accumulateModerationPromptRepairStats(moderationPromptRepair, row);
  }

  const completed = aggregate?.completed ?? 0;
  const failed = aggregate?.failed ?? 0;
  const pending = aggregate?.pending ?? 0;
  const finished = completed + failed;
  const platformDenominator = completed + platformErrors;
  const avgSeconds =
    aggregate?.avgSeconds == null ? null : Number(aggregate.avgSeconds);
  const p95Seconds =
    aggregate?.p95Seconds == null ? null : Number(aggregate.p95Seconds);

  return {
    total: aggregate?.total ?? 0,
    completed,
    failed,
    pending,
    producedImages: aggregate?.producedImages ?? 0,
    creditsConsumed: aggregate?.creditsConsumed ?? 0,
    successRate: finished > 0 ? completed / finished : 1,
    platformSla: platformDenominator > 0 ? completed / platformDenominator : 1,
    platformErrors,
    moderationErrors,
    userRequestErrors,
    avgSeconds,
    p95Seconds,
    durationBreakdown,
    moderationPromptRepair,
  };
}

function topErrors(rows: GenerationMetricRow[]) {
  const errorCounts = new Map<
    string,
    { count: number; category: "platform" | "moderation" | "user_request" }
  >();

  for (const row of rows) {
    if (row.status !== "failed") continue;
    const message = (row.error || "Unknown error").replace(/\s+/g, " ").trim();
    const key = message.length > 140 ? `${message.slice(0, 137)}...` : message;
    const category = classifyGenerationError(row.error);
    const current = errorCounts.get(key);
    errorCounts.set(key, {
      count: (current?.count ?? 0) + 1,
      category,
    });
  }

  return [...errorCounts.entries()]
    .map(([message, item]) => ({ message, ...item }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
}

function summarizeBackendRows(
  rows: Array<{
    status: string;
    isEnabled: boolean;
    cooldownUntil: Date | null;
    successCount: number;
    failCount: number;
    mode: string;
  }>
): BackendHealthStats {
  const now = Date.now();
  const modes = new Map<string, number>();
  const stats: BackendHealthStats = {
    total: rows.length,
    enabled: 0,
    active: 0,
    limited: 0,
    error: 0,
    cooling: 0,
    disabled: 0,
    successCount: 0,
    failCount: 0,
    modes: [],
  };

  for (const row of rows) {
    modes.set(row.mode || "unknown", (modes.get(row.mode || "unknown") ?? 0) + 1);
    stats.successCount += row.successCount || 0;
    stats.failCount += row.failCount || 0;
    if (!row.isEnabled) {
      stats.disabled += 1;
      continue;
    }
    stats.enabled += 1;
    if (row.cooldownUntil && row.cooldownUntil.getTime() > now) stats.cooling += 1;
    if (row.status === "active") stats.active += 1;
    if (row.status === "limited") stats.limited += 1;
    if (row.status === "error") stats.error += 1;
  }

  stats.modes = [...modes.entries()]
    .map(([mode, modeCount]) => ({ mode, count: modeCount }))
    .sort((a, b) => b.count - a.count);
  return stats;
}

function summarizeSchedulerMetrics(
  rows: Array<{
    selectedLayer: string;
    selectCount: number;
    stickyPreviousHitCount: number;
    stickySessionHitCount: number;
    loadBalanceCount: number;
    switchCount: number;
    candidateCountTotal: number;
    latencyMsTotal: number;
  }>
): SchedulerMetricStats {
  const byLayer = new Map<string, number>();
  const stats: SchedulerMetricStats = {
    selectCount: 0,
    stickyPreviousHits: 0,
    stickySessionHits: 0,
    stickyHitRate: 0,
    loadBalanceCount: 0,
    switchCount: 0,
    avgCandidateCount: null,
    avgLatencyMs: null,
    byLayer: [],
  };
  let candidateTotal = 0;
  let latencyTotal = 0;

  for (const row of rows) {
    stats.selectCount += row.selectCount;
    stats.stickyPreviousHits += row.stickyPreviousHitCount;
    stats.stickySessionHits += row.stickySessionHitCount;
    stats.loadBalanceCount += row.loadBalanceCount;
    stats.switchCount += row.switchCount;
    candidateTotal += row.candidateCountTotal;
    latencyTotal += row.latencyMsTotal;
    if (row.selectCount > 0) {
      byLayer.set(
        row.selectedLayer,
        (byLayer.get(row.selectedLayer) || 0) + row.selectCount
      );
    }
  }

  const stickyHits = stats.stickyPreviousHits + stats.stickySessionHits;
  stats.stickyHitRate =
    stats.selectCount > 0 ? stickyHits / stats.selectCount : 0;
  stats.avgCandidateCount =
    stats.selectCount > 0 ? candidateTotal / stats.selectCount : null;
  stats.avgLatencyMs =
    stats.selectCount > 0 ? latencyTotal / stats.selectCount : null;
  stats.byLayer = Array.from(byLayer.entries())
    .map(([layer, count]) => ({ layer, count }))
    .sort((left, right) => right.count - left.count);
  return stats;
}

// 把 video_generation 的 (family, status) 聚合行折叠为面板所需统计:
// 总数/各状态计数、成功率、完成视频积分与时长、平均生成耗时,以及按模型族明细。
// 未在 VIDEO_FAMILIES 中登记的 family(如新增/历史脏数据)归入 byFamily 末尾,
// 但仍计入顶部总数,避免漏算。
function summarizeVideoGenerationRows(
  rows: VideoAggregateRow[]
): VideoGenerationStats {
  let total = 0;
  let completed = 0;
  let failed = 0;
  let running = 0;
  let pending = 0;
  let creditsConsumed = 0;
  let totalVideoSeconds = 0;
  let latencySecondsTotal = 0;
  let latencyCount = 0;

  const familyMap = new Map<string, VideoFamilyStats>();
  for (const family of VIDEO_FAMILIES) {
    familyMap.set(family, { family, total: 0, completed: 0, failed: 0 });
  }

  for (const row of rows) {
    const rowTotal = Number(row.total) || 0;
    total += rowTotal;

    const bucket =
      familyMap.get(row.family) ??
      familyMap
        .set(row.family, {
          family: row.family,
          total: 0,
          completed: 0,
          failed: 0,
        })
        .get(row.family);
    if (bucket) bucket.total += rowTotal;

    if (row.status === "completed") {
      completed += rowTotal;
      creditsConsumed += Number(row.creditsConsumed) || 0;
      totalVideoSeconds += Number(row.videoSeconds) || 0;
      latencySecondsTotal += Number(row.latencySecondsTotal) || 0;
      latencyCount += Number(row.latencyCount) || 0;
      if (bucket) bucket.completed += rowTotal;
    } else if (row.status === "failed") {
      failed += rowTotal;
      if (bucket) bucket.failed += rowTotal;
    } else if (row.status === "running") {
      running += rowTotal;
    } else {
      pending += rowTotal;
    }
  }

  const finished = completed + failed;
  // VIDEO_FAMILIES 顺序在前,运行时新出现的 family 追加在后(保留插入顺序)。
  const byFamily = Array.from(familyMap.values());

  return {
    total,
    completed,
    failed,
    running,
    pending,
    successRate: finished > 0 ? completed / finished : 1,
    creditsConsumed,
    totalVideoSeconds,
    avgLatencySeconds:
      latencyCount > 0 ? latencySecondsTotal / latencyCount : null,
    byFamily,
  };
}

function formatDuration(seconds: number | null, locale: string) {
  if (seconds === null) return copy(locale, "No sample", "暂无样本");
  if (seconds < 60) return `${Math.round(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function formatPercent(value: number, locale: string) {
  return new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US", {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatNumber(value: number, locale: string) {
  return new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US").format(
    Math.round(value)
  );
}

function MetricCard({
  title,
  value,
  description,
  icon: Icon,
  tone = "default",
  delay = 0,
}: {
  title: string;
  value: string;
  description: string;
  icon: typeof Activity;
  tone?: "default" | "success" | "warning" | "danger";
  // 入场错峰延迟(毫秒),纯展示;配合 animationFillMode backwards 避免闪现。
  delay?: number;
}) {
  const toneClass =
    tone === "success"
      ? "text-success"
      : tone === "warning"
        ? "text-warning"
        : tone === "danger"
          ? "text-destructive"
          : "text-muted-foreground";
  // 入场动画放外层、hover 过渡放卡片:两者的 duration 工具类共享同一
  // CSS 变量,同元素叠加会互相覆盖(入场 400ms 与交互 250ms 需求不同)。
  return (
    <div
      className="animate-in fade-in slide-in-from-bottom-2 duration-400 motion-reduce:animate-none"
      style={{ animationDelay: `${delay}ms`, animationFillMode: "backwards" }}
    >
      <Card className="h-full gap-3 rounded-lg py-5 lift-hover">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-0">
          <CardTitle className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
            {title}
          </CardTitle>
          <Icon className={`h-4 w-4 ${toneClass}`} />
        </CardHeader>
        <CardContent>
          <div className="font-serif text-3xl font-medium tracking-tight">
            {value}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        </CardContent>
      </Card>
    </div>
  );
}

function SlaCard({
  title,
  description,
  stats,
  locale,
}: {
  title: string;
  description: string;
  stats: GenerationWindowStats;
  locale: string;
}) {
  return (
    <Card className="rounded-lg">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              {copy(locale, "Platform SLA", "平台 SLA")}
            </span>
            <span className="font-medium">
              {formatPercent(stats.platformSla, locale)}
            </span>
          </div>
          <Progress value={Math.round(stats.platformSla * 100)} />
        </div>
        <div className="grid gap-3 text-sm sm:grid-cols-3">
          <MiniStat
            label={copy(locale, "Success rate", "生图成功率")}
            value={formatPercent(stats.successRate, locale)}
          />
          <MiniStat
            label={copy(locale, "Produced images", "产出图片")}
            value={formatNumber(stats.producedImages, locale)}
          />
          <MiniStat
            label={copy(locale, "P95 duration", "P95 耗时")}
            value={formatDuration(stats.p95Seconds, locale)}
          />
        </div>
        <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
          <span>
            {copy(locale, "Completed", "完成")} {stats.completed}
          </span>
          <span>
            {copy(locale, "Platform errors", "平台错误")} {stats.platformErrors}
          </span>
          <span>
            {copy(locale, "Pending", "处理中")} {stats.pending}
          </span>
          <span>
            {copy(locale, "Moderation blocks", "审核拦截")}{" "}
            {stats.moderationErrors}
          </span>
          <span>
            {copy(locale, "User request errors", "用户请求错误")}{" "}
            {stats.userRequestErrors}
          </span>
          <span>
            {copy(locale, "Avg duration", "平均耗时")}{" "}
            {formatDuration(stats.avgSeconds, locale)}
          </span>
        </div>
        <div className="rounded-md border bg-muted/20 p-3 text-xs">
          <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="font-medium text-foreground">
              {copy(locale, "Prompt repair retries", "审核修剪重试")}
            </span>
            <span className="text-muted-foreground">
              {copy(locale, "Attempts", "尝试")}{" "}
              {stats.moderationPromptRepair.attempted}
            </span>
            <span className="text-muted-foreground">
              {copy(locale, "Succeeded", "成功")}{" "}
              {stats.moderationPromptRepair.succeeded}
            </span>
            <span className="text-muted-foreground">
              {copy(locale, "Failed", "失败")}{" "}
              {stats.moderationPromptRepair.failed}
            </span>
          </div>
          <div className="flex flex-wrap gap-2 text-muted-foreground">
            {stats.moderationPromptRepair.byAttempt.length > 0 ? (
              stats.moderationPromptRepair.byAttempt.map((item) => (
                <span key={item.attempt}>
                  #{item.attempt}: {item.attempted}/{item.succeeded}/
                  {item.failed}
                </span>
              ))
            ) : (
              <span>
                {copy(
                  locale,
                  "No prompt repair retries in the selected range.",
                  "当前范围暂无审核修剪重试。"
                )}
              </span>
            )}
          </div>
        </div>
        <DurationBreakdownTable
          breakdown={stats.durationBreakdown}
          locale={locale}
        />
      </CardContent>
    </Card>
  );
}

function resolutionDurationLabel(
  bucket: ResolutionDurationBucket,
  locale: string
) {
  if (bucket === "custom") return copy(locale, "Custom", "自定义");
  return bucket.toUpperCase();
}

function backendDurationLabel(bucket: BackendDurationBucket) {
  if (bucket === "web") return "Web";
  if (bucket === "images") return "Images";
  if (bucket === "adobe") return "Adobe";
  return "Codex";
}

function isDurationBucketApplicable(
  resolutionBucket: ResolutionDurationBucket,
  backendBucket: BackendDurationBucket
) {
  // Web 仅 1K(统一计入 1K);Codex/Images 走真实分辨率,各档都适用。
  return backendBucket !== "web" || resolutionBucket === "1k";
}

function DurationBucketCell({
  stats,
  locale,
  applicable = true,
}: {
  stats: DurationBucketStats;
  locale: string;
  applicable?: boolean;
}) {
  if (!applicable) {
    return (
      <span className="text-xs text-muted-foreground">
        {copy(locale, "N/A", "不适用")}
      </span>
    );
  }

  if (stats.count === 0) {
    return (
      <span className="text-xs text-muted-foreground">
        {copy(locale, "No sample", "暂无样本")}
      </span>
    );
  }

  return (
    <div className="space-y-0.5">
      <div className="font-medium">
        P95 {formatDuration(stats.p95Seconds, locale)}
      </div>
      <div className="text-[11px] text-muted-foreground">
        {copy(locale, "Avg", "平均")} {formatDuration(stats.avgSeconds, locale)}
        {" · n="}
        {formatNumber(stats.count, locale)}
      </div>
    </div>
  );
}

function DurationBreakdownTable({
  breakdown,
  locale,
}: {
  breakdown: DurationBreakdown;
  locale: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">
          {copy(locale, "Duration by size and backend", "按分辨率和后端耗时")}
        </span>
        <span className="text-xs text-muted-foreground">
          {copy(
            locale,
            "Completed only. Web is counted as 1K.",
            "仅统计完成记录；Web 统一计入 1K。"
          )}
        </span>
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[420px] text-left text-xs">
          <thead className="border-b border-border/60 text-[11px] uppercase tracking-widest text-muted-foreground">
            <tr>
              <th className="w-24 px-3 py-2 font-medium">
                {copy(locale, "Size", "分辨率")}
              </th>
              {BACKEND_DURATION_BUCKETS.map((backend) => (
                <th key={backend} className="px-3 py-2 font-medium">
                  {backendDurationLabel(backend)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {RESOLUTION_DURATION_BUCKETS.map((bucket) => (
              <tr
                key={bucket}
                className="transition-colors duration-150 hover:bg-muted/50"
              >
                <td className="px-3 py-2 font-medium">
                  {resolutionDurationLabel(bucket, locale)}
                </td>
                {BACKEND_DURATION_BUCKETS.map((backend) => (
                  <td key={backend} className="px-3 py-2 align-top">
                    <DurationBucketCell
                      stats={breakdown[bucket][backend]}
                      locale={locale}
                      applicable={isDurationBucketApplicable(bucket, backend)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-muted/20 p-3 transition-colors duration-150 hover:border-foreground/20">
      <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 font-serif text-lg font-medium tracking-tight">
        {value}
      </div>
    </div>
  );
}

async function loadHistoricalGenerationErrors(
  filters: HistoricalErrorFilters
) {
  const where = buildHistoricalErrorWhere(filters);
  const offset = (filters.page - 1) * ERROR_PAGE_SIZE;

  const [rows, totalRows] = await Promise.all([
    db
      .select({
        id: generation.id,
        userId: generation.userId,
        userEmail: user.email,
        userName: user.name,
        prompt: generation.prompt,
        model: generation.model,
        size: generation.size,
        creditsConsumed: generation.creditsConsumed,
        error: generation.error,
        createdAt: generation.createdAt,
        completedAt: generation.completedAt,
      })
      .from(generation)
      .leftJoin(user, eq(user.id, generation.userId))
      .where(where)
      .orderBy(desc(generation.createdAt))
      .limit(ERROR_PAGE_SIZE)
      .offset(offset),
    db.select({ total: count() }).from(generation).where(where),
  ]);

  const items: HistoricalGenerationErrorRow[] = rows.map((row) => ({
    ...row,
    category: classifyGenerationError(row.error),
  }));

  return {
    items,
    total: totalRows[0]?.total ?? 0,
    page: filters.page,
    pageSize: ERROR_PAGE_SIZE,
  };
}

function errorCategoryLabel(
  category: HistoricalGenerationErrorRow["category"],
  locale: string
) {
  if (category === "moderation") return copy(locale, "Moderation", "审核");
  if (category === "user_request") {
    return copy(locale, "User request", "用户请求");
  }
  return copy(locale, "Platform", "平台");
}

function describeErrorFilter(
  filters: HistoricalErrorFilters,
  locale: string,
  timeZone: string
) {
  if (filters.range === "all") return copy(locale, "All history", "全部历史");
  if (filters.range === "custom") {
    const from = filters.fromDate
      ? formatDateInput(filters.fromDate, timeZone)
      : copy(locale, "Unbounded", "不限");
    const to = filters.toDate
      ? formatDateInput(filters.toDate, timeZone)
      : copy(locale, "Unbounded", "不限");
    return `${copy(locale, "Custom", "自定义")}：${from} - ${to}`;
  }
  if (filters.range === "24h") return copy(locale, "Last 24 hours", "最近24小时");
  if (filters.range === "30d") return copy(locale, "Last 30 days", "最近30天");
  if (filters.range === "90d") return copy(locale, "Last 90 days", "最近90天");
  return copy(locale, "Last 7 days", "最近7天");
}

function HistoricalErrorsCard({
  errors,
  filters,
  locale,
  timeZone,
}: {
  errors: Awaited<ReturnType<typeof loadHistoricalGenerationErrors>>;
  filters: HistoricalErrorFilters;
  locale: string;
  timeZone: string;
}) {
  const totalPages = Math.max(1, Math.ceil(errors.total / errors.pageSize));
  const page = Math.min(errors.page, totalPages);
  const hasPrevious = errors.page > 1;
  const hasNext = errors.page < totalPages;

  return (
    <Card id="historical-errors" className="rounded-lg">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-warning" />
          {copy(locale, "Historical Error Records", "历史错误记录")}
        </CardTitle>
        <CardDescription>
          {copy(
            locale,
            "All failed generation records with time filters and pagination.",
            "所有失败的生成记录，支持按时间筛选和分页查看。"
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form className="grid gap-3 rounded-md border bg-muted/20 p-3 md:grid-cols-[160px_180px_180px_auto] md:items-end">
          <label className="grid gap-1 text-sm">
            <span className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
              {copy(locale, "Range", "时间范围")}
            </span>
            <select
              name="errorRange"
              defaultValue={filters.range}
              className="h-9 rounded-md border bg-background px-3 text-sm outline-none transition-colors duration-150 focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
            >
              <option value="24h">{copy(locale, "Last 24 hours", "最近24小时")}</option>
              <option value="7d">{copy(locale, "Last 7 days", "最近7天")}</option>
              <option value="30d">{copy(locale, "Last 30 days", "最近30天")}</option>
              <option value="90d">{copy(locale, "Last 90 days", "最近90天")}</option>
              <option value="all">{copy(locale, "All history", "全部历史")}</option>
              <option value="custom">{copy(locale, "Custom", "自定义")}</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
              {copy(locale, "From", "开始日期")}
            </span>
            <input
              type="date"
              name="errorFrom"
              defaultValue={filters.fromInput}
              className="h-9 rounded-md border bg-background px-3 text-sm outline-none transition-colors duration-150 focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
              {copy(locale, "To", "结束日期")}
            </span>
            <input
              type="date"
              name="errorTo"
              defaultValue={filters.toInput}
              className="h-9 rounded-md border bg-background px-3 text-sm outline-none transition-colors duration-150 focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
            />
          </label>
          <Button type="submit" className="md:w-fit">
            {copy(locale, "Filter", "筛选")}
          </Button>
          <p className="text-xs text-muted-foreground md:col-span-4">
            {copy(
              locale,
              "Date inputs are applied when the range is Custom. Fixed ranges ignore manual dates.",
              "日期输入仅在选择自定义时生效；固定时间范围会忽略手动日期。"
            )}
          </p>
        </form>

        <div className="flex flex-col gap-2 text-sm text-muted-foreground md:flex-row md:items-center md:justify-between">
          <div>
            {describeErrorFilter(filters, locale, timeZone)} ·{" "}
            {copy(locale, "Total", "共")} {formatNumber(errors.total, locale)}{" "}
            {copy(locale, "records", "条")}
          </div>
          <div>
            {copy(locale, "Page", "第")} {formatNumber(page, locale)} /{" "}
            {formatNumber(totalPages, locale)} {copy(locale, "page", "页")}
          </div>
        </div>

        {errors.items.length === 0 ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {copy(locale, "No failed records in this range.", "该时间范围内没有失败记录。")}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[960px] text-left text-sm">
              <thead className="border-b border-border/60 text-[11px] uppercase tracking-widest text-muted-foreground">
                <tr>
                  <th className="w-[210px] px-3 py-2 font-medium">
                    {copy(locale, "Time", "时间")}
                  </th>
                  <th className="w-[140px] px-3 py-2 font-medium">
                    {copy(locale, "Category", "类型")}
                  </th>
                  <th className="w-[220px] px-3 py-2 font-medium">
                    {copy(locale, "User", "用户")}
                  </th>
                  <th className="w-[170px] px-3 py-2 font-medium">
                    {copy(locale, "Request", "请求")}
                  </th>
                  <th className="px-3 py-2 font-medium">
                    {copy(locale, "Error", "错误")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {errors.items.map((item) => {
                  const userDisplay =
                    item.userEmail || item.userName || item.userId || "-";
                  const prompt = truncateText(item.prompt, 180);
                  const message = item.error || "Unknown error";

                  return (
                    <tr
                      key={item.id}
                      className="align-top transition-colors duration-150 hover:bg-muted/50"
                    >
                      <td className="px-3 py-3">
                        <div className="font-medium">
                          {formatDateTime(item.createdAt, locale, timeZone)}
                        </div>
                        {item.completedAt && (
                          <div className="mt-1 text-xs text-muted-foreground">
                            {copy(locale, "Completed", "结束")}{" "}
                            {formatDateTime(
                              item.completedAt,
                              locale,
                              timeZone
                            )}
                          </div>
                        )}
                        <div className="mt-1 break-all text-xs text-muted-foreground">
                          {item.id}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <Badge
                          variant={
                            item.category === "platform"
                              ? "destructive"
                              : item.category === "moderation"
                                ? "secondary"
                                : "outline"
                          }
                          className="w-fit"
                        >
                          {errorCategoryLabel(item.category, locale)}
                        </Badge>
                      </td>
                      <td className="px-3 py-3">
                        <div className="break-all font-medium">{userDisplay}</div>
                        {userDisplay !== item.userId && (
                          <div className="mt-1 break-all text-xs text-muted-foreground">
                            {item.userId}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <div className="font-medium">{item.model || "-"}</div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {item.size || "-"} · {formatCredits(item.creditsConsumed)}
                        </div>
                        {prompt && (
                          <div className="mt-2 break-words text-xs text-muted-foreground">
                            {prompt}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <div className="whitespace-pre-wrap break-words text-muted-foreground">
                          {message}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          {hasPrevious ? (
            <Button asChild variant="outline" size="sm">
              <a href={buildErrorPageHref(filters, errors.page - 1)}>
                {copy(locale, "Previous", "上一页")}
              </a>
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled>
              {copy(locale, "Previous", "上一页")}
            </Button>
          )}
          {hasNext ? (
            <Button asChild variant="outline" size="sm">
              <a href={buildErrorPageHref(filters, errors.page + 1)}>
                {copy(locale, "Next", "下一页")}
              </a>
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled>
              {copy(locale, "Next", "下一页")}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

async function loadStatusData() {
  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [
    recentGenerationRows,
    generationTotals,
    creditBalanceRows,
    creditLedger24h,
    creditLedger7d,
    creditBatchRows,
    userRows,
    ticketRows,
    accountRows,
    apiRows,
    adobeRows,
    schedulerRows24h,
    schedulerRows7d,
    videoRows7d,
  ] = await Promise.all([
    db
      .select({
        status: generation.status,
        error: generation.error,
        creditsConsumed: generation.creditsConsumed,
        storageKey: generation.storageKey,
        size: generation.size,
        createdAt: generation.createdAt,
        completedAt: generation.completedAt,
        metadata: generation.metadata,
      })
      .from(generation)
      .where(gte(generation.createdAt, last7d))
      .orderBy(desc(generation.createdAt))
      .limit(10000),
    db
      .select({
        total: count(),
        completed:
          sql<number>`sum(case when ${generation.status} = 'completed' then 1 else 0 end)`.mapWith(
            Number
          ),
        failed:
          sql<number>`sum(case when ${generation.status} = 'failed' then 1 else 0 end)`.mapWith(
            Number
          ),
        pending:
          sql<number>`sum(case when ${generation.status} = 'pending' then 1 else 0 end)`.mapWith(
            Number
          ),
        completedImages:
          sql<number>`coalesce(sum(case when ${generation.status} = 'completed' then case when jsonb_typeof(${generation.metadata}::jsonb #> '{outputImage,billableImageOutputCount}') = 'number' then (${generation.metadata}::jsonb #>> '{outputImage,billableImageOutputCount}')::int when ${generation.storageKey} is not null then 1 else 0 end else 0 end), 0)`.mapWith(
            Number
          ),
        creditsConsumed:
          sql<number>`coalesce(sum(${generation.creditsConsumed}), 0)`.mapWith(
            Number
          ),
      })
      .from(generation),
    db
      .select({
        totalBalance: sql<number>`coalesce(sum(${creditsBalance.balance}), 0)`.mapWith(
          Number
        ),
        totalEarned:
          sql<number>`coalesce(sum(${creditsBalance.totalEarned}), 0)`.mapWith(
            Number
          ),
        totalSpent:
          sql<number>`coalesce(sum(${creditsBalance.totalSpent}), 0)`.mapWith(
            Number
          ),
        frozen:
          sql<number>`sum(case when ${creditsBalance.status} = 'frozen' then 1 else 0 end)`.mapWith(
            Number
          ),
      })
      .from(creditsBalance),
    db
      .select({
        consumption:
          sql<number>`coalesce(sum(case when ${creditsTransaction.type} = 'consumption' then ${creditsTransaction.amount} else 0 end), 0)`.mapWith(
            Number
          ),
        refund:
          sql<number>`coalesce(sum(case when ${creditsTransaction.type} = 'refund' then ${creditsTransaction.amount} else 0 end), 0)`.mapWith(
            Number
          ),
        expiration:
          sql<number>`coalesce(sum(case when ${creditsTransaction.type} = 'expiration' then ${creditsTransaction.amount} else 0 end), 0)`.mapWith(
            Number
          ),
        grants:
          sql<number>`coalesce(sum(case when ${creditsTransaction.type} in ('monthly_grant', 'registration_bonus', 'admin_grant', 'purchase') then ${creditsTransaction.amount} else 0 end), 0)`.mapWith(
            Number
          ),
      })
      .from(creditsTransaction)
      .where(gte(creditsTransaction.createdAt, last24h)),
    db
      .select({
        consumption:
          sql<number>`coalesce(sum(case when ${creditsTransaction.type} = 'consumption' then ${creditsTransaction.amount} else 0 end), 0)`.mapWith(
            Number
          ),
        refund:
          sql<number>`coalesce(sum(case when ${creditsTransaction.type} = 'refund' then ${creditsTransaction.amount} else 0 end), 0)`.mapWith(
            Number
          ),
        expiration:
          sql<number>`coalesce(sum(case when ${creditsTransaction.type} = 'expiration' then ${creditsTransaction.amount} else 0 end), 0)`.mapWith(
            Number
          ),
        grants:
          sql<number>`coalesce(sum(case when ${creditsTransaction.type} in ('monthly_grant', 'registration_bonus', 'admin_grant', 'purchase') then ${creditsTransaction.amount} else 0 end), 0)`.mapWith(
            Number
          ),
      })
      .from(creditsTransaction)
      .where(gte(creditsTransaction.createdAt, last7d)),
    db
      .select({
        activeRemaining:
          sql<number>`coalesce(sum(case when ${creditsBatch.status} = 'active' then ${creditsBatch.remaining} else 0 end), 0)`.mapWith(
            Number
          ),
        consumedAmount:
          sql<number>`coalesce(sum(case when ${creditsBatch.status} = 'consumed' then ${creditsBatch.amount} else 0 end), 0)`.mapWith(
            Number
          ),
        expiredAmount:
          sql<number>`coalesce(sum(case when ${creditsBatch.status} = 'expired' then ${creditsBatch.remaining} else 0 end), 0)`.mapWith(
            Number
          ),
      })
      .from(creditsBatch),
    db
      .select({
        total: count(),
        new24h:
          sql<number>`sum(case when ${user.createdAt} >= ${last24h} then 1 else 0 end)`.mapWith(
            Number
          ),
        new7d:
          sql<number>`sum(case when ${user.createdAt} >= ${last7d} then 1 else 0 end)`.mapWith(
            Number
          ),
        banned:
          sql<number>`sum(case when ${user.banned} = true then 1 else 0 end)`.mapWith(
            Number
          ),
        observers:
          sql<number>`sum(case when ${user.role} = 'observer_admin' then 1 else 0 end)`.mapWith(
            Number
          ),
        admins:
          sql<number>`sum(case when ${user.role} = 'admin' then 1 else 0 end)`.mapWith(
            Number
          ),
        superAdmins:
          sql<number>`sum(case when ${user.role} = 'super_admin' then 1 else 0 end)`.mapWith(
            Number
          ),
      })
      .from(user),
    db
      .select({
        open:
          sql<number>`sum(case when ${ticket.status} = 'open' then 1 else 0 end)`.mapWith(
            Number
          ),
        inProgress:
          sql<number>`sum(case when ${ticket.status} = 'in_progress' then 1 else 0 end)`.mapWith(
            Number
          ),
        unresolved:
          sql<number>`sum(case when ${ticket.status} in ('open', 'in_progress') then 1 else 0 end)`.mapWith(
            Number
          ),
        new24h:
          sql<number>`sum(case when ${ticket.createdAt} >= ${last24h} then 1 else 0 end)`.mapWith(
            Number
          ),
      })
      .from(ticket),
    db
      .select({
        status: imageBackendAccount.status,
        isEnabled: imageBackendAccount.isEnabled,
        cooldownUntil: imageBackendAccount.cooldownUntil,
        successCount: imageBackendAccount.successCount,
        failCount: imageBackendAccount.failCount,
        mode: imageBackendAccount.implementationMode,
      })
      .from(imageBackendAccount),
    db
      .select({
        status: imageBackendApi.status,
        isEnabled: imageBackendApi.isEnabled,
        cooldownUntil: imageBackendApi.cooldownUntil,
        successCount: imageBackendApi.successCount,
        failCount: imageBackendApi.failCount,
        mode: imageBackendApi.interfaceMode,
      })
      .from(imageBackendApi),
    db
      .select({
        status: imageBackendAdobe.status,
        isEnabled: imageBackendAdobe.isEnabled,
        cooldownUntil: imageBackendAdobe.cooldownUntil,
        successCount: imageBackendAdobe.successCount,
        failCount: imageBackendAdobe.failCount,
        mode: imageBackendAdobe.mode,
      })
      .from(imageBackendAdobe),
    db
      .select({
        selectedLayer: imageBackendSchedulerMetric.selectedLayer,
        selectCount:
          sql<number>`coalesce(sum(${imageBackendSchedulerMetric.selectCount}), 0)`.mapWith(
            Number
          ),
        stickyPreviousHitCount:
          sql<number>`coalesce(sum(${imageBackendSchedulerMetric.stickyPreviousHitCount}), 0)`.mapWith(
            Number
          ),
        stickySessionHitCount:
          sql<number>`coalesce(sum(${imageBackendSchedulerMetric.stickySessionHitCount}), 0)`.mapWith(
            Number
          ),
        loadBalanceCount:
          sql<number>`coalesce(sum(${imageBackendSchedulerMetric.loadBalanceCount}), 0)`.mapWith(
            Number
          ),
        switchCount:
          sql<number>`coalesce(sum(${imageBackendSchedulerMetric.switchCount}), 0)`.mapWith(
            Number
          ),
        candidateCountTotal:
          sql<number>`coalesce(sum(${imageBackendSchedulerMetric.candidateCountTotal}), 0)`.mapWith(
            Number
          ),
        latencyMsTotal:
          sql<number>`coalesce(sum(${imageBackendSchedulerMetric.latencyMsTotal}), 0)`.mapWith(
            Number
          ),
      })
      .from(imageBackendSchedulerMetric)
      .where(gte(imageBackendSchedulerMetric.bucketStartedAt, last24h))
      .groupBy(imageBackendSchedulerMetric.selectedLayer),
    db
      .select({
        selectedLayer: imageBackendSchedulerMetric.selectedLayer,
        selectCount:
          sql<number>`coalesce(sum(${imageBackendSchedulerMetric.selectCount}), 0)`.mapWith(
            Number
          ),
        stickyPreviousHitCount:
          sql<number>`coalesce(sum(${imageBackendSchedulerMetric.stickyPreviousHitCount}), 0)`.mapWith(
            Number
          ),
        stickySessionHitCount:
          sql<number>`coalesce(sum(${imageBackendSchedulerMetric.stickySessionHitCount}), 0)`.mapWith(
            Number
          ),
        loadBalanceCount:
          sql<number>`coalesce(sum(${imageBackendSchedulerMetric.loadBalanceCount}), 0)`.mapWith(
            Number
          ),
        switchCount:
          sql<number>`coalesce(sum(${imageBackendSchedulerMetric.switchCount}), 0)`.mapWith(
            Number
          ),
        candidateCountTotal:
          sql<number>`coalesce(sum(${imageBackendSchedulerMetric.candidateCountTotal}), 0)`.mapWith(
            Number
          ),
        latencyMsTotal:
          sql<number>`coalesce(sum(${imageBackendSchedulerMetric.latencyMsTotal}), 0)`.mapWith(
            Number
          ),
      })
      .from(imageBackendSchedulerMetric)
      .where(gte(imageBackendSchedulerMetric.bucketStartedAt, last7d))
      .groupBy(imageBackendSchedulerMetric.selectedLayer),
    // 视频生成(Adobe Firefly)独立管线,与 generation 无关。按 (family, status) 分组,
    // 与近期 SLA 一致取最近 7 天窗口(createdAt >= last7d)。
    // 积分/时长/耗时仅对完成记录(completed)累加;latencyCount 用于计算平均生成耗时。
    db
      .select({
        family: videoGeneration.family,
        status: videoGeneration.status,
        total: count(),
        creditsConsumed:
          sql<number>`coalesce(sum(case when ${videoGeneration.status} = 'completed' then ${videoGeneration.creditsConsumed} else 0 end), 0)`.mapWith(
            Number
          ),
        videoSeconds:
          sql<number>`coalesce(sum(case when ${videoGeneration.status} = 'completed' then ${videoGeneration.durationSeconds} else 0 end), 0)`.mapWith(
            Number
          ),
        latencySecondsTotal:
          sql<number>`coalesce(sum(case when ${videoGeneration.status} = 'completed' and ${videoGeneration.completedAt} is not null then extract(epoch from (${videoGeneration.completedAt} - ${videoGeneration.createdAt})) else 0 end), 0)`.mapWith(
            Number
          ),
        latencyCount:
          sql<number>`coalesce(sum(case when ${videoGeneration.status} = 'completed' and ${videoGeneration.completedAt} is not null then 1 else 0 end), 0)`.mapWith(
            Number
          ),
      })
      .from(videoGeneration)
      .where(gte(videoGeneration.createdAt, last7d))
      .groupBy(videoGeneration.family, videoGeneration.status),
  ]);

  // recentGenerationRows(带帽 10000 行)现仅用于 topErrors 列表与 rowsTruncated 旗标;
  // SLA 全部展示字段已由 loadGenerationWindowStats 按窗口用聚合 SQL 精确算,不受帽子限制。
  const sample7d = recentGenerationRows satisfies GenerationMetricRow[];
  const sample24h = sample7d.filter((row) => row.createdAt >= last24h);
  // 仅表示 topErrors 样本触顶,SLA 各窗口数值已不受其影响。
  const rowsTruncated = sample7d.length >= 10000;
  const [stats24h, stats7d] = await Promise.all([
    loadGenerationWindowStats(last24h),
    loadGenerationWindowStats(last7d),
  ]);

  return {
    // 全局状态对所有 admin 相同、且被 unstable_cache 缓存,序列化要求 now 为字符串
    // (缓存命中后会是 ISO 字符串);此处统一返回 ISO,展示侧再 new Date 还原。
    now: now.toISOString(),
    stats24h,
    stats7d,
    // 当 last7d 行数触达 limit(10000) 时为 true,表示统计为近似值
    rowsTruncated,
    topErrors24h: topErrors(sample24h),
    generationTotals: generationTotals[0] ?? {
      total: 0,
      completed: 0,
      failed: 0,
      pending: 0,
      completedImages: 0,
      creditsConsumed: 0,
    },
    credits: {
      balance: creditBalanceRows[0] ?? {
        totalBalance: 0,
        totalEarned: 0,
        totalSpent: 0,
        frozen: 0,
      },
      ledger24h: creditLedger24h[0] ?? {
        consumption: 0,
        refund: 0,
        expiration: 0,
        grants: 0,
      },
      ledger7d: creditLedger7d[0] ?? {
        consumption: 0,
        refund: 0,
        expiration: 0,
        grants: 0,
      },
      batches: creditBatchRows[0] ?? {
        activeRemaining: 0,
        consumedAmount: 0,
        expiredAmount: 0,
      },
    },
    users: userRows[0] ?? {
      total: 0,
      new24h: 0,
      new7d: 0,
      banned: 0,
      observers: 0,
      admins: 0,
      superAdmins: 0,
    },
    tickets: ticketRows[0] ?? {
      open: 0,
      inProgress: 0,
      unresolved: 0,
      new24h: 0,
    },
    accounts: summarizeBackendRows(accountRows),
    apis: summarizeBackendRows(apiRows),
    adobe: summarizeBackendRows(adobeRows),
    scheduler24h: summarizeSchedulerMetrics(schedulerRows24h),
    scheduler7d: summarizeSchedulerMetrics(schedulerRows7d),
    video7d: summarizeVideoGenerationRows(videoRows7d),
  };
}

// 全局状态聚合较重(全表 generation 聚合含逐行 jsonb 解析);last7d 查询已加
// .limit(10000) 防止无限内存增长,高峰期统计为近似值(rowsTruncated=true)。
// 对所有 admin 相同、不依赖 searchParams、只需准实时。
// 用 unstable_cache 缓存其结果(小聚合对象),120s 内重复打开秒开,后台按需重算。
// 页面仍 force-dynamic(逐请求渲染),数据缓存与整页缓存相互独立。
const getCachedStatusData = unstable_cache(
  loadStatusData,
  ["admin-global-status"],
  { revalidate: 120, tags: [GLOBAL_STATUS_CACHE_TAG] }
);

export default async function GlobalStatusPage({
  searchParams,
}: GlobalStatusPageProps) {
  const session = await getServerSession();
  const locale = await getLocale();
  if (!session?.user) {
    redirect(`/${locale}/sign-in`);
  }

  const role = await getUserRoleById(session.user.id);
  if (!canViewImageBackendPool(role)) {
    redirect(`/${locale}/dashboard`);
  }

  const [params, timeZone] = await Promise.all([
    searchParams,
    getAppTimeZone(),
  ]);
  const errorFilters = parseHistoricalErrorFilters(params, timeZone);
  const [data, historicalErrors] = await Promise.all([
    getCachedStatusData(),
    loadHistoricalGenerationErrors(errorFilters),
  ]);
  const generationTotals = data.generationTotals;
  const creditBalance = data.credits.balance;
  const backendTotal =
    data.accounts.total + data.apis.total + data.adobe.total;
  const backendCooling =
    data.accounts.cooling + data.apis.cooling + data.adobe.cooling;
  const backendErrors =
    data.accounts.error + data.apis.error + data.adobe.error;

  return (
    <div className="container mx-auto space-y-8 px-4 py-6 md:px-6">
      <div className="flex flex-col gap-3 animate-in fade-in slide-in-from-bottom-2 duration-400 motion-reduce:animate-none md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="font-serif text-2xl font-medium tracking-tight">
            {copy(locale, "Global Status", "全局状态")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {copy(
              locale,
              "Read-only operational overview for image generation, credits, users, and backend health.",
              "只读运营总览：生图、积分、用户与后端池健康状态。"
            )}
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center">
          <RefreshStatusButton
            label={copy(locale, "Refresh", "刷新")}
            refreshingLabel={copy(locale, "Refreshing", "刷新中")}
            errorLabel={copy(locale, "Refresh failed", "刷新失败")}
          />
          <Badge variant="outline" className="w-fit">
            {copy(locale, "Updated", "更新时间")}{" "}
            {formatDateTime(new Date(data.now), locale, timeZone)}
          </Badge>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          title={copy(locale, "24h Platform SLA", "24小时平台 SLA")}
          value={formatPercent(data.stats24h.platformSla, locale)}
          description={copy(
            locale,
            "Completed / completed plus platform errors",
            "完成数 / 完成数 + 平台错误"
          )}
          icon={Activity}
          tone={data.stats24h.platformSla >= 0.95 ? "success" : "warning"}
          delay={0}
        />
        <MetricCard
          title={copy(locale, "24h Images", "24小时产出图片")}
          value={formatNumber(data.stats24h.producedImages, locale)}
          description={`${formatNumber(data.stats24h.completed, locale)} ${copy(
            locale,
            "completed generation records",
            "条完成记录"
          )}`}
          icon={ImageIcon}
          tone="success"
          delay={60}
        />
        <MetricCard
          title={copy(locale, "Credit Consumption 24h", "24小时积分消耗")}
          value={formatCredits(data.credits.ledger24h.consumption)}
          description={`${copy(locale, "Refund", "退款")} ${formatCredits(
            data.credits.ledger24h.refund
          )} · ${copy(locale, "Expired", "过期核销")} ${formatCredits(
            data.credits.ledger24h.expiration
          )}`}
          icon={Coins}
          delay={120}
        />
        <MetricCard
          title={copy(locale, "Backend Health", "后端池健康")}
          value={`${formatNumber(backendCooling, locale)} ${copy(
            locale,
            "cooling",
            "冷却中"
          )}`}
          description={`${formatNumber(backendTotal, locale)} ${copy(
            locale,
            "members",
            "成员"
          )} · ${formatNumber(backendErrors, locale)} ${copy(
            locale,
            "errors",
            "错误"
          )}`}
          icon={Server}
          tone={backendErrors > 0 || backendCooling > 0 ? "warning" : "success"}
          delay={180}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <SlaCard
          title={copy(locale, "Recent SLA: last 24 hours", "最近 SLA：24 小时")}
          description={copy(
            locale,
            "SLA excludes moderation blocks and user request errors from the platform denominator.",
            "SLA 分母不包含审核拦截和用户请求错误，只看平台侧可用性。"
          )}
          stats={data.stats24h}
          locale={locale}
        />
        <SlaCard
          title={copy(locale, "Recent SLA: last 7 days", "最近 SLA：7 天")}
          description={copy(
            locale,
            "Use this window to spot sustained backend or upstream instability.",
            "用于观察持续性的后端或上游波动。"
          )}
          stats={data.stats7d}
          locale={locale}
        />
      </div>

      <Card className="rounded-lg">
        <CardHeader>
          <CardTitle>{copy(locale, "Scheduler Routing", "调度路由")}</CardTitle>
          <CardDescription>
            {copy(
              locale,
              "Sticky routing, backend switches, and scheduler latency. Full backend queues are not used; saturated accounts are skipped.",
              "粘性路由、后端切换和调度耗时。账号满不排队，会跳过并切换其他账号。"
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <MiniStat
            label={copy(locale, "24h sticky hit rate", "24小时粘性命中率")}
            value={formatPercent(data.scheduler24h.stickyHitRate, locale)}
          />
          <MiniStat
            label={copy(locale, "24h backend switches", "24小时后端切换")}
            value={formatNumber(data.scheduler24h.switchCount, locale)}
          />
          <MiniStat
            label={copy(locale, "24h avg candidates", "24小时平均候选")}
            value={
              data.scheduler24h.avgCandidateCount === null
                ? copy(locale, "No sample", "暂无样本")
                : formatNumber(data.scheduler24h.avgCandidateCount, locale)
            }
          />
          <MiniStat
            label={copy(locale, "24h avg routing latency", "24小时平均调度耗时")}
            value={
              data.scheduler24h.avgLatencyMs === null
                ? copy(locale, "No sample", "暂无样本")
                : `${Math.round(data.scheduler24h.avgLatencyMs)}ms`
            }
          />
          <MiniStat
            label={copy(locale, "7d previous-response hits", "7天强粘性命中")}
            value={formatNumber(data.scheduler7d.stickyPreviousHits, locale)}
          />
          <MiniStat
            label={copy(locale, "7d session hits", "7天弱粘性命中")}
            value={formatNumber(data.scheduler7d.stickySessionHits, locale)}
          />
          <MiniStat
            label={copy(locale, "7d load-balance picks", "7天负载选择")}
            value={formatNumber(data.scheduler7d.loadBalanceCount, locale)}
          />
          <MiniStat
            label={copy(locale, "7d selections", "7天调度次数")}
            value={formatNumber(data.scheduler7d.selectCount, locale)}
          />
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="rounded-lg xl:col-span-2">
          <CardHeader>
            <CardTitle>{copy(locale, "Image Generation", "生图总览")}</CardTitle>
            <CardDescription>
              {copy(locale, "All-time records and recent production output.", "累计记录和近期产出。")}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MiniStat
              label={copy(locale, "Total records", "累计记录")}
              value={formatNumber(generationTotals.total, locale)}
            />
            <MiniStat
              label={copy(locale, "Completed records", "完成记录")}
              value={formatNumber(generationTotals.completed, locale)}
            />
            <MiniStat
              label={copy(locale, "Completed images", "累计完成图片")}
              value={formatNumber(generationTotals.completedImages, locale)}
            />
            <MiniStat
              label={copy(locale, "Pending records", "处理中")}
              value={formatNumber(generationTotals.pending, locale)}
            />
            <MiniStat
              label={copy(locale, "Failed records", "失败记录")}
              value={formatNumber(generationTotals.failed, locale)}
            />
            <MiniStat
              label={copy(locale, "7d image output", "7天图片产出")}
              value={formatNumber(data.stats7d.producedImages, locale)}
            />
            <MiniStat
              label={copy(locale, "7d credits on records", "7天记录积分")}
              value={formatCredits(data.stats7d.creditsConsumed)}
            />
            <MiniStat
              label={copy(locale, "All-time record credits", "累计记录积分")}
              value={formatCredits(generationTotals.creditsConsumed)}
            />
          </CardContent>
        </Card>

        <Card className="rounded-lg">
          <CardHeader>
            <CardTitle>{copy(locale, "Users & Support", "用户与工单")}</CardTitle>
            <CardDescription>
              {copy(locale, "Account growth and unresolved ticket pressure.", "账号增长和未处理工单压力。")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <MiniStat
              label={copy(locale, "Total users", "用户总数")}
              value={formatNumber(data.users.total, locale)}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <MiniStat
                label={copy(locale, "New users 24h", "24小时新增")}
                value={formatNumber(data.users.new24h, locale)}
              />
              <MiniStat
                label={copy(locale, "New users 7d", "7天新增")}
                value={formatNumber(data.users.new7d, locale)}
              />
              <MiniStat
                label={copy(locale, "Banned users", "封禁用户")}
                value={formatNumber(data.users.banned, locale)}
              />
              <MiniStat
                label={copy(locale, "Unresolved tickets", "未处理工单")}
                value={formatNumber(data.tickets.unresolved, locale)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {copy(locale, "Admin roles", "管理员角色")}：observer{" "}
              {data.users.observers} · admin {data.users.admins} · super{" "}
              {data.users.superAdmins}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="rounded-lg">
          <CardHeader>
            <CardTitle>{copy(locale, "Credits", "积分账本")}</CardTitle>
            <CardDescription>
              {copy(locale, "Consumption, refunds, grants, and expired write-off.", "消耗、退款、发放和过期核销。")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <MiniStat
                label={copy(locale, "Current balance", "当前余额")}
                value={formatCredits(creditBalance.totalBalance)}
              />
              <MiniStat
                label={copy(locale, "Total earned", "累计获得")}
                value={formatCredits(creditBalance.totalEarned)}
              />
              <MiniStat
                label={copy(locale, "Total spent", "累计消费")}
                value={formatCredits(creditBalance.totalSpent)}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <MiniStat
                label={copy(locale, "7d consumption", "7天消耗")}
                value={formatCredits(data.credits.ledger7d.consumption)}
              />
              <MiniStat
                label={copy(locale, "7d refunds", "7天退款")}
                value={formatCredits(data.credits.ledger7d.refund)}
              />
              <MiniStat
                label={copy(locale, "7d grants/purchases", "7天发放/购买")}
                value={formatCredits(data.credits.ledger7d.grants)}
              />
              <MiniStat
                label={copy(locale, "7d expired write-off", "7天过期核销")}
                value={formatCredits(data.credits.ledger7d.expiration)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {copy(locale, "Active batch remaining", "有效批次剩余")}{" "}
              {formatCredits(data.credits.batches.activeRemaining)} ·{" "}
              {copy(locale, "Consumed batches", "已用尽批次")}{" "}
              {formatCredits(data.credits.batches.consumedAmount)} ·{" "}
              {copy(locale, "Expired batches", "已过期批次")}{" "}
              {formatCredits(data.credits.batches.expiredAmount)} ·{" "}
              {copy(locale, "Frozen balances", "冻结余额账户")}{" "}
              {formatNumber(creditBalance.frozen, locale)}
            </p>
          </CardContent>
        </Card>

        <Card className="rounded-lg">
          <CardHeader>
            <CardTitle>{copy(locale, "Backend Pool", "后端池")}</CardTitle>
            <CardDescription>
              {copy(locale, "Platform accounts and external upstream APIs.", "平台账号和外接上游 API。")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <BackendHealthBlock
                title={copy(locale, "Accounts", "账号池")}
                stats={data.accounts}
                locale={locale}
              />
              <BackendHealthBlock
                title={copy(locale, "External APIs", "外接 API")}
                stats={data.apis}
                locale={locale}
              />
              <BackendHealthBlock
                title={copy(locale, "Adobe Firefly", "Adobe Firefly")}
                stats={data.adobe}
                locale={locale}
              />
            </div>
          </CardContent>
        </Card>
      </div>

      <VideoGenerationCard stats={data.video7d} locale={locale} />

      <Card className="rounded-lg">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-warning" />
            {copy(locale, "Top Failed Reasons: last 24 hours", "24小时高频失败原因")}
          </CardTitle>
          <CardDescription>
            {copy(locale, "Grouped by normalized error message.", "按归一化错误信息聚合。")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.topErrors24h.length === 0 ? (
            <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              {copy(locale, "No failures in the last 24 hours.", "24小时内没有失败记录。")}
            </div>
          ) : (
            <div className="divide-y overflow-hidden rounded-lg border">
              {data.topErrors24h.map((item) => (
                <div
                  key={item.message}
                  className="grid gap-3 p-3 text-sm md:grid-cols-[120px_140px_1fr]"
                >
                  <div className="font-medium">
                    {formatNumber(item.count, locale)}x
                  </div>
                  <Badge
                    variant={
                      item.category === "platform" ? "destructive" : "secondary"
                    }
                    className="w-fit"
                  >
                    {item.category === "platform"
                      ? copy(locale, "Platform", "平台")
                      : item.category === "moderation"
                        ? copy(locale, "Moderation", "审核")
                        : copy(locale, "User request", "用户请求")}
                  </Badge>
                  <div className="min-w-0 break-words text-muted-foreground">
                    {item.message}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <HistoricalErrorsCard
        errors={historicalErrors}
        filters={errorFilters}
        locale={locale}
        timeZone={timeZone}
      />
    </div>
  );
}

// 视频生成(Adobe Firefly)独立统计区块。读 video_generation 表近 7 天聚合,
// 展示总数/完成/失败/进行中、成功率(Progress)、累计积分与时长,以及按模型族明细。
// 无任何样本时优雅降级为"暂无视频生成样本"。
function VideoGenerationCard({
  stats,
  locale,
}: {
  stats: VideoGenerationStats;
  locale: string;
}) {
  // 仅展示有过样本的模型族(总数 > 0),避免空表全是 0 行;无样本时整体走空态。
  const familyRows = stats.byFamily.filter((item) => item.total > 0);

  return (
    <Card className="rounded-lg">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Video className="h-4 w-4 text-muted-foreground" />
          {copy(locale, "Video Generation (Adobe Firefly)", "视频生成 (Adobe Firefly)")}
        </CardTitle>
        <CardDescription>
          {copy(
            locale,
            "Independent pipeline from video_generation, last 7 days. Not folded into image stats.",
            "独立于生图管线,读 video_generation 表,最近 7 天;不计入生图统计。"
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {stats.total === 0 ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {copy(locale, "No video generation samples.", "暂无视频生成样本")}
          </div>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <MiniStat
                label={copy(locale, "Total", "总数")}
                value={formatNumber(stats.total, locale)}
              />
              <MiniStat
                label={copy(locale, "Completed", "完成")}
                value={formatNumber(stats.completed, locale)}
              />
              <MiniStat
                label={copy(locale, "Failed", "失败")}
                value={formatNumber(stats.failed, locale)}
              />
              <MiniStat
                label={copy(locale, "Running", "进行中")}
                value={formatNumber(stats.running + stats.pending, locale)}
              />
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  {copy(locale, "Success rate", "成功率")}
                </span>
                <span className="font-medium">
                  {formatPercent(stats.successRate, locale)}
                </span>
              </div>
              <Progress value={Math.round(stats.successRate * 100)} />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <MiniStat
                label={copy(locale, "Credits consumed", "消耗积分")}
                value={formatCredits(stats.creditsConsumed)}
              />
              <MiniStat
                label={copy(locale, "Video seconds", "累计时长")}
                value={`${formatNumber(stats.totalVideoSeconds, locale)}s`}
              />
              <MiniStat
                label={copy(locale, "Avg generation time", "平均生成耗时")}
                value={formatDuration(stats.avgLatencySeconds, locale)}
              />
            </div>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[360px] text-left text-xs">
                <thead className="border-b border-border/60 text-[11px] uppercase tracking-widest text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">
                      {copy(locale, "Family", "模型族")}
                    </th>
                    <th className="px-3 py-2 font-medium">
                      {copy(locale, "Total", "总数")}
                    </th>
                    <th className="px-3 py-2 font-medium">
                      {copy(locale, "Completed", "完成")}
                    </th>
                    <th className="px-3 py-2 font-medium">
                      {copy(locale, "Failed", "失败")}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {familyRows.map((item) => (
                    <tr
                      key={item.family}
                      className="transition-colors duration-150 hover:bg-muted/50"
                    >
                      <td className="px-3 py-2 font-medium">{item.family}</td>
                      <td className="px-3 py-2">
                        {formatNumber(item.total, locale)}
                      </td>
                      <td className="px-3 py-2">
                        {formatNumber(item.completed, locale)}
                      </td>
                      <td className="px-3 py-2">
                        {formatNumber(item.failed, locale)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function BackendHealthBlock({
  title,
  stats,
  locale,
}: {
  title: string;
  stats: BackendHealthStats;
  locale: string;
}) {
  const availability =
    stats.enabled > 0 ? Math.max(0, stats.active / stats.enabled) : 1;
  const modeText = stats.modes
    .slice(0, 4)
    .map((item) => `${item.mode} ${item.count}`)
    .join(" · ");
  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="font-medium">{title}</div>
        <Badge variant="outline">{formatPercent(availability, locale)}</Badge>
      </div>
      <Progress value={Math.round(availability * 100)} />
      <div className="grid gap-2 text-xs text-muted-foreground">
        <span>
          {copy(locale, "Total", "总数")} {stats.total} ·{" "}
          {copy(locale, "Enabled", "启用")} {stats.enabled}
        </span>
        <span>
          {copy(locale, "Active", "可用")} {stats.active} ·{" "}
          {copy(locale, "Limited", "限流")} {stats.limited} ·{" "}
          {copy(locale, "Cooling", "冷却")} {stats.cooling} ·{" "}
          {copy(locale, "Error", "错误")} {stats.error}
        </span>
        <span>
          {copy(locale, "Success", "成功")} {stats.successCount} ·{" "}
          {copy(locale, "Failed", "失败")} {stats.failCount}
        </span>
        {modeText && <span>{modeText}</span>}
      </div>
    </div>
  );
}
