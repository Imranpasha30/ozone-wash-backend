-- Migration 011: FA Incentive Credit Engine (Phase B)
--
-- Implements the credit-based incentive engine per the "FA Incentive (1)" PDF.
-- Per agent per month, accumulate CREDITS across 9 weighted parameters
-- (turnover, avg-time, TAT, transactions, 8-step checklist, EcoScore,
-- customer feedback, addon conversion, zero escalation). Tier (platinum →
-- unrated) is derived from the monthly credit total. The credit system
-- sits on top of — and is ADDITIVE to — the existing per-job incentives
-- table and payout_batches lifecycle from migration 008.
--
-- Idempotent: every change is `IF NOT EXISTS` / `DROP CONSTRAINT IF EXISTS`.

-- ── 1. Extend agent_stats with credit-engine fields ────────────────────────
ALTER TABLE agent_stats
  ADD COLUMN IF NOT EXISTS credits_current_month   INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS credits_breakdown       JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS escalation_count_30d    INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS avg_job_minutes_30d     NUMERIC(6,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tat_compliance_pct_30d  NUMERIC(4,3) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS avg_eco_score_30d       NUMERIC(5,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_credit_recalc_at   TIMESTAMPTZ;

-- ── 2. Allow 'unrated' tier ────────────────────────────────────────────────
ALTER TABLE agent_stats
  DROP CONSTRAINT IF EXISTS agent_stats_current_tier_check;

ALTER TABLE agent_stats
  ADD CONSTRAINT agent_stats_current_tier_check
  CHECK (current_tier IN ('platinum','gold','silver','bronze','unrated'));

-- ── 3. Extend incentive_rules with credit-engine config ────────────────────
ALTER TABLE incentive_rules
  ADD COLUMN IF NOT EXISTS weight_turnover         NUMERIC(4,3) DEFAULT 0.25,
  ADD COLUMN IF NOT EXISTS weight_avg_time         NUMERIC(4,3) DEFAULT 0.10,
  ADD COLUMN IF NOT EXISTS weight_tat              NUMERIC(4,3) DEFAULT 0.15,
  ADD COLUMN IF NOT EXISTS weight_transactions     NUMERIC(4,3) DEFAULT 0.10,
  ADD COLUMN IF NOT EXISTS weight_checklist        NUMERIC(4,3) DEFAULT 0.10,
  ADD COLUMN IF NOT EXISTS weight_ecoscore         NUMERIC(4,3) DEFAULT 0.15,
  ADD COLUMN IF NOT EXISTS weight_feedback         NUMERIC(4,3) DEFAULT 0.10,
  ADD COLUMN IF NOT EXISTS weight_addon            NUMERIC(4,3) DEFAULT 0.05,
  ADD COLUMN IF NOT EXISTS weight_escalation       NUMERIC(4,3) DEFAULT 0.05,
  ADD COLUMN IF NOT EXISTS benchmark_job_minutes   INTEGER DEFAULT 60,
  ADD COLUMN IF NOT EXISTS tier_credits_platinum   INTEGER DEFAULT 800,
  ADD COLUMN IF NOT EXISTS tier_credits_gold       INTEGER DEFAULT 600,
  ADD COLUMN IF NOT EXISTS tier_credits_silver     INTEGER DEFAULT 400,
  ADD COLUMN IF NOT EXISTS tier_credits_bronze     INTEGER DEFAULT 200,
  ADD COLUMN IF NOT EXISTS cash_bonus_pct_platinum NUMERIC(4,3) DEFAULT 0.15,
  ADD COLUMN IF NOT EXISTS cash_bonus_pct_gold     NUMERIC(4,3) DEFAULT 0.10,
  ADD COLUMN IF NOT EXISTS cash_bonus_pct_silver   NUMERIC(4,3) DEFAULT 0.05,
  ADD COLUMN IF NOT EXISTS leave_days_platinum     INTEGER DEFAULT 2,
  ADD COLUMN IF NOT EXISTS leave_days_gold         INTEGER DEFAULT 1;

-- Make sure the singleton row exists (no-op if migration 008 already inserted).
INSERT INTO incentive_rules (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── 4. payout_batches.leave_days_awarded for tier-driven leave grants ──────
ALTER TABLE payout_batches
  ADD COLUMN IF NOT EXISTS leave_days_awarded INTEGER DEFAULT 0;

-- ── 5. agent_credit_log — audit trail of monthly credit recalculations ─────
CREATE TABLE IF NOT EXISTS agent_credit_log (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month              DATE NOT NULL,
  credits_total      INTEGER NOT NULL DEFAULT 0,
  credits_breakdown  JSONB  NOT NULL DEFAULT '{}'::jsonb,
  tier               TEXT   NOT NULL
                       CHECK (tier IN ('platinum','gold','silver','bronze','unrated')),
  computed_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_credit_log_agent_month
  ON agent_credit_log(agent_id, month DESC);

CREATE INDEX IF NOT EXISTS idx_agent_credit_log_month
  ON agent_credit_log(month);
