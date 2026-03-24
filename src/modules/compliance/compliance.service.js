const ComplianceRepository = require('./compliance.repository');
const JobRepository = require('../jobs/job.repository');

// 8 compliance steps definition
const COMPLIANCE_STEPS = {
  1: { name: 'Site Inspection', required_fields: ['photo_before_url', 'gps_lat', 'gps_lng'] },
  2: { name: 'PPE Check', required_fields: ['ppe_list', 'gps_lat', 'gps_lng'] },
  3: { name: 'Tank Drainage', required_fields: ['photo_before_url', 'photo_after_url', 'gps_lat', 'gps_lng'] },
  4: { name: 'Pre-Clean Photos', required_fields: ['photo_before_url', 'photo_after_url', 'gps_lat', 'gps_lng'] },
  5: { name: 'Ozone Treatment', required_fields: ['photo_before_url', 'photo_after_url', 'ozone_exposure_mins', 'gps_lat', 'gps_lng'] },
  6: { name: 'Microbial Test', required_fields: ['microbial_test_url', 'gps_lat', 'gps_lng'] },
  7: { name: 'Post-Clean Photos', required_fields: ['photo_before_url', 'photo_after_url', 'gps_lat', 'gps_lng'] },
  8: { name: 'Customer Sign-off', required_fields: ['photo_after_url', 'gps_lat', 'gps_lng'] },
};

const ComplianceService = {

  // Get checklist for a job with completion status
  getChecklist: async (jobId) => {
    // Verify job exists
    const job = await JobRepository.findById(jobId);
    if (!job) {
      throw { status: 404, message: 'Job not found.' };
    }

    // Get all logged steps
    const loggedSteps = await ComplianceRepository.getSteps(jobId);
    const loggedMap = {};
    loggedSteps.forEach(step => {
      loggedMap[step.step_number] = step;
    });

    // Build full checklist with all 8 steps
    const checklist = Object.entries(COMPLIANCE_STEPS).map(([num, step]) => {
      const stepNum = parseInt(num);
      const logged = loggedMap[stepNum];
      return {
        step_number: stepNum,
        step_name: step.name,
        required_fields: step.required_fields,
        completed: logged ? logged.completed : false,
        logged: !!logged,
        data: logged || null,
      };
    });

    const completedCount = loggedSteps.filter(s => s.completed).length;

    return {
      job_id: jobId,
      total_steps: 8,
      completed_steps: completedCount,
      completion_percentage: Math.round((completedCount / 8) * 100),
      checklist,
    };
  },

  // Log a compliance step
  logStep: async (teamId, data) => {
    const { job_id, step_number } = data;

    // Validate step number
    if (step_number < 1 || step_number > 8) {
      throw { status: 400, message: 'Step number must be between 1 and 8.' };
    }

    // Verify job exists and is assigned to this team
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

    // Get step definition
    const stepDef = COMPLIANCE_STEPS[step_number];

    // Validate required fields for this step
    const missingFields = [];
    for (const field of stepDef.required_fields) {
      if (field === 'ppe_list') {
        if (!data.ppe_list || data.ppe_list.length === 0) {
          missingFields.push('ppe_list');
        }
      } else if (!data[field]) {
        missingFields.push(field);
      }
    }

    if (missingFields.length > 0) {
      throw {
        status: 400,
        message: `Missing required fields for step ${step_number}: ${missingFields.join(', ')}`,
      };
    }

    // Validate PPE list for step 2
    if (step_number === 2) {
      const requiredPPE = ['mask', 'gloves', 'boots', 'suit'];
      const missingPPE = requiredPPE.filter(item => !data.ppe_list.includes(item));
      if (missingPPE.length > 0) {
        throw {
          status: 400,
          message: `Missing PPE items: ${missingPPE.join(', ')}. All 4 items required.`,
        };
      }
    }

    // Validate ozone exposure for step 5
    if (step_number === 5 && (!data.ozone_exposure_mins || data.ozone_exposure_mins < 30)) {
      throw { status: 400, message: 'Ozone exposure must be at least 30 minutes.' };
    }

    // Save the step
    const step = await ComplianceRepository.saveStep({
      ...data,
      step_name: stepDef.name,
      completed: true,
    });

    // Get updated completion count
    const completedCount = await ComplianceRepository.getCompletedCount(job_id);

    return {
      step,
      completed_steps: completedCount,
      total_steps: 8,
      completion_percentage: Math.round((completedCount / 8) * 100),
      all_complete: completedCount === 8,
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

    // Find pending steps
    const loggedStepNumbers = allSteps.map(s => s.step_number);
    const pendingSteps = Object.keys(COMPLIANCE_STEPS)
      .map(Number)
      .filter(num => !loggedStepNumbers.includes(num))
      .map(num => ({
        step_number: num,
        step_name: COMPLIANCE_STEPS[num].name,
      }));

    return {
      job_id: jobId,
      total_steps: 8,
      completed: parseInt(status.completed),
      incomplete: parseInt(status.incomplete),
      pending_steps: pendingSteps,
      completion_percentage: Math.round((parseInt(status.completed) / 8) * 100),
      ready_for_certificate: parseInt(status.completed) === 8,
    };
  },

  // Complete compliance — gate before certificate generation
  completeCompliance: async (jobId, teamId) => {
    // Verify job
    const job = await JobRepository.findById(jobId);
    if (!job) {
      throw { status: 404, message: 'Job not found.' };
    }

    if (job.assigned_team_id !== teamId) {
      throw { status: 403, message: 'This job is not assigned to you.' };
    }

    // CRITICAL: Check all 8 steps are complete
    // This check is enforced at backend level — cannot be bypassed
    const allComplete = await ComplianceRepository.areAllStepsComplete(jobId);
    if (!allComplete) {
      const status = await ComplianceRepository.getStatus(jobId);
      throw {
        status: 400,
        message: `Cannot complete. Only ${status.completed} of 8 steps done. Complete all steps first.`,
      };
    }

    // Update job status to completed
    await JobRepository.updateStatus(jobId, 'completed');

    return {
      message: 'All 8 compliance steps verified. Job completed successfully.',
      job_id: jobId,
      ready_for_certificate: true,
    };
  },

};

module.exports = ComplianceService;