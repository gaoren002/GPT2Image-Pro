/** 本机缓存调度：重复初始化、慢清理和失败后继续，真实计时器接口使用虚拟时间。 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const cleanup = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
vi.mock("@repo/shared/storage/thumbnail-cache", () => ({
  cleanupThumbnailCache: cleanup,
}));
import { startInstanceCacheMaintenance } from "./instance-cache-maintenance";
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("__gpt2imageCacheMaintenanceStarted", false);
  cleanup.mockReset().mockResolvedValue({ deleted: 0, legacyDeleted: 0 });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("多次初始化只启动一个实例本地清理循环", async () => {
  startInstanceCacheMaintenance();
  startInstanceCacheMaintenance();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(cleanup).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(cleanup).toHaveBeenCalledTimes(2);
});
it("慢清理不会叠加，失败后仍安排下一轮", async () => {
  let release!: () => void;
  cleanup.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      })
  );
  startInstanceCacheMaintenance();
  await vi.advanceTimersByTimeAsync(180_000);
  expect(cleanup).toHaveBeenCalledTimes(1);
  release();
  await Promise.resolve();
  cleanup.mockRejectedValueOnce(new Error("fixture cleanup failure"));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(cleanup).toHaveBeenCalledTimes(3);
});
