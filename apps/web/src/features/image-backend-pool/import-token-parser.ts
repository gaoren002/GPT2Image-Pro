/** 管理端与服务端共用的令牌导入解析；限制 UTF-8 字节数，JWT 扫描单向前进。 */
export const MAX_TOKEN_IMPORT_BYTES = 32 * 1024 * 1024;

type TokenParseMode = "refresh" | "access" | "none";

/** 首尾游标剥离包装字符；不使用未锚定的尾部重复正则。 */
function normalizeImportedToken(value: string | null | undefined) {
  let token = value?.trim() || "";
  for (let pass = 0; pass < 2; pass++) {
    token = token.replace(/^Bearer\s+/i, "").trim();
    let start = 0;
    let end = token.length;
    while (start < end && "\"'`".includes(token.charAt(start))) start++;
    while (end > start && "\"'`,;".includes(token.charAt(end - 1))) end--;
    token = token.slice(start, end).trim();
  }
  return token;
}

function addToken(tokens: Set<string>, value: string | null | undefined) {
  const token = normalizeImportedToken(value);
  if (token) tokens.add(token);
}

function isRefreshToken(value: string) {
  return /^rt_[A-Za-z0-9._~+/=-]+$/.test(normalizeImportedToken(value));
}

function isLikelyPlainAccessToken(value: string) {
  const token = normalizeImportedToken(value);
  if (!token || token.startsWith("rt_")) return false;
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){1,3}$/.test(token)) {
    return true;
  }
  return token.length >= 80 && !/\s/.test(token);
}

function addAccessToken(tokens: Set<string>, value: string | null | undefined) {
  const token = normalizeImportedToken(value);
  if (token && token.length >= 40 && !token.startsWith("rt_")) {
    tokens.add(token);
  }
}

/** 迭代遍历 JSON 导出，避免深层结构耗尽调用栈；只提取约定字段/数组字符串。 */
function collectTokensFromJson(
  value: unknown,
  tokens: { refreshTokens: Set<string>; accessTokens: Set<string> },
  mode: TokenParseMode
) {
  const pending: Array<{
    value: unknown;
    allowBareString: boolean;
    kind?: "access" | "refresh";
  }> = [{ value, allowBareString: false }];
  while (pending.length) {
    const entry = pending.pop();
    if (!entry) break;
    const item = entry.value;
    if (typeof item === "string") {
      if (entry.kind === "refresh") {
        addToken(tokens.refreshTokens, item);
        continue;
      }
      if (entry.kind === "access") {
        addAccessToken(tokens.accessTokens, item);
        continue;
      }
      if (!entry.allowBareString) continue;
      const token = normalizeImportedToken(item);
      if (mode === "refresh" && isRefreshToken(token))
        tokens.refreshTokens.add(token);
      if (mode === "access" && isLikelyPlainAccessToken(token))
        tokens.accessTokens.add(token);
    } else if (Array.isArray(item)) {
      for (let i = item.length - 1; i >= 0; i--)
        pending.push({ value: item[i], allowBareString: true });
    } else if (item && typeof item === "object") {
      const entries = Object.entries(item);
      for (let i = entries.length - 1; i >= 0; i--) {
        const pair = entries[i];
        if (!pair) continue;
        const [key, child] = pair;
        const normalized = key.toLowerCase().replace(/[-_\s]/g, "");
        const kind = ["refreshtoken", "rt", "refresh"].includes(normalized)
          ? "refresh"
          : ["accesstoken", "at", "access"].includes(normalized)
            ? "access"
            : undefined;
        pending.push({ value: child, allowBareString: false, kind });
      }
    }
  }
}

/**
 * 按字符段扫描 JWT，段与游标只向前；无点的 eyJ 重复串只扫一次。
 * 签名中的 eyJ 仅在后面确有另一个三段 JWT 时用作无分隔拼接边界。
 */
