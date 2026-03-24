const { validationResult } = require('express-validator');
const AmcService = require('./amc.service');
const { sendSuccess, sendError } = require('../../utils/response');

const AmcController = {

  // GET /api/v1/amc/plans
  getPlans: async (req, res, next) => {
    try {
      const plans = AmcService.getPlanInfo();
      return sendSuccess(res, { plans });
    } catch (err) {
      next(err);
    }
  },

  // POST /api/v1/amc/contracts
  createContract: async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, 'Validation failed', 400, errors.array());
      }
      const contract = await AmcService.createContract(req.user.id, req.body);
      return sendSuccess(res, { contract }, 'AMC contract created successfully', 201);
    } catch (err) {
      next(err);
    }
  },

  // GET /api/v1/amc/contracts/my
  getMyContracts: async (req, res, next) => {
    try {
      const contracts = await AmcService.getMyContracts(req.user.id);
      return sendSuccess(res, { contracts });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/v1/amc/contracts (admin)
  getAllContracts: async (req, res, next) => {
    try {
      const { status, limit, offset } = req.query;
      const contracts = await AmcService.getAllContracts({
        status,
        limit: parseInt(limit) || 20,
        offset: parseInt(offset) || 0,
      });
      return sendSuccess(res, { contracts });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/v1/amc/contracts/:id
  getContract: async (req, res, next) => {
    try {
      const contract = await AmcService.getContract(
        req.params.id,
        req.user.id,
        req.user.role
      );
      return sendSuccess(res, { contract });
    } catch (err) {
      next(err);
    }
  },

  // POST /api/v1/amc/contracts/:id/sign
  signContract: async (req, res, next) => {
    try {
      const { customer_esign } = req.body;
      if (!customer_esign) {
        return sendError(res, 'Customer signature is required', 400);
      }
      const contract = await AmcService.signContract(
        req.params.id,
        req.user.id,
        customer_esign
      );
      return sendSuccess(res, { contract }, 'Contract signed successfully');
    } catch (err) {
      next(err);
    }
  },

  // POST /api/v1/amc/contracts/:id/admin-sign (admin)
  adminSignContract: async (req, res, next) => {
    try {
      const { admin_esign } = req.body;
      if (!admin_esign) {
        return sendError(res, 'Admin signature is required', 400);
      }
      const contract = await AmcService.adminSignContract(
        req.params.id,
        admin_esign
      );
      return sendSuccess(res, { contract }, 'Contract signed by admin');
    } catch (err) {
      next(err);
    }
  },

  // PATCH /api/v1/amc/contracts/:id/renew
  renewContract: async (req, res, next) => {
    try {
      const contract = await AmcService.renewContract(
        req.params.id,
        req.user.id,
        req.user.role
      );
      return sendSuccess(res, { contract }, 'Contract renewed successfully');
    } catch (err) {
      next(err);
    }
  },

  // PATCH /api/v1/amc/contracts/:id/cancel (admin)
  cancelContract: async (req, res, next) => {
    try {
      const contract = await AmcService.cancelContract(
        req.params.id,
        req.user.id
      );
      return sendSuccess(res, { contract }, 'Contract cancelled');
    } catch (err) {
      next(err);
    }
  },

  // GET /api/v1/amc/expiring (admin)
  getExpiringSoon: async (req, res, next) => {
    try {
      const { days } = req.query;
      const contracts = await AmcService.getExpiringSoon(parseInt(days) || 30);
      return sendSuccess(res, { contracts });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/v1/amc/sla-breaches (admin)
  getSlaBreaches: async (req, res, next) => {
    try {
      const breaches = await AmcService.getSlaBreaches();
      return sendSuccess(res, { breaches });
    } catch (err) {
      next(err);
    }
  },

};

module.exports = AmcController;