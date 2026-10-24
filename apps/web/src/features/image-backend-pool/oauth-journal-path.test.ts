/** PL12 部署路径回归：~来自目标HOME，DB/ENV优先级明确，拒绝自动创建release相对目录。 */
import { mkdtemp, mkdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ runtime: undefined as string | undefined }));
vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingString: async () => state.runtime,
}));
import {
  expandOAuthStoragePath,
  resolveOAuthJournalRoot,
} from "./oauth-journal-path";
import { oauthJournal } from "./oauth-rotation-journal";
let base = "";
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "pl12-path-"));
  state.runtime = undefined;
  vi.stubEnv("IMAGE_BACKEND_RT_JOURNAL_ROOT", "");
  vi.stubEnv("LOCAL_STORAGE_PATH", base);
  vi.stubEnv("BETTER_AUTH_SECRET", "synthetic-test-secret-for-pl12-123456789");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(base, { recursive: true, force: true });
});
it("按目标进程HOME展开~和~/，不把字面~放到cwd下", () => {
  expect(expandOAuthStoragePath("~/data", base)).toBe(join(base, "data"));
  expect(expandOAuthStoragePath("~", base)).toBe(base);
  expect(() => expandOAuthStoragePath("~other/data", base)).toThrow();
});
it("实际进程HOME展开后使用既有根目录，首次仅创建700私有子目录", async () => {
  vi.stubEnv("HOME", base);
  await mkdir(join(base, "persistent"));
  vi.stubEnv("LOCAL_STORAGE_PATH", "~/persistent");
  const root = await resolveOAuthJournalRoot();
  expect(root).toBe(await realpath(join(base, "persistent")));
  await oauthJournal(root).prepare();
  expect((await stat(join(root, ".private"))).mode & 0o777).toBe(0o700);
  expect(
    (await stat(join(root, ".private/pool-oauth-rotation"))).mode & 0o777
  ).toBe(0o700);
});
it("DB运行时设置优先于ENV，与现有local provider一致", async () => {
  const configured = join(base, "runtime");
  await mkdir(configured);
  state.runtime = configured;
  expect(await resolveOAuthJournalRoot()).toBe(await realpath(configured));
});
it("显式server override优先于DB与ENV，供专用共享持久根目录使用", async () => {
  const override = join(base, "override");
  await mkdir(override);
  state.runtime = "/nonexistent/runtime";
  vi.stubEnv("IMAGE_BACKEND_RT_JOURNAL_ROOT", override);
  expect(await resolveOAuthJournalRoot()).toBe(await realpath(override));
});
it.each([
  "./storage",
  "relative/path",
  "~other/data",
])("拒绝release/cwd相对路径%s", async (value) => {
  vi.stubEnv("LOCAL_STORAGE_PATH", value);
  await expect(resolveOAuthJournalRoot()).rejects.toThrow();
});
it("绝对或~根不存在时拒绝，不通过mkdir把错误路径当作持久卷", async () => {
  const missing = join(base, "not-deployed");
  vi.stubEnv("LOCAL_STORAGE_PATH", missing);
  await expect(resolveOAuthJournalRoot()).rejects.toThrow();
  await expect(stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(oauthJournal(missing).prepare()).rejects.toThrow();
  await expect(stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
});
