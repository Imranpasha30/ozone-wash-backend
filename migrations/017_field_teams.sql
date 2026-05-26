-- ──────────────────────────────────────────────────────────────────────────
-- 017_field_teams.sql
-- Group field agents into named teams with a leader. Jobs can now be
-- assigned to a team instead of (or alongside) a single agent. The
-- incentive engine splits each completed job's accruals across the team
-- members per their share_pct, with a configurable leader bonus.
-- ──────────────────────────────────────────────────────────────────────────

-- A team has a name, a leader, and an active flag. created_by tracks which
-- admin assembled the team.
CREATE TABLE IF NOT EXISTS field_teams (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(120) NOT NULL,
  leader_id     UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  description   TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_by    UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- An agent belongs to at most one ACTIVE team at a time. share_pct controls
-- their slice of the team's incentive pool — values are relative and get
-- normalized at payout (e.g., 60/40 split = leader 60, member 40). Default
-- 100 means equal share when every member uses the default.
CREATE TABLE IF NOT EXISTS field_team_members (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id    UUID NOT NULL REFERENCES field_teams(id) ON DELETE CASCADE,
  agent_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       VARCHAR(20) NOT NULL DEFAULT 'member'
               CHECK (role IN ('leader', 'member')),
  share_pct  INT NOT NULL DEFAULT 100 CHECK (share_pct > 0 AND share_pct <= 1000),
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (team_id, agent_id)
);

-- Only one ACTIVE membership per agent. We enforce via a partial unique
-- index instead of a row constraint so historical (deactivated) memberships
-- stay queryable.
CREATE UNIQUE INDEX IF NOT EXISTS unq_field_team_active_member
  ON field_team_members(agent_id) WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_field_team_members_team ON field_team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_field_teams_leader ON field_teams(leader_id);

-- A job's team assignment is independent of the legacy assigned_team_id
-- (singular agent). Setting both is permitted — the engine prefers
-- assigned_field_team_id when present. Backward compat is preserved.
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS assigned_field_team_id
    UUID REFERENCES field_teams(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_field_team ON jobs(assigned_field_team_id)
  WHERE assigned_field_team_id IS NOT NULL;

-- Trigger to keep updated_at fresh on field_teams.
CREATE OR REPLACE FUNCTION touch_field_teams_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_field_teams_touch ON field_teams;
CREATE TRIGGER trg_field_teams_touch BEFORE UPDATE ON field_teams
  FOR EACH ROW EXECUTE FUNCTION touch_field_teams_updated_at();
