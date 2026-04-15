-- Migration 003: Add job_requests table for field team assignment workflow

CREATE TABLE IF NOT EXISTS job_requests (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id     UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  team_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_requests_job    ON job_requests(job_id);
CREATE INDEX IF NOT EXISTS idx_job_requests_team   ON job_requests(team_id);
CREATE INDEX IF NOT EXISTS idx_job_requests_status ON job_requests(status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_job_requests_unique_pending
  ON job_requests(job_id, team_id) WHERE status = 'pending';
