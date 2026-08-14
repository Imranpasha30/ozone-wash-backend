-- ──────────────────────────────────────────────────────────────────────────
-- 021_field_sop_v2.sql
-- Field App SOP v2 — implements the Developer Handout v2.0 safety-gate layer:
--   1. van_checks             — Phase 0 pre-departure shift checks (gate G-0)
--   2. water_readings         — numeric before/after readings (append-only)
--   3. ozone_sessions         — Phase 4 timer + venting + safety gates G-5..G-8
--   4. safety_checks          — confined-space gas checks + pre-ozone PPE (G-3/G-5)
--   5. scheduled_notifications— 83-day recleaning reminder + day-3 AMC upsell
--   6. daily_mis              — end-of-shift agent MIS submissions
--   7. jobs columns           — en_route/departure, OTP attempt limits, damage
--                               log, ORP/O3 gate flags, AMC interest, pause
-- All *reading/gate* tables are append-only by convention (no UPDATE path in
-- code); OTP attempt counters live on jobs.
-- ──────────────────────────────────────────────────────────────────────────

-- ── 1. Van checks (per agent per shift day) ───────────────────────────────
CREATE TABLE IF NOT EXISTS van_checks (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id                  UUID NOT NULL REFERENCES users(id),
  shift_date                DATE NOT NULL DEFAULT CURRENT_DATE,
  equipment_checklist       JSONB NOT NULL DEFAULT '{}',  -- 13-item boolean map
  calibration_dates         JSONB DEFAULT '{}',           -- {ph_meter, dissolved_o3, turbidity}
  ppe_photo_url             VARCHAR(500),
  o2_pressure_bar           INT,
  o2_pressure_post_job_bar  INT,
  water_tank_litres         INT,
  van_check_complete        BOOLEAN NOT NULL DEFAULT FALSE,
  completed_at              TIMESTAMP,
  created_at                TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (agent_id, shift_date)
);

-- ── 2. Numeric water readings (append-only; supersedes bucket strings) ────
CREATE TABLE IF NOT EXISTS water_readings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID NOT NULL REFERENCES jobs(id),
  agent_id      UUID NOT NULL REFERENCES users(id),
  param         VARCHAR(30) NOT NULL,   -- pH|TDS|ORP|turbidity|dissolved_o3|dissolved_o3_final
  timing        VARCHAR(10) NOT NULL,   -- before|after
  value         DECIMAL(10,3) NOT NULL,
  unit          VARCHAR(10) NOT NULL,   -- pH|ppm|mV|NTU|mg/L
  photo_url     VARCHAR(500),
  delta_vs_before DECIMAL(10,3),        -- server-computed on 'after' rows
  bis_compliant BOOLEAN,                -- BIS IS 10500 thresholds
  gps_lat       DECIMAL(10,7),
  gps_lng       DECIMAL(10,7),
  recorded_at   TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_water_readings_job ON water_readings(job_id, param, timing);

-- ── 3. Ozone sessions (Phase 4 — timer, venting, safety readings) ─────────
CREATE TABLE IF NOT EXISTS ozone_sessions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                  UUID NOT NULL REFERENCES jobs(id),
  agent_id                UUID NOT NULL REFERENCES users(id),
  started_at              TIMESTAMP NOT NULL DEFAULT NOW(),
  stopped_at              TIMESTAMP,
  tank_size_litres        INT,
  target_duration_min     INT NOT NULL,          -- min duration from tank size
  actual_duration_min     INT,
  extended_duration_min   INT DEFAULT 0,
  extension_reason        TEXT,
  fan_started_at          TIMESTAMP,
  ambient_o3_ppm          DECIMAL(6,3),
  ambient_o3_result       VARCHAR(4),            -- PASS|FAIL
  ambient_o3_checked_at   TIMESTAMP,
  dissolved_o3_mgl        DECIMAL(6,3),
  dissolved_o3_result     VARCHAR(4),
  dissolved_o3_checked_at TIMESTAMP,
  safety_passed           BOOLEAN NOT NULL DEFAULT FALSE,
  safety_passed_at        TIMESTAMP,
  setup_photo_url         VARCHAR(500),
  created_at              TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ozone_sessions_job ON ozone_sessions(job_id);

