const EcoScoreService = require('./ecoscore.service');
const { sendSuccess } = require('../../utils/response');

const EcoScoreController = {

  // POST /api/v1/ecoscore/calculate
  calculateScore: async (req, res, next) => {
    try {
      const { job_id } = req.body;
      const result = await EcoScoreService.calculateScore(job_id);
      return sendSuccess(res, result, 'EcoScore calculated successfully');
    } catch (err) {
      next(err);
    }
  },

  // GET /api/v1/ecoscore/:jobId
  getScore: async (req, res, next) => {
    try {
      const score = await EcoScoreService.getScore(req.params.jobId);
      return sendSuccess(res, { score });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/v1/ecoscore/leaderboard
  getLeaderboard: async (req, res, next) => {
    try {
      const leaderboard = await EcoScoreService.getLeaderboard();
      return sendSuccess(res, { leaderboard });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/v1/ecoscore/trends
  getTrends: async (req, res, next) => {
    try {
      const trends = await EcoScoreService.getTrends();
      return sendSuccess(res, { trends });
    } catch (err) {
      next(err);
    }
  },

};

module.exports = EcoScoreController;