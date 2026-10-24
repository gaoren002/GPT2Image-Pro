/** 维护操作只接受内部 cron；普通用户和管理员不能通过统一网关主动删历史或磁盘缓存。 */
import { invokeOperation } from "@repo/shared/uol";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ pool: vi.fn(), local: vi.fn() }));
vi.mock("./retention", () => ({ cleanupImageBackendRetention: mocks.pool }));
vi.mock("@repo/shared/storage/thumbnail-cache", () => ({
  cleanupThumbnailCache: mocks.local,
}));
import "./retention-operation";
beforeEach(() => {
  mocks.pool
    .mockReset()
    .mockResolvedValue({ stickyDeleted: 2, metricsDeleted: 3 });
  mocks.local.mockReset().mockResolvedValue({ deleted: 4, legacyDeleted: 5 });
});
it.each([
  "image-backend-pool.cleanupRetention",
  "storage.cleanupThumbnailCache",
])("%s 拒绝管理界面身份和任意维护参数", async (name) => {
  for (const role of [
    "user",
    "observer_admin",
    "admin",
    "super_admin",
  ] as const) {
    await expect(
      invokeOperation(name, {}, { type: "user", userId: "fixture", role })
    ).rejects.toThrow();
  }
  await expect(
    invokeOperation(
      name,
      { now: "2099-01-01", directory: "/" },
      { type: "cron", job: "test" }
    )
  ).rejects.toThrow();
  expect(mocks.pool).not.toHaveBeenCalled();
  expect(mocks.local).not.toHaveBeenCalled();
});
it("cron 只调用本地与数据库各自的固定维护入口", async () => {
  await expect(
    invokeOperation(
      "image-backend-pool.cleanupRetention",
      {},
      { type: "cron", job: "test" }
    )
  ).resolves.toEqual({ stickyDeleted: 2, metricsDeleted: 3 });
  await expect(
    invokeOperation(
      "storage.cleanupThumbnailCache",
      {},
      { type: "cron", job: "test" }
    )
  ).resolves.toEqual({ deleted: 4, legacyDeleted: 5 });
  expect(mocks.pool).toHaveBeenCalledWith();
  expect(mocks.local).toHaveBeenCalledWith();
});
