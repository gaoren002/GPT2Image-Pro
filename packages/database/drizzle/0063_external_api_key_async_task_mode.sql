-- 外部 API Key 异步任务模式开关（兼容速度马 suduma 的提交与查询格式）。
--
-- async_task_mode=true 时，该 key 的 /v1/images/generations 与 /v1/images/edits 一律异步执行：
-- 立即返回 {requestId, status:"processing"}，结果用 GET /v1/tasks/{requestId} 查询。
-- 执行、扣费与失败退款与普通 async 相同。默认 false，现有 key 的行为完全不变。
-- 常量默认值的 ADD COLUMN 只改目录，不重写表。
ALTER TABLE "external_api_key"
 ADD COLUMN IF NOT EXISTS "async_task_mode" boolean NOT NULL DEFAULT false;
