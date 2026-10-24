/** PL12 轮换的持久计划；不含调用者凭据，令牌只在加密计划和账号凭据列内传递。 */
export type OAuthMode = "web" | "responses";
export type OAuthAccountTarget = {
  id?: string;
  groupId?: string | null;
  groupIds?: string[] | null;
  mergeGroupIds?: boolean;
  name: string;
  email?: string | null;
  implementationMode: OAuthMode;
  model?: string | null;
  qualityBilling?: Partial<Record<string, number>> | null;
  contentSafetyEnabled: boolean;
  isEnabled: boolean;
  alwaysActive?: boolean;
  priority: number;
  concurrency: number;
  status?: string;
  cooldownUntil?: Date | string | null;
  lastError?: string | null;
  lastErrorAt?: Date | string | null;
  metadata?: Record<string, unknown> | null;
  expectedCredentialHash?: string;
};
export type OAuthRotationPlan = {
  version: 1;
  id: string;
  owner: string;
  /** 根目录、持久卷标识及加密密钥的摘要；旧未绑定计划只能显式迁移，不能新外呼。 */
  journalIdentity?: string;
  clientId: string;
  idToken?: string;
  accessToken: string;
  refreshToken: string;
  rotated: boolean;
  targets: OAuthAccountTarget[];
};
export type OAuthStoredAccount = { id: string; mode: OAuthMode };

/** owner限定引用是唯一恢复/清理单位；重开同一操作不复用旧owner路径。 */
export function oauthCheckpointRef(
  plan: Pick<OAuthRotationPlan, "id" | "owner">
) {
  return `${plan.id}.${plan.owner}`;
}

/** 错误仅含固定说明和不透明恢复ID，不持有原始驱动/网络异常或令牌。 */
export class OAuthRecoveryError extends Error {
  constructor(
    readonly recoveryId: string,
    readonly pending = true
  ) {
    super(
      pending
        ? "轮换结果已暂存或状态不确定，请重试补写；勿重复刷新旧RT"
        : "OAuth轮换未执行，请检查持久化配置"
    );
    this.name = "OAuthRecoveryError";
  }
}
