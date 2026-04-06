const express = require('express');
const { body, query } = require('express-validator');
const IncidentController = require('./incident.controller');
const { authenticate, requireRole } = require('../../middleware/auth.middleware');

const router = express.Router();

// ── Validation rules ──────────────────────────────────────────────────────────

const createValidation = [
  body('job_id')
    .notEmpty().withMessage('Job ID is required')
    .isUUID().withMessage('Job ID must be a valid UUID'),
  body('description')
    .trim()
    .notEmpty().withMessage('Description is required')
    .isLength({ min: 10, max: 2000 }).withMessage('Description must be 10–2000 characters'),
  body('severity')
    .optional()
    .isIn(['low', 'medium', 'high', 'critical']).withMessage('Invalid severity'),
  body('photo_url')
    .optional()
    .isURL().withMessage('Photo URL must be a valid URL'),
  body('audio_url')
    .optional()
    .isURL().withMessage('Audio URL must be a valid URL'),
];

const listValidation = [
  query('status')
    .optional()
    .isIn(['open', 'resolved', 'escalated']).withMessage('Invalid status filter'),
  query('severity')
    .optional()
    .isIn(['low', 'medium', 'high', 'critical']).withMessage('Invalid severity filter'),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 }).withMessage('Limit must be 1–100'),
  query('offset')
    .optional()
    .isInt({ min: 0 }).withMessage('Offset must be >= 0'),
];

// ── Routes ────────────────────────────────────────────────────────────────────

// Field team creates incidents
router.post('/', authenticate, requireRole('field_team'), createValidation, IncidentController.create);

// Get incidents for a specific job (any authenticated user)
router.get('/job/:jobId', authenticate, IncidentController.getByJobId);

// Admin: list all incidents
router.get('/', authenticate, requireRole('admin'), listValidation, IncidentController.getAll);

// Get single incident
router.get('/:id', authenticate, IncidentController.getById);

// Admin actions
router.patch('/:id/resolve', authenticate, requireRole('admin'), IncidentController.resolve);
router.patch('/:id/escalate', authenticate, requireRole('admin'), IncidentController.escalate);

module.exports = router;
