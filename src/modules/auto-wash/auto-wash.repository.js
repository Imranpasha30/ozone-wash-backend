/**
 * Data-access layer for the Auto Wash module.
 * No business logic — just parameterised SQL.
 */

const { query } = require('../../config/db');

const AutoWashRepository = {

  /* ── Catalog (read-only) ─────────────────────────────────────────────── */

  listPackages: async () => {
    const { rows } = await query(
      `SELECT code, display_name, tagline, features,
              price_hatchback_paise, price_sedan_paise,
              price_suv_paise, price_luxury_paise, display_order
         FROM auto_wash_packages
        WHERE active = true
        ORDER BY display_order ASC`
    );
    return rows;
  },

  getPackageByCode: async (code) => {
    const { rows } = await query(
      `SELECT * FROM auto_wash_packages WHERE code = $1 AND active = true LIMIT 1`,
      [code]
    );
    return rows[0] || null;
  },

  listAddons: async () => {
    const { rows } = await query(
      `SELECT code, display_name, benefit,
              price_hatchback_paise, price_sedan_paise,
              price_suv_paise, price_luxury_paise,
              display_order, coming_soon
         FROM auto_wash_addons
        WHERE active = true
        ORDER BY display_order ASC`
    );
    return rows;
  },

  getAddonsByCodes: async (codes) => {
    if (!codes || !codes.length) return [];
    const { rows } = await query(
      `SELECT code, display_name,
              price_hatchback_paise, price_sedan_paise,
              price_suv_paise, price_luxury_paise
         FROM auto_wash_addons
        WHERE active = true AND code = ANY($1::text[])`,
      [codes]
    );
    return rows;
  },

  listSubscriptionPlans: async () => {
    const { rows } = await query(
      `SELECT code, display_name, cadence_label, washes_per_cycle, cycle_days,
              price_hatchback_paise, price_suv_paise,
              addon_discount_pct, highlight, display_order, notes
         FROM auto_wash_subscription_plans
        WHERE active = true
        ORDER BY display_order ASC`
    );
    return rows;
  },

  getSubscriptionPlan: async (code) => {
    const { rows } = await query(
      `SELECT * FROM auto_wash_subscription_plans WHERE code = $1 AND active = true LIMIT 1`,
      [code]
    );
    return rows[0] || null;
  },

  /* ── Vehicles ────────────────────────────────────────────────────────── */

  listVehiclesForCustomer: async (customerId) => {
    const { rows } = await query(
      `SELECT id, vehicle_type, registration_number, make, model, year,
              nickname, registration_date, is_primary, created_at
         FROM vehicles
        WHERE customer_id = $1
        ORDER BY is_primary DESC, created_at DESC`,
      [customerId]
    );
    return rows;
  },

  findVehicleById: async (id, customerId) => {
    const { rows } = await query(
      `SELECT * FROM vehicles WHERE id = $1 AND customer_id = $2 LIMIT 1`,
      [id, customerId]
    );
    return rows[0] || null;
  },

  createVehicle: async ({ customer_id, vehicle_type, registration_number, make, model, year, nickname, registration_date, is_primary }) => {
    // If creating as primary, clear primary flag on other vehicles first.
    if (is_primary) {
      await query(
        `UPDATE vehicles SET is_primary = false, updated_at = NOW() WHERE customer_id = $1`,
        [customer_id]
      );
    }
    const { rows } = await query(
      `INSERT INTO vehicles
         (customer_id, vehicle_type, registration_number, make, model, year, nickname, registration_date, is_primary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [customer_id, vehicle_type, registration_number, make || null, model || null,
       year || null, nickname || null, registration_date || null, !!is_primary]
    );
    return rows[0];
  },

  updateVehicle: async ({ id, customer_id, fields }) => {
    const allowed = ['vehicle_type', 'registration_number', 'make', 'model', 'year', 'nickname', 'registration_date', 'is_primary'];
    const sets = [];
    const params = [];
    for (const key of allowed) {
      if (fields[key] !== undefined) {
        params.push(fields[key]);
        sets.push(`${key} = $${params.length}`);
      }
    }
    if (!sets.length) {
      return AutoWashRepository.findVehicleById(id, customer_id);
    }
    if (fields.is_primary) {
      await query(
        `UPDATE vehicles SET is_primary = false, updated_at = NOW() WHERE customer_id = $1 AND id <> $2`,
        [customer_id, id]
      );
    }
    sets.push(`updated_at = NOW()`);
    params.push(id, customer_id);
    const { rows } = await query(
      `UPDATE vehicles SET ${sets.join(', ')}
        WHERE id = $${params.length - 1} AND customer_id = $${params.length}
        RETURNING *`,
      params
    );
    return rows[0] || null;
  },

  deleteVehicle: async (id, customerId) => {
    const { rowCount } = await query(
      `DELETE FROM vehicles WHERE id = $1 AND customer_id = $2`,
      [id, customerId]
    );
    return rowCount > 0;
  },

  /* ── Jobs (auto wash bookings — stored in the existing jobs table) ──── */

  createAutoWashJob: async (job) => {
    const { rows } = await query(
      `INSERT INTO jobs (
         booking_id, customer_id, status, job_type, resource_type,
         scheduled_at, location_lat, location_lng, location_address, notes,
         vehicle_id, service_package, addons_booked, gated_community,
         base_price_paise, addons_price_paise, total_price_paise,
         subscription_job_id
       ) VALUES (
         NULL, $1, 'scheduled', 'auto_wash', 'vehicle',
         $2, $3, $4, $5, $6,
         $7, $8, $9::jsonb, $10,
         $11, $12, $13,
         $14
       )
       RETURNING *`,
      [
        job.customer_id,
        job.scheduled_at,
        job.location_lat || null,
        job.location_lng || null,
        job.location_address || null,
        job.notes || null,
        job.vehicle_id,
        job.service_package,
        JSON.stringify(job.addons_booked || []),
        !!job.gated_community,
        job.base_price_paise,
        job.addons_price_paise,
        job.total_price_paise,
        job.subscription_job_id || null,
      ]
    );
    return rows[0];
  },

  findAutoWashJobById: async (id) => {
    const { rows } = await query(
      `SELECT j.*,
              v.vehicle_type AS v_type, v.registration_number AS v_reg,
              v.make AS v_make, v.model AS v_model, v.nickname AS v_nickname
         FROM jobs j
         LEFT JOIN vehicles v ON v.id = j.vehicle_id
        WHERE j.id = $1 AND j.job_type = 'auto_wash'
        LIMIT 1`,
      [id]
    );
    return rows[0] || null;
  },

  listAutoWashJobsForCustomer: async (customerId, { limit = 50, offset = 0 } = {}) => {
    const { rows } = await query(
      `SELECT j.id, j.status, j.scheduled_at, j.started_at, j.completed_at,
              j.service_package, j.addons_booked, j.total_price_paise,
              v.vehicle_type AS v_type, v.registration_number AS v_reg,
              v.nickname AS v_nickname
         FROM jobs j
         LEFT JOIN vehicles v ON v.id = j.vehicle_id
        WHERE j.customer_id = $1 AND j.job_type = 'auto_wash'
        ORDER BY j.scheduled_at DESC
        LIMIT $2 OFFSET $3`,
      [customerId, limit, offset]
    );
    return rows;
  },

  listAutoWashJobsForCrew: async (crewId, { fromDate, toDate } = {}) => {
    const params = [crewId];
    let clause = `j.assigned_team_id = $1 AND j.job_type = 'auto_wash'`;
    if (fromDate) { params.push(fromDate); clause += ` AND j.scheduled_at >= $${params.length}`; }
    if (toDate)   { params.push(toDate);   clause += ` AND j.scheduled_at <= $${params.length}`; }
    const { rows } = await query(
      `SELECT j.id, j.status, j.scheduled_at, j.notes, j.gated_community,
              j.service_package, j.addons_booked,
              v.vehicle_type AS v_type, v.registration_number AS v_reg,
              v.make AS v_make, v.model AS v_model
         FROM jobs j
         LEFT JOIN vehicles v ON v.id = j.vehicle_id
        WHERE ${clause}
        ORDER BY j.scheduled_at ASC`,
      params
    );
    return rows;
  },

  /* ── Pre-inspection + step logs ──────────────────────────────────────── */

  setPreInspectionPhotos: async (jobId, photoUrls) => {
    await query(
      `UPDATE jobs SET pre_inspection_photos = $1::jsonb, updated_at = NOW()
        WHERE id = $2 AND job_type = 'auto_wash'`,
      [JSON.stringify(photoUrls), jobId]
    );
  },

  startStep: async ({ job_id, step_number, step_name, step_type }) => {
    const { rows } = await query(
      `INSERT INTO auto_wash_step_logs (job_id, step_number, step_name, step_type, started_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (job_id, step_number)
       DO UPDATE SET started_at = NOW(), ended_at = NULL, duration_minutes = NULL, passed_validation = false
       RETURNING *`,
      [job_id, step_number, step_name, step_type || 'core']
    );
    return rows[0];
  },

  endStep: async ({ job_id, step_number, photo_urls, ozone_ppm, notes, passed_validation }) => {
    const { rows } = await query(
      `UPDATE auto_wash_step_logs
          SET ended_at = NOW(),
              duration_minutes = GREATEST(0, EXTRACT(EPOCH FROM (NOW() - started_at))::INTEGER / 60),
              photo_urls = COALESCE($3::jsonb, photo_urls),
              ozone_ppm = COALESCE($4, ozone_ppm),
              notes = COALESCE($5, notes),
              passed_validation = $6
        WHERE job_id = $1 AND step_number = $2
        RETURNING *`,
      [
        job_id,
        step_number,
        photo_urls ? JSON.stringify(photo_urls) : null,
        ozone_ppm || null,
        notes || null,
        !!passed_validation,
      ]
    );
    return rows[0] || null;
  },

  listStepsForJob: async (jobId) => {
    const { rows } = await query(
      `SELECT id, step_number, step_name, step_type,
              started_at, ended_at, duration_minutes,
              photo_urls, ozone_ppm, notes, passed_validation
         FROM auto_wash_step_logs
        WHERE job_id = $1
        ORDER BY step_number ASC`,
      [jobId]
    );
    return rows;
  },

  setJobInProgress: async (jobId) => {
    await query(
      `UPDATE jobs SET status = 'in_progress', started_at = COALESCE(started_at, NOW()), updated_at = NOW()
        WHERE id = $1 AND job_type = 'auto_wash' AND status = 'scheduled'`,
      [jobId]
    );
  },

  completeJobWithReadings: async (jobId, readings) => {
    await query(
      `UPDATE jobs
          SET status = 'completed',
              completed_at = NOW(),
              ozone_ppm_reading = COALESCE($2, ozone_ppm_reading),
              fogging_ppm_reading = COALESCE($3, fogging_ppm_reading),
              fogging_duration_min = COALESCE($4, fogging_duration_min),
              water_used_litres = COALESCE($5, water_used_litres),
              water_saved_litres = COALESCE($6, water_saved_litres),
              addons_completed = COALESCE($7::jsonb, addons_completed),
              updated_at = NOW()
        WHERE id = $1 AND job_type = 'auto_wash'`,
      [
        jobId,
        readings.ozone_ppm_reading || null,
        readings.fogging_ppm_reading || null,
        readings.fogging_duration_min || null,
        readings.water_used_litres || null,
        readings.water_saved_litres || null,
        readings.addons_completed ? JSON.stringify(readings.addons_completed) : null,
      ]
    );
  },

  /* ── Subscriptions ───────────────────────────────────────────────────── */

  createSubscription: async (sub) => {
    const { rows } = await query(
      `INSERT INTO auto_subscriptions
         (customer_id, plan_type, vehicle_ids, washes_per_cycle,
          price_per_cycle_paise, billing_day_of_cycle, next_billing_date,
          status, addon_discount_pct)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, 'active', $8)
       RETURNING *`,
      [
        sub.customer_id,
        sub.plan_type,
        JSON.stringify(sub.vehicle_ids || []),
        sub.washes_per_cycle,
        sub.price_per_cycle_paise,
        sub.billing_day_of_cycle || null,
        sub.next_billing_date,
        sub.addon_discount_pct || 0,
      ]
    );
    return rows[0];
  },

  getActiveSubscription: async (customerId) => {
    const { rows } = await query(
      `SELECT * FROM auto_subscriptions
        WHERE customer_id = $1 AND status = 'active'
        ORDER BY created_at DESC
        LIMIT 1`,
      [customerId]
    );
    return rows[0] || null;
  },

  pauseSubscription: async (id, customerId, pauseUntil) => {
    const { rows } = await query(
      `UPDATE auto_subscriptions
          SET status = 'paused', pause_until = $3, updated_at = NOW()
        WHERE id = $1 AND customer_id = $2 AND status = 'active'
        RETURNING *`,
      [id, customerId, pauseUntil]
    );
    return rows[0] || null;
  },

  cancelSubscription: async (id, customerId) => {
    const { rows } = await query(
      `UPDATE auto_subscriptions
          SET status = 'cancelled', cancellation_date = CURRENT_DATE, updated_at = NOW()
        WHERE id = $1 AND customer_id = $2 AND status IN ('active','paused')
        RETURNING *`,
      [id, customerId]
    );
    return rows[0] || null;
  },

  /* ── Certificates ────────────────────────────────────────────────────── */

  createCertificate: async (cert) => {
    const { rows } = await query(
      `INSERT INTO auto_wash_certificates
         (job_id, vehicle_id, service_package, addons_included,
          ozone_ppm_exterior, ozone_ppm_cabin, fogging_duration_min,
          water_used_litres, water_saved_litres,
          eco_score, eco_badge, crew_id, ev_unit_id,
          qr_token, certificate_pdf_url, valid_until)
       VALUES ($1, $2, $3, $4::jsonb,
               $5, $6, $7,
               $8, $9,
               $10, $11, $12, $13,
               $14, $15, $16)
       RETURNING *`,
      [
        cert.job_id, cert.vehicle_id, cert.service_package,
        JSON.stringify(cert.addons_included || []),
        cert.ozone_ppm_exterior || null,
        cert.ozone_ppm_cabin || null,
        cert.fogging_duration_min || null,
        cert.water_used_litres || null,
        cert.water_saved_litres || null,
        cert.eco_score,
        cert.eco_badge,
        cert.crew_id || null,
        cert.ev_unit_id || null,
        cert.qr_token,
        cert.certificate_pdf_url || null,
        cert.valid_until,
      ]
    );
    return rows[0];
  },

  updateCertificatePdfUrl: async (certId, pdfUrl) => {
    await query(
      `UPDATE auto_wash_certificates SET certificate_pdf_url = $2 WHERE id = $1`,
      [certId, pdfUrl]
    );
  },

  findCertificateByJobId: async (jobId) => {
    const { rows } = await query(
      `SELECT c.*, v.vehicle_type AS v_type, v.registration_number AS v_reg
         FROM auto_wash_certificates c
         LEFT JOIN vehicles v ON v.id = c.vehicle_id
        WHERE c.job_id = $1
        LIMIT 1`,
      [jobId]
    );
    return rows[0] || null;
  },

  findCertificateByQrToken: async (qrToken) => {
    const { rows } = await query(
      `SELECT c.*, v.vehicle_type AS v_type, v.registration_number AS v_reg,
              u.name AS crew_name, e.unit_code AS ev_unit_code
         FROM auto_wash_certificates c
         LEFT JOIN vehicles v ON v.id = c.vehicle_id
         LEFT JOIN users u   ON u.id = c.crew_id
         LEFT JOIN ev_units e ON e.id = c.ev_unit_id
        WHERE c.qr_token = $1 AND c.status = 'active'
        LIMIT 1`,
      [qrToken]
    );
    return rows[0] || null;
  },

  /* ── Admin queries ──────────────────────────────────────────────────── */

  adminDashboardToday: async () => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today.getTime() + 86400000);
    const { rows } = await query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'completed')   AS completed,
         COUNT(*) FILTER (WHERE status = 'in_progress') AS in_progress,
         COUNT(*) FILTER (WHERE status = 'scheduled')   AS scheduled,
         COALESCE(SUM(total_price_paise) FILTER (WHERE status = 'completed'), 0) AS revenue_paise,
         COALESCE(SUM(water_saved_litres) FILTER (WHERE status = 'completed'), 0) AS water_saved_litres,
         COALESCE(AVG(total_price_paise) FILTER (WHERE status = 'completed'), 0)::INT AS avg_ticket_paise,
         (
           COUNT(*) FILTER (WHERE status = 'completed' AND jsonb_array_length(COALESCE(addons_completed, '[]'::jsonb)) > 0)::FLOAT
           / NULLIF(COUNT(*) FILTER (WHERE status = 'completed'), 0)
         ) * 100 AS addon_conversion_pct
       FROM jobs
       WHERE job_type = 'auto_wash'
         AND scheduled_at >= $1 AND scheduled_at < $2`,
      [today, tomorrow]
    );
    return rows[0];
  },

  adminSubscriptionMRR: async () => {
    const { rows } = await query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'active') AS active_count,
         COALESCE(SUM(price_per_cycle_paise) FILTER (WHERE status = 'active'), 0) AS mrr_paise
       FROM auto_subscriptions`
    );
    return rows[0];
  },

  adminListJobs: async ({ status, fromDate, toDate, limit = 100, offset = 0 } = {}) => {
    const conditions = [`j.job_type = 'auto_wash'`];
    const params = [];
    if (status)   { params.push(status);   conditions.push(`j.status = $${params.length}`); }
    if (fromDate) { params.push(fromDate); conditions.push(`j.scheduled_at >= $${params.length}`); }
    if (toDate)   { params.push(toDate);   conditions.push(`j.scheduled_at <= $${params.length}`); }
    params.push(limit, offset);
    const { rows } = await query(
      `SELECT j.id, j.status, j.scheduled_at, j.completed_at,
              j.service_package, j.total_price_paise,
              j.gated_community,
              v.vehicle_type, v.registration_number,
              c.id AS customer_id, c.name AS customer_name, c.phone AS customer_phone,
              t.id AS crew_id, t.name AS crew_name,
              e.unit_code AS ev_unit_code
         FROM jobs j
         LEFT JOIN vehicles v  ON v.id = j.vehicle_id
         LEFT JOIN users    c  ON c.id = j.customer_id
         LEFT JOIN users    t  ON t.id = j.assigned_team_id
         LEFT JOIN ev_units e  ON e.id = j.ev_unit_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY j.scheduled_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return rows;
  },

  adminAssignJobToCrew: async (jobId, crewId, evUnitId = null) => {
    const { rows } = await query(
      `UPDATE jobs
          SET assigned_team_id = $2,
              ev_unit_id = COALESCE($3, ev_unit_id),
              updated_at = NOW()
        WHERE id = $1 AND job_type = 'auto_wash'
        RETURNING id, assigned_team_id, ev_unit_id, status`,
      [jobId, crewId, evUnitId]
    );
    return rows[0] || null;
  },

  adminAddonAnalytics: async ({ fromDate = null } = {}) => {
    const params = [];
    let clause = `job_type = 'auto_wash' AND status = 'completed'`;
    if (fromDate) { params.push(fromDate); clause += ` AND completed_at >= $${params.length}`; }
    // Unnest addons_completed and aggregate.
    const { rows } = await query(
      `SELECT addon_code, COUNT(*) AS times_sold,
              SUM(j.total_price_paise) / COUNT(*) AS avg_job_value_paise
         FROM (
           SELECT id, total_price_paise, jsonb_array_elements_text(COALESCE(addons_completed, '[]'::jsonb)) AS addon_code
             FROM jobs
            WHERE ${clause}
         ) addon_rows
         JOIN jobs j ON j.id = addon_rows.id
         GROUP BY addon_code
         ORDER BY times_sold DESC`,
      params
    );
    return rows;
  },

  /* ── EV units (for admin) ────────────────────────────────────────────── */

  listEvUnits: async () => {
    const { rows } = await query(
      `SELECT id, unit_code, registration_number, model, status,
              hub_location, battery_capacity_kwh, range_km,
              last_service_date, next_service_due_km, assigned_crew_id
         FROM ev_units
        ORDER BY unit_code ASC`
    );
    return rows;
  },
};

module.exports = AutoWashRepository;
