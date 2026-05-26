/**
 * Business logic for admin authentication.
 * Spec: Master Prompt v2.0 PART 2.2.3.
 *
 * Admin auth is DELIBERATELY separate from user (phone-OTP) auth:
 *   • Username + bcrypt password (no OTP)
 *   • 8-hour JWT (vs 7-day for users)
 *   • Server-side session record (allows forced logout / revoke)
 *   • Audit-logs every account creation, deactivation, and session revoke
 */

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const AdminAuthRepository = require('./admin-auth.repository');

const BCRYPT_COST = 12;
const ADMIN_JWT_EXPIRY_HOURS = 8;
const ADMIN_JWT_EXPIRES_IN = `${ADMIN_JWT_EXPIRY_HOURS}h`;

function nowPlusHours(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

function sanitizeAdmin(admin) {
  if (!admin) return null;
  // Never expose password_hash.
  const { password_hash, ...safe } = admin;
  return safe;
}

const AdminAuthService = {

  /**
   * Login with username-or-email + password.
   * Returns { token, admin } on success.
   * Throws { status, message } on failure.
   */
  loginAdmin: async ({ usernameOrEmail, password, ip_address, user_agent }) => {
    if (!usernameOrEmail || !password) {
      throw { status: 400, message: 'Username/email and password are required.' };
    }

    const admin = await AdminAuthRepository.findAdminByUsernameOrEmail(usernameOrEmail);
    if (!admin) {
      // Vague error on purpose — don't leak which field was wrong.
      throw { status: 401, message: 'Invalid credentials.' };
    }

    const passwordMatches = await bcrypt.compare(password, admin.password_hash);
    if (!passwordMatches) {
      throw { status: 401, message: 'Invalid credentials.' };
    }

    if (!admin.is_active) {
      throw { status: 403, message: 'This admin account has been deactivated.' };
    }

    // Sign a short-lived JWT with session_id, then store the session row.
    // We do this in two steps so token_hash matches what we signed.
    const expiresAt = nowPlusHours(ADMIN_JWT_EXPIRY_HOURS);
    const token = jwt.sign(
      {
        sub: admin.id,
        type: 'admin',
        username: admin.username,
        admin_role: admin.admin_role,
        permissions: admin.permissions || [],
      },
      process.env.JWT_SECRET,
      { expiresIn: ADMIN_JWT_EXPIRES_IN }
    );

    const session = await AdminAuthRepository.createSession({
      admin_id: admin.id,
      token,
      expires_at: expiresAt,
      ip_address,
      user_agent,
    });

    // Embed session_id by re-signing with it included.
    // (cleaner alternative: include session_id in the original sign call by
    //  pre-generating a UUID; but using DB-generated UUID keeps schema simple)
    const tokenWithSession = jwt.sign(
      {
        sub: admin.id,
        type: 'admin',
        username: admin.username,
        admin_role: admin.admin_role,
        permissions: admin.permissions || [],
        session_id: session.id,
      },
      process.env.JWT_SECRET,
      { expiresIn: ADMIN_JWT_EXPIRES_IN }
    );

    // Replace the session's token_hash with the final token's hash.
    const { hashToken } = AdminAuthRepository;
    await require('../../config/db').query(
      `UPDATE admin_sessions SET token_hash = $1 WHERE id = $2`,
      [hashToken(tokenWithSession), session.id]
    );

    await AdminAuthRepository.setLastLogin(admin.id);
    await AdminAuthRepository.insertAuditLog({
      admin_id: admin.id,
      action: 'admin.login',
      ip_address,
    });

    return {
      token: tokenWithSession,
      admin: sanitizeAdmin(admin),
      expires_at: expiresAt,
    };
  },

  /**
   * Revoke a single session (logout from current device).
   */
  logoutAdmin: async ({ admin_id, session_id, ip_address }) => {
    await AdminAuthRepository.revokeSession(session_id);
    await AdminAuthRepository.insertAuditLog({
      admin_id,
      action: 'admin.logout',
      ip_address,
    });
  },

  /**
   * Force-revoke every active session for an admin (logout all devices).
   * Used by super_admin to lock out a compromised account.
   */
  revokeAllSessions: async ({ admin_id, performed_by_admin_id, ip_address }) => {
    await AdminAuthRepository.revokeAllSessionsForAdmin(admin_id);
    await AdminAuthRepository.insertAuditLog({
      admin_id: performed_by_admin_id,
      action: 'admin.revoke_all_sessions',
      resource_type: 'admin',
      resource_id: admin_id,
      ip_address,
    });
  },

  /**
   * Change the current admin's password. Requires the old password as proof.
   */
  changePassword: async ({ admin_id, old_password, new_password, ip_address }) => {
    if (!old_password || !new_password) {
      throw { status: 400, message: 'Old and new passwords are required.' };
    }
    if (new_password.length < 10) {
      throw { status: 400, message: 'New password must be at least 10 characters.' };
    }

    const admin = await require('../../config/db').query(
      `SELECT id, password_hash FROM admin_users WHERE id = $1`,
      [admin_id]
    );
    if (!admin.rows.length) {
      throw { status: 404, message: 'Admin not found.' };
    }
    const ok = await bcrypt.compare(old_password, admin.rows[0].password_hash);
    if (!ok) {
      throw { status: 401, message: 'Old password is incorrect.' };
    }

    const newHash = await bcrypt.hash(new_password, BCRYPT_COST);
    await AdminAuthRepository.updatePasswordHash(admin_id, newHash);

    // Best-practice: revoke all OTHER sessions when password changes.
    await AdminAuthRepository.revokeAllSessionsForAdmin(admin_id);

    await AdminAuthRepository.insertAuditLog({
      admin_id,
      action: 'admin.password_change',
      ip_address,
    });

    return { message: 'Password updated. You have been logged out of all other sessions.' };
  },

  /**
   * Create a new admin account. Only callable by super_admin.
   * Returns the new admin row + the plaintext temp password
   * (only place it's ever exposed — operator must share securely).
   */
  createAdminAccount: async ({ created_by, username, email, password, full_name, phone, admin_role, ip_address }) => {
    if (!username || !email || !full_name) {
      throw { status: 400, message: 'username, email, and full_name are required.' };
    }
    if (!/^[a-zA-Z0-9_.]{3,50}$/.test(username)) {
      throw { status: 400, message: 'username must be 3-50 chars, alphanumeric / underscore / dot only.' };
    }
    if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
      throw { status: 400, message: 'Invalid email format.' };
    }

    const existingByUsername = await AdminAuthRepository.findAdminByUsername(username);
    if (existingByUsername) throw { status: 409, message: 'Username already taken.' };

    const existingByEmail = await AdminAuthRepository.findAdminByEmail(email);
    if (existingByEmail) throw { status: 409, message: 'Email already registered.' };

    // If no password supplied, auto-generate a strong temp password.
    const finalPassword = password || generateTempPassword();
    if (finalPassword.length < 10) {
      throw { status: 400, message: 'Password must be at least 10 characters.' };
    }
    const passwordHash = await bcrypt.hash(finalPassword, BCRYPT_COST);

    const created = await AdminAuthRepository.createAdmin({
      username,
      email,
      password_hash: passwordHash,
      full_name,
      phone,
      admin_role: admin_role || 'ops_manager',
      created_by,
    });

    await AdminAuthRepository.insertAuditLog({
      admin_id: created_by,
      action: 'admin.create',
      resource_type: 'admin',
      resource_id: created.id,
      new_value: {
        username: created.username,
        email: created.email,
        admin_role: created.admin_role,
      },
      ip_address,
    });

    return {
      admin: created,
      temp_password: password ? null : finalPassword, // only returned if we generated it
    };
  },

  deactivateAdmin: async ({ admin_id, performed_by_admin_id, ip_address }) => {
    const target = await AdminAuthRepository.findAdminById(admin_id);
    if (!target) throw { status: 404, message: 'Admin not found.' };
    if (admin_id === performed_by_admin_id) {
      throw { status: 400, message: 'You cannot deactivate your own account.' };
    }
    await AdminAuthRepository.deactivateAdmin(admin_id);
    await AdminAuthRepository.revokeAllSessionsForAdmin(admin_id);

    await AdminAuthRepository.insertAuditLog({
      admin_id: performed_by_admin_id,
      action: 'admin.deactivate',
      resource_type: 'admin',
      resource_id: admin_id,
      old_value: { is_active: true },
      new_value: { is_active: false },
      ip_address,
    });

    return { message: `Admin ${target.username} deactivated.` };
  },

  getAdminById: async (admin_id) => {
    const admin = await AdminAuthRepository.findAdminById(admin_id);
    return sanitizeAdmin(admin);
  },

  listAdminAccounts: async () => {
    const admins = await AdminAuthRepository.listAdminAccounts();
    return admins.map(sanitizeAdmin);
  },

  getAuditLog: async (filters) => {
    return AdminAuthRepository.listAuditLog(filters);
  },
};

/**
 * Generate a 14-char temp password with letters, digits, and a couple of symbols.
 * Suitable for one-time delivery to a new admin via secure channel.
 */
function generateTempPassword() {
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digit = '23456789';
  const sym   = '@#$%&*';
  const pool  = lower + upper + digit + sym;
  let pw = '';
  // Guarantee at least one of each category
  pw += lower[Math.floor(Math.random() * lower.length)];
  pw += upper[Math.floor(Math.random() * upper.length)];
  pw += digit[Math.floor(Math.random() * digit.length)];
  pw += sym[Math.floor(Math.random() * sym.length)];
  for (let i = 0; i < 10; i++) {
    pw += pool[Math.floor(Math.random() * pool.length)];
  }
  // Light shuffle
  return pw.split('').sort(() => Math.random() - 0.5).join('');
}

module.exports = AdminAuthService;
