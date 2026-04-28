-- ─────────────────────────────────────────────────────────────────────────────
-- 010_ecopoints_redemption.sql
-- Phase A: EcoPoints Redemption + per-job continuous accrual.
--
-- Extends the wallets / wallet_transactions / rewards stack from migration 005
-- to support the "Ecoscore Dashboard - Revised & Updated" PDF (pages 3-6):
--   • per-job EcoPoints accrual (base + tier bonus + streak bonus)
--   • 1,000-point wallet cap with truncation audit
--   • 24-month expiry, evaluated via nightly cron
--   • redemption catalog (9 SKUs across 4 categories) with streak gating
--   • redemptions table tracking delivery status
--
-- All ALTERs use IF NOT EXISTS / DROP-IF-EXISTS-then-ADD; all INSERTs use
-- ON CONFLICT DO NOTHING so the migration is idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Wallet cap ────────────────────────────────────────────────────────────
-- Per-user wallet balance is capped at 1,000 EcoPoints. We store the cap on the
-- wallets row so admins can tune it later without a code deploy.
ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS eco_points_capped_at INTEGER NOT NULL DEFAULT 1000;

-- ── 2. EcoScore history bonus audit trail ───────────────────────────────────
-- The PDF's wallet ledger surfaces tier bonus + streak bonus events on the
-- EcoScore timeline. eco_score_history already exists from migration 007;
-- here we just add a column to record the bonus delta attributable to that
-- history row (separate from the score-delta column already present).
ALTER TABLE eco_score_history
  ADD COLUMN IF NOT EXISTS bonus_points INTEGER DEFAULT 0;

-- ── 3. Rewards catalog: extend with category / streak gating / slug ─────────
-- The existing rewards table from migration 005 has (id, name, description,
-- cost_points, category, active, stock, created_at). The 'category' column
-- already exists as TEXT — we KEEP it, but widen its semantic to match the
-- PDF's 4 buckets ('amc_renewal' | 'hygiene' | 'partner' | 'streak'). We add
-- the streak-gating column and a stable slug used by the redemption API.
ALTER TABLE rewards
  ADD COLUMN IF NOT EXISTS slug            VARCHAR(60),
  ADD COLUMN IF NOT EXISTS requires_streak VARCHAR(20);

-- Slug is the stable identifier the redemption endpoint accepts. UNIQUE so we
-- cannot ship duplicates. NULL allowed for legacy rows seeded in migration 005.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'rewards_slug_unique'
  ) THEN
    ALTER TABLE rewards ADD CONSTRAINT rewards_slug_unique UNIQUE (slug);
  END IF;
END $$;

-- 'is_active' alias requested by the spec. Migration 005 already created an
-- 'active' column; we don't rename it (would break MIS dashboards). The
-- rewards.service.js layer maps active → is_active in API responses.

-- ── 4. Seed the 9 PDF SKUs (idempotent on slug) ─────────────────────────────
INSERT INTO rewards (slug, name, description, cost_points, category, active, requires_streak)
VALUES
  -- AMC Renewal Discounts ──────────────────────────────────────────────────
  ('amc_discount_10',       '10% off AMC renewal',
     'Apply 10% discount on your next AMC renewal',                    200,  'amc_renewal', true, NULL),
  ('amc_discount_25',       '25% off AMC renewal',
     'Apply 25% discount on your next AMC renewal',                    400,  'amc_renewal', true, NULL),

  -- Hygiene Upgrades ──────────────────────────────────────────────────────
  ('free_water_test',       'Free water test',
     'Complimentary 21-parameter water quality test on next visit',    100,  'hygiene',     true, NULL),
  ('free_anti_algae',       'Free anti-algae treatment',
     'One-time free anti-algae treatment on your tank',                150,  'hygiene',     true, NULL),
  ('free_structural_audit', 'Free structural audit',
     'Comprehensive tank structural integrity audit',                  300,  'hygiene',     true, NULL),

  -- Partner Benefits ──────────────────────────────────────────────────────
  ('eco_voucher',           'Eco-friendly product voucher',
     'Voucher redeemable on partner eco-friendly products',            200,  'partner',     true, NULL),
  ('free_filter_cartridge', 'Free water filter cartridge',
     'One free replacement cartridge from our partner brands',         400,  'partner',     true, NULL),

  -- Streak Rewards (point cost = 0; gated on streak tier) ─────────────────
  ('platinum_streak_cert',  'Free compliance certificate re-issue',
     'Re-issue your hygiene compliance certificate at no cost',          0,  'streak',      true, 'platinum'),
  ('gold_streak_amc_extend','AMC extension by 1 month',
     'Extend your AMC contract by an additional month, free',            0,  'streak',      true, 'gold')
ON CONFLICT (slug) DO NOTHING;

-- ── 5. Redemptions tracker ──────────────────────────────────────────────────
-- Migration 005 already shipped a 'reward_redemptions' table for MIS purposes.
-- The PDF flow needs a richer record (delivery status, applied_at, notes,
-- transaction reference). We create 'redemptions' as the canonical Phase-A
-- tracker. The legacy 'reward_redemptions' table is left intact.
CREATE TABLE IF NOT EXISTS redemptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id),
  reward_id       UUID NOT NULL REFERENCES rewards(id),
  reward_slug     VARCHAR(60),                    -- denormalised for quick display
  points_spent    INTEGER NOT NULL DEFAULT 0,     -- 0 for streak-gated rewards
  wallet_tx_id    UUID REFERENCES wallet_transactions(id),
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','applied','cancelled')),
  notes           TEXT,
  applied_at      TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_redemptions_user_created
  ON redemptions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_redemptions_status
  ON redemptions(status);
CREATE INDEX IF NOT EXISTS idx_redemptions_reward
  ON redemptions(reward_id);

-- ── 6. wallet_transactions reason taxonomy ──────────────────────────────────
-- No schema change needed (reason is TEXT). Documented values used by the
-- new EcoPoints layer:
--   'job_complete'    – per-job base credit (EcoScore % → points)
--   'tier_bonus'      – platinum/gold/silver tier add-on (+10/+5/+2)
--   'streak_bonus'    – consecutive-tier streak bonus (+50 platinum, +25 gold)
--   'cap_truncate'    – debit when credit would exceed eco_points_capped_at
--   'expiry'          – nightly cron expires points >24 months old
--   'reward_redeem'   – debit on redemption.create
--
-- The legacy 'ecoscore_badge_up' reason is preserved; the historical migration
-- from creditBadgeBonus (one-shot upgrade bonus) → awardEcoPoints (per-job
-- continuous accrual) is a code-level change, not a schema change.
