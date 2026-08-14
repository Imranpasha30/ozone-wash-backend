/**
 * Field Ops service — Field App SOP v2 (Developer Handout v2.0).
 *
 * Implements the server-enforced safety-gate layer:
 *   Van checks (Phase 0)        → gate G-0: no job can start until the shift
 *                                 van check is complete
 *   Confined-space gas check    → gate G-3: underground/sump jobs blocked
 *                                 until a PASS gas reading exists
 *   Water readings (Ph 2 & 5)   → numeric, append-only, BIS-flagged, with
 *                                 server-computed deltas; ORP certificate
 *                                 gate; final dissolved-O₃ hard gate (G-10)
 *   Ozone sessions (Phase 4)    → pre-ozone checklist (G-5), min-duration
 *                                 stop lock (G-6), ambient O₃ (G-7) and
 *                                 dissolved O₃ (G-8) gates with HTTP 423 +
 *                                 retry_after_minutes semantics
 *   Closure (Phase 7 & 8)       → payment collection, AMC interest → admin
 *                                 lead, daily MIS submission
 *
 * Every gate here is enforced at the API level — the app UI mirrors them but
 * cannot bypass them.
 */
const db = require('../../config/db');
const JobRepository = require('../jobs/job.repository');
const AdminAlertsService = require('../admin-alerts/admin-alerts.service');
const NotificationService = require('../../services/notification.service');

/* ── Constants (spec §3, §10) ─────────────────────────────────────── */

// 13-item van equipment checklist (Phase 0, step 0.2)
const VAN_EQUIPMENT_ITEMS = [
  'ozone_generator', 'o2_cylinder', 'pressure_washer', 'vacuum_pump',
  'ph_meter', 'orp_meter', 'tds_meter', 'turbidity_meter',
  'dissolved_o3_meter', 'ppe_kits', 'safety_harness', 'ventilation_fan',
  'first_aid_kit',
];

// Ozone minimum durations by tank size (step 4.4)
const OZONE_MIN_DURATIONS = [
  { maxLitres: 1000,   minutes: 15 },
  { maxLitres: 2000,   minutes: 15 },
  { maxLitres: 5000,   minutes: 20 },
  { maxLitres: 10000,  minutes: 25 },
  { maxLitres: 25000,  minutes: 35 },
  { maxLitres: 50000,  minutes: 50 },
  { maxLitres: Infinity, minutes: 90 },
];

// Water reading validation ranges + BIS IS 10500 compliance (spec §10)
const READING_SPECS = {
  pH:            { unit: 'pH',   min: 0,    max: 14,    bis: (v) => v >= 6.5 && v <= 8.5 },
  TDS:           { unit: 'ppm',  min: 0,    max: 9999,  bis: (v) => v <= 500 },
  ORP:           { unit: 'mV',   min: -500, max: 1000,  bis: () => null },  // no BIS standard
  turbidity:     { unit: 'NTU',  min: 0,    max: 999.9, bis: (v) => v <= 1 },
  dissolved_o3:  { unit: 'mg/L', min: 0,    max: 20,    bis: (v) => v < 0.05 },
  dissolved_o3_final: { unit: 'mg/L', min: 0, max: 20,  bis: (v) => v < 0.05 },
};
const BEFORE_PARAMS = ['pH', 'TDS', 'ORP', 'turbidity', 'dissolved_o3'];
const AFTER_PARAMS  = ['pH', 'TDS', 'ORP', 'turbidity', 'dissolved_o3_final'];

const ORP_GOLD_THRESHOLD = 650;       // mV — below → certificate capped Silver
const AMBIENT_O3_LIMIT   = 0.1;       // ppm  (G-7)
const DISSOLVED_O3_LIMIT = 0.05;      // mg/L (G-8, G-10)
const RETRY_AFTER_MIN    = 10;

// Admin-configurable thresholds (spec §10: "configurable in admin settings").
// app_settings.water_thresholds overrides the constants above; 60 s cache.
let _thr = null, _thrAt = 0;
async function thresholds() {
  if (_thr && Date.now() - _thrAt < 60_000) return _thr;
  try {
    const { rows } = await db.query(`SELECT value FROM app_settings WHERE key = 'water_thresholds'`);
    _thr = rows[0]?.value || {};
  } catch { _thr = _thr || {}; }
  _thrAt = Date.now();
  return _thr;
}
const invalidateThresholds = () => { _thr = null; };

const err = (status, message, extra = {}) => ({ status, message, ...extra });

/** Job must exist + belong to this agent. */
async function ownedJob(jobId, agentId) {
  const job = await JobRepository.findById(jobId);
  if (!job) throw err(404, 'Job not found.');
  if (job.assigned_team_id !== agentId) throw err(403, 'This job is not assigned to you.');
  return job;
}

