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

const assignTeamValidation = [
  body('team_id')
    .notEmpty().withMessage('Team ID is required')
    .isUUID().withMessage('Team ID must be a valid UUID'),
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
router.get('/stats', authenticate, requireRole('admin'), JobController.getTodayStats);
router.get('/teams', authenticate, requireRole('admin'), JobController.getTeamList);
router.patch('/:id/assign', authenticate, requireRole('admin'), assignTeamValidation, JobController.assignTeam);
router.patch('/:id/complete', authenticate, requireRole('admin', 'field_team'), JobController.completeJob);

// Field team routes
router.get('/my', authenticate, requireRole('field_team'), JobController.getMyJobs);
router.patch('/:id/start', authenticate, requireRole('field_team'), JobController.startJob);

// Shared (customer, field team, admin)
router.get('/:id', authenticate, JobController.getJob);

module.exports = router;
