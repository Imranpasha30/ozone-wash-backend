/**
 * Rewards controller — HTTP layer for the EcoPoints redemption flow.
 */

const { validationResult } = require('express-validator');
const RewardsService = require('./rewards.service');
const { sendSuccess, sendError } = require('../../utils/response');

const RewardsController = {

  // GET /api/v1/rewards (public)
  getCatalog: async (req, res, next) => {
    try {
      const rewards = await RewardsService.getCatalog();
      return sendSuccess(res, { rewards });
    } catch (err) { next(err); }
  },

  // GET /api/v1/rewards/me (authenticated)
  getMyRewards: async (req, res, next) => {
    try {
      const data = await RewardsService.getMyRewards(req.user.id);
      return sendSuccess(res, data);
    } catch (err) { next(err); }
  },

  // POST /api/v1/rewards/redeem (authenticated)
  redeem: async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, 'Validation failed', 400, errors.array());
      }
      const result = await RewardsService.redeem({
        userId: req.user.id,
        reward_slug: req.body.reward_slug,
      });
      return sendSuccess(res, result, 'Reward redeemed.', 201);
    } catch (err) {
      if (err && err.status) {
        return sendError(res, err.message || 'Redemption failed.', err.status);
      }
      next(err);
    }
  },
};

module.exports = RewardsController;
