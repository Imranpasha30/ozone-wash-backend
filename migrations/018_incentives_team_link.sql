-- ──────────────────────────────────────────────────────────────────────────
-- 018_incentives_team_link.sql
-- Attribute each incentive line to the field team that earned it (when the
-- job was team-assigned). Lets us report "how much did Team Alpha earn
-- this month" and break down each agent's earnings by team.
-- Nullable — pre-team historical rows stay valid.
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE incentives
  ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES field_teams(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_incentives_team ON incentives(team_id)
  WHERE team_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_incentives_agent_created ON incentives(agent_id, created_at DESC);
