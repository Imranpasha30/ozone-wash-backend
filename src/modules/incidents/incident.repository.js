const db = require('../../config/db');

const IncidentRepository = {

  create: async (data) => {
    const result = await db.query(
      `INSERT INTO incident_reports (
        job_id, reported_by, description, photo_url, audio_url, severity
      ) VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *`,
      [
        data.job_id, data.reported_by, data.description,
        data.photo_url || null, data.audio_url || null,
        data.severity || 'medium',
      ]
    );
    return result.rows[0];
  },

  findById: async (id) => {
    const result = await db.query(
      `SELECT ir.*,
        u.name as reporter_name, u.phone as reporter_phone,
        r.name as resolver_name
       FROM incident_reports ir
       JOIN users u ON u.id = ir.reported_by
       LEFT JOIN users r ON r.id = ir.resolved_by
       WHERE ir.id = $1`,
      [id]
    );
    return result.rows[0] || null;
  },

  findByJobId: async (jobId) => {
    const result = await db.query(
      `SELECT ir.*,
        u.name as reporter_name
       FROM incident_reports ir
       JOIN users u ON u.id = ir.reported_by
       WHERE ir.job_id = $1
       ORDER BY ir.created_at DESC`,
      [jobId]
    );
    return result.rows;
  },

  findAll: async ({ status, severity, limit = 20, offset = 0 }) => {
    let query = `SELECT ir.*,
        u.name as reporter_name, u.phone as reporter_phone,
        j.booking_id
       FROM incident_reports ir
       JOIN users u ON u.id = ir.reported_by
       LEFT JOIN jobs j ON j.id = ir.job_id
       WHERE 1=1`;
    const params = [];
    let i = 1;

    if (status) { query += ` AND ir.status = $${i++}`; params.push(status); }
    if (severity) { query += ` AND ir.severity = $${i++}`; params.push(severity); }

    query += ` ORDER BY ir.created_at DESC LIMIT $${i++} OFFSET $${i++}`;
    params.push(limit, offset);

    const result = await db.query(query, params);
    return result.rows;
  },

  resolve: async (id, resolvedBy) => {
    const result = await db.query(
      `UPDATE incident_reports SET
        status = 'resolved', resolved_by = $1, resolved_at = NOW()
       WHERE id = $2 RETURNING *`,
      [resolvedBy, id]
    );
    return result.rows[0];
  },

  escalate: async (id) => {
    const result = await db.query(
      `UPDATE incident_reports SET status = 'escalated'
       WHERE id = $1 RETURNING *`,
      [id]
    );
    return result.rows[0];
  },

};

module.exports = IncidentRepository;
