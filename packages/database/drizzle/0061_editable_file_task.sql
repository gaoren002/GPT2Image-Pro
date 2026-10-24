-- R05：任务执行墓碑与结果引用，不保存请求内容或凭据；金额真相仍在 credits_transaction。
CREATE TABLE IF NOT EXISTS "editable_file_task" (
  "id" text PRIMARY KEY,
  "public_id" text NOT NULL UNIQUE,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "api_key_id" text,
  "kind" text NOT NULL CHECK (kind IN ('ppt', 'psd')),
  "request_fingerprint" text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  "claim_token" text NOT NULL,
  "state" text NOT NULL CHECK (state IN ('prepared', 'running', 'completed', 'refund_pending', 'refunded', 'failed')),
  "quoted_credits" numeric(12,2) NOT NULL CHECK (quoted_credits >= 0),
  "result_references" json,
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CHECK ((state = 'completed') = (result_references IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS "editable_file_task_due_idx"
  ON "editable_file_task" ("expires_at", "id")
  WHERE state IN ('prepared', 'running', 'refund_pending');
