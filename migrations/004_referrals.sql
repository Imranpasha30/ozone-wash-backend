-- Migration 004: Referrals tracking
--
-- Backs the /api/v1/mis/referrals dashboard. Every referral originates from
-- a `referral_source` (a watchman / facilities manager / society contact /
-- apartment manager / etc.). Each referral may convert into a booking and
-- eventually an AMC contract — both are tracked here so we can compute the
-- ROI uplift of each source.

CREATE TABLE IF NOT EXISTS referral_sources (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type        TEXT NOT NULL CHECK (type IN (
                'facilities_manager',
                'watchman',
                'apartment_manager',
                'society_secretary',
                'other'
              )),
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL,
  notes       TEXT,
  active      BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS referrals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       UUID REFERENCES referral_sources(id),
  customer_id     UUID REFERENCES users(id),
  booking_id      UUID REFERENCES bookings(id),
  amc_contract_id UUID REFERENCES amc_contracts(id),
  status          TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'converted', 'lost')),
  points_awarded  INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_referrals_source ON referrals(source_id);
CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status);
