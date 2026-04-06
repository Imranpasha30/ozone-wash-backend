const JobRepository = require('./job.repository');
const crypto = require('crypto');

const generateOtp = () => {
  return crypto.randomInt(100000, 999999).toString();
};

const JobService = {

  // Get all jobs (admin)
  getAllJobs: async (filters) => {
    return await JobRepository.findAll(filters);
  },

  // Get today's jobs for field team
  getMyJobs: async (teamId) => {
    return await JobRepository.findByTeam(teamId);
  },

  // Get single job details
  getJob: async (jobId, userId, userRole) => {
    const job = await JobRepository.findById(jobId);
    if (!job) {
      throw { status: 404, message: 'Job not found.' };
    }

    // Field team can only see their own assigned jobs
    if (userRole === 'field_team' && job.assigned_team_id !== userId) {
      throw { status: 403, message: 'Access denied.' };
    }

    // Customer can only see their own jobs
    if (userRole === 'customer' && job.customer_id !== userId) {
      throw { status: 403, message: 'Access denied.' };
    }

    return job;
  },

  // Assign field team to a job (admin only)
  assignTeam: async (jobId, teamId) => {
    // Check job exists
    const job = await JobRepository.findById(jobId);
    if (!job) {
      throw { status: 404, message: 'Job not found.' };
    }

    if (job.status === 'cancelled') {
      throw { status: 400, message: 'Cannot assign team to a cancelled job.' };
    }

    if (job.status === 'completed') {
      throw { status: 400, message: 'Cannot assign team to a completed job.' };
    }

    // Assign the team
    const updated = await JobRepository.assignTeam(jobId, teamId);
    return updated;
  },

  // Start a job (field team)
  startJob: async (jobId, teamId) => {
    const job = await JobRepository.findById(jobId);
    if (!job) {
      throw { status: 404, message: 'Job not found.' };
    }

    if (job.assigned_team_id !== teamId) {
      throw { status: 403, message: 'This job is not assigned to you.' };
    }

    if (job.status !== 'scheduled') {
      throw { status: 400, message: `Cannot start a job with status: ${job.status}` };
    }

    const updated = await JobRepository.updateStatus(jobId, 'in_progress');
    return updated;
  },

  // Complete a job (called automatically by compliance engine)
  completeJob: async (jobId) => {
    const job = await JobRepository.findById(jobId);
    if (!job) {
      throw { status: 404, message: 'Job not found.' };
    }

    if (job.status !== 'in_progress') {
      throw { status: 400, message: 'Job must be in progress to complete.' };
    }

    const updated = await JobRepository.updateStatus(jobId, 'completed');
    return updated;
  },

  // ── OTP Methods ──────────────────────────────────────────────────────────

  // Generate start OTP and notify customer
  generateStartOtp: async (jobId, teamId) => {
    const job = await JobRepository.findById(jobId);
    if (!job) throw { status: 404, message: 'Job not found.' };
    if (job.assigned_team_id !== teamId) throw { status: 403, message: 'This job is not assigned to you.' };
    if (job.status !== 'scheduled') throw { status: 400, message: `Cannot generate start OTP for a job with status: ${job.status}` };

    const otp = generateOtp();
    await JobRepository.storeStartOtp(jobId, otp);
    return { job_id: jobId, otp_sent: true };
  },

  // Verify start OTP entered by agent
  verifyStartOtp: async (jobId, teamId, otp) => {
    const job = await JobRepository.findById(jobId);
    if (!job) throw { status: 404, message: 'Job not found.' };
    if (job.assigned_team_id !== teamId) throw { status: 403, message: 'This job is not assigned to you.' };
    if (job.status !== 'scheduled') throw { status: 400, message: `Cannot verify start OTP for a job with status: ${job.status}` };
    if (!job.start_otp) throw { status: 400, message: 'Start OTP has not been generated yet.' };
    if (job.start_otp !== otp) throw { status: 400, message: 'Invalid OTP. Please try again.' };

    const updated = await JobRepository.verifyStartOtp(jobId);
    return updated;
  },

  // Generate end OTP and notify customer
  generateEndOtp: async (jobId, teamId) => {
    const job = await JobRepository.findById(jobId);
    if (!job) throw { status: 404, message: 'Job not found.' };
    if (job.assigned_team_id !== teamId) throw { status: 403, message: 'This job is not assigned to you.' };
    if (job.status !== 'in_progress') throw { status: 400, message: 'Job must be in progress to generate end OTP.' };

    const otp = generateOtp();
    await JobRepository.storeEndOtp(jobId, otp);
    return { job_id: jobId, otp_sent: true };
  },

  // Verify end OTP entered by agent
  verifyEndOtp: async (jobId, teamId, otp) => {
    const job = await JobRepository.findById(jobId);
    if (!job) throw { status: 404, message: 'Job not found.' };
    if (job.assigned_team_id !== teamId) throw { status: 403, message: 'This job is not assigned to you.' };
    if (job.status !== 'in_progress') throw { status: 400, message: 'Job must be in progress to verify end OTP.' };
    if (!job.end_otp) throw { status: 400, message: 'End OTP has not been generated yet.' };
    if (job.end_otp !== otp) throw { status: 400, message: 'Invalid OTP. Please try again.' };

    const updated = await JobRepository.verifyEndOtp(jobId);
    return updated;
  },

  // ── Transfer ────────────────────────────────────────────────────────────

  transferJob: async (jobId, newTeamId, reason, userId, userRole) => {
    const job = await JobRepository.findById(jobId);
    if (!job) throw { status: 404, message: 'Job not found.' };

    // Field team can only transfer their own jobs
    if (userRole === 'field_team' && job.assigned_team_id !== userId) {
      throw { status: 403, message: 'This job is not assigned to you.' };
    }

    if (job.status === 'completed' || job.status === 'cancelled') {
      throw { status: 400, message: `Cannot transfer a ${job.status} job.` };
    }

    if (job.assigned_team_id === newTeamId) {
      throw { status: 400, message: 'Job is already assigned to this team member.' };
    }

    const updated = await JobRepository.transferJob(jobId, newTeamId, reason);
    return updated;
  },

  // Get list of all field team members (admin — for assignment dropdown)
  getTeamList: async () => {
    return await JobRepository.getTeamList();
  },

  // Get today's stats (admin dashboard)
  getTodayStats: async (teamId = null) => {
    return await JobRepository.getTodayStats(teamId);
  },

};

module.exports = JobService;