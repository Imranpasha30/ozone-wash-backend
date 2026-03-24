const express = require('express');
const { body } = require('express-validator');
const JobController = require('./job.controller');
const { authenticate, requireRole } = require('../../middleware/auth.middleware');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Jobs
 *   description: Job management and field team operations
 */

/**
 * @swagger
 * /jobs:
 *   get:
 *     summary: Get all jobs (admin only)
 *     tags: [Jobs]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           example: "scheduled"
 *       - in: query
 *         name: date
 *         schema:
 *           type: string
 *           example: "2026-03-25"
 *       - in: query
 *         name: team_id
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of all jobs
 *
 * /jobs/my:
 *   get:
 *     summary: Get today's jobs for field team
 *     tags: [Jobs]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Today's assigned jobs
 *
 * /jobs/stats:
 *   get:
 *     summary: Get today's job stats (admin dashboard)
 *     tags: [Jobs]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Today's stats
 *
 * /jobs/teams:
 *   get:
 *     summary: Get all field team members (admin)
 *     tags: [Jobs]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of field team members
 *
 * /jobs/{id}:
 *   get:
 *     summary: Get single job details
 *     tags: [Jobs]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Job details
 *       404:
 *         description: Job not found
 *
 * /jobs/{id}/assign:
 *   patch:
 *     summary: Assign field team to job (admin only)
 *     tags: [Jobs]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [team_id]
 *             properties:
 *               team_id:
 *                 type: string
 *                 example: "uuid-of-field-team-member"
 *     responses:
 *       200:
 *         description: Team assigned successfully
 *
 * /jobs/{id}/start:
 *   patch:
 *     summary: Start a job (field team only)
 *     tags: [Jobs]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Job started successfully
 *
 * /jobs/{id}/complete:
 *   patch:
 *     summary: Complete a job (admin or field team)
 *     tags: [Jobs]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Job completed successfully
 */

// Validation
const assignTeamValidation = [
  body('team_id')
    .notEmpty().withMessage('Team ID is required')
    .isUUID().withMessage('Team ID must be a valid UUID'),
];

// Admin routes
router.get('/', authenticate, requireRole('admin'), JobController.getAllJobs);
router.get('/stats', authenticate, requireRole('admin'), JobController.getTodayStats);
router.get('/teams', authenticate, requireRole('admin'), JobController.getTeamList);
router.patch('/:id/assign', authenticate, requireRole('admin'), assignTeamValidation, JobController.assignTeam);
router.patch('/:id/complete', authenticate, requireRole('admin', 'field_team'), JobController.completeJob);

// Field team routes
router.get('/my', authenticate, requireRole('field_team'), JobController.getMyJobs);
router.patch('/:id/start', authenticate, requireRole('field_team'), JobController.startJob);

// Shared routes (customer, field team, admin)
router.get('/:id', authenticate, JobController.getJob);

module.exports = router;