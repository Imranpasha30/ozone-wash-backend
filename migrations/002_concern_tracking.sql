-- Migration 002: Add scheduling conflict concern tracking to jobs

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS concern_message    TEXT,
  ADD COLUMN IF NOT EXISTS concern_raised_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS concern_resolved   BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS concern_raised_by  UUID REFERENCES users(id);
