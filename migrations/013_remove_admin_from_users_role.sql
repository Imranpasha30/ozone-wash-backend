-- Migration 013: Remove 'admin' from users.role CHECK constraint
-- Spec: Master Prompt v2.0 — PART 2.2.7 (Migration Safety Note)
--
-- ⚠️  DO NOT APPLY THIS MIGRATION until scripts/migrate_admins_to_admin_users.js
--    has been run successfully on the target database. The script moves all
--    existing rows where users.role = 'admin' into the new admin_users table.
--    Applying this migration before the script will fail because the CHECK
--    constraint cannot be added while admin rows still exist in users.
--
-- ⚠️  Spec mentioned `ALTER TYPE user_role ADD VALUE 'fleet_client'` but the
--    current schema uses a VARCHAR + CHECK constraint, not a Postgres ENUM.
--    So we recreate the CHECK constraint instead of altering a type.
--    'fleet_client' is added in migration 014, not here.

-- Safety guard: refuse to run if any user still has role='admin'.
DO $$
DECLARE
  leftover_admin_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO leftover_admin_count FROM users WHERE role = 'admin';
  IF leftover_admin_count > 0 THEN
    RAISE EXCEPTION
      'Cannot drop admin role: % users still have role=admin. Run scripts/migrate_admins_to_admin_users.js first.',
      leftover_admin_count;
  END IF;
END $$;

-- Drop the old constraint that includes 'admin'.
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_role_check;

-- Add the new constraint without 'admin'. Field team and customer remain.
-- 'fleet_client' will be added in migration 014.
ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('customer', 'field_team'));
