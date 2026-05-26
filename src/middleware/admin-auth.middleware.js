/**
 * Admin authentication middleware.
 * Spec: Master Prompt v2.0 PART 2.2.5.
 *
 * Distinct from auth.middleware.js (which handles user phone-OTP JWTs).
 * Admin JWTs have type='admin' and carry a session_id that's validated
 * against the admin_sessions table on every request (revocable sessions).
 */

const jwt = require('jsonwebtoken');
const AdminAuthRepository = require('../modules/admin-auth/admin-auth.repository');
const { hasPermission } = require('../modules/admin-auth/permissions');
const { sendError } = require('../utils/response');

/**
 * Decode the admin JWT, validate session in DB, attach req.admin.
 */
const authenticateAdmin = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return sendError(res, 'No token provided. Please log in.', 401);
  }
  const token = authHeader.split(' ')[1];

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return sendError(res, 'Session expired. Please log in again.', 401);
    }
    return sendError(res, 'Invalid token.', 401);
  }

  if (decoded.type !== 'admin' || !decoded.session_id) {
    return sendError(res, 'Not an admin token.', 403);
  }

  // Validate the session still exists, is not revoked, and the token_hash
  // matches the row. This lets super_admin force-logout any admin instantly.
  const session = await AdminAuthRepository.findActiveSession(decoded.session_id, token);
  if (!session) {
    return sendError(res, 'Session revoked or expired. Please log in again.', 401);
  }

  // Hydrate full admin record (in case role/permissions changed since JWT was minted).
  const admin = await AdminAuthRepository.findAdminById(decoded.sub);
  if (!admin || !admin.is_active) {
    return sendError(res, 'Admin account is inactive.', 403);
  }

  req.admin = admin;
  req.admin_session_id = decoded.session_id;
  next();
};

/**
 * Restrict to specific admin_role(s).
 * Usage: requireAdminRole('super_admin') or requireAdminRole('super_admin', 'finance')
 */
const requireAdminRole = (...roles) => {
  return (req, res, next) => {
    if (!req.admin) return sendError(res, 'Not authenticated.', 401);
    if (!roles.includes(req.admin.admin_role)) {
      return sendError(
        res,
        `Access denied. Required role: ${roles.join(' or ')}`,
        403
      );
    }
    next();
  };
};

/**
 * Restrict to admins who have a specific permission (role-based or override).
 * Usage: requirePermission('booking.cancel')
 */
const requirePermission = (permission) => {
  return (req, res, next) => {
    if (!req.admin) return sendError(res, 'Not authenticated.', 401);
    if (!hasPermission(req.admin, permission)) {
      return sendError(
        res,
        `Access denied. Missing permission: ${permission}`,
        403
      );
    }
    next();
  };
};

module.exports = {
  authenticateAdmin,
  requireAdminRole,
  requirePermission,
};
