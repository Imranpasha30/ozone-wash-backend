-- ──────────────────────────────────────────────────────────────────────────
-- 020_billing_v2.sql
-- Billing system v2 — aligns pricing with the "VHS Tank-Cleaning Pricing &
-- Billing Logic Spec" (Pricing & GST sheet = source of truth).
--
--   1. Re-seed pricing_tiers with the 8 authoritative size brackets
--   2. Re-seed pricing_matrix from the master formula:
--        per_tank_per_service = base × (1 − tank_count_disc) × (1 − freq_disc)
--        tank discounts:  1 → 0%, 2 → 15%, 3+ → 30%
--        plan discounts:  one_time/yearly → 0% (1/yr), half_yearly → 10% (2/yr),
--                         quarterly → 15% (4/yr), monthly → 30% (12/yr)
--      All paise values are GST-INCLUSIVE (ex-GST = value ÷ 1.18).
--   3. tank_addons — app-facing add-on price list ("Add On for APP" sheet)
--      with its own size buckets: 500–9,999 / 10,000–49,999 / 50,000–99,999 /
--      1,00,000+ (custom quote).
--   4. customer_addresses — Zomato-style saved address book.
--   5. booking_funnel — abandoned-checkout tracking for admin follow-up.
--   6. bookings + amc_contracts columns for AMC-at-checkout purchase linking.
-- ──────────────────────────────────────────────────────────────────────────

-- ── 1. Authoritative size brackets ────────────────────────────────────────
UPDATE pricing_tiers SET label = '500 – 1,000 L',       min_litres = 0,      max_litres = 1000,   requires_inspection = false WHERE id = 1;
UPDATE pricing_tiers SET label = '1,001 – 10,000 L',    min_litres = 1001,   max_litres = 10000,  requires_inspection = false WHERE id = 2;
UPDATE pricing_tiers SET label = '10,001 – 20,000 L',   min_litres = 10001,  max_litres = 20000,  requires_inspection = false WHERE id = 3;
UPDATE pricing_tiers SET label = '20,001 – 30,000 L',   min_litres = 20001,  max_litres = 30000,  requires_inspection = false WHERE id = 4;
UPDATE pricing_tiers SET label = '30,001 – 40,000 L',   min_litres = 30001,  max_litres = 40000,  requires_inspection = false WHERE id = 5;
UPDATE pricing_tiers SET label = '40,001 – 50,000 L',   min_litres = 40001,  max_litres = 50000,  requires_inspection = false WHERE id = 6;
UPDATE pricing_tiers SET label = '50,001 – 1,00,000 L', min_litres = 50001,  max_litres = 100000, requires_inspection = false WHERE id = 7;
UPDATE pricing_tiers SET label = '1,00,000+ L (Industrial/ISO)', min_litres = 100001, max_litres = NULL, requires_inspection = true WHERE id = 8;

-- ── 2. Re-seed the pricing matrix ─────────────────────────────────────────
-- Retire every previous row, then insert the spec-correct set. Old rows stay
-- for audit history (active = false).
UPDATE pricing_matrix SET active = false, updated_at = NOW() WHERE active = true;

-- Base rates (incl. GST): T1 ₹3,500 · T2 ₹3,500 · T3 ₹7,000 · T4 ₹9,000 ·
-- T5 ₹12,000 · T6 ₹14,000 · T7 ₹21,000 · T8 ₹25,000 (indicative, inspection)
INSERT INTO pricing_matrix
  (tier_id, plan, single_tank_paise, per_tank_2_paise, per_tank_2plus_paise, services_per_year, effective_from, active, notes)
