-- ──────────────────────────────────────────────────────────────────────────
-- 019_jobs_location_address.sql
-- Tank bookings store the service address on the bookings row. Auto-wash
-- bookings have no bookings row (they're job-only), so they need their
-- own address column on jobs. Nullable so existing rows remain valid.
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS location_address TEXT;
