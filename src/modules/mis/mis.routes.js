/**
 * MIS routes — six admin-only dashboards.
 *
 * Mounted at /api/v1/mis (see src/routes/index.js).
 * All endpoints require role=admin.
 */

const express = require('express');
const MisController = require('./mis.controller');
const { authenticate, requireRole } = require('../../middleware/auth.middleware');

const router = express.Router();

const adminOnly = [authenticate, requireRole('admin')];

/**
 * @swagger
 * tags:
 *   name: MIS
 *   description: Admin dashboards aggregating operational, eco, revenue, customer, sales, referrals
 */

/**
 * @swagger
 * /mis/operational:
 *   get:
 *     summary: Operational dashboard — jobs, SLA, compliance gaps
 *     tags: [MIS]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *     responses:
 *       200: { description: Operational metrics }
 *       401: { description: Unauthorized }
 *       403: { description: Admin role required }
 */
router.get('/operational', adminOnly, MisController.operational);

/**
 * @swagger
 * /mis/ecoscore:
 *   get:
 *     summary: EcoScore dashboard — averages, badges, streaks, trends
 *     tags: [MIS]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *     responses:
 *       200: { description: EcoScore metrics }
 */
router.get('/ecoscore', adminOnly, MisController.ecoScore);

/**
 * @swagger
 * /mis/revenue:
 *   get:
 *     summary: Revenue dashboard — per-agent turnover, tiers, incentives
 *     tags: [MIS]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *     responses:
 *       200: { description: Revenue metrics }
 */
router.get('/revenue', adminOnly, MisController.revenue);

/**
 * @swagger
 * /mis/customer-engagement:
 *   get:
 *     summary: Customer engagement — wallet, redemptions, AMC renewals
 *     tags: [MIS]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *     responses:
 *       200: { description: Engagement metrics }
 */
router.get('/customer-engagement', adminOnly, MisController.customerEngagement);

/**
 * @swagger
 * /mis/sales:
 *   get:
 *     summary: Sales dashboard — funnel, segments, growth, cross-sell
 *     tags: [MIS]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *     responses:
 *       200: { description: Sales metrics }
 */
router.get('/sales', adminOnly, MisController.sales);

/**
 * @swagger
 * /mis/referrals:
 *   get:
 *     summary: Referrals dashboard — sources, tiers, ROI uplift
 *     tags: [MIS]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *     responses:
 *       200: { description: Referrals metrics }
 */
router.get('/referrals', adminOnly, MisController.referrals);

module.exports = router;
