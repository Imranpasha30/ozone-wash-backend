-- ─────────────────────────────────────────────────────────────────────────────
-- 006_pricing_matrix.sql
-- Authoritative AMC + One-Time pricing matrix.
-- All amounts in paise (₹1 = 100), inclusive of GST 18%.
-- 8 tank-size tiers × 4 plan frequencies × 3 tank-count rate columns.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pricing_tiers (
  id SMALLINT PRIMARY KEY,
  label TEXT NOT NULL,
  min_litres INTEGER NOT NULL,
  max_litres INTEGER,                  -- NULL for top tier
  requires_inspection BOOLEAN DEFAULT false
);

CREATE TABLE IF NOT EXISTS pricing_matrix (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier_id SMALLINT REFERENCES pricing_tiers(id),
  plan TEXT NOT NULL CHECK (plan IN ('one_time','monthly','quarterly','half_yearly')),
  -- Price PER YEAR for the plan, in paise, inc-GST
  single_tank_paise INTEGER NOT NULL,
  per_tank_2_paise INTEGER NOT NULL,            -- per-tank rate when booking 2 tanks
  per_tank_2plus_paise INTEGER NOT NULL,        -- per-tank rate when booking 3+ tanks
  services_per_year SMALLINT NOT NULL,          -- 1, 2, 4, 12
  effective_from DATE DEFAULT CURRENT_DATE,
  active BOOLEAN DEFAULT true,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tier_id, plan, effective_from)
);

CREATE INDEX IF NOT EXISTS idx_pricing_matrix_active
  ON pricing_matrix(tier_id, plan)
  WHERE active = true;

-- ─── Seed tiers ──────────────────────────────────────────────────────────────
INSERT INTO pricing_tiers (id, label, min_litres, max_litres, requires_inspection) VALUES
  (1,'Up to 500 L',         0,    500,  false),
  (2,'501 - 1,000 L',       501,  1000, false),
  (3,'1,001 - 2,000 L',     1001, 2000, false),
  (4,'2,001 - 3,000 L',     2001, 3000, false),
  (5,'3,001 - 5,000 L',     3001, 5000, false),
  (6,'5,001 - 7,500 L',     5001, 7500, false),
  (7,'7,501 - 10,000 L',    7501, 10000,false),
  (8,'10,001 L and above',  10001,NULL, true)
ON CONFLICT (id) DO NOTHING;

-- ─── Seed pricing matrix (paise, inc-GST) ────────────────────────────────────
-- (tier_id, plan, single_paise, per_tank_2_paise, per_tank_2plus_paise, services_per_year)
INSERT INTO pricing_matrix (tier_id, plan, single_tank_paise, per_tank_2_paise, per_tank_2plus_paise, services_per_year) VALUES
  -- tier 1
  (1,'one_time',     350000, 297500, 245000, 1),
  (1,'half_yearly',  630000, 535500, 441000, 2),
  (1,'quarterly',   1190000,1011500, 833000, 4),
  (1,'monthly',     2940000,2499000,2058000,12),
  -- tier 2
  (2,'one_time',     350000, 297500, 245000, 1),
  (2,'half_yearly',  630000, 535500, 441000, 2),
  (2,'quarterly',   1190000,1011500, 833000, 4),
  (2,'monthly',     2940000,2499000,2058000,12),
  -- tier 3
  (3,'one_time',     700000, 595000, 490000, 1),
  (3,'half_yearly', 1260000,1071000, 882000, 2),
  (3,'quarterly',   2380000,2023000,1666000, 4),
  (3,'monthly',     5880000,4998000,4116000,12),
  -- tier 4
  (4,'one_time',     900000, 765000, 630000, 1),
  (4,'half_yearly', 1620000,1377000,1134000, 2),
  (4,'quarterly',   3060000,2601000,2142000, 4),
  (4,'monthly',     7560000,6426000,5292000,12),
  -- tier 5
  (5,'one_time',    1020000, 840000, 840000, 1),
  (5,'half_yearly', 2160000,1836000,1512000, 2),
  (5,'quarterly',   4080000,3468000,2856000, 4),
  (5,'monthly',    10080000,8568000,7056000,12),
  -- tier 6
  (6,'one_time',    1190000, 980000, 980000, 1),
  (6,'half_yearly', 2520000,2142000,1764000, 2),
  (6,'quarterly',   4760000,4046000,3332000, 4),
  (6,'monthly',    11760000,9996000,8232000,12),
  -- tier 7
  (7,'one_time',    1785000,1470000,1470000, 1),
  (7,'half_yearly', 3780000,3213000,2646000, 2),
  (7,'quarterly',   7140000,6069000,4998000, 4),
  (7,'monthly',    17640000,14994000,12348000,12),
  -- tier 8
  (8,'one_time',    2125000,1750000,1750000, 1),
  (8,'half_yearly', 4500000,3825000,3150000, 2),
  (8,'quarterly',   8500000,7225000,5950000, 4),
  (8,'monthly',    21000000,17850000,14700000,12)
ON CONFLICT (tier_id, plan, effective_from) DO NOTHING;
