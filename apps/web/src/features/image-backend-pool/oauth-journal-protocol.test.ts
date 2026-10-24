/** PL12复核后协议回归：真实磁盘，合成SQL/令牌；不替代父隔离PG。 */
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  oauthRows,
  resetOAuthDb,
  oauthDbState,
} from "./test-support/oauth-test-db";
vi.mock("@repo/database", async () => ({
  db: (await import("./test-support/oauth-test-db")).oauthTestDb,
}));
vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingString: async (key: string) => {
    expect(oauthDbState.inTransaction()).toBe(false);
    return process.env[key];
  },
}));
import { oauthJournal } from "./oauth-rotation-journal";
import { prepareOAuthRotation } from "./oauth-account-store";
import {
  recoverPendingOAuthWrites,
  rotateAndStoreOAuth,
} from "./oauth-rotation";
import { oauthRotationKey } from "./oauth-identity";
import {
  oauthCheckpointRef,
  type OAuthRotationPlan,
} from "./oauth-rotation-types";
const target = {
  name: "protocol",
  implementationMode: "responses" as const,
  contentSafetyEnabled: true,
  isEnabled: true,
  priority: 50,
  concurrency: 2,
};
const jwt = (n: number) =>
  `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "workspace", chatgpt_user_id: "user" }, n })).toString("base64url")}.signature`;
