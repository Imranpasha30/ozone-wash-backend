-- Migration 015: Auto Wash pricing catalog
-- Spec: Auto Wash Scope PDF Section 3.2 (packages, add-ons, subscription plans)
--
-- Three lookup tables:
--   auto_wash_packages          — 4 service packages × vehicle pricing
--   auto_wash_addons            — 10 add-on services with per-vehicle pricing
--   auto_wash_subscription_plans — 9 subscription plan templates
--
-- All prices stored in PAISE (₹1 = 100 paise), GST-inclusive.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ──────────────────────────────────────────────────────────────────────────
-- Packages
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auto_wash_packages (
  code                  VARCHAR(20) PRIMARY KEY
                          CHECK (code IN ('ecorinse', 'ecoshield', 'ozonecomplete', 'hygieneelite')),
  display_name          VARCHAR(50) NOT NULL,
  tagline               TEXT NOT NULL,
  features              JSONB NOT NULL DEFAULT '[]'::jsonb,         -- bullet list shown in UI
  price_hatchback_paise INTEGER NOT NULL,
  price_sedan_paise     INTEGER NOT NULL,
  price_suv_paise       INTEGER NOT NULL,                            -- SUV-MUV tier
  price_luxury_paise    INTEGER NOT NULL,
  display_order         SMALLINT NOT NULL DEFAULT 0,
  active                BOOLEAN NOT NULL DEFAULT true,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO auto_wash_packages
  (code, display_name, tagline, features,
   price_hatchback_paise, price_sedan_paise, price_suv_paise, price_luxury_paise, display_order)
VALUES
  ('ecorinse', 'EcoRinse', 'Exterior ozone wash + precision dry',
    '["Exterior ozone wash","Precision microfibre dry","Hygiene snapshot photo","≈3L water used"]'::jsonb,
    39900, 44900, 49900, 59900, 1),
  ('ecoshield', 'EcoShield', 'Exterior + vacuum + basic interior + dashboard wipe',
    '["Everything in EcoRinse","Interior vacuum","Dashboard wipe","Basic interior protect"]'::jsonb,
    59900, 67400, 74900, 89900, 2),
  ('ozonecomplete', 'OzoneComplete', 'Full exterior + steam interior + cabin ozone fogging 8–12 min',
    '["Full exterior wash","Steam interior clean","Ozone cabin fogging (8–12 min)","QR-signed hygiene cert"]'::jsonb,
    89900, 99900, 109900, 129900, 3),
  ('hygieneelite', 'HygieneElite', 'All above + upholstery deep clean + engine bay clean',
    '["Everything in OzoneComplete","Upholstery deep steam clean","Engine bay degrease + clean","Full pre/post inspection"]'::jsonb,
    149900, 174900, 199900, 249900, 4)
ON CONFLICT (code) DO NOTHING;

-- ──────────────────────────────────────────────────────────────────────────
-- Add-ons
-- Each add-on has 4 vehicle prices (some are flat — store same value in all)
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auto_wash_addons (
  code                  VARCHAR(40) PRIMARY KEY,
  display_name          VARCHAR(80) NOT NULL,
  benefit               TEXT NOT NULL,                               -- 1-line shown to customer
  price_hatchback_paise INTEGER NOT NULL,
  price_sedan_paise     INTEGER NOT NULL,
  price_suv_paise       INTEGER NOT NULL,
  price_luxury_paise    INTEGER NOT NULL,
  display_order         SMALLINT NOT NULL DEFAULT 0,
  coming_soon           BOOLEAN NOT NULL DEFAULT false,
  active                BOOLEAN NOT NULL DEFAULT true,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO auto_wash_addons
  (code, display_name, benefit,
   price_hatchback_paise, price_sedan_paise, price_suv_paise, price_luxury_paise,
   display_order, coming_soon)
VALUES
  ('upholstery_deep_clean',     'Upholstery Deep Clean',
    'Steam-extract stains & allergens from fabric seats',
    49900, 59900, 69900, 79900, 1, false),
  ('ac_vent_ozone_fogging',     'AC Vent Ozone Fogging',
    'Kill mould inside AC vents — eliminate musty smell',
    19900, 22900, 24900, 29900, 2, false),
  ('dashboard_leather_cond',    'Dashboard & Leather Conditioning',
    'UV-protectant shine for dashboard & leather',
    29900, 32900, 36900, 39900, 3, false),
  ('headlight_restoration',     'Headlight Restoration',
    'Restore cloudy headlights — improve night visibility',
    39900, 44900, 49900, 59900, 4, false),
  ('engine_bay_clean',          'Engine Bay Clean',
    'Degrease engine bay — prevent rust & electrical issues',
    49900, 54900, 59900, 69900, 5, false),
  ('ceramic_nano_coat',         'Ceramic Nano-Coat Express',
    '3–6 month hydrophobic paint protection',
    99900, 119900, 134900, 149900, 6, false),
  ('pet_hair_removal',          'Pet Hair Removal',
    'Specialised vacuum + ozone deodorisation',
    29900, 34900, 44900, 49900, 7, false),
  ('odour_bomb_treatment',      'Odour Bomb Treatment',
    'High-intensity ozone blast for severe cabin odours',
    29900, 32900, 36900, 39900, 8, false),
  ('two_wheeler_wash',          '2-Wheeler Wash',
    'Quick bike wash at same location while car is done',
    14900, 17900, 19900, 24900, 9, false),
  ('standalone_certificate',    'Hygiene Certificate (standalone)',
    'WhatsApp + app hygiene report — free with OzoneComplete+',
    9900, 9900, 9900, 9900, 10, false)
ON CONFLICT (code) DO NOTHING;

-- ──────────────────────────────────────────────────────────────────────────
-- Subscription plans (templates — actual subscriptions in auto_subscriptions)
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auto_wash_subscription_plans (
  code                  VARCHAR(30) PRIMARY KEY
                          CHECK (code IN (
                            'weekly', 'monthly_silver', 'monthly_gold', 'bimonthly',
                            'quarterly', 'half_yearly', 'yearly', 'fleet', 'family'
                          )),
  display_name          VARCHAR(80) NOT NULL,
  cadence_label         VARCHAR(60) NOT NULL,                        -- e.g. '4× EcoRinse / month'
  washes_per_cycle      INTEGER NOT NULL,                            -- 0 for fleet (custom)
  cycle_days            INTEGER NOT NULL,                            -- billing cycle in days (7, 30, 60, 90, 180, 365)
  price_hatchback_paise INTEGER NOT NULL,                            -- 0 if custom (fleet)
  price_suv_paise       INTEGER NOT NULL,
  addon_discount_pct    SMALLINT NOT NULL DEFAULT 0,
  highlight             BOOLEAN NOT NULL DEFAULT false,              -- e.g. "Best Value"
  display_order         SMALLINT NOT NULL DEFAULT 0,
  active                BOOLEAN NOT NULL DEFAULT true,
  notes                 TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO auto_wash_subscription_plans
  (code, display_name, cadence_label, washes_per_cycle, cycle_days,
   price_hatchback_paise, price_suv_paise, addon_discount_pct, highlight, display_order, notes)
VALUES
  ('weekly',          'Weekly Flex',       '4× EcoRinse per month (every week)', 4,   30,  34900,  42900, 10, false, 1, 'No lock-in. Cancel anytime.'),
  ('monthly_silver',  'Monthly Silver',    '4× EcoRinse per month',              4,   30, 129900, 159900, 15, false, 2, 'No lock-in.'),
  ('monthly_gold',    'Monthly Gold',      '8× EcoRinse per month',              8,   30, 229900, 289900, 20, false, 3, 'No lock-in.'),
  ('bimonthly',       'Bi-Monthly',        '8 washes over 2 months',             8,   60, 219900, 279900, 15, false, 4, 'No lock-in.'),
  ('quarterly',       'Quarterly',         '12 washes over 3 months',           12,   90, 349900, 429900, 18, false, 5, '1-month notice to cancel.'),
  ('half_yearly',     'Half-Yearly',       '24 washes over 6 months',           24,  180, 649900, 799900, 22, false, 6, '1-month notice to cancel.'),
  ('yearly',          'Yearly',            '48 washes over 12 months',          48,  365, 1199900, 1499900, 25, true, 7, 'Best value. 1-month notice to cancel.'),
  ('fleet',           'Fleet Plan (5+ vehicles)', 'Custom frequency — weekly / monthly / quarterly', 0, 30, 0, 0, 0, false, 8, 'Custom quote. Contact sales.'),
  ('family',          'Family Plan (2 cars, same address)', '15% bundle discount on any plan', 0, 30, 0, 0, 15, false, 9, 'Applies on top of selected plan price.')
ON CONFLICT (code) DO NOTHING;
