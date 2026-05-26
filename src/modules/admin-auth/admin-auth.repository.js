/**
 * Data-access layer for the admin-auth module.
 * No business logic here — just SQL.
 */

const crypto = require('crypto');
const { query } = require('../../config/db');

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const AdminAuthRepository = {

  /* ── admin_users ─────────────────────────────────────────────────────── */

  findAdminByUsernameOrEmail: async (usernameOrEmail) => {
    const { rows } = await query(
      `SELECT id, username, email, password_hash, full_name, phone,
              admin_role, permissions, is_active, last_login_at, created_at
         FROM admin_users
        WHERE (LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1))
          AND is_active = true
        LIMIT 1`,
      [usernameOrEmail]
    );
    return rows[0] || null;
  },

  findAdminById: async (id) => {
    const { rows } = await query(
      `SELECT id, username, email, full_name, phone, admin_role, permissions,
              is_active, last_login_at, created_at, created_by
         FROM admin_users
        WHERE id = $1
        LIMIT 1`,
      [id]
    );
    return rows[0] || null;
  },

  findAdminByEmail: async (email) => {
    const { rows } = await query(
      `SELECT id FROM admin_users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [email]
    );
    return rows[0] || null;
  },

  findAdminByUsername: async (username) => {
    const { rows } = await query(
      `SELECT id FROM admin_users WHERE LOWER(username) = LOWER($1) LIMIT 1`,
      [username]
    );
    return rows[0] || null;
  },

  listAdminAccounts: async () => {
    const { rows } = await query(
      `SELECT id, username, email, full_name, phone, admin_role, permissions,
              is_active, last_login_at, created_at, created_by
         FROM admin_users
        ORDER BY created_at DESC`
    );
    return rows;
  },

  createAdmin: async ({ username, email, password_hash, full_name, phone, admin_role, created_by }) => {
    const { rows } = await query(
      `INSERT INTO admin_users (username, email, password_hash, full_name, phone, admin_role, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, username, email, full_name, phone, admin_role, permissions, is_active, created_at`,
      [username, email, password_hash, full_name, phone || null, admin_role || 'ops_manager', created_by]
    );
    return rows[0];
  },

  updatePasswordHash: async (id, password_hash) => {
    await query(
      `UPDATE admin_users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
      [password_hash, id]
    );
  },

  setLastLogin: async (id) => {
    await query(
      `UPDATE admin_users SET last_login_at = NOW() WHERE id = $1`,
      [id]
    );
  },

  deactivateAdmin: async (id) => {
    await query(
      `UPDATE admin_users SET is_active = false, updated_at = NOW() WHERE id = $1`,
      [id]
    );
  },

  /* ── admin_sessions ──────────────────────────────────────────────────── */

  createSession: async ({ admin_id, token, expires_at, ip_address, user_agent }) => {
    const token_hash = hashToken(token);
    const { rows } = await query(
      `INSERT INTO admin_sessions (admin_id, token_hash, expires_at, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, admin_id, expires_at, created_at`,
      [admin_id, token_hash, expires_at, ip_address || null, user_agent || null]
    );
    return rows[0];
  },

  findActiveSession: async (sessionId, token) => {
    const token_hash = hashToken(token);
    const { rows } = await query(
      `SELECT id, admin_id, expires_at, revoked
         FROM admin_sessions
        WHERE id = $1 AND token_hash = $2 AND revoked = false AND expires_at > NOW()
        LIMIT 1`,
      [sessionId, token_hash]
    );
    return rows[0] || null;
  },

  revokeSession: async (sessionId) => {
    await query(
      `UPDATE admin_sessions SET revoked = true WHERE id = $1`,
      [sessionId]
    );
  },

  revokeAllSessionsForAdmin: async (adminId) => {
    await query(
      `UPDATE admin_sessions SET revoked = true WHERE admin_id = $1 AND revoked = false`,
      [adminId]
    );
  },

  /* ── admin_audit_log ─────────────────────────────────────────────────── */

  insertAuditLog: async ({ admin_id, action, resource_type, resource_id, old_value, new_value, ip_address }) => {
    await query(
      `INSERT INTO admin_audit_log (admin_id, action, resource_type, resource_id, old_value, new_value, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        admin_id,
        action,
        resource_type || null,
        resource_id ? String(resource_id) : null,
        old_value ? JSON.stringify(old_value) : null,
        new_value ? JSON.stringify(new_value) : null,
        ip_address || null,
      ]
    );
  },

  listAuditLog: async ({ limit = 100, offset = 0, admin_id = null, action = null }) => {
    const conditions = [];
    const params = [];
    if (admin_id) { params.push(admin_id); conditions.push(`admin_id = $${params.length}`); }
    if (action)   { params.push(action);   conditions.push(`action = $${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit, offset);
    const { rows } = await query(
      `SELECT id, admin_id, action, resource_type, resource_id, old_value, new_value, ip_address, created_at
         FROM admin_audit_log
         ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return rows;
  },
};

module.exports = AdminAuthRepository;
module.exports.hashToken = hashToken;
