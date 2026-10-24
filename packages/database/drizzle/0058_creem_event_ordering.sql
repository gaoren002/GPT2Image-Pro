-- Creem 已验签事件身份与订阅状态水位；0057 永久保留空号，父侧最终统一排序 journal。
ALTER TABLE subscription ADD COLUMN IF NOT EXISTS creem_event_created_at bigint;
CREATE TABLE IF NOT EXISTS creem_webhook_event (
  event_id text PRIMARY KEY,
  event_created_at bigint NOT NULL CHECK (event_created_at >= 1000000000000),
  payload_hash text NOT NULL,
  received_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS creem_subscription_state (
  subscription_id text PRIMARY KEY,
  user_id text REFERENCES "user"(id) ON DELETE RESTRICT,
  event_id text NOT NULL,
  event_created_at bigint NOT NULL CHECK (event_created_at >= 1000000000000),
  snapshot json NOT NULL
);
-- 历史行没有可靠 provider 时间，不把本机 updated_at 编造成版本；首次事件保守保护旧限制状态。
