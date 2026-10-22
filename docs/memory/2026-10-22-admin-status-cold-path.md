# 2026-10-22 全局状态冷路径提速

## 现象与根因

- 全局状态页在缓存缺失时（部署 / 重启后首访、点"刷新"触发 `updateTag`）要等约 31 秒；缓存过期（>120s）时 `unstable_cache` 先返回旧值、后台重算，不阻塞。其余 dashboard 页面带会话实测均为 25-190ms，无同类问题。
- `generation.metadata` 是 `json`（文本）列，不是 `jsonb`。每个 `metadata::jsonb` 都要 TOAST 解压并整段解析，是这类聚合的全部成本：
  - 全站累计对约 130 万行各解析两次（`jsonb_typeof` + `#>>`），27-31 秒；
  - 耗时分布查询里同一行在 CASE / WHERE 中被引用十余次就解析十余次，7 天窗口 5.2 秒；
  - 窗口统计排在首批查询全部结束之后才开始。

## 方案（79db604、3da61f5）

- 表 `generation_daily_stats`（迁移 0051）：按 UTC 日汇总，只收早于"昨天 0 点"的已结算日期。读路径 `loadGenerationTotals`（`apps/web/src/server/generation-daily-stats.ts`）= 汇总前缀求和 + 实时尾巴（前缀最后一天的次日起）。前缀和与尾巴边界出自同一条语句快照，任务滞后时尾巴自动覆盖缺口。
- 内置任务 `generation-daily-stats`（lockKey 5，`INTERNAL_JOB_GENERATION_DAILY_STATS_INTERVAL_MINUTES`，默认 10 分钟）：表为空时全量回填（生产约 40 秒，后台）；之后补齐新结算的日期，并按 `refreshedAt` 轮转重算 7 天。用户硬删除与图片销毁（`storage_key` 置空）会改写旧行，约 4 小时轮完一圈，这就是累计值漂移的上界。
- 读 metadata 的 SQL 一律放进带 `offset 0` 的子查询，每行只转换一次（屏障阻止子查询被上拉展开后重复求值）。drizzle 的 `.offset(0)` 会被省略，必须写成原生 `sql` 再传给 `.from()`。审核重试另加 `metadata::text like '%"moderationPromptRepair"%'` 预过滤：键名在 JSON 文本中必然以原文出现，不会漏行。
- Top 错误改由 24h 窗口的全部失败行计算（原来取自带帽 10000 行、读整列 metadata 的采样）；次数相同按文本排序，保证结果确定。

## 效果与验证

- 冷路径 0.6 秒（原约 31 秒），热路径约 35ms。
- 在同一个可重复读快照里，旧全表聚合（27.2 秒）与新方案（0.54 秒）6 项全等。7 天窗口：耗时分布 5.2s -> 0.48s、聚合 0.81s -> 0.43s，用 EXCEPT 对照逐行一致。

## 注意

- 新写读 `generation.metadata` 的聚合时，务必保证每行只转换一次。
- 调度器关闭时，全站累计会退回全表实时聚合（结果准确，但很慢）。
- 0049-0051 都是手工执行的，没写 `drizzle.__drizzle_migrations`（账本停在 0048）。三个迁移都幂等，将来重放无害。

## 未处理（待定）

- `/v1/chat/completions` 收到 base64 输入图时，`buildInputImagesMetadata` 在没有 storageKey 的情况下回退到 `image.url`，把整段 data URI 写进了 `metadata.inputImages.images[].imageUrl`。生产有 470 行 metadata 超过 50KB（压缩后约 388MB，单行最大约 10MB），10 月仍在增长，所有读 metadata 的查询都要为它付出 TOAST 成本。可选方案：不落 data URI，或改为转存对象存储。要不要保留历史详情里的参考图显示，属于产品决定。
