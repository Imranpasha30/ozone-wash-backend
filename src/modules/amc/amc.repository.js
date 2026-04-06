const db = require('../../config/db');

const AmcRepository = {

  // Create new AMC contract
  create: async (data) => {
    const result = await db.query(
      `INSERT INTO amc_contracts (
        customer_id, tank_ids, plan_type, sla_terms,
        start_date, end_date, status, amount_paise,
        payment_status, job_type, resource_type
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *`,
      [
        data.customer_id,
        JSON.stringify(data.tank_ids || []),
        data.plan_type,
        JSON.stringify(data.sla_terms || {}),
        data.start_date,
        data.end_date,
        data.status || 'pending_payment',
        data.amount_paise || 0,
        data.payment_status || 'pending',
        'tank_cleaning',
        'tank',
      ]
    );
    return result.rows[0];
  },

  // Find contract by ID
  findById: async (id) => {
    const result = await db.query(
      `SELECT a.*, u.name as customer_name, u.phone as customer_phone
       FROM amc_contracts a
       JOIN users u ON u.id = a.customer_id
       WHERE a.id = $1`,
      [id]
    );
    return result.rows[0] || null;
  },

  // Find all contracts for a customer
  findByCustomer: async (customerId) => {
    const result = await db.query(
      `SELECT * FROM amc_contracts
       WHERE customer_id = $1
       ORDER BY created_at DESC`,
      [customerId]
    );
    return result.rows;
  },

  // Find all contracts (admin)
  findAll: async ({ status, limit = 20, offset = 0 }) => {
    let query = `SELECT a.*, u.name as customer_name, u.phone as customer_phone
                 FROM amc_contracts a
                 JOIN users u ON u.id = a.customer_id
                 WHERE 1=1`;
    const params = [];
    let i = 1;

    if (status) { query += ` AND a.status = $${i++}`; params.push(status); }

    query += ` ORDER BY a.created_at DESC LIMIT $${i++} OFFSET $${i++}`;
    params.push(limit, offset);

    const result = await db.query(query, params);
    return result.rows;
  },

  // Update contract status
  updateStatus: async (id, status) => {
    const result = await db.query(
      `UPDATE amc_contracts
       SET status = $1, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [status, id]
    );
    return result.rows[0];
  },

  // Save e-signatures
  saveSignatures: async (id, customerEsign, adminEsign) => {
    const result = await db.query(
      `UPDATE amc_contracts
       SET customer_esign = $1, admin_esign = $2, updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [customerEsign, adminEsign, id]
    );
    return result.rows[0];
  },

  // Update payment fields on a contract
  updatePayment: async (id, { razorpay_order_id, razorpay_payment_id, payment_status }) => {
    const result = await db.query(
      `UPDATE amc_contracts
       SET razorpay_order_id = COALESCE($1, razorpay_order_id),
           razorpay_payment_id = COALESCE($2, razorpay_payment_id),
           payment_status = COALESCE($3, payment_status),
           updated_at = NOW()
       WHERE id = $4 RETURNING *`,
      [razorpay_order_id, razorpay_payment_id, payment_status, id]
    );
    return result.rows[0];
  },

  // Get contracts expiring within X days (for renewal alerts)
  getExpiringSoon: async (days) => {
    const result = await db.query(
      `SELECT a.*, u.name as customer_name, u.phone as customer_phone
       FROM amc_contracts a
       JOIN users u ON u.id = a.customer_id
       WHERE a.status = 'active'
         AND a.end_date <= CURRENT_DATE + INTERVAL '${days} days'
         AND a.end_date >= CURRENT_DATE
       ORDER BY a.end_date ASC`,
    );
    return result.rows;
  },

  // Mark renewal pending
  markRenewalPending: async (id) => {
    await db.query(
      `UPDATE amc_contracts
       SET renewal_pending = true, updated_at = NOW()
       WHERE id = $1`,
      [id]
    );
  },

  // Get SLA breaches
  getSlaBreaches: async () => {
    const result = await db.query(
      `SELECT j.*, 
        u.name as customer_name,
        t.name as team_name,
        b.address,
        EXTRACT(EPOCH FROM (NOW() - j.scheduled_at))/3600 as hours_overdue
       FROM jobs j
       JOIN users u ON u.id = j.customer_id
       LEFT JOIN users t ON t.id = j.assigned_team_id
       LEFT JOIN bookings b ON b.id = j.booking_id
       WHERE j.status NOT IN ('completed', 'cancelled')
         AND j.scheduled_at < NOW() - INTERVAL '3 hours'
       ORDER BY j.scheduled_at ASC`
    );
    return result.rows;
  },

};

module.exports = AmcRepository;