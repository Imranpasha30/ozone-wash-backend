-- Migration 005: MIS supporting tables
--
-- Adds the tables required to hydrate the /api/v1/mis/* dashboards with real
-- data instead of zeros. Covers payments, wallets / wallet_transactions,
-- rewards / reward_redemptions, agent incentives, sales team + monthly
-- targets, marketing spend (for CAC), and customer ratings.
--
-- All CREATEs are IF NOT EXISTS so the migration is idempotent. Seed data
-- uses ON CONFLICT DO NOTHING for the same reason.

-- payments: every Razorpay / COD transaction
CREATE TABLE IF NOT EXISTS payments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID REFERENCES users(id),
  booking_id          UUID REFERENCES bookings(id),
  amc_contract_id     UUID REFERENCES amc_contracts(id),
  razorpay_order_id   TEXT,
  razorpay_payment_id TEXT,
  razorpay_signature  TEXT,
  amount_paise        INTEGER NOT NULL,        -- store in paise (₹1 = 100)
  currency            TEXT DEFAULT 'INR',
  method              TEXT,                    -- upi | card | netbanking | wallet | cod
  status              TEXT NOT NULL DEFAULT 'created' CHECK (status IN
                        ('created','attempted','captured','failed','refunded','cod_pending','cod_collected')),
  gst_paise           INTEGER DEFAULT 0,
  notes               JSONB,
  created_at          TIMESTAMPTZ DEFAULT now(),
  captured_at         TIMESTAMPTZ
);

-- wallets: one row per user (eco-points balance)
CREATE TABLE IF NOT EXISTS wallets (
  user_id           UUID PRIMARY KEY REFERENCES users(id),
  eco_points        INTEGER NOT NULL DEFAULT 0,
  lifetime_earned   INTEGER NOT NULL DEFAULT 0,
  lifetime_redeemed INTEGER NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ DEFAULT now()
);

-- wallet_transactions: audit trail for every credit/debit
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id),
  delta       INTEGER NOT NULL,             -- positive=credit, negative=debit
  reason      TEXT,                          -- 'job_completed' | 'referral_credit' | 'reward_redeem' | …
  ref_type    TEXT,                          -- 'job' | 'referral' | 'reward' | 'admin_adjust'
  ref_id      UUID,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- rewards catalog
CREATE TABLE IF NOT EXISTS rewards (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  description  TEXT,
  cost_points  INTEGER NOT NULL,
  category     TEXT,                         -- 'discount' | 'voucher' | 'service' | 'merchandise'
  active       BOOLEAN DEFAULT true,
  stock        INTEGER,                      -- NULL = unlimited
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- reward redemptions
CREATE TABLE IF NOT EXISTS reward_redemptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users(id),
  reward_id     UUID REFERENCES rewards(id),
  points_spent  INTEGER NOT NULL,
  status        TEXT DEFAULT 'pending' CHECK (status IN ('pending','fulfilled','cancelled')),
  fulfilled_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- agent incentives (payouts to field team)
CREATE TABLE IF NOT EXISTS incentives (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      UUID REFERENCES users(id),
  job_id        UUID REFERENCES jobs(id),
  amount_paise  INTEGER NOT NULL,
  reason        TEXT,                        -- 'addon_upsell' | 'high_ecoscore' | 'referral_bonus' | 'monthly_target'
  tier          TEXT CHECK (tier IN ('platinum','gold','silver','bronze')),
  status        TEXT DEFAULT 'accrued' CHECK (status IN ('accrued','paid','reversed')),
  paid_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- sales team roster
CREATE TABLE IF NOT EXISTS sales_team (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id),
  name       TEXT NOT NULL,
  region     TEXT,
  active     BOOLEAN DEFAULT true,
  joined_at  DATE DEFAULT CURRENT_DATE
);

-- monthly sales targets per team member
CREATE TABLE IF NOT EXISTS sales_targets (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_team_id            UUID REFERENCES sales_team(id),
  month                    DATE NOT NULL,            -- first day of the month
  target_revenue_paise     INTEGER NOT NULL,
  achieved_revenue_paise   INTEGER DEFAULT 0,
  created_at               TIMESTAMPTZ DEFAULT now(),
  UNIQUE(sales_team_id, month)
);

-- marketing spend per channel/month (for CAC)
CREATE TABLE IF NOT EXISTS marketing_spend (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel             TEXT NOT NULL,             -- 'google_ads' | 'meta' | 'whatsapp' | 'partner' | 'referral'
  month               DATE NOT NULL,
  spend_paise         INTEGER NOT NULL,
  leads_generated     INTEGER DEFAULT 0,
  customers_acquired  INTEGER DEFAULT 0,
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT now(),
  UNIQUE(channel, month)
);

-- customer ratings on completed jobs
CREATE TABLE IF NOT EXISTS ratings (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id       UUID REFERENCES jobs(id) UNIQUE,
  customer_id  UUID REFERENCES users(id),
  agent_id     UUID REFERENCES users(id),
  rating       SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment      TEXT,
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- ── Indexes ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_payments_user        ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_booking     ON payments(booking_id);
CREATE INDEX IF NOT EXISTS idx_payments_amc         ON payments(amc_contract_id);
CREATE INDEX IF NOT EXISTS idx_payments_status      ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_created     ON payments(created_at);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_user       ON wallet_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_reason     ON wallet_transactions(reason);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_created    ON wallet_transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_redemptions_user     ON reward_redemptions(user_id);
CREATE INDEX IF NOT EXISTS idx_redemptions_reward   ON reward_redemptions(reward_id);
CREATE INDEX IF NOT EXISTS idx_redemptions_status   ON reward_redemptions(status);
CREATE INDEX IF NOT EXISTS idx_incentives_agent     ON incentives(agent_id);
CREATE INDEX IF NOT EXISTS idx_incentives_status    ON incentives(status);
CREATE INDEX IF NOT EXISTS idx_incentives_created   ON incentives(created_at);
CREATE INDEX IF NOT EXISTS idx_targets_month        ON sales_targets(month);
CREATE INDEX IF NOT EXISTS idx_marketing_month      ON marketing_spend(month);
CREATE INDEX IF NOT EXISTS idx_marketing_channel    ON marketing_spend(channel);
CREATE INDEX IF NOT EXISTS idx_ratings_agent        ON ratings(agent_id);
CREATE INDEX IF NOT EXISTS idx_ratings_customer     ON ratings(customer_id);
CREATE INDEX IF NOT EXISTS idx_ratings_created      ON ratings(created_at);

-- ── Seed: 5 reward catalog items ───────────────────────────────────────────
INSERT INTO rewards (name, description, cost_points, category) VALUES
  ('₹100 Cleaning Discount',     'Get ₹100 off your next overhead-tank cleaning',          100, 'discount'),
  ('Free Water-Quality Test',    'Complimentary 21-parameter lab test on next visit',      250, 'service'),
  ('UV Double-Lock Upgrade',     'Free UV sterilisation add-on (₹399 value)',              400, 'service'),
  ('Amazon ₹500 Voucher',        'Redeem instantly via email',                             500, 'voucher'),
  ('AMC 10% Renewal Discount',   '10% off your next AMC renewal',                          750, 'discount')
ON CONFLICT DO NOTHING;

-- ── Seed: marketing channels with last 3 months of light data ──────────────
DO $$
DECLARE m DATE := date_trunc('month', current_date)::date;
BEGIN
  FOR i IN 0..2 LOOP
    INSERT INTO marketing_spend (channel, month, spend_paise, leads_generated, customers_acquired) VALUES
      ('google_ads', m - (i || ' months')::interval, 1500000 + (i*200000), 80 - i*8, 18 - i*2),
      ('meta',       m - (i || ' months')::interval, 1200000 + (i*150000), 65 - i*6, 12 - i*1),
      ('whatsapp',   m - (i || ' months')::interval, 200000,                30 - i*2,  9 - i*1),
      ('partner',    m - (i || ' months')::interval, 0,                     12,        7),
      ('referral',   m - (i || ' months')::interval, 0,                     20 + i*4, 14 + i*2)
    ON CONFLICT (channel, month) DO NOTHING;
  END LOOP;
END $$;
