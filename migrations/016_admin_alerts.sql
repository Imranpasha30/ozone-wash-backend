-- ──────────────────────────────────────────────────────────────────────────
-- admin_alerts
-- System-generated notifications for the admin team. Created automatically by
-- the booking/job pipeline when scheduling conflicts are detected (slot
-- overbooked, no field team available, technician double-booked, etc).
-- The admin can acknowledge an alert to dismiss it from the dashboard banner.
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS admin_alerts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Discriminator for the alert kind. New types should be added as needed.
  --   slot_conflict       — more bookings at a slot than available teams
  --   team_overcommit     — a team accepted/was assigned overlapping jobs
  --   no_team_for_slot    — booking confirmed but no team is free
  --   incident_open       — escalated incident pending admin review
  type                VARCHAR(40) NOT NULL,
  -- 'info' (FYI) | 'warning' (needs attention) | 'critical' (act now)
  severity            VARCHAR(20) NOT NULL DEFAULT 'warning'
                        CHECK (severity IN ('info', 'warning', 'critical')),
  title               TEXT NOT NULL,
  message             TEXT,
  -- Optional pointers to the entity that triggered the alert.
  related_booking_id  UUID REFERENCES bookings(id) ON DELETE SET NULL,
  related_job_id      UUID REFERENCES jobs(id) ON DELETE SET NULL,
  related_team_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Free-form payload for the UI (timestamps, counts, etc).
  metadata            JSONB DEFAULT '{}'::jsonb,
  acknowledged        BOOLEAN NOT NULL DEFAULT FALSE,
  acknowledged_by     UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  acknowledged_at     TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_alerts_unack
  ON admin_alerts(created_at DESC) WHERE acknowledged = FALSE;
CREATE INDEX IF NOT EXISTS idx_admin_alerts_type ON admin_alerts(type);
CREATE INDEX IF NOT EXISTS idx_admin_alerts_booking ON admin_alerts(related_booking_id);
CREATE INDEX IF NOT EXISTS idx_admin_alerts_job ON admin_alerts(related_job_id);
