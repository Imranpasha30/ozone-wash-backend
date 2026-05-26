-- Migration 012: Separate admin users from customer/field_team users
-- Spec: Master Prompt v2.0 — PART 2 (Admin Separation)
--
-- Creates three new tables:
--   admin_users       — dedicated admin account table (username + email + bcrypt password)
--   admin_sessions    — server-side session tracking (allows forced logout, revocation)
--   admin_audit_log   — append-only audit trail for every admin action
--
-- Does NOT yet remove 'admin' from the existing users.role CHECK constraint.
-- That happens in migration 013 AFTER existing admin users are migrated by
-- scripts/migrate_admins_to_admin_users.js.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ──────────────────────────────────────────────────────────────────────────
-- admin_users
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username       VARCHAR(50) UNIQUE NOT NULL,
  email          VARCHAR(255) UNIQUE NOT NULL,
  password_hash  VARCHAR(255) NOT NULL,                   -- bcrypt cost factor 12
  full_name      VARCHAR(255) NOT NULL,
  phone          VARCHAR(15),                             -- optional, emergency contact only
  admin_role     VARCHAR(50) NOT NULL DEFAULT 'ops_manager'
                   CHECK (admin_role IN (
                     'super_admin',
                     'ops_manager',
                     'finance',
                     'support',
                     'read_only'
                   )),
  permissions    JSONB NOT NULL DEFAULT '[]'::jsonb,      -- granular overrides on top of admin_role
  is_active      BOOLEAN NOT NULL DEFAULT true,
  last_login_at  TIMESTAMP WITH TIME ZONE,
  created_by     UUID REFERENCES admin_users(id),         -- who created this admin (NULL for the seed)
  created_at     TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at     TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_users_username ON admin_users(username);
CREATE INDEX IF NOT EXISTS idx_admin_users_email    ON admin_users(email);
CREATE INDEX IF NOT EXISTS idx_admin_users_active   ON admin_users(is_active);

-- Seed the first super_admin.
-- Password = OzoneAdmin@2025 (must be rotated on first login).
-- Hash generated via: node -e "require('bcrypt').hash('OzoneAdmin@2025', 12).then(console.log)"
INSERT INTO admin_users (username, email, password_hash, full_name, admin_role, created_by)
VALUES (
  'super_admin',
  'admin@ozonewash.in',
  '$2b$12$5tjJvIuUxU1mQQI/BIn2u.//lts2G9EF3P8tbYCFYiznlHZlmu4M2',
  'Super Admin',
  'super_admin',
  NULL
)
ON CONFLICT (username) DO NOTHING;

-- ──────────────────────────────────────────────────────────────────────────
-- admin_sessions
-- Server-side session record. The JWT itself carries session_id; on every
-- request we validate the row exists and is not revoked. This enables forced
-- logout / revoke-all-devices without rotating JWT_SECRET.
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_sessions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id       UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hash     VARCHAR(255) NOT NULL,                   -- SHA-256 of the issued JWT
  ip_address     INET,
  user_agent     TEXT,
  expires_at     TIMESTAMP WITH TIME ZONE NOT NULL,
  revoked        BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin_id ON admin_sessions(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_token    ON admin_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_active   ON admin_sessions(admin_id, revoked, expires_at);

-- ──────────────────────────────────────────────────────────────────────────
-- admin_audit_log
-- Append-only record of every admin action. Old/new values stored as JSONB
-- for replay + diff. BIGSERIAL because we expect high volume long term.
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id             BIGSERIAL PRIMARY KEY,
  admin_id       UUID NOT NULL REFERENCES admin_users(id),
  action         VARCHAR(100) NOT NULL,                   -- e.g. 'booking.cancel', 'crew.assign', 'admin.create'
  resource_type  VARCHAR(50),                             -- 'booking' | 'job' | 'user' | 'admin' | etc.
  resource_id    VARCHAR(100),
  old_value      JSONB,
  new_value      JSONB,
  ip_address     INET,
  created_at     TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_admin_id      ON admin_audit_log(admin_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at    ON admin_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action        ON admin_audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_log_resource      ON admin_audit_log(resource_type, resource_id);
