/**
 * Repository for the admin_alerts table.
 * Migration: 016_admin_alerts.sql
 */
const db = require('../../config/db');

const AdminAlertsRepository = {
  create: async ({
    type, severity = 'warning', title, message,
    related_booking_id = null, related_job_id = null, related_team_id = null,
    metadata = {},
  }) => {
    const { rows } = await db.query(
      `INSERT INTO admin_alerts (
         type, severity, title, message,
         related_booking_id, related_job_id, related_team_id, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       RETURNING *`,
      [type, severity, title, message, related_booking_id, related_job_id, related_team_id, JSON.stringify(metadata)]
    );
    return rows[0];
  },

  // Most-recent first. If unack=true, only unacknowledged alerts.
  list: async ({ unackOnly = false, limit = 50 } = {}) => {
    const where = unackOnly ? 'WHERE acknowledged = FALSE' : '';
    const { rows } = await db.query(
      `SELECT * FROM admin_alerts ${where}
        ORDER BY (NOT acknowledged) DESC, created_at DESC
        LIMIT $1`,
      [limit]
    );
    return rows;
  },

  countUnack: async () => {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS count FROM admin_alerts WHERE acknowledged = FALSE`
    );
    return rows[0]?.count || 0;
  },

  acknowledge: async (id, adminId) => {
    const { rows } = await db.query(
      `UPDATE admin_alerts
          SET acknowledged = TRUE,
              acknowledged_by = $2,
              acknowledged_at = NOW()
        WHERE id = $1 AND acknowledged = FALSE
        RETURNING *`,
      [id, adminId]
    );
    return rows[0] || null;
  },

  // De-dupe: if there's an unacknowledged alert of the same type for the same
  // booking/job/team within the last 24 h, skip re-creating it. Prevents spam
  // when the conflict detector fires repeatedly for the same slot.
  findRecentDuplicate: async ({ type, related_booking_id, related_job_id, related_team_id }) => {
    const { rows } = await db.query(
      `SELECT id FROM admin_alerts
        WHERE type = $1
          AND acknowledged = FALSE
          AND created_at > NOW() - INTERVAL '24 hours'
          AND COALESCE(related_booking_id::text, '') = COALESCE($2::text, '')
          AND COALESCE(related_job_id::text, '')     = COALESCE($3::text, '')
          AND COALESCE(related_team_id::text, '')    = COALESCE($4::text, '')
        LIMIT 1`,
      [type, related_booking_id, related_job_id, related_team_id]
    );
    return rows[0] || null;
  },
};

module.exports = AdminAlertsRepository;
