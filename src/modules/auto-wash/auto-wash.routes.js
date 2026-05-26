/**
 * Ozone Auto Wash routes.
 * Spec: Master Prompt v2.0 PART 4 + Auto Wash Scope PDF Section 8.
 * Mounted at /api/v1/auto-wash
 */

const express = require('express');
const { body, param } = require('express-validator');
const { authenticate, requireRole } = require('../../middleware/auth.middleware');
const { authenticateAdmin, requireAdminRole } = require('../../middleware/admin-auth.middleware');
const ctrl = require('./auto-wash.controller');
const { sendError } = require('../../utils/response');

const router = express.Router();

/* ── Validation helpers ───────────────────────────────────────────────── */
const validate = (req, res, next) => {
  const { validationResult } = require('express-validator');
  const errs = validationResult(req);
  if (!errs.isEmpty()) return sendError(res, 'Validation failed', 400, errs.array());
  next();
};

const VEHICLE_TYPES = ['hatchback', 'sedan', 'suv_muv', 'luxury', 'two_wheeler'];
const PACKAGE_CODES = ['ecorinse', 'ecoshield', 'ozonecomplete', 'hygieneelite'];

/* ── Public catalog ──────────────────────────────────────────────────── */

router.get('/packages',            ctrl.listPackages);
router.get('/addons',              ctrl.listAddons);
router.get('/subscription-plans',  ctrl.listSubscriptionPlans);

router.post('/quote', [
  body('vehicle_type').isIn(VEHICLE_TYPES),
  body('package_code').isIn(PACKAGE_CODES),
  body('addon_codes').optional().isArray(),
  body('subscription_code').optional({ nullable: true }).isString(),
  validate,
], ctrl.quote);

/* ── Public verify ───────────────────────────────────────────────────── */

router.get('/verify/:qr_token', ctrl.verifyCertificate);

/* ── Customer: Vehicles ──────────────────────────────────────────────── */

router.post('/vehicles', authenticate, [
  body('vehicle_type').isIn(VEHICLE_TYPES),
  body('registration_number').isString().isLength({ min: 4, max: 20 }),
  body('make').optional().isString().isLength({ max: 100 }),
  body('model').optional().isString().isLength({ max: 100 }),
  body('year').optional().isInt({ min: 1980, max: 2100 }),
  body('nickname').optional().isString().isLength({ max: 50 }),
  body('is_primary').optional().isBoolean(),
  validate,
], ctrl.addVehicle);

router.get   ('/vehicles',     authenticate, ctrl.listVehicles);
router.put   ('/vehicles/:id', authenticate, ctrl.updateVehicle);
router.delete('/vehicles/:id', authenticate, ctrl.deleteVehicle);

/* ── Customer: Bookings ──────────────────────────────────────────────── */

router.post('/bookings', authenticate, [
  body('vehicle_id').isUUID(),
  body('package_code').isIn(PACKAGE_CODES),
  body('addon_codes').optional().isArray(),
  body('scheduled_at').isISO8601(),
  body('location_lat').optional().isFloat(),
  body('location_lng').optional().isFloat(),
  body('gated_community').optional().isBoolean(),
  body('subscription_code').optional({ nullable: true }).isString(),
  validate,
], ctrl.createBooking);

router.get('/bookings/history',          authenticate, ctrl.bookingHistory);
router.get('/bookings/:id', authenticate, [
  param('id').isUUID(), validate,
], ctrl.getBookingById);

/* ── Customer: Subscriptions ─────────────────────────────────────────── */

router.post('/subscriptions', authenticate, [
  body('plan_type').isString(),
  body('vehicle_ids').optional().isArray(),
  validate,
], ctrl.createSubscription);

router.get('/subscriptions/active',     authenticate, ctrl.activeSubscription);
router.put('/subscriptions/:id/pause',  authenticate, ctrl.pauseSubscription);
router.put('/subscriptions/:id/cancel', authenticate, ctrl.cancelSubscription);

/* ── Field Team ──────────────────────────────────────────────────────── */

router.get('/jobs/today', authenticate, requireRole('field_team'), ctrl.jobsToday);

router.post('/jobs/:id/pre-inspection', authenticate, requireRole('field_team'), [
  param('id').isUUID(),
  body('photo_urls').isArray({ min: 5 }),
  validate,
], ctrl.preInspection);

router.post('/jobs/:id/steps/:step_no/start', authenticate, requireRole('field_team'), [
  param('id').isUUID(),
  param('step_no').isInt({ min: 1, max: 6 }),
  validate,
], ctrl.startStep);

router.post('/jobs/:id/steps/:step_no/end', authenticate, requireRole('field_team'), [
  param('id').isUUID(),
  param('step_no').isInt({ min: 1, max: 6 }),
  validate,
], ctrl.endStep);

router.post('/jobs/:id/complete', authenticate, requireRole('field_team'), [
  param('id').isUUID(),
  body('water_used_litres').isFloat({ min: 0.1 }),
  body('fogging_duration_min').optional().isInt({ min: 0 }),
  body('ppe_full').optional().isBoolean(),
  body('zero_chemicals').optional().isBoolean(),
  validate,
], ctrl.completeJob);

/* ── Admin ───────────────────────────────────────────────────────────── */

router.get ('/admin/dashboard',         authenticateAdmin, ctrl.adminDashboard);
router.get ('/admin/jobs',              authenticateAdmin, ctrl.adminListJobs);
router.put ('/admin/jobs/:id/assign',   authenticateAdmin, [param('id').isUUID(), validate], ctrl.adminAssignJob);
router.get ('/admin/analytics/addons',  authenticateAdmin, ctrl.adminAddonAnalytics);
router.get ('/admin/ev-units',          authenticateAdmin, ctrl.listEvUnits);

module.exports = router;
