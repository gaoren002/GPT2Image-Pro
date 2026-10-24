/** PL12稳定账户键；仅匹配可信OAuth响应/已存凭据，不进行JWT验签或授予用户身份。 */
import { createHash } from "node:crypto";
export type OAuthIdentity = { workspace: string; user: string; key: string };
/** 轮换请求键不随加密密钥变化，只识别同一client下的原RT。 */
export function oauthRotationKey(refreshToken: string, clientId: string) {
  return createHash("sha256")
    .update(JSON.stringify(["pool-oauth:v1", clientId, refreshToken]))
    .digest("hex");
}
/** 错误不携带JWT、原始claim或解析器异常。 */
function invalidIdentity(): never {
  throw new Error("OAuth账户身份缺失或冲突；轮换结果须保留待恢复");
}
/** 公开claim有界读取；AT可为opaque，身份仍须由同一可信响应中的ID token提供。 */
function identityParts(token: string) {
  let claims: Record<string, unknown>;
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1] || parts[1].length > 65_536) return {};
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8")
    ) as Record<string, unknown>;
    const auth = payload["https://api.openai.com/auth"];
    if (!auth || typeof auth !== "object" || Array.isArray(auth)) return {};
    claims = auth as Record<string, unknown>;
  } catch {
    return {};
  }
  const workspace = claims.chatgpt_account_id;
  const user = claims.chatgpt_user_id ?? claims.user_id;
  if (
    claims.chatgpt_user_id !== undefined &&
    claims.user_id !== undefined &&
    claims.chatgpt_user_id !== claims.user_id
  )
    invalidIdentity();
  if (
    workspace !== undefined &&
    (typeof workspace !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(workspace))
  )
    invalidIdentity();
  if (
    user !== undefined &&
    (typeof user !== "string" || !/^[A-Za-z0-9_|:-]{1,256}$/.test(user))
  )
    invalidIdentity();
  return {
    workspace: workspace as string | undefined,
    user: user as string | undefined,
  };
}
/** 身份proof重新计算key，不能只信数据库里的一串摘要。 */
export function oauthIdentityProof(
  workspace: unknown,
  user: unknown
): OAuthIdentity {
  if (
    typeof workspace !== "string" ||
    typeof user !== "string" ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(workspace) ||
    !/^[A-Za-z0-9_|:-]{1,256}$/.test(user)
  )
    invalidIdentity();
  return {
    workspace,
    user,
    key: createHash("sha256")
      .update(JSON.stringify(["openai", workspace, user]))
      .digest("hex"),
  };
}
/** 不从email/sub/外部metadata猜测单个AT的账户身份。 */
export function oauthIdentity(accessToken: string): OAuthIdentity {
  const parts = identityParts(accessToken);
  return oauthIdentityProof(parts.workspace, parts.user);
}
/** 官方Codex以ID token读取用户/workspace；AT若也提供对应字段则必须一致。 */
export function oauthResponseIdentity(
  accessToken: string,
  idToken?: string
): OAuthIdentity {
  const at = identityParts(accessToken),
    id = idToken ? identityParts(idToken) : {};
  if (
    (at.workspace && id.workspace && at.workspace !== id.workspace) ||
    (at.user && id.user && at.user !== id.user)
  )
    invalidIdentity();
  return oauthIdentityProof(at.workspace ?? id.workspace, at.user ?? id.user);
}

/** 已保存的可信proof只补缺失字段，不能覆盖AT中显式矛盾的用户/workspace。 */
export function oauthStoredIdentity(
  accessToken: string,
  workspace: unknown,
  user: unknown
) {
  const proof = oauthIdentityProof(workspace, user),
    at = identityParts(accessToken);
  if (
    (at.workspace && at.workspace !== proof.workspace) ||
    (at.user && at.user !== proof.user)
  )
    invalidIdentity();
  return proof;
}
