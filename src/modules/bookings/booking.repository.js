const db = require('../../config/db');

const BookingRepository = {

  create: async (data) => {
    const result = await db.query(
      `INSERT INTO bookings (
        customer_id, tank_type, tank_size_litres, address, lat, lng,
        slot_time, addons, amc_plan, payment_method, amount_paise,
        job_type, resource_type
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *`,
      [
        data.customer_id, data.tank_type, data.tank_size_litres,
        data.address, data.lat, data.lng, data.slot_time,
        JSON.stringify(data.addons || []), data.amc_plan,
        data.payment_method, data.amount_paise,
        'tank_cleaning', 'tank'
      ]
    );
    return result.rows[0];
  },

  findById: async (id) => {
    const result = await db.query(
      `SELECT b.*, u.name as customer_name, u.phone as customer_phone,
              j.id as job_id, j.status as job_status,
              j.assigned_team_id, j.start_otp, j.end_otp,
              j.start_otp_verified, j.end_otp_verified,
              j.end_otp_satisfied, j.end_otp_unsatisfied, j.customer_satisfied,
              t.name as team_name
       FROM bookings b
       JOIN users u ON u.id = b.customer_id
       LEFT JOIN jobs j ON j.booking_id = b.id
       LEFT JOIN users t ON t.id = j.assigned_team_id
       WHERE b.id = $1`,
      [id]
    );
    return result.rows[0] || null;
  },

  findByCustomer: async (customerId) => {
    const result = await db.query(
      `SELECT b.*, j.id as job_id, j.status as job_status,
              j.assigned_team_id, j.start_otp, j.end_otp,
              j.start_otp_verified, j.end_otp_verified,
              j.end_otp_satisfied, j.end_otp_unsatisfied, j.customer_satisfied,
              t.name as team_name
       FROM bookings b
       LEFT JOIN jobs j ON j.booking_id = b.id
       LEFT JOIN users t ON t.id = j.assigned_team_id
       WHERE b.customer_id = $1
       ORDER BY b.created_at DESC`,
      [customerId]
    );
    return result.rows;
  },

  findAll: async ({ status, date, limit = 20, offset = 0 }) => {
    let query = `SELECT b.*, u.name as customer_name, u.phone as customer_phone,
                        j.id as job_id, j.status as job_status,
                        j.assigned_team_id, t.name as team_name
                 FROM bookings b
                 JOIN users u ON u.id = b.customer_id
                 LEFT JOIN jobs j ON j.booking_id = b.id
                 LEFT JOIN users t ON t.id = j.assigned_team_id
                 WHERE 1=1`;
    const params = [];
    let i = 1;

    if (status) { query += ` AND b.status = $${i++}`; params.push(status); }
    if (date) { query += ` AND DATE(b.slot_time) = $${i++}`; params.push(date); }

    query += ` ORDER BY b.created_at DESC LIMIT $${i++} OFFSET $${i++}`;
    params.push(limit, offset);

    const result = await db.query(query, params);
    return result.rows;
  },

  updateStatus: async (id, status) => {
    const result = await db.query(
      `UPDATE bookings SET status = $1, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [status, id]
    );
    return result.rows[0];
  },

  updatePayment: async (id, { razorpay_order_id, razorpay_payment_id, payment_status }) => {
    const result = await db.query(
      `UPDATE bookings SET
        razorpay_order_id = $1,
        razorpay_payment_id = $2,
        payment_status = $3,
        updated_at = NOW()
       WHERE id = $4 RETURNING *`,
      [razorpay_order_id, razorpay_payment_id, payment_status, id]
    );
    return result.rows[0];
  },

  // Check if a slot is already taken for a team
  checkSlotConflict: async (slot_time, team_id) => {
    const result = await db.query(
      `SELECT id FROM jobs
       WHERE assigned_team_id = $1
         AND scheduled_at BETWEEN $2::timestamp - interval '2 hours'
                              AND $2::timestamp + interval '2 hours'
         AND status NOT IN ('cancelled')`,
      [team_id, slot_time]
    );
    return result.rows.length > 0;
  },

  getAvailableSlots: async (date) => {
    // Returns booked slots for a date so frontend can show available ones
    const result = await db.query(
      `SELECT scheduled_at, assigned_team_id FROM jobs
       WHERE DATE(scheduled_at) = $1
         AND status NOT IN ('cancelled')`,
      [date]
    );
    return result.rows;
  },

};

module.exports = BookingRepository;