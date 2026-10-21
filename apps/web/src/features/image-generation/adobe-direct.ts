/**
 * Adobe Firefly 直连派发（mode=direct）：用本仓库移植的逆向逻辑
 * （@repo/shared/adobe/firefly-direct）直连 Adobe Firefly，经 Go TLS 旁路过风控，
 * 不依赖外部 adobe2api 进程。
 *
 * 职责：
 * - 账号/token 池（adobe_account / adobe_token）：cookie → IMS access_token 刷新、
 *   token 轮换选取、失效/配额错误标记。
 * - 出图：选 token → 选模型族/尺寸 → 图生图先 uploadImage → generateImage → 返回 base64。
 */

import { db } from "@repo/database";
import { adobeAccount, adobeToken } from "@repo/database/schema";
import {
  type AdobeImageFamily,
  type AdobeImageResolution,
  type AdobeRatio,
  composeAdobeImageModelId,
  mapSizeToAdobe,
} from "@repo/shared/adobe";
import {
  AdobeFireflyClient,
  AuthError,
  decodeJwtExp,
  decodeJwtPayload,
  FetchFireflyTransport,
  type FireflyTransport,
  fetchAccountInfo,
  fetchCreditsBalance,
  isAdobeRotatableError,
  isTokenExpired,
  ProxyFireflyTransport,
  QuotaExhaustedError,
  refreshAccessTokenFromCookie,
  resolveFireflyImageModel,
} from "@repo/shared/adobe/firefly-direct";
import { logError, logWarn } from "@repo/shared/logger";
import { getRuntimeSettingString } from "@repo/shared/system-settings";
import { and, asc, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { parseAdobeCookieEntries } from "./adobe-cookie-parser";
import type { ApiConfig, GenerateImageResult } from "./types";

// IMS access_token 距过期多久内视为需要刷新（秒）。
const TOKEN_REFRESH_SKEW_SECONDS = 120;

/** 读取 Firefly 旁路代理配置：优先 FIREFLY_PROXY_*，回落到 chatgpt-web 旁路（同一 Go 服务）。 */
async function getFireflyProxyConfig(): Promise<{
  url: string;
  secret: string;
} | null> {
  // 复用 chatgpt-web 旁路（同一个 Go TLS 服务）；FIREFLY_PROXY_* 仅作 env 覆盖。
  const rawUrl =
    process.env.FIREFLY_PROXY_URL?.trim() ||
    (await getRuntimeSettingString("CHATGPT_WEB_PROXY_URL")) ||
    process.env.CHATGPT_WEB_PROXY_URL?.trim();
  const url = rawUrl?.replace(/\/+$/, "");
  if (!url) return null;
  const secret =
    process.env.FIREFLY_PROXY_SECRET?.trim() ||
    (await getRuntimeSettingString("CHATGPT_WEB_PROXY_SECRET")) ||
    process.env.CHATGPT_WEB_PROXY_SECRET?.trim() ||
    "";
  return { url, secret };
}

/** 构造 API/下载传输：API 走旁路（无则回落直连），产物下载走直连。 */
async function buildAdobeTransports(sessionKey: string): Promise<{
  apiTransport: FireflyTransport;
  downloadTransport: FireflyTransport;
}> {
  const proxy = await getFireflyProxyConfig();
  const downloadTransport = new FetchFireflyTransport();
  if (!proxy) {
    return { apiTransport: new FetchFireflyTransport(), downloadTransport };
  }
  return {
    apiTransport: new ProxyFireflyTransport({
      proxyUrl: proxy.url,
      secret: proxy.secret,
      sessionKey,
    }),
    downloadTransport,
  };
}

function tokenExpiresAt(value: string): Date | null {
  const exp = decodeJwtExp(value);
  return exp === null ? null : new Date(exp * 1000);
}

/** 拒绝 Guest 会话 cookie：能 refresh 但 Firefly 生图会 401。 */
function assertLoggedInAdobeCookie(
  accessToken: string,
  account: { displayName: string; email: string; userId: string } | null
): void {
  const sub = String(decodeJwtPayload(accessToken).sub || "").trim();
  if (sub.includes("@GuestID")) {
    throw new Error(
      "Cookie 对应 Firefly 访客会话（GuestID），不是已登录 Adobe 账号。请在已登录 firefly.adobe.com 的标签页用 tools/adobe-cookie-exporter 重新导出（需含 HttpOnly 会话 cookie，例如 aux_sid）。"
    );
  }
  if (!account?.userId && !account?.email && !account?.displayName) {
    throw new Error(
      "Cookie 能刷新 token，但读不到 Adobe 账号信息。请确认浏览器已登录 Adobe ID，并用 cookie 导出扩展重新导出完整 cookie。"
    );
  }
}

/**
 * 用某账号的 cookie 刷新出 access_token，并 upsert 到 adobe_token（一个账号一行
 * auto_refresh token）。同时回写账号信息/状态。
 */
async function refreshAccountToken(
  adobeId: string,
  account: { id: string; cookie: string; scope: string | null },
  transport: FireflyTransport,
  signal?: AbortSignal
): Promise<{ id: string; value: string } | null> {
  try {
    const result = await refreshAccessTokenFromCookie(
      transport,
      account.cookie,
      {
        scope: account.scope ?? undefined,
        signal,
        fetchAccount: true,
      }
    );
    const now = new Date();
    const accountUserId = result.account?.userId || "";

    await db
      .update(adobeAccount)
      .set({
        status: "active",
        lastRefreshAt: now,
        lastRefreshError: null,
        consecutiveFailures: 0,
        ...(result.account
          ? {
              displayName: result.account.displayName || null,
              email: result.account.email || null,
              accountUserId: result.account.userId || null,
            }
          : {}),
        updatedAt: now,
      })
      .where(eq(adobeAccount.id, account.id));

    // 该账号已有的 auto_refresh token？有则更新，无则插入。
    const existing = await db
      .select({ id: adobeToken.id })
      .from(adobeToken)
      .where(
        and(
          eq(adobeToken.accountId, account.id),
          eq(adobeToken.source, "auto_refresh")
        )
      )
      .limit(1);

    const expiresAt = tokenExpiresAt(result.accessToken);
    let tokenId: string;
    if (existing[0]) {
      await db
        .update(adobeToken)
        .set({
          value: result.accessToken,
          accountUserId: accountUserId || null,
          status: "active",
          fails: 0,
          expiresAt,
          updatedAt: now,
        })
        .where(eq(adobeToken.id, existing[0].id));
      tokenId = existing[0].id;
    } else {
      tokenId = nanoid();
      await db.insert(adobeToken).values({
        id: tokenId,
        adobeId,
        accountId: account.id,
        value: result.accessToken,
        accountUserId: accountUserId || null,
        status: "active",
        source: "auto_refresh",
        expiresAt,
      });
    }
    // best-effort 拉 Firefly 余额写入 token（失败不影响刷新结果）。
    await storeTokenCredits(
      transport,
      tokenId,
      result.accessToken,
      signal
    ).catch((error) =>
      logError(error, { source: "adobe-credits-balance", adobeId })
    );
    return { id: tokenId, value: result.accessToken };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(adobeAccount)
      .set({
        status: "error",
        lastRefreshError: message.slice(0, 500),
        consecutiveFailures: sql`${adobeAccount.consecutiveFailures} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(adobeAccount.id, account.id));
    logError(error, { source: "adobe-direct-refresh", adobeId });
    return null;
  }
}

// best-effort 拉取 Firefly 余额并写入 adobe_token 的 credits 列；失败只记 creditsError,
// 不抛出（余额是运营展示用，不应影响刷新/生成主流程）。
async function storeTokenCredits(
  transport: FireflyTransport,
  tokenId: string,
  accessToken: string,
  signal?: AbortSignal
): Promise<void> {
  const toInt = (value: number | null) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.round(value)
      : null;
  try {
    const balance = await fetchCreditsBalance(transport, accessToken, signal);
    await db
      .update(adobeToken)
      .set({
        creditsTotal: toInt(balance.total),
        creditsUsed: toInt(balance.used),
        creditsAvailable: toInt(balance.available),
        creditsUpdatedAt: new Date(),
        creditsError: null,
        updatedAt: new Date(),
      })
      .where(eq(adobeToken.id, tokenId));
  } catch (error) {
    await db
      .update(adobeToken)
      .set({
        creditsError: (error instanceof Error
          ? error.message
          : String(error)
        ).slice(0, 300),
        creditsUpdatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(adobeToken.id, tokenId))
      .catch(() => {});
  }
}

/**
 * 为某 adobe 后端取一个可用 access_token：
 * 1. 现有 active 且未过期的 token → 轮换选取（lastUsedAt 最旧优先）。
 * 2. 否则用某个 enabled 账号的 cookie 刷新出新 token。
 */
async function acquireToken(
  adobeId: string,
  transport: FireflyTransport,
  signal?: AbortSignal,
  // 换号重试用：跳过本次已试过的 token / 账号（被 429 等限流的账号本次不再重选）。
  exclude?: { tokenIds?: Set<string>; accountIds?: Set<string> }
): Promise<{ id: string; value: string; accountId: string | null } | null> {
  const candidates = await db
    .select({
      id: adobeToken.id,
      value: adobeToken.value,
      expiresAt: adobeToken.expiresAt,
      accountId: adobeToken.accountId,
    })
    .from(adobeToken)
    .where(
      and(eq(adobeToken.adobeId, adobeId), eq(adobeToken.status, "active"))
    )
    .orderBy(asc(adobeToken.lastUsedAt), asc(adobeToken.createdAt));

  for (const candidate of candidates) {
    if (exclude?.tokenIds?.has(candidate.id)) continue;
    if (candidate.accountId && exclude?.accountIds?.has(candidate.accountId)) {
      continue;
    }
    const expired = candidate.expiresAt
      ? candidate.expiresAt.getTime() - TOKEN_REFRESH_SKEW_SECONDS * 1000 <=
        Date.now()
      : isTokenExpired(candidate.value, TOKEN_REFRESH_SKEW_SECONDS);
    if (expired) continue;
    await db
      .update(adobeToken)
      .set({ lastUsedAt: new Date() })
      .where(eq(adobeToken.id, candidate.id));
    return {
      id: candidate.id,
      value: candidate.value,
      accountId: candidate.accountId,
    };
  }

  // 没有可用 token：用一个 enabled 账号刷新（同样跳过本次已试过的账号）。
  const accounts = await db
    .select({
      id: adobeAccount.id,
      cookie: adobeAccount.cookie,
      scope: adobeAccount.scope,
    })
    .from(adobeAccount)
    .where(
      and(eq(adobeAccount.adobeId, adobeId), eq(adobeAccount.isEnabled, true))
    )
    .orderBy(asc(adobeAccount.lastRefreshAt), asc(adobeAccount.createdAt));

  for (const account of accounts) {
    if (exclude?.accountIds?.has(account.id)) continue;
    const refreshed = await refreshAccountToken(
      adobeId,
      account,
      transport,
      signal
    );
    if (refreshed) {
      await db
        .update(adobeToken)
        .set({ lastUsedAt: new Date() })
        .where(eq(adobeToken.id, refreshed.id));
      return {
        id: refreshed.id,
        value: refreshed.value,
        accountId: account.id,
      };
    }
  }
  return null;
}

async function markTokenStatus(
  tokenId: string,
  status: "error" | "exhausted" | "invalid"
): Promise<void> {
  await db
    .update(adobeToken)
    .set({
      status,
      fails: sql`${adobeToken.fails} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(adobeToken.id, tokenId));
}

// 单个 Adobe 后端（伪账号）内换号重试的账号数上限。实际收口由「本后端可用账号数」与
// 「整单 signal（20 分钟）」共同决定；此常数仅作防御性兜底，避免账号池极大时空转过久。
const MAX_ADOBE_TOKEN_ROTATION = 24;

/**
 * 在一个 Adobe 后端（伪账号）内带 token/账号轮换地执行一次直连调用。
 * - 每次取一个本次未试过的可用账号 token，执行 run（用该 token 完成上传+生成）；
 * - 遇「可轮换错误」（429/5xx 上游临时、配额耗尽、鉴权失效）就标记当前 token、把该
 *   token+账号本次排除，换下一个账号重试；
 * - 直到成功、本后端内已无更多可用账号、或 signal 取消。
 * WHY：池层换号是「整个 Adobe 后端」粒度——一旦本后端被排除就轮到下一个后端。故必须先在
 * 本后端内把所有可用账号都试完（重试完毕）才返回错误上抛，才能满足
 * 「伪账号内部重试完毕 → 再由外层切换其它 Adobe 后端继续轮换」的两级语义。
 * 非可轮换错误（请求本身 4xx、内容拒绝、模型不支持等）换号无用，立即上抛。
 */
async function runWithAdobeTokenRotation<T>(
  adobeId: string,
  transport: FireflyTransport,
  signal: AbortSignal | undefined,
  run: (token: string) => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const triedTokenIds = new Set<string>();
  const triedAccountIds = new Set<string>();
  let lastError =
    "Adobe 直连无可用账号/token（请在 admin 导入 Adobe cookie 账号）";
  for (let attempt = 1; attempt <= MAX_ADOBE_TOKEN_ROTATION; attempt++) {
    if (signal?.aborted) break;
    const acquired = await acquireToken(adobeId, transport, signal, {
      tokenIds: triedTokenIds,
      accountIds: triedAccountIds,
    });
    if (!acquired) break; // 本后端内已无更多未试过的可用账号
    triedTokenIds.add(acquired.id);
    if (acquired.accountId) triedAccountIds.add(acquired.accountId);
    try {
      return { ok: true, value: await run(acquired.value) };
    } catch (error) {
      // 配额耗尽/鉴权失效是持久态，落库标记便于后续请求跳过；429 等临时态不改 token 状态，
      // 仅本次排除（lastUsedAt 已更新，下次自然排到队尾）。
      if (error instanceof QuotaExhaustedError) {
        await markTokenStatus(acquired.id, "exhausted").catch(() => {});
      } else if (error instanceof AuthError) {
        await markTokenStatus(acquired.id, "invalid").catch(() => {});
      }
      lastError = error instanceof Error ? error.message : "Adobe 直连生成失败";
      if (isAdobeRotatableError(error) && !signal?.aborted) {
        logWarn("Adobe 直连账号失败，换下一个账号重试", {
          source: "adobe-direct-rotate",
          adobeId,
          attempt,
          triedAccounts: triedAccountIds.size,
          error: lastError.slice(0, 160),
        });
        continue;
      }
      logError(error, { source: "adobe-direct-rotate", adobeId, attempt });
      return { ok: false, error: lastError };
    }
  }
  return { ok: false, error: lastError };
}

const ALLOWED_FAMILIES: AdobeImageFamily[] = [
  "gpt-image-2",
  "gpt-image-1.5",
  "nano-banana",
  "nano-banana2",
  "nano-banana-pro",
];

// 从请求 model（firefly-<family> 或 firefly-<family>-<res>-<ratio>）解析模型族；
// 用户在创作页/接口选的具体 Firefly 模型优先，按最长前缀匹配，避免 nano-banana 误吞
// nano-banana-pro / nano-banana2。非 firefly 模型（如普通 gpt-image 经 force_firefly 强制
// 路由到 adobe）一律落到 gpt-image-2，而非后端 enabledModels 首项（可能是 nano-banana）。
export function resolveAdobeFamilyFromModel(
  model: string | null | undefined,
  _enabled?: string[] | null | undefined
): AdobeImageFamily {
  const normalized = String(model || "")
    .trim()
    .toLowerCase();
  if (normalized.startsWith("firefly-")) {
    const rest = normalized.slice("firefly-".length);
    const byLength = [...ALLOWED_FAMILIES].sort((a, b) => b.length - a.length);
    for (const family of byLength) {
      if (rest === family || rest.startsWith(`${family}-`)) {
        return family;
      }
    }
  }
  return "gpt-image-2";
}

/**
 * mode=direct 的 adobe 派发：选 token → 选模型族/尺寸 → 图生图先上传 → generateImage。
 * 出错返回 { error }，由上层管线统一处理（含池上报）。
 */
export async function runAdobeDirectImageRequest(
  config: ApiConfig,
  params: {
    prompt: string;
    model?: string | null;
    size?: string | null;
    quality?: string | null;
    images?: Array<{ data: Buffer; type?: string | null }>;
    signal?: AbortSignal;
  }
): Promise<GenerateImageResult> {
  const adobeId = config.backend?.id;
  if (!adobeId) return { error: "Adobe 直连后端缺少 id" };

  const sessionKey = `adobe-${adobeId}`;
  const { apiTransport, downloadTransport } =
    await buildAdobeTransports(sessionKey);

  // 模型族 + 宽高比/分辨率（与 token 无关，放轮换外只算一次）：family 优先取请求 model
  // （创作页/接口选的 Firefly 模型），非 firefly 模型一律落 gpt-image-2；ratio/res 由 size
  // 映射，缺省走后端默认。
  const family = resolveAdobeFamilyFromModel(params.model);
  const fallbackRatio = (config.backend?.adobeDefaultRatio ||
    "1x1") as AdobeRatio;
  const fallbackResolution = (config.backend?.adobeDefaultResolution ||
    "2k") as AdobeImageResolution;
  const mapped = mapSizeToAdobe(params.size, {
    ratio: fallbackRatio,
    resolution: fallbackResolution,
  });
  const modelId = composeAdobeImageModelId({
    family,
    resolution: mapped.resolution,
    ratio: mapped.ratio,
  });
  const modelConf = resolveFireflyImageModel(modelId);
  if (!modelConf) {
    return { error: `Adobe 直连不支持的模型组合: ${modelId}` };
  }

  const client = new AdobeFireflyClient({
    transport: apiTransport,
    downloadTransport,
  });

  // 伪账号内换号重试：撞 429/配额/鉴权就换本后端下一个账号，轮完才上抛（交外层切后端）。
  const result = await runWithAdobeTokenRotation(
    adobeId,
    apiTransport,
    params.signal,
    async (token) => {
      // 图生图：先上传输入图拿 Adobe image id（与 token 绑定，故放轮换内、每次换号重传）。
      let sourceImageIds: string[] | undefined;
      if (params.images && params.images.length > 0) {
        sourceImageIds = [];
        for (const image of params.images) {
          sourceImageIds.push(
            await client.uploadImage(
              token,
              image.data,
              image.type || "image/png",
              params.signal
            )
          );
        }
      }

      const output = await client.generateImage({
        token,
        prompt: params.prompt,
        aspectRatio: modelConf.aspectRatio,
        outputResolution: modelConf.outputResolution,
        upstreamModelId: modelConf.upstreamModelId,
        upstreamModelVersion: modelConf.upstreamModelVersion,
        // gpt-image 质量改用户操控：用户显式选的 low/medium/high 优先;auto/未选则回退
        // 后端默认或 high。builder 把 low/medium/high → detailLevel 1/3/5,对 nano-banana
        // 忽略,故无条件透传安全。
        qualityLevel:
          params.quality && params.quality !== "auto"
            ? params.quality
            : (config.backend?.adobeGptImageQuality ?? "high"),
        ...(sourceImageIds ? { sourceImageIds } : {}),
        signal: params.signal,
      });
      return output.bytes.toString("base64");
    }
  );
  if (!result.ok) return { error: result.error };
  return { imageBase64: result.value };
}

/**
 * 供 admin 调用：导入一个 Adobe cookie 账号并立即刷新一次（验证 cookie 有效）。
 * 返回账号信息或抛错。
 */
type AdobeCookieValidation = Awaited<
  ReturnType<typeof refreshAccessTokenFromCookie>
>;

// 验证一个 Adobe cookie：刷新一次拿 access_token + 账号信息，并断言为已登录（非 guest）。
// sessionKey 沿用 `adobe-<adobeId>`（与历史单条导入一致；只影响代理出口会话路由）。
async function validateAdobeCookie(
  adobeId: string,
  cookie: string,
  scope?: string | null
): Promise<AdobeCookieValidation> {
  const { apiTransport } = await buildAdobeTransports(`adobe-${adobeId}`);
  const result = await refreshAccessTokenFromCookie(apiTransport, cookie, {
    scope: scope ?? undefined,
    fetchAccount: true,
  });
  assertLoggedInAdobeCookie(result.accessToken, result.account);
  return result;
}

// 持久化一个已验证的 Adobe 账号：写 adobeAccount + 初始 auto_refresh adobeToken。
// 额外回传 accountUserId（IMS 稳定身份），供批量导入去重使用。
async function persistAdobeAccount(
  input: {
    adobeId: string;
    name?: string;
    cookie: string;
    scope?: string | null;
    headers?: { "x-arp-session-id": string };
  },
  validated: AdobeCookieValidation
): Promise<{
  id: string;
  displayName: string;
  email: string;
  accountUserId: string | null;
}> {
  const id = nanoid();
  const account = validated.account;
  const now = new Date();

  await db.insert(adobeAccount).values({
    id,
    adobeId: input.adobeId,
    name: input.name?.trim() || account?.displayName || account?.email || id,
    cookie: input.cookie,
    scope: input.scope ?? null,
    isEnabled: true,
    displayName: account?.displayName || null,
    email: account?.email || null,
    accountUserId: account?.userId || null,
    status: "active",
    lastRefreshAt: now,
    ...(input.headers ? { metadata: { fireflyHeaders: input.headers } } : {}),
  });

  await db.insert(adobeToken).values({
    id: nanoid(),
    adobeId: input.adobeId,
    accountId: id,
    value: validated.accessToken,
    accountUserId: account?.userId || null,
    status: "active",
    source: "auto_refresh",
    expiresAt: tokenExpiresAt(validated.accessToken),
  });

  return {
    id,
    displayName: account?.displayName || "",
    email: account?.email || "",
    accountUserId: account?.userId || null,
  };
}

export async function importAdobeAccount(input: {
  adobeId: string;
  name?: string;
  cookie: string;
  scope?: string | null;
}): Promise<{ id: string; displayName: string; email: string }> {
  const parsedEntries = parseAdobeCookieEntries(input.cookie);
  const [entry] = parsedEntries;
  if (!entry || parsedEntries.length !== 1) {
    throw new Error("单条导入需要且只能包含一个 Adobe cookie");
  }
  const validated = await validateAdobeCookie(
    input.adobeId,
    entry.cookie,
    entry.scope ?? input.scope
  );
  const { id, displayName, email } = await persistAdobeAccount(
    {
      ...input,
      cookie: entry.cookie,
      name: input.name ?? entry.name,
      scope: entry.scope ?? input.scope,
      headers: entry.headers,
    },
    validated
  );
  return { id, displayName, email };
}

export type AdobeAccountImportOutcome = {
  index: number;
  status: "imported" | "skipped" | "failed";
  accountId?: string;
  displayName?: string;
  email?: string;
  reason?: string;
};

export type AdobeAccountBatchImportResult = {
  total: number;
  imported: number;
  skipped: number;
  failed: number;
  results: AdobeAccountImportOutcome[];
  firstError?: string;
};

/**
 * 供 admin 调用：在某个 Adobe 后端（伪账号）下批量导入真实 Adobe 账号。
 * - 解析 cookie 文本（每行一个 / JSON 数组，见 adobe-cookie-parser）。
 * - 逐条刷新验证（best-effort）：单条失败不影响其余，逐条回报原因。
 * - 去重：同一 Adobe 用户（accountUserId，IMS 稳定身份；cookie 会轮换）或同邮箱已存在则
 *   跳过——既防重复粘贴，也防同一批内重复。
 * 串行执行：避免对 Adobe IMS 造成突发压力，并保证去重集一致。每条成功即落库（非单一大
 * 事务），因此即便整体请求中途超时也不丢已导入数据，重新粘贴会按身份自动跳过已导入项。
 */
export async function importAdobeAccountsBatch(input: {
  adobeId: string;
  cookiesText: string;
  namePrefix?: string;
  scope?: string | null;
}): Promise<AdobeAccountBatchImportResult> {
  const entries = parseAdobeCookieEntries(input.cookiesText);
  if (entries.length === 0) {
    return { total: 0, imported: 0, skipped: 0, failed: 0, results: [] };
  }

  // 预取该后端已存在账号的稳定身份，用于跨次/批内去重。
  const existing = await db
    .select({
      accountUserId: adobeAccount.accountUserId,
      email: adobeAccount.email,
    })
    .from(adobeAccount)
    .where(eq(adobeAccount.adobeId, input.adobeId));
  const seenUserIds = new Set<string>();
  const seenEmails = new Set<string>();
  for (const row of existing) {
    if (row.accountUserId) seenUserIds.add(row.accountUserId);
    if (row.email) seenEmails.add(row.email.toLowerCase());
  }

  const results: AdobeAccountImportOutcome[] = [];
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  let firstError: string | undefined;

  for (const [index, entry] of entries.entries()) {
    const scope = entry.scope ?? input.scope ?? null;
    const fallbackName = input.namePrefix?.trim()
      ? `${input.namePrefix.trim()}-${index + 1}`
      : undefined;
    const name = entry.name?.trim() || fallbackName;
    try {
      const validated = await validateAdobeCookie(
        input.adobeId,
        entry.cookie,
        scope
      );
      const userId = validated.account?.userId || null;
      const email = validated.account?.email?.toLowerCase() || null;
      if (
        (userId && seenUserIds.has(userId)) ||
        (email && seenEmails.has(email))
      ) {
        skipped++;
        results.push({
          index,
          status: "skipped",
          reason: "已存在相同 Adobe 账号，已跳过",
          displayName: validated.account?.displayName || undefined,
          email: validated.account?.email || undefined,
        });
        continue;
      }
      const persisted = await persistAdobeAccount(
        {
          adobeId: input.adobeId,
          name,
          cookie: entry.cookie,
          scope,
          headers: entry.headers,
        },
        validated
      );
      if (userId) seenUserIds.add(userId);
      if (email) seenEmails.add(email);
      imported++;
      results.push({
        index,
        status: "imported",
        accountId: persisted.id,
        displayName: persisted.displayName || undefined,
        email: persisted.email || undefined,
      });
    } catch (error) {
      failed++;
      const reason = error instanceof Error ? error.message : "导入失败";
      if (!firstError) firstError = reason;
      results.push({ index, status: "failed", reason });
      logError(error, {
        source: "adobe-direct-batch-import",
        adobeId: input.adobeId,
        index,
      });
    }
  }

  return {
    total: entries.length,
    imported,
    skipped,
    failed,
    results,
    ...(firstError ? { firstError } : {}),
  };
}

/** 列出某 adobe 后端的账号（admin 用）。不返回 cookie 明文。 */
export async function listAdobeAccounts(adobeId: string): Promise<
  Array<{
    id: string;
    name: string;
    displayName: string | null;
    email: string | null;
    isEnabled: boolean;
    status: string;
    lastRefreshAt: Date | null;
    lastRefreshError: string | null;
    consecutiveFailures: number;
    creditsTotal: number | null;
    creditsUsed: number | null;
    creditsAvailable: number | null;
    creditsUpdatedAt: Date | null;
    creditsError: string | null;
  }>
> {
  // 左连账号的 auto_refresh token，带出最新的 Firefly 余额（运营展示）。
  return db
    .select({
      id: adobeAccount.id,
      name: adobeAccount.name,
      displayName: adobeAccount.displayName,
      email: adobeAccount.email,
      isEnabled: adobeAccount.isEnabled,
      status: adobeAccount.status,
      lastRefreshAt: adobeAccount.lastRefreshAt,
      lastRefreshError: adobeAccount.lastRefreshError,
      consecutiveFailures: adobeAccount.consecutiveFailures,
      creditsTotal: adobeToken.creditsTotal,
      creditsUsed: adobeToken.creditsUsed,
      creditsAvailable: adobeToken.creditsAvailable,
      creditsUpdatedAt: adobeToken.creditsUpdatedAt,
      creditsError: adobeToken.creditsError,
    })
    .from(adobeAccount)
    .leftJoin(
      adobeToken,
      and(
        eq(adobeToken.accountId, adobeAccount.id),
        eq(adobeToken.source, "auto_refresh")
      )
    )
    .where(eq(adobeAccount.adobeId, adobeId))
    .orderBy(asc(adobeAccount.createdAt));
}

/** 删除一个 Adobe 账号（其 token 经 FK cascade 一并删除）。 */
export async function deleteAdobeAccount(id: string): Promise<void> {
  await db.delete(adobeAccount).where(eq(adobeAccount.id, id));
}

/** 启用/停用一个 Adobe 账号。停用即不再参与刷新/出图。 */
export async function setAdobeAccountEnabled(
  id: string,
  isEnabled: boolean
): Promise<void> {
  await db
    .update(adobeAccount)
    .set({
      isEnabled,
      ...(isEnabled
        ? { status: "active", lastRefreshError: null, consecutiveFailures: 0 }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(adobeAccount.id, id));
}

export { fetchAccountInfo };
