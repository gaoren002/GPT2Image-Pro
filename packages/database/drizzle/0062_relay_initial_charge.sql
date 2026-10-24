-- pureRelay 初始消费的财务标记；与消费同事务插入，不保存请求/响应/图片/任意错误。
CREATE TABLE IF NOT EXISTS "relay_initial_charge" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "generation_id" text NOT NULL,
  "consumption_transaction_id" text NOT NULL REFERENCES "credits_transaction"("id"),
  "api_key_id" text,
  "amount" numeric(12,2) NOT NULL,
  "state" text NOT NULL DEFAULT 'captured',
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "relay_initial_charge_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "relay_initial_charge_state_check" CHECK ("state" IN ('captured','dispatched','refund_pending','refund_enqueued'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "relay_initial_charge_user_generation_unique"
  ON "relay_initial_charge" ("user_id", "generation_id");
CREATE UNIQUE INDEX IF NOT EXISTS "relay_initial_charge_transaction_unique"
  ON "relay_initial_charge" ("consumption_transaction_id");
CREATE INDEX IF NOT EXISTS "relay_initial_charge_due_idx"
  ON "relay_initial_charge" ("expires_at", "id")
  WHERE "state" IN ('captured','refund_pending');
