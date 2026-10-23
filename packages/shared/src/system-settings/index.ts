// 系统设置读写与运行时取值。读路径(loadSystemSettingsMap)带 10s 进程内
// 缓存，并合并缓存缺失时的并发查询；DB 查询失败按空设置兜底并负缓存 5s。
// 空设置与空库行为一致(全部 getRuntimeSetting* 落代码默认值),保证 DB
// 抖动时整站不 500；负缓存兼顾故障期不打爆 DB 与恢复后快速生效。
// 写路径不经缓存读取函数,不受影响。
import { createHash } from "node:crypto";

import { db } from "@repo/database";
import { systemSetting } from "@repo/database/schema";
import { eq, inArray, sql } from "drizzle-orm";

import {
  SETTING_DEFINITION_BY_KEY,
  SYSTEM_SETTING_DEFINITIONS,
  type SettingDefinition,
  type SettingKey,
  isSettingKey,
} from "./definitions";

export {
  SETTING_CATEGORIES,
  SETTING_DEFINITION_BY_KEY,
  SYSTEM_SETTING_DEFINITIONS,
  type SettingCategory,
  type SettingDefinition,
  type SettingKey,
  type SettingValueType,
} from "./definitions";

const CACHE_TTL_MS = 10_000;
// 负缓存 TTL:设置查询失败时缓存空 Map 的时长。WHY:DB 抖动/不可达时
// 整站不应 500——空设置与空库行为一致(所有 getRuntimeSetting* 落代码
// 默认值);5s 兼顾故障期不打爆 DB(每进程至多 5s 一次重试)与恢复后
// 快速生效。写路径(setSystemSettings 等)不经 loadSystemSettingsMap,
// 不受影响。
const NEGATIVE_CACHE_TTL_MS = 5_000;

let settingsCache:
  | {
      expiresAt: number;
      values: Map<string, unknown>;
    }
  | undefined;
let settingsLoad: Promise<Map<string, unknown>> | undefined;
let settingsCacheGeneration = 0;

function normalizeStoredValue(value: unknown) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  return value;
}

/** 读取一版全局配置；失效代次的在途读仍返回给原调用方，但不能回填当前缓存。 */
async function readSystemSettingsMap(generation: number, now: number) {
  let rows: Array<{ key: string; value: unknown }>;
  try {
    rows = await db
      .select({
        key: systemSetting.key,
        value: systemSetting.value,
      })
      .from(systemSetting);
  } catch (err) {
    // WHY: 查询失败按空设置处理并负缓存 5s——DB 抖动时宁可临时走代码
    // 默认值(与空库行为一致),不可让营销首页/后台等读路径整页 500;
    // 负缓存避免故障期每请求都打 DB,5s 后自动重试、恢复即生效。
    console.error(
      "[system-settings] 设置查询失败,按空设置处理(负缓存 5s)",
      err
    );
    const empty = new Map<string, unknown>();
    if (generation === settingsCacheGeneration) {
      settingsCache = {
        expiresAt: now + NEGATIVE_CACHE_TTL_MS,
        values: empty,
      };
    }
    return empty;
  }

  const values = new Map<string, unknown>();
  for (const row of rows) {
    const normalized = normalizeStoredValue(row.value);
    if (normalized !== undefined) {
      values.set(row.key, normalized);
    }
  }

  if (generation === settingsCacheGeneration) {
    settingsCache = {
      expiresAt: now + CACHE_TTL_MS,
      values,
    };
  }

  return values;
}

/** 同一代的并发配置键共享查询；有效配置与负缓存的 TTL 仍按原规则计算。 */
async function loadSystemSettingsMap() {
  const now = Date.now();
  if (settingsCache && settingsCache.expiresAt > now) {
    return settingsCache.values;
  }
  if (settingsLoad) return settingsLoad;

  const pending = readSystemSettingsMap(settingsCacheGeneration, now);
  settingsLoad = pending;
  try {
    return await pending;
  } finally {
    // 写入失效后可能已启动下一代查询，旧查询完成时不能清除新查询的合并入口。
    if (settingsLoad === pending) settingsLoad = undefined;
  }
}