-- ── 4. Safety checks (confined-space gas + pre-ozone checklist) ───────────
CREATE TABLE IF NOT EXISTS safety_checks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID NOT NULL REFERENCES jobs(id),
  agent_id      UUID NOT NULL REFERENCES users(id),
  check_type    VARCHAR(30) NOT NULL,  -- confined_space_gas | pre_ozone_ppe
  gas_o2_pct    DECIMAL(5,2),
  gas_o3_ppm    DECIMAL(6,3),
  gas_h2s_ppm   DECIMAL(6,3),
  gas_co_ppm    DECIMAL(6,3),
  ppe_checklist JSONB,                 -- pre_ozone: {respirators, monitors, bystanders_clear, customer_notified}
  result        VARCHAR(4) NOT NULL,   -- PASS|FAIL
  fail_reason   TEXT,
  checked_at    TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_safety_checks_job ON safety_checks(job_id, check_type);

-- ── 5. Scheduled notifications (server-side reminder queue) ───────────────
CREATE TABLE IF NOT EXISTS scheduled_notifications (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type         VARCHAR(40) NOT NULL,   -- recleaning_reminder | amc_upsell
  customer_id  UUID NOT NULL REFERENCES users(id),
  job_id       UUID REFERENCES jobs(id),
  due_date     DATE NOT NULL,
  payload      JSONB DEFAULT '{}',
  sent         BOOLEAN NOT NULL DEFAULT FALSE,
  sent_at      TIMESTAMP,
  created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sched_notif_due ON scheduled_notifications(due_date) WHERE sent = FALSE;

-- ── 6. Daily MIS (end-of-shift submission per agent) ──────────────────────
CREATE TABLE IF NOT EXISTS daily_mis (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          UUID NOT NULL REFERENCES users(id),
  shift_date        DATE NOT NULL DEFAULT CURRENT_DATE,
  jobs_done         INT DEFAULT 0,
  water_saved_litres INT DEFAULT 0,
  avg_eco_score     DECIMAL(5,2),
  amc_leads         INT DEFAULT 0,
  incidents         INT DEFAULT 0,
  o2_used_bar       INT,
  submitted_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (agent_id, shift_date)
);

-- ── 7. Jobs — SOP v2 columns ──────────────────────────────────────────────
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS departure_time        TIMESTAMP,             -- en-route logging
  ADD COLUMN IF NOT EXISTS arrived_at            TIMESTAMP,             -- geofenced arrival
  ADD COLUMN IF NOT EXISTS arrival_gps_lat       DECIMAL(10,7),
  ADD COLUMN IF NOT EXISTS arrival_gps_lng       DECIMAL(10,7),
  ADD COLUMN IF NOT EXISTS start_otp_attempts    INT NOT NULL DEFAULT 0, -- max 5 (G-2)
  ADD COLUMN IF NOT EXISTS end_otp_attempts      INT NOT NULL DEFAULT 0, -- max 5 (G-11)
  ADD COLUMN IF NOT EXISTS pre_damage_level      VARCHAR(10),            -- none|minor|major
  ADD COLUMN IF NOT EXISTS pre_damage_notes      TEXT,
  ADD COLUMN IF NOT EXISTS pre_damage_photo_url  VARCHAR(500),
  ADD COLUMN IF NOT EXISTS ozone_safety_passed_at TIMESTAMP,            -- G-7 + G-8 cleared
  ADD COLUMN IF NOT EXISTS orp_gate_failed       BOOLEAN DEFAULT FALSE, -- after-ORP < 650 mV → cert capped Silver
  ADD COLUMN IF NOT EXISTS o3_final_safe         BOOLEAN,               -- final dissolved O3 < 0.05 (G-10); NULL = not yet read
  ADD COLUMN IF NOT EXISTS amc_interest          VARCHAR(20),           -- signed_up|interested|not_interested
  ADD COLUMN IF NOT EXISTS review_requested      BOOLEAN,
  ADD COLUMN IF NOT EXISTS paused                BOOLEAN NOT NULL DEFAULT FALSE, -- critical incident pause
  ADD COLUMN IF NOT EXISTS payment_collected_method VARCHAR(10),        -- upi|cash|prepaid
  ADD COLUMN IF NOT EXISTS payment_collected_at  TIMESTAMP;

-- ── 8. Compliance logs — numeric litres + cleanup checklist ───────────────
ALTER TABLE compliance_logs
  ADD COLUMN IF NOT EXISTS volume_drained_litres INT,     -- step 2
  ADD COLUMN IF NOT EXISTS water_before_litres   INT,     -- step 4
  ADD COLUMN IF NOT EXISTS water_after_litres    INT,     -- step 4
  ADD COLUMN IF NOT EXISTS water_used_litres     INT,     -- auto-calc before − after
  ADD COLUMN IF NOT EXISTS cleanup_checklist     JSONB;   -- step 8: 4-item site clean-up
