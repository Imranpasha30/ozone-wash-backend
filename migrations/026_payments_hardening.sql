-- ═══════════════════════════════════════════════════════════════════════
-- 026_payments_hardening.sql — partial refunds + gateway webhooks
--
-- Adds:
--   • refunded_paise ledger column on bookings + amc_contracts
--   • payment_refunds  — one row per refund (full or partial), audit trail
--   • webhook_events   — idempotency store for gateway webhooks
--
-- payment_status has no CHECK constraint (see 001), so 'partially_refunded'
-- is introduced without an ALTER TYPE. All money is PAISE.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE bookings       ADD COLUMN IF NOT EXISTS refunded_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE amc_contracts  ADD COLUMN IF NOT EXISTS refunded_paise INTEGER NOT NULL DEFAULT 0;

-- ── Refund ledger ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payment_refunds (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id        UUID REFERENCES bookings(id)      ON DELETE SET NULL,
  amc_contract_id   UUID REFERENCES amc_contracts(id) ON DELETE SET NULL,
  amount_paise      INTEGER NOT NULL CHECK (amount_paise > 0),
  gateway           VARCHAR(16),
  gateway_refund_id TEXT,
  reason            TEXT,
  created_by        UUID REFERENCES users(id) ON DELETE SET NULL, -- admin who issued it
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_refunds_booking ON payment_refunds(booking_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_refunds_amc     ON payment_refunds(amc_contract_id, created_at DESC);

-- ── Webhook idempotency store ────────────────────────────────────────────
-- (gateway, event_id) is unique so a redelivered webhook is a no-op.
CREATE TABLE IF NOT EXISTS webhook_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gateway      VARCHAR(16) NOT NULL,
  event_id     TEXT        NOT NULL,
  event_type   VARCHAR(60),
  payload      JSONB,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (gateway, event_id)
);
CREATE INDEX IF NOT EXISTS idx_webhook_events_type ON webhook_events(gateway, event_type, processed_at DESC);
