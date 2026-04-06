-- Migration: Add OTP columns to jobs + create incident_reports table
-- Run this in Supabase SQL Editor if your DB was created before this migration.
-- Safe to run multiple times (uses IF NOT EXISTS / IF NOT EXISTS patterns).

-- 1. Add OTP columns to jobs table
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='jobs' AND column_name='start_otp') THEN
    ALTER TABLE jobs ADD COLUMN start_otp VARCHAR(6);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='jobs' AND column_name='end_otp') THEN
    ALTER TABLE jobs ADD COLUMN end_otp VARCHAR(6);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='jobs' AND column_name='start_otp_verified') THEN
    ALTER TABLE jobs ADD COLUMN start_otp_verified BOOLEAN DEFAULT false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='jobs' AND column_name='end_otp_verified') THEN
    ALTER TABLE jobs ADD COLUMN end_otp_verified BOOLEAN DEFAULT false;
  END IF;
END $$;

-- 2. Create incident_reports table
CREATE TABLE IF NOT EXISTS incident_reports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID NOT NULL REFERENCES jobs(id),
  reported_by   UUID NOT NULL REFERENCES users(id),
  description   TEXT NOT NULL,
  photo_url     TEXT,
  audio_url     TEXT,
  severity      VARCHAR(20) DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status        VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'escalated')),
  resolved_by   UUID REFERENCES users(id),
  resolved_at   TIMESTAMP,
  created_at    TIMESTAMP DEFAULT NOW()
);
