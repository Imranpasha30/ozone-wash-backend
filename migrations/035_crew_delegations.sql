-- ═══════════════════════════════════════════════════════════════════════
-- 035_crew_delegations.sql — leader delegates a job's duty to a crew member
--
-- Model: a team-assigned job is VISIBLE to every member (shared progress), but
-- by default only the LEADER (jobs.assigned_team_id = the lead agent) can WORK
-- it (start / OTP / complete / transfer). When the leader is absent/unable they
-- can hand the duty to a specific member WITHOUT reassigning the job —
-- scoped to a single job (job_id) OR a whole day (date, all the team's jobs).
-- Delegations are additive (leader keeps access) and can be revoked.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS crew_delegations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id           UUID NOT NULL REFERENCES field_teams(id) ON DELETE CASCADE,
  delegate_agent_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id            UUID REFERENCES jobs(id) ON DELETE CASCADE,  -- set → just this job
  date              DATE,                                        -- set → all team jobs that day
  note              TEXT,
  created_by        UUID,   -- leader (users) or admin (admin_users); mixed, so no FK
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT crew_deleg_scope CHECK (job_id IS NOT NULL OR date IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_crew_deleg_agent     ON crew_delegations(delegate_agent_id);
CREATE INDEX IF NOT EXISTS idx_crew_deleg_job       ON crew_delegations(job_id);
CREATE INDEX IF NOT EXISTS idx_crew_deleg_team_date ON crew_delegations(team_id, date);