const FieldOpsService = {

  /* ══ VAN CHECKS (Phase 0 — gate G-0) ══════════════════════════════ */

  getTodayVanCheck: async (agentId) => {
    const { rows } = await db.query(
      `SELECT * FROM van_checks WHERE agent_id = $1 AND shift_date = CURRENT_DATE`,
      [agentId]
    );
    return rows[0] || null;
  },

  /** Create-or-update today's van check; evaluates completion server-side. */
  upsertVanCheck: async (agentId, data) => {
    const existing = await FieldOpsService.getTodayVanCheck(agentId);

    const merged = {
      equipment_checklist: data.equipment_checklist ?? existing?.equipment_checklist ?? {},
      calibration_dates:   data.calibration_dates   ?? existing?.calibration_dates   ?? {},
      ppe_photo_url:       data.ppe_photo_url       ?? existing?.ppe_photo_url       ?? null,
      o2_pressure_bar:     data.o2_pressure_bar     ?? existing?.o2_pressure_bar     ?? null,
      water_tank_litres:   data.water_tank_litres   ?? existing?.water_tank_litres   ?? null,
    };

    // ── Completion rules (steps 0.2–0.6) ──
    const allEquipment = VAN_EQUIPMENT_ITEMS.every((k) => merged.equipment_checklist?.[k] === true);
    const calOk = ['ph_meter', 'dissolved_o3', 'turbidity'].every((m) => {
      const d = merged.calibration_dates?.[m];
      if (!d) return false;
      const diffDays = (Date.now() - new Date(d).getTime()) / 86400000;
      return diffDays >= -1 && diffDays < 2; // today or yesterday
    });
    const o2Ok = Number(merged.o2_pressure_bar) > 40;
    const o2Warn = Number(merged.o2_pressure_bar) > 20 && Number(merged.o2_pressure_bar) <= 40;
    const waterOk = Number(merged.water_tank_litres) > 100;
    const complete = allEquipment && calOk && !!merged.ppe_photo_url && (o2Ok || o2Warn) && waterOk;

    // O₂ < 20 bar → block shift + admin alert (step 0.5)
    if (merged.o2_pressure_bar != null && Number(merged.o2_pressure_bar) <= 20) {
      AdminAlertsService.recordO2Low?.({ agentId, bar: merged.o2_pressure_bar });
      try {
        const Repo = require('../admin-alerts/admin-alerts.repository');
        await Repo.create({
          type: 'o2_refill_needed', severity: 'critical',
          title: 'O₂ refill needed',
          message: `Van O₂ cylinder at ${merged.o2_pressure_bar} bar — below 20 bar minimum. Arrange refill before shift.`,
          related_team_id: agentId,
          metadata: { o2_pressure_bar: merged.o2_pressure_bar },
        });
      } catch (e) { console.warn('[field-ops] o2 alert failed:', e?.message); }
    }

    const { rows } = await db.query(
      `INSERT INTO van_checks (agent_id, shift_date, equipment_checklist, calibration_dates,
                               ppe_photo_url, o2_pressure_bar, water_tank_litres,
                               van_check_complete, completed_at, updated_at)
       VALUES ($1, CURRENT_DATE, $2::jsonb, $3::jsonb, $4, $5, $6, $7, CASE WHEN $7 THEN NOW() ELSE NULL END, NOW())
       ON CONFLICT (agent_id, shift_date) DO UPDATE SET
         equipment_checklist = $2::jsonb,
         calibration_dates   = $3::jsonb,
         ppe_photo_url       = $4,
         o2_pressure_bar     = $5,
         water_tank_litres   = $6,
         van_check_complete  = $7,
         completed_at        = CASE WHEN $7 AND van_checks.completed_at IS NULL THEN NOW() ELSE van_checks.completed_at END,
         updated_at          = NOW()
       RETURNING *`,
      [agentId, JSON.stringify(merged.equipment_checklist), JSON.stringify(merged.calibration_dates),
       merged.ppe_photo_url, merged.o2_pressure_bar, merged.water_tank_litres, complete]
    );

    return {
      ...rows[0],
      checks: {
        equipment_ok: allEquipment,
        calibration_ok: calOk,
        ppe_photo_ok: !!merged.ppe_photo_url,
        o2_ok: o2Ok, o2_warning: o2Warn,
        o2_blocked: merged.o2_pressure_bar != null && Number(merged.o2_pressure_bar) <= 20,
        water_ok: waterOk,
      },
      equipment_items: VAN_EQUIPMENT_ITEMS,
    };
  },

  /** Post-job O₂ log (step 8.3) — refill alert when < 20 bar. */
  logPostJobO2: async (agentId, bar) => {
    const n = Number(bar);
    if (!Number.isFinite(n) || n < 0 || n > 300) throw err(400, 'O₂ pressure must be 0–300 bar.');
    await db.query(
      `UPDATE van_checks SET o2_pressure_post_job_bar = $1, updated_at = NOW()
        WHERE agent_id = $2 AND shift_date = CURRENT_DATE`,
      [n, agentId]
    );
    if (n < 20) {
      try {
        const Repo = require('../admin-alerts/admin-alerts.repository');
        await Repo.create({
          type: 'o2_refill_needed', severity: 'warning',
          title: 'O₂ refill needed',
          message: `Post-job O₂ cylinder at ${n} bar. Arrange refill before next shift.`,
          related_team_id: agentId, metadata: { o2_pressure_bar: n },
        });
      } catch (_) {}
    }
    return { o2_pressure_post_job_bar: n, refill_needed: n < 20 };
  },

  /** Gate G-0 helper — used by job.service before start-OTP. */
  isVanCheckComplete: async (agentId) => {
    const vc = await FieldOpsService.getTodayVanCheck(agentId);
    return !!vc?.van_check_complete;
  },

  /* ══ SAFETY CHECKS (G-3 gas, G-5 pre-ozone) ═══════════════════════ */

  /** Confined-space gas check (step 1.7). FAIL blocks steps + critical alert. */
  submitGasCheck: async (agentId, jobId, { gas_o2_pct, gas_o3_ppm, gas_h2s_ppm, gas_co_ppm }) => {
    const job = await ownedJob(jobId, agentId);

    const o2 = Number(gas_o2_pct), o3 = Number(gas_o3_ppm);
    const h2s = Number(gas_h2s_ppm), co = Number(gas_co_ppm);
    for (const [k, v] of Object.entries({ gas_o2_pct: o2, gas_o3_ppm: o3, gas_h2s_ppm: h2s, gas_co_ppm: co })) {
      if (!Number.isFinite(v)) throw err(400, `${k} is required and must be numeric.`);
    }

    const failures = [];
    if (o2 < 19.5 || o2 > 23.5) failures.push(`O₂ ${o2}% (safe: 19.5–23.5%)`);
    if (o3 >= 0.1)              failures.push(`O₃ ${o3} ppm (must be <0.1)`);
    if (h2s > 0)                failures.push(`H₂S ${h2s} ppm (must be 0)`);
    if (co > 0)                 failures.push(`CO ${co} ppm (must be 0)`);
    const result = failures.length ? 'FAIL' : 'PASS';

    const { rows } = await db.query(
      `INSERT INTO safety_checks (job_id, agent_id, check_type, gas_o2_pct, gas_o3_ppm, gas_h2s_ppm, gas_co_ppm, result, fail_reason)
       VALUES ($1, $2, 'confined_space_gas', $3, $4, $5, $6, $7, $8) RETURNING *`,
      [jobId, agentId, o2, o3, h2s, co, result, failures.join('; ') || null]
    );

    if (result === 'FAIL') {
      try {
        const Repo = require('../admin-alerts/admin-alerts.repository');
        await Repo.create({
          type: 'gas_check_failed', severity: 'critical',
          title: 'SAFETY: confined-space gas check FAILED',
          message: `Gas check failed on job ${String(jobId).slice(0, 8)} — ${failures.join('; ')}. Crew instructed to ventilate and recheck.`,
          related_job_id: jobId, related_team_id: agentId,
          metadata: { o2, o3, h2s, co },
        });
      } catch (_) {}
    }

    return {
      ...rows[0],
      blocked: result === 'FAIL',
      instruction: result === 'FAIL' ? 'Ventilate and recheck. All readings must be in safe range before continuing.' : null,
    };
  },

  /** Latest confined-space gas result (gate helper for compliance steps). */
  latestGasResult: async (jobId) => {
    const { rows } = await db.query(
      `SELECT result FROM safety_checks
        WHERE job_id = $1 AND check_type = 'confined_space_gas'
        ORDER BY checked_at DESC LIMIT 1`,
      [jobId]
    );
    return rows[0]?.result || null;
  },

  /** Pre-ozone 4-item safety checklist (step 4.1, gate G-5). */
  submitPreOzoneChecklist: async (agentId, jobId, checklist = {}) => {
    await ownedJob(jobId, agentId);
    const REQUIRED = ['respirators', 'monitors', 'bystanders_clear', 'customer_notified'];
    const missing = REQUIRED.filter((k) => checklist[k] !== true);
    if (missing.length) {
      throw err(400, `All 4 pre-ozone safety items must be confirmed. Missing: ${missing.join(', ')}`);
    }
    const { rows } = await db.query(
      `INSERT INTO safety_checks (job_id, agent_id, check_type, ppe_checklist, result)
       VALUES ($1, $2, 'pre_ozone_ppe', $3::jsonb, 'PASS') RETURNING *`,
      [jobId, agentId, JSON.stringify(checklist)]
    );
    return rows[0];
  },

  /* ══ OZONE SESSIONS (Phase 4 — gates G-5..G-8) ════════════════════ */

  minDurationFor: (litres) =>
    OZONE_MIN_DURATIONS.find((d) => Number(litres || 0) <= d.maxLitres).minutes,

  activeSession: async (jobId) => {
    const { rows } = await db.query(
      `SELECT * FROM ozone_sessions WHERE job_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [jobId]
    );
    return rows[0] || null;
  },

  /** Start ozone (step 4.2). Requires pre-ozone checklist PASS (G-5). */
  startOzoneSession: async (agentId, jobId, { tank_size_litres, setup_photo_url }) => {
    const job = await ownedJob(jobId, agentId);
    if (job.status !== 'in_progress') throw err(400, 'Job must be in progress.');
    if (job.paused) throw err(423, 'Job is paused after a critical incident. Contact admin.');

    // G-5: pre-ozone checklist must exist and PASS
    const { rows: pre } = await db.query(
      `SELECT id FROM safety_checks WHERE job_id = $1 AND check_type = 'pre_ozone_ppe' AND result = 'PASS' LIMIT 1`,
      [jobId]
    );
    if (!pre.length) throw err(423, 'Pre-ozone safety checklist not confirmed. Complete all 4 safety items first.');

    const existing = await FieldOpsService.activeSession(jobId);
    if (existing && !existing.stopped_at) {
      return { ...existing, resumed: true }; // idempotent — session already running
    }

    const litres = Number(tank_size_litres) || Number(job.tank_size_litres) || 1000;
    const target = FieldOpsService.minDurationFor(litres);

    const { rows } = await db.query(
      `INSERT INTO ozone_sessions (job_id, agent_id, tank_size_litres, target_duration_min, setup_photo_url)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [jobId, agentId, litres, target, setup_photo_url || null]
    );

    // Auto-trigger: customer "do not approach" warning (server-side)
    if (job.customer_phone) {
      NotificationService.sendWhatsApp(job.customer_phone, 'ozone_active', [
        { name: 'duration', value: String(target) },
      ]).catch(() => {});
    }

    return { ...rows[0], countdown_seconds: target * 60 };
  },

  /** Extend timer with reason (step 4.4). */
  extendOzoneSession: async (agentId, jobId, { extra_minutes, reason }) => {
    await ownedJob(jobId, agentId);
    const session = await FieldOpsService.activeSession(jobId);
    if (!session || session.stopped_at) throw err(400, 'No running ozone session.');
    const extra = Math.max(1, Math.min(120, Math.floor(Number(extra_minutes) || 0)));
    if (!reason?.trim()) throw err(400, 'Extension reason is required.');
    const { rows } = await db.query(
      `UPDATE ozone_sessions SET extended_duration_min = extended_duration_min + $1,
              extension_reason = COALESCE(extension_reason || ' | ', '') || $2
        WHERE id = $3 RETURNING *`,
      [extra, reason.trim(), session.id]
    );
    return rows[0];
  },

  /** Stop generator (step 4.5) — SERVER blocks before minimum time (G-6). */
  stopOzoneSession: async (agentId, jobId) => {
    await ownedJob(jobId, agentId);
    const session = await FieldOpsService.activeSession(jobId);
    if (!session) throw err(400, 'No ozone session started.');
    if (session.stopped_at) return session; // idempotent

    const requiredMin = Number(session.target_duration_min) + Number(session.extended_duration_min || 0);
    const elapsedMin = (Date.now() - new Date(session.started_at).getTime()) / 60000;
    if (elapsedMin < requiredMin) {
      throw err(423, `Ozone minimum duration not reached. ${Math.ceil(requiredMin - elapsedMin)} minute(s) remaining.`, {
        retry_after_minutes: Math.ceil(requiredMin - elapsedMin),
      });
    }

    const { rows } = await db.query(
      `UPDATE ozone_sessions SET stopped_at = NOW(),
              actual_duration_min = ROUND(EXTRACT(EPOCH FROM (NOW() - started_at)) / 60)
        WHERE id = $1 RETURNING *`,
      [session.id]
    );
    return { ...rows[0], venting_minutes: 15, instruction: 'Start the 12V fan at the manhole opening now.' };
  },

  /** Fan running confirm (step 4.6) — starts the 15-min venting lock. */
  confirmFan: async (agentId, jobId) => {
    await ownedJob(jobId, agentId);
    const session = await FieldOpsService.activeSession(jobId);
    if (!session || !session.stopped_at) throw err(400, 'Stop the ozone generator first.');
    if (session.fan_started_at) return session;
    const { rows } = await db.query(
      `UPDATE ozone_sessions SET fan_started_at = NOW() WHERE id = $1 RETURNING *`,
      [session.id]
    );
    return { ...rows[0], venting_unlock_at: new Date(Date.now() + 15 * 60000).toISOString() };
  },

  /**
   * Ozone safety readings (steps 4.7 / 4.8) — HARD GATES G-7 / G-8.
   * kind = 'ambient' (ppm, <0.1) | 'dissolved' (mg/L, <0.05).
   * Fail → HTTP 423 + retry_after_minutes. Both must PASS to unlock refill.
   */
  submitOzoneSafetyReading: async (agentId, jobId, { kind, value }) => {
    const job = await ownedJob(jobId, agentId);
    const session = await FieldOpsService.activeSession(jobId);
    if (!session) throw err(400, 'No ozone session for this job.');
    if (!session.stopped_at) throw err(400, 'Stop the ozone generator before taking safety readings.');
    if (!session.fan_started_at) throw err(400, 'Confirm the 12V venting fan is running first.');

    // 15-minute venting lock after fan start (step 4.6)
    const ventElapsedMin = (Date.now() - new Date(session.fan_started_at).getTime()) / 60000;
    if (ventElapsedMin < 15) {
      throw err(423, `Venting in progress. Wait ${Math.ceil(15 - ventElapsedMin)} more minute(s) before the safety reading.`, {
        retry_after_minutes: Math.ceil(15 - ventElapsedMin),
      });
    }

    const v = Number(value);
    if (!Number.isFinite(v) || v < 0) throw err(400, 'Reading value must be a non-negative number.');

    const isAmbient = kind === 'ambient';
    if (!isAmbient && kind !== 'dissolved') throw err(400, "kind must be 'ambient' or 'dissolved'.");
    const tt = await thresholds();
    const limit = isAmbient ? (tt.ambient_o3_max ?? AMBIENT_O3_LIMIT) : (tt.dissolved_o3_max ?? DISSOLVED_O3_LIMIT);
    const pass = v < limit;

    const col = isAmbient
      ? { val: 'ambient_o3_ppm', res: 'ambient_o3_result', at: 'ambient_o3_checked_at' }
      : { val: 'dissolved_o3_mgl', res: 'dissolved_o3_result', at: 'dissolved_o3_checked_at' };

    const { rows } = await db.query(
      `UPDATE ozone_sessions SET ${col.val} = $1, ${col.res} = $2, ${col.at} = NOW()
        WHERE id = $3 RETURNING *`,
      [v, pass ? 'PASS' : 'FAIL', session.id]
    );
    const updated = rows[0];

    if (!pass) {
      throw err(423, isAmbient
        ? `Not safe yet — ambient O₃ ${v} ppm (must be <${AMBIENT_O3_LIMIT}). Run the fan, wait ${RETRY_AFTER_MIN} min and recheck.`
        : `Not safe yet — dissolved O₃ ${v} mg/L (must be <${DISSOLVED_O3_LIMIT}). Wait ${RETRY_AFTER_MIN} min and recheck.`, {
        retry_after_minutes: RETRY_AFTER_MIN,
      });
    }

    // Both readings PASS → safety_passed (step 4.9) + customer notification
    if (updated.ambient_o3_result === 'PASS' && updated.dissolved_o3_result === 'PASS' && !updated.safety_passed) {
      await db.query(
        `UPDATE ozone_sessions SET safety_passed = TRUE, safety_passed_at = NOW() WHERE id = $1`,
        [session.id]
      );
      await db.query(
        `UPDATE jobs SET ozone_safety_passed_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [jobId]
      );
      if (job.customer_phone) {
        NotificationService.sendWhatsApp(job.customer_phone, 'ozone_complete', []).catch(() => {});
        NotificationService.sendPush?.(null, '', '').catch?.(() => {});
      }
      return { ...updated, safety_passed: true, refill_unlocked: true };
    }

    return { ...updated, refill_unlocked: updated.safety_passed === true };
  },

  /* ══ WATER READINGS (Phases 2 & 5 — gates G-4/G-9/G-10) ═══════════ */

  submitReading: async (agentId, jobId, { param, timing, value, unit, photo_url, gps_lat, gps_lng }) => {
    const job = await ownedJob(jobId, agentId);
    if (job.status !== 'in_progress') throw err(400, 'Job must be in progress (verify the start OTP first).');
    if (job.paused) throw err(423, 'Job is paused after a critical incident.');

    const spec = READING_SPECS[param];
    if (!spec) throw err(400, `Unknown param. Must be one of: ${Object.keys(READING_SPECS).join(', ')}`);
    if (!['before', 'after'].includes(timing)) throw err(400, "timing must be 'before' or 'after'.");
    if (param === 'dissolved_o3_final' && timing !== 'after') throw err(400, 'dissolved_o3_final is an after reading.');

    const v = Number(value);
    if (!Number.isFinite(v) || v < spec.min || v > spec.max) {
      throw err(400, `${param} must be between ${spec.min} and ${spec.max} ${spec.unit}.`);
    }

    // Admin-configurable BIS thresholds (fallback to spec defaults)
    const t = await thresholds();
    const bisFor = {
      pH: () => v >= (t.ph_min ?? 6.5) && v <= (t.ph_max ?? 8.5),
      TDS: () => v <= (t.tds_max ?? 500),
      ORP: () => null,
      turbidity: () => v <= (t.turbidity_max ?? 1),
      dissolved_o3: () => v < (t.dissolved_o3_max ?? 0.05),
      dissolved_o3_final: () => v < (t.dissolved_o3_max ?? 0.05),
    };

    // Delta vs before (server-computed, spec 5.2)
    let delta = null;
    if (timing === 'after') {
      const beforeParam = param === 'dissolved_o3_final' ? 'dissolved_o3' : param;
      const { rows: prev } = await db.query(
        `SELECT value FROM water_readings WHERE job_id = $1 AND param = $2 AND timing = 'before'
          ORDER BY recorded_at DESC LIMIT 1`,
        [jobId, beforeParam]
      );
      if (prev.length) delta = Math.round((v - Number(prev[0].value)) * 1000) / 1000;
    }

    const bis = bisFor[param] ? bisFor[param]() : null;

    const { rows } = await db.query(
      `INSERT INTO water_readings (job_id, agent_id, param, timing, value, unit, photo_url, delta_vs_before, bis_compliant, gps_lat, gps_lng)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [jobId, agentId, param, timing, v, unit || spec.unit, photo_url || null, delta, bis, gps_lat ?? null, gps_lng ?? null]
    );
    const reading = rows[0];

    const flags = { bis_compliant: bis, delta_vs_before: delta };

    // ★ ORP certificate gate (step 5.4): after-ORP < threshold → cap Silver + admin alert
    const ORP_MIN = t.orp_gold_min ?? ORP_GOLD_THRESHOLD;
    if (param === 'ORP' && timing === 'after') {
      if (v < ORP_MIN) {
        await db.query(`UPDATE jobs SET orp_gate_failed = TRUE, updated_at = NOW() WHERE id = $1`, [jobId]);
        try {
          const Repo = require('../admin-alerts/admin-alerts.repository');
          await Repo.create({
            type: 'orp_below_target', severity: 'warning',
            title: 'ORP below 650 mV after ozone',
            message: `Job ${String(jobId).slice(0, 8)}: after-ORP ${v} mV (<650). Certificate capped at Silver. Crew prompted to recheck in 10 min.`,
            related_job_id: jobId, related_team_id: agentId, metadata: { orp: v },
          });
        } catch (_) {}
        flags.certificate_grade_capped = 'SILVER';
        flags.recheck_prompt = 'Recheck ORP in 10 min — ozone effectiveness not yet confirmed.';
      } else {
        await db.query(`UPDATE jobs SET orp_gate_failed = FALSE, updated_at = NOW() WHERE id = $1`, [jobId]);
        flags.ozone_effectiveness_confirmed = true;
      }
    }

    // ★ Final dissolved O₃ HARD gate (step 5.6, G-10): ≥ limit blocks Stop OTP
    if (param === 'dissolved_o3_final') {
      const safe = v < (t.dissolved_o3_max ?? DISSOLVED_O3_LIMIT);
      await db.query(`UPDATE jobs SET o3_final_safe = $1, updated_at = NOW() WHERE id = $2`, [safe, jobId]);
      flags.o3_final_safe = safe;
      if (!safe) {
        throw err(423, `Not safe for consumption — dissolved O₃ ${v} mg/L (must be <${DISSOLVED_O3_LIMIT}). Wait and recheck; the Stop OTP stays locked.`, {
          retry_after_minutes: RETRY_AFTER_MIN, reading,
        });
      }
    }

    return { reading, ...flags };
  },

  getReadings: async (jobId) => {
    const { rows } = await db.query(
      `SELECT * FROM water_readings WHERE job_id = $1 ORDER BY recorded_at ASC`,
      [jobId]
    );
    // Latest reading per param+timing wins (append-only → rechecks add rows)
    const latest = {};
    for (const r of rows) latest[`${r.param}:${r.timing}`] = r;
    return { all: rows, latest: Object.values(latest) };
  },

  /** Gate helpers — used by compliance (G-4) and end-OTP (G-9/G-10). */
  beforeReadingsComplete: async (jobId) => {
    const { rows } = await db.query(
      `SELECT DISTINCT param FROM water_readings WHERE job_id = $1 AND timing = 'before'`, [jobId]
    );
    const have = rows.map((r) => r.param);
    const missing = BEFORE_PARAMS.filter((p) => !have.includes(p));
    return { complete: missing.length === 0, missing };
  },

  afterReadingsComplete: async (jobId) => {
    const { rows } = await db.query(
      `SELECT DISTINCT param FROM water_readings WHERE job_id = $1 AND timing = 'after'`, [jobId]
    );
    const have = rows.map((r) => r.param);
    const missing = AFTER_PARAMS.filter((p) => !have.includes(p));
    return { complete: missing.length === 0, missing };
  },

  /* ══ COMPARISON VIEW (step 7.1) ═══════════════════════════════════ */

  comparisonView: async (jobId, userId, userRole) => {
    const job = await JobRepository.findById(jobId);
    if (!job) throw err(404, 'Job not found.');
    if (userRole === 'customer' && job.customer_id !== userId) throw err(403, 'Access denied.');
    if (userRole === 'field_team' && job.assigned_team_id !== userId) throw err(403, 'Access denied.');

    const { latest } = await FieldOpsService.getReadings(jobId);
    const byParam = {};
    for (const r of latest) {
      const key = r.param === 'dissolved_o3_final' ? 'dissolved_o3' : r.param;
      byParam[key] = byParam[key] || {};
      byParam[key][r.timing] = { value: Number(r.value), unit: r.unit, photo_url: r.photo_url, bis_compliant: r.bis_compliant };
      if (r.timing === 'after' && r.delta_vs_before != null) byParam[key].delta = Number(r.delta_vs_before);
    }

    const { rows: photos } = await db.query(
      `SELECT step_number, step_name, photo_before_url, photo_after_url
         FROM compliance_logs WHERE job_id = $1 ORDER BY step_number ASC`,
      [jobId]
    );

    return { job_id: jobId, readings: byParam, step_photos: photos };
  },

  /* ══ CLOSURE (Phase 7 & 8) ════════════════════════════════════════ */

  /**
   * On-site tank details confirm/correct (step 1.5). If the details differ
   * from the booking, a change reason is MANDATORY, admin is alerted, and a
   * fresh price quote is attached for reconciliation.
   */
  confirmTank: async (agentId, jobId, { tank_type, tank_capacity_litres, tank_count, reason }) => {
    const job = await ownedJob(jobId, agentId);
    if (job.status !== 'in_progress') throw err(400, 'Verify the start OTP before confirming tank details.');

    const type = String(tank_type || '').toLowerCase();
    if (!['overhead', 'underground', 'sump', 'sintex', 'hdpe', 'ss', 'rcc', 'other'].includes(type)) {
      throw err(400, 'Invalid tank type.');
    }
    const litres = Math.floor(Number(tank_capacity_litres));
    const count = Math.max(1, Math.floor(Number(tank_count) || 1));
    if (!Number.isFinite(litres) || litres <= 0) throw err(400, 'Tank capacity (litres) is required.');

    // Compare against the booking's values to detect a change
    let booking = null;
    let changed = false;
    if (job.booking_id) {
      const BookingRepository = require('../bookings/booking.repository');
      booking = await BookingRepository.findById(job.booking_id);
      if (booking) {
        const bookedCount = Array.isArray(booking.tanks) && booking.tanks.length ? booking.tanks.length : 1;
        changed = Number(booking.tank_size_litres) !== litres
          || String(booking.tank_type) !== type
          || bookedCount !== count;
      }
    }
    if (changed && !reason?.trim()) {
      throw err(400, 'Tank details differ from the booking — a change reason is mandatory.');
    }

    await db.query(
      `UPDATE jobs SET tank_type = $1, tank_capacity_litres = $2, tank_count = $3,
              tank_change_reason = $4, tank_confirmed_at = NOW(), updated_at = NOW()
        WHERE id = $5`,
      [type, litres, count, changed ? reason.trim() : null, jobId]
    );

    // Changed → repricing quote + admin alert (spec: pricing recalc trigger)
    let newQuote = null;
    if (changed && booking) {
      try {
        const PricingService = require('../../services/pricing');
        const plan = PricingService.normalizePlan(booking.plan) || 'one_time';
        newQuote = await PricingService.quoteInvoice({
          tanks: Array(count).fill(litres),
          plan,
          addon_codes: booking.addons || [],
        });
        const Repo = require('../admin-alerts/admin-alerts.repository');
        await Repo.create({
          type: 'tank_details_changed', severity: 'warning',
          title: 'Tank details corrected on site',
          message: `Job ${String(jobId).slice(0, 8)}: crew corrected tank to ${count} × ${litres} L (${type}). ` +
            `Reason: ${reason.trim()}. Booked invoice Rs.${((booking.amount_paise || 0) / 100).toFixed(0)} vs ` +
            `re-quoted Rs.${(newQuote.invoice_total_paise / 100).toFixed(0)} — reconcile with the customer.`,
          related_job_id: jobId, related_booking_id: job.booking_id, related_team_id: agentId,
          metadata: { litres, count, type, reason: reason.trim(), requoted_paise: newQuote.invoice_total_paise, booked_paise: booking.amount_paise },
        });
      } catch (e) { console.warn('[field-ops] tank repricing alert failed:', e?.message); }
    }

    return { confirmed: true, changed, new_quote: newQuote };
  },

  /** Pre-existing damage log (step 1.6). */
  logPreDamage: async (agentId, jobId, { level, notes, photo_url }) => {
    const job = await ownedJob(jobId, agentId);
    if (!['none', 'minor', 'major'].includes(level)) throw err(400, 'level must be none, minor or major.');
    if (level !== 'none' && !photo_url) throw err(400, 'Photo is mandatory for minor/major damage.');

    await db.query(
      `UPDATE jobs SET pre_damage_level = $1, pre_damage_notes = $2, pre_damage_photo_url = $3, updated_at = NOW()
        WHERE id = $4`,
      [level, notes || null, photo_url || null, jobId]
    );

    if (level === 'major') {
      try {
        const Repo = require('../admin-alerts/admin-alerts.repository');
        await Repo.create({
          type: 'pre_damage_major', severity: 'warning',
          title: 'Major pre-existing damage logged',
          message: `Crew logged MAJOR pre-existing tank damage on job ${String(jobId).slice(0, 8)} before starting work. ${notes || ''}`.trim(),
          related_job_id: jobId, related_team_id: agentId,
          metadata: { level, photo_url },
        });
      } catch (_) {}
    }
    return { job_id: jobId, pre_damage_level: level };
  },

  /** Payment collection at job end (step 7.2) — field crew collects UPI/cash. */
  collectPayment: async (agentId, jobId, { method, amount_paise }) => {
    const job = await ownedJob(jobId, agentId);
    if (!job.booking_id) throw err(400, 'No booking linked to this job.');
    if (!['upi', 'cash'].includes(method)) throw err(400, "method must be 'upi' or 'cash'.");

    const BookingRepository = require('../bookings/booking.repository');
    const booking = await BookingRepository.findById(job.booking_id);
    if (!booking) throw err(404, 'Booking not found.');

    if (booking.payment_status === 'paid') {
      return { already_paid: true, method: 'prepaid', message: 'Booking is pre-paid — collection auto-skipped.' };
    }

    const due = Number(booking.amount_paise) || 0;
    const collected = Math.floor(Number(amount_paise));
    if (!Number.isFinite(collected) || collected <= 0) throw err(400, 'amount_paise is required.');
    if (collected < due) {
      throw err(400, `Under-payment: collected ₹${collected / 100} but invoice is ₹${due / 100}. Cannot mark paid.`);
    }
    const overpaid = collected > due;

    await BookingRepository.updatePayment(job.booking_id, {
      razorpay_order_id: booking.razorpay_order_id,
      razorpay_payment_id: `field_${method}_${Date.now()}`,
      payment_status: 'paid',
    });
    await db.query(
      `UPDATE jobs SET payment_collected_method = $1, payment_collected_at = NOW(), updated_at = NOW() WHERE id = $2`,
      [method, jobId]
    );

    if (overpaid) {
      try {
        const Repo = require('../admin-alerts/admin-alerts.repository');
        await Repo.create({
          type: 'payment_overpaid', severity: 'info',
          title: 'Over-payment collected',
          message: `Job ${String(jobId).slice(0, 8)}: collected ₹${collected / 100} vs invoice ₹${due / 100} (${method}).`,
          related_job_id: jobId, related_booking_id: job.booking_id, related_team_id: agentId,
          metadata: { collected, due, method },
        });
      } catch (_) {}
    }

    // Invoice WhatsApp to the customer (spec ow_invoice)
    if (job.customer_phone) {
      NotificationService.sendWhatsApp(job.customer_phone, 'invoice_sent', [
        { name: 'job_id', value: String(jobId).slice(0, 8) },
        { name: 'amount', value: (due / 100).toFixed(2) },
        { name: 'payment_method', value: method.toUpperCase() },
      ]).catch(() => {});
    }

    return { paid: true, method, amount_paise: collected, overpaid };
  },

  /** AMC interest + review request (steps 7.3 / 7.4). */
  logCloseout: async (agentId, jobId, { amc_interest, review_requested }) => {
    const job = await ownedJob(jobId, agentId);
    if (!['signed_up', 'interested', 'not_interested'].includes(amc_interest)) {
      throw err(400, 'amc_interest must be signed_up, interested or not_interested.');
    }
    await db.query(
      `UPDATE jobs SET amc_interest = $1, review_requested = $2, updated_at = NOW() WHERE id = $3`,
      [amc_interest, review_requested === true, jobId]
    );

    // CRM follow-up task → admin alerts inbox (due 24h)
    if (amc_interest === 'interested') {
      try {
        const Repo = require('../admin-alerts/admin-alerts.repository');
        await Repo.create({
          type: 'amc_lead', severity: 'info',
          title: 'AMC follow-up lead',
          message: `${job.customer_name || 'Customer'} (${job.customer_phone || 'no phone'}) is interested in an AMC after job ${String(jobId).slice(0, 8)}. Follow up within 24 hours.`,
          related_job_id: jobId, related_team_id: agentId,
          metadata: { due_hours: 24, customer_id: job.customer_id },
        });
      } catch (_) {}
    }
    return { job_id: jobId, amc_interest, review_requested: review_requested === true };
  },

  /** End-of-shift daily MIS (step 8.5) — aggregates + supervisor WhatsApp. */
  submitDailyMis: async (agentId) => {
    const { rows: agg } = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE j.status = 'completed')::int AS jobs_done,
         COALESCE(SUM(cl.water_used_litres), 0)::int         AS water_used,
         COUNT(*) FILTER (WHERE j.amc_interest IN ('interested','signed_up'))::int AS amc_leads,
         (SELECT COUNT(*)::int FROM incident_reports i
           WHERE i.reported_by = $1 AND DATE(i.created_at) = CURRENT_DATE) AS incidents,
         (SELECT ROUND(AVG(e.eco_score), 2) FROM eco_metrics_log e
           JOIN jobs j2 ON j2.id = e.job_id
          WHERE j2.assigned_team_id = $1 AND DATE(j2.completed_at) = CURRENT_DATE) AS avg_eco
       FROM jobs j
       LEFT JOIN compliance_logs cl ON cl.job_id = j.id AND cl.step_number = 4
      WHERE j.assigned_team_id = $1 AND DATE(j.scheduled_at) = CURRENT_DATE`,
      [agentId]
    );
    const a = agg[0] || {};

    // All today's jobs must be closed (spec 8.5)
    const { rows: open } = await db.query(
      `SELECT COUNT(*)::int AS n FROM jobs
        WHERE assigned_team_id = $1 AND DATE(scheduled_at) = CURRENT_DATE
          AND status IN ('scheduled', 'in_progress')`,
      [agentId]
    );
    if (open[0].n > 0) {
      throw err(400, `${open[0].n} job(s) still open today. Close all jobs before submitting the daily MIS.`);
    }

    const vc = await FieldOpsService.getTodayVanCheck(agentId);
    const o2Used = vc?.o2_pressure_bar != null && vc?.o2_pressure_post_job_bar != null
      ? Math.max(0, vc.o2_pressure_bar - vc.o2_pressure_post_job_bar) : null;

    const { rows } = await db.query(
      `INSERT INTO daily_mis (agent_id, shift_date, jobs_done, water_saved_litres, avg_eco_score, amc_leads, incidents, o2_used_bar)
       VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (agent_id, shift_date) DO UPDATE SET
         jobs_done = $2, water_saved_litres = $3, avg_eco_score = $4,
         amc_leads = $5, incidents = $6, o2_used_bar = $7, submitted_at = NOW()
       RETURNING *`,
      [agentId, a.jobs_done || 0, a.water_used || 0, a.avg_eco || null, a.amc_leads || 0, a.incidents || 0, o2Used]
    );

    // Supervisor WhatsApp digest (SUPERVISOR_PHONE from .env; dev logs)
    const supervisor = process.env.SUPERVISOR_PHONE;
    if (supervisor) {
      NotificationService.sendWhatsApp(supervisor, 'daily_mis_summary', [
        { name: 'jobs_done', value: String(a.jobs_done || 0) },
        { name: 'water_saved', value: String(a.water_used || 0) },
        { name: 'avg_ecoscore', value: String(a.avg_eco || '—') },
        { name: 'amc_leads', value: String(a.amc_leads || 0) },
        { name: 'incidents', value: String(a.incidents || 0) },
      ]).catch(() => {});
    }

    return rows[0];
  },

  VAN_EQUIPMENT_ITEMS,
  BEFORE_PARAMS,
  AFTER_PARAMS,
  READING_SPECS,
  minDurationForExport: (litres) => OZONE_MIN_DURATIONS.find((d) => Number(litres || 0) <= d.maxLitres).minutes,
  invalidateThresholds,
};

module.exports = FieldOpsService;
