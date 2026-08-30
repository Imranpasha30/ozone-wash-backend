-- ═══════════════════════════════════════════════════════════════════════
-- 033_payment_events.sql — full payment lifecycle ledger (inflow + outflow)
--
-- The `payments` table is a per-ORDER summary (created→captured…) and
-- `payment_refunds` is a per-REFUND record. This adds an APPEND-ONLY event
-- log that captures EVERY stage of money movement so admin/MIS can see the
-- complete timeline: order created → captured (IN) → refund initiated/queued
-- → refund processed/failed (OUT), plus COD + cancellation markers.
--
-- direction: 'in'  = money received (customer → us)
--            'out' = money returned (us → customer: refund/payout)
--            'neutral' = state marker (created, failed, cancelled)
-- All amounts in PAISE.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS payment_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id       UUID REFERENCES bookings(id)      ON DELETE SET NULL,
  amc_contract_id  UUID REFERENCES amc_contracts(id) ON DELETE SET NULL,
  order_id         TEXT,                 -- razorpay_order_id / payu txnid
  gateway          VARCHAR(16),          -- payu | razorpay | easebuzz | cod
  event_type       VARCHAR(40) NOT NULL, -- order_created | payment_attempted |
                                         -- payment_captured | payment_failed |
                                         -- refund_initiated | refund_queued |
                                         -- refund_processing | refund_processed |
                                         -- refund_failed | booking_cancelled |
                                         -- cod_pending | cod_collected
  direction        VARCHAR(8)  NOT NULL DEFAULT 'neutral'
                     CHECK (direction IN ('in', 'out', 'neutral')),
  amount_paise     INTEGER     NOT NULL DEFAULT 0,
  status           VARCHAR(24),          -- stage status (queued/processed/failed…)
  gateway_ref      TEXT,                 -- payment_id / refund request id
  note             TEXT,
  metadata         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL, -- admin/actor, nullable
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_events_booking ON payment_events(booking_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_events_order   ON payment_events(order_id);
CREATE INDEX IF NOT EXISTS idx_payment_events_type    ON payment_events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_events_dir     ON payment_events(direction, created_at DESC);

-- ── Refund lifecycle status on the refund record ──────────────────────────
-- 'initiated' → we sent it | 'queued' → gateway accepted | 'processing' →
-- gateway working | 'processed' → credited to customer | 'failed'.
ALTER TABLE payment_refunds
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'queued'
    CHECK (status IN ('initiated', 'queued', 'processing', 'processed', 'failed')),
  ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;
