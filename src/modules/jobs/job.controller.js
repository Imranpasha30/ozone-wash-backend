const { validationResult } = require('express-validator');
const JobService = require('./job.service');
const JobRepository = require('./job.repository');
const NotificationService = require('../../services/notification.service');
const EcoScoreService = require('../ecoscore/ecoscore.service');
const IncentiveEngine = require('../incentives/engine');
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

  // GET /api/v1/jobs/route-optimize (field team)
  optimizeRoute: async (req, res, next) => {
    try {
      const { lat, lng } = req.query;
      const originLat = lat ? parseFloat(lat) : null;
      const originLng = lng ? parseFloat(lng) : null;
      const result = await JobService.optimizeRoute(req.user.id, originLat, originLng);
      return sendSuccess(res, result);
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
      const { team_id, field_team_id, force } = req.body;
      const opts = { force: force === true || force === 'true' };
      // Prefer whole-crew (field_team) assignment; fall back to the legacy
      // single-agent path when only team_id is supplied.
      const job = field_team_id
        ? await JobService.assignFieldTeam(req.params.id, field_team_id, opts)
        : await JobService.assignTeam(req.params.id, team_id, opts);
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
      // EcoScore: refresh customer's rolling score (fire-and-forget — never block)
      if (job?.customer_id) {
        EcoScoreService.recalcOnEvent({
          event: 'job_complete',
          user_id: job.customer_id,
          ref: job.id,
        }).catch(() => {});
      }
      // FA Incentives: accrue base + addon + rating (fire-and-forget)
      if (job?.id) {
        IncentiveEngine.accrueForJob({ job_id: job.id })
          .catch(err => console.warn('[incentives.accrue]', err.message));
      }
      if (job?.assigned_team_id) {
        IncentiveEngine.recalcAgentStats({ agent_id: job.assigned_team_id })
          .catch(err => console.warn('[incentives.recalc]', err.message));
        IncentiveEngine.evaluateMonthlyTarget({
          agent_id: job.assigned_team_id,
          month: IncentiveEngine.firstOfMonth(),
        }).catch(err => console.warn('[incentives.target]', err.message));
      }
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
        if (fullJob) {
          NotificationService.notifyUser(
            { id: fullJob.customer_id, fcm_token: fullJob.customer_fcm_token },
            '🔑 Start OTP',
            `Your start OTP is: ${fullJob.start_otp}. Share this with the technician to begin service.`,
            { job_id: fullJob.id, booking_id: fullJob.booking_id || '', type: 'start_otp', otp: fullJob.start_otp }
          );
        }
      }).catch(() => {});
      return sendSuccess(res, result, 'Start OTP sent to customer');
    } catch (err) {
      next(err);
    }
  },

  // POST /api/v1/jobs/:id/verify-start-otp
  // Body: { otp, gps_lat?, gps_lng? } — GPS feeds the 200m geofence (G-1)
  verifyStartOtp: async (req, res, next) => {
    try {
      const { otp, gps_lat, gps_lng, arrival_photo_url } = req.body;
      if (!otp) return sendError(res, 'OTP is required', 400);
      const job = await JobService.verifyStartOtp(req.params.id, req.user.id, otp, { gps_lat, gps_lng, arrival_photo_url });
      // Notify customer that job has started (push + WhatsApp, server-side)
      JobRepository.findById(req.params.id).then(fullJob => {
        if (fullJob) {
          NotificationService.onJobStarted(
            { fcm_token: fullJob.customer_fcm_token, phone: fullJob.customer_phone },
            fullJob
          );
          if (fullJob.customer_phone) {
            NotificationService.sendWhatsApp(fullJob.customer_phone, 'job_started', [
              { name: 'job_id', value: String(fullJob.id).slice(0, 8) },
            ]).catch(() => {});
          }
        }
      }).catch(() => {});
      return sendSuccess(res, { job }, 'Start OTP verified. Job started.');
    } catch (err) {
      next(err);
    }
  },

  // PATCH /api/v1/jobs/:id/en-route — crew departed for the site (step 1.1)
  markEnRoute: async (req, res, next) => {
    try {
      const result = await JobService.markEnRoute(req.params.id, req.user.id);
      // Notify the customer (server-side): push + WhatsApp + in-app banner
      // (the banner reads departure_time via /jobs/customer-alerts).
      JobRepository.findById(req.params.id).then((fullJob) => {
        if (!fullJob) return;
        if (fullJob.customer_id) {
          NotificationService.notifyUser(
            { id: fullJob.customer_id, fcm_token: fullJob.customer_fcm_token },
            '🚐 Crew on the way!',
            'Your OzoneWash team has departed and is heading to your location.',
            { job_id: fullJob.id, booking_id: fullJob.booking_id, type: 'crew_departed' }
          ).catch(() => {});
        }
        if (fullJob.customer_phone) {
          NotificationService.sendWhatsApp(fullJob.customer_phone, 'crew_departed', [
            { name: 'job_id', value: String(fullJob.id).slice(0, 8) },
          ]).catch(() => {});
        }
      }).catch(() => {});
      return sendSuccess(res, result, 'Departure logged');
    } catch (err) {
      next(err);
    }
  },

  // GET /api/v1/jobs/customer-alerts — live banners for the customer app
  customerAlerts: async (req, res, next) => {
    try {
      const alerts = await JobRepository.customerAlerts(req.user.id);
      return sendSuccess(res, { alerts });
    } catch (err) {
      next(err);
    }
  },

  // POST /api/v1/jobs/:id/generate-end-otp
  generateEndOtp: async (req, res, next) => {
    try {
      const result = await JobService.generateEndOtp(req.params.id, req.user.id);
      // Send both OTPs to customer via push notification
      JobRepository.findById(req.params.id).then(fullJob => {
        if (fullJob) {
          NotificationService.notifyUser(
            { id: fullJob.customer_id, fcm_token: fullJob.customer_fcm_token },
            '🔑 Service Feedback OTP',
            `Your technician has completed the work. Open the app to share your feedback OTP.`,
            {
              job_id: fullJob.id,
              booking_id: fullJob.booking_id || '',
              type: 'end_otp',
              otp_satisfied: fullJob.end_otp_satisfied,
              otp_unsatisfied: fullJob.end_otp_unsatisfied,
            }
          );
        }
      }).catch(() => {});
      return sendSuccess(res, result, 'End OTPs sent to customer');
    } catch (err) {
      next(err);
    }
  },

  // POST /api/v1/jobs/:id/verify-end-otp
  verifyEndOtp: async (req, res, next) => {
    try {
      const { otp } = req.body;
      if (!otp) return sendError(res, 'OTP is required', 400);
      const result = await JobService.verifyEndOtp(req.params.id, req.user.id, otp);

      // If customer is NOT satisfied, notify admin
      if (result.customer_satisfied === false) {
        NotificationService.sendPush(
          null, // Admin FCM token would be fetched in production
          '⚠️ Customer Not Satisfied',
          `Customer reported dissatisfaction for Job #${req.params.id.slice(0, 8).toUpperCase()}`,
          { job_id: req.params.id, type: 'customer_unsatisfied' }
        ).catch(() => {});
      }

      const msg = result.customer_satisfied
        ? 'End OTP verified. Customer is satisfied. Job closeout confirmed.'
        : 'End OTP verified. Customer reported dissatisfaction. Job flagged for review.';
      return sendSuccess(res, { job: result }, msg);
    } catch (err) {
      next(err);
    }
  },

  // POST /api/v1/jobs/:id/customer-request-otp (customer)
  customerRequestStartOtp: async (req, res, next) => {
    try {
      const result = await JobService.customerRequestStartOtp(req.params.id, req.user.id);
      // Notify the assigned technician
      JobRepository.findById(req.params.id).then(fullJob => {
        if (fullJob && fullJob.team_fcm_token) {
          NotificationService.sendPush(
            fullJob.team_fcm_token,
            'Customer requested OTP',
            `Customer ${fullJob.customer_name} has generated a start OTP. Please ask them for the code.`,
            { job_id: fullJob.id, type: 'customer_otp_request' }
          );
        }
      }).catch(() => {});
      return sendSuccess(res, result, 'OTP generated. Show this code to your technician.');
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
      const { new_team_id, reason, force } = req.body;
      const job = await JobService.transferJob(
        req.params.id, new_team_id, reason || 'No reason provided',
        req.user.id, req.user.role,
        { force: force === true || force === 'true' }
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

  // ── Duty delegation (leader → member) ─────────────────────────────────

  // GET /api/v1/jobs/:id/team-members — members the leader can delegate to
  getJobTeamMembers: async (req, res, next) => {
    try {
      const members = await JobService.getTeamMembersForJob(req.params.id, { id: req.user.id, role: req.user.role });
      return sendSuccess(res, { members });
    } catch (err) {
      if (err?.status) return sendError(res, err.message, err.status);
      next(err);
    }
  },

  // POST /api/v1/jobs/:id/delegate  { agent_id, scope?: 'job'|'day', note? }
  delegateJob: async (req, res, next) => {
    try {
      const { agent_id, scope, note } = req.body || {};
      if (!agent_id) return sendError(res, 'agent_id is required', 400);
      const result = await JobService.delegateJob(
        req.params.id, agent_id, { id: req.user.id, role: req.user.role }, { scope, note });
      // Notify the delegated member.
      JobRepository.findById(req.params.id).then((fullJob) => {
        if (fullJob) NotificationService.notifyUser(
          { id: agent_id },
          '🤝 Job duty delegated to you',
          scope === 'day' ? 'You’ve been asked to cover your team’s jobs for the day.' : 'You’ve been asked to handle a job for your team.',
          { job_id: req.params.id, type: 'duty_delegated' }
        ).catch(() => {});
      }).catch(() => {});
      return sendSuccess(res, result, scope === 'day' ? 'Duty delegated for the day.' : 'Duty delegated for this job.');
    } catch (err) {
      if (err?.status) return sendError(res, err.message, err.status);
      next(err);
    }
  },

  // DELETE /api/v1/jobs/:id/delegate/:delegationId
  revokeDelegation: async (req, res, next) => {
    try {
      const result = await JobService.revokeDelegation(req.params.delegationId, { id: req.user.id, role: req.user.role });
      return sendSuccess(res, result, 'Delegation removed.');
    } catch (err) {
      if (err?.status) return sendError(res, err.message, err.status);
      next(err);
    }
  },

  // ── Available Jobs & Requests ─────────────────────────────────────────

  // GET /api/v1/jobs/available (field team)
  getAvailableJobs: async (req, res, next) => {
    try {
      const jobs = await JobService.getAvailableJobs();
      return sendSuccess(res, { jobs });
    } catch (err) {
      next(err);
    }
  },

  // POST /api/v1/jobs/:id/request (field team)
  requestJob: async (req, res, next) => {
    try {
      const request = await JobService.requestJob(req.params.id, req.user.id);
      return sendSuccess(res, { request }, 'Job request submitted', 201);
    } catch (err) {
      next(err);
    }
  },

  // GET /api/v1/jobs/my-requests (field team — own requests, any status)
  getMyJobRequests: async (req, res, next) => {
    try {
      const requests = await JobService.getMyJobRequests(req.user.id);
      return sendSuccess(res, { requests });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/v1/jobs/requests (admin)
  getJobRequests: async (req, res, next) => {
    try {
      const { status, limit, offset } = req.query;
      const requests = await JobService.getJobRequests({
        status,
        limit: parseInt(limit) || 20,
        offset: parseInt(offset) || 0,
      });
      return sendSuccess(res, { requests });
    } catch (err) {
      next(err);
    }
  },

  // PATCH /api/v1/jobs/requests/:requestId/approve (admin)
  approveJobRequest: async (req, res, next) => {
    try {
      const { force } = req.body || {};
      const result = await JobService.approveJobRequest(req.params.requestId, { force: force === true || force === 'true' });
      // Notify the team member
      JobRepository.findById(result.job_id).then(fullJob => {
        if (fullJob) {
          NotificationService.onTeamAssigned(
            { fcm_token: fullJob.team_fcm_token },
            fullJob
          );
        }
      }).catch(() => {});
      return sendSuccess(res, result, 'Request approved. Team assigned.');
    } catch (err) {
      next(err);
    }
  },

  // PATCH /api/v1/jobs/requests/:requestId/reject (admin)
  rejectJobRequest: async (req, res, next) => {
    try {
      const result = await JobService.rejectJobRequest(req.params.requestId);
      return sendSuccess(res, result);
    } catch (err) {
      next(err);
    }
  },

  // GET /api/v1/jobs/conflict-check?team_id=&scheduled_at=&exclude_job_id=
  checkConflict: async (req, res, next) => {
    try {
      const { team_id, scheduled_at, exclude_job_id } = req.query;
      if (!team_id || !scheduled_at) return sendError(res, 'team_id and scheduled_at are required', 400);
      const result = await JobService.checkConflict(team_id, scheduled_at, exclude_job_id || null);
      return sendSuccess(res, result);
    } catch (err) {
      next(err);
    }
  },

  // POST /api/v1/jobs/:id/raise-concern (field team)
  raiseConcern: async (req, res, next) => {
    try {
      const { message } = req.body;
      const job = await JobService.raiseConcern(req.params.id, req.user.id, message);
      // Notify admin
      NotificationService.sendPush(
        null,
        '⚠️ Schedule Conflict Raised',
        `${req.user.name || 'A team member'} flagged a scheduling conflict on Job #${req.params.id.slice(0, 8).toUpperCase()}`,
        { job_id: req.params.id, type: 'concern_raised' }
      ).catch(() => {});
      return sendSuccess(res, { job }, 'Concern raised. Admin has been notified.');
    } catch (err) {
      next(err);
    }
  },

  // GET /api/v1/jobs/concerns (admin)
  getConcerns: async (_req, res, next) => {
    try {
      const concerns = await JobService.getConcerns();
      return sendSuccess(res, { concerns });
    } catch (err) {
      next(err);
    }
  },

  // PATCH /api/v1/jobs/:id/resolve-concern (admin)
  resolveConcern: async (req, res, next) => {
    try {
      const job = await JobService.resolveConcern(req.params.id);
      // Notify field team member that concern is resolved
      if (job?.concern_raised_by) {
        JobRepository.findById(req.params.id).then(fullJob => {
          if (fullJob?.team_fcm_token) {
            NotificationService.sendPush(
              fullJob.team_fcm_token,
              '✅ Concern Resolved',
              `Admin has resolved your scheduling concern for Job #${req.params.id.slice(0, 8).toUpperCase()}.`,
              { job_id: req.params.id, type: 'concern_resolved' }
            );
          }
        }).catch(() => {});
      }
      return sendSuccess(res, { job }, 'Concern resolved.');
    } catch (err) {
      next(err);
    }
  },

  // GET /api/v1/jobs/requests/count (admin dashboard)
  getPendingRequestCount: async (req, res, next) => {
    try {
      const count = await JobService.getPendingRequestCount();
      return sendSuccess(res, { pending_requests: count });
    } catch (err) {
      next(err);
    }
  },

};

module.exports = JobController;