-- PL12：只追加池身份与轮换意图；journal由父代理统一整合，0057永久不用。
ALTER TABLE image_backend_account ADD COLUMN IF NOT EXISTS oauth_identity_key text;
CREATE UNIQUE INDEX IF NOT EXISTS image_backend_account_oauth_identity_unique
  ON image_backend_account (interface_mode, oauth_identity_key);
CREATE TABLE IF NOT EXISTS image_backend_token_rotation (
  id text PRIMARY KEY,
  owner text NOT NULL,
  journal_identity text,
  client_id text NOT NULL,
  state text NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared','uncertain','ready','done')),
  encrypted_plan text,
  accounts json,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
-- 兼容仅测试环境执行过旧候选的空库；旧未绑定pending不能自动消费RT。
ALTER TABLE image_backend_token_rotation ADD COLUMN IF NOT EXISTS journal_identity text;
CREATE INDEX IF NOT EXISTS image_backend_token_rotation_pending_idx
  ON image_backend_token_rotation (created_at) WHERE state = 'ready';
-- 认领时在全局 advisory 锁内检查未完成意图的绑定；done 行永久保留，必须只扫未完成行。
CREATE INDEX IF NOT EXISTS image_backend_token_rotation_unfinished_idx
  ON image_backend_token_rotation (journal_identity)
  WHERE state IN ('prepared', 'uncertain', 'ready');
-- 旧账号由可信RT导入在短事务内识别/绑定；不凭workspace ID批量误合并其他用户。
