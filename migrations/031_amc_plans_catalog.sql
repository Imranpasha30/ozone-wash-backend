-- ═══════════════════════════════════════════════════════════════════════
-- 031_amc_plans_catalog.sql — admin-editable AMC plan display names/copy
--
-- Prices ALWAYS come from pricing_matrix (single source of truth, server-
-- recomputed). This catalog holds ONLY the display name / headline / feature
-- bullets so admin can edit them and the app + billing render them
-- dynamically. There is deliberately NO price column here (avoids a second,
-- driftable price source).
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS amc_plans (
  plan          TEXT PRIMARY KEY
                  CHECK (plan IN ('one_time','half_yearly','quarterly','monthly')),
  display_name  TEXT NOT NULL,
  headline      TEXT,
  features      JSONB NOT NULL DEFAULT '[]',
  display_order INT  NOT NULL DEFAULT 0,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the four matrix plans with the current in-app copy so nothing regresses.
INSERT INTO amc_plans (plan, display_name, headline, features, display_order) VALUES
  ('one_time',    'One-Time Cleaning', 'Single visit',
     '["One full ozone clean","Includes GST","Cancel anytime"]'::jsonb, 1),
  ('half_yearly', 'Half-Yearly AMC',   '2 visits / year',
     '["Two scheduled visits","Priority support","Includes GST"]'::jsonb, 2),
  ('quarterly',   'Quarterly AMC',     '4 visits / year',
     '["Four scheduled visits","Priority scheduling","10% off add-ons","Includes GST"]'::jsonb, 3),
  ('monthly',     'Monthly AMC',       '12 visits / year',
     '["Twelve scheduled visits","Top priority + dedicated team","15% off add-ons","Includes GST"]'::jsonb, 4)
ON CONFLICT (plan) DO NOTHING;
