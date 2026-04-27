-- ─────────────────────────────────────────────────────────────────────────────
-- 007_ecoscore_engine.sql
-- Production-grade EcoScore engine: rolling per-customer hygiene/loyalty
-- score (0-100), badge tier, audit history, configurable weights.
-- The legacy `eco_metrics_log` table (per-job snapshot) is left intact and
-- continues to be written by the field-team compliance flow.
-- ─────────────────────────────────────────────────────────────────────────────

-- Per-customer rolling EcoScore snapshot. Recalculated on job-complete +
-- nightly cron. One row per user. Components are normalised 0..1.
CREATE TABLE IF NOT EXISTS eco_scores (
  user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  score            SMALLINT NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
  badge            TEXT NOT NULL DEFAULT 'unrated'
                     CHECK (badge IN ('platinum','gold','silver','bronze','unrated')),
  rationale        TEXT,                              -- short human-readable why
  streak_days      INTEGER DEFAULT 0,                 -- consecutive days at gold-or-better
  last_recalc_at   TIMESTAMPTZ DEFAULT now(),
  -- breakdown (each 0..1 normalised, weighted into score)
  c_amc_plan       NUMERIC(4,3) DEFAULT 0,            -- driven by plan frequency
  c_compliance     NUMERIC(4,3) DEFAULT 0,            -- 8-step checklist completion %
  c_timeliness     NUMERIC(4,3) DEFAULT 0,            -- on-time service streak
  c_addons         NUMERIC(4,3) DEFAULT 0,            -- UV / lab-test upgrades adopted
  c_ratings        NUMERIC(4,3) DEFAULT 0,            -- ratings the customer has given
  c_water_tests    NUMERIC(4,3) DEFAULT 0,            -- pre+post lab tests opted-in
  c_referrals      NUMERIC(4,3) DEFAULT 0             -- successful referrals contributed
);

CREATE INDEX IF NOT EXISTS idx_eco_scores_badge ON eco_scores(badge);
CREATE INDEX IF NOT EXISTS idx_eco_scores_score ON eco_scores(score DESC);

-- Audit log of every recalc + badge change so we can show
-- "Why did my score change?" to the customer.
CREATE TABLE IF NOT EXISTS eco_score_history (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  score        SMALLINT NOT NULL,
  badge        TEXT NOT NULL,
  delta        SMALLINT,                              -- vs previous score
  trigger      TEXT,                                  -- 'job_complete' | 'amc_renewal' | 'rating_received' | 'cron_nightly' | 'admin_adjust' | 'booking_created'
  trigger_ref  UUID,                                  -- job_id / contract_id / etc
  rationale    TEXT,
  components   JSONB,                                 -- snapshot of c_* values at this time
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_eco_history_user_time
  ON eco_score_history(user_id, created_at DESC);

-- Configurable weights (admin-tunable later without code change). Single-row
-- table — id is always 1.
CREATE TABLE IF NOT EXISTS eco_score_weights (
  id              SMALLINT PRIMARY KEY,
  w_amc_plan      NUMERIC(4,3) DEFAULT 0.30,
  w_compliance    NUMERIC(4,3) DEFAULT 0.20,
  w_timeliness    NUMERIC(4,3) DEFAULT 0.15,
  w_addons        NUMERIC(4,3) DEFAULT 0.10,
  w_ratings       NUMERIC(4,3) DEFAULT 0.15,
  w_water_tests   NUMERIC(4,3) DEFAULT 0.05,
  w_referrals     NUMERIC(4,3) DEFAULT 0.05,
  -- thresholds
  t_platinum      SMALLINT DEFAULT 90,
  t_gold          SMALLINT DEFAULT 75,
  t_silver        SMALLINT DEFAULT 60,
  t_bronze        SMALLINT DEFAULT 40,
  updated_at      TIMESTAMPTZ DEFAULT now(),
  CHECK (
    w_amc_plan + w_compliance + w_timeliness + w_addons
      + w_ratings + w_water_tests + w_referrals = 1.00
  )
);
INSERT INTO eco_score_weights (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
