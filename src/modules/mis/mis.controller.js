/**
 * MIS controller — thin pass-through to MisService.
 *
 * Every endpoint accepts optional `?from=YYYY-MM-DD&to=YYYY-MM-DD` filters
 * which default to the last 30 days inside the service layer.
 */

const MisService = require('./mis.service');
const { sendSuccess } = require('../../utils/response');

function parseRange(req) {
  const { from, to } = req.query || {};
  return { from, to };
}

const MisController = {

  operational: async (req, res, next) => {
    try {
      const data = await MisService.getOperational(parseRange(req));
      return sendSuccess(res, data, 'Operational MIS');
    } catch (err) { next(err); }
  },

  ecoScore: async (req, res, next) => {
    try {
      const data = await MisService.getEcoScore(parseRange(req));
      return sendSuccess(res, data, 'EcoScore MIS');
    } catch (err) { next(err); }
  },

  revenue: async (req, res, next) => {
    try {
      const data = await MisService.getRevenue(parseRange(req));
      return sendSuccess(res, data, 'Revenue MIS');
    } catch (err) { next(err); }
  },

  customerEngagement: async (req, res, next) => {
    try {
      const data = await MisService.getCustomerEngagement(parseRange(req));
      return sendSuccess(res, data, 'Customer engagement MIS');
    } catch (err) { next(err); }
  },

  sales: async (req, res, next) => {
    try {
      const data = await MisService.getSales(parseRange(req));
      return sendSuccess(res, data, 'Sales MIS');
    } catch (err) { next(err); }
  },

  referrals: async (req, res, next) => {
    try {
      const data = await MisService.getReferrals(parseRange(req));
      return sendSuccess(res, data, 'Referrals MIS');
    } catch (err) { next(err); }
  },

};

module.exports = MisController;
