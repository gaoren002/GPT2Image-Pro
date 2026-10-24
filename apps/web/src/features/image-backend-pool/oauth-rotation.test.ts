/** PL12 真实恢复编排/持久密文/账号事务回归；远端与SQL用明确替身，无真实令牌或生产连接。 */
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  oauthDbState,
  oauthRows,
  resetOAuthDb,
} from "./test-support/oauth-test-db";
vi.mock("@repo/database", async () => ({
  db: (await import("./test-support/oauth-test-db")).oauthTestDb,
}));
vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingString: async (key: string) => process.env[key],
}));
const io = vi.hoisted(() => ({ failCheckpoint: false }));
vi.mock("./oauth-rotation-journal", async (original) => {
  const module = await original<typeof import("./oauth-rotation-journal")>();
  return {
    oauthJournal: (storageRoot?: string) => {
      const real = module.oauthJournal(storageRoot);
      return {
        ...real,
        write: async (id: string, encrypted: string) => {
          if (io.failCheckpoint) {
            io.failCheckpoint = false;
            throw new Error("checkpoint volume unavailable");
          }
          return real.write(id, encrypted);
        },
      };
    },
  };
});
import { oauthIdentity } from "./oauth-identity";
import { oauthJournal } from "./oauth-rotation-journal";
import {
  rotateAndStoreOAuth,
  recoverPendingOAuthWrites,
} from "./oauth-rotation";
import {
  OAuthRecoveryError,
  oauthCheckpointRef,
  type OAuthAccountTarget,
} from "./oauth-rotation-types";

const target: OAuthAccountTarget = {
  name: "test",
  implementationMode: "responses",
  contentSafetyEnabled: true,
  isEnabled: true,
  concurrency: 2,
  priority: 50,
  mergeGroupIds: true,
  groupId: "group-a",
};
let directory = "";
/** 标准形状的合成claim；不持有或读取本机/线上登录数据。 */
function jwt(workspace = "workspace-a", user = "user-a", nonce = 1) {
  return `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: workspace, chatgpt_user_id: user }, nonce })).toString("base64url")}.signature`;
}
const accounts = () => oauthRows("image_backend_account");
const intents = () => oauthRows("image_backend_token_rotation");
const journalDirectory = () => join(directory, ".private/pool-oauth-rotation");
/** 按 DB 当前 owner 定位该操作唯一的 owner checkpoint 引用。 */
function checkpointRefFor(refreshToken: string) {
  const id = oauthJournal().operationId(refreshToken, "client-test");
  const row = intents().find((intent) => intent.id === id);
  if (!row) throw new Error("Missing rotation intent");
  return oauthCheckpointRef({ id, owner: String(row.owner) });
}
/** 每轮只换合成nonce，账户身份恒定；断言外呼不在本地事务里。 */
function refresh() {
  let count = 0;
  return vi.fn(async () => {
    expect(oauthDbState.inTransaction()).toBe(false);
    count++;
    return {
      accessToken: jwt("workspace-a", "user-a", count),
      refreshToken: `rt-new-${count}`,
    };
  });
}
const run = (
  refreshToken: string,
  upstream: Parameters<typeof rotateAndStoreOAuth>[0]["refresh"],
  targets = [target]
) =>
  rotateAndStoreOAuth({
    refreshToken,
    clientId: "client-test",
    targets,
    refresh: upstream,
  });
