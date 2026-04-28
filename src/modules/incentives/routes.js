/**
 * Incentive routes
 *
 * Field-team:
 *   GET  /api/v1/incentives/me
 *   GET  /api/v1/incentives/me/credits     (Phase B credit engine)
 *   GET  /api/v1/incentives/me/history
 *
 * Admin:
 *   GET  /api/v1/admin/incentives/payouts?month=YYYY-MM
 *   POST /api/v1/admin/incentives/payouts/:batchId/freeze
 *   POST /api/v1/admin/incentives/payouts/:batchId/mark-paid
 *   POST /api/v1/admin/incentives/payouts/:batchId/reverse
 *   GET  /api/v1/admin/incentives/rules
 *   PUT  /api/v1/admin/incentives/rules
 *   GET  /api/v1/admin/incentives/credits/:month   (Phase B credit engine)
 */

const express = require('express');
const { authenticate, requireRole } = require('../../middleware/auth.middleware');
const ctrl = require('./controller');

const meRouter    = express.Router();
const adminRouter = express.Router();

/* Field-team self */
meRouter.get('/me',         authenticate, requireRole('field_team'), ctrl.getMyLedger);
meRouter.get('/me/credits', authenticate, requireRole('field_team'), ctrl.getMyCredits);
meRouter.get('/me/history', authenticate, requireRole('field_team'), ctrl.getMyHistory);

/* Admin */
adminRouter.get('/payouts',                         authenticate, requireRole('admin'), ctrl.adminListPayouts);
adminRouter.post('/payouts/:batchId/freeze',        authenticate, requireRole('admin'), ctrl.adminFreezeBatch);
adminRouter.post('/payouts/:batchId/mark-paid',     authenticate, requireRole('admin'), ctrl.adminMarkPaid);
adminRouter.post('/payouts/:batchId/reverse',       authenticate, requireRole('admin'), ctrl.adminReverseBatch);
adminRouter.get('/rules',                           authenticate, requireRole('admin'), ctrl.adminGetRules);
adminRouter.put('/rules',                           authenticate, requireRole('admin'), ctrl.adminUpdateRules);
adminRouter.get('/credits/:month',                  authenticate, requireRole('admin'), ctrl.adminGetCreditsForMonth);

module.exports = { meRouter, adminRouter };
