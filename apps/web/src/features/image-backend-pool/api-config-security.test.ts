/** PL08 保存服务回归；真实 URL 校验/Drizzle 条件，内存数据库与 DNS，不发网络。 */
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  row: {
    id: "api-a",
    baseUrl: "https://old.example/v1",
    apiKey: "old-test-key",
    metadata: null,
  } as Record<string, unknown>,
  updates: 0,
  lookup: vi.fn(),
  beforeUpdate: undefined as (() => void) | undefined,
}));
vi.mock("node:dns/promises", () => ({ lookup: state.lookup }));
vi.mock("@repo/shared/logger", () => ({ logWarn: vi.fn(), logError: vi.fn() }));
vi.mock("@repo/shared/system-settings", () => ({
  clearSystemSettingsCache: vi.fn(),
  getRuntimeSettingNumber: vi.fn(),
  getRuntimeSettingString: vi.fn(),
}));
vi.mock("@repo/database", async () => {
  const { PgDialect } = await import("drizzle-orm/pg-core");
  return {
    db: {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [structuredClone(state.row)] }),
        }),
      }),
      update: () => ({
        set: (value: Record<string, unknown>) => ({
          where: (condition: SQL) => ({
            returning: async () => {
              state.beforeUpdate?.();
              const query = new PgDialect().sqlToQuery(condition);
              if (
                query.params[0] !== state.row.id ||
                query.params[1] !== state.row.baseUrl
              )
                return [];
              Object.assign(state.row, value);
              state.updates++;
              return [{ id: state.row.id }];
            },
          }),
        }),
      }),
      delete: () => ({ where: async () => undefined }),
      insert: () => ({
        values: () => ({ onConflictDoNothing: async () => undefined }),
      }),
    },
  };
});
import { upsertImageBackendApi } from "./service";
const input = {
  id: "api-a",
  name: "API",
  baseUrl: "https://old.example/v1",
  useStream: false,
  contentSafetyEnabled: true,
  isEnabled: true,
  alwaysActive: false,
  failureCooldownEnabled: true,
  priority: 0,
  concurrency: 1,
};
beforeEach(() => {
  state.row = {
    id: "api-a",
    baseUrl: input.baseUrl,
    apiKey: "old-test-key",
    metadata: null,
  };
  state.updates = 0;
  state.beforeUpdate = undefined;
  state.lookup
    .mockReset()
    .mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});
describe("pool API credential isolation", () => {
  it("retarget requires an explicitly entered replacement credential", async () => {
    await expect(
      upsertImageBackendApi({ ...input, baseUrl: "https://other.example/v1" })
    ).rejects.toThrow(/重新输入密钥/);
    expect(state.updates).toBe(0);
    expect(state.row.apiKey).toBe("old-test-key");
  });
  it("same origin path edits preserve the credential", async () => {
    await upsertImageBackendApi({
      ...input,
      baseUrl: "https://old.example/v2",
    });
    expect(state.row.baseUrl).toBe("https://old.example/v2");
    expect(state.row.apiKey).toBe("old-test-key");
  });
  it("explicit replacement permits a new public origin", async () => {
    await upsertImageBackendApi({
      ...input,
      baseUrl: "https://other.example/v1",
      apiKey: "new-test-key",
    });
    expect(state.row.baseUrl).toBe("https://other.example/v1");
    expect(state.row.apiKey).toBe("new-test-key");
  });
  it("DNS failure aborts before updating credentials", async () => {
    state.lookup.mockRejectedValueOnce(new Error("DNS unavailable"));
    await expect(
      upsertImageBackendApi({ ...input, apiKey: "new-test-key" })
    ).rejects.toThrow();
    expect(state.updates).toBe(0);
    expect(state.row.apiKey).toBe("old-test-key");
  });
  it("ordinary config cannot approve internal HTTP", async () => {
    await expect(
      upsertImageBackendApi({
        ...input,
        baseUrl: "http://127.0.0.1/v1",
        apiKey: "new-test-key",
      })
    ).rejects.toThrow();
    expect(state.updates).toBe(0);
  });
  it("CAS rejects a stale save after another admin changes host and key", async () => {
    state.beforeUpdate = () =>
      Object.assign(state.row, {
        baseUrl: "https://other.example/v1",
        apiKey: "other-test-key",
      });
    await expect(upsertImageBackendApi(input)).rejects.toThrow(/配置已变化/);
    expect(state.row.baseUrl).toBe("https://other.example/v1");
    expect(state.row.apiKey).toBe("other-test-key");
  });
});
