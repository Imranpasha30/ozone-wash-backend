const JobRepository = require('./job.repository');

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