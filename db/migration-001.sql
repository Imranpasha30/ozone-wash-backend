-- Migration 001 — Run in Supabase SQL Editor
-- Adds columns required by booking.repository.js, job.repository.js, certificate

-- ── bookings ─────────────────────────────────────────────────────────────────
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS tanks           JSONB,
  ADD COLUMN IF NOT EXISTS property_type   VARCHAR(50) DEFAULT 'residential',
  ADD COLUMN IF NOT EXISTS contact_name    VARCHAR(255),
  ADD COLUMN IF NOT EXISTS contact_phone   VARCHAR(15),
  ADD COLUMN IF NOT EXISTS eco_discount_pct     DECIMAL,
  ADD COLUMN IF NOT EXISTS eco_discount_amount  INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS eco_discount_label   VARCHAR(100);

-- ── jobs ─────────────────────────────────────────────────────────────────────
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS end_otp_satisfied    VARCHAR(6),
  ADD COLUMN IF NOT EXISTS end_otp_unsatisfied  VARCHAR(6),
  ADD COLUMN IF NOT EXISTS customer_satisfied   BOOLEAN;

-- ── compliance_logs ──────────────────────────────────────────────────────────
ALTER TABLE compliance_logs
  ADD COLUMN IF NOT EXISTS microbial_result VARCHAR(10) CHECK (microbial_result IN ('pass', 'fail')),
  ADD COLUMN IF NOT EXISTS microbial_notes  TEXT;

-- ── hygiene_certificates ─────────────────────────────────────────────────────
ALTER TABLE hygiene_certificates
  ADD COLUMN IF NOT EXISTS badge_level VARCHAR(20)
    CHECK (badge_level IN ('bronze', 'silver', 'gold', 'platinum'));
