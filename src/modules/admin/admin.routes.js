/**
 * Admin routes — currently exposes the pricing manager endpoints.
 * Mounted at /api/v1/admin (see src/routes/index.js).
 *
 * All endpoints require role=admin.
 */

const express = require('express');
const PricingService = require('../../services/pricing');
const { authenticate, requireRole } = require('../../middleware/auth.middleware');
const { sendSuccess, sendError } = require('../../utils/response');
const { adminRouter: incentiveAdminRouter } = require('../incentives/routes');

const router = express.Router();
const adminOnly = [authenticate, requireRole('admin')];

// ── Incentive payout management (mounted at /api/v1/admin/incentives) ──────
router.use('/incentives', incentiveAdminRouter);

/**
 * @swagger
 * tags:
 *   name: Admin
 *   description: Admin-only management endpoints (pricing, etc.)
 */

/**
 * @swagger
 * /admin/pricing:
 *   get:
 *     summary: Get the full pricing matrix (admin only)
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: tiers + matrix rows }
 *       401: { description: Unauthorized }
 *       403: { description: Admin role required }
 */
router.get('/pricing', adminOnly, async (req, res, next) => {
  try {
    const [tiers, matrix] = await Promise.all([
      PricingService.listTiers(),
      PricingService.listMatrix({ active: req.query.active !== 'false' }),
    ]);
    return sendSuccess(res, { tiers, matrix });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /admin/pricing/{matrixId}:
 *   put:
 *     summary: Update a pricing-matrix row (admin only)
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: matrixId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               single_tank_paise:    { type: integer }
 *               per_tank_2_paise:     { type: integer }
 *               per_tank_2plus_paise: { type: integer }
 *               notes:                { type: string }
 *               active:               { type: boolean }
 *     responses:
 *       200: { description: Updated row }
 */
router.put('/pricing/:matrixId', adminOnly, async (req, res, next) => {
  try {
    const updated = await PricingService.updateMatrixRow(req.params.matrixId, req.body || {});
    return sendSuccess(res, { row: updated }, 'Pricing row updated');
  } catch (err) {
    if (err && err.status) return sendError(res, err.message, err.status);
    next(err);
  }
});

/**
 * @swagger
 * /admin/pricing/freeze:
 *   post:
 *     summary: Snapshot active pricing & schedule a copy for tomorrow
 *     description: |
 *       Copies the currently-active rows (effective_from <= today) and inserts
 *       them with effective_from = tomorrow so changes can be audited and
 *       reverted. Idempotent for the same day.
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: How many rows were inserted }
 */
router.post('/pricing/freeze', adminOnly, async (req, res, next) => {
  try {
    const result = await PricingService.freezeAndScheduleNew();
    return sendSuccess(res, result, `Inserted ${result.inserted_count} rows for tomorrow.`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
