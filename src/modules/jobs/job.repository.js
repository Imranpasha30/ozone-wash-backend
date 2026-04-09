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
      `SELECT j.*, j.end_otp_satisfied, j.end_otp_unsatisfied, j.customer_satisfied,
        c.name as customer_name, c.phone as customer_phone, c.fcm_token as customer_fcm_token,
        t.name as team_name, t.phone as team_phone, t.fcm_token as team_fcm_token,
        b.address, b.tank_type, b.tank_size_litres, b.addons, b.amount_paise,
        b.amc_plan, b.property_type, b.contact_name, b.contact_phone
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
        b.address, b.tank_type, b.tank_size_litres, b.amount_paise
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

  // ── OTP Methods ──────────────────────────────────────────────────────────

  storeStartOtp: async (jobId, otp) => {
    const result = await db.query(
      `UPDATE jobs SET start_otp = $1, start_otp_verified = false, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [otp, jobId]
    );
    return result.rows[0];
  },

  storeEndOtp: async (jobId, satisfiedOtp, unsatisfiedOtp) => {
    const result = await db.query(
      `UPDATE jobs SET
        end_otp_satisfied = $1, end_otp_unsatisfied = $2,
        end_otp = $1, end_otp_verified = false,
        customer_satisfied = NULL, updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [satisfiedOtp, unsatisfiedOtp, jobId]
    );
    return result.rows[0];
  },

  verifyStartOtp: async (jobId) => {
    const result = await db.query(
      `UPDATE jobs SET start_otp_verified = true, status = 'in_progress', started_at = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [jobId]
    );
    return result.rows[0];
  },

  verifyEndOtp: async (jobId, satisfied) => {
    const result = await db.query(
      `UPDATE jobs SET end_otp_verified = true, customer_satisfied = $1, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [satisfied, jobId]
    );
    return result.rows[0];
  },

  // ── Transfer ────────────────────────────────────────────────────────────

  transferJob: async (jobId, newTeamId, reason) => {
    const result = await db.query(
      `UPDATE jobs SET assigned_team_id = $1, notes = COALESCE(notes, '') || $2, updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [newTeamId, `\n[Transfer] Reason: ${reason}`, jobId]
    );
    return result.rows[0];
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
      const [statsRes, streakRes] = await Promise.all([
        db.query(
          `SELECT
            COUNT(*) as total_assigned,
            COUNT(*) FILTER (WHERE status = 'scheduled') as pending,
            COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress,
            COUNT(*) FILTER (WHERE status = 'completed' AND DATE(completed_at) = CURRENT_DATE) as completed_today,
            COUNT(*) FILTER (WHERE status = 'completed' AND DATE(completed_at) >= CURRENT_DATE - INTERVAL '7 days') as completed_this_week,
            COUNT(*) FILTER (WHERE status = 'completed' AND DATE(completed_at) >= DATE_TRUNC('month', CURRENT_DATE)) as completed_this_month
           FROM jobs
           WHERE assigned_team_id = $1 AND status NOT IN ('cancelled')`,
          [teamId]
        ),
        // Streak: count consecutive days with at least 1 completed job (going back from today)
        db.query(
          `WITH daily AS (
            SELECT DATE(completed_at) as day
            FROM jobs
            WHERE assigned_team_id = $1 AND status = 'completed' AND completed_at IS NOT NULL
            GROUP BY DATE(completed_at)
            ORDER BY day DESC
          ),
          numbered AS (
            SELECT day, ROW_NUMBER() OVER (ORDER BY day DESC) as rn
            FROM daily
          )
          SELECT COUNT(*) as streak_days
          FROM numbered
          WHERE day = CURRENT_DATE - (rn - 1) * INTERVAL '1 day'`,
          [teamId]
        ),
      ]);
      return {
        ...statsRes.rows[0],
        streak_days: parseInt(streakRes.rows[0]?.streak_days || '0'),
      };
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

  // ── Available Jobs (unassigned, for field team to browse) ─────────────

  findAvailable: async () => {
    const result = await db.query(
      `SELECT j.*,
        c.name as customer_name, c.phone as customer_phone,
        b.address, b.tank_type, b.tank_size_litres, b.addons
       FROM jobs j
       JOIN users c ON c.id = j.customer_id
       LEFT JOIN bookings b ON b.id = j.booking_id
       WHERE j.assigned_team_id IS NULL
         AND j.status = 'scheduled'
       ORDER BY j.scheduled_at ASC`
    );
    return result.rows;
  },

  // ── Job Requests ────────────────────────────────────────────────────

  createRequest: async (jobId, teamId) => {
    const result = await db.query(
      `INSERT INTO job_requests (job_id, team_id, status)
       VALUES ($1, $2, 'pending')
       RETURNING *`,
      [jobId, teamId]
    );
    return result.rows[0];
  },

  findRequestByJobAndTeam: async (jobId, teamId) => {
    const result = await db.query(
      `SELECT * FROM job_requests
       WHERE job_id = $1 AND team_id = $2 AND status = 'pending'`,
      [jobId, teamId]
    );
    return result.rows[0] || null;
  },

  findRequests: async ({ status, limit = 20, offset = 0 }) => {
    let query = `SELECT jr.*,
      j.scheduled_at, j.status as job_status,
      u.name as team_name, u.phone as team_phone,
      c.name as customer_name, c.phone as customer_phone,
      b.tank_type, b.tank_size_litres, b.address
     FROM job_requests jr
     JOIN jobs j ON j.id = jr.job_id
     JOIN users u ON u.id = jr.team_id
     JOIN users c ON c.id = j.customer_id
     LEFT JOIN bookings b ON b.id = j.booking_id
     WHERE 1=1`;
    const params = [];
    let i = 1;
    if (status) { query += ` AND jr.status = $${i++}`; params.push(status); }
    query += ` ORDER BY jr.created_at DESC LIMIT $${i++} OFFSET $${i++}`;
    params.push(limit, offset);
    const result = await db.query(query, params);
    return result.rows;
  },

  findRequestById: async (id) => {
    const result = await db.query(
      `SELECT jr.*,
        j.assigned_team_id, j.status as job_status,
        u.name as team_name, u.phone as team_phone, u.fcm_token as team_fcm_token
       FROM job_requests jr
       JOIN jobs j ON j.id = jr.job_id
       JOIN users u ON u.id = jr.team_id
       WHERE jr.id = $1`,
      [id]
    );
    return result.rows[0] || null;
  },

  updateRequestStatus: async (id, status) => {
    const result = await db.query(
      `UPDATE job_requests SET status = $1, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [status, id]
    );
    return result.rows[0];
  },

  rejectOtherRequests: async (jobId, approvedTeamId) => {
    await db.query(
      `UPDATE job_requests SET status = 'rejected', updated_at = NOW()
       WHERE job_id = $1 AND team_id != $2 AND status = 'pending'`,
      [jobId, approvedTeamId]
    );
  },

  countPendingRequests: async () => {
    const result = await db.query(
      `SELECT COUNT(*) as count FROM job_requests WHERE status = 'pending'`
    );
    return parseInt(result.rows[0].count) || 0;
  },

};

module.exports = JobRepository;