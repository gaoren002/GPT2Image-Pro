/** PL12 远端轮换/本地补写编排；外呼不在DB事务内，密文先落持久卷，账号失败可重放且不再rotate。 */
import { randomUUID } from "node:crypto";
import { logWarn } from "@repo/shared/logger";
import { oauthJournal } from "./oauth-rotation-journal";
import { resolveOAuthJournalRoot } from "./oauth-journal-path";
import * as store from "./oauth-account-store";
import {
  OAuthRecoveryError,
  oauthCheckpointRef,
  type OAuthAccountTarget,
  type OAuthRotationPlan,
  type OAuthStoredAccount,
} from "./oauth-rotation-types";

// 仅兜住首次磁盘确认异常的当前进程副本；不能把它声称为跨进程/主机故障恢复保证。
const uncheckpointed = new Map<string, OAuthRotationPlan>();
const inFlight = new Map<
  string,
  Promise<{ accounts: OAuthStoredAccount[]; rotated: boolean }>
>();

/** DB事务成功后才清除密文；清理失败留待下次检查done凭证，不重新改账号。 */
async function applyPlan(
  journal: ReturnType<typeof oauthJournal>,
  id: string,
  encrypted: string
) {
  const plan = journal.decrypt(id, encrypted);
  await store.stageOAuthRotation(plan, encrypted);
  const accounts = await store.commitOAuthRotation(plan);
  await journal.remove(id).catch(() => undefined);
  return accounts;
}

/** 恢复仅重放可信加密计划，不重新请求远端；单笔失败保留，后续真实请求仍独立认领。 */
export async function recoverPendingOAuthWrites(
  providedJournal?: ReturnType<typeof oauthJournal>
) {
  const journal =
    providedJournal ?? oauthJournal(await resolveOAuthJournalRoot());
  const journalIdentity = await journal.prepare();
  for (const [id, plan] of uncheckpointed) {
    if (plan.journalIdentity !== journalIdentity)
      throw new OAuthRecoveryError("journal-binding-mismatch", false);
    await journal.write(id, journal.encrypt(plan));
    uncheckpointed.delete(id);
  }
  const candidates = new Map<string, string>();
  for (const row of await store.pendingOAuthRotations())
    if (row.encryptedPlan)
      candidates.set(oauthCheckpointRef(row), row.encryptedPlan);
  for (const id of await journal.list()) {
    const encrypted = await journal.read(id);
    if (encrypted) candidates.set(id, encrypted);
  }
  const failed: Array<{ ref: string; plan: OAuthRotationPlan }> = [];
  for (const [id, encrypted] of candidates) {
    // 换卷或换密钥后若连计划都读不出，必须停止新外呼，不能把未知恢复记录当作可忽略失败。
    const plan = journal.decrypt(id, encrypted);
    if (plan.journalIdentity !== journalIdentity)
      throw new OAuthRecoveryError("journal-binding-mismatch", false);
    try {
      await applyPlan(journal, id, encrypted);
    } catch {
      failed.push({ ref: id, plan });
    }
  }
  // 本轮全部补写之后再判定失败项是否已被取代：同一操作的新 owner 可能刚在本轮完成，
  // 判定结果因此不依赖候选的处理顺序。被取代的旧轮计划无法补写，隔离（改名，不删除）
  // 其文件，避免每次扫描都计为 pending 并占用扫描名额；判定或隔离失败时保守保留。
  let pending = 0;
  for (const { ref, plan } of failed) {
    if (await store.isOAuthRotationSuperseded(plan).catch(() => false)) {
      // 改名成功或文件已不在（另一实例已隔离、仅 DB 有副本）都不再计 pending；
      // 只有真正改名才记日志，改名出错时保守计 pending。
      const quarantined = await journal.quarantine(ref).catch(() => null);
      if (quarantined !== null) {
        if (quarantined)
          logWarn("Quarantined superseded OAuth rotation checkpoint", {
            recoveryId: ref,
            source: "image-backend-pool-oauth-rotation",
          });
        continue;
      }
    }
    pending++;
  }
  return { pending };
}

/** 唯一意图绑定原RT+client；重复输入复用完成凭证，prepared/uncertain无结果时不能猜测重发。 */
export async function rotateAndStoreOAuth(input: {
  refreshToken: string;
  clientId: string;
  targets: OAuthAccountTarget[];
  refresh: (
    refreshToken: string,
    clientId: string
  ) => Promise<{
    accessToken: string;
    refreshToken: string | null;
    idToken?: string | null;
  } | null>;
}) {
  const journal = oauthJournal(await resolveOAuthJournalRoot());
  journal.validateTargets(input.targets);
  const id = journal.operationId(input.refreshToken, input.clientId);
  const previous = inFlight.get(id);
  if (previous) {
    const result = await previous;
    if (
      input.targets.some(
        (target) =>
          !result.accounts.some(
            (account) =>
              account.mode === target.implementationMode &&
              (!target.id || target.id === account.id)
          )
      )
    )
      throw new OAuthRecoveryError(id);
    return { ...result, rotated: false };
  }
  const run = async () => {
    let owner = "";
    try {
      await recoverPendingOAuthWrites(journal);
      const journalIdentity = await journal.binding();
      const claim = await store.prepareOAuthRotation(
        id,
        randomUUID(),
        input.clientId,
        input.refreshToken,
        journalIdentity
      );
      owner = claim.row.owner;
      if (!claim.claimed) {
        let accounts: OAuthStoredAccount[];
        if (claim.row.state === "done") accounts = claim.row.accounts ?? [];
        else {
          const ref = oauthCheckpointRef(claim.row);
          const encrypted =
            (await journal.read(ref)) ?? claim.row.encryptedPlan;
          if (!encrypted) throw new OAuthRecoveryError(id);
          accounts = await applyPlan(journal, ref, encrypted);
        }
        if (
          input.targets.some(
            (target) =>
              !accounts.some(
                (account) =>
                  account.mode === target.implementationMode &&
                  (!target.id || target.id === account.id)
              )
          )
        )
          throw new OAuthRecoveryError(id);
        return { accounts, rotated: false };
      }
      // 从这里到首次耐久写入有不可消除的跨系统窗口；失败后prepared不自动重发旧RT。
      const refreshed = await input.refresh(input.refreshToken, input.clientId);
      if (!refreshed) throw new OAuthRecoveryError(id);
      const plan: OAuthRotationPlan = {
        version: 1,
        id,
        owner,
        journalIdentity,
        clientId: input.clientId,
        accessToken: refreshed.accessToken,
        ...(refreshed.idToken ? { idToken: refreshed.idToken } : {}),
        refreshToken: refreshed.refreshToken || input.refreshToken,
        rotated: Boolean(
          refreshed.refreshToken &&
            refreshed.refreshToken !== input.refreshToken
        ),
        targets: input.targets,
      };
      const ref = oauthCheckpointRef(plan);
      uncheckpointed.set(ref, plan);
      const encrypted = journal.encrypt(plan);
      await journal.write(ref, encrypted);
      uncheckpointed.delete(ref);
      const accounts = await applyPlan(journal, ref, encrypted);
      return { accounts, rotated: plan.rotated };
    } catch (error) {
      if (owner)
        await store
          .markOAuthRotationUncertain(id, owner)
          .catch(() => undefined);
      if (error instanceof OAuthRecoveryError) throw error;
      throw new OAuthRecoveryError(
        uncheckpointed.keys().next().value ?? id,
        Boolean(owner) || uncheckpointed.size > 0
      );
    }
  };
  const result = run();
  inFlight.set(id, result);
  try {
    return await result;
  } finally {
    inFlight.delete(id);
  }
}
