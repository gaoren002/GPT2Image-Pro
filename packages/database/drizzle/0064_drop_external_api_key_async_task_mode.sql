-- 撤下外部 API Key 的异步任务模式（0063 为它新增的列），表结构回到 0062 时的状态。
--
-- 必须在不再读取该列的 Web 上线之后执行：0063 那一版的外部 API 鉴权查询会选取
-- async_task_mode，先删列会让全部外部 API 鉴权失败。该列只存一个已撤下功能的开关，
-- 删除不影响其他字段。DROP COLUMN 只改目录、不重写表；IF EXISTS 保证重放幂等。
ALTER TABLE "external_api_key"
 DROP COLUMN IF EXISTS "async_task_mode";
