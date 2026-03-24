const express = require('express');
const { body } = require('express-validator');
const EcoScoreController = require('./ecoscore.controller');
const { authenticate, requireRole } = require('../../middleware/auth.middleware');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: EcoScore
 *   description: Environmental score calculation and leaderboard
 */

/**
 * @swagger
 * /ecoscore/calculate:
 *   post:
 *     summary: Calculate EcoScore for a completed job
 *     tags: [EcoScore]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [job_id]
 *             properties:
 *               job_id:
 *                 type: string
 *                 example: "d858bb65-e918-4bea-93eb-9d4a38ba3d3f"
 *     responses:
 *       200:
 *         description: EcoScore calculated with breakdown
 *       400:
 *         description: Not all steps complete
 *
 * /ecoscore/leaderboard:
 *   get:
 *     summary: Get team EcoScore leaderboard
 *     tags: [EcoScore]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Team leaderboard with avg scores and badges
 *
 * /ecoscore/trends:
 *   get:
 *     summary: Get monthly EcoScore trends (admin)
 *     tags: [EcoScore]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Monthly trends for dashboard
 *
 * /ecoscore/{jobId}:
 *   get:
 *     summary: Get EcoScore for a specific job
 *     tags: [EcoScore]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: EcoScore details
 *       404:
 *         description: Score not calculated yet
 */

// Validation
const calculateValidation = [
  body('job_id')
    .notEmpty().withMessage('Job ID is required')
    .isUUID().withMessage('Job ID must be a valid UUID'),
];

// Routes
router.post('/calculate', authenticate, requireRole('field_team', 'admin'), calculateValidation, EcoScoreController.calculateScore);
router.get('/leaderboard', authenticate, EcoScoreController.getLeaderboard);
router.get('/trends', authenticate, requireRole('admin'), EcoScoreController.getTrends);
router.get('/:jobId', authenticate, EcoScoreController.getScore);

module.exports = router;