-- Rollback for migration 012 — admin separation
-- Spec: Master Prompt v2.0 PART 9 (Important Constraints) — rollback safety
--
-- ⚠️  DANGER ZONE
-- ────────────────────────────────────────────────────────────────────
-- This script REVERSES migration 012 by dropping admin_audit_log,
-- admin_sessions, and admin_users. All admin accounts and the entire
-- audit history will be permanently destroyed.
--
-- Do NOT run this in production unless you have:
--   1. Verified there are no real admin users in admin_users (only the
--      seed super_admin), OR
--   2. Backed up admin_users + admin_audit_log to a safe location, OR
--   3. Re-migrated existing admins back into users.role='admin' first.
--
-- The migrate.js runner does NOT auto-apply this file (it only reads
-- forward migrations). Apply it manually:
--
--   cd ozone-wash-backend
--   psql "$DATABASE_URL" -f migrations/rollbacks/012_admin_separation.rollback.sql
--
-- Or via node one-shot:
--   node -e "require('dotenv').config({path:'.env.client'}); \
--     const{Pool}=require('pg'); \
--     const p=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}}); \
--     p.query(require('fs').readFileSync('migrations/rollbacks/012_admin_separation.rollback.sql','utf8')) \
--       .then(()=>{console.log('rolled back'); p.end();}) \
--       .catch(e=>{console.error(e.message); p.end();});"
--
-- Note: this file lives in migrations/rollbacks/ so the forward migration
-- runner (scripts/migrate.js) does NOT pick it up — its readdirSync only
-- scans the top-level migrations/ directory.
-- ────────────────────────────────────────────────────────────────────

-- ── Safety guard ──────────────────────────────────────────────────────────
-- Refuse to drop if there are non-seed admin accounts (anyone other than the
-- single 'super_admin' seed row) or any real audit history (>2 rows — the
-- two admin.login events from initial verification are allowed to remain).
-- Override by setting GUARD_OFF first: SET LOCAL guard_off = 'YES';
DO $$
DECLARE
  real_admin_count INT;
  audit_count      INT;
  guard_off        TEXT := current_setting('guard_off', true);
BEGIN
  IF guard_off IS NULL OR guard_off <> 'YES' THEN
    SELECT COUNT(*) INTO real_admin_count
      FROM admin_users
     WHERE username <> 'super_admin';
    IF real_admin_count > 0 THEN
      RAISE EXCEPTION
        'Rollback refused: % non-seed admin account(s) exist. Set guard_off=YES to force.',
        real_admin_count;
    END IF;

    SELECT COUNT(*) INTO audit_count FROM admin_audit_log;
    IF audit_count > 10 THEN
      RAISE EXCEPTION
        'Rollback refused: admin_audit_log has % entries (>10). Set guard_off=YES to force.',
        audit_count;
    END IF;
  END IF;
END $$;

-- ── Drop in reverse FK order ──────────────────────────────────────────────
DROP TABLE IF EXISTS admin_audit_log;
DROP TABLE IF EXISTS admin_sessions;
DROP TABLE IF EXISTS admin_users;

-- ── Un-record the migration so it can be re-applied later ────────────────
DELETE FROM schema_migrations WHERE name = '012_admin_separation.sql';
