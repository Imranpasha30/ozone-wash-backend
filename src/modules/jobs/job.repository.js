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
        b.address, b.lat AS booking_lat, b.lng AS booking_lng,
        b.tank_type, b.tank_size_litres, b.addons, b.amount_paise,
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
    // Returns BOTH tank-cleaning and auto-wash jobs that this agent will work.
    // Includes jobs assigned to them as an individual (legacy single-agent
    // path) AND jobs assigned to any field team they're currently an active
    // member of — so every team member sees the same job list.
    const result = await db.query(
      `SELECT j.*,
        c.name as customer_name, c.phone as customer_phone,
        b.address as b_address, b.tank_type, b.tank_size_litres,
        v.vehicle_type, v.registration_number, v.nickname as vehicle_nickname,
        v.make as vehicle_make, v.model as vehicle_model,
        COALESCE(b.address, '(see customer)') as address,
        ft.name as field_team_name
       FROM jobs j
       JOIN users c ON c.id = j.customer_id
       LEFT JOIN bookings b ON b.id = j.booking_id
       LEFT JOIN vehicles v ON v.id = j.vehicle_id
       LEFT JOIN field_teams ft ON ft.id = j.assigned_field_team_id
       WHERE j.status NOT IN ('cancelled')
         AND (
           j.assigned_team_id = $1
           OR j.assigned_field_team_id IN (
             SELECT team_id FROM field_team_members
              WHERE agent_id = $1 AND is_active = TRUE
           )
         )
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

  // Team-based assignment. `fieldTeamId` is the field_teams.id (the whole
  // crew); `leadAgentId` is the agent who requested or the team leader —
  // stored in the legacy assigned_team_id column so older queries still
  // return the job. Every active member of the team will see this job
  // via findMyJobs (which now also unions through field_team_members).
  assignToFieldTeam: async (jobId, fieldTeamId, leadAgentId) => {
    const result = await db.query(
      `UPDATE jobs SET
        assigned_field_team_id = $1,
        assigned_team_id       = $2,
        updated_at             = NOW()
       WHERE id = $3 RETURNING *`,
      [fieldTeamId, leadAgentId || null, jobId]
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
        end_otp_verified = false,
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

  // Live in-app alerts for a customer's active jobs (OTP requested / crew
  // departed). Drives the tappable banners on the customer home screen.
  customerAlerts: async (customerId) => {
    const result = await db.query(
      `SELECT j.id AS job_id, j.booking_id, j.scheduled_at, j.job_type,
              j.start_otp, j.start_otp_verified, j.departure_time, j.status,
              b.tank_type AS b_tank_type, b.tank_size_litres AS b_litres,
              b.tanks AS b_tanks, b.address AS b_address,
              v.vehicle_type, v.registration_number
         FROM jobs j
         LEFT JOIN bookings b ON b.id = j.booking_id
         LEFT JOIN vehicles v ON v.id = j.vehicle_id
        WHERE j.customer_id = $1
          AND j.status = 'scheduled'
          AND (j.start_otp IS NOT NULL OR j.departure_time IS NOT NULL)
        ORDER BY j.scheduled_at ASC
        LIMIT 5`,
      [customerId]
    );
    const alerts = [];
    for (const j of result.rows) {
      // Human job label so customers with several bookings know WHICH job
      // the alert refers to (e.g. "Overhead Tank · 15,000 L" / "Car Wash ·
      // HATCHBACK TS09AB1234") + when/where.
      let label;
      if (j.job_type === 'auto_wash') {
        label = `Car Wash${j.vehicle_type ? ` · ${String(j.vehicle_type).toUpperCase()}` : ''}${j.registration_number ? ` ${j.registration_number}` : ''}`;
      } else {
        const tankCount = Array.isArray(j.b_tanks) && j.b_tanks.length > 1 ? ` × ${j.b_tanks.length} tanks` : '';
        label = `${(j.b_tank_type || 'Tank').replace(/_/g, ' ')} tank${tankCount}${j.b_litres ? ` · ${Number(j.b_litres).toLocaleString('en-IN')} L` : ''}`;
        label = label.charAt(0).toUpperCase() + label.slice(1);
      }
      const when = new Date(j.scheduled_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
      const where = j.b_address ? ` · ${String(j.b_address).split(',')[0].slice(0, 28)}` : '';
      const context = `${label} · ${when}${where}`;

      if (j.start_otp && !j.start_otp_verified) {
        alerts.push({
          type: 'otp_requested',
          job_id: j.job_id,
          booking_id: j.booking_id,
          job_type: j.job_type,
          scheduled_at: j.scheduled_at,
          context,
          message: 'Technician requested your Start OTP — tap to view it',
        });
      } else if (j.departure_time && !j.start_otp_verified) {
        alerts.push({
          type: 'crew_departed',
          job_id: j.job_id,
          booking_id: j.booking_id,
          job_type: j.job_type,
          scheduled_at: j.scheduled_at,
          context,
          message: 'Your OzoneWash crew has departed and is on the way',
        });
      }
    }
    return alerts;
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
    // Available = no individual agent assigned AND no field team assigned.
    // Once a team is on it, every team member already sees it via My Jobs;
    // it shouldn't keep appearing on the public board.
    const result = await db.query(
      `SELECT j.*,
        c.name as customer_name, c.phone as customer_phone,
        b.address, b.tank_type, b.tank_size_litres, b.addons
       FROM jobs j
       JOIN users c ON c.id = j.customer_id
       LEFT JOIN bookings b ON b.id = j.booking_id
       WHERE j.assigned_team_id IS NULL
         AND j.assigned_field_team_id IS NULL
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

  // Get all job requests for a specific field team member (any status, newest
  // first). Joins job + booking + customer so the UI has everything to render
  // a card without follow-up calls.
  findRequestsByTeam: async (teamId, { limit = 50 } = {}) => {
    const result = await db.query(
      `SELECT jr.id as request_id, jr.status as request_status,
        jr.created_at as requested_at, jr.updated_at as request_updated_at,
        j.id, j.scheduled_at, j.status as job_status, j.assigned_team_id,
        c.name as customer_name, c.phone as customer_phone,
        b.tank_type, b.tank_size_litres, b.address, b.addons
       FROM job_requests jr
       JOIN jobs j ON j.id = jr.job_id
       JOIN users c ON c.id = j.customer_id
       LEFT JOIN bookings b ON b.id = j.booking_id
       WHERE jr.team_id = $1
       ORDER BY jr.created_at DESC
       LIMIT $2`,
      [teamId, limit]
    );
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

  // ── Conflict Detection ──────────────────────────────────────────────────

  // Returns jobs assigned to teamId that overlap the given scheduledAt (±60 min)
  checkConflict: async (teamId, scheduledAt, excludeJobId = null) => {
    let query = `
      SELECT j.id, j.scheduled_at, j.status,
        b.tank_type, b.tank_size_litres, b.address,
        c.name as customer_name, c.phone as customer_phone
      FROM jobs j
      LEFT JOIN bookings b ON b.id = j.booking_id
      LEFT JOIN users c ON c.id = j.customer_id
      WHERE j.assigned_team_id = $1
        AND j.status NOT IN ('cancelled', 'completed')
        AND j.scheduled_at BETWEEN $2::timestamptz - INTERVAL '60 minutes'
                                AND $2::timestamptz + INTERVAL '60 minutes'
    `;
    const params = [teamId, scheduledAt];
    if (excludeJobId) {
      query += ` AND j.id != $3`;
      params.push(excludeJobId);
    }
    query += ` ORDER BY j.scheduled_at ASC`;
    const result = await db.query(query, params);
    return result.rows;
  },

  // Field team raises a scheduling concern on their job
  raiseConcern: async (jobId, teamId, message) => {
    const result = await db.query(
      `UPDATE jobs SET
        concern_message   = $1,
        concern_raised_at = NOW(),
        concern_resolved  = false,
        concern_raised_by = $2,
        updated_at        = NOW()
       WHERE id = $3 AND assigned_team_id = $2
       RETURNING *`,
      [message, teamId, jobId]
    );
    return result.rows[0] || null;
  },

  // Admin: get all unresolved concerns
  findConcerns: async () => {
    const result = await db.query(
      `SELECT j.id, j.scheduled_at, j.status,
        j.concern_message, j.concern_raised_at, j.concern_resolved,
        j.assigned_team_id,
        t.name as team_name, t.phone as team_phone, t.fcm_token as team_fcm_token,
        c.name as customer_name, c.phone as customer_phone,
        b.address, b.tank_type, b.tank_size_litres
       FROM jobs j
       JOIN users t ON t.id = j.assigned_team_id
       JOIN users c ON c.id = j.customer_id
       LEFT JOIN bookings b ON b.id = j.booking_id
       WHERE j.concern_message IS NOT NULL
         AND j.concern_resolved = false
       ORDER BY j.concern_raised_at DESC`
    );
    return result.rows;
  },

  // Admin resolves a concern (e.g. after reassigning)
  resolveConcern: async (jobId) => {
    const result = await db.query(
      `UPDATE jobs SET concern_resolved = true, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [jobId]
    );
    return result.rows[0];
  },

};

module.exports = JobRepository;