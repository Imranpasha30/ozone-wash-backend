const ComplianceRepository = require('./compliance.repository');
const JobRepository = require('../jobs/job.repository');
const NotificationService = require('../../services/notification.service');

// 9-phase service SOP from FA Check List PDF.
// Stage 0 is the pre-service PPE / safety gate; Steps 1-8 are the numbered
// process steps the brand markets as the "8-step" clean. Step 7 (UV) is
// optional - the agent can mark it skipped via `uv_skipped: true`.
//
// `customer_msg_template` names a Wati BSP WhatsApp template that must be
// registered separately. If the template isn't registered, sendWhatsApp
// silently no-ops (try/catch in NotificationService) so the API call still
// succeeds.
const COMPLIANCE_STEPS = {
  0: {
    name: 'PPE & Safety Discipline',
    required_fields: [
      'ppe_list', 'ladder_check', 'electrical_check', 'emergency_kit',
      'spare_tank_water', 'fence_placed', 'danger_board',
      'photo_before_url', 'gps_lat', 'gps_lng',
    ],
    customer_msg_template: 'compliance_stage_0_complete',
  },
  1: {
    name: 'Pre-Check & Setup',
    required_fields: [
      'turbidity', 'ph_level', 'orp', 'conductivity', 'tds', 'atp',
      'photo_before_url', 'gps_lat', 'gps_lng',
    ],
    customer_msg_template: 'compliance_stage_1_complete',
  },
  2: {
    name: 'Drain & Inspect',
    required_fields: ['water_level_pct', 'tank_condition', 'volume_drained_litres', 'photo_after_url', 'gps_lat', 'gps_lng'],
    customer_msg_template: 'compliance_stage_2_complete',
  },
  3: {
    name: 'Mechanical Scrub & Rotary Jet',
    required_fields: ['scrub_completed', 'confined_entry', 'photo_after_url', 'gps_lat', 'gps_lng'],
    customer_msg_template: 'compliance_stage_3_complete',
  },
  4: {
    name: 'High-Pressure Rinse',
    required_fields: ['rinse_duration', 'water_before_litres', 'water_after_litres', 'photo_after_url', 'gps_lat', 'gps_lng'],
    customer_msg_template: 'compliance_stage_4_complete',
  },
  5: {
    name: 'Sludge Removal',
    required_fields: ['disposal_status', 'photo_after_url', 'gps_lat', 'gps_lng'],
    customer_msg_template: 'compliance_stage_5_complete',
  },
  6: {
    name: 'Ozone Disinfection',
    required_fields: ['ozone_cycle_duration', 'ozone_ppm_dosed', 'photo_before_url', 'gps_lat', 'gps_lng'],
    customer_msg_template: 'compliance_stage_6_complete',
  },
  7: {
    name: 'UV Double Lock',
    optional: true,
    required_fields: ['uv_cycle_duration', 'uv_dose', 'uv_lumines_status', 'photo_before_url', 'gps_lat', 'gps_lng'],
    customer_msg_template: 'compliance_stage_7_complete',
  },
  8: {
    name: 'After-Wash Testing & Proof Delivery',
    required_fields: [
      'turbidity', 'ph_level', 'orp', 'conductivity', 'tds', 'atp',
      'client_signature_url', 'technician_remarks', 'photo_after_url',
      'cleanup_checklist',
      'gps_lat', 'gps_lng',
    ],
    customer_msg_template: 'compliance_stage_8_complete',
  },
};

// Step-8 site clean-up items (spec 8.1) — all four must be true.
const CLEANUP_ITEMS = ['tools_loaded', 'manhole_secured', 'no_water_pooling', 'ppe_waste_bagged'];

// Safety-critical BOOLEAN toggles that must be TRUE (not just present) — the
// spec demands affirmative confirmation. NOTE: ladder_check and
// electrical_check are STATUS STRINGS in the app ("secured"/"needs
// adjustment" etc.), not booleans — they are validated for presence only.
const MUST_BE_TRUE = ['emergency_kit', 'spare_tank_water', 'fence_placed', 'danger_board', 'scrub_completed'];

