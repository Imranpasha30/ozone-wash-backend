const express = require('express');
const { body } = require('express-validator');
const AdminAuthController = require('./admin-auth.controller');
const {
  authenticateAdmin,
  requireAdminRole,
} = require('../../middleware/admin-auth.middleware');

const router = express.Router();

/**
 * Admin Auth routes
 * Spec: Master Prompt v2.0 PART 2.2.3
 * Mounted at /api/v1/admin-auth
 */

// ── Validation rules ───────────────────────────────────────────────────────
const loginValidation = [
  body('username').trim().notEmpty().withMessage('username or email is required'),
  body('password').isLength({ min: 1 }).withMessage('password is required'),
];

const createAccountValidation = [
  body('username').trim().notEmpty()
    .matches(/^[a-zA-Z0-9_.]{3,50}$/)
    .withMessage('username must be 3-50 alphanumeric / underscore / dot chars'),
  body('email').trim().isEmail().withMessage('valid email required'),
  body('full_name').trim().isLength({ min: 2, max: 255 }).withMessage('full_name 2-255 chars'),
  body('admin_role').optional().isIn(['super_admin', 'ops_manager', 'finance', 'support', 'read_only']),
  body('password').optional().isLength({ min: 10 }).withMessage('password must be ≥ 10 chars when set manually'),
];

const changePasswordValidation = [
  body('old_password').isLength({ min: 1 }).withMessage('old_password required'),
  body('new_password').isLength({ min: 10 }).withMessage('new_password must be ≥ 10 chars'),
];

// ── Public ─────────────────────────────────────────────────────────────────
router.post('/login', loginValidation, AdminAuthController.login);

// ── Authenticated (any admin) ──────────────────────────────────────────────
router.post('/logout',          authenticateAdmin, AdminAuthController.logout);
router.post('/change-password', authenticateAdmin, changePasswordValidation, AdminAuthController.changePassword);
router.get ('/me',              authenticateAdmin, AdminAuthController.me);

// ── Super admin only ───────────────────────────────────────────────────────
router.post  ('/accounts',
              authenticateAdmin, requireAdminRole('super_admin'),
              createAccountValidation, AdminAuthController.createAccount);

router.get   ('/accounts',
              authenticateAdmin, requireAdminRole('super_admin'),
              AdminAuthController.listAccounts);

router.patch ('/accounts/:id/deactivate',
              authenticateAdmin, requireAdminRole('super_admin'),
              AdminAuthController.deactivateAccount);

router.post  ('/accounts/:id/revoke-sessions',
              authenticateAdmin, requireAdminRole('super_admin'),
              AdminAuthController.revokeSessions);

router.get   ('/audit-log',
              authenticateAdmin, requireAdminRole('super_admin'),
              AdminAuthController.auditLog);

module.exports = router;