beforeEach(async () => {
  resetOAuthDb();
  io.failCheckpoint = false;
  directory = await mkdtemp(join(tmpdir(), "pl12-"));
  vi.stubEnv("LOCAL_STORAGE_PATH", directory);
  vi.stubEnv("BETTER_AUTH_SECRET", "synthetic-test-secret-for-pl12-123456789");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("稳定账户身份与唯一落库", () => {
  it("新AT不生成新成员；旧RT重复也不再次外呼，容量不叠加", async () => {
    const upstream = refresh();
    const first = await run("rt-original", upstream);
    const second = await run("rt-new-1", upstream);
    const repeated = await run("rt-original", upstream);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(first.accounts).toEqual(second.accounts);
    expect(repeated.accounts).toEqual(first.accounts);
    expect(accounts()).toHaveLength(1);
    expect(accounts()[0]?.refreshToken).toBe("rt-new-2");
    expect(accounts()[0]?.concurrency).toBe(2);
    expect(oauthRows("image_backend_account_group")).toHaveLength(1);
  });
  it("provider不轮换RT时完成后仍可换取下一轮AT，但账户行保持幂等", async () => {
    let n = 0;
    const upstream = vi.fn(async () => ({
      accessToken: jwt("workspace-a", "user-a", ++n),
      refreshToken: null,
    }));
    await run("rt-long-lived", upstream);
    await run("rt-long-lived", upstream);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(accounts()).toHaveLength(1);
    expect(accounts()[0]?.accessToken).toBe(jwt("workspace-a", "user-a", 2));
  });
  it("AT缺少身份时从同一可信响应的ID token识别，后续重复仍复用同一行", async () => {
    let n = 0;
    const upstream = vi.fn(async () => ({
      accessToken: `opaque-at-${++n}`,
      idToken: jwt(),
      refreshToken: `rt-next-${n}`,
    }));
    await rotateAndStoreOAuth({
      refreshToken: "rt-original",
      clientId: "client-test",
      targets: [target],
      refresh: upstream,
    });
    await rotateAndStoreOAuth({
      refreshToken: "rt-next-1",
      clientId: "client-test",
      targets: [target],
      refresh: upstream,
    });
    expect(accounts()).toHaveLength(1);
    expect(accounts()[0]?.refreshToken).toBe("rt-next-2");
  });
  it("同workspace不同用户不合并，同用户不同workspace也独立", async () => {
    for (const [workspace, user] of [
      ["workspace-a", "user-a"],
      ["workspace-a", "user-b"],
      ["workspace-b", "user-a"],
    ]) {
      const upstream = vi.fn(async () => ({
        accessToken: jwt(workspace, user),
        refreshToken: "rt-new",
      }));
      await rotateAndStoreOAuth({
        refreshToken: `rt-${workspace}-${user}`,
        clientId: "client-test",
        targets: [target],
        refresh: upstream,
      });
    }
    expect(accounts()).toHaveLength(3);
  });
  it("并发重复只外呼一次，同身份不同RT也只保留一个成员", async () => {
    const upstream = refresh();
    const [a, b] = await Promise.all([
      run("rt-original", upstream),
      run("rt-original", upstream),
    ]);
    expect(a.accounts).toEqual(b.accounts);
    expect(upstream).toHaveBeenCalledTimes(1);
    await Promise.all([
      run("rt-chain-a", upstream),
      run("rt-chain-b", upstream),
    ]);
    expect(accounts()).toHaveLength(1);
  });
  it("为已有同身份旧重复行收敛成一个可调度成员，不删审计行", async () => {
    accounts().push(
      ...[1, 2].map((n) => ({
        id: `legacy-${n}`,
        accessToken: jwt("workspace-a", "user-a", n),
        implementationMode: "responses",
        metadata: { source: "manual_refresh_token" },
        concurrency: 2,
        credentialHash: `old-${n}`,
        isEnabled: true,
      }))
    );
    await run("rt-original", refresh());
    expect(accounts()).toHaveLength(2);
    expect(accounts().filter((row) => row.isEnabled)).toHaveLength(1);
    expect(accounts().find((row) => !row.isEnabled)?.metadata).toMatchObject({
      oauthDuplicateOf: "legacy-1",
    });
  });
  it("Mobile双模式各一条成员，后续AT变化不生成第二轮成员", async () => {
    const upstream = refresh(),
      targets = [target, { ...target, implementationMode: "web" as const }];
    await run("rt-original", upstream, targets);
    await run("rt-new-1", upstream, targets);
    expect(accounts()).toHaveLength(2);
    expect(
      accounts()
        .map((row) => row.implementationMode)
        .sort()
    ).toEqual(["responses", "web"]);
    expect(accounts().map((row) => row.refreshToken)).toEqual([
      "rt-new-2",
      "rt-new-2",
    ]);
  });
  it("不能覆盖同身份Sub2API托管凭据", async () => {
    accounts().push({
      id: "managed",
      accessToken: jwt(),
      implementationMode: "responses",
      credentialHash: "managed",
      metadata: { source: "sub2api_postgres" },
      isEnabled: true,
    });
    await expect(run("rt-original", refresh())).rejects.toBeInstanceOf(
      OAuthRecoveryError
    );
    expect(accounts()[0]?.credentialHash).toBe("managed");
    expect(await oauthJournal().list()).toHaveLength(1);
  });
  it("同一已知RT链的身份变化不能新增账户叠加容量", async () => {
    const upstream = refresh();
    await run("rt-original", upstream);
    const changed = vi.fn(async () => ({
      accessToken: jwt("workspace-a", "changed-user"),
      refreshToken: "rt-only-new-identity",
    }));
    await expect(run("rt-new-1", changed)).rejects.toBeInstanceOf(
      OAuthRecoveryError
    );
    expect(accounts()).toHaveLength(1);
    expect(accounts()[0]?.refreshToken).toBe("rt-new-1");
    expect(await oauthJournal().list()).toHaveLength(1);
  });
  it("稳定键碰撞或已绑定身份矛盾不覆盖账号，密文仍可恢复", async () => {
    const identity = oauthIdentity(jwt());
    accounts().push({
      id: "collision",
      implementationMode: "responses",
      oauthIdentityKey: identity.key,
      accessToken: jwt("workspace-a", "other"),
      credentialHash: "old",
      isEnabled: true,
    });
    await expect(run("rt-original", refresh())).rejects.toBeInstanceOf(
      OAuthRecoveryError
    );
    expect(accounts()[0]?.credentialHash).toBe("old");
    expect(intents()[0]?.state).toBe("ready");
    expect(await oauthJournal().list()).toHaveLength(1);
  });
  it.each([
    {},
    { chatgpt_account_id: "workspace-a" },
    { chatgpt_account_id: "workspace-a", chatgpt_user_id: "a", user_id: "b" },
  ])("缺失/冲突身份 %j 不激活，仍保存唯一新RT", async (auth) => {
    const accessToken = `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": auth })).toString("base64url")}.signature`;
    const upstream = vi.fn(async () => ({
      accessToken,
      refreshToken: "rt-only-new-copy",
    }));
    await expect(
      rotateAndStoreOAuth({
        refreshToken: "rt-original",
        clientId: "client-test",
        targets: [target],
        refresh: upstream,
      })
    ).rejects.toBeInstanceOf(OAuthRecoveryError);
    expect(accounts()).toHaveLength(0);
    expect(intents()[0]?.state).toBe("ready");
    const journal = oauthJournal();
    const ref = checkpointRefFor("rt-original");
    expect(
      journal.decrypt(ref, (await journal.read(ref)) ?? "").refreshToken
    ).toBe("rt-only-new-copy");
  });
});

describe("远端rotate后本地失败的恢复边界", () => {
  it("账号写入失败后密文已fsync，重试补写原计划而不再rotate", async () => {
    const upstream = refresh();
    oauthDbState.failAccounts = true;
    let failure: unknown;
    try {
      await run("rt-original", upstream);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(OAuthRecoveryError);
    expect(String(failure)).not.toContain("rt-new-1");
    expect(String(failure)).not.toContain("eyJ");
    expect(accounts()).toHaveLength(0);
    const files = (await readdir(journalDirectory())).filter(
      (file) =>
        !file.startsWith("key-version-") && !file.startsWith("volume-version-")
    );
    // 只有一份不可覆盖的 owner checkpoint，没有按操作 id 命名的副本。
    expect(files).toEqual([`${checkpointRefFor("rt-original")}.checkpoint`]);
    const path = join(
      directory,
      ".private/pool-oauth-rotation",
      files[0] ?? ""
    );
    expect(await readFile(path, "utf8")).not.toContain("rt-new-1");
    expect((await stat(path)).mode & 0o077).toBe(0);
    oauthDbState.failAccounts = false;
    await run("rt-original", upstream);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(accounts()).toHaveLength(1);
    expect(accounts()[0]?.refreshToken).toBe("rt-new-1");
    expect(intents()[0]?.state).toBe("done");
    expect(await oauthJournal().list()).toHaveLength(0);
  });
  it("旧文件晚于后继DB计划恢复时不得把已消费RT写回，避免丢失唯一更新RT", async () => {
    const upstream = refresh(),
      journal = oauthJournal();
    oauthDbState.failAccounts = true;
    oauthDbState.failStageForId = journal.operationId(
      "rt-original",
      "client-test"
    );
    await expect(run("rt-original", upstream)).rejects.toBeInstanceOf(
      OAuthRecoveryError
    );
    await expect(run("rt-new-1", upstream)).rejects.toBeInstanceOf(
      OAuthRecoveryError
    );
    expect(upstream).toHaveBeenCalledTimes(2);
    oauthDbState.failAccounts = false;
    oauthDbState.failStageForId = null;
    await recoverPendingOAuthWrites();
    expect(accounts()[0]?.refreshToken).toBe("rt-new-2");
    expect(intents().every((intent) => intent.state === "done")).toBe(true);
    expect(await journal.list()).toHaveLength(0);
  });
  it("DB结果checkpoint也失败时保留文件，下一次补写不再rotate", async () => {
    const upstream = refresh();
    oauthDbState.failStage = true;
    await expect(run("rt-original", upstream)).rejects.toBeInstanceOf(
      OAuthRecoveryError
    );
    expect(intents()[0]?.state).toBe("uncertain");
    expect(intents()[0]?.encryptedPlan).toBeUndefined();
    expect(await oauthJournal().list()).toHaveLength(1);
    oauthDbState.failStage = false;
    await run("rt-original", upstream);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(accounts()[0]?.refreshToken).toBe("rt-new-1");
  });
  it("待补写日志存在时更换BETTER_AUTH_SECRET被阻止，不把旧RT当新意图重发", async () => {
    const upstream = refresh();
    oauthDbState.failAccounts = true;
    await expect(run("rt-original", upstream)).rejects.toBeInstanceOf(
      OAuthRecoveryError
    );
    oauthDbState.failAccounts = false;
    vi.stubEnv(
      "BETTER_AUTH_SECRET",
      "another-synthetic-secret-for-pl12-123456789"
    );
    await expect(run("rt-original", upstream)).rejects.toBeInstanceOf(
      OAuthRecoveryError
    );
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(accounts()).toHaveLength(0);
  });
  it("AAD/密钥校验失败不删除唯一密文或写账号", async () => {
    const upstream = refresh();
    oauthDbState.failAccounts = true;
    await expect(run("rt-original", upstream)).rejects.toBeInstanceOf(
      OAuthRecoveryError
    );
    const journal = oauthJournal(),
      refs = await journal.list(),
      ref = refs[0] ?? "";
    const encrypted = (await journal.read(ref)) ?? "";
    // 同一操作换成别的 owner 引用时 AAD 不符，不能被当作该 owner 的计划解密。
    const otherOwner = `${ref.split(".")[0]}.${randomUUID()}`;
    expect(() => journal.decrypt(otherOwner, encrypted)).toThrow();
    expect(await journal.read(ref)).toBe(encrypted);
  });
  it("首次checkpoint暂时失败显式保留进程内副本，下次只补写而不再次rotate", async () => {
    const upstream = refresh();
    io.failCheckpoint = true;
    await expect(run("rt-original", upstream)).rejects.toBeInstanceOf(
      OAuthRecoveryError
    );
    expect(accounts()).toHaveLength(0);
    expect(intents()[0]?.state).toBe("uncertain");
    await run("rt-original", upstream);
    expect(accounts()[0]?.refreshToken).toBe("rt-new-1");
    expect(upstream).toHaveBeenCalledTimes(1);
  });
  it("损坏密文阻止新的外呼而不是被忽略，仍保留恢复证据", async () => {
    const upstream = refresh();
    oauthDbState.failAccounts = true;
    await expect(run("rt-original", upstream)).rejects.toBeInstanceOf(
      OAuthRecoveryError
    );
    const journal = oauthJournal();
    const ref = checkpointRefFor("rt-original");
    // write 会拒绝无法解密的内容；直接篡改磁盘上的 checkpoint 模拟介质损坏。
    await expect(journal.write(ref, "corrupted")).rejects.toBeInstanceOf(
      OAuthRecoveryError
    );
    await writeFile(
      join(journalDirectory(), `${ref}.checkpoint`),
      "corrupted",
      {
        mode: 0o600,
      }
    );
    oauthDbState.failAccounts = false;
    await expect(run("rt-other", upstream)).rejects.toBeInstanceOf(
      OAuthRecoveryError
    );
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(await journal.read(ref)).toBe("corrupted");
  });
  it("目标账号并发换凭据后旧计划不覆盖，保留新RT等待冲突处理", async () => {
    accounts().push({
      id: "existing",
      accessToken: jwt(),
      implementationMode: "responses",
      credentialHash: "expected",
      isEnabled: true,
    });
    const upstream = refresh();
    oauthDbState.failAccounts = true;
    await expect(
      run("rt-original", upstream, [
        { ...target, id: "existing", expectedCredentialHash: "expected" },
      ])
    ).rejects.toBeInstanceOf(OAuthRecoveryError);
    oauthDbState.failAccounts = false;
    const existing = accounts()[0];
    if (!existing) throw new Error("Missing row");
    existing.credentialHash = "newer-credential";
    existing.accessToken = jwt("workspace-a", "user-a", 999);
    expect((await recoverPendingOAuthWrites()).pending).toBe(1);
    expect(accounts()[0]?.credentialHash).toBe("newer-credential");
    expect(intents()[0]?.state).toBe("ready");
    expect(upstream).toHaveBeenCalledTimes(1);
  });
  it("完成标记写入失败整体回滚账号和分组，随后恢复仍不再次外呼", async () => {
    const upstream = refresh();
    oauthDbState.failDone = true;
    await expect(run("rt-original", upstream)).rejects.toBeInstanceOf(
      OAuthRecoveryError
    );
    expect(accounts()).toHaveLength(0);
    expect(oauthRows("image_backend_account_group")).toHaveLength(0);
    oauthDbState.failDone = false;
    await recoverPendingOAuthWrites();
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(accounts()).toHaveLength(1);
    expect(intents()[0]?.state).toBe("done");
  });
  it("DB密文副本可在本地checkpoint文件丢失后补写", async () => {
    const upstream = refresh();
    oauthDbState.failAccounts = true;
    await expect(run("rt-original", upstream)).rejects.toBeInstanceOf(
      OAuthRecoveryError
    );
    const journal = oauthJournal();
    await journal.remove(checkpointRefFor("rt-original"));
    expect(await journal.list()).toHaveLength(0);
    oauthDbState.failAccounts = false;
    await recoverPendingOAuthWrites();
    expect(accounts()).toHaveLength(1);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
  it("成功完成后目录只剩卷与密钥标记，不留任何含计划的文件", async () => {
    await run("rt-original", refresh());
    expect((await readdir(journalDirectory())).sort()).toEqual([
      "key-version-1",
      "volume-version-1",
    ]);
  });
  it("已被新 owner 取代的旧 checkpoint 在扫描时隔离而非删除；DB 无对应行的仍保留并计为 pending", async () => {
    await run("rt-original", refresh());
    const journal = oauthJournal();
    const journalIdentity = await journal.binding();
    const id = journal.operationId("rt-original", "client-test");
    const stalePlan = {
      version: 1 as const,
      id,
      owner: randomUUID(),
      journalIdentity,
      clientId: "client-test",
      accessToken: jwt(),
      refreshToken: "rt-stale",
      rotated: true,
      targets: [target],
    };
    const staleRef = oauthCheckpointRef(stalePlan);
    await journal.write(staleRef, journal.encrypt(stalePlan));
    const orphanPlan = {
      ...stalePlan,
      id: journal.operationId("rt-never-claimed", "client-test"),
      owner: randomUUID(),
    };
    const orphanRef = oauthCheckpointRef(orphanPlan);
    await journal.write(orphanRef, journal.encrypt(orphanPlan));
    expect((await recoverPendingOAuthWrites()).pending).toBe(1);
    expect(await journal.list()).toEqual([orphanRef]);
    // 隔离文件保留唯一副本供人工核对，但不再进入恢复扫描。
    expect(await readdir(journalDirectory())).toContain(
      `${staleRef}.superseded`
    );
    expect(accounts()[0]?.refreshToken).toBe("rt-new-1");
  });
  it("意图行被人工删除后重投且新 owner 未完成时，旧 owner 的新 RT 仍留在扫描中不被隔离", async () => {
    oauthDbState.failAccounts = true;
    await expect(run("rt-original", refresh())).rejects.toBeInstanceOf(
      OAuthRecoveryError
    );
    const staleRef = checkpointRefFor("rt-original");
    const rows = intents();
    rows.splice(0, rows.length);
    oauthDbState.failAccounts = false;
    const rejecting = vi.fn(async () => {
      throw new Error("provider rejected reused refresh token");
    });
    await expect(run("rt-original", rejecting)).rejects.toBeInstanceOf(
      OAuthRecoveryError
    );
    expect(intents()[0]?.state).toBe("uncertain");
    expect((await recoverPendingOAuthWrites()).pending).toBe(1);
    expect(await oauthJournal().list()).toEqual([staleRef]);
    expect(await readdir(journalDirectory())).not.toContain(
      `${staleRef}.superseded`
    );
  });
  it("预检回收超过一小时的临时文件残留，保留新近的临时文件", async () => {
    const journal = oauthJournal();
    await journal.prepare();
    const old = join(journalDirectory(), `stale.${randomUUID()}.tmp`);
    const fresh = join(journalDirectory(), `fresh.${randomUUID()}.tmp`);
    await writeFile(old, "residue", { mode: 0o600 });
    await writeFile(fresh, "in-flight", { mode: 0o600 });
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(old, twoHoursAgo, twoHoursAgo);
    await journal.prepare();
    const names = await readdir(journalDirectory());
    expect(names).not.toContain(old.split("/").pop());
    expect(names).toContain(fresh.split("/").pop());
  });
  it("响应丢失无法跨系统原子判定；不确定意图不盲目重发旧RT或泄露错误正文", async () => {
    const upstream = vi.fn(async () => {
      throw new Error("provider echoed rt-super-secret");
    });
    await expect(run("rt-original", upstream)).rejects.toThrow("状态不确定");
    await expect(run("rt-original", upstream)).rejects.toThrow("状态不确定");
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(intents()[0]?.state).toBe("uncertain");
  });
  it("非法目标配置在消费RT前拒绝，不写出自身无法重放的计划", async () => {
    const upstream = refresh();
    await expect(
      run("rt-original", upstream, [{ ...target, concurrency: 0 }])
    ).rejects.toBeInstanceOf(OAuthRecoveryError);
    expect(upstream).not.toHaveBeenCalled();
    expect(intents()).toHaveLength(0);
  });
  it("持久卷/密钥预检失败时不消耗RT", async () => {
    vi.stubEnv("LOCAL_STORAGE_PATH", "");
    const upstream = refresh();
    await expect(run("rt-original", upstream)).rejects.toBeInstanceOf(
      OAuthRecoveryError
    );
    expect(upstream).not.toHaveBeenCalled();
    expect(intents()).toHaveLength(0);
  });
});