function scanJwtTokens(value: string, tokens: Set<string>) {
  for (const run of value.matchAll(/[A-Za-z0-9_.-]+/g)) {
    const parts = run[0].split(".");
    let index = 0;
    let headerStart = 0;
    while (index + 2 < parts.length) {
      const header = parts[index] || "";
      const start = header.indexOf("eyJ", headerStart);
      const payload = parts[index + 1] || "";
      const signature = parts[index + 2] || "";
      if (start < 0 || header.length <= start + 3 || !payload || !signature) {
        index++;
        headerStart = 0;
        continue;
      }
      const nextHeader = signature.lastIndexOf("eyJ");
      const concatenated =
        nextHeader > 0 &&
        signature.length > nextHeader + 3 &&
        Boolean(parts[index + 3] && parts[index + 4]);
      addAccessToken(
        tokens,
        `${header.slice(start)}.${payload}.${concatenated ? signature.slice(0, nextHeader) : signature}`
      );
      if (concatenated) {
        index += 2;
        headerStart = nextHeader;
      } else {
        index += 3;
        headerStart = 0;
      }
    }
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractNamedTokens(value: string, names: string[]) {
  const namePattern = names.map(escapeRegExp).join("|");
  const pattern = new RegExp(
    `(?:^|[\\s,{\\[])(?:"(?:${namePattern})"|'(?:${namePattern})'|(?:${namePattern}))\\s*[:=]\\s*(?:"([^"]+)"|'([^']+)'|([^"',}\\]\\s;]+))`,
    "gi"
  );
  const results: string[] = [];
  for (const match of value.matchAll(pattern)) {
    const token = match[1] || match[2] || match[3];
    if (token) results.push(token);
  }
  return results;
}

function lineTokenCandidate(value: string) {
  const line = value.trim();
  if (!line) return "";
  const bearerMatch = line.match(/\bBearer\s+([^\s"'`,;]+)/i);
  if (bearerMatch?.[1]) return normalizeImportedToken(bearerMatch[1]);
  return normalizeImportedToken(line.replace(/^[>\-*•\s]+/, ""));
}

function addPlainFallbackTokens(
  value: string,
  tokens: { refreshTokens: Set<string>; accessTokens: Set<string> },
  mode: TokenParseMode
) {
  for (const line of value.split(/\r?\n/g)) {
    const token = lineTokenCandidate(line);
    if (mode === "refresh" && token) {
      tokens.refreshTokens.add(token);
    }
    if (mode === "access" && isLikelyPlainAccessToken(token)) {
      tokens.accessTokens.add(token);
    }
  }

  for (const item of value.split(/[\s,;]+/g)) {
    const token = normalizeImportedToken(item);
    if (mode === "refresh" && token) {
      tokens.refreshTokens.add(token);
    }
    if (mode === "access" && isLikelyPlainAccessToken(token)) {
      tokens.accessTokens.add(token);
    }
  }
}

export function parseImportTokensText(
  value: string,
  options: { plainFallback: TokenParseMode } = {
    plainFallback: "refresh",
  }
) {
  // 先按 UTF-16 长度拒绝超大文本，再计算 UTF-8；浏览器和 Node 使用同一上限。
  if (
    value.length > MAX_TOKEN_IMPORT_BYTES ||
    new TextEncoder().encode(value).byteLength > MAX_TOKEN_IMPORT_BYTES
  ) {
    throw new Error("令牌导入内容不能超过 32 MiB，请分批导入");
  }
  const tokens = {
    refreshTokens: new Set<string>(),
    accessTokens: new Set<string>(),
  };

  try {
    collectTokensFromJson(JSON.parse(value), tokens, options.plainFallback);
    if (tokens.refreshTokens.size || tokens.accessTokens.size) {
      return {
        refreshTokens: Array.from(tokens.refreshTokens),
        accessTokens: Array.from(tokens.accessTokens),
      };
    }
  } catch {
    // Plain RT/AT lists and copied pages are handled by the text parser below.
  }

  for (const match of value.matchAll(/\brt_[A-Za-z0-9._~+/=-]+/g)) {
    tokens.refreshTokens.add(match[0]);
  }

  scanJwtTokens(value, tokens.accessTokens);

  for (const token of extractNamedTokens(value, [
    "refresh_token",
    "refreshToken",
    "rt",
  ])) {
    addToken(tokens.refreshTokens, token);
  }
  for (const token of extractNamedTokens(value, [
    "access_token",
    "accessToken",
    "at",
  ])) {
    addAccessToken(tokens.accessTokens, token);
  }

  const looksStructured =
    /(?:^|[\s{,])["']?(?:access[_-]?token|accessToken|refresh[_-]?token|refreshToken)["']?\s*[:=]/i.test(
      value
    );
  if (
    !tokens.refreshTokens.size &&
    !tokens.accessTokens.size &&
    !looksStructured
  ) {
    addPlainFallbackTokens(value, tokens, options.plainFallback);
  }

  return {
    refreshTokens: Array.from(tokens.refreshTokens),
    accessTokens: Array.from(tokens.accessTokens),
  };
}
