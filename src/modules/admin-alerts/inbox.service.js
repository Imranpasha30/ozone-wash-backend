/**
 * Admin Inbox — unified feed of every actionable item:
 *
 *   - alerts        (admin_alerts, unacknowledged) — slot conflicts,
 *                   no-team-available, technician overcommit
 *   - requests      (job_requests, pending) — field team asked to take a job;
 *                   waiting for admin approve/reject
 *   - unassigned    (jobs, status='scheduled' AND assigned_team_id IS NULL)
 *                   — bookings landed in the pipeline but no crew on it yet
 *
 * One endpoint, one poll, the admin sees everything that needs them.
 */
const db = require('../../config/db');

const InboxService = {
  getInbox: async () => {
    const [alertsRes, requestsRes, unassignedRes] = await Promise.all([
      db.query(
        `SELECT id, type, severity, title, message, related_booking_id, related_job_id, related_team_id, created_at
           FROM admin_alerts
          WHERE acknowledged = FALSE
          ORDER BY created_at DESC
          LIMIT 50`
      ),
      db.query(
        // Pending job requests, joined to the requester's current field team
        // (if any) so the admin can see "Team Alpha (via Ramesh)" instead of
        // just the agent name. ftm filter uses LATERAL so we only get the
        // active-team row per agent.
        `SELECT jr.id as request_id, jr.created_at as requested_at,
                j.id as job_id, j.scheduled_at, j.job_type,
                u.name as team_name, u.phone as team_phone,
                c.name as customer_name,
                b.tank_type, b.tank_size_litres, b.address,
                ft.id   as field_team_id,
                ft.name as field_team_name
           FROM job_requests jr
           JOIN jobs j ON j.id = jr.job_id
           JOIN users u ON u.id = jr.team_id
           JOIN users c ON c.id = j.customer_id
      LEFT JOIN bookings b ON b.id = j.booking_id
      LEFT JOIN LATERAL (
              SELECT t.id, t.name
                FROM field_team_members m
                JOIN field_teams t ON t.id = m.team_id
               WHERE m.agent_id = jr.team_id
                 AND m.is_active = TRUE
                 AND t.is_active = TRUE
               LIMIT 1
           ) ft ON TRUE
          WHERE jr.status = 'pending'
          ORDER BY jr.created_at DESC
          LIMIT 50`
      ),
      db.query(
        `SELECT j.id as job_id, j.scheduled_at, j.job_type,
                j.booking_id, j.created_at,
                c.name as customer_name, c.phone as customer_phone,
                b.tank_type, b.tank_size_litres, b.address,
                v.vehicle_type, v.registration_number
           FROM jobs j
           JOIN users c ON c.id = j.customer_id
      LEFT JOIN bookings b ON b.id = j.booking_id
      LEFT JOIN vehicles v ON v.id = j.vehicle_id
          WHERE j.status = 'scheduled'
            AND j.assigned_team_id IS NULL
          ORDER BY j.scheduled_at ASC
          LIMIT 50`
      ),
    ]);

    return {
      alerts: alertsRes.rows,
      requests: requestsRes.rows,
      unassigned: unassignedRes.rows,
      total: alertsRes.rows.length + requestsRes.rows.length + unassignedRes.rows.length,
    };
  },
};

module.exports = InboxService;
