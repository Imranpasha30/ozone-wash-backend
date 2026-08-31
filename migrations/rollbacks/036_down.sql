-- Rollback for 036: timestamptz → naive timestamp, reverting EXACTLY the columns
-- 036 converted (per the _tz_migration_036 ledger), using each column's recorded
-- source zone so values are byte-identical to before 036. Also resets the DB
-- default timezone to UTC and drops the ledger table.

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT table_name, column_name, source_tz FROM _tz_migration_036 LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ALTER COLUMN %I TYPE timestamp USING %I AT TIME ZONE %L',
      r.table_name, r.column_name, r.column_name, r.source_tz
    );
  END LOOP;
END $$;

DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'UTC');
END $$;

DROP TABLE IF EXISTS _tz_migration_036;