export function clearSystemSettingsCache() {
  settingsCacheGeneration += 1;
  settingsCache = undefined;
  settingsLoad = undefined;
  // 级联失效:下游缓存(如营销首页 home-data)注册同一个失效点,
  // 任何写路径(管理面板/UOL/sla 开关)保存后即刻全站生效
  settingsCacheInvalidator?.();
}

/** 下游缓存失效回调:单槽,由消费方(如 apps/web home-data)在模块初始化注册 */
let settingsCacheInvalidator: (() => void) | null = null;

export function setSettingsCacheInvalidator(cb: (() => void) | null): void {
  settingsCacheInvalidator = cb;
}

export async function getSystemSettingValue(
  key: SettingKey
): Promise<unknown | undefined> {
  const values = await loadSystemSettingsMap();
  return values.get(key);
}

function parseJsonText(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return JSON.parse(trimmed) as unknown;
}

export async function getRuntimeSettingJson(key: SettingKey) {
  const value = await getSystemSettingValue(key);
  if (value !== undefined) {
    if (typeof value === "string") return parseJsonText(value);
    return value;
  }

  const envValue = process.env[key];
  if (!envValue?.trim()) return undefined;
  return parseJsonText(envValue);
}

export async function getSystemSettingString(key: SettingKey) {
  const value = await getSystemSettingValue(key);
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

export async function getRuntimeSettingString(key: SettingKey) {
  const value = await getSystemSettingString(key);
  return value ?? (process.env[key]?.trim() || undefined);
}

export async function getRuntimeSettingBoolean(
  key: SettingKey,
  fallback = false
) {
  const value = await getSystemSettingValue(key);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string" && value.trim()) {
    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  }

  const envValue = process.env[key];
  if (!envValue) return fallback;
  return ["1", "true", "yes", "on"].includes(envValue.toLowerCase());
}

export async function getRuntimeSettingNumber(
  key: SettingKey,
  fallback: number,
  options?: { positive?: boolean; nonNegative?: boolean }
) {
  const isAllowedNumber = (candidate: number) => {
    if (!Number.isFinite(candidate)) return false;
    if (options?.positive) return candidate > 0;
    if (options?.nonNegative) return candidate >= 0;
    return true;
  };
  const value = await getSystemSettingValue(key);
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  if (isAllowedNumber(numericValue)) {
    return numericValue;
  }

  const envRawValue = process.env[key]?.trim();
  if (envRawValue) {
    const envValue = Number(envRawValue);
    if (isAllowedNumber(envValue)) {
      return envValue;
    }
  }

  return fallback;
}

