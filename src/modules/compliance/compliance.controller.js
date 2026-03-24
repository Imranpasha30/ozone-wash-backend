const { validationResult } = require('express-validator');
const ComplianceService = require('./compliance.service');
const { sendSuccess, sendError } = require('../../utils/response');

const ComplianceController = {

  // GET /api/v1/compliance/:jobId/checklist
  getChecklist: async (req, res, next) => {
    try {
      const checklist = await ComplianceService.getChecklist(req.params.jobId);
      return sendSuccess(res, checklist);
    } catch (err) {
      next(err);
    }
  },

  // POST /api/v1/compliance/step
  logStep: async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, 'Validation failed', 400, errors.array());
      }
      const result = await ComplianceService.logStep(req.user.id, req.body);
      return sendSuccess(res, result, `Step ${req.body.step_number} logged successfully`);
    } catch (err) {
      next(err);
    }
  },

  // GET /api/v1/compliance/:jobId/status
  getStatus: async (req, res, next) => {
    try {
      const status = await ComplianceService.getStatus(req.params.jobId);
      return sendSuccess(res, status);
    } catch (err) {
      next(err);
    }
  },

  // POST /api/v1/compliance/:jobId/complete
  completeCompliance: async (req, res, next) => {
    try {
      const result = await ComplianceService.completeCompliance(
        req.params.jobId,
        req.user.id
      );
      return sendSuccess(res, result, 'Compliance completed successfully');
    } catch (err) {
      next(err);
    }
  },

};

module.exports = ComplianceController;