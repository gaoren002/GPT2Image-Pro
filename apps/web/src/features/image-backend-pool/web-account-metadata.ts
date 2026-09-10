/**
 * 解析 ChatGPT Web access token 的 workspace claim，并安全合并账号 metadata。
 * 供后端池账号导入、换绑和请求配置复用；不校验或保存 JWT 凭据。
 */
import type { ImageBackendAccountBackend } from "./types";

/** 判断 JWT claim 是否为可安全索引的普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 从公开 JWT payload 读取 workspace id；畸形或不支持的 token 返回空字符串。 */
export function chatGptAccountIdFromAccessToken(accessToken: string) {
  const token = accessToken.trim().replace(/^Bearer\s+/i, "");
  const payloadSegment = token.split(".")[1];
  if (!payloadSegment || payloadSegment.length > 65_536) return "";
  try {
    const parsedPayload = JSON.parse(
      Buffer.from(payloadSegment, "base64url").toString("utf8")
    ) as unknown;
    if (!isRecord(parsedPayload)) return "";
    const authClaim = parsedPayload["https://api.openai.com/auth"];
    const nestedAccountId = isRecord(authClaim)
      ? authClaim.chatgpt_account_id
      : undefined;
    // 兼容少量旧导入工具生成的扁平 claim；现网 token 使用嵌套 auth 对象。
    const accountId =
      typeof nestedAccountId === "string"
        ? nestedAccountId
        : parsedPayload["https://api.openai.com/auth.chatgpt_account_id"];
    if (typeof accountId !== "string") return "";
    const normalized = accountId.trim();
    return /^[A-Za-z0-9_-]{1,256}$/.test(normalized) ? normalized : "";
  } catch {
    return "";
  }
}

/** Web token 中的 workspace claim 覆盖旧值，同时保留其他账号 metadata。 */
export function mergeChatGptAccountIdMetadata(
  metadata: Record<string, unknown> | null | undefined,
  accessToken: string,
  implementationMode: ImageBackendAccountBackend
) {
  if (implementationMode !== "web") return metadata;
  const chatgptAccountId = chatGptAccountIdFromAccessToken(accessToken);
  return chatgptAccountId
    ? { ...(metadata || {}), chatgptAccountId }
    : metadata;
}
