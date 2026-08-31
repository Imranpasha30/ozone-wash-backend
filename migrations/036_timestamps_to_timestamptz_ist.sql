-- 036: Standardize timestamps to timestamptz + pin the DB session to IST.
--
-- WHY: the schema had 52 naive `timestamp` columns with TWO conventions —
--   * bookings.slot_time / jobs.scheduled_at hold IST wall-clock (the app sends
--     naive slot strings like '2026-09-01T08:00:00' meaning 8 AM IST), while
--   * created_at/updated_at/*_at/etc. hold UTC wall-clock (written via NOW()).
-- node-pg parses ALL naive columns with the single process TZ, so on Railway
-- (UTC) slot_time round-tripped back as '08:00Z' and IST devices rendered a
-- booked 08:00 slot as 13:30 — a latent 5.5h display bug. This migration makes
-- every business timestamp an unambiguous absolute instant (timestamptz) and
-- sets the database default timezone to Asia/Kolkata so:
--   * naive slot strings the app sends are interpreted as IST on write,
--   * DATE()/CURRENT_DATE/date_trunc bucket by the India business day,
--   * timestamptz values are rendered in IST by default.
-- Node stays on UTC; timestamptz is TZ-independent when read (absolute instant).
--
-- Existing rows are converted with the correct SOURCE zone per column so no
-- instant shifts. Every converted (table,column,source) is recorded in
-- _tz_migration_036 so the rollback reverts EXACTLY these columns (never the
-- ~70 columns that were already timestamptz). Rollback: rollbacks/036_down.sql.

-- 1) Database default timezone → IST (applies to all NEW sessions).
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'Asia/Kolkata');
END $$;

-- 2) Ledger of exactly what we convert (drives the precise rollback).
CREATE TABLE IF NOT EXISTS _tz_migration_036 (
  table_name  text NOT NULL,
  column_name text NOT NULL,
  source_tz   text NOT NULL,
  PRIMARY KEY (table_name, column_name)
);

-- 3) Convert every naive timestamp column to timestamptz with the right source zone.
DO $$
DECLARE
  r   record;
  src text;
BEGIN
  FOR r IN
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND data_type = 'timestamp without time zone'
    ORDER BY table_name, column_name
  LOOP
    IF (r.table_name = 'bookings' AND r.column_name = 'slot_time')
       OR (r.table_name = 'jobs' AND r.column_name = 'scheduled_at') THEN
      src := 'Asia/Kolkata';   -- IST wall-clock (user-picked appointment time)
    ELSE
      src := 'UTC';            -- UTC wall-clock (event/audit time via NOW())
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ALTER COLUMN %I TYPE timestamptz USING %I AT TIME ZONE %L',
      r.table_name, r.column_name, r.column_name, src
    );
    INSERT INTO _tz_migration_036 (table_name, column_name, source_tz)
      VALUES (r.table_name, r.column_name, src)
      ON CONFLICT (table_name, column_name) DO NOTHING;
    RAISE NOTICE 'converted %.% (source %)', r.table_name, r.column_name, src;
  END LOOP;
END $$;
