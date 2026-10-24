/** PL12 本地短事务：意图唯一认领、稳定身份去重、账号/分组/完成状态同提交；不外呼或读设置。 */
import { createHash } from "node:crypto";
import { db } from "@repo/database";
import {
  imageBackendAccount,
  imageBackendAccountGroup,
  imageBackendTokenRotation,
} from "@repo/database/schema";
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { oauthJournal } from "./oauth-rotation-journal";
import { resolveOAuthJournalRoot } from "./oauth-journal-path";
import { chatGptAccountIdFromAccessToken } from "./web-account-metadata";
import {
  oauthIdentity,
  oauthResponseIdentity,
  oauthRotationKey,
  oauthStoredIdentity,
} from "./oauth-identity";
import {
  OAuthRecoveryError,
  type OAuthAccountTarget,
  type OAuthRotationPlan,
  type OAuthStoredAccount,
} from "./oauth-rotation-types";

/** 不经运行时缓存认领；同一旧RT只允许一个远端请求，prepared/uncertain不按租约猜测重放。 */
export async function prepareOAuthRotation(
  id: string,
  owner: string,
  clientId: string,
  sourceRefreshToken: string,
  journalIdentity?: string
) {
  // 配置/文件I/O在事务外；调用者传的是已经完成预检的身份摘要，不在锁内取配置。
  const binding =
    journalIdentity ??
    (await oauthJournal(await resolveOAuthJournalRoot()).binding());
  return db.transaction(async (tx) => {
    // 所有新建/重开意图共用此短锁：检查与claim不能被另一root的claim穿插。
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('pool-oauth-journal-binding:v1', 0))`
    );
    const [foreign] = await tx
      .select()
      .from(imageBackendTokenRotation)
      .where(
        and(
          inArray(imageBackendTokenRotation.state, [
            "prepared",
            "uncertain",
            "ready",
          ]),
          or(
            isNull(imageBackendTokenRotation.journalIdentity),
            ne(imageBackendTokenRotation.journalIdentity, binding)
          )
        )
      )
      .limit(1);
    if (foreign)
      throw new OAuthRecoveryError("journal-binding-mismatch", false);
    const [inserted] = await tx
      .insert(imageBackendTokenRotation)
      .values({
        id,
        owner,
        clientId,
        journalIdentity: binding,
        state: "prepared",
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) return { row: inserted, claimed: true };
    const [row] = await tx
      .select()
      .from(imageBackendTokenRotation)
      .where(eq(imageBackendTokenRotation.id, id))
      .limit(1);
    if (!row || row.clientId !== clientId) throw new OAuthRecoveryError(id);
    // 部分provider刷新不轮换RT。只有已完成且账号仍明确保存同一RT时才可开启下一轮；
    // prepared/uncertain绝不能据此重试，远端是否消费仍不可知。
    const accountId = row.state === "done" ? row.accounts?.[0]?.id : undefined;
    if (accountId) {
      const [account] = await tx
        .select()
        .from(imageBackendAccount)
        .where(eq(imageBackendAccount.id, accountId))
        .limit(1);
      if (account?.refreshToken === sourceRefreshToken) {
        const [reopened] = await tx
          .update(imageBackendTokenRotation)
          .set({
            owner,
            journalIdentity: binding,
            state: "prepared",
            encryptedPlan: null,
            accounts: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(imageBackendTokenRotation.id, id),
              eq(imageBackendTokenRotation.owner, row.owner),
              eq(imageBackendTokenRotation.state, "done")
            )
          )
          .returning();
        if (reopened) return { row: reopened, claimed: true };
        throw new OAuthRecoveryError(id);
      }
    }
    return { row, claimed: false };
  });
}

/** 数据库也是加密结果的恢复副本；只接受预先认领的同一owner，不能被迟到请求覆盖新意图。 */
export async function stageOAuthRotation(
  plan: OAuthRotationPlan,
  encryptedPlan: string
) {
  const rows = await db
    .update(imageBackendTokenRotation)
    .set({ state: "ready", encryptedPlan, updatedAt: new Date() })
    .where(
      and(
        eq(imageBackendTokenRotation.id, plan.id),
        eq(imageBackendTokenRotation.owner, plan.owner),
        eq(
          imageBackendTokenRotation.journalIdentity,
          plan.journalIdentity ?? ""
        ),
        inArray(imageBackendTokenRotation.state, [
          "prepared",
          "uncertain",
          "ready",
        ])
      )
    )
    .returning({ id: imageBackendTokenRotation.id });
  if (!rows.length) {
    const [row] = await db
      .select()
      .from(imageBackendTokenRotation)
      .where(eq(imageBackendTokenRotation.id, plan.id))
      .limit(1);
    if (
      row?.state !== "done" ||
      row.owner !== plan.owner ||
      row.journalIdentity !== plan.journalIdentity
    )
      throw new OAuthRecoveryError(plan.id);
  }
}

/**
 * 判断磁盘计划的 owner 是否已被取代：当前行为 done 且 owner 不同。owner 只会在上一轮
 * done 后经 CAS 重开时更换，此时旧轮计划已提交、不可能再补写。行不存在或仍未完成时
 * 返回 false，按失败保留。该判定依赖数据库单调，调用方只做隔离而不删除文件。
 */
export async function isOAuthRotationSuperseded(
  plan: Pick<OAuthRotationPlan, "id" | "owner">
) {
  const [row] = await db
    .select()
    .from(imageBackendTokenRotation)
    .where(eq(imageBackendTokenRotation.id, plan.id))
    .limit(1);
  return !!row && row.state === "done" && row.owner !== plan.owner;
}

/** 标记外呼结果不明；不保存可能回显令牌的网络错误正文。 */
export async function markOAuthRotationUncertain(id: string, owner: string) {
  await db
    .update(imageBackendTokenRotation)
    .set({ state: "uncertain", updatedAt: new Date() })
    .where(
      and(
        eq(imageBackendTokenRotation.id, id),
        eq(imageBackendTokenRotation.owner, owner),
        eq(imageBackendTokenRotation.state, "prepared")
      )
    );
}

/** DB结果副本支持进程重启后的补写；同一失败不阻止其他独立意图。 */
export async function pendingOAuthRotations() {
  return db
    .select()
    .from(imageBackendTokenRotation)
    .where(eq(imageBackendTokenRotation.state, "ready"))
    .orderBy(asc(imageBackendTokenRotation.createdAt))
    .limit(100);
}

/** 旧AT缺claim时仅接受此前可信轮换保存的完整proof；不能只按workspace归并。 */
function storedIdentity(row: typeof imageBackendAccount.$inferSelect) {
  try {
    return oauthIdentity(row.accessToken);
  } catch {
    const proof = row.metadata?.oauthIdentity;
    if (
      !row.oauthIdentityKey ||
      typeof row.metadata?.oauthRotationId !== "string" ||
      !proof ||
      typeof proof !== "object" ||
      !("workspace" in proof) ||
      !("user" in proof)
    )
      throw new Error("账户身份无法确认");
    const identity = oauthStoredIdentity(
      row.accessToken,
      proof.workspace,
      proof.user
    );
    if (identity.key !== row.oauthIdentityKey) throw new Error("账户身份冲突");
    return identity;
  }
}

/** 固定字段生成更新，禁止将内部恢复参数或原始凭据混入用户metadata。 */
function accountValues(target: OAuthAccountTarget) {
  return {
    name: target.name,
    email: target.email ?? null,
    implementationMode: target.implementationMode,
    model: target.model ?? null,
    contentSafetyEnabled: target.contentSafetyEnabled,
    isEnabled: target.isEnabled,
    priority: target.priority,
    concurrency: target.concurrency,
    status: target.status ?? "active",
    updatedAt: new Date(),
    ...(target.alwaysActive !== undefined
      ? { alwaysActive: target.alwaysActive }
      : {}),
    ...(target.qualityBilling !== undefined
      ? { qualityBilling: target.qualityBilling }
      : {}),
    ...(target.cooldownUntil !== undefined
      ? {
          cooldownUntil:
            target.cooldownUntil === null
              ? null
              : new Date(target.cooldownUntil),
        }
      : {}),
    ...(target.lastError !== undefined ? { lastError: target.lastError } : {}),
    ...(target.lastErrorAt !== undefined
      ? {
          lastErrorAt:
            target.lastErrorAt === null ? null : new Date(target.lastErrorAt),
        }
      : {}),
  };
}

/** 每个接口模式仅保留一个可调度身份；旧重复行停用而不删除，保留正在结束的租约和审计。 */
export async function commitOAuthRotation(
  plan: OAuthRotationPlan
): Promise<OAuthStoredAccount[]> {
  if (!plan.accessToken.trim()) throw new OAuthRecoveryError(plan.id);
  const identity = oauthResponseIdentity(plan.accessToken, plan.idToken);
  return db.transaction(async (tx) => {
    const [intent] = await tx
      .select()
      .from(imageBackendTokenRotation)
      .where(eq(imageBackendTokenRotation.id, plan.id))
      .for("update");
    if (
      !intent ||
      intent.owner !== plan.owner ||
      !plan.journalIdentity ||
      intent.journalIdentity !== plan.journalIdentity
    )
      throw new OAuthRecoveryError(plan.id);
    if (intent.state === "done") return intent.accounts ?? [];
    if (intent.state !== "ready") throw new OAuthRecoveryError(plan.id);
    /** 后继引用必须仍指向同一账户身份，不能仅信完成记录里的ID。 */
    const checkSuccessorAccount = async (account: OAuthStoredAccount) => {
      const [row] = await tx
        .select()
        .from(imageBackendAccount)
        .where(eq(imageBackendAccount.id, account.id))
        .limit(1);
      if (
        !row ||
        row.implementationMode !== account.mode ||
        storedIdentity(row).key !== identity.key
      )
        throw new OAuthRecoveryError(plan.id);
    };
    const successorId = oauthRotationKey(plan.refreshToken, plan.clientId);
    if (successorId !== plan.id) {
      // 若这份新RT已有后继轮换，不能再把它作为最新凭据写回；普通读避免反向持锁。
      const [successor] = await tx
        .select()
        .from(imageBackendTokenRotation)
        .where(eq(imageBackendTokenRotation.id, successorId))
        .limit(1);
      if (successor) {
        const newer = successor.accounts ?? [];
        if (
          successor.state !== "done" ||
          plan.targets.some(
            (target) =>
              !newer.some(
                (account) => account.mode === target.implementationMode
              )
          )
        )
          throw new OAuthRecoveryError(plan.id);
        const accounts = newer.filter((account) =>
          plan.targets.some(
            (target) => target.implementationMode === account.mode
          )
        );
        for (const account of accounts) await checkSuccessorAccount(account);
        await tx
          .update(imageBackendTokenRotation)
          .set({
            state: "done",
            encryptedPlan: null,
            accounts,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(imageBackendTokenRotation.id, plan.id),
              eq(imageBackendTokenRotation.owner, plan.owner)
            )
          );
        return accounts;
      }
    }
    const accounts: OAuthStoredAccount[] = [];
    // 固定mode顺序，避免mobile/bulk并发导入时颠倒锁顺序。
    for (const target of [...plan.targets].sort((a, b) =>
      a.implementationMode.localeCompare(b.implementationMode)
    )) {
      const mode = target.implementationMode;
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`pool-oauth:${mode}:${identity.key}`}, 0))`
      );
      if (successorId !== plan.id) {
        // 获得身份锁后重读，覆盖“首次读后才出现后继请求”的交错；不反向锁后继意图行。
        const [successor] = await tx
          .select()
          .from(imageBackendTokenRotation)
          .where(eq(imageBackendTokenRotation.id, successorId))
          .limit(1);
        if (successor) {
          const account = successor.accounts?.find(
            (candidate) => candidate.mode === mode
          );
          if (successor.state !== "done" || !account)
            throw new OAuthRecoveryError(plan.id);
          await checkSuccessorAccount(account);
          accounts.push(account);
          continue;
        }
      }
      const rows = await tx
        .select()
        .from(imageBackendAccount)
        .where(
          target.id
            ? or(
                eq(imageBackendAccount.implementationMode, mode),
                eq(imageBackendAccount.id, target.id)
              )
            : eq(imageBackendAccount.implementationMode, mode)
        )
        .orderBy(asc(imageBackendAccount.id))
        .for("update");
      // 已知RT链若突然换了用户/workspace身份，不能把它当新账户扩容；保留结果待核对。
      for (const row of rows) {
        if (
          row.refreshToken &&
          oauthRotationKey(row.refreshToken, plan.clientId) === plan.id &&
          storedIdentity(row).key !== identity.key
        )
          throw new OAuthRecoveryError(plan.id);
      }
      const matching = rows.filter((row) => {
        if (row.oauthIdentityKey === identity.key) {
          const proof = storedIdentity(row);
          if (
            proof.workspace !== identity.workspace ||
            proof.user !== identity.user
          )
            throw new OAuthRecoveryError(plan.id);
          return true;
        }
        try {
          return storedIdentity(row).key === identity.key;
        } catch {
          if (
            chatGptAccountIdFromAccessToken(row.accessToken) ===
            identity.workspace
          )
            throw new OAuthRecoveryError(plan.id);
          return false;
        }
      });
      if (matching.some((row) => row.metadata?.source === "sub2api_postgres"))
        throw new OAuthRecoveryError(plan.id);
      const explicit = target.id
        ? rows.find((row) => row.id === target.id)
        : undefined;
      if (target.id && (!explicit || !matching.includes(explicit)))
        throw new OAuthRecoveryError(plan.id);
      const credentialHash = createHash("sha256")
        .update(plan.accessToken.trim())
        .digest("hex");
      // 旧重复行可能已持有同一AT，优先复用它，避免现有AT唯一索引与身份收敛相冲突。
      const existing =
        explicit ??
        matching.find((row) => row.credentialHash === credentialHash) ??
        matching.find((row) => row.oauthIdentityKey === identity.key) ??
        matching[0];
      if (
        existing &&
        target.expectedCredentialHash &&
        existing.credentialHash !== target.expectedCredentialHash
      )
        throw new OAuthRecoveryError(plan.id);
      const id = existing?.id ?? `oauth_${mode}_${identity.key}`;
      for (const duplicate of matching.filter((row) => row.id !== id)) {
        await tx
          .update(imageBackendAccount)
          .set({
            oauthIdentityKey: null,
            isEnabled: false,
            status: "disabled",
            metadata: { ...duplicate.metadata, oauthDuplicateOf: id },
            updatedAt: new Date(),
          })
          .where(eq(imageBackendAccount.id, duplicate.id));
      }
      const groups = Array.from(
        new Set(target.groupIds ?? (target.groupId ? [target.groupId] : []))
      ).filter(Boolean);
      const values = {
        ...accountValues(target),
        groupId: target.mergeGroupIds
          ? (existing?.groupId ?? groups[0] ?? null)
          : (groups[0] ?? null),
        accessToken: plan.accessToken,
        refreshToken: plan.refreshToken,
        oauthIdentityKey: identity.key,
        credentialHash,
        metadata: {
          ...(target.metadata === null ? {} : existing?.metadata),
          ...target.metadata,
          chatgptAccountId: identity.workspace,
          oauthIdentity: identity,
          oauthRotationId: plan.id,
          refreshTokenRotated: plan.rotated,
        },
      };
      if (existing)
        await tx
          .update(imageBackendAccount)
          .set(values)
          .where(eq(imageBackendAccount.id, id));
      else await tx.insert(imageBackendAccount).values({ id, ...values });
      if (!target.mergeGroupIds)
        await tx
          .delete(imageBackendAccountGroup)
          .where(eq(imageBackendAccountGroup.accountId, id));
      if (groups.length)
        await tx
          .insert(imageBackendAccountGroup)
          .values(
            groups.map((groupId) => ({
              id: `${id}:${groupId}`,
              accountId: id,
              groupId,
            }))
          )
          .onConflictDoNothing();
      accounts.push({ id, mode });
    }
    await tx
      .update(imageBackendTokenRotation)
      .set({
        state: "done",
        encryptedPlan: null,
        accounts,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(imageBackendTokenRotation.id, plan.id),
          eq(imageBackendTokenRotation.owner, plan.owner)
        )
      );
    return accounts;
  });
}
