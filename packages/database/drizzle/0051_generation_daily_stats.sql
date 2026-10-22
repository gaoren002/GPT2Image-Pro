-- generation 按 UTC 日汇总(全局状态页"全站累计"的已结算前缀)
-- 全站累计原为对 generation 全表聚合:产图数要逐行读 metadata(json 文本类型,
-- 每次 ::jsonb 都需 TOAST 解压 + 整段 JSON 解析),130 万行实测 27-31 秒;缓存
-- 冷启动(每次部署 / 手动刷新)都把这 30 秒压在页面请求上。
-- 改为:已结算的日期(早于"昨天 UTC 0 点")由内置定时任务 generation-daily-stats
-- 汇总进本表,页面只读本表求和 + 实时聚合最近一两天的尾巴。
-- 口径与原全表聚合逐项一致(上线前生产对照:按日求和与全表结果 6 项全等)。
-- 用户硬删除、图片销毁(storage_key 置空)会改写旧行,由任务按 refreshed_at
-- 轮转重算吸收,漂移有界。
-- 表与列均可由任务从 generation 完整重建,删除本表不丢失任何业务数据。
CREATE TABLE IF NOT EXISTS "generation_daily_stats" (
  "day" date PRIMARY KEY NOT NULL,
  "total" integer DEFAULT 0 NOT NULL,
  "completed" integer DEFAULT 0 NOT NULL,
  "failed" integer DEFAULT 0 NOT NULL,
  "pending" integer DEFAULT 0 NOT NULL,
  "completed_images" integer DEFAULT 0 NOT NULL,
  "credits_consumed" numeric(18, 2) DEFAULT 0 NOT NULL,
  "refreshed_at" timestamp DEFAULT now() NOT NULL
);
