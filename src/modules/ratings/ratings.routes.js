/**
 * Ratings — minimal route to record a customer's 1..5 star rating + comment
 * for a completed job. Recording a rating triggers an EcoScore recalc.
 *
 * Schema lives in 005_mis_supporting_tables.sql:
 *   ratings(id, job_id UNIQUE, customer_id, agent_id, rating 1..5, comment, created_at)
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticate } = require('../../middleware/auth.middleware');
const { sendSuccess, sendError } = require('../../utils/response');
const db = require('../../config/db');
const EcoScoreService = require('../ecoscore/ecoscore.service');

const router = express.Router();

const validation = [
  body('job_id').notEmpty().isUUID().withMessage('job_id must be a UUID'),
  body('rating').isInt({ min: 1, max: 5 }).withMessage('rating must be 1..5'),
  body('comment').optional().isString().isLength({ max: 1000 }),
];

// POST /api/v1/ratings
router.post('/', authenticate, validation, async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendError(res, 'Validation failed', 400, errors.array());
    }
    const { job_id, rating, comment } = req.body;

    // Make sure the job belongs to this customer
    const { rows: jobRows } = await db.query(
      `SELECT id, customer_id, assigned_team_id, status FROM jobs WHERE id = $1`,
      [job_id]
    );
    const job = jobRows[0];
    if (!job) return sendError(res, 'Job not found.', 404);
    if (job.customer_id !== req.user.id) {
      return sendError(res, 'You can only rate your own jobs.', 403);
    }
    if (job.status !== 'completed') {
      return sendError(res, 'You can only rate completed jobs.', 400);
    }

    const { rows } = await db.query(
      `INSERT INTO ratings (job_id, customer_id, agent_id, rating, comment)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (job_id) DO UPDATE SET
         rating = EXCLUDED.rating,
         comment = EXCLUDED.comment
       RETURNING *`,
      [job_id, req.user.id, job.assigned_team_id, rating, comment || null]
    );

    // EcoScore: recalc on rating received (fire-and-forget — never block)
    EcoScoreService.recalcOnEvent({
      event: 'rating_received',
      user_id: req.user.id,
      ref: job_id,
    }).catch(() => {});

    return sendSuccess(res, { rating: rows[0] }, 'Rating recorded.');
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/ratings/job/:jobId — return the rating for a job (if any)
router.get('/job/:jobId', authenticate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM ratings WHERE job_id = $1`,
      [req.params.jobId]
    );
    return sendSuccess(res, { rating: rows[0] || null });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
