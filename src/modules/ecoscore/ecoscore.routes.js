const express = require('express');
const { body } = require('express-validator');
const EcoScoreController = require('./ecoscore.controller');
const { authenticate, requireRole } = require('../../middleware/auth.middleware');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: EcoScore
 *   description: Per-customer hygiene/loyalty score + admin tuning + leaderboard
 */

// Validation
const calculateValidation = [
  body('job_id')
    .notEmpty().withMessage('Job ID is required')
    .isUUID().withMessage('Job ID must be a valid UUID'),
];

// ── Customer-facing rolling EcoScore ────────────────────────────────────────
router.get('/me', authenticate, EcoScoreController.getMyEcoScore);

// ── Public anonymised customer leaderboard (NEW) ────────────────────────────
router.get('/customer-leaderboard', EcoScoreController.getCustomerLeaderboard);

// ── Admin: tune engine + drill-downs ────────────────────────────────────────
router.get('/admin/weights',     authenticate, requireRole('admin'), EcoScoreController.getWeights);
router.put('/admin/weights',     authenticate, requireRole('admin'), EcoScoreController.updateWeights);
router.post('/admin/recalc-all', authenticate, requireRole('admin'), EcoScoreController.recalcAll);
router.get('/admin/top',         authenticate, requireRole('admin'), EcoScoreController.getTop);
router.get('/admin/bottom',      authenticate, requireRole('admin'), EcoScoreController.getBottom);

// ── Legacy per-job + team leaderboard (kept intact) ─────────────────────────
router.post('/calculate',  authenticate, requireRole('field_team', 'admin'), calculateValidation, EcoScoreController.calculateScore);
router.get('/leaderboard', authenticate, EcoScoreController.getLeaderboard);
router.get('/trends',      authenticate, requireRole('admin'), EcoScoreController.getTrends);

// IMPORTANT: keep this LAST — `/:jobId` is a catch-all that would otherwise
// shadow the named routes above (`/me`, `/customer-leaderboard`, …).
router.get('/:jobId', authenticate, EcoScoreController.getScore);

module.exports = router;
