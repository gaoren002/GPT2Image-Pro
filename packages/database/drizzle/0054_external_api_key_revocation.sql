-- 用户撤销与管理员临时禁用分开。上线须先迁移，再替换所有可更改 Key 状态的旧进程。
ALTER TABLE "external_api_key" ADD COLUMN IF NOT EXISTS "revoked_at" timestamp;
-- 历史 inactive 无法识别是用户撤销还是管理员禁用，保守视为已撤销，避免复活泄露的 Key。
-- 这些历史 Key 不再重新启用；用户需要时创建新 Key。新管理员禁用不填写 revoked_at。
UPDATE "external_api_key" SET "revoked_at" = "updated_at"
WHERE "is_active" = false AND "revoked_at" IS NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'external_api_key_revocation_inactive') THEN
    ALTER TABLE "external_api_key" ADD CONSTRAINT "external_api_key_revocation_inactive"
      CHECK ("revoked_at" IS NULL OR "is_active" = false);
  END IF;
END $$;