// Human labels for validation messages — raw column names must never reach
// the customer/crew UI.
const FIELD_LABELS = {
  ppe_list: 'PPE items',
  ladder_check: 'Ladder safety check',
  electrical_check: 'Electrical safety check',
  emergency_kit: 'Emergency kit confirmation',
  spare_tank_water: 'Spare tank water confirmation',
  fence_placed: 'Safety fence confirmation',
  danger_board: 'Danger board confirmation',
  photo_before_url: 'Photo',
  photo_after_url: 'Photo',
  gps_lat: 'GPS location',
  gps_lng: 'GPS location',
  turbidity: 'Turbidity reading',
  ph_level: 'pH reading',
  orp: 'ORP reading',
  conductivity: 'Conductivity reading',
  tds: 'TDS reading',
  atp: 'ATP reading',
  water_level_pct: 'Water level',
  tank_condition: 'Tank condition',
  volume_drained_litres: 'Volume drained (litres)',
  scrub_completed: 'Scrub completed confirmation',
  confined_entry: 'Confined-space entry declaration',
  harness_attached: 'Safety harness confirmation',
  rinse_duration: 'Rinse duration',
  water_before_litres: 'Van tank level before (litres)',
  water_after_litres: 'Van tank level after (litres)',
  disposal_status: 'Sludge disposal status',
  ozone_cycle_duration: 'Ozone cycle duration',
  ozone_ppm_dosed: 'Ozone dose',
  uv_cycle_duration: 'UV cycle duration',
  uv_dose: 'UV dose',
  uv_lumines_status: 'UV luminescence status',
  client_signature_url: 'Customer signature',
  technician_remarks: 'Technician remarks',
  cleanup_checklist: 'Site clean-up checklist',
};
const labelFor = (field) => FIELD_LABELS[field] || field.replace(/_/g, ' ');

const STEP_NUMBERS = Object.keys(COMPLIANCE_STEPS).map(Number); // [0..8]
const TOTAL_STEPS  = STEP_NUMBERS.length;                       // 9

