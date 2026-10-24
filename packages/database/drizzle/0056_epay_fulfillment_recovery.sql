-- 普通 Epay 收款事实、可过期租约、冻结履约计划与终态；不修改 R08 的升级结算。
ALTER TABLE epay_order ADD COLUMN IF NOT EXISTS paid_at timestamp;
ALTER TABLE epay_order ADD COLUMN IF NOT EXISTS payment_method text;
ALTER TABLE epay_order ADD COLUMN IF NOT EXISTS fulfillment_state text NOT NULL DEFAULT 'pending';
ALTER TABLE epay_order ADD COLUMN IF NOT EXISTS fulfillment_lease_token text;
ALTER TABLE epay_order ADD COLUMN IF NOT EXISTS fulfillment_lease_expires_at timestamp;
ALTER TABLE epay_order ADD COLUMN IF NOT EXISTS fulfillment_plan json;
ALTER TABLE epay_order ADD COLUMN IF NOT EXISTS fulfilled_at timestamp;

-- 历史 success 是旧 claim 提交时点，不能当作履约完成证明。保留该时点作为可用的
-- 首次收款近似值；没有网关流水不编造流水。已退款和 upgrade 均不自动重放。
UPDATE epay_order e SET paid_at = e.updated_at
WHERE e.status = 'success' AND e.paid_at IS NULL
  AND COALESCE(e.metadata->>'checkoutMode', '') <> 'upgrade'
  AND NOT EXISTS (SELECT 1 FROM upgrade_reservation u WHERE u.out_trade_no = e.out_trade_no);

-- 历史批次的原始周期和金额在恢复时按唯一 source_ref 读取并冻结，
-- 已有批次只补后续步骤；无批次才 grant，不把历史 success 逐笔重新发放。
CREATE INDEX IF NOT EXISTS epay_order_fulfillment_due_idx ON epay_order (updated_at)
WHERE paid_at IS NOT NULL AND fulfillment_state <> 'fulfilled'
  AND status NOT IN ('refund_pending', 'refunded');
