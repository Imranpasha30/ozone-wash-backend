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
    required_fields: ['water_level_pct', 'tank_condition', 'photo_after_url', 'gps_lat', 'gps_lng'],
    customer_msg_template: 'compliance_stage_2_complete',
  },
  3: {
    name: 'Mechanical Scrub & Rotary Jet',
    required_fields: ['scrub_completed', 'photo_after_url', 'gps_lat', 'gps_lng'],
    customer_msg_template: 'compliance_stage_3_complete',
  },
  4: {
    name: 'High-Pressure Rinse',
    required_fields: ['rinse_duration', 'photo_after_url', 'gps_lat', 'gps_lng'],
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
      'gps_lat', 'gps_lng',
    ],
    customer_msg_template: 'compliance_stage_8_complete',
  },
};

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
        } else if (typeof value === 'boolean') {
          if (value !== true && value !== false) missingFields.push(field);
        } else if (value === undefined || value === null || value === '') {
          missingFields.push(field);
        }
      }
      if (missingFields.length > 0) {
        throw {
          status: 400,
          message: `Missing required fields for step ${step_number}: ${missingFields.join(', ')}`,
        };
      }

      // Stage 0 PPE policy: all 6 items must be ticked.
      if (step_number === 0) {
        const requiredPPE = ['mask', 'gloves', 'boots', 'coverall', 'face_shield', 'o3_sensor'];
        const missingPPE = requiredPPE.filter(item => !data.ppe_list.includes(item));
        if (missingPPE.length > 0) {
          throw {
            status: 400,
            message: `Missing PPE items: ${missingPPE.join(', ')}. All 6 items required.`,
          };
        }
      }
    }

    const step = await ComplianceRepository.saveStep({
      ...data,
      step_name: stepDef.name,
      uv_skipped: isUvSkipped,
      completed: true,
    });

    // Auto-send the customer-facing message via WhatsApp. Failures here do
    // not break the API - sendWhatsApp swallows BSP errors internally.
    if (job.customer_phone && stepDef.customer_msg_template) {
      try {
        await NotificationService.sendWhatsApp(
          job.customer_phone,
          stepDef.customer_msg_template,
          [job.id, stepDef.name],
        );
      } catch (_) { /* non-fatal */ }
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