const ComplianceService = {

  // Get checklist for a job with completion status
  getChecklist: async (jobId) => {
    const job = await JobRepository.findById(jobId);
    if (!job) {
      throw { status: 404, message: 'Job not found.' };
    }

    const loggedSteps = await ComplianceRepository.getSteps(jobId);
    const loggedMap = {};
    loggedSteps.forEach(step => {
      loggedMap[step.step_number] = step;
    });

    // Build full 9-entry checklist (Stage 0 + Steps 1-8).
    const checklist = STEP_NUMBERS.map(stepNum => {
      const step = COMPLIANCE_STEPS[stepNum];
      const logged = loggedMap[stepNum];
      return {
        step_number: stepNum,
        step_name: step.name,
        optional: !!step.optional,
        required_fields: step.required_fields,
        completed: logged ? logged.completed : false,
        skipped: logged ? !!logged.uv_skipped : false,
        logged: !!logged,
        data: logged || null,
      };
    });

    // A skipped UV step counts as "completed" for total progress.
    const completedCount = loggedSteps.filter(s => s.completed || s.uv_skipped).length;

    return {
      job_id: jobId,
      total_steps: TOTAL_STEPS,
      completed_steps: completedCount,
      completion_percentage: Math.round((completedCount / TOTAL_STEPS) * 100),
      checklist,
    };
  },

  // Log a compliance step
  logStep: async (teamId, data) => {
    const { job_id, step_number } = data;

    if (step_number < 0 || step_number > 8) {
      throw { status: 400, message: 'Step number must be between 0 and 8.' };
    }

    const job = await JobRepository.findById(job_id);
    if (!job) {
      throw { status: 404, message: 'Job not found.' };
    }
    if (job.assigned_team_id !== teamId) {
      throw { status: 403, message: 'This job is not assigned to you.' };
    }
    if (job.status === 'cancelled') {
      throw { status: 400, message: 'Cannot log compliance for a cancelled job.' };
    }
    if (job.status === 'completed') {
      throw { status: 400, message: 'Cannot log compliance for a completed job.' };
    }
    // Gate G-2 (server-side): the start OTP must be verified — no step can be
    // logged while the job is still 'scheduled'.
    if (job.status !== 'in_progress') {
      throw { status: 423, message: 'Start OTP not verified. Verify the customer start OTP before logging steps. (Gate G-2)' };
    }
    if (job.paused) {
      throw { status: 423, message: 'Job is paused after a critical incident. Contact admin to resume.' };
    }

    // Server-side SEQUENCE gate: every previous non-optional step must already
    // be logged (UI ordering alone is bypassable via direct API calls).
    if (step_number > 0) {
      const logged = await ComplianceRepository.getSteps(job_id);
      const done = new Set(logged.filter((s) => s.completed || s.uv_skipped).map((s) => s.step_number));
      const missingPrev = STEP_NUMBERS.filter(
        (n) => n < step_number && !COMPLIANCE_STEPS[n].optional && !done.has(n)
      );
      if (missingPrev.length) {
        throw { status: 423, message: `Complete step(s) ${missingPrev.join(', ')} before step ${step_number}.` };
      }
    }

    const FieldOpsService = require('../field-ops/field-ops.service');

    // Gate G-3: underground/sump tanks need a PASSED confined-space gas check
    // before any physical work (steps ≥ 1).
    if (step_number >= 1 && ['underground', 'sump'].includes(job.tank_type || job.booking_tank_type)) {
      const gas = await FieldOpsService.latestGasResult(job_id);
      if (gas !== 'PASS') {
        throw {
          status: 423,
          message: gas === 'FAIL'
            ? 'Confined-space gas check FAILED. Ventilate and recheck before continuing. (Gate G-3)'
            : 'Confined-space gas check required before working on this tank. (Gate G-3)',
        };
      }
    }

    // Gate G-4 — enforced EARLY, at the step where the crew can fix it:
    // Step 1 cannot be SAVED until all 5 numeric meter readings are recorded
    // (the bucket chips alone aren't enough), and step 8 likewise requires
    // the 5 after-readings. Step 2 keeps a backstop check.
    const READING_NAMES = { pH: 'pH', TDS: 'TDS', ORP: 'ORP', turbidity: 'Turbidity', dissolved_o3: 'Dissolved O₃', dissolved_o3_final: 'Dissolved O₃ (final)' };
    if (step_number === 1 || step_number === 2) {
      const before = await FieldOpsService.beforeReadingsComplete(job_id);
      if (!before.complete) {
        const missing = before.missing.map((p) => READING_NAMES[p] || p).join(', ');
        throw {
          status: 423,
          message: step_number === 1
            ? `Save all 5 meter readings first — tap Save next to each in the Meter Readings panel. Still missing: ${missing}.`
            : `Record all 5 water readings in Step 1 before draining. Still missing: ${missing}. (Gate G-4)`,
        };
      }
    }
    if (step_number === 8) {
      const after = await FieldOpsService.afterReadingsComplete(job_id);
      if (!after.complete) {
        const missing = after.missing.map((p) => READING_NAMES[p] || p).join(', ');
        throw { status: 423, message: `Save all 5 after-service meter readings first — tap Save next to each. Still missing: ${missing}.` };
      }
    }

    // Ozone step (6) requires a SAFETY-PASSED ozone session (gates G-5..G-8).
    if (step_number === 6) {
      const session = await FieldOpsService.activeSession(job_id);
      if (!session || !session.safety_passed) {
        throw { status: 423, message: 'Ozone session safety not cleared. Run the ozone session and pass both O₃ safety readings first. (Gates G-5–G-8)' };
      }
    }

    const stepDef = COMPLIANCE_STEPS[step_number];

    // Step 7 (UV) is skippable. When uv_skipped is true, bypass field validation.
    const isUvSkipped = step_number === 7 && data.uv_skipped === true;

    if (!isUvSkipped) {
      const missingFields = [];
      for (const field of stepDef.required_fields) {
        const value = data[field];
        // booleans + arrays must be checked structurally; primitives via truthiness.
        if (field === 'ppe_list') {
          if (!Array.isArray(value) || value.length === 0) missingFields.push('ppe_list');
        } else if (field === 'cleanup_checklist') {
          if (!value || typeof value !== 'object') missingFields.push('cleanup_checklist');
        } else if (MUST_BE_TRUE.includes(field)) {
          // Safety toggles: must be affirmatively TRUE, not just present.
          if (value !== true) missingFields.push(labelFor(field));
        } else if (typeof value === 'boolean') {
          if (value !== true && value !== false) missingFields.push(labelFor(field));
        } else if (value === undefined || value === null || value === '') {
          missingFields.push(labelFor(field));
        }
      }
      if (missingFields.length > 0) {
        // Human, production-safe message — no raw column names.
        const unique = [...new Set(missingFields)];
        throw {
          status: 400,
          message: `Please complete before saving: ${unique.join(', ')}.`,
        };
      }

      // Stage 0 PPE policy: all 6 items must be ticked.
      if (step_number === 0) {
        const PPE_LABELS = {
          mask: 'Mask', gloves: 'Gloves', boots: 'Boots',
          coverall: 'Coverall', face_shield: 'Face shield', o3_sensor: 'O₃ sensor',
        };
        const requiredPPE = Object.keys(PPE_LABELS);
        const missingPPE = requiredPPE.filter(item => !data.ppe_list.includes(item));
        if (missingPPE.length > 0) {
          throw {
            status: 400,
            message: `All 6 PPE items must be ticked. Missing: ${missingPPE.map(i => PPE_LABELS[i]).join(', ')}.`,
          };
        }
      }

      // Step 8: all 4 site clean-up items must be confirmed (spec 8.1).
      if (step_number === 8) {
        const CLEANUP_LABELS = {
          tools_loaded: 'Tools loaded', manhole_secured: 'Manhole secured',
          no_water_pooling: 'No water pooling', ppe_waste_bagged: 'PPE waste bagged',
        };
        const missingCleanup = CLEANUP_ITEMS.filter((k) => data.cleanup_checklist?.[k] !== true);
        if (missingCleanup.length) {
          throw { status: 400, message: `Confirm all site clean-up items: ${missingCleanup.map(k => CLEANUP_LABELS[k] || k).join(', ')}.` };
        }
      }

      // Step 3: confined-space entry needs the harness confirmed (spec 3.3).
      if (step_number === 3 && data.confined_entry === true && data.harness_attached !== true) {
        throw { status: 400, message: 'Confined-space entry declared — safety harness must be attached and confirmed.' };
      }

      // Steps 1 & 8: visual documentation = 3 photos (main + 2 extra), video
      // optional but accepted (spec 2.7 / 5.7).
      if (step_number === 1 || step_number === 8) {
        const extras = Array.isArray(data.extra_photo_urls) ? data.extra_photo_urls.filter(Boolean) : [];
        if (extras.length < 2) {
          throw { status: 400, message: `Step ${step_number} needs 3 photos total (main + 2 more): water/walls, floor, tank exterior.` };
        }
      }
    }

    // Step 4: water_used auto-calc (spec 3.7) — feeds the EcoScore water metric.
    if (step_number === 4 && data.water_before_litres != null && data.water_after_litres != null) {
      const used = Number(data.water_before_litres) - Number(data.water_after_litres);
      if (!Number.isFinite(used) || used < 0) {
        throw { status: 400, message: 'water_after_litres cannot exceed water_before_litres.' };
      }
      data.water_used_litres = used;
    }

    const step = await ComplianceRepository.saveStep({
      ...data,
      agent_id: teamId,
      step_name: stepDef.name,
      uv_skipped: isUvSkipped,
      completed: true,
    });

    // In-app + push progress notification (works without WhatsApp templates).
    // Step 0 tells the customer work has STARTED at their site, GPS-verified.
    if (job.customer_id || job.customer_fcm_token) {
      const title = step_number === 0
        ? '🚿 Work started at your site'
        : `✅ Step ${step_number} complete`;
      const bodyMsg = step_number === 0
        ? 'Your OzoneWash crew has started — safety checks done, location GPS-verified.'
        : `${stepDef.name} finished. Track live progress in your booking.`;
      NotificationService.notifyUser({ id: job.customer_id, fcm_token: job.customer_fcm_token }, title, bodyMsg, {
        job_id: job.id, booking_id: job.booking_id || '', type: 'step_progress', step: String(step_number),
      }).catch(() => {});
    }

    // Auto-send the customer-facing message via WhatsApp. Fire-and-forget:
    // the BSP call must never delay the step-save response (sendWhatsApp
    // swallows errors internally and queues failed sends for cron retry).
    // Params must be {name, value} objects — the Wati sender maps p.name/p.value.
    if (job.customer_phone && stepDef.customer_msg_template) {
      NotificationService.sendWhatsApp(
        job.customer_phone,
        stepDef.customer_msg_template,
        [
          { name: 'job_id', value: String(job.id).slice(0, 8) },
          { name: 'step_name', value: stepDef.name },
        ],
      ).catch(() => { /* non-fatal */ });
    }

    const completedCount = await ComplianceRepository.getCompletedCount(job_id);

    return {
      step,
      completed_steps: completedCount,
      total_steps: TOTAL_STEPS,
      completion_percentage: Math.round((completedCount / TOTAL_STEPS) * 100),
      all_complete: completedCount === TOTAL_STEPS,
    };
  },

  // Get compliance status
  getStatus: async (jobId) => {
    const job = await JobRepository.findById(jobId);
    if (!job) {
      throw { status: 404, message: 'Job not found.' };
    }

    const status = await ComplianceRepository.getStatus(jobId);
    const allSteps = await ComplianceRepository.getSteps(jobId);

    const loggedStepNumbers = allSteps.map(s => s.step_number);
    const pendingSteps = STEP_NUMBERS
      .filter(num => !loggedStepNumbers.includes(num))
      .map(num => ({
        step_number: num,
        step_name: COMPLIANCE_STEPS[num].name,
        optional: !!COMPLIANCE_STEPS[num].optional,
      }));

    const completed = parseInt(status.completed);
    return {
      job_id: jobId,
      total_steps: TOTAL_STEPS,
      completed,
      incomplete: parseInt(status.incomplete),
      pending_steps: pendingSteps,
      completion_percentage: Math.round((completed / TOTAL_STEPS) * 100),
      ready_for_certificate: completed === TOTAL_STEPS,
    };
  },

  // Complete compliance — gate before certificate generation
  completeCompliance: async (jobId, teamId) => {
    const job = await JobRepository.findById(jobId);
    if (!job) {
      throw { status: 404, message: 'Job not found.' };
    }

    if (job.assigned_team_id !== teamId) {
      throw { status: 403, message: 'This job is not assigned to you.' };
    }

    // CRITICAL: Check all 9 phases are complete (skipped UV counts).
    const allComplete = await ComplianceRepository.areAllStepsComplete(jobId);
    if (!allComplete) {
      const status = await ComplianceRepository.getStatus(jobId);
      throw {
        status: 400,
        message: `Cannot complete. Only ${status.completed} of ${TOTAL_STEPS} phases done. Complete all phases first.`,
      };
    }

    // Auto-trigger per-job EcoScore (PDF page 6 - 9 dimensions). Lazy-required
    // to avoid a circular import (compliance ↔ ecoscore depend on each other).
    // Fire-and-forget: never block the field-team flow on score computation.
    try {
      const EcoScoreService = require('../ecoscore/ecoscore.service');
      EcoScoreService.calculateScore(jobId).catch(() => {});
    } catch (_) { /* non-fatal */ }

    // Job stays in_progress until customer provides end OTP.
    return {
      message: `All ${TOTAL_STEPS} compliance phases verified. Generate end OTP to finalise the job.`,
      job_id: jobId,
      ready_for_certificate: true,
    };
  },

};

module.exports = ComplianceService;
