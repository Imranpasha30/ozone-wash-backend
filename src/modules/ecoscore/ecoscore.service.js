const EcoScoreRepository = require('./ecoscore.repository');
const ComplianceRepository = require('../compliance/compliance.repository');
const JobRepository = require('../jobs/job.repository');
const { computeEcoScore, updateStreak } = require('./ecoscore.engine');

/* ── Wallet bonus on badge upgrade ─────────────────────────────────────
 *  Customers earn bonus eco-points when their badge improves. Awarded
 *  once per upgrade event — going down does NOT debit anything.
 */
const BADGE_RANK = { unrated: 0, bronze: 1, silver: 2, gold: 3, platinum: 4 };
const BADGE_BONUS = { silver: 100, gold: 200, platinum: 500 };

const EcoScoreService = {

  // ── LEGACY: per-job badge from raw score (used by field team flow) ──
  getBadgeLevel: (score) => {
    if (score >= 86) return 'platinum';
    if (score >= 66) return 'gold';
    if (score >= 41) return 'silver';
    return 'bronze';
  },

  // ── LEGACY: compute + persist a per-job EcoScore (eco_metrics_log) ──
  // Kept intact for the field-team compliance flow. Now ALSO triggers a
  // recalc of the customer's rolling EcoScore behind the scenes.
  calculateScore: async (jobId) => {
    const job = await JobRepository.findById(jobId);
    if (!job) throw { status: 404, message: 'Job not found.' };

    const steps = await ComplianceRepository.getSteps(jobId);
    if (steps.length < 8) {
      throw { status: 400, message: 'Cannot calculate EcoScore — not all 8 steps complete.' };
    }

    const step2 = steps.find((s) => s.step_number === 2);
    const step5 = steps.find((s) => s.step_number === 5);
    const step3 = steps.find((s) => s.step_number === 3);

    const scoreBreakdown = {};
    const tankSizeLitres = parseFloat(job.tank_size_litres) || 500;
    const waterUsed = parseFloat(step5?.chemical_qty_ml) || 0;
    const waterBenchmark = tankSizeLitres * 0.3;

    let waterScore = 25;
    if (waterUsed > waterBenchmark) {
      const overPercent = ((waterUsed - waterBenchmark) / waterBenchmark) * 100;
      waterScore = Math.max(0, 25 - Math.floor(overPercent / 10) * 5);
    }
    scoreBreakdown.water_score = waterScore;

    const chemicalQty = parseFloat(step5?.chemical_qty_ml) || 0;
    const chemicalBenchmark = 500;
    let chemicalScore = 20;
    if (chemicalQty > chemicalBenchmark) {
      const overUse = ((chemicalQty - chemicalBenchmark) / chemicalBenchmark);
      chemicalScore = Math.max(0, Math.round(20 * (1 - overUse)));
    }
    scoreBreakdown.chemical_score = chemicalScore;

    const requiredPPE = ['mask', 'gloves', 'boots', 'suit'];
    const loggedPPE = step2?.ppe_list || [];
    const ppeArray = Array.isArray(loggedPPE)
      ? loggedPPE
      : JSON.parse(loggedPPE || '[]');
    const missingPPE = requiredPPE.filter((item) => !ppeArray.includes(item));
    const ppeScore = Math.max(0, 25 - (missingPPE.length * 6));
    scoreBreakdown.ppe_score = ppeScore;

    let timeScore = 15;
    if (job.completed_at && job.scheduled_at) {
      const scheduledEnd = new Date(job.scheduled_at);
      scheduledEnd.setHours(scheduledEnd.getHours() + 3);
      const completedAt = new Date(job.completed_at);
      if (completedAt > scheduledEnd) {
        const lateMinutes = (completedAt - scheduledEnd) / (1000 * 60);
        timeScore = Math.max(0, 15 - Math.floor(lateMinutes / 30) * 5);
      }
    }
    scoreBreakdown.time_score = timeScore;

    const residualScore = (step3?.photo_before_url && step3?.photo_after_url) ? 15 : 7;
    scoreBreakdown.residual_score = residualScore;

    const totalScore = Math.min(100, Math.max(0,
      waterScore + chemicalScore + ppeScore + timeScore + residualScore
    ));
    const badgeLevel = EcoScoreService.getBadgeLevel(totalScore);

    const saved = await EcoScoreRepository.save({
      job_id: jobId,
      residual_water_before: 0,
      water_used_litres: waterUsed,
      chemical_type: step5?.chemical_type || 'ozone',
      chemical_qty_ml: chemicalQty,
      ppe_list: ppeArray,
      eco_score: totalScore,
      badge_level: badgeLevel,
      score_breakdown: scoreBreakdown,
    });

    // Fire-and-forget: also recalculate the customer's rolling EcoScore.
    // Never throw — never block the field-team flow.
    if (job.customer_id) {
      EcoScoreService.recalcAndStore({
        user_id: job.customer_id,
        trigger: 'job_complete',
        trigger_ref: jobId,
      }).catch(() => {});
    }

    return {
      job_id: jobId,
      eco_score: totalScore,
      badge_level: badgeLevel,
      score_breakdown: scoreBreakdown,
      details: {
        water: `${waterScore}/25`,
        chemical: `${chemicalScore}/20`,
        ppe: `${ppeScore}/25`,
        timeliness: `${timeScore}/15`,
        residual: `${residualScore}/15`,
      },
    };
  },

  getScore: async (jobId) => {
    const score = await EcoScoreRepository.findByJob(jobId);
    if (!score) throw { status: 404, message: 'EcoScore not calculated yet for this job.' };
    return score;
  },

  getLeaderboard: async () => EcoScoreRepository.getTeamLeaderboard(),
  getTrends: async () => EcoScoreRepository.getTrends(),

  // ── NEW: Rolling per-customer EcoScore ────────────────────────────────

  /**
   * Compute + persist a customer's rolling EcoScore. Inserts a history row
   * with delta/components and credits a wallet bonus on badge upgrade.
   * Returns the new eco_scores row plus the previous one (for the caller).
   */
  recalcAndStore: async ({ user_id, trigger, trigger_ref }) => {
    if (!user_id) throw { status: 400, message: 'user_id required.' };

    const previous = await EcoScoreRepository.getCurrent(user_id);
    const result = await computeEcoScore({ user_id });

    const streak_days = updateStreak(previous, result.badge);

    const saved = await EcoScoreRepository.upsertCurrent({
      user_id,
      score: result.score,
      badge: result.badge,
      rationale: result.rationale,
      streak_days,
      components: result.components,
    });

    const delta = previous ? result.score - previous.score : result.score;

    await EcoScoreRepository.insertHistory({
      user_id,
      score: result.score,
      badge: result.badge,
      delta,
      trigger,
      trigger_ref,
      rationale: result.rationale,
      components: result.components,
    });

    // Wallet bonus when badge has IMPROVED. Going down does nothing.
    const prevRank = BADGE_RANK[previous?.badge || 'unrated'];
    const newRank = BADGE_RANK[result.badge];
    if (newRank > prevRank && BADGE_BONUS[result.badge]) {
      try {
        await EcoScoreRepository.creditBadgeBonus({
          user_id,
          points: BADGE_BONUS[result.badge],
          ref_id: trigger_ref || null,
        });
      } catch (_) { /* never block on wallet failure */ }
    }

    return { previous, current: saved, delta, history_inserted: true };
  },

  /** Thin wrapper used by triggering modules (booking/job/amc/rating). */
  recalcOnEvent: async ({ event, user_id, ref }) => {
    if (!user_id) return null;
    return EcoScoreService.recalcAndStore({
      user_id,
      trigger: event || 'admin_adjust',
      trigger_ref: ref || null,
    });
  },

  /** Get the current rolling score + last 10 history rows for a user. */
  getMyScore: async (userId) => {
    let current = await EcoScoreRepository.getCurrent(userId);
    if (!current) {
      // First-time read — compute + persist a baseline so we always have data
      try {
        const seeded = await EcoScoreService.recalcAndStore({
          user_id: userId,
          trigger: 'first_view',
        });
        current = seeded.current;
      } catch (_) { /* fall through */ }
    }
    const history = await EcoScoreRepository.getHistory(userId, 10);
    return { ...current, history };
  },

  /** Public leaderboard — anonymised first name + initial. */
  getCustomerLeaderboard: async () => {
    const rows = await EcoScoreRepository.getTopUsers(50);
    return rows.map((r) => {
      const parts = (r.full_name || '').trim().split(/\s+/);
      const first = parts[0] || 'Anon';
      const initial = (parts[1] || '').slice(0, 1).toUpperCase();
      // Best-effort city from "<line>, <city>[, <pincode>]" address.
      // We pick the LAST non-numeric segment so a trailing pincode is skipped.
      let city = null;
      if (r.last_address) {
        const segs = r.last_address.split(',').map((s) => s.trim()).filter(Boolean);
        for (let i = segs.length - 1; i >= 0; i -= 1) {
          if (!/^\d+$/.test(segs[i])) { city = segs[i]; break; }
        }
        // Avoid leaking a street-number-prefixed line as the "city"
        if (city && /^\d+\s/.test(city) && segs.length > 1) city = segs[segs.length - 1];
      }
      return {
        display_name: initial ? `${first} ${initial}.` : first,
        score: r.score,
        badge: r.badge,
        streak_days: r.streak_days,
        city,
      };
    });
  },

  // Admin: weights ───────────────────────────────────────────────────────
  getWeights: async () => EcoScoreRepository.getWeights(),

  updateWeights: async (fields) => {
    // Validate that the 7 weights sum to 1.00 if any of them are being set
    const weightKeys = [
      'w_amc_plan','w_compliance','w_timeliness','w_addons',
      'w_ratings','w_water_tests','w_referrals',
    ];
    if (weightKeys.some((k) => fields[k] !== undefined)) {
      const current = await EcoScoreRepository.getWeights();
      const merged = { ...current, ...fields };
      const sum = weightKeys.reduce((s, k) => s + Number(merged[k] || 0), 0);
      // Allow tiny floating-point slack
      if (Math.abs(sum - 1.0) > 0.001) {
        throw {
          status: 400,
          message: `Weights must sum to 1.00 — current sum is ${sum.toFixed(3)}`,
        };
      }
    }
    return EcoScoreRepository.updateWeights(fields);
  },

  // Admin: top + bottom users ────────────────────────────────────────────
  getTopCustomers: async (limit = 20) => EcoScoreRepository.getTopUsers(limit),
  getBottomCustomers: async (limit = 20) => EcoScoreRepository.getBottomUsers(limit),

  /** Admin trigger: recompute every active customer (sync small batches). */
  recalcAllCustomers: async ({ concurrency = 5 } = {}) => {
    const ids = await EcoScoreRepository.listActiveCustomerIds();
    let ok = 0, fail = 0;
    for (let i = 0; i < ids.length; i += concurrency) {
      const batch = ids.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        batch.map((id) => EcoScoreService.recalcAndStore({
          user_id: id,
          trigger: 'cron_nightly',
        }))
      );
      results.forEach((r) => {
        if (r.status === 'fulfilled') ok += 1;
        else fail += 1;
      });
    }
    return { total: ids.length, ok, fail };
  },
};

module.exports = EcoScoreService;
