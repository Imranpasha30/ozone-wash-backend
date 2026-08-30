const { validationResult } = require('express-validator');
const AmcService = require('./amc.service');
const PricingService = require('../../services/pricing');
const EcoScoreService = require('../ecoscore/ecoscore.service');
const { sendSuccess, sendError } = require('../../utils/response');

const AmcController = {

  // GET /api/v1/amc/plans
  // Optional ?tank_size_litres=X&tank_count=N — when supplied, returns the
  // four matrix plans (one_time, monthly, quarterly, half_yearly) with
  // computed totals so the customer can compare side by side.
  getPlans: async (req, res, next) => {
    try {
      const litres = parseFloat(req.query.tank_size_litres);
      const count = Math.max(1, parseInt(req.query.tank_count, 10) || 1);

      // Names/copy come from the admin-editable catalog; prices from the matrix.
      const catalog = await PricingService.listAmcPlans();
      const metaFor = Object.fromEntries(catalog.map((c) => [c.plan, c]));

      // No tank size given → return the catalog (names/copy) without prices.
      if (!litres || !Number.isFinite(litres) || litres <= 0) {
        const plans = catalog
          .filter((c) => c.active !== false)
          .map((c) => ({ plan: c.plan, display_name: c.display_name, headline: c.headline, features: c.features }));
        return sendSuccess(res, { plans, catalog_only: true });
      }

      const tier = await PricingService.tierForLitres(litres);
      if (!tier) {
        return sendError(res, 'No pricing tier matches that tank size.', 400);
      }

      const planNames = ['one_time', 'half_yearly', 'quarterly', 'monthly'];
      const plans = [];
      for (const plan of planNames) {
        const meta = metaFor[plan] || {};
        if (meta.active === false) continue; // hidden by admin
        try {
          const p = await PricingService.priceForBooking({ tier_id: tier.id, plan, tank_count: count });
          plans.push({
            ...p,
            display_name: meta.display_name || plan,
            headline: meta.headline || null,
            features: meta.features || [],
            display_order: meta.display_order ?? 99,
          });
        } catch (e) {
          // Skip plans with no active pricing rather than failing the whole call
        }
      }
      plans.sort((a, b) => (a.display_order ?? 99) - (b.display_order ?? 99));

      return sendSuccess(res, { tier, tank_count: count, plans });
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
      // EcoScore: AMC plan is the strongest single signal — refresh now
      EcoScoreService.recalcOnEvent({
        event: 'amc_renewal',
        user_id: req.user.id,
        ref: contract?.id,
      }).catch(() => {});
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
      // EcoScore: AMC renewal — refresh score (renewal preserves loyalty)
      EcoScoreService.recalcOnEvent({
        event: 'amc_renewal',
        user_id: contract?.customer_id || req.user.id,
        ref: contract?.id,
      }).catch(() => {});
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