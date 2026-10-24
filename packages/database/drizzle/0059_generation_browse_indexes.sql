-- R39 默认历史/图库模型列表与已完成图片计数。查询和显示语义不变。
-- 大表发布前必须在迁移事务之外按下方同定义 CONCURRENTLY 预建，并核对
-- pg_index.indisvalid=true；本文件只负责已存在索引的迁移登记，禁止盲跑阻塞写入。
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS generation_user_model_idx ON generation(user_id, model);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS generation_user_completed_storage_idx
--   ON generation(user_id, created_at) WHERE status='completed' AND storage_key IS NOT NULL;
-- 覆盖默认模型列表/完成图片计数，不声称解决任意 ILIKE、JSON筛选或深OFFSET分页。
DO $$ BEGIN
  IF pg_total_relation_size('generation') > 67108864 AND (
    NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      WHERE i.indrelid='generation'::regclass AND c.relname='generation_user_model_idx' AND i.indisvalid)
    OR NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      WHERE i.indrelid='generation'::regclass AND c.relname='generation_user_completed_storage_idx' AND i.indisvalid)
  ) THEN
    RAISE EXCEPTION 'Prebuild generation browse indexes concurrently and verify validity before migration';
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "generation_user_model_idx" ON "generation" ("user_id", "model");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "generation_user_completed_storage_idx"
ON "generation" ("user_id", "created_at")
WHERE "status"='completed' AND "storage_key" IS NOT NULL;
