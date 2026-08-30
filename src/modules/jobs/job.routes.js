const express = require('express');
const { body, query } = require('express-validator');
const JobController = require('./job.controller');
const { authenticate, requireRole } = require('../../middleware/auth.middleware');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Jobs
 *   description: Job management and field team operations
 */

// ── Validation rules ──────────────────────────────────────────────────────────

// Assign accepts EITHER a field_team_id (whole crew — preferred) OR the legacy
// single-agent team_id. At least one must be a valid UUID.
const assignTeamValidation = [
  body('team_id')
    .optional({ nullable: true })
    .isUUID().withMessage('team_id must be a valid UUID'),
  body('field_team_id')
    .optional({ nullable: true })
    .isUUID().withMessage('field_team_id must be a valid UUID'),
  body().custom((_, { req }) => {
    if (!req.body?.team_id && !req.body?.field_team_id) {
      throw new Error('team_id or field_team_id is required');
    }
    return true;
  }),
];

const transferValidation = [
  body('new_team_id')
    .notEmpty().withMessage('New team ID is required')
    .isUUID().withMessage('New team ID must be a valid UUID'),
  body('reason')
    .optional()
    .trim()
    .isLength({ max: 500 }).withMessage('Reason must be under 500 characters'),
];

const otpValidation = [
  body('otp')
    .notEmpty().withMessage('OTP is required')
    .isLength({ min: 6, max: 6 }).withMessage('OTP must be 6 digits')
    .isNumeric().withMessage('OTP must be numeric'),
];

// Query param validation for admin GET /jobs
const listJobsValidation = [
  query('status')
    .optional()
    .isIn(['scheduled', 'in_progress', 'completed', 'cancelled']).withMessage('Invalid status filter'),
  query('date')
    .optional()
    .isDate({ format: 'YYYY-MM-DD' }).withMessage('Date must be YYYY-MM-DD'),
  query('team_id')
    .optional()
    .isUUID().withMessage('team_id must be a valid UUID'),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 }).withMessage('Limit must be 1–100'),
  query('offset')
    .optional()
    .isInt({ min: 0 }).withMessage('Offset must be >= 0'),
];

// ── Routes ────────────────────────────────────────────────────────────────────

// Admin routes
router.get('/', authenticate, requireRole('admin'), listJobsValidation, JobController.getAllJobs);
router.get('/stats', authenticate, requireRole('admin', 'field_team'), JobController.getTodayStats);
router.get('/teams', authenticate, requireRole('admin'), JobController.getTeamList);
router.patch('/:id/assign', authenticate, requireRole('admin'), assignTeamValidation, JobController.assignTeam);
router.patch('/:id/complete', authenticate, requireRole('admin', 'field_team'), JobController.completeJob);

// Job requests (field team requests, admin manages)
router.get('/available', authenticate, requireRole('field_team'), JobController.getAvailableJobs);
router.post('/:id/request', authenticate, requireRole('field_team'), JobController.requestJob);
// Field team — see own requests (any status). MUST come before /requests
// (admin-only) so the more specific path wins.
router.get('/my-requests', authenticate, requireRole('field_team'), JobController.getMyJobRequests);
router.get('/requests', authenticate, requireRole('admin'), JobController.getJobRequests);
router.get('/requests/count', authenticate, requireRole('admin'), JobController.getPendingRequestCount);
router.patch('/requests/:requestId/approve', authenticate, requireRole('admin'), JobController.approveJobRequest);
router.patch('/requests/:requestId/reject', authenticate, requireRole('admin'), JobController.rejectJobRequest);

// Field team routes
router.get('/my', authenticate, requireRole('field_team'), JobController.getMyJobs);
router.get('/route-optimize', authenticate, requireRole('field_team'), JobController.optimizeRoute);
router.patch('/:id/start', authenticate, requireRole('field_team'), JobController.startJob);
router.patch('/:id/en-route', authenticate, requireRole('field_team'), JobController.markEnRoute);

// OTP routes (field team)
router.post('/:id/generate-start-otp', authenticate, requireRole('field_team'), JobController.generateStartOtp);
router.post('/:id/verify-start-otp', authenticate, requireRole('field_team'), otpValidation, JobController.verifyStartOtp);
router.post('/:id/generate-end-otp', authenticate, requireRole('field_team'), JobController.generateEndOtp);
router.post('/:id/verify-end-otp', authenticate, requireRole('field_team'), otpValidation, JobController.verifyEndOtp);

// Customer OTP request
router.post('/:id/customer-request-otp', authenticate, requireRole('customer'), JobController.customerRequestStartOtp);
// Customer in-app alert banners (OTP requested / crew departed).
// NOTE: must stay above the catch-all GET /:id route.
router.get('/customer-alerts', authenticate, requireRole('customer'), JobController.customerAlerts);

// Transfer (field team or admin)
router.post('/:id/transfer', authenticate, requireRole('field_team', 'admin'), transferValidation, JobController.transferJob);

// Conflict detection & concerns
router.get('/conflict-check', authenticate, requireRole('admin', 'field_team'), JobController.checkConflict);
router.post('/:id/raise-concern', authenticate, requireRole('field_team'), JobController.raiseConcern);
router.get('/concerns', authenticate, requireRole('admin'), JobController.getConcerns);
router.patch('/:id/resolve-concern', authenticate, requireRole('admin'), JobController.resolveConcern);

// Shared (customer, field team, admin)
router.get('/:id', authenticate, JobController.getJob);

module.exports = router;
