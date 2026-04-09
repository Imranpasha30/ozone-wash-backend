const db = require('../../config/db');

const ComplianceRepository = {

  // Get all steps for a job
  getSteps: async (jobId) => {
    const result = await db.query(
      `SELECT * FROM compliance_logs
       WHERE job_id = $1
       ORDER BY step_number ASC`,
      [jobId]
    );
    return result.rows;
  },

  // Get a single step
  getStep: async (jobId, stepNumber) => {
    const result = await db.query(
      `SELECT * FROM compliance_logs
       WHERE job_id = $1 AND step_number = $2`,
      [jobId, stepNumber]
    );
    return result.rows[0] || null;
  },

  // Save or update a compliance step
  saveStep: async (data) => {
    const result = await db.query(
      `INSERT INTO compliance_logs (
        job_id, step_number, step_name,
        photo_before_url, photo_after_url,
        ozone_exposure_mins, microbial_test_url,
        microbial_result, microbial_notes,
        chemical_type, chemical_qty_ml,
        ppe_list, gps_lat, gps_lng, completed,
        job_type, resource_type
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT (job_id, step_number)
      DO UPDATE SET
        photo_before_url = $4,
        photo_after_url = $5,
        ozone_exposure_mins = $6,
        microbial_test_url = $7,
        microbial_result = $8,
        microbial_notes = $9,
        chemical_type = $10,
        chemical_qty_ml = $11,
        ppe_list = $12,
        gps_lat = $13,
        gps_lng = $14,
        completed = $15,
        logged_at = NOW()
      RETURNING *`,
      [
        data.job_id,
        data.step_number,
        data.step_name,
        data.photo_before_url || null,
        data.photo_after_url || null,
        data.ozone_exposure_mins || null,
        data.microbial_test_url || null,
        data.microbial_result || null,
        data.microbial_notes || null,
        data.chemical_type || null,
        data.chemical_qty_ml || null,
        JSON.stringify(data.ppe_list || []),
        data.gps_lat,
        data.gps_lng,
        data.completed || false,
        'tank_cleaning',
        'tank',
      ]
    );
    return result.rows[0];
  },

  // Count completed steps for a job
  getCompletedCount: async (jobId) => {
    const result = await db.query(
      `SELECT COUNT(*) as completed_count
       FROM compliance_logs
       WHERE job_id = $1 AND completed = true`,
      [jobId]
    );
    return parseInt(result.rows[0].completed_count);
  },

  // Check if ALL 8 steps are complete
  areAllStepsComplete: async (jobId) => {
    const result = await db.query(
      `SELECT COUNT(*) as total
       FROM compliance_logs
       WHERE job_id = $1 AND completed = true`,
      [jobId]
    );
    return parseInt(result.rows[0].total) === 8;
  },

  // Get compliance status summary
  getStatus: async (jobId) => {
    const result = await db.query(
      `SELECT
        COUNT(*) as total_logged,
        COUNT(*) FILTER (WHERE completed = true) as completed,
        COUNT(*) FILTER (WHERE completed = false) as incomplete,
        ARRAY_AGG(step_number ORDER BY step_number) as logged_steps
       FROM compliance_logs
       WHERE job_id = $1`,
      [jobId]
    );
    return result.rows[0];
  },

};

module.exports = ComplianceRepository;