-- Migration 014: Phase 3 — Ozone Auto Wash schema
-- Spec: Master Prompt v2.0 — PART 4 + Auto Wash Scope PDF Section 7
--
-- Adds tables for the Ozone Auto Wash (EV doorstep car hygiene) product:
--   ev_units                  — EV 3-wheeler fleet register
--   vehicles                  — customer vehicle profiles
--   auto_subscriptions        — car wash subscription plans (7 plan types + fleet/family)
--   auto_wash_step_logs       — 6-step crew compliance log + add-on steps
--   auto_wash_certificates    — car hygiene certificates (separate from tank certs)
-- Plus extends the existing jobs table with 18 columns for auto wash data.
-- Plus extends users.role CHECK to include 'fleet_client'.
--
-- Conventions:
--   • UUIDs (not INT) for primary keys, matching the rest of the codebase
--   • Money in PAISE (INTEGER), not DECIMAL — Master Prompt PART 9 #4
--   • TIMESTAMPTZ for all timestamps
--   • JSONB (not JSON) for array fields — better indexing
--   • VARCHAR + CHECK constraints (not ENUM types) to match existing pattern

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ──────────────────────────────────────────────────────────────────────────
-- Extend users.role to allow 'fleet_client'
-- ──────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Drop only the version of the constraint left by migration 013.
  -- If 013 hasn't been applied yet (i.e. still has 'admin'), we extend that
  -- version too — so this migration works in either order in dev.
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
  ALTER TABLE users
    ADD CONSTRAINT users_role_check
    CHECK (role IN ('customer', 'field_team', 'fleet_client'));
EXCEPTION WHEN check_violation THEN
  RAISE EXCEPTION
    'Cannot widen users.role CHECK because existing rows violate it. Migrate admins to admin_users first.';
END $$;

-- ──────────────────────────────────────────────────────────────────────────
-- ev_units — EV 3-wheeler fleet
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ev_units (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_code             VARCHAR(20) UNIQUE NOT NULL,        -- e.g. 'EV-HYD-01'
  registration_number   VARCHAR(20) UNIQUE NOT NULL,
  model                 VARCHAR(30) NOT NULL DEFAULT 'bajaj_re_ev'
                          CHECK (model IN ('bajaj_re_ev', 'piaggio_ape_ecity', 'other')),
  assigned_crew_id      UUID REFERENCES users(id),
  hub_location          VARCHAR(200),
  battery_capacity_kwh  DECIMAL(5,2),
  range_km              INTEGER,
  last_service_date     DATE,
  next_service_due_km   INTEGER,
  status                VARCHAR(20) NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'charging', 'maintenance', 'inactive')),
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ev_units_status ON ev_units(status);
CREATE INDEX IF NOT EXISTS idx_ev_units_crew   ON ev_units(assigned_crew_id);

-- ──────────────────────────────────────────────────────────────────────────
-- vehicles — customer vehicle profiles
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vehicles (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vehicle_type          VARCHAR(20) NOT NULL
                          CHECK (vehicle_type IN ('hatchback', 'sedan', 'suv_muv', 'luxury', 'two_wheeler')),
  registration_number   VARCHAR(20) NOT NULL,               -- partial display only; last 4 in cert
  make                  VARCHAR(100),
  model                 VARCHAR(100),
  year                  SMALLINT,                           -- Postgres has no YEAR type
  nickname              VARCHAR(50),
  registration_date     DATE,                               -- for car-birthday reminders
  is_primary            BOOLEAN NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vehicles_customer ON vehicles(customer_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_reg      ON vehicles(registration_number);

-- ──────────────────────────────────────────────────────────────────────────
-- auto_subscriptions — car wash subscription plans
-- One row per active subscription. Counters reset on next_billing_date.
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auto_subscriptions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id              UUID NOT NULL REFERENCES users(id),
  plan_type                VARCHAR(30) NOT NULL
                             CHECK (plan_type IN (
                               'weekly',
                               'monthly_silver',
                               'monthly_gold',
                               'bimonthly',
                               'quarterly',
                               'half_yearly',
                               'yearly',
                               'fleet',
                               'family'
                             )),
  vehicle_ids              JSONB NOT NULL DEFAULT '[]'::jsonb,   -- 1 for Silver/Gold, 2+ for Fleet/Family
  washes_per_cycle         INTEGER NOT NULL,                     -- Weekly:4 | M_Silver:4 | M_Gold:8 | BiMo:8 | Q:12 | H:24 | Y:48 | Fleet:custom
  washes_used_this_cycle   INTEGER NOT NULL DEFAULT 0,
  price_per_cycle_paise    INTEGER NOT NULL,                     -- PAISE
  billing_day_of_cycle     SMALLINT,                             -- day of month for auto-debit
  next_billing_date        DATE NOT NULL,
  status                   VARCHAR(20) NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'paused', 'cancelled', 'expired')),
  addon_discount_pct       SMALLINT NOT NULL DEFAULT 0,          -- per-plan discount on add-ons
  pause_until              DATE,
  cancellation_date        DATE,
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auto_subs_customer ON auto_subscriptions(customer_id);
CREATE INDEX IF NOT EXISTS idx_auto_subs_status   ON auto_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_auto_subs_billing  ON auto_subscriptions(next_billing_date)
  WHERE status = 'active';

