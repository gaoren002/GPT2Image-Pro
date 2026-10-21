/**
 * API 后端出站模型映射（纯函数，DB-free）。
 *
 * 本站内部型号（gpt-image-2.5 / nano-banana-pro 等）与上游网关 id
 * （如 gpt-image-2-ad / gemini-3.1-flash-image-preview-ad）往往不同；
 * 单字段 `model` 只作缺省，不能按请求改写。本模块把「本站 from → 上游 to」
 * 做成每条 API 可配的规则表，并支持按 quality 分档（高清走 gpt-image-2-high）。
 *
 * 使用方：image-generation 派发层、后台/用户 API 配置表单、测活。
 */

export const API_MODEL_MAPPING_MAX_ENTRIES = 50;
export const API_MODEL_MAPPING_FIELD_MAX = 120;

export const API_MODEL_MAPPING_QUALITIES = [
  "high",
  "medium",
  "low",
  "auto",
  "xhigh",
  "max",
] as const;

export type ApiModelMappingQuality =
  (typeof API_MODEL_MAPPING_QUALITIES)[number];

export type ApiModelMappingEntry = {
  /** 本站请求型号或家族名（大小写不敏感）。 */
  from: string;
  /** 出站发给上游的型号。 */
  to: string;
  /** 仅当请求 quality 命中时启用；不填则任意质量都可命中。 */
  whenQuality?: ApiModelMappingQuality;
  /** 命中后覆盖出站 quality；高清档应设为 high。 */
  setQuality?: ApiModelMappingQuality;
};

const QUALITY_SET = new Set<string>(API_MODEL_MAPPING_QUALITIES);

/**
 * -ad 后缀兼容上游预设：普通档 gpt-image-2-ad，高清 gpt-image-2-high。
 * 高清必须显式 quality=high，否则与普通档完全一致。
 */
export const PRESET_GPT_IMAGE_ADOBE_MAPPING: ApiModelMappingEntry[] = [
  {
    from: "gpt-image-2.5",
    to: "gpt-image-2-high",
    whenQuality: "high",
    setQuality: "high",
  },
  {
    from: "gpt-image-2",
    to: "gpt-image-2-high",
    whenQuality: "high",
    setQuality: "high",
  },
  { from: "gpt-image-2.5", to: "gpt-image-2-ad" },
  { from: "gpt-image-2", to: "gpt-image-2-ad" },
];

/**
 * Gemini 图像上游：nano-banana 家族改写成 gemini-*-ad。
 * 这两个 id 不能走 /v1/images/*，API 的 Images 上游需设为 Responses 或对话。
 */
export const PRESET_GEMINI_IMAGE_MAPPING: ApiModelMappingEntry[] = [
  {
    from: "nano-banana-pro",
    to: "gemini-3-pro-image-preview-ad",
  },
  {
    from: "nano-banana2",
    to: "gemini-3.1-flash-image-preview-ad",
  },
  {
    from: "nano-banana",
    to: "gemini-3.1-flash-image-preview-ad",
  },
];

function normalizeKey(value: string | null | undefined): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function isMappingQuality(
  value: string | null | undefined
): value is ApiModelMappingQuality {
  return Boolean(value && QUALITY_SET.has(value));
}

function qualityBucket(
  quality: string | null | undefined
): ApiModelMappingQuality | undefined {
  const normalized = normalizeKey(quality);
  if (!normalized) return undefined;
  if (normalized === "xhigh" || normalized === "max") return "high";
  return isMappingQuality(normalized) ? normalized : undefined;
}

function addKey(keys: string[], value: string) {
  const key = normalizeKey(value);
  if (key && !keys.includes(key)) keys.push(key);
}

/**
 * 为一条请求型号生成匹配键：精确 id、去掉 firefly- 前缀、2.5 变体前缀。
 * 顺序即优先级（越靠前越具体）。
 */
export function collectApiModelMappingKeys(
  model: string | null | undefined
): string[] {
  const keys: string[] = [];
  const normalized = normalizeKey(model);
  if (!normalized) return keys;
  addKey(keys, normalized);
  if (normalized.startsWith("firefly-")) {
    addKey(keys, normalized.slice("firefly-".length));
  }
  if (normalized.startsWith("gpt-image-2.5-")) {
    addKey(keys, "gpt-image-2.5");
  }
  return keys;
}

function scoreMappingEntry(
  entry: ApiModelMappingEntry,
  keys: string[],
  quality: ApiModelMappingQuality | undefined
): number | null {
  const from = normalizeKey(entry.from);
  const index = keys.indexOf(from);
  if (index < 0) return null;
  if (entry.whenQuality) {
    const required = qualityBucket(entry.whenQuality);
    if (!required || quality !== required) return null;
  }
  const specificity = Math.max(1, 20 - index);
  return (entry.whenQuality ? 100 : 0) + specificity;
}

function sanitizeEntry(value: unknown): ApiModelMappingEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const from =
    typeof record.from === "string" ? record.from.trim() : "";
  const to = typeof record.to === "string" ? record.to.trim() : "";
  if (!from || !to) return null;
  if (from.length > API_MODEL_MAPPING_FIELD_MAX) return null;
  if (to.length > API_MODEL_MAPPING_FIELD_MAX) return null;
  const whenRaw =
    typeof record.whenQuality === "string"
      ? record.whenQuality.trim().toLowerCase()
      : "";
  const setRaw =
    typeof record.setQuality === "string"
      ? record.setQuality.trim().toLowerCase()
      : "";
  const entry: ApiModelMappingEntry = { from, to };
  if (isMappingQuality(whenRaw)) entry.whenQuality = whenRaw;
  if (isMappingQuality(setRaw)) entry.setQuality = setRaw;
  return entry;
}

/** 把库里的 json 收成合法规则表；非法项丢弃，上限 50 条。 */
export function parseApiModelMapping(
  value: unknown
): ApiModelMappingEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: ApiModelMappingEntry[] = [];
  for (const item of value) {
    const entry = sanitizeEntry(item);
    if (!entry) continue;
    entries.push(entry);
    if (entries.length >= API_MODEL_MAPPING_MAX_ENTRIES) break;
  }
  return entries;
}

export function applyApiModelMapping(input: {
  requestedModel?: string | null;
  resolvedModel: string;
  quality?: string | null;
  mapping?: unknown;
}): { model: string; quality: string | undefined } {
  const mapping = parseApiModelMapping(input.mapping);
  const resolved = input.resolvedModel.trim();
  const incomingQuality = input.quality?.trim() || undefined;
  if (mapping.length === 0 || !resolved) {
    return { model: resolved, quality: incomingQuality };
  }

  const keys = [
    ...collectApiModelMappingKeys(resolved),
    ...collectApiModelMappingKeys(input.requestedModel),
  ].filter((key, index, all) => all.indexOf(key) === index);
  const quality = qualityBucket(incomingQuality);

  let best: { entry: ApiModelMappingEntry; score: number } | null = null;
  for (const entry of mapping) {
    const score = scoreMappingEntry(entry, keys, quality);
    if (score === null) continue;
    if (!best || score > best.score) best = { entry, score };
  }
  if (!best) return { model: resolved, quality: incomingQuality };
  return {
    model: best.entry.to.trim(),
    quality: best.entry.setQuality || incomingQuality,
  };
}
