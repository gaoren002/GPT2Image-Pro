/** 调度和测活共用的鉴权错误判定；只认状态码语法或明确凭据错误，不匹配随机 ID。 */

/** 提取错误前缀中的第一个 HTTP 状态，缺少明确状态语法时返回 undefined。 */
export function getBackendHttpStatus(error: string): number | undefined {
  const match = error.match(
    /\b(?:http(?:\/\d(?:\.\d)?)?|status(?:[_ ]code)?)\s*[:=]?\s+([1-5]\d{2})\b|\bstatus(?:[_ ]code)?\s*[:=]\s*([1-5]\d{2})\b|\bfailed\s*\(([1-5]\d{2})\)|^([1-5]\d{2})(?:\s|:)/i
  );
  const value = match?.slice(1).find((part) => part !== undefined);
  return value ? Number(value) : undefined;
}

/** 5xx 表示上游故障；其正文中的鉴权服务描述不能使成员永久下线。 */
export function isInvalidBackendCredentialError(error?: string | null) {
  const normalized = (error || "").trim().toLowerCase();
  const status = getBackendHttpStatus(normalized);
  if (status === 401 || status === 403) return true;
  if (status !== undefined && status >= 500) return false;
  return (
    /^(?:unauthorized|forbidden)(?:[.:]|$)/.test(normalized) ||
    /\b(?:invalid_api_key|invalid_access_token|token_invalidated|token_revoked)\b/.test(
      normalized
    ) ||
    normalized.includes("invalid api key") ||
    normalized.includes("invalid access token") ||
    normalized.includes("invalid auth") ||
    normalized.includes("authentication failed") ||
    normalized.includes("authentication token has been invalidated") ||
    normalized.includes("token has been invalidated") ||
    normalized.includes("token expired") ||
    normalized.includes("expired token") ||
    normalized.includes("token is expired") ||
    normalized.includes("access token expired") ||
    normalized.includes("signing in again") ||
    normalized.includes("please sign in again")
  );
}
