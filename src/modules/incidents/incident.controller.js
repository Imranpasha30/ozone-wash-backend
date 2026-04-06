const { validationResult } = require('express-validator');
const IncidentService = require('./incident.service');
const NotificationService = require('../../services/notification.service');
const { sendSuccess, sendError } = require('../../utils/response');
const db = require('../../config/db');

const IncidentController = {

  // POST /api/v1/incidents (field_team)
  create: async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, 'Validation failed', 400, errors.array());
      }

      const incident = await IncidentService.create({
        ...req.body,
        reported_by: req.user.id,
      });

      // Notify admin for critical incidents
      if (incident.severity === 'critical' || incident.severity === 'high') {
        const admins = await db.query(
          `SELECT fcm_token FROM users WHERE role = 'admin' AND fcm_token IS NOT NULL`
        );
        for (const admin of admins.rows) {
          NotificationService.onIncidentReported(admin.fcm_token, incident.job_id);
        }
      }

      return sendSuccess(res, { incident }, 'Incident reported successfully', 201);
    } catch (err) {
      next(err);
    }
  },

  // GET /api/v1/incidents/job/:jobId
  getByJobId: async (req, res, next) => {
    try {
      const incidents = await IncidentService.getByJobId(req.params.jobId);
      return sendSuccess(res, { incidents });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/v1/incidents (admin)
  getAll: async (req, res, next) => {
    try {
      const { status, severity, limit, offset } = req.query;
      const incidents = await IncidentService.getAll({
        status,
        severity,
        limit: parseInt(limit) || 20,
        offset: parseInt(offset) || 0,
      });
      return sendSuccess(res, { incidents });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/v1/incidents/:id
  getById: async (req, res, next) => {
    try {
      const incident = await IncidentService.getById(req.params.id);
      return sendSuccess(res, { incident });
    } catch (err) {
      next(err);
    }
  },

  // PATCH /api/v1/incidents/:id/resolve (admin)
  resolve: async (req, res, next) => {
    try {
      const incident = await IncidentService.resolve(req.params.id, req.user.id);
      return sendSuccess(res, { incident }, 'Incident resolved');
    } catch (err) {
      next(err);
    }
  },

  // PATCH /api/v1/incidents/:id/escalate (admin)
  escalate: async (req, res, next) => {
    try {
      const incident = await IncidentService.escalate(req.params.id);
      return sendSuccess(res, { incident }, 'Incident escalated');
    } catch (err) {
      next(err);
    }
  },

};

module.exports = IncidentController;
