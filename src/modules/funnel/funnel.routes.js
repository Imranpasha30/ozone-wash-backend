const express = require('express');
const FunnelService = require('./funnel.service');
const { authenticate, requireRole } = require('../../middleware/auth.middleware');
const { sendSuccess } = require('../../utils/response');
const db = require('../../config/db');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Funnel
 *   description: Booking-abandonment tracking & admin follow-up workflow
 */

// POST /funnel/track — customer reached a booking step (fire-and-forget from app)
router.post('/track', authenticate, async (req, res, next) => {
  try {
    const entry = await FunnelService.track(req.user.id, {
      step: req.body.step,
      draft: req.body.draft,
    });
    sendSuccess(res, { entry });
  } catch (err) { next(err); }
});

// GET /funnel/abandoned — admin list of abandoned checkouts (?status=pending|ongoing|solved)
router.get('/abandoned', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const [leads, stats] = await Promise.all([
      FunnelService.listAbandoned({
        status: req.query.status,
        limit: req.query.limit,
        offset: req.query.offset,
      }),
      FunnelService.stats(),
    ]);
    sendSuccess(res, { leads, stats });
  } catch (err) { next(err); }
});

// PATCH /funnel/:id/status — admin claims/updates a lead { status, note }
router.patch('/:id/status', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    // Record WHICH admin handled it so a second admin doesn't double-contact.
    let adminName = null;
    try {
      const { rows } = await db.query(`SELECT name, phone FROM users WHERE id = $1`, [req.user.id]);
      adminName = rows[0]?.name || rows[0]?.phone || null;
    } catch { /* name is best-effort */ }

    const entry = await FunnelService.updateStatus(req.params.id, {
      status: req.body.status,
      note: req.body.note,
      adminName,
    });
    sendSuccess(res, { entry }, 'Lead updated');
  } catch (err) { next(err); }
});

module.exports = router;
