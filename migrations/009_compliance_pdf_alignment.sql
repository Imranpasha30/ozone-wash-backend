-- Migration 009: Align compliance_logs with the FA Check List PDF SOP.
--
-- Adds Stage 0 (Pre-Service PPE & Safety Discipline) to the compliance flow,
-- expanding the model from 8 to 9 phases (step_number 0..8) and capturing the
-- richer per-step data required by the PDF (water tests with bucketed labels,
-- duration buckets, sludge disposal, UV add-on, client signature, technician
-- remarks, etc.). All new columns are nullable so existing 8-step rows survive.
--
-- Companion change required outside this migration:
--   Wati BSP must register 9 message templates named
--     compliance_stage_0_complete ... compliance_stage_8_complete
--   matching the "Customer Message" strings in the PDF. The backend dispatches
--   them via NotificationService.sendWhatsApp after each successful logStep.

-- 1. Drop the existing CHECK (step_number BETWEEN 1 AND 8). Postgres auto-names
--    inline column CHECKs as <table>_<column>_check.
ALTER TABLE compliance_logs
  DROP CONSTRAINT IF EXISTS compliance_logs_step_number_check;

-- 2. Add the wider 0..8 range constraint.
ALTER TABLE compliance_logs
  ADD CONSTRAINT compliance_logs_step_number_check
  CHECK (step_number BETWEEN 0 AND 8);

-- 3. Stage 0 (Pre-Service PPE & Safety Discipline) columns.
--    PPE individual items reuse the existing ppe_list JSONB column; here we
--    only add the structural-safety + environmental flags from the PDF.
ALTER TABLE compliance_logs
  ADD COLUMN IF NOT EXISTS ladder_check        VARCHAR(20),
  ADD COLUMN IF NOT EXISTS electrical_check    VARCHAR(20),
  ADD COLUMN IF NOT EXISTS emergency_kit       BOOLEAN,
  ADD COLUMN IF NOT EXISTS spare_tank_water    BOOLEAN,
  ADD COLUMN IF NOT EXISTS fence_placed        BOOLEAN,
  ADD COLUMN IF NOT EXISTS danger_board        BOOLEAN,
  ADD COLUMN IF NOT EXISTS arrival_at          TIMESTAMPTZ;

-- 4. Steps 1 + 8 water test buckets. Each stores the human-readable bucket
--    label exactly as the agent picked it (e.g. "<5 NTU", "6.5-8.5 Safe").
ALTER TABLE compliance_logs
  ADD COLUMN IF NOT EXISTS turbidity     VARCHAR(20),
  ADD COLUMN IF NOT EXISTS ph_level      VARCHAR(20),
  ADD COLUMN IF NOT EXISTS orp           VARCHAR(20),
  ADD COLUMN IF NOT EXISTS conductivity  VARCHAR(20),
  ADD COLUMN IF NOT EXISTS tds           VARCHAR(20),
  ADD COLUMN IF NOT EXISTS atp           VARCHAR(20);

-- 5. Step 2 - Drain & Inspect.
ALTER TABLE compliance_logs
  ADD COLUMN IF NOT EXISTS water_level_pct VARCHAR(20),
  ADD COLUMN IF NOT EXISTS tank_condition  VARCHAR(20);

-- 6. Step 3 - Mechanical scrub completion flag.
ALTER TABLE compliance_logs
  ADD COLUMN IF NOT EXISTS scrub_completed BOOLEAN;

-- 7. Step 4 - High-pressure rinse duration bucket.
ALTER TABLE compliance_logs
  ADD COLUMN IF NOT EXISTS rinse_duration VARCHAR(20);

-- 8. Step 5 - Sludge disposal status.
ALTER TABLE compliance_logs
  ADD COLUMN IF NOT EXISTS disposal_status VARCHAR(20);

-- 9. Step 6 - Ozone disinfection cycle. Existing ozone_exposure_mins is
--    retained for backward compatibility with older rows; new rows use the
--    bucketed pair below.
ALTER TABLE compliance_logs
  ADD COLUMN IF NOT EXISTS ozone_cycle_duration VARCHAR(20),
  ADD COLUMN IF NOT EXISTS ozone_ppm_dosed      VARCHAR(20);

-- 10. Step 7 - UV Double Lock (optional add-on). uv_skipped lets us count
--     skipped steps as completed for total-progress while preserving auditability.
ALTER TABLE compliance_logs
  ADD COLUMN IF NOT EXISTS uv_cycle_duration VARCHAR(20),
  ADD COLUMN IF NOT EXISTS uv_dose           VARCHAR(20),
  ADD COLUMN IF NOT EXISTS uv_lumines_status VARCHAR(20),
  ADD COLUMN IF NOT EXISTS uv_skipped        BOOLEAN DEFAULT FALSE;

-- 11. Step 8 - After-Wash Testing & Proof Delivery. Post water-test values
--     reuse the same Step 1 columns above (single set of columns, distinguished
--     by the row's step_number). Signature + remarks are step-8 specific.
ALTER TABLE compliance_logs
  ADD COLUMN IF NOT EXISTS client_signature_url TEXT,
  ADD COLUMN IF NOT EXISTS technician_remarks   TEXT;
