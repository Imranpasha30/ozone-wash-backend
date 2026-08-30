const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { sendError } = require('../utils/response');

// Use this on any route that needs a logged-in user
const authenticate = async (req, res, next) => {
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

  // Confirm the account behind the token STILL EXISTS. A signature-valid token
  // for a deleted account (e.g. after a data reset) would otherwise sail past
  // auth and blow up deep in a request as a confusing FK error ("Referenced
  // record does not exist"). Returning 401 here makes the client clear the
  // stale token and route to login. On a transient DB error we fall back to
  // trusting the token so a DB hiccup doesn't log everyone out.
  try {
    // Admin tokens have a different shape — `{ sub, type:'admin', admin_role,
    // permissions, session_id }` — issued by admin-auth.service.js. Map them
    // into the user-shaped `req.user` so existing `requireRole('admin')`
    // checks on shared routes (e.g. /api/v1/bookings) accept them too.
    if (decoded.type === 'admin') {
      const { rows } = await db.query(`SELECT id FROM admin_users WHERE id = $1`, [decoded.sub]);
      if (!rows.length) return sendError(res, 'Session expired. Please log in again.', 401);
      req.user = {
        id: decoded.sub,
        role: 'admin',
        admin_role: decoded.admin_role,
        username: decoded.username,
        permissions: decoded.permissions || [],
      };
    } else {
      const { rows } = await db.query(`SELECT id, role FROM users WHERE id = $1`, [decoded.id]);
      if (!rows.length) return sendError(res, 'Session expired. Please log in again.', 401);
      req.user = { ...decoded, role: rows[0].role || decoded.role }; // { id, phone, role }
    }
    return next();
  } catch (e) {
    console.warn('[auth] account existence check failed, trusting token:', e?.message);
    if (decoded.type === 'admin') {
      req.user = {
        id: decoded.sub, role: 'admin', admin_role: decoded.admin_role,
        username: decoded.username, permissions: decoded.permissions || [],
      };
    } else {
      req.user = decoded;
    }
    return next();
  }
};

// Use this AFTER authenticate to restrict to specific roles
// Example: requireRole('admin') or requireRole('field_team')
const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return sendError(res, 'Not authenticated.', 401);
    }
    if (!roles.includes(req.user.role)) {
      return sendError(
        res,
        `Access denied. Required role: ${roles.join(' or ')}`,
        403
      );
    }
    next();
  };
};

module.exports = { authenticate, requireRole };