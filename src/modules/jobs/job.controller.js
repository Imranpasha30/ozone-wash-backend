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

};

module.exports = JobController;