-- ──────────────────────────────────────────────────────────────────────────
-- Extend jobs table with auto-wash columns
-- All new columns are nullable so tank-cleaning rows remain valid.
-- job_type CHECK widens to include 'auto_wash'.
-- ──────────────────────────────────────────────────────────────────────────
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS vehicle_id              UUID REFERENCES vehicles(id),
  ADD COLUMN IF NOT EXISTS service_package         VARCHAR(20)
                              CHECK (service_package IS NULL OR service_package IN (
                                'ecorinse', 'ecoshield', 'ozonecomplete', 'hygieneelite'
                              )),
  ADD COLUMN IF NOT EXISTS addons_booked           JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS addons_completed        JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS gated_community         BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS pre_inspection_photos   JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS ozone_ppm_reading       DECIMAL(4,2),
  ADD COLUMN IF NOT EXISTS fogging_ppm_reading     DECIMAL(4,2),
  ADD COLUMN IF NOT EXISTS fogging_duration_min    INTEGER,
  ADD COLUMN IF NOT EXISTS water_used_litres       DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS water_saved_litres      DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS ev_unit_id              UUID REFERENCES ev_units(id),
  ADD COLUMN IF NOT EXISTS subscription_job_id     UUID REFERENCES auto_subscriptions(id),
  ADD COLUMN IF NOT EXISTS base_price_paise        INTEGER,
  ADD COLUMN IF NOT EXISTS addons_price_paise      INTEGER,
  ADD COLUMN IF NOT EXISTS total_price_paise       INTEGER;

-- The existing jobs.job_type is VARCHAR(50) with no CHECK. Add one now so we
-- explicitly enumerate every job_type we accept.
DO $$
BEGIN
  ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_job_type_check;
  ALTER TABLE jobs
    ADD CONSTRAINT jobs_job_type_check
    CHECK (job_type IN ('tank_cleaning', 'iot_guard', 'auto_wash'));
END $$;

CREATE INDEX IF NOT EXISTS idx_jobs_vehicle      ON jobs(vehicle_id) WHERE vehicle_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_ev_unit      ON jobs(ev_unit_id) WHERE ev_unit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_subscription ON jobs(subscription_job_id) WHERE subscription_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_type_status  ON jobs(job_type, status, scheduled_at);

-- ──────────────────────────────────────────────────────────────────────────
-- auto_wash_step_logs — 6 core steps + add-on steps (one row per step)
-- Mirrors compliance_logs for tank hygiene.
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auto_wash_step_logs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id              UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  step_number         INTEGER NOT NULL CHECK (step_number BETWEEN 1 AND 16),
  step_name           VARCHAR(100) NOT NULL,                -- e.g. 'mist_rinse', 'ozone_fogging', 'upholstery_clean'
  step_type           VARCHAR(10) NOT NULL DEFAULT 'core'
                        CHECK (step_type IN ('core', 'addon')),
  started_at          TIMESTAMPTZ,
  ended_at            TIMESTAMPTZ,
  duration_minutes    INTEGER,
  photo_urls          JSONB DEFAULT '[]'::jsonb,            -- before/after photo URL array
  ozone_ppm           DECIMAL(4,2),                         -- for ozone steps 3, 6, AC fogging
  notes               TEXT,
  passed_validation   BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aw_step_logs_job      ON auto_wash_step_logs(job_id);
CREATE INDEX IF NOT EXISTS idx_aw_step_logs_job_step ON auto_wash_step_logs(job_id, step_number);
CREATE UNIQUE INDEX IF NOT EXISTS uq_aw_step_per_job ON auto_wash_step_logs(job_id, step_number);

-- ──────────────────────────────────────────────────────────────────────────
-- auto_wash_certificates — issued on job completion. Separate table from
-- the tank hygiene certificates to allow different fields and PDF templates.
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auto_wash_certificates (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                UUID NOT NULL UNIQUE REFERENCES jobs(id),
  vehicle_id            UUID NOT NULL REFERENCES vehicles(id),
  service_package       VARCHAR(20) NOT NULL,
  addons_included       JSONB DEFAULT '[]'::jsonb,
  ozone_ppm_exterior    DECIMAL(4,2),
  ozone_ppm_cabin       DECIMAL(4,2),
  fogging_duration_min  INTEGER,
  water_used_litres     DECIMAL(5,2),
  water_saved_litres    DECIMAL(5,2),
  eco_score             SMALLINT CHECK (eco_score IS NULL OR (eco_score >= 0 AND eco_score <= 100)),
  eco_badge             VARCHAR(10)
                          CHECK (eco_badge IS NULL OR eco_badge IN ('bronze', 'silver', 'gold', 'platinum')),
  crew_id               UUID REFERENCES users(id),
  ev_unit_id            UUID REFERENCES ev_units(id),
  qr_token              VARCHAR(64) UNIQUE NOT NULL,        -- token for /verify/AW-{token}
  certificate_pdf_url   TEXT,                                -- R2 URL
  valid_until           DATE,                                -- typically generated_at + 30 days
  whatsapp_sent         BOOLEAN NOT NULL DEFAULT false,
  status                VARCHAR(20) NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'revoked')),
  generated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aw_certs_vehicle   ON auto_wash_certificates(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_aw_certs_qr_token  ON auto_wash_certificates(qr_token);
CREATE INDEX IF NOT EXISTS idx_aw_certs_generated ON auto_wash_certificates(generated_at DESC);