export async function getRuntimeSettingSelect<T extends string>(
  key: SettingKey,
  allowed: readonly T[],
  fallback: T
) {
  const value = await getRuntimeSettingString(key);
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function getProcessSettingString(key: SettingKey) {
  return process.env[key]?.trim() || undefined;
}

export function getProcessSettingBoolean(key: SettingKey, fallback = false) {
  const value = process.env[key];
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function getProcessSettingNumber(key: SettingKey, fallback: number) {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function coerceValue(definition: SettingDefinition, value: unknown) {
  if (definition.valueType === "boolean") {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      return ["1", "true", "yes", "on"].includes(value.toLowerCase());
    }
    return Boolean(value);
  }

  if (definition.valueType === "number") {
    // WHY: 空白数值输入视为清空（删除行，回退默认值），与 string 类型一致；
    // 否则 Number("") === 0 会被范围校验误判，破坏"清空即重置"的后台 UX。
    if (typeof value === "string" && !value.trim()) {
      return "";
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      throw new Error(`${definition.label} 必须是有效数字`);
    }
    // WHY: 经济/安全语义键（积分、价格、审核超时等）在 definitions.ts 声明了业务
    // 上下界；S-C1 已把写入收紧为 superAdminAction，此处补 per-key 范围闭区间钳制，
    // 拒绝负积分/负价格/0 超时/异常巨大值等会破坏经济或安全语义的脏值落库。
    // 未声明 min/max 的键行为不变。
    if (definition.min !== undefined && numeric < definition.min) {
      throw new Error(`${definition.label} 不能小于 ${definition.min}`);
    }
    if (definition.max !== undefined && numeric > definition.max) {
      throw new Error(`${definition.label} 不能大于 ${definition.max}`);
    }
    return numeric;
  }

  if (definition.valueType === "json") {
    if (value === undefined || value === null) return "";
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return "";
      try {
        return JSON.parse(trimmed) as unknown;
      } catch {
        throw new Error(`${definition.label} 必须是有效 JSON`);
      }
    }
    return value;
  }

  const text = typeof value === "string" ? value.trim() : String(value ?? "");
  if (definition.valueType === "select") {
    const allowed = definition.options?.map((option) => option.value) ?? [];
    if (text && !allowed.includes(text)) {
      throw new Error(`${definition.label} 的取值无效`);
    }
  }
  return text;
}

function getProcessSettingValue(definition: SettingDefinition) {
  const envValue = process.env[definition.key]?.trim();
  if (!envValue) return undefined;
  return coerceValue(definition, envValue);
}

function getDefaultSettingValue(definition: SettingDefinition) {
  if (definition.secret) return undefined;
  if (definition.exampleValue !== undefined) return definition.exampleValue;
  if (definition.defaultValue !== undefined) return definition.defaultValue;
  return undefined;
}

export async function importSystemSettingsFromEnv(options?: {
  updatedBy?: string;
  overwrite?: boolean;
}) {
  const rows = await db
    .select({
      key: systemSetting.key,
      value: systemSetting.value,
    })
    .from(systemSetting);

  const storedKeys = new Set(
    rows
      .filter((row) => normalizeStoredValue(row.value) !== undefined)
      .map((row) => row.key)
  );
  const now = new Date();
  const values = SYSTEM_SETTING_DEFINITIONS.flatMap((definition) => {
    if (!options?.overwrite && storedKeys.has(definition.key)) return [];

    const value = getProcessSettingValue(definition);
    if (value === undefined || value === "") return [];

    return [
      {
        key: definition.key,
        value,
        isSecret: "secret" in definition && Boolean(definition.secret),
        ...(options?.updatedBy ? { updatedBy: options.updatedBy } : {}),
        updatedAt: now,
      },
    ];
  });

  if (values.length === 0) return [] as SettingKey[];

  await db
    .insert(systemSetting)
    .values(values)
    .onConflictDoUpdate({
      target: systemSetting.key,
      set: {
        value: sql`excluded.value`,
        isSecret: sql`excluded.is_secret`,
        updatedBy: sql`excluded.updated_by`,
        updatedAt: now,
      },
    });

  clearSystemSettingsCache();

  // 同步进 process.env:同步读取器(getProcessSettingString,如邮件 SMTP/Resend、鉴权配置)只看
  // process.env,而 process.env 仅在启动时由 bootstrap 从 DB 灌入。若保存后不同步,后台改完邮件/
  // 配置要重启容器才生效(否则一直读旧值、SMTP 配了仍退回 resend、发码 400)。这里写回当前进程的
  // process.env,使改动即时生效、无需重启(单实例部署如 docker compose)。
  for (const { key, value } of values) {
    if (value === null || value === undefined || value === "") {
      delete process.env[key];
      continue;
    }
    process.env[key] =
      typeof value === "string"
        ? value.trim()
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value);
  }

  return values.map((value) => value.key);
}

export async function initializeMissingSystemSettingsDefaults(options?: {
  updatedBy?: string;
}) {
  const now = new Date();
  await migrateLegacyModerationSettings(now, options?.updatedBy);
  await migrateLegacySub2ApiAutoSyncSettings(now, options?.updatedBy);

  const rows = await db
    .select({
      key: systemSetting.key,
      value: systemSetting.value,
    })
    .from(systemSetting);

  const storedKeys = new Set(
    rows
      .filter((row) => normalizeStoredValue(row.value) !== undefined)
      .map((row) => row.key)
  );
  const values = SYSTEM_SETTING_DEFINITIONS.flatMap((definition) => {
    if (storedKeys.has(definition.key)) return [];

    const value = getDefaultSettingValue(definition);
    if (value === undefined || value === "") return [];

    return [
      {
        key: definition.key,
        value,
        isSecret: false,
        ...(options?.updatedBy ? { updatedBy: options.updatedBy } : {}),
        updatedAt: now,
      },
    ];
  });

  if (values.length === 0) return [] as SettingKey[];

  await db.insert(systemSetting).values(values).onConflictDoNothing({
    target: systemSetting.key,
  });

  clearSystemSettingsCache();
  return values.map((value) => value.key);
}

