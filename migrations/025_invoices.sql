-- ═══════════════════════════════════════════════════════════════════════
-- 025_invoices.sql — GST tax-invoice system for bookings + AMC contracts
--
-- Adds tax-compliant invoicing on top of the existing (GST-inclusive) billing
-- engine: a per-fiscal-year sequential invoice number, CGST/SGST split, SAC
-- codes, a billing snapshot, and a link to the generated PDF (R2).
--
-- All money is PAISE (₹1 = 100 paise), GST-INCLUSIVE (matches pricing.js).
-- ═══════════════════════════════════════════════════════════════════════

-- ── Per-fiscal-year invoice number sequence ──────────────────────────────
-- Indian FY runs Apr–Mar. invoice_number = OW/<FY>/<5-digit seq>, e.g.
-- OW/2026-27/00001. The UPSERT below is atomic so concurrent payments can
-- never collide on a number.
CREATE TABLE IF NOT EXISTS invoice_sequences (
  fiscal_year VARCHAR(9) PRIMARY KEY,     -- e.g. '2026-27'
  last_seq    INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Invoices ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number     VARCHAR(32) UNIQUE NOT NULL,      -- OW/2026-27/00001
  fiscal_year        VARCHAR(9)  NOT NULL,
  seq                INTEGER     NOT NULL,

  -- What this invoice bills for (exactly one of booking/amc is set)
  source_type        VARCHAR(12) NOT NULL CHECK (source_type IN ('booking','amc')),
  booking_id         UUID REFERENCES bookings(id)      ON DELETE SET NULL,
  amc_contract_id    UUID REFERENCES amc_contracts(id) ON DELETE SET NULL,

  -- Bill-to snapshot (frozen at issue time; a later profile edit must not
  -- retro-change a tax document)
  customer_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  customer_name      VARCHAR(160),
  customer_phone     VARCHAR(20),
  customer_email     VARCHAR(160),
  billing_address    TEXT,
  customer_gstin     VARCHAR(20),                       -- B2B customer GSTIN (optional)

  -- Tax fields
  sac_code           VARCHAR(10)  NOT NULL DEFAULT '998534', -- 998534 tank / 998538 auto
  place_of_supply    VARCHAR(40)  NOT NULL DEFAULT 'Telangana (36)',
  gst_rate_pct       NUMERIC(4,1) NOT NULL DEFAULT 18.0,
  line_items         JSONB        NOT NULL DEFAULT '[]'::jsonb,
  taxable_value_paise INTEGER     NOT NULL,             -- ex-GST
  cgst_paise         INTEGER      NOT NULL,             -- 9%
  sgst_paise         INTEGER      NOT NULL,             -- 9%
  total_paise        INTEGER      NOT NULL,             -- GST-inclusive grand total

  -- Payment linkage
  payment_gateway    VARCHAR(16),                       -- razorpay | easebuzz | cod
  payment_ref        TEXT,                              -- gateway payment id
  payment_status     VARCHAR(16) NOT NULL DEFAULT 'paid',

  -- Generated document
  pdf_key            TEXT,
  pdf_url            TEXT,

  status             VARCHAR(12) NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','cancelled')),
  issued_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One issued invoice per paid booking / per AMC contract (idempotency guard).
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_booking
  ON invoices(booking_id) WHERE booking_id IS NOT NULL AND status = 'issued';
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_amc
  ON invoices(amc_contract_id) WHERE amc_contract_id IS NOT NULL AND status = 'issued';

CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_issued   ON invoices(issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_fy        ON invoices(fiscal_year, seq);