VALUES
  -- Tier 1 — 500–1,000 L (base ₹3,500)
  (1, 'one_time',     350000,  297500,  245000,  1, CURRENT_DATE, true, 'Spec v2'),
  (1, 'half_yearly',  315000,  267750,  220500,  2, CURRENT_DATE, true, 'Spec v2'),
  (1, 'quarterly',    297500,  252875,  208250,  4, CURRENT_DATE, true, 'Spec v2'),
  (1, 'monthly',      245000,  208250,  171500, 12, CURRENT_DATE, true, 'Spec v2'),
  -- Tier 2 — 1,001–10,000 L (base ₹3,500 — deliberately same as Tier 1)
  (2, 'one_time',     350000,  297500,  245000,  1, CURRENT_DATE, true, 'Spec v2'),
  (2, 'half_yearly',  315000,  267750,  220500,  2, CURRENT_DATE, true, 'Spec v2'),
  (2, 'quarterly',    297500,  252875,  208250,  4, CURRENT_DATE, true, 'Spec v2'),
  (2, 'monthly',      245000,  208250,  171500, 12, CURRENT_DATE, true, 'Spec v2'),
  -- Tier 3 — 10,001–20,000 L (base ₹7,000)
  (3, 'one_time',     700000,  595000,  490000,  1, CURRENT_DATE, true, 'Spec v2'),
  (3, 'half_yearly',  630000,  535500,  441000,  2, CURRENT_DATE, true, 'Spec v2'),
  (3, 'quarterly',    595000,  505750,  416500,  4, CURRENT_DATE, true, 'Spec v2'),
  (3, 'monthly',      490000,  416500,  343000, 12, CURRENT_DATE, true, 'Spec v2'),
  -- Tier 4 — 20,001–30,000 L (base ₹9,000)
  (4, 'one_time',     900000,  765000,  630000,  1, CURRENT_DATE, true, 'Spec v2'),
  (4, 'half_yearly',  810000,  688500,  567000,  2, CURRENT_DATE, true, 'Spec v2'),
  (4, 'quarterly',    765000,  650250,  535500,  4, CURRENT_DATE, true, 'Spec v2'),
  (4, 'monthly',      630000,  535500,  441000, 12, CURRENT_DATE, true, 'Spec v2'),
  -- Tier 5 — 30,001–40,000 L (base ₹12,000)
  (5, 'one_time',    1200000, 1020000,  840000,  1, CURRENT_DATE, true, 'Spec v2'),
  (5, 'half_yearly', 1080000,  918000,  756000,  2, CURRENT_DATE, true, 'Spec v2'),
  (5, 'quarterly',   1020000,  867000,  714000,  4, CURRENT_DATE, true, 'Spec v2'),
  (5, 'monthly',      840000,  714000,  588000, 12, CURRENT_DATE, true, 'Spec v2'),
  -- Tier 6 — 40,001–50,000 L (base ₹14,000)
  (6, 'one_time',    1400000, 1190000,  980000,  1, CURRENT_DATE, true, 'Spec v2'),
  (6, 'half_yearly', 1260000, 1071000,  882000,  2, CURRENT_DATE, true, 'Spec v2'),
  (6, 'quarterly',   1190000, 1011500,  833000,  4, CURRENT_DATE, true, 'Spec v2'),
  (6, 'monthly',      980000,  833000,  686000, 12, CURRENT_DATE, true, 'Spec v2'),
  -- Tier 7 — 50,001–1,00,000 L (base ₹21,000)
  (7, 'one_time',    2100000, 1785000, 1470000,  1, CURRENT_DATE, true, 'Spec v2'),
  (7, 'half_yearly', 1890000, 1606500, 1323000,  2, CURRENT_DATE, true, 'Spec v2'),
  (7, 'quarterly',   1785000, 1517250, 1249500,  4, CURRENT_DATE, true, 'Spec v2'),
  (7, 'monthly',     1470000, 1249500, 1029000, 12, CURRENT_DATE, true, 'Spec v2'),
  -- Tier 8 — 1,00,000+ L (base ₹25,000 — INDICATIVE, requires inspection)
  (8, 'one_time',    2500000, 2125000, 1750000,  1, CURRENT_DATE, true, 'Spec v2 — indicative, inspection required'),
  (8, 'half_yearly', 2250000, 1912500, 1575000,  2, CURRENT_DATE, true, 'Spec v2 — indicative, inspection required'),
  (8, 'quarterly',   2125000, 1806250, 1487500,  4, CURRENT_DATE, true, 'Spec v2 — indicative, inspection required'),
  (8, 'monthly',     1750000, 1487500, 1225000, 12, CURRENT_DATE, true, 'Spec v2 — indicative, inspection required')
ON CONFLICT (tier_id, plan, effective_from) DO UPDATE SET
  single_tank_paise    = EXCLUDED.single_tank_paise,
  per_tank_2_paise     = EXCLUDED.per_tank_2_paise,
  per_tank_2plus_paise = EXCLUDED.per_tank_2plus_paise,
  services_per_year    = EXCLUDED.services_per_year,
  active               = true,
  notes                = EXCLUDED.notes,
  updated_at           = NOW();

