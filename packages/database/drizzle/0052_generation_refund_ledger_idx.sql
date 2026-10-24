-- R10：generation 净扣费退款查询。只加速同用户同任务的消费/已退查询，不改变金额。
-- 部署前置：
-- 1. 核对既有 0029 的 per-user 交易幂等索引已生效；检查历史消费/退款的
--    metadata.generationId 是否齐全、归属是否正确。缺失任务 ID 的历史消费不会
--    凭 source_ref 猜测退款，须经账本审计后单独回填，不能拿 generation 行金额补作消费。
-- 2. 大表须先在迁移事务外执行下方同定义的 CREATE INDEX CONCURRENTLY，确认索引有效。
--    本文件保留普通 IF NOT EXISTS 供事务内迁移登记；未经预建直接跑可能阻塞写入。
-- 3. 更新所有调用 refundGenerationCredits 的 Web/worker/维护进程并排空旧调用。
--    旧实例不参与 generation 事务锁，混跑期间不能承诺退款封顶成立。
-- 4. 父代理统一完成真实 PostgreSQL 并发、回滚与 Key 配额验收后再部署。
--    历史扣费缺 externalApiKeyId 的记录仅可确认钱包退款，Key 退额边界见退款交易审计。
-- 预建命令（仅供部署评审，不在本轮执行）：
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS "credits_transaction_user_generation_refund_idx"
-- ON "credits_transaction" ("user_id", ("metadata"->>'generationId'))
-- WHERE "type" IN ('consumption', 'refund');
CREATE INDEX IF NOT EXISTS "credits_transaction_user_generation_refund_idx"
ON "credits_transaction" ("user_id", ("metadata"->>'generationId'))
WHERE "type" IN ('consumption', 'refund');
