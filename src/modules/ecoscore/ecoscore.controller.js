const EcoScoreService = require('./ecoscore.service');
const { sendSuccess, sendError } = require('../../utils/response');

const EcoScoreController = {

  // POST /api/v1/ecoscore/calculate (legacy — per-job)
  calculateScore: async (req, res, next) => {
    try {
      const { job_id } = req.body;
      const result = await EcoScoreService.calculateScore(job_id);
      return sendSuccess(res, result, 'EcoScore calculated successfully');
    } catch (err) { next(err); }
  },

  // GET /api/v1/ecoscore/:jobId (legacy — per-job)
  getScore: async (req, res, next) => {
    try {
      const score = await EcoScoreService.getScore(req.params.jobId);
      return sendSuccess(res, { score });
    } catch (err) { next(err); }
  },

  // GET /api/v1/ecoscore/leaderboard (legacy — TEAM leaderboard)
  getLeaderboard: async (req, res, next) => {
    try {
      const leaderboard = await EcoScoreService.getLeaderboard();
      return sendSuccess(res, { leaderboard });
    } catch (err) { next(err); }
  },

  // GET /api/v1/ecoscore/trends
  getTrends: async (req, res, next) => {
    try {
      const trends = await EcoScoreService.getTrends();
      return sendSuccess(res, { trends });
    } catch (err) { next(err); }
  },

  // ── NEW: rolling per-customer EcoScore ─────────────────────────────────

  // GET /api/v1/ecoscore/me (customer-protected)
  getMyEcoScore: async (req, res, next) => {
    try {
      const data = await EcoScoreService.getMyScore(req.user.id);
      if (!data || data.score === undefined) {
        return sendSuccess(res, {
          score: 0, badge: 'unrated', rationale: 'No service history yet',
          streak_days: 0, components: {}, history: [],
        });
      }
      return sendSuccess(res, {
        score: data.score,
        badge: data.badge,
        rationale: data.rationale,
        streak_days: data.streak_days,
        last_recalc_at: data.last_recalc_at,
        components: {
          c_amc_plan: Number(data.c_amc_plan),
          c_compliance: Number(data.c_compliance),
          c_timeliness: Number(data.c_timeliness),
          c_addons: Number(data.c_addons),
          c_ratings: Number(data.c_ratings),
          c_water_tests: Number(data.c_water_tests),
          c_referrals: Number(data.c_referrals),
        },
        history: data.history || [],
      });
    } catch (err) { next(err); }
  },

  // GET /api/v1/ecoscore/customer-leaderboard (public — anonymised)
  getCustomerLeaderboard: async (_req, res, next) => {
    try {
      const leaderboard = await EcoScoreService.getCustomerLeaderboard();
      return sendSuccess(res, { leaderboard });
    } catch (err) { next(err); }
  },

  // ── ADMIN ──────────────────────────────────────────────────────────────

  // GET /api/v1/ecoscore/admin/weights
  getWeights: async (_req, res, next) => {
    try {
      const weights = await EcoScoreService.getWeights();
      return sendSuccess(res, { weights });
    } catch (err) { next(err); }
  },

  // PUT /api/v1/ecoscore/admin/weights
  updateWeights: async (req, res, next) => {
    try {
      const updated = await EcoScoreService.updateWeights(req.body || {});
      return sendSuccess(res, { weights: updated }, 'Weights updated.');
    } catch (err) {
      if (err && err.status === 400) {
        return sendError(res, err.message, 400);
      }
      next(err);
    }
  },

  // POST /api/v1/ecoscore/admin/recalc-all
  recalcAll: async (_req, res, next) => {
    try {
      const result = await EcoScoreService.recalcAllCustomers({ concurrency: 5 });
      return sendSuccess(res, result, 'Recalculation complete.');
    } catch (err) { next(err); }
  },

  // GET /api/v1/ecoscore/admin/top
  getTop: async (req, res, next) => {
    try {
      const limit = Math.min(100, parseInt(req.query.limit, 10) || 20);
      const top = await EcoScoreService.getTopCustomers(limit);
      return sendSuccess(res, { top });
    } catch (err) { next(err); }
  },

  // GET /api/v1/ecoscore/admin/bottom
  getBottom: async (req, res, next) => {
    try {
      const limit = Math.min(100, parseInt(req.query.limit, 10) || 20);
      const bottom = await EcoScoreService.getBottomCustomers(limit);
      return sendSuccess(res, { bottom });
    } catch (err) { next(err); }
  },

};

module.exports = EcoScoreController;
