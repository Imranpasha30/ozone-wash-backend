const db = require('../../config/db');

const CertificateRepository = {

  // Save certificate to DB
  create: async (data) => {
    const result = await db.query(
      `INSERT INTO hygiene_certificates (
        job_id, eco_score, certificate_url,
        qr_code_url, digital_signature,
        valid_until, status
      ) VALUES ($1,$2,$3,$4,$5,$6,'active')
      ON CONFLICT (job_id)
      DO UPDATE SET
        eco_score = $2,
        certificate_url = $3,
        qr_code_url = $4,
        digital_signature = $5,
        valid_until = $6,
        status = 'active'
      RETURNING *`,
      [
        data.job_id,
        data.eco_score,
        data.certificate_url,
        data.qr_code_url,
        data.digital_signature,
        data.valid_until,
      ]
    );
    return result.rows[0];
  },

  // Find certificate by job ID
  findByJob: async (jobId) => {
    const result = await db.query(
      `SELECT c.*,
        j.scheduled_at, j.completed_at,
        b.tank_type, b.tank_size_litres, b.address,
        cu.name as customer_name, cu.phone as customer_phone,
        tu.name as team_name
       FROM hygiene_certificates c
       JOIN jobs j ON j.id = c.job_id
       LEFT JOIN bookings b ON b.id = j.booking_id
       JOIN users cu ON cu.id = j.customer_id
       LEFT JOIN users tu ON tu.id = j.assigned_team_id
       WHERE c.job_id = $1`,
      [jobId]
    );
    return result.rows[0] || null;
  },

  // Find certificate by certificate ID (for QR verification)
  findById: async (certId) => {
    const result = await db.query(
      `SELECT c.*,
        j.scheduled_at, j.completed_at,
        b.tank_type, b.tank_size_litres, b.address,
        cu.name as customer_name, cu.phone as customer_phone,
        tu.name as team_name
       FROM hygiene_certificates c
       JOIN jobs j ON j.id = c.job_id
       LEFT JOIN bookings b ON b.id = j.booking_id
       JOIN users cu ON cu.id = j.customer_id
       LEFT JOIN users tu ON tu.id = j.assigned_team_id
       WHERE c.id = $1`,
      [certId]
    );
    return result.rows[0] || null;
  },

  // Revoke a certificate (admin only)
  revoke: async (certId, adminId, reason) => {
    const result = await db.query(
      `UPDATE hygiene_certificates
       SET status = 'revoked',
           revoked_reason = $1,
           revoked_by = $2
       WHERE id = $3
       RETURNING *`,
      [reason, adminId, certId]
    );
    return result.rows[0];
  },

};

module.exports = CertificateRepository;