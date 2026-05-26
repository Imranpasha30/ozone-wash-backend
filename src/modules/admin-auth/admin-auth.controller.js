/**
 * HTTP layer for admin-auth.
 * Spec: Master Prompt v2.0 PART 2.2.3.
 */

const { validationResult } = require('express-validator');
const AdminAuthService = require('./admin-auth.service');
const { sendSuccess, sendError } = require('../../utils/response');

function ip(req) {
  return (
    req.headers['x-forwarded-for']?.toString().split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    null
  );
}

const AdminAuthController = {

  // POST /api/v1/admin-auth/login
  login: async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, 'Validation failed', 400, errors.array());
      }
      const { username, password } = req.body;
      const result = await AdminAuthService.loginAdmin({
        usernameOrEmail: username,
        password,
        ip_address: ip(req),
        user_agent: req.headers['user-agent'] || null,
      });
      return sendSuccess(res, result, 'Login successful');
    } catch (err) { next(err); }
  },

  // POST /api/v1/admin-auth/logout
  logout: async (req, res, next) => {
    try {
      await AdminAuthService.logoutAdmin({
        admin_id: req.admin.id,
        session_id: req.admin_session_id,
        ip_address: ip(req),
      });
      return sendSuccess(res, null, 'Logged out');
    } catch (err) { next(err); }
  },

  // POST /api/v1/admin-auth/change-password
  changePassword: async (req, res, next) => {
    try {
      const { old_password, new_password } = req.body;
      const result = await AdminAuthService.changePassword({
        admin_id: req.admin.id,
        old_password,
        new_password,
        ip_address: ip(req),
      });
      return sendSuccess(res, result, result.message);
    } catch (err) { next(err); }
  },

  // GET /api/v1/admin-auth/me
  me: async (req, res, next) => {
    try {
      const admin = await AdminAuthService.getAdminById(req.admin.id);
      return sendSuccess(res, { admin });
    } catch (err) { next(err); }
  },

  // POST /api/v1/admin-auth/accounts (super_admin only)
  createAccount: async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, 'Validation failed', 400, errors.array());
      }
      const result = await AdminAuthService.createAdminAccount({
        created_by: req.admin.id,
        username: req.body.username,
        email: req.body.email,
        password: req.body.password || null,    // null → auto-generate
        full_name: req.body.full_name,
        phone: req.body.phone || null,
        admin_role: req.body.admin_role,
        ip_address: ip(req),
      });
      return sendSuccess(res, result, 'Admin account created');
    } catch (err) { next(err); }
  },

  // GET /api/v1/admin-auth/accounts (super_admin only)
  listAccounts: async (req, res, next) => {
    try {
      const admins = await AdminAuthService.listAdminAccounts();
      return sendSuccess(res, { admins });
    } catch (err) { next(err); }
  },

  // PATCH /api/v1/admin-auth/accounts/:id/deactivate (super_admin only)
  deactivateAccount: async (req, res, next) => {
    try {
      const result = await AdminAuthService.deactivateAdmin({
        admin_id: req.params.id,
        performed_by_admin_id: req.admin.id,
        ip_address: ip(req),
      });
      return sendSuccess(res, result, result.message);
    } catch (err) { next(err); }
  },

  // POST /api/v1/admin-auth/accounts/:id/revoke-sessions (super_admin only)
  revokeSessions: async (req, res, next) => {
    try {
      await AdminAuthService.revokeAllSessions({
        admin_id: req.params.id,
        performed_by_admin_id: req.admin.id,
        ip_address: ip(req),
      });
      return sendSuccess(res, null, 'All sessions revoked');
    } catch (err) { next(err); }
  },

  // GET /api/v1/admin-auth/audit-log (super_admin only)
  auditLog: async (req, res, next) => {
    try {
      const limit  = Math.min(parseInt(req.query.limit, 10) || 100, 500);
      const offset = parseInt(req.query.offset, 10) || 0;
      const rows = await AdminAuthService.getAuditLog({
        limit,
        offset,
        admin_id: req.query.admin_id || null,
        action: req.query.action || null,
      });
      return sendSuccess(res, { entries: rows, limit, offset });
    } catch (err) { next(err); }
  },
};

module.exports = AdminAuthController;
