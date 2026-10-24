/** 每个 Web 进程维护其所在磁盘的缩略图缓存；不经跨实例 DB 锁，不依赖内部财务调度开关。 */
import { describeErrorForLog } from "@repo/shared/db/error-summary";
import { invokeOperation } from "@repo/shared/uol";
import "@/features/image-backend-pool/retention-operation";

const cacheGlobal = globalThis as typeof globalThis & {
  __gpt2imageCacheMaintenanceStarted?: boolean;
};

/** 首次一分钟后清理；一次完成后再安排下一次，慢磁盘不叠加清理，无需连接数据库。 */
export function startInstanceCacheMaintenance(): void {
  if (cacheGlobal.__gpt2imageCacheMaintenanceStarted) return;
  cacheGlobal.__gpt2imageCacheMaintenanceStarted = true;
  const schedule = () => {
    const timer = setTimeout(() => {
      void tick().catch((error: unknown) => {
        console.warn(
          "[thumbnail-cache] maintenance failed",
          describeErrorForLog(error)
        );
      });
    }, 60_000);
    timer.unref?.();
  };
  const tick = async () => {
    try {
      await invokeOperation(
        "storage.cleanupThumbnailCache",
        {},
        { type: "cron", job: "instance-thumbnail-cache" }
      );
    } catch (error) {
      console.warn(
        "[thumbnail-cache] cleanup failed",
        describeErrorForLog(error)
      );
    } finally {
      schedule();
    }
  };
  schedule();
}
