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
const db = require('../../config/db');

const router = express.Router();
const adminOnly = [authenticate, requireRole('admin')];

// ── Change a user's role ─────────────────────────────────────────────────
// Lets the admin promote a customer to field_team (or demote back). New
// signups default to 'customer' — this is the only path to make them an
// agent. Admin role itself can't be set here; only via admin-auth.
router.patch('/users/:id/role', adminOnly, async (req, res, next) => {
  try {
    const id = req.params.id;
    const role = (req.body?.role || '').trim();
    if (!['customer', 'field_team'].includes(role)) {
      return sendError(res, 'Invalid role. Must be customer or field_team.', 400);
    }
    // If demoting a field_team to customer, make sure they're not in an
    // active field-team or assigned to in-progress jobs — would break
    // incentive accruals and crew rosters.
    if (role === 'customer') {
      const inTeam = await db.query(
        `SELECT m.team_id FROM field_team_members m
          WHERE m.agent_id = $1 AND m.is_active = TRUE LIMIT 1`,
        [id]
      );
      if (inTeam.rows[0]) {
        return sendError(res, 'Remove the user from their field team before demoting.', 400);
      }
      const activeJobs = await db.query(
        `SELECT id FROM jobs WHERE assigned_team_id = $1
            AND status IN ('scheduled', 'in_progress') LIMIT 1`,
        [id]
      );
      if (activeJobs.rows[0]) {
        return sendError(res, 'User has active jobs assigned. Reassign first.', 400);
      }
    }
    const { rows } = await db.query(
      `UPDATE users SET role = $1 WHERE id = $2 AND role IN ('customer', 'field_team')
       RETURNING id, name, phone, role`,
      [role, id]
    );
    if (!rows[0]) return sendError(res, 'User not found or role cannot be changed.', 404);
    return sendSuccess(res, { user: rows[0] }, `Role updated to ${role}`);
  } catch (err) { next(err); }
});

// ── Top customers leaderboard ────────────────────────────────────────────
// Returns the rank-worthy customers with reason tags. Useful for the admin
// to spot whales / loyal repeats / AMC members at a glance.
router.get('/customers/top', adminOnly, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '10', 10), 30);

    // Aggregate per-customer totals across both tank bookings + auto-wash jobs.
    const { rows } = await db.query(
      `WITH tank AS (
         SELECT customer_id,
                COUNT(*)::int AS bookings,
                COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
                COALESCE(SUM(amount_paise) FILTER (WHERE status NOT IN ('cancelled')), 0)::bigint AS spent
           FROM bookings GROUP BY customer_id
       ), aw AS (
         SELECT customer_id,
                COUNT(*)::int AS bookings,
                COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
                COALESCE(SUM(total_price_paise) FILTER (WHERE status NOT IN ('cancelled')), 0)::bigint AS spent
           FROM jobs WHERE job_type = 'auto_wash' GROUP BY customer_id
       ), agg AS (
         SELECT u.id, u.name, u.phone, u.created_at,
                COALESCE(t.spent, 0) + COALESCE(a.spent, 0) AS lifetime_paise,
                COALESCE(t.bookings, 0) + COALESCE(a.bookings, 0) AS total_bookings,
                COALESCE(t.completed, 0) + COALESCE(a.completed, 0) AS total_completed
           FROM users u
      LEFT JOIN tank t ON t.customer_id = u.id
      LEFT JOIN aw   a ON a.customer_id = u.id
          WHERE u.role = 'customer'
            AND (COALESCE(t.bookings, 0) + COALESCE(a.bookings, 0)) > 0
       )
       SELECT agg.*,
              amc.plan_type as amc_plan,
              amc.status    as amc_status,
              amc.end_date  as amc_end_date
         FROM agg
    LEFT JOIN LATERAL (
           SELECT plan_type, status, end_date FROM amc_contracts
            WHERE customer_id = agg.id ORDER BY (status = 'active') DESC, end_date DESC LIMIT 1
         ) amc ON TRUE
        ORDER BY agg.lifetime_paise DESC, agg.total_completed DESC
        LIMIT $1`,
      [limit]
    );

    // Tag each customer with the reasons they're notable.
    const tagged = rows.map((r) => {
      const tags = [];
      const amcActive = r.amc_status === 'active' && r.amc_end_date && new Date(r.amc_end_date) > new Date();
      if (r.lifetime_paise >= 1000000) tags.push({ label: 'Top spender', color: '#7C3AED' });        // ₹10k+
      else if (r.lifetime_paise >= 500000) tags.push({ label: 'High value', color: '#0EA5E9' });    // ₹5k+
      if (r.total_completed >= 5)        tags.push({ label: 'Repeat', color: '#16A34A' });
      else if (r.total_completed >= 3)   tags.push({ label: 'Returning', color: '#0EA5E9' });
      if (amcActive)                     tags.push({ label: `${r.amc_plan?.toUpperCase()} AMC`, color: '#F59E0B' });
      return { ...r, tags };
    });

    return sendSuccess(res, { top: tagged });
  } catch (err) { next(err); }
});