async function migrateLegacyModerationSettings(now: Date, updatedBy?: string) {
  const legacyKeys = [
    "ALIYUN_MODERATION_PUBLIC_BASE_URL",
    "ALIYUN_MODERATION_BLOCK_RISK_LEVEL",
  ];
  const rows = await db
    .select({
      key: systemSetting.key,
      value: systemSetting.value,
    })
    .from(systemSetting)
    .where(
      inArray(systemSetting.key, [
        "CONTENT_MODERATION_PUBLIC_BASE_URL",
        ...legacyKeys,
      ])
    );

  const stored = new Map(
    rows
      .map((row) => [row.key, normalizeStoredValue(row.value)] as const)
      .filter(([, value]) => value !== undefined)
  );
  const legacyPublicBaseUrl = stored.get("ALIYUN_MODERATION_PUBLIC_BASE_URL");
  const hasPublicBaseUrl = stored.has("CONTENT_MODERATION_PUBLIC_BASE_URL");

  await db.transaction(async (tx) => {
    if (!hasPublicBaseUrl && legacyPublicBaseUrl !== undefined) {
      await tx
        .insert(systemSetting)
        .values({
          key: "CONTENT_MODERATION_PUBLIC_BASE_URL",
          value: legacyPublicBaseUrl,
          isSecret: false,
          ...(updatedBy ? { updatedBy } : {}),
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: systemSetting.key,
        });
    }

    await tx
      .delete(systemSetting)
      .where(inArray(systemSetting.key, legacyKeys));
  });

  clearSystemSettingsCache();
}

async function migrateLegacySub2ApiAutoSyncSettings(
  now: Date,
  updatedBy?: string
) {
  const legacyKeys = [
    "SUB2API_AUTO_SYNC_ENABLED",
    "SUB2API_AUTO_SYNC_INTERVAL_MINUTES",
    "SUB2API_AUTO_SYNC_SOURCE_GROUP_ID",
    "SUB2API_AUTO_SYNC_MODE",
    "SUB2API_AUTO_SYNC_ALLOW_MOBILE_RT",
    "SUB2API_AUTO_SYNC_PLAN_FILTER",
  ];
  const rows = await db
    .select({
      key: systemSetting.key,
      value: systemSetting.value,
    })
    .from(systemSetting)
    .where(
      inArray(systemSetting.key, ["SUB2API_AUTO_SYNC_TASKS", ...legacyKeys])
    );

  const stored = new Map(
    rows
      .map((row) => [row.key, normalizeStoredValue(row.value)] as const)
      .filter(([, value]) => value !== undefined)
  );
  const hasTasks = stored.has("SUB2API_AUTO_SYNC_TASKS");
  const hasLegacyConfig = legacyKeys.some((key) => stored.has(key));

  await db.transaction(async (tx) => {
    if (!hasTasks && hasLegacyConfig) {
      const enabled = parseBooleanLike(
        stored.get("SUB2API_AUTO_SYNC_ENABLED"),
        true
      );
      const allowMobileRtImport = parseBooleanLike(
        stored.get("SUB2API_AUTO_SYNC_ALLOW_MOBILE_RT"),
        false
      );
      const syncMode = allowMobileRtImport
        ? parseSyncMode(stored.get("SUB2API_AUTO_SYNC_MODE"))
        : "responses";
      const sourceGroupId = parseOptionalString(
        stored.get("SUB2API_AUTO_SYNC_SOURCE_GROUP_ID")
      );
      const planFilter = parseSub2ApiPlanFilter(
        stored.get("SUB2API_AUTO_SYNC_PLAN_FILTER")
      );
      const intervalMinutes = parsePositiveInteger(
        stored.get("SUB2API_AUTO_SYNC_INTERVAL_MINUTES"),
        720
      );
      const taskKey = [
        sourceGroupId || "all",
        allowMobileRtImport ? syncMode : "responses",
        allowMobileRtImport ? "mobile-allowed" : "codex-only",
        planFilter,
      ].join("|");
      await tx
        .insert(systemSetting)
        .values({
          key: "SUB2API_AUTO_SYNC_TASKS",
          value: [
            {
              id: `sub2api-${createHash("sha256").update(taskKey).digest("hex").slice(0, 16)}`,
              enabled,
              sourceGroupId,
              sourceGroupName: null,
              webGroupId: null,
              responsesGroupId: null,
              syncMode,
              allowMobileRtImport,
              contentSafetyEnabled: true,
              overwriteLocalUnavailableState: true,
              planFilter,
              intervalMinutes,
              createdAt: now.toISOString(),
              updatedAt: now.toISOString(),
            },
          ],
          isSecret: false,
          ...(updatedBy ? { updatedBy } : {}),
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: systemSetting.key,
        });
    }

    await tx
      .delete(systemSetting)
      .where(inArray(systemSetting.key, legacyKeys));
  });

  clearSystemSettingsCache();
}

function parseOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseBooleanLike(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string" && value.trim()) {
    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  }
  return fallback;
}

function parsePositiveInteger(value: unknown, fallback: number) {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function parseSyncMode(value: unknown) {
  return value === "web" || value === "both" ? value : "responses";
}

function parseSub2ApiPlanFilter(value: unknown) {
  return value === "all" ||
    value === "free" ||
    value === "plus" ||
    value === "pro" ||
    value === "non_free"
    ? value
    : "non_free";
}

export async function importMissingSystemSettingsFromEnv(updatedBy?: string) {
  return importSystemSettingsFromEnv(
    updatedBy === undefined ? undefined : { updatedBy }
  );
}

export async function setSystemSettings(
  entries: Array<{
    key: string;
    value: unknown;
    clear?: boolean;
  }>,
  updatedBy: string
) {
  const now = new Date();
  const changedKeys: SettingKey[] = [];

  await db.transaction(async (tx) => {
    for (const entry of entries) {
      if (!isSettingKey(entry.key)) {
        throw new Error(`未知配置项: ${entry.key}`);
      }

      const definition = SETTING_DEFINITION_BY_KEY.get(entry.key);
      if (!definition) {
        throw new Error(`未知配置项: ${entry.key}`);
      }

      if (entry.clear) {
        await tx.delete(systemSetting).where(eq(systemSetting.key, entry.key));
        changedKeys.push(entry.key);
        continue;
      }

      if (
        definition.secret &&
        typeof entry.value === "string" &&
        !entry.value.trim()
      ) {
        continue;
      }

      const value = coerceValue(definition, entry.value);
      if (value === "") {
        await tx.delete(systemSetting).where(eq(systemSetting.key, entry.key));
      } else {
        await tx
          .insert(systemSetting)
          .values({
            key: entry.key,
            value,
            isSecret: Boolean(definition.secret),
            updatedBy,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: systemSetting.key,
            set: {
              value,
              isSecret: Boolean(definition.secret),
              updatedBy,
              updatedAt: now,
            },
          });
      }
      changedKeys.push(entry.key);
    }
  });

  clearSystemSettingsCache();
  return changedKeys;
}

export async function getAdminSystemSettingsSnapshot() {
  const keys = SYSTEM_SETTING_DEFINITIONS.map((definition) => definition.key);
  const rows = await db
    .select({
      key: systemSetting.key,
      value: systemSetting.value,
      isSecret: systemSetting.isSecret,
      updatedAt: systemSetting.updatedAt,
    })
    .from(systemSetting)
    .where(inArray(systemSetting.key, keys));

  const stored = new Map(rows.map((row) => [row.key, row]));

  return SYSTEM_SETTING_DEFINITIONS.map((definition) => {
    const row = stored.get(definition.key);
    const envValue = process.env[definition.key];
    const hasStoredValue =
      row?.value !== undefined &&
      row.value !== null &&
      (typeof row.value !== "string" || row.value.trim().length > 0);
    const hasEnvValue =
      typeof envValue === "string" && envValue.trim().length > 0;
    const isSecret = "secret" in definition && Boolean(definition.secret);
    const displayValue = isSecret
      ? ""
      : hasStoredValue
        ? typeof row.value === "object"
          ? JSON.stringify(row.value, null, 2)
          : String(row.value)
        : hasEnvValue
          ? envValue.trim()
          : "";

    return {
      ...definition,
      value: displayValue,
      configured: hasStoredValue || hasEnvValue,
      stored: hasStoredValue,
      fromEnv: !hasStoredValue && hasEnvValue,
      updatedAt: row?.updatedAt?.toISOString() ?? null,
    };
  });
}
