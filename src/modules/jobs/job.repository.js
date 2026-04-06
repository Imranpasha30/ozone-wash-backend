const db = require('../../config/db');

const JobRepository = {

  create: async (data) => {
    const result = await db.query(
      `INSERT INTO jobs (
        booking_id, customer_id, scheduled_at,
        location_lat, location_lng, job_type, resource_type
      ) VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *`,
      [
        data.booking_id, data.customer_id, data.scheduled_at,
        data.location_lat || null, data.location_lng || null,
        'tank_cleaning', 'tank'
      ]
    );
    return result.rows[0];
  },

  findById: async (id) => {
    const result = await db.query(
      `SELECT j.*,
        c.name as customer_name, c.phone as customer_phone, c.fcm_token as customer_fcm_token,
        t.name as team_name, t.phone as team_phone, t.fcm_token as team_fcm_token,
        b.address, b.tank_type, b.tank_size_litres, b.addons, b.amount_paise
       FROM jobs j
       JOIN users c ON c.id = j.customer_id
       LEFT JOIN users t ON t.id = j.assigned_team_id
       LEFT JOIN bookings b ON b.id = j.booking_id
       WHERE j.id = $1`,
      [id]
    );
    return result.rows[0] || null;
  },

  findByTeam: async (teamId) => {
    const result = await db.query(
      `SELECT j.*,
        c.name as customer_name, c.phone as customer_phone,
        b.address, b.tank_type, b.tank_size_litres
       FROM jobs j
       JOIN users c ON c.id = j.customer_id
       LEFT JOIN bookings b ON b.id = j.booking_id
       WHERE j.assigned_team_id = $1
         AND j.status NOT IN ('cancelled')
       ORDER BY j.scheduled_at ASC`,
      [teamId]
    );
    return result.rows;
  },

  findAll: async ({ status, date, team_id, limit = 20, offset = 0 }) => {
    let query = `SELECT j.*,
        c.name as customer_name, c.phone as customer_phone,
        t.name as team_name,
        b.address, b.tank_type
       FROM jobs j
       JOIN users c ON c.id = j.customer_id
       LEFT JOIN users t ON t.id = j.assigned_team_id
       LEFT JOIN bookings b ON b.id = j.booking_id
       WHERE 1=1`;
    const params = [];
    let i = 1;

    if (status) { query += ` AND j.status = $${i++}`; params.push(status); }
    if (date) { query += ` AND DATE(j.scheduled_at) = $${i++}`; params.push(date); }
    if (team_id) { query += ` AND j.assigned_team_id = $${i++}`; params.push(team_id); }

    query += ` ORDER BY j.scheduled_at ASC LIMIT $${i++} OFFSET $${i++}`;
    params.push(limit, offset);

    const result = await db.query(query, params);
    return result.rows;
  },

  assignTeam: async (jobId, teamId) => {
    const result = await db.query(
      `UPDATE jobs SET
        assigned_team_id = $1,
        updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [teamId, jobId]
    );
    return result.rows[0];
  },

  updateStatus: async (jobId, status) => {
    let query = `UPDATE jobs SET status = $1, updated_at = NOW()`;
    const params = [status, jobId];

    if (status === 'in_progress') {
      query += `, started_at = NOW()`;
    } else if (status === 'completed') {
      query += `, completed_at = NOW()`;
    }

    query += ` WHERE id = $2 RETURNING *`;
    const result = await db.query(query, params);
    return result.rows[0];
  },

  cancelByBookingId: async (bookingId) => {
    await db.query(
      `UPDATE jobs SET status = 'cancelled', updated_at = NOW()
       WHERE booking_id = $1`,
      [bookingId]
    );
  },

  getTeamList: async () => {
    const result = await db.query(
      `SELECT id, name, phone FROM users WHERE role = 'field_team'`
    );
    return result.rows;
  },

  getTodayStats: async (teamId = null) => {
    if (teamId) {
      // Field team stats — scoped to their assigned jobs
      const result = await db.query(
        `SELECT
          COUNT(*) as total_assigned,
          COUNT(*) FILTER (WHERE status = 'scheduled') as pending,
          COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress,
          COUNT(*) FILTER (WHERE status = 'completed' AND DATE(completed_at) = CURRENT_DATE) as completed_today
         FROM jobs
         WHERE assigned_team_id = $1 AND status NOT IN ('cancelled')`,
        [teamId]
      );
      return result.rows[0];
    }
    // Admin stats — global, today-focused
    const result = await db.query(
      `SELECT
        COUNT(*) FILTER (WHERE DATE(scheduled_at) = CURRENT_DATE) as today_total,
        COUNT(*) FILTER (WHERE DATE(scheduled_at) = CURRENT_DATE AND status = 'completed') as today_completed,
        COUNT(*) FILTER (WHERE DATE(scheduled_at) = CURRENT_DATE AND status = 'in_progress') as today_inprogress,
        COUNT(*) FILTER (WHERE DATE(scheduled_at) < CURRENT_DATE AND status NOT IN ('completed','cancelled')) as overdue
       FROM jobs`
    );
    return result.rows[0];
  },

};

module.exports = JobRepository;