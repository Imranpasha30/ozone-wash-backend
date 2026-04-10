const JobRepository = require('./job.repository');
const RouteService = require('../../services/route.service');
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

    // Reuse existing OTP if already generated and not yet verified — prevents overwrite race condition
    if (job.start_otp && !job.start_otp_verified) {
      return { job_id: jobId, otp_sent: true };
    }

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

  // Generate end OTPs (satisfied + unsatisfied) and notify customer
  generateEndOtp: async (jobId, teamId) => {
    const job = await JobRepository.findById(jobId);
    if (!job) throw { status: 404, message: 'Job not found.' };
    if (job.assigned_team_id !== teamId) throw { status: 403, message: 'This job is not assigned to you.' };
    if (job.status !== 'in_progress') throw { status: 400, message: 'Job must be in progress to generate end OTP.' };

    // Generate two unique OTPs — one for satisfied, one for unsatisfied
    const satisfiedOtp = generateOtp();
    let unsatisfiedOtp = generateOtp();
    while (unsatisfiedOtp === satisfiedOtp) {
      unsatisfiedOtp = generateOtp();
    }

    await JobRepository.storeEndOtp(jobId, satisfiedOtp, unsatisfiedOtp);
    return { job_id: jobId, otp_sent: true };
  },

  // Verify end OTP entered by agent — determines customer satisfaction
  verifyEndOtp: async (jobId, teamId, otp) => {
    const job = await JobRepository.findById(jobId);
    if (!job) throw { status: 404, message: 'Job not found.' };
    if (job.assigned_team_id !== teamId) throw { status: 403, message: 'This job is not assigned to you.' };
    if (job.status !== 'in_progress') throw { status: 400, message: 'Job must be in progress to verify end OTP.' };
    if (!job.end_otp_satisfied && !job.end_otp_unsatisfied) throw { status: 400, message: 'End OTP has not been generated yet.' };

    // Check which OTP was entered
    let satisfied = null;
    if (job.end_otp_satisfied && otp === job.end_otp_satisfied) {
      satisfied = true;
    } else if (job.end_otp_unsatisfied && otp === job.end_otp_unsatisfied) {
      satisfied = false;
    } else {
      throw { status: 400, message: 'Invalid OTP. Please try again.' };
    }

    const updated = await JobRepository.verifyEndOtp(jobId, satisfied);
    return { ...updated, customer_satisfied: satisfied };
  },

  // Customer requests start OTP generation (when technician is present)
  customerRequestStartOtp: async (jobId, customerId) => {
    const job = await JobRepository.findById(jobId);
    if (!job) throw { status: 404, message: 'Job not found.' };
    if (job.customer_id !== customerId) throw { status: 403, message: 'Access denied.' };
    if (!job.assigned_team_id) throw { status: 400, message: 'No technician assigned yet.' };
    if (job.status !== 'scheduled') throw { status: 400, message: `Cannot generate OTP for a job with status: ${job.status}` };

    // Reuse existing OTP if already generated and not yet verified — prevents overwrite race condition
    if (job.start_otp && !job.start_otp_verified) {
      return { job_id: jobId, otp: job.start_otp };
    }

    const otp = generateOtp();
    await JobRepository.storeStartOtp(jobId, otp);
    return { job_id: jobId, otp };
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

  // ── Available Jobs & Requests ─────────────────────────────────────────

  // Get unassigned scheduled jobs (field team can browse)
  getAvailableJobs: async () => {
    return await JobRepository.findAvailable();
  },

  // Field team requests a job
  requestJob: async (jobId, teamId) => {
    const job = await JobRepository.findById(jobId);
    if (!job) throw { status: 404, message: 'Job not found.' };
    if (job.assigned_team_id) throw { status: 400, message: 'This job is already assigned.' };
    if (job.status !== 'scheduled') throw { status: 400, message: 'Only scheduled jobs can be requested.' };

    // Check for duplicate pending request
    const existing = await JobRepository.findRequestByJobAndTeam(jobId, teamId);
    if (existing) throw { status: 400, message: 'You have already requested this job.' };

    const request = await JobRepository.createRequest(jobId, teamId);
    return request;
  },

  // Get all job requests (admin)
  getJobRequests: async (filters) => {
    return await JobRepository.findRequests(filters);
  },

  // Admin approves a job request (assigns the team)
  approveJobRequest: async (requestId) => {
    const request = await JobRepository.findRequestById(requestId);
    if (!request) throw { status: 404, message: 'Request not found.' };
    if (request.status !== 'pending') throw { status: 400, message: 'Request is no longer pending.' };
    if (request.job_status !== 'scheduled') throw { status: 400, message: 'Job is no longer available.' };
    if (request.assigned_team_id) throw { status: 400, message: 'Job is already assigned.' };

    // Assign the team
    await JobRepository.assignTeam(request.job_id, request.team_id);

    // Approve this request and reject all other pending requests for this job
    await JobRepository.updateRequestStatus(requestId, 'approved');
    await JobRepository.rejectOtherRequests(request.job_id, request.team_id);

    return { job_id: request.job_id, team_id: request.team_id, team_name: request.team_name };
  },

  // Admin rejects a job request
  rejectJobRequest: async (requestId) => {
    const request = await JobRepository.findRequestById(requestId);
    if (!request) throw { status: 404, message: 'Request not found.' };
    if (request.status !== 'pending') throw { status: 400, message: 'Request is no longer pending.' };

    await JobRepository.updateRequestStatus(requestId, 'rejected');
    return { message: 'Request rejected.' };
  },

  // Count pending requests (for admin dashboard)
  getPendingRequestCount: async () => {
    return await JobRepository.countPendingRequests();
  },

  // ── Conflict Detection & Concerns ────────────────────────────────────────

  // Check if a team has a conflicting job at the given time (±60 min)
  checkConflict: async (teamId, scheduledAt, excludeJobId = null) => {
    const conflicts = await JobRepository.checkConflict(teamId, scheduledAt, excludeJobId);
    return { has_conflict: conflicts.length > 0, conflicts };
  },

  // Field team raises a scheduling concern
  raiseConcern: async (jobId, teamId, message) => {
    const job = await JobRepository.findById(jobId);
    if (!job) throw { status: 404, message: 'Job not found.' };
    if (job.assigned_team_id !== teamId) throw { status: 403, message: 'This job is not assigned to you.' };
    if (!message?.trim()) throw { status: 400, message: 'Concern message is required.' };
    const updated = await JobRepository.raiseConcern(jobId, teamId, message.trim());
    if (!updated) throw { status: 400, message: 'Could not raise concern. Job not found or not assigned to you.' };
    return updated;
  },

  // Admin: get all unresolved concerns
  getConcerns: async () => {
    return await JobRepository.findConcerns();
  },

  // Admin: resolve a concern
  resolveConcern: async (jobId) => {
    const job = await JobRepository.findById(jobId);
    if (!job) throw { status: 404, message: 'Job not found.' };
    return await JobRepository.resolveConcern(jobId);
  },

  // Optimize route for field team's day jobs
  optimizeRoute: async (teamId, originLat, originLng) => {
    const jobs = await JobRepository.findByTeam(teamId);
    // Only optimize scheduled/in_progress jobs
    const active = jobs.filter(j => j.status === 'scheduled' || j.status === 'in_progress');
    if (active.length === 0) return { optimized: [], method: 'none' };
    return await RouteService.optimizeRoute(active, originLat, originLng);
  },

};

module.exports = JobService;