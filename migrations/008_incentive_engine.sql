-- Migration 008: Field-Agent Incentive Engine
--
-- Builds the rules engine, per-agent rolling stats, and monthly payout
-- batches that sit on top of the `incentives` table created in migration
-- 005. Agents accrue per job (base + addon-upsell + rating bonus + tier
-- multiplier), with monthly target / streak top-ups computed nightly. Admin
-- "freezes" then "marks paid" each month's batch.
--
-- All CREATEs are IF NOT EXISTS so the migration is idempotent.

-- ── Per-agent rolling stats + tier ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_stats (
  agent_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  jobs_completed_30d    INTEGER DEFAULT 0,
  avg_rating_30d        NUMERIC(3,2) DEFAULT 0,
  addon_conversion_30d  NUMERIC(4,3) DEFAULT 0,        -- % of jobs with at least one addon
  on_time_pct_30d       NUMERIC(4,3) DEFAULT 0,
  referrals_30d         INTEGER DEFAULT 0,
  total_turnover_30d_paise BIGINT DEFAULT 0,           -- contribution to revenue
  current_tier          TEXT NOT NULL DEFAULT 'bronze'
                          CHECK (current_tier IN ('platinum','gold','silver','bronze')),
  current_streak_months INTEGER DEFAULT 0,             -- consecutive months at gold-or-better
  last_streak_month     DATE,                          -- guards once-per-month streak increment
  last_recalc_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_stats_tier ON agent_stats(current_tier);

-- ── Configurable rules (admin-tunable, single row id=1) ────────────────────
CREATE TABLE IF NOT EXISTS incentive_rules (
  id                       SMALLINT PRIMARY KEY,
  -- Base per-job (paise)
  base_completion_paise    INTEGER DEFAULT 5000,        -- ₹50 per completed job
  -- Addon-upsell: % of addon revenue passed to agent
  addon_commission_pct     NUMERIC(4,3) DEFAULT 0.10,   -- 10%
  -- Rating bonuses (paise)
  rating_5_paise           INTEGER DEFAULT 5000,        -- ₹50 for 5-star
  rating_4_paise           INTEGER DEFAULT 2000,        -- ₹20 for 4-star
  rating_3_paise           INTEGER DEFAULT 0,
  -- Referral attribution: when an agent's customer brings a referral
  referral_bonus_paise     INTEGER DEFAULT 10000,       -- ₹100 per converted referral
  -- Monthly tier multipliers applied to base_completion
  multiplier_platinum      NUMERIC(4,3) DEFAULT 1.50,
  multiplier_gold          NUMERIC(4,3) DEFAULT 1.25,
  multiplier_silver        NUMERIC(4,3) DEFAULT 1.10,
  multiplier_bronze        NUMERIC(4,3) DEFAULT 1.00,
  -- Monthly target structure
  monthly_target_jobs      INTEGER DEFAULT 30,
  monthly_target_bonus_paise INTEGER DEFAULT 100000,    -- ₹1,000 lump sum
  -- Streak bonus: every N consecutive gold-or-better months
  streak_bonus_paise       INTEGER DEFAULT 200000,      -- ₹2,000 every 3 months at gold+
  streak_threshold_months  INTEGER DEFAULT 3,
  -- Tier thresholds against agent_stats.total_turnover_30d_paise
  tier_platinum_paise      BIGINT DEFAULT 5000000,      -- ₹50,000+
  tier_gold_paise          BIGINT DEFAULT 3000000,      -- ₹30,000+
  tier_silver_paise        BIGINT DEFAULT 1500000,      -- ₹15,000+
  -- bronze = below silver threshold
  updated_at               TIMESTAMPTZ DEFAULT now()
);
INSERT INTO incentive_rules (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── Per-agent monthly payout batches ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS payout_batches (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    UUID REFERENCES users(id),
  month       DATE NOT NULL,                            -- first day of month
  total_paise INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','frozen','paid','cancelled')),
  payment_ref TEXT,                                     -- bank txn id / UPI ref
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  paid_at     TIMESTAMPTZ,
  UNIQUE(agent_id, month)
);
CREATE INDEX IF NOT EXISTS idx_batches_agent_month ON payout_batches(agent_id, month);
CREATE INDEX IF NOT EXISTS idx_batches_status      ON payout_batches(status);

-- ── Link incentives to a payout batch once frozen ──────────────────────────
ALTER TABLE incentives ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES payout_batches(id);
CREATE INDEX IF NOT EXISTS idx_incentives_batch ON incentives(batch_id);
CREATE INDEX IF NOT EXISTS idx_incentives_job   ON incentives(job_id);
CREATE INDEX IF NOT EXISTS idx_incentives_reason ON incentives(reason);
