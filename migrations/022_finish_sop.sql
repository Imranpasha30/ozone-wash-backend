-- ──────────────────────────────────────────────────────────────────────────
-- 022_finish_sop.sql
-- Closes every remaining Handout v2.0 gap that lives in the schema:
--   1. jobs — on-site tank confirmation + arrival photo + resume support
--   2. hygiene_certificates — human certificate number (OZW-HYG-YYYY-XXXXXX)
--   3. app_settings — admin-configurable thresholds (BIS etc.)
--   4. compliance_log_revisions — append-only audit shadow of every step save
--   5. otp_events — append-only log of every OTP generate/verify attempt
--   6. compliance_logs — 3-photo visual documentation, video, confined/harness
-- ──────────────────────────────────────────────────────────────────────────

-- ── 1. Jobs: on-site tank confirm + arrival photo ─────────────────────────
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS tank_type             VARCHAR(20),
  ADD COLUMN IF NOT EXISTS tank_capacity_litres  INT,
  ADD COLUMN IF NOT EXISTS tank_count            INT,
  ADD COLUMN IF NOT EXISTS tank_change_reason    TEXT,
  ADD COLUMN IF NOT EXISTS tank_confirmed_at     TIMESTAMP,
  ADD COLUMN IF NOT EXISTS arrival_photo_url     VARCHAR(500);

-- ── 2. Certificate numbers ────────────────────────────────────────────────
ALTER TABLE hygiene_certificates
  ADD COLUMN IF NOT EXISTS certificate_number VARCHAR(30);
CREATE SEQUENCE IF NOT EXISTS certificate_number_seq START 1;

-- ── 3. Admin-configurable settings (BIS thresholds etc.) ──────────────────
CREATE TABLE IF NOT EXISTS app_settings (
  key        VARCHAR(60) PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_by VARCHAR(60),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
INSERT INTO app_settings (key, value) VALUES
  ('water_thresholds', '{
     "ph_min": 6.5, "ph_max": 8.5,
     "tds_max": 500,
     "turbidity_max": 1,
     "orp_gold_min": 650,
     "dissolved_o3_max": 0.05,
     "ambient_o3_max": 0.1
   }'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ── 4. Append-only audit shadow for compliance step saves ─────────────────
-- compliance_logs upserts (one row per job+step); every save also lands here
-- immutably so reading/photo changes are fully traceable.
CREATE TABLE IF NOT EXISTS compliance_log_revisions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      UUID NOT NULL,
  step_number INT NOT NULL,
  agent_id    UUID,
  snapshot    JSONB NOT NULL,
  saved_at    TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_clr_job ON compliance_log_revisions(job_id, step_number);

-- ── 5. Append-only OTP event log ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS otp_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id     UUID NOT NULL,
  agent_id   UUID,
  otp_kind   VARCHAR(10) NOT NULL,   -- start | end
  event      VARCHAR(20) NOT NULL,   -- generated | verify_ok | verify_fail | locked
  detail     TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_otp_events_job ON otp_events(job_id);

-- ── 6. Compliance logs: visual documentation + confined-space scrub ───────
ALTER TABLE compliance_logs
  ADD COLUMN IF NOT EXISTS extra_photo_urls  JSONB,          -- steps 1/8: +2 photos (3 total)
  ADD COLUMN IF NOT EXISTS video_url         VARCHAR(500),   -- optional 15-30s clip
  ADD COLUMN IF NOT EXISTS confined_entry    BOOLEAN,        -- step 3
  ADD COLUMN IF NOT EXISTS harness_attached  BOOLEAN;        -- step 3 (required if confined)
