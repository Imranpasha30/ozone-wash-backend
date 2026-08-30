-- ═══════════════════════════════════════════════════════════════════════
-- 032_crew_availability.sql — per-crew, per-day availability (leave / sick /
-- off / shift window). Two jobs it does:
--   1. EFFECTIVE VAN COUNT: the capacity engine no longer treats the fleet as a
--      static integer. For a date, effective concurrent capacity =
--      configured vans  −  crews marked leave/sick/off that day. Absent any
--      rows, capacity falls back to the configured fleet (never drops to zero
--      on a normal day).
--   2. ASSIGNMENT GUARD: assigning/approving/transferring a crew that is on
--      leave/sick/off — or a job that falls outside the crew's shift window —
--      is blocked (with an explicit admin override), alongside the existing
--      duration-aware double-booking guard.
--
-- Keyed by the AGENT (users.id) because that is the unit the double-booking
-- guard already serializes on (jobs.assigned_team_id = users.id).
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS crew_availability (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  status      TEXT NOT NULL DEFAULT 'working'
                CHECK (status IN ('working', 'leave', 'sick', 'off')),
  -- Optional shift window (local wall-clock). When both are set, a job must
  -- fit entirely inside [shift_start, shift_end) or the guard blocks it.
  shift_start TIME,
  shift_end   TIME,
  note        TEXT,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent_id, date)
);

-- Capacity queries filter by date + unavailable status; the guard looks up a
-- single (agent, date) row.
CREATE INDEX IF NOT EXISTS idx_crew_availability_date   ON crew_availability(date);
CREATE INDEX IF NOT EXISTS idx_crew_availability_agent  ON crew_availability(agent_id, date);

-- Keep updated_at fresh.
CREATE OR REPLACE FUNCTION touch_crew_availability_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_crew_availability_touch ON crew_availability;
CREATE TRIGGER trg_crew_availability_touch BEFORE UPDATE ON crew_availability
  FOR EACH ROW EXECUTE FUNCTION touch_crew_availability_updated_at();
