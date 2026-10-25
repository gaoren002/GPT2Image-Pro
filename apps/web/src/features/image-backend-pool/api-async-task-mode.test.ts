/** 池 API 异步任务模式的保存：并入 metadata 且保留其他键；未传时不改动。内存数据库与 DNS，不发网络。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { upsertImageBackendApi } from "./service";

const state = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  lookup: vi.fn(),
}));
vi.mock("node:dns/promises", () => ({ lookup: state.lookup }));
vi.mock("@repo/shared/logger", () => ({ logWarn: vi.fn(), logError: vi.fn() }));
vi.mock("@repo/shared/system-settings", () => ({
  clearSystemSettingsCache: vi.fn(),
  getRuntimeSettingNumber: vi.fn(),
  getRuntimeSettingString: vi.fn(),
}));
vi.mock("@repo/database", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [structuredClone(state.row)] }),
      }),
    }),
    update: () => ({
      set: (value: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            Object.assign(state.row, value);
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
}));

const input = {
  id: "api-a",
  name: "suduma",
  baseUrl: "https://upstream.example/v1",
  useStream: false,
  contentSafetyEnabled: true,
  isEnabled: true,
  alwaysActive: false,
  failureCooldownEnabled: false,
  priority: 0,
  concurrency: 1,
};

beforeEach(() => {
  state.row = {
    id: "api-a",
    baseUrl: input.baseUrl,
    apiKey: "test-key",
    metadata: {
      sizeDialect: "exact-ratio",
      modelBilling: { "gpt-image-2": 2 },
    },
  };
  state.lookup
    .mockReset()
    .mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});

describe("池 API 异步任务模式保存", () => {
  it("开启时写入 metadata.asyncTaskMode，保留尺寸方言与模型计价", async () => {
    await upsertImageBackendApi({ ...input, asyncTaskMode: true });
    expect(state.row.metadata).toEqual({
      sizeDialect: "exact-ratio",
      modelBilling: { "gpt-image-2": 2 },
      asyncTaskMode: true,
    });
  });

  it("关闭时显式写 false，后台可回显", async () => {
    state.row.metadata = { asyncTaskMode: true, sizeDialect: "wxh" };
    await upsertImageBackendApi({ ...input, asyncTaskMode: false });
    expect(state.row.metadata).toEqual({
      asyncTaskMode: false,
      sizeDialect: "wxh",
    });
  });

  it("其他保存入口未传该字段时不改动 metadata", async () => {
    state.row.metadata = { asyncTaskMode: true };
    await upsertImageBackendApi(input);
    expect(state.row.metadata).toEqual({ asyncTaskMode: true });
  });
});