// ── Customer detail dashboard ─────────────────────────────────────────────
// GET /api/v1/admin/customers/:id/stats — full profile + activity history
// for one customer. Returns everything the admin's drill-in page needs in a
// single round-trip: profile, lifetime totals, type breakdown, AMC status,
// recent bookings, EcoScore tier.
router.get('/customers/:id/stats', adminOnly, async (req, res, next) => {
  try {
    const id = req.params.id;
    const [profile, tankAgg, autoAgg, amc, eco, recent] = await Promise.all([
      db.query(`SELECT id, name, phone, email, lang, role, created_at FROM users WHERE id = $1`, [id]),
      db.query(
        `SELECT COUNT(*)::int AS bookings_count,
                COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
                COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
                COALESCE(SUM(amount_paise) FILTER (WHERE status NOT IN ('cancelled')), 0)::bigint AS spent
           FROM bookings WHERE customer_id = $1`,
        [id]
      ),
      db.query(
        `SELECT COUNT(*)::int AS jobs_count,
                COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
                COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
                COALESCE(SUM(total_price_paise) FILTER (WHERE status NOT IN ('cancelled')), 0)::bigint AS spent
           FROM jobs WHERE customer_id = $1 AND job_type = 'auto_wash'`,
        [id]
      ),
      db.query(
        // amc_contracts has no services_availed/total columns — derive
        // services_used from the jobs table (completed jobs since contract
        // start). services_total is left null (no quota field on contract).
        `SELECT c.id, c.plan_type, c.status, c.start_date, c.end_date,
                (
                  SELECT COUNT(*)::int FROM jobs j
                    JOIN bookings b ON b.id = j.booking_id
                   WHERE b.customer_id = c.customer_id
                     AND j.status = 'completed'
                     AND j.completed_at >= c.start_date
                     AND j.completed_at <= COALESCE(c.end_date, NOW())
                ) AS services_availed,
                NULL::int AS services_total
           FROM amc_contracts c
          WHERE c.customer_id = $1
          ORDER BY (c.status = 'active') DESC, c.end_date DESC
          LIMIT 1`,
        [id]
      ),
      db.query(
        // Eco score lives in eco_scores (current value) — easier than scanning
        // the history table. Falls back gracefully if no row exists.
        `SELECT score, badge, rationale, last_recalc_at AS created_at
           FROM eco_scores
          WHERE user_id = $1
          LIMIT 1`,
        [id]
      ).catch(() => ({ rows: [] })),
      db.query(
        `SELECT 'tank' as kind, id, status, slot_time as scheduled, amount_paise, tank_type as label, created_at
           FROM bookings WHERE customer_id = $1
         UNION ALL
         SELECT 'auto_wash' as kind, id, status, scheduled_at as scheduled, total_price_paise as amount_paise,
                service_package as label, created_at
           FROM jobs WHERE customer_id = $1 AND job_type = 'auto_wash'
         ORDER BY scheduled DESC NULLS LAST
         LIMIT 20`,
        [id]
      ),
    ]);

    const t = tankAgg.rows[0] || {};
    const a = autoAgg.rows[0] || {};

    return sendSuccess(res, {
      profile: profile.rows[0] || null,
      lifetime: {
        total_spent_paise: Number(t.spent || 0) + Number(a.spent || 0),
        total_services: Number(t.completed || 0) + Number(a.completed || 0),
        total_bookings: Number(t.bookings_count || 0) + Number(a.jobs_count || 0),
        cancellations: Number(t.cancelled || 0) + Number(a.cancelled || 0),
      },
      tank: {
        bookings: Number(t.bookings_count || 0),
        completed: Number(t.completed || 0),
        spent_paise: Number(t.spent || 0),
      },
      auto_wash: {
        bookings: Number(a.jobs_count || 0),
        completed: Number(a.completed || 0),
        spent_paise: Number(a.spent || 0),
      },
      amc: amc.rows[0] || null,
      ecoscore: eco.rows[0] || null,
      recent: recent.rows,
    });
  } catch (err) { next(err); }
});

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

/**
 * @swagger
 * /admin/settings/{key}:
 *   get:
 *     summary: Read an app setting (e.g. water_thresholds for BIS gates)
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *   put:
 *     summary: Update an app setting — water-quality thresholds take effect within 60s
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 */
router.get('/settings/:key', adminOnly, async (req, res, next) => {
  try {
    const db = require('../../config/db');
    const { rows } = await db.query(`SELECT key, value, updated_at FROM app_settings WHERE key = $1`, [req.params.key]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Setting not found.' });
    return sendSuccess(res, { setting: rows[0] });
  } catch (err) { next(err); }
});

router.put('/settings/:key', adminOnly, async (req, res, next) => {
  try {
    const db = require('../../config/db');
    if (!req.body || typeof req.body.value !== 'object') {
      return res.status(400).json({ success: false, message: 'Body must be { value: {...} }.' });
    }
    const { rows } = await db.query(
      `INSERT INTO app_settings (key, value, updated_by, updated_at)
       VALUES ($1, $2::jsonb, $3, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_by = $3, updated_at = NOW()
       RETURNING key, value, updated_at`,
      [req.params.key, JSON.stringify(req.body.value), req.user?.phone || req.user?.id || 'admin']
    );
    // Bust the relevant setting caches so changes apply immediately.
    try { require('../field-ops/field-ops.service').invalidateThresholds(); } catch (_) {}
    if (req.params.key === 'scheduling') {
      try { require('../../services/scheduling.service').invalidate(); } catch (_) {}
    }
    return sendSuccess(res, { setting: rows[0] }, 'Setting updated');
  } catch (err) { next(err); }
});

module.exports = router;
