/** 缓存与池历史维护的 UOL 入口；固定维护预算，不接受外部任意截止时间或磁盘路径。 */
import { defineOperation } from "@repo/shared/uol";
import { z } from "zod";

export const cleanupPoolRetention = defineOperation({
  name: "image-backend-pool.cleanupRetention",
  domain: "image-backend-pool",
  title: "清理过期池历史",
  description: "按固定预算清理过期粘性绑定及30天前的调度指标",
  input: z.object({}).strict(),
  output: z.object({ stickyDeleted: z.number(), metricsDeleted: z.number() }),
  access: { kind: "cron" },
  readOnly: false,
  destructive: true,
  idempotency: { kind: "natural" },
  sideEffects: ["cache"],
  execute: async () =>
    (await import("./retention")).cleanupImageBackendRetention(),
});

export const cleanupLocalThumbnails = defineOperation({
  name: "storage.cleanupThumbnailCache",
  domain: "storage",
  title: "清理本机缩略图缓存",
  description: "仅清理执行实例所在磁盘；保留配额和固定TTL，不清理其他节点",
  input: z.object({}).strict(),
  output: z.object({ deleted: z.number(), legacyDeleted: z.number() }),
  access: { kind: "cron" },
  readOnly: false,
  destructive: true,
  processLocalState: true,
  idempotency: { kind: "natural" },
  sideEffects: ["cache", "storage"],
  execute: async () =>
    (
      await import("@repo/shared/storage/thumbnail-cache")
    ).cleanupThumbnailCache(),
});
