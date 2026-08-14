/**
 * Booking funnel — tracks how far each customer got in the booking flow so
 * the admin team can follow up on abandoned checkouts ("came to step 2 and
 * left"). One OPEN row per customer; creating a booking marks it converted.
 *
 * Admin workflow per lead: pending → ongoing → solved. `handled_by` records
 * which admin picked it up so two admins never chase the same customer.
 */
const db = require('../../config/db');

const STEP_NAMES = {
  1: 'Tank details',
  2: 'Date & time',
  3: 'Add-ons',
  4: 'Payment',
};

const FunnelService = {

  /** Customer reached a step — upsert their open funnel row. */
  track: async (customerId, { step, draft }) => {
    const s = Math.min(4, Math.max(1, Math.floor(Number(step) || 1)));
    const stepName = STEP_NAMES[s];
    const { rows } = await db.query(
      `INSERT INTO booking_funnel (customer_id, step_reached, step_name, draft, last_activity_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (customer_id) WHERE (converted = false)
       DO UPDATE SET
         step_reached     = GREATEST(booking_funnel.step_reached, EXCLUDED.step_reached),
         step_name        = CASE WHEN EXCLUDED.step_reached >= booking_funnel.step_reached
                                 THEN EXCLUDED.step_name ELSE booking_funnel.step_name END,
         draft            = EXCLUDED.draft,
         last_activity_at = NOW(),
         updated_at       = NOW()
       RETURNING id, step_reached, step_name`,
      [customerId, s, stepName, JSON.stringify(draft || {})]
    );
    return rows[0];
  },

  /** Booking created — close the customer's open funnel row. */
  markConverted: async (customerId, bookingId) => {
    try {
      await db.query(
        `UPDATE booking_funnel
            SET converted = true, converted_booking_id = $2,
                status = 'solved', updated_at = NOW()
          WHERE customer_id = $1 AND converted = false`,
        [customerId, bookingId]
      );
    } catch (e) {
      console.warn('[funnel] markConverted failed:', e?.message);
    }
  },

  /**
   * Admin list — abandoned checkouts (open rows with no booking), newest
   * activity first. `status` filter optional. Rows idle < 15 min are still
   * shown but flagged in_session so admins don't call someone mid-booking.
   */
  listAbandoned: async ({ status, limit = 50, offset = 0 } = {}) => {
    let q = `
      SELECT f.id, f.customer_id, f.step_reached, f.step_name, f.draft,
             f.status, f.handled_by, f.admin_note,
             f.last_activity_at, f.created_at, f.updated_at,
             u.name AS customer_name, u.phone AS customer_phone,
             (f.last_activity_at > NOW() - INTERVAL '15 minutes') AS in_session
        FROM booking_funnel f
        JOIN users u ON u.id = f.customer_id
       WHERE f.converted = false`;
    const params = [];
    let i = 1;
    if (status) { q += ` AND f.status = $${i++}`; params.push(status); }
    q += ` ORDER BY f.last_activity_at DESC LIMIT $${i++} OFFSET $${i++}`;
    params.push(Math.min(200, Number(limit) || 50), Number(offset) || 0);

    const { rows } = await db.query(q, params);
    return rows;
  },

  /** Admin updates a lead's status (pending | ongoing | solved) + claims it. */
  updateStatus: async (funnelId, { status, note, adminName }) => {
    if (!['pending', 'ongoing', 'solved'].includes(status)) {
      throw { status: 400, message: 'Status must be pending, ongoing or solved.' };
    }
    const { rows } = await db.query(
      `UPDATE booking_funnel
          SET status = $1,
              handled_by = COALESCE($2, handled_by),
              admin_note = COALESCE($3, admin_note),
              updated_at = NOW()
        WHERE id = $4
        RETURNING id, status, handled_by, admin_note, updated_at`,
      [status, adminName || null, note ?? null, funnelId]
    );
    if (!rows.length) throw { status: 404, message: 'Funnel entry not found.' };
    return rows[0];
  },

  /** Funnel stats for the admin dashboard tile. */
  stats: async () => {
    const { rows } = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')  ::int AS pending,
         COUNT(*) FILTER (WHERE status = 'ongoing')  ::int AS ongoing,
         COUNT(*) FILTER (WHERE status = 'solved')   ::int AS solved,
         COUNT(*)                                     ::int AS total
        FROM booking_funnel
       WHERE converted = false`
    );
    return rows[0];
  },

};

module.exports = FunnelService;
