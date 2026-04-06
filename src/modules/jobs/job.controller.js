const { validationResult } = require('express-validator');
const JobService = require('./job.service');
const JobRepository = require('./job.repository');
const NotificationService = require('../../services/notification.service');
const { sendSuccess, sendError } = require('../../utils/response');

const JobController = {

  // GET /api/v1/jobs (admin)
  getAllJobs: async (req, res, next) => {
    try {
      const { status, date, team_id, limit, offset } = req.query;
      const jobs = await JobService.getAllJobs({
        status,
        date,
        team_id,
        limit: parseInt(limit) || 20,
        offset: parseInt(offset) || 0,
      });
      return sendSuccess(res, { jobs });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/v1/jobs/my (field team)
  getMyJobs: async (req, res, next) => {
    try {
      const jobs = await JobService.getMyJobs(req.user.id);
      return sendSuccess(res, { jobs });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/v1/jobs/stats (admin dashboard)
  getTodayStats: async (req, res, next) => {
    try {
      // Field team gets their own stats; admin gets global stats
      const teamId = req.user.role === 'field_team' ? req.user.id : null;
      const stats = await JobService.getTodayStats(teamId);
      return sendSuccess(res, { stats });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/v1/jobs/teams (admin — for assignment)
  getTeamList: async (req, res, next) => {
    try {
      const teams = await JobService.getTeamList();
      return sendSuccess(res, { teams });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/v1/jobs/:id
  getJob: async (req, res, next) => {
    try {
      const job = await JobService.getJob(
        req.params.id,
        req.user.id,
        req.user.role
      );
      return sendSuccess(res, { job });
    } catch (err) {
      next(err);
    }
  },

  // PATCH /api/v1/jobs/:id/assign (admin)
  assignTeam: async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, 'Validation failed', 400, errors.array());
      }
      const { team_id } = req.body;
      const job = await JobService.assignTeam(req.params.id, team_id);
      JobRepository.findById(req.params.id).then(fullJob => {
        if (fullJob) {
          NotificationService.onTeamAssigned(
            { fcm_token: fullJob.team_fcm_token },
            fullJob
          );
        }
      }).catch(() => {});
      return sendSuccess(res, { job }, 'Team assigned successfully');
    } catch (err) {
      next(err);
    }
  },

  // PATCH /api/v1/jobs/:id/start (field team)
  startJob: async (req, res, next) => {
    try {
      const job = await JobService.startJob(req.params.id, req.user.id);
      JobRepository.findById(req.params.id).then(fullJob => {
        if (fullJob) {
          NotificationService.onJobStarted(
            { fcm_token: fullJob.customer_fcm_token },
            fullJob
          );
        }
      }).catch(() => {});
      return sendSuccess(res, { job }, 'Job started successfully');
    } catch (err) {
      next(err);
    }
  },

  // PATCH /api/v1/jobs/:id/complete (called by compliance engine)
  completeJob: async (req, res, next) => {
    try {
      const job = await JobService.completeJob(req.params.id);
      return sendSuccess(res, { job }, 'Job completed successfully');
    } catch (err) {
      next(err);
    }
  },

  // ── OTP Endpoints ─────────────────────────────────────────────────────

  // POST /api/v1/jobs/:id/generate-start-otp
  generateStartOtp: async (req, res, next) => {
    try {
      const result = await JobService.generateStartOtp(req.params.id, req.user.id);
      // Send OTP to customer via push notification
      JobRepository.findById(req.params.id).then(fullJob => {
        if (fullJob && fullJob.customer_fcm_token) {
          NotificationService.sendPush(
            fullJob.customer_fcm_token,
            '🔑 Start OTP',
            `Your start OTP is: ${fullJob.start_otp}. Share this with the technician to begin service.`,
            { job_id: fullJob.id, type: 'start_otp', otp: fullJob.start_otp }
          );
        }
      }).catch(() => {});
      return sendSuccess(res, result, 'Start OTP sent to customer');
    } catch (err) {
      next(err);
    }
  },

  // POST /api/v1/jobs/:id/verify-start-otp
  verifyStartOtp: async (req, res, next) => {
    try {
      const { otp } = req.body;
      if (!otp) return sendError(res, 'OTP is required', 400);
      const job = await JobService.verifyStartOtp(req.params.id, req.user.id, otp);
      // Notify customer that job has started
      JobRepository.findById(req.params.id).then(fullJob => {
        if (fullJob) {
          NotificationService.onJobStarted(
            { fcm_token: fullJob.customer_fcm_token },
            fullJob
          );
        }
      }).catch(() => {});
      return sendSuccess(res, { job }, 'Start OTP verified. Job started.');
    } catch (err) {
      next(err);
    }
  },

  // POST /api/v1/jobs/:id/generate-end-otp
  generateEndOtp: async (req, res, next) => {
    try {
      const result = await JobService.generateEndOtp(req.params.id, req.user.id);
      // Send OTP to customer via push notification
      JobRepository.findById(req.params.id).then(fullJob => {
        if (fullJob && fullJob.customer_fcm_token) {
          NotificationService.sendPush(
            fullJob.customer_fcm_token,
            '🔑 End OTP',
            `Your end OTP is: ${fullJob.end_otp}. Share this with the technician to complete service.`,
            { job_id: fullJob.id, type: 'end_otp', otp: fullJob.end_otp }
          );
        }
      }).catch(() => {});
      return sendSuccess(res, result, 'End OTP sent to customer');
    } catch (err) {
      next(err);
    }
  },

  // POST /api/v1/jobs/:id/verify-end-otp
  verifyEndOtp: async (req, res, next) => {
    try {
      const { otp } = req.body;
      if (!otp) return sendError(res, 'OTP is required', 400);
      const job = await JobService.verifyEndOtp(req.params.id, req.user.id, otp);
      return sendSuccess(res, { job }, 'End OTP verified. Job closeout confirmed.');
    } catch (err) {
      next(err);
    }
  },

  // ── Transfer ──────────────────────────────────────────────────────────

  // POST /api/v1/jobs/:id/transfer
  transferJob: async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, 'Validation failed', 400, errors.array());
      }
      const { new_team_id, reason } = req.body;
      const job = await JobService.transferJob(
        req.params.id, new_team_id, reason || 'No reason provided',
        req.user.id, req.user.role
      );
      // Notify new team member
      JobRepository.findById(req.params.id).then(fullJob => {
        if (fullJob) {
          NotificationService.onTeamAssigned(
            { fcm_token: fullJob.team_fcm_token },
            fullJob
          );
        }
      }).catch(() => {});
      return sendSuccess(res, { job }, 'Job transferred successfully');
    } catch (err) {
      next(err);
    }
  },

};

module.exports = JobController;