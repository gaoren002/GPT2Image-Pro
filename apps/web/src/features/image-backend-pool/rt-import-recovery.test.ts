/** PL12 真实service导入/保存/批量刷新入口；OAuth及SQL替身，检查令牌不进入返回值和日志。 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  oauthDbState,
  oauthRows,
  resetOAuthDb,
} from "./test-support/oauth-test-db";
const mocks = vi.hoisted(() => ({ log: vi.fn() }));
vi.mock("@repo/database", async () => ({
  db: (await import("./test-support/oauth-test-db")).oauthTestDb,
}));
vi.mock("@repo/shared/logger", () => ({
  logWarn: mocks.log,
  logError: mocks.log,
  logInfo: mocks.log,
}));
vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingString: async () => undefined,
  getRuntimeSettingNumber: async (_key: string, fallback?: number) =>
    fallback ?? 0,
  getRuntimeSettingBoolean: async () => false,
  getRuntimeSettingJson: async (_key: string, fallback?: unknown) =>
    fallback ?? null,
  clearSystemSettingsCache: () => {},
}));
import {
  importImageBackendAccountsFromRefreshTokens,
  upsertImageBackendAccount,
  bulkUpdateImageBackendAccounts,
} from "./service";
const input = {
  webGroupId: null,
  responsesGroupId: null,
  syncMode: "responses" as const,
  contentSafetyEnabled: true,
  priority: 50,
  concurrency: 2,
};
let directory = "",
  calls = 0;
const jwt = (nonce: number) =>
  `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "workspace-a", chatgpt_user_id: "user-a" }, nonce })).toString("base64url")}.signature`;
beforeEach(async () => {
  resetOAuthDb();
  vi.clearAllMocks();
  calls = 0;
  directory = await mkdtemp(join(tmpdir(), "pl12-service-"));
  vi.stubEnv("LOCAL_STORAGE_PATH", directory);
  vi.stubEnv("BETTER_AUTH_SECRET", "synthetic-test-secret-for-pl12-123456789");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      expect(String(url)).toBe("https://auth.openai.com/oauth/token");
      expect(oauthDbState.inTransaction()).toBe(false);
      calls++;
      return Response.json({
        access_token: jwt(calls),
        refresh_token: `rt-only-new-${calls}`,
      });
    })
  );
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});
it("同身份轮换导入复用账号，旧RT重投不再次外呼，返回值无令牌", async () => {
  const first = await importImageBackendAccountsFromRefreshTokens({
    ...input,
    refreshTokensText: "rt-original",
  });
  const second = await importImageBackendAccountsFromRefreshTokens({
    ...input,
    refreshTokensText: "rt-only-new-1",
  });
  const repeated = await importImageBackendAccountsFromRefreshTokens({
    ...input,
    refreshTokensText: "rt-original",
  });
  expect([first.syncedCount, second.syncedCount, repeated.syncedCount]).toEqual(
    [1, 1, 1]
  );
  expect(calls).toBe(2);
  expect(oauthRows("image_backend_account")).toHaveLength(1);
  expect(oauthRows("image_backend_account")[0]?.refreshToken).toBe(
    "rt-only-new-2"
  );
  expect(
    JSON.stringify([first, second, repeated, mocks.log.mock.calls])
  ).not.toContain("rt-only-new");
});
it("写账号失败显式提示暂存，恢复后不丢新RT且原输入可重投", async () => {
  oauthDbState.failAccounts = true;
  const failed = await importImageBackendAccountsFromRefreshTokens({
    ...input,
    refreshTokensText: "rt-original",
  });
  expect(failed.failed).toBe(1);
  expect(failed.message).toMatch(/暂存|恢复|补写/);
  expect(oauthRows("image_backend_account")).toHaveLength(0);
  expect(JSON.stringify([failed, mocks.log.mock.calls])).not.toContain(
    "rt-only-new"
  );
  expect(JSON.stringify([failed, mocks.log.mock.calls])).not.toContain("eyJ");
  oauthDbState.failAccounts = false;
  const result = await importImageBackendAccountsFromRefreshTokens({
    ...input,
    refreshTokensText: "rt-original",
  });
  expect(result.syncedCount).toBe(1);
  expect(calls).toBe(1);
  expect(oauthRows("image_backend_account")[0]?.refreshToken).toBe(
    "rt-only-new-1"
  );
});
it("仅RT保存入口也走同一可恢复协议", async () => {
  const settings = {
    name: "saved",
    implementationMode: "responses" as const,
    contentSafetyEnabled: true,
    isEnabled: true,
    concurrency: 1,
    priority: 50,
  };
  oauthDbState.failAccounts = true;
  await expect(
    upsertImageBackendAccount({ ...settings, refreshToken: "rt-original" })
  ).rejects.toThrow(/暂存|不确定/);
  oauthDbState.failAccounts = false;
  const id = await upsertImageBackendAccount({
    ...settings,
    refreshToken: "rt-original",
  });
  expect(calls).toBe(1);
  expect(oauthRows("image_backend_account")[0]?.id).toBe(id);
});
it("批量切换接口模式：轮换后写失败可重试，不再消耗旧RT", async () => {
  oauthRows("image_backend_account").push({
    id: "old",
    name: "old",
    implementationMode: "responses",
    accessToken: jwt(0),
    refreshToken: "rt-original",
    credentialHash: "old-hash",
    metadata: {},
    contentSafetyEnabled: true,
    isEnabled: true,
    priority: 50,
    concurrency: 2,
  });
  oauthDbState.failAccounts = true;
  const failed = await bulkUpdateImageBackendAccounts({
    accountIds: ["old"],
    implementationMode: "web",
  });
  expect(failed.failedCount).toBe(1);
  expect(calls).toBe(1);
  oauthDbState.failAccounts = false;
  const result = await bulkUpdateImageBackendAccounts({
    accountIds: ["old"],
    implementationMode: "web",
  });
  expect(result.updatedCount).toBe(1);
  expect(calls).toBe(1);
  expect(oauthRows("image_backend_account")[0]).toMatchObject({
    id: "old",
    implementationMode: "web",
    refreshToken: "rt-only-new-1",
  });
});
it.each([
  "LOCAL_STORAGE_PATH",
  "BETTER_AUTH_SECRET",
])("持久配置%s缺失导致失败，OAuth外呼为零", async (key) => {
  vi.stubEnv(key, "");
  const result = await importImageBackendAccountsFromRefreshTokens({
    ...input,
    refreshTokensText: "rt-original",
  });
  expect(result.failed).toBe(1);
  expect(calls).toBe(0);
});
it("HTTP失败正文可能回显凭据，日志和返回只含安全状态/恢复标识", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response("provider echoed rt-super-sensitive", { status: 400 })
    )
  );
  const result = await importImageBackendAccountsFromRefreshTokens({
    ...input,
    refreshTokensText: "rt-original",
  });
  expect(result.failed).toBe(1);
  expect(JSON.stringify([result, mocks.log.mock.calls])).not.toContain(
    "rt-super-sensitive"
  );
});
