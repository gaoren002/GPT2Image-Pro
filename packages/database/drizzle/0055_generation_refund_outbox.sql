-- R11：只持久化退款财务标量；纯中转/可编辑文件没有 generation 行，故不关联该表。
-- 先部署此表再启动新退款入口/worker，不能在缺表时降级为非持久退款。
-- 0053 升级 hold、0054 Key revocation 由其他代理维护，不在本迁移改写。
-- 失败存量由在线有界恢复扫描回填；历史消费缺 generationId/Key 归属不可据展示金额造账。
CREATE TABLE IF NOT EXISTS "generation_refund_outbox" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "generation_id" text NOT NULL,
  "source_ref" text NOT NULL,
  "requested_amount" numeric(12, 2) NOT NULL,
  "target_credits" numeric(12, 2) NOT NULL DEFAULT 0,
  "state" text NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamp NOT NULL DEFAULT now(),
  "created_at" timestamp NOT NULL DEFAULT now(),
  "settled_at" timestamp,
  CONSTRAINT "generation_refund_outbox_state_check" CHECK ("state" IN ('pending', 'settled')),
  CONSTRAINT "generation_refund_outbox_amount_check" CHECK ("requested_amount" >= 0 AND "target_credits" >= 0 AND "attempts" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "generation_refund_outbox_user_ref_unique"
ON "generation_refund_outbox" ("user_id", "source_ref");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "generation_refund_outbox_due_idx"
ON "generation_refund_outbox" ("next_attempt_at", "id") WHERE "state" = 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "generation_refund_outbox_task_idx"
ON "generation_refund_outbox" ("user_id", "generation_id");