-- ── 3. App-facing add-ons ("Add On for APP" sheet) ────────────────────────
-- Own size buckets (NOT the §2 brackets). NULL price = not offered ("–").
-- 1,00,000+ L is always a custom inspection quote.
CREATE TABLE IF NOT EXISTS tank_addons (
  code                VARCHAR(40) PRIMARY KEY,
  display_name        VARCHAR(80) NOT NULL,
  price_small_paise   INTEGER,          -- 500 – 9,999 L
  price_medium_paise  INTEGER,          -- 10,000 – 49,999 L
  price_large_paise   INTEGER,          -- 50,000 – 99,999 L
  coming_soon         BOOLEAN NOT NULL DEFAULT false,
  active              BOOLEAN NOT NULL DEFAULT true,
  display_order       SMALLINT NOT NULL DEFAULT 0,
  created_at          TIMESTAMP DEFAULT NOW(),
  updated_at          TIMESTAMP DEFAULT NOW()
);

INSERT INTO tank_addons (code, display_name, price_small_paise, price_medium_paise, price_large_paise, coming_soon, display_order) VALUES
  ('uv_sterilization',  'UV Sterilization Pass',           50000, 100000, 200000, false, 1),
  ('anti_algae',        'Anti-Algae Spray/Coating',        40000,  80000, 150000, false, 2),
  ('anti_lime',         'Anti-Lime / Descaling',           60000, 120000, 250000, false, 3),
  ('pathogen_testing',  'Pathogen Testing & Lab Report',  150000, 250000, 400000, false, 4),
  ('structural_audit',  'Structural Safety Audit',        150000, 250000, 350000, false, 5),
  ('iot_sensor',        'IoT Sensor Installation',          NULL, 1500000, 2500000, true, 6)
ON CONFLICT (code) DO UPDATE SET
  display_name       = EXCLUDED.display_name,
  price_small_paise  = EXCLUDED.price_small_paise,
  price_medium_paise = EXCLUDED.price_medium_paise,
  price_large_paise  = EXCLUDED.price_large_paise,
  coming_soon        = EXCLUDED.coming_soon,
  display_order      = EXCLUDED.display_order,
  updated_at         = NOW();

-- ── 4. Saved address book (Zomato/Swiggy-style) ───────────────────────────
CREATE TABLE IF NOT EXISTS customer_addresses (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  UUID NOT NULL REFERENCES users(id),
  label        VARCHAR(40) NOT NULL,     -- nickname: Home / Office / "Mom''s house"
  address      TEXT NOT NULL,
  lat          DECIMAL,
  lng          DECIMAL,
  is_default   BOOLEAN NOT NULL DEFAULT false,
  deleted_at   TIMESTAMP,                -- soft delete keeps old bookings readable
  created_at   TIMESTAMP DEFAULT NOW(),
  updated_at   TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_customer_addresses_customer
  ON customer_addresses(customer_id) WHERE deleted_at IS NULL;

-- ── 5. Abandoned-checkout funnel ──────────────────────────────────────────
-- One OPEN row per customer (converted = false). Every step the customer
-- reaches upserts this row; creating a booking flips converted = true.
-- Admin workflow: pending → ongoing → solved (handled_by = admin username so
-- two admins never chase the same lead).
CREATE TABLE IF NOT EXISTS booking_funnel (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id           UUID NOT NULL REFERENCES users(id),
  step_reached          SMALLINT NOT NULL DEFAULT 1,
  step_name             VARCHAR(40),
  draft                 JSONB DEFAULT '{}',
  status                VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','ongoing','solved')),
  handled_by            VARCHAR(60),
  admin_note            TEXT,
  converted             BOOLEAN NOT NULL DEFAULT false,
  converted_booking_id  UUID,
  last_activity_at      TIMESTAMP DEFAULT NOW(),
  created_at            TIMESTAMP DEFAULT NOW(),
  updated_at            TIMESTAMP DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_funnel_open_customer
  ON booking_funnel(customer_id) WHERE converted = false;
CREATE INDEX IF NOT EXISTS idx_booking_funnel_status
  ON booking_funnel(status) WHERE converted = false;

-- ── 6. Booking / AMC linking for checkout upsell ──────────────────────────
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS plan            VARCHAR(20) DEFAULT 'one_time',
  ADD COLUMN IF NOT EXISTS amc_contract_id UUID REFERENCES amc_contracts(id),
  ADD COLUMN IF NOT EXISTS pricing         JSONB;

ALTER TABLE amc_contracts
  ADD COLUMN IF NOT EXISTS tank_size_litres  DECIMAL,
  ADD COLUMN IF NOT EXISTS tank_count        SMALLINT DEFAULT 1,
  ADD COLUMN IF NOT EXISTS services_per_year SMALLINT,
  ADD COLUMN IF NOT EXISTS source            VARCHAR(30) DEFAULT 'standalone';