let roots: string[] = [];
/** 每例独立合成卷，绝不触碰部署根。 */
async function volume() {
  const root = await mkdtemp(join(tmpdir(), "pl12-protocol-"));
  roots.push(root);
  return root;
}
beforeEach(async () => {
  resetOAuthDb();
  roots = [];
  vi.stubEnv("LOCAL_STORAGE_PATH", await volume());
  vi.stubEnv("IMAGE_BACKEND_RT_JOURNAL_ROOT", "");
  vi.stubEnv(
    "BETTER_AUTH_SECRET",
    "synthetic-protocol-secret-at-least-32-chars"
  );
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true }))
  );
});
/** 固定形状计划，所有凭据仅为本测试合成数据。 */
function plan(
  id: string,
  owner: string,
  journalIdentity: string,
  n = 1
): OAuthRotationPlan {
  return {
    version: 1,
    id,
    owner,
    journalIdentity,
    clientId: "client",
    accessToken: jwt(n),
    refreshToken: `synthetic-rt-${n}`,
    rotated: true,
    targets: [target],
  };
}
it("不同owner同id同时可枚举，旧owner反复cleanup不能删新结果；同owner不可改计划", async () => {
  const journal = oauthJournal(),
    binding = await journal.prepare(),
    id = oauthRotationKey("source", "client");
  const a = plan(id, randomUUID(), binding),
    b = plan(id, randomUUID(), binding, 2);
  await journal.write(oauthCheckpointRef(a), journal.encrypt(a));
  await journal.write(oauthCheckpointRef(b), journal.encrypt(b));
  expect(await journal.list()).toEqual(
    [oauthCheckpointRef(a), oauthCheckpointRef(b)].sort()
  );
  await journal.write(oauthCheckpointRef(b), journal.encrypt(b));
  await expect(
    journal.write(
      oauthCheckpointRef(b),
      journal.encrypt({ ...b, refreshToken: "different" })
    )
  ).rejects.toThrow();
  await journal.remove(oauthCheckpointRef(a));
  await journal.remove(oauthCheckpointRef(a));
  expect(
    journal.decrypt(
      oauthCheckpointRef(b),
      (await journal.read(oauthCheckpointRef(b))) ?? ""
    ).refreshToken
  ).toBe(b.refreshToken);
});
it("DB当前owner计划不被磁盘旧owner同id覆盖；被取代的旧owner文件隔离", async () => {
  const source = "synthetic-reusable",
    id = oauthRotationKey(source, "client");
  await rotateAndStoreOAuth({
    refreshToken: source,
    clientId: "client",
    targets: [target],
    refresh: async () => ({ accessToken: jwt(1), refreshToken: null }),
  });
  const journal = oauthJournal(),
    binding = await journal.binding(),
    row = oauthRows("image_backend_token_rotation")[0];
  if (!row || typeof row.owner !== "string")
    throw new Error("Missing synthetic intent");
  const a = {
    ...plan(id, row.owner, binding),
    refreshToken: source,
    rotated: false,
  };
  await journal.write(oauthCheckpointRef(a), journal.encrypt(a));
  const claim = await prepareOAuthRotation(
    id,
    randomUUID(),
    "client",
    source,
    binding
  );
  const b = plan(id, claim.row.owner, binding, 2);
  row.state = "ready";
  row.encryptedPlan = journal.encrypt(b);
  // 旧 owner a 只能在其轮次 done 后才被 b 取代，其文件不可能再补写，扫描时隔离。
  expect((await recoverPendingOAuthWrites()).pending).toBe(0);
  expect(await journal.read(oauthCheckpointRef(a))).toBeNull();
  expect(
    await readdir(join(roots[0] ?? "", ".private/pool-oauth-rotation"))
  ).toContain(`${oauthCheckpointRef(a)}.superseded`);
  expect(oauthRows("image_backend_account")[0]?.refreshToken).toBe(
    b.refreshToken
  );
  expect(row.state).toBe("done");
});
it("残留probe被独立清理，并发预检不把活动probe当计划", async () => {
  const journal = oauthJournal();
  await journal.prepare();
  await writeFile(
    join(
      roots[0] ?? "",
      ".private/pool-oauth-rotation",
      `probe.${randomUUID()}.json`
    ),
    "preflight",
    { mode: 0o600 }
  );
  expect(await journal.list()).toHaveLength(0);
  const bindings = await Promise.all(
    Array.from({ length: 12 }, () => oauthJournal().prepare())
  );
  expect(new Set(bindings).size).toBe(1);
  expect(await journal.list()).toHaveLength(0);
});
it("不同根并发prepare在同一事务串行校验，仅一种卷身份能创建pending", async () => {
  const a = oauthJournal(),
    b = oauthJournal(await volume());
  const bindings = await Promise.all([a.prepare(), b.prepare()]);
  const results = await Promise.allSettled(
    Array.from({ length: 16 }, (_, n) =>
      prepareOAuthRotation(
        oauthRotationKey(`synthetic-source-${n}`, "client"),
        randomUUID(),
        "client",
        `synthetic-source-${n}`,
        bindings[n % 2]
      )
    )
  );
  expect(
    results.filter((result) => result.status === "fulfilled")
  ).toHaveLength(8);
  expect(
    new Set(
      oauthRows("image_backend_token_rotation").map(
        (row) => row.journalIdentity
      )
    ).size
  ).toBe(1);
  expect(
    oauthDbState.statements.filter((text) =>
      text.includes("pool-oauth-journal-binding")
    )
  ).toHaveLength(16);
});
it("同路径换空卷的volume身份变化也拒绝新claim", async () => {
  const journal = oauthJournal(),
    binding = await journal.prepare();
  await prepareOAuthRotation(
    oauthRotationKey("source", "client"),
    randomUUID(),
    "client",
    "source",
    binding
  );
  await unlink(
    join(roots[0] ?? "", ".private/pool-oauth-rotation/volume-version-1")
  );
  const next = await oauthJournal().prepare();
  expect(next).not.toBe(binding);
  await expect(
    prepareOAuthRotation(
      oauthRotationKey("other", "client"),
      randomUUID(),
      "client",
      "other",
      next
    )
  ).rejects.toThrow();
  expect(oauthRows("image_backend_token_rotation")).toHaveLength(1);
});
it("旧未绑定pending不靠推测补身份，不得新claim", async () => {
  oauthRows("image_backend_token_rotation").push({
    id: oauthRotationKey("old", "client"),
    owner: randomUUID(),
    clientId: "client",
    state: "uncertain",
    journalIdentity: null,
  });
  await expect(
    prepareOAuthRotation(
      oauthRotationKey("other", "client"),
      randomUUID(),
      "client",
      "other"
    )
  ).rejects.toThrow();
  expect(oauthRows("image_backend_token_rotation")).toHaveLength(1);
});
it("DB ready副本跨根也不能被新根恢复后掩盖pending绑定冲突", async () => {
  const journal = oauthJournal(),
    binding = await journal.prepare(),
    id = oauthRotationKey("source", "client"),
    owner = randomUUID();
  await prepareOAuthRotation(id, owner, "client", "source", binding);
  const row = oauthRows("image_backend_token_rotation")[0];
  if (!row) throw new Error("Missing synthetic intent");
  row.state = "ready";
  row.encryptedPlan = journal.encrypt(plan(id, owner, binding));
  vi.stubEnv("LOCAL_STORAGE_PATH", await volume());
  await expect(recoverPendingOAuthWrites()).rejects.toThrow();
  expect(oauthRows("image_backend_account")).toHaveLength(0);
  expect(row.state).toBe("ready");
});
