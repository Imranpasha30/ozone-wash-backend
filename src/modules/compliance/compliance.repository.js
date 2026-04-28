const db = require('../../config/db');

// Total phases including Stage 0 (Pre-Service) - kept in sync with the
// COMPLIANCE_STEPS object in compliance.service.js.
const TOTAL_STEPS = 9;

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

  // Save or update a compliance step. Persists the full PDF-aligned payload:
  // legacy columns (photos, gps, ppe_list, ozone_exposure_mins, microbial_*,
  // chemical_*) plus all new Stage 0 + per-step columns added in
  // migrations/009_compliance_pdf_alignment.sql.
  saveStep: async (data) => {
    const result = await db.query(
      `INSERT INTO compliance_logs (
        job_id, step_number, step_name,
        photo_before_url, photo_after_url,
        ozone_exposure_mins, microbial_test_url,
        microbial_result, microbial_notes,
        chemical_type, chemical_qty_ml,
        ppe_list, gps_lat, gps_lng, completed,
        job_type, resource_type,
        ladder_check, electrical_check, emergency_kit, spare_tank_water,
        fence_placed, danger_board, arrival_at,
        turbidity, ph_level, orp, conductivity, tds, atp,
        water_level_pct, tank_condition, scrub_completed,
        rinse_duration, disposal_status,
        ozone_cycle_duration, ozone_ppm_dosed,
        uv_cycle_duration, uv_dose, uv_lumines_status, uv_skipped,
        client_signature_url, technician_remarks
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        $11,$12,$13,$14,$15,$16,$17,
        $18,$19,$20,$21,$22,$23,$24,
        $25,$26,$27,$28,$29,$30,
        $31,$32,$33,$34,$35,$36,$37,
        $38,$39,$40,$41,$42,$43
      )
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
        ladder_check = $18,
        electrical_check = $19,
        emergency_kit = $20,
        spare_tank_water = $21,
        fence_placed = $22,
        danger_board = $23,
        arrival_at = $24,
        turbidity = $25,
        ph_level = $26,
        orp = $27,
        conductivity = $28,
        tds = $29,
        atp = $30,
        water_level_pct = $31,
        tank_condition = $32,
        scrub_completed = $33,
        rinse_duration = $34,
        disposal_status = $35,
        ozone_cycle_duration = $36,
        ozone_ppm_dosed = $37,
        uv_cycle_duration = $38,
        uv_dose = $39,
        uv_lumines_status = $40,
        uv_skipped = $41,
        client_signature_url = $42,
        technician_remarks = $43,
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
        // Stage 0 columns
        data.ladder_check || null,
        data.electrical_check || null,
        typeof data.emergency_kit === 'boolean' ? data.emergency_kit : null,
        typeof data.spare_tank_water === 'boolean' ? data.spare_tank_water : null,
        typeof data.fence_placed === 'boolean' ? data.fence_placed : null,
        typeof data.danger_board === 'boolean' ? data.danger_board : null,
        data.arrival_at || null,
        // Water tests (steps 1 + 8)
        data.turbidity || null,
        data.ph_level || null,
        data.orp || null,
        data.conductivity || null,
        data.tds || null,
        data.atp || null,
        // Step 2
        data.water_level_pct || null,
        data.tank_condition || null,
        // Step 3
        typeof data.scrub_completed === 'boolean' ? data.scrub_completed : null,
        // Step 4
        data.rinse_duration || null,
        // Step 5
        data.disposal_status || null,
        // Step 6
        data.ozone_cycle_duration || null,
        data.ozone_ppm_dosed || null,
        // Step 7
        data.uv_cycle_duration || null,
        data.uv_dose || null,
        data.uv_lumines_status || null,
        data.uv_skipped === true,
        // Step 8
        data.client_signature_url || null,
        data.technician_remarks || null,
      ]
    );
    return result.rows[0];
  },

  // Count completed (or skipped, for step 7) phases for a job. A skipped UV
  // step counts as completed so the agent can still progress past Step 7
  // without UV being part of the booking.
  getCompletedCount: async (jobId) => {
    const result = await db.query(
      `SELECT COUNT(*) as completed_count
       FROM compliance_logs
       WHERE job_id = $1 AND (completed = true OR uv_skipped = true)`,
      [jobId]
    );
    return parseInt(result.rows[0].completed_count);
  },

  // Check if all 9 phases are complete (Stage 0 + Steps 1-8, with skipped UV
  // counting as complete).
  areAllStepsComplete: async (jobId) => {
    const result = await db.query(
      `SELECT COUNT(*) as total
       FROM compliance_logs
       WHERE job_id = $1 AND (completed = true OR uv_skipped = true)`,
      [jobId]
    );
    return parseInt(result.rows[0].total) === TOTAL_STEPS;
  },

  // Get compliance status summary
  getStatus: async (jobId) => {
    const result = await db.query(
      `SELECT
        COUNT(*) as total_logged,
        COUNT(*) FILTER (WHERE completed = true OR uv_skipped = true) as completed,
        COUNT(*) FILTER (WHERE completed = false AND uv_skipped = false) as incomplete,
        ARRAY_AGG(step_number ORDER BY step_number) as logged_steps
       FROM compliance_logs
       WHERE job_id = $1`,
      [jobId]
    );
    return result.rows[0];
  },

};

module.exports = ComplianceRepository;
