-- 升级折抵预留、支付事实及财务证据约束；手写幂等迁移，不重写已有订单。
ALTER TABLE epay_order ADD COLUMN IF NOT EXISTS payment_trade_no text;
ALTER TABLE epay_order ADD COLUMN IF NOT EXISTS paid_amount numeric(12,2);
CREATE UNIQUE INDEX IF NOT EXISTS epay_order_payment_trade_no_unique ON epay_order(payment_trade_no);
CREATE TABLE IF NOT EXISTS upgrade_reservation (
  out_trade_no text PRIMARY KEY REFERENCES epay_order(out_trade_no) ON DELETE RESTRICT,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  client_request_id text NOT NULL,
  state text NOT NULL,
  snapshot json NOT NULL,
  expires_at timestamp NOT NULL,
  settled_at timestamp,
  release_reason text,
  refund_ref text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT upgrade_reservation_state_check CHECK (state IN ('held','settled','released','refund_pending','refunded'))
);
CREATE UNIQUE INDEX IF NOT EXISTS upgrade_reservation_user_request_unique ON upgrade_reservation(user_id, client_request_id);
CREATE UNIQUE INDEX IF NOT EXISTS upgrade_reservation_user_open_unique ON upgrade_reservation(user_id)
  WHERE state = 'held' OR (state = 'refund_pending' AND settled_at IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS upgrade_reservation_refund_ref_unique ON upgrade_reservation(refund_ref) WHERE refund_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS upgrade_reservation_expiry_idx ON upgrade_reservation(expires_at) WHERE state = 'held';
CREATE TABLE IF NOT EXISTS upgrade_reservation_batch (
  batch_id text NOT NULL REFERENCES credits_batch(id) ON DELETE RESTRICT,
  out_trade_no text NOT NULL REFERENCES upgrade_reservation(out_trade_no) ON DELETE RESTRICT,
  amount numeric(18,2) NOT NULL CONSTRAINT upgrade_reservation_batch_amount_check CHECK(amount > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS upgrade_reservation_batch_order_unique ON upgrade_reservation_batch(out_trade_no, batch_id);
-- 独立旧代码路径的失败/重试不能覆盖受预留管理的订单终态。
CREATE OR REPLACE FUNCTION guard_upgrade_epay_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM upgrade_reservation WHERE out_trade_no = OLD.out_trade_no) AND
    (NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.amount IS DISTINCT FROM OLD.amount OR
     NEW.metadata::jsonb IS DISTINCT FROM OLD.metadata::jsonb AND
       (NEW.metadata::jsonb - 'upgradeRefundRef') IS DISTINCT FROM (OLD.metadata::jsonb - 'upgradeRefundRef') OR
     OLD.payment_trade_no IS NOT NULL AND
       (NEW.payment_trade_no IS DISTINCT FROM OLD.payment_trade_no OR NEW.paid_amount IS DISTINCT FROM OLD.paid_amount) OR
     OLD.status IN ('success','refund_pending','refunded','cancelled','expired') AND NEW.status = 'pending') THEN
    RAISE EXCEPTION 'upgrade order facts are immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_upgrade_epay_order_trigger ON epay_order;
CREATE TRIGGER guard_upgrade_epay_order_trigger BEFORE UPDATE ON epay_order FOR EACH ROW EXECUTE FUNCTION guard_upgrade_epay_order();

CREATE TABLE IF NOT EXISTS upgrade_reservation_request (
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  client_request_id text NOT NULL,
  out_trade_no text NOT NULL REFERENCES upgrade_reservation(out_trade_no) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS upgrade_reservation_request_unique ON upgrade_reservation_request(user_id, client_request_id);

-- 数据库兜底订单/批次/请求归属，防止未来新调用方错误拼接跨用户预留。
CREATE OR REPLACE FUNCTION guard_upgrade_reservation_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'upgrade_reservation' THEN
    IF NOT EXISTS (SELECT 1 FROM epay_order WHERE out_trade_no=NEW.out_trade_no AND user_id=NEW.user_id
        AND business_type='subscription' AND metadata->>'checkoutMode'='upgrade') THEN
      RAISE EXCEPTION 'upgrade reservation owner mismatch';
    END IF;
    IF TG_OP = 'UPDATE' THEN
      IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.client_request_id IS DISTINCT FROM OLD.client_request_id OR
        NEW.snapshot::jsonb IS DISTINCT FROM OLD.snapshot::jsonb OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR
        OLD.settled_at IS NOT NULL AND NEW.settled_at IS DISTINCT FROM OLD.settled_at THEN
        RAISE EXCEPTION 'upgrade reservation facts are immutable';
      END IF;
      IF NEW.state <> OLD.state AND NOT (
        OLD.state='held' AND NEW.state IN ('settled','released') OR
        OLD.state IN ('settled','released') AND NEW.state='refund_pending' OR
        OLD.state='refund_pending' AND NEW.state='refunded') THEN
        RAISE EXCEPTION 'invalid upgrade reservation transition';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'upgrade_reservation_batch' THEN
    IF NOT EXISTS (SELECT 1 FROM upgrade_reservation r JOIN credits_batch b ON b.user_id=r.user_id
        WHERE r.out_trade_no=NEW.out_trade_no AND b.id=NEW.batch_id AND b.source_type='subscription') THEN
      RAISE EXCEPTION 'upgrade reservation batch owner mismatch';
    END IF;
  ELSIF TG_TABLE_NAME = 'upgrade_reservation_request' THEN
    IF NOT EXISTS (SELECT 1 FROM upgrade_reservation WHERE out_trade_no=NEW.out_trade_no AND user_id=NEW.user_id) THEN
      RAISE EXCEPTION 'upgrade reservation request owner mismatch';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_upgrade_reservation_identity_trigger ON upgrade_reservation;
CREATE TRIGGER guard_upgrade_reservation_identity_trigger BEFORE INSERT OR UPDATE ON upgrade_reservation
  FOR EACH ROW EXECUTE FUNCTION guard_upgrade_reservation_identity();
DROP TRIGGER IF EXISTS guard_upgrade_reservation_batch_identity_trigger ON upgrade_reservation_batch;
CREATE TRIGGER guard_upgrade_reservation_batch_identity_trigger BEFORE INSERT OR UPDATE ON upgrade_reservation_batch
  FOR EACH ROW EXECUTE FUNCTION guard_upgrade_reservation_identity();
DROP TRIGGER IF EXISTS guard_upgrade_reservation_request_identity_trigger ON upgrade_reservation_request;
CREATE TRIGGER guard_upgrade_reservation_request_identity_trigger BEFORE INSERT OR UPDATE ON upgrade_reservation_request
  FOR EACH ROW EXECUTE FUNCTION guard_upgrade_reservation_identity();
