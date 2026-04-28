/**
 * Incentive controller — HTTP boundary for the FA incentive system.
 * Engine + repository do the work; this module shapes responses and
 * validates inputs.
 */

const { sendSuccess, sendError } = require('../../utils/response');
const repo = require('./repository');
const engine = require('./engine');
const service = require('./service');

/* ── helpers ─────────────────────────────────────────────────────── */
const monthFromQuery = (q) => {
  // Accept '2026-04' or '2026-04-01' or '2026-04-15' — coerce to first of month
  const raw = (q || '').trim();
  if (!raw) return engine.monthKey();
  const m = raw.match(/^(\d{4})-(\d{2})/);
  if (!m) return engine.monthKey();
  return `${m[1]}-${m[2]}-01`;
};

const nextMonth = (monthDate) => {
  const d = new Date(monthDate + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
};

/* ── Field-team ──────────────────────────────────────────────────── */

// GET /api/v1/incentives/me
exports.getMyLedger = async (req, res, next) => {
  try {
    const agent_id = req.user.id;
    const month = engine.monthKey();
    const [stats, summary, lines, lastPaid] = await Promise.all([
      (async () => {
        const { rows } = await require('../../config/db').query(
          `SELECT * FROM agent_stats WHERE agent_id = $1`, [agent_id]
        );
        return rows[0] || null;
      })(),
      repo.monthSummary(agent_id, month),
      repo.last30Lines(agent_id, 30),
      repo.lastPaidBatch(agent_id),
    ]);

    // Lazily ensure a current-month batch exists so the FA always sees one
    await engine.ensureBatchForAgentMonth({ agent_id, month }).catch(() => {});

    return sendSuccess(res, {
      tier: stats?.current_tier || 'bronze',
      streak_months: stats?.current_streak_months || 0,
      stats: stats || {
        agent_id,
        jobs_completed_30d: 0,
        avg_rating_30d: 0,
        addon_conversion_30d: 0,
        on_time_pct_30d: 0,
        referrals_30d: 0,
        total_turnover_30d_paise: 0,
        current_tier: 'bronze',
        current_streak_months: 0,
      },
      current_month: month,
      current_month_total_paise: summary.total_paise,
      current_month_breakdown: summary.breakdown,
      last_30_lines: lines,
      last_paid_batch: lastPaid,
      next_payout_eta: nextMonth(month), // freezes on the 1st of next month
    });
  } catch (err) { next(err); }
};

// GET /api/v1/incentives/me/credits
// Returns the agent's current monthly credits + breakdown + tier for the
// FA Incentive screen (Phase B). Live-recalculates if the saved snapshot
// is stale (> 6h old) or missing, so the FA always sees fresh numbers.
exports.getMyCredits = async (req, res, next) => {
  try {
    const agent_id = req.user.id;
    const STALE_MS = 6 * 60 * 60 * 1000; // 6h
    const snap = await repo.getAgentCredits(agent_id);
    const stale = !snap.last_credit_recalc_at
      || (Date.now() - new Date(snap.last_credit_recalc_at).getTime()) > STALE_MS;

    let credits;
    if (stale) {
      credits = await service.recalcAgentCredits(agent_id);
    } else {
      // Recompute on-the-fly raw metrics so the screen has the per-parameter
      // detail panel even when we serve from cache.
      credits = await engine.computeAgentCredits({
        agent_id, month_start: engine.firstOfMonth(),
      });
      credits.month = engine.firstOfMonth();
    }

    return sendSuccess(res, {
      agent_id,
      month: credits.month || engine.firstOfMonth(),
      tier: credits.tier,
      credits_total: credits.total,
      credits_breakdown: credits.breakdown,
      raw_metrics: credits.raw,
      thresholds: {
        platinum: 800, gold: 600, silver: 400, bronze: 200,
      },
      benefits: {
        platinum: { cash_bonus_pct: 0.15, leave_days: 2, badge: 'Star Performer' },
        gold:     { cash_bonus_pct: 0.10, leave_days: 1, badge: 'Gold Recognition' },
        silver:   { cash_bonus_pct: 0.05, leave_days: 0, badge: 'Performance Certificate' },
        bronze:   { cash_bonus_pct: 0,    leave_days: 0, badge: null },
        unrated:  { cash_bonus_pct: 0,    leave_days: 0, badge: null, flag: 'review' },
      },
    });
  } catch (err) { next(err); }
};

// GET /api/v1/incentives/me/history?limit=&offset=
exports.getMyHistory = async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const rows = await repo.historyPage(req.user.id, limit, offset);
    return sendSuccess(res, { rows, limit, offset });
  } catch (err) { next(err); }
};

/* ── Admin ───────────────────────────────────────────────────────── */

// GET /api/v1/admin/incentives/payouts?month=YYYY-MM
exports.adminListPayouts = async (req, res, next) => {
  try {
    const month = monthFromQuery(req.query.month);
    const rows = await repo.listBatchesForMonth(month);
    const totals = rows.reduce(
      (acc, r) => {
        if (r.status === 'paid')   acc.paid_paise   += parseInt(r.total_paise || 0, 10);
        if (r.status === 'frozen') acc.frozen_paise += parseInt(r.total_paise || 0, 10);
        if (r.status === 'open')   acc.open_paise   += parseInt(r.computed_total_paise || 0, 10);
        return acc;
      },
      { paid_paise: 0, frozen_paise: 0, open_paise: 0 }
    );
    return sendSuccess(res, { month, batches: rows, totals });
  } catch (err) { next(err); }
};

// POST /api/v1/admin/incentives/payouts/:batchId/freeze
exports.adminFreezeBatch = async (req, res, next) => {
  try {
    // Apply tier-driven cash bonus + leave days BEFORE freezing so the
    // bonus row is captured in the freeze sweep.
    let tierApplied = null;
    try {
      tierApplied = await service.applyTierBonusToBatch(req.params.batchId);
    } catch (err) {
      // Don't block the freeze on tier-bonus failures; log and continue.
      console.warn('[incentives] applyTierBonusToBatch failed:', err?.message || err);
    }
    const batch = await repo.freezeBatch(req.params.batchId);
    return sendSuccess(res, { batch, tier_bonus: tierApplied }, 'Batch frozen.');
  } catch (err) { next(err); }
};

// GET /api/v1/admin/incentives/credits/:month
// Admin view: every field-team agent's credit + tier for a given month.
exports.adminGetCreditsForMonth = async (req, res, next) => {
  try {
    const raw = (req.params.month || '').trim();
    const m = raw.match(/^(\d{4})-(\d{2})/);
    const month = m ? `${m[1]}-${m[2]}-01` : engine.monthKey();
    const rows = await repo.getAllAgentCreditsForMonth(month);
    const counts = rows.reduce((acc, r) => {
      acc[r.tier] = (acc[r.tier] || 0) + 1;
      return acc;
    }, {});
    return sendSuccess(res, { month, agents: rows, tier_counts: counts });
  } catch (err) { next(err); }
};

// POST /api/v1/admin/incentives/payouts/:batchId/mark-paid
exports.adminMarkPaid = async (req, res, next) => {
  try {
    const { payment_ref, notes } = req.body || {};
    if (!payment_ref || String(payment_ref).trim().length === 0) {
      return sendError(res, 'payment_ref is required.', 400);
    }
    const batch = await repo.markBatchPaid(req.params.batchId, payment_ref, notes);
    return sendSuccess(res, { batch }, 'Batch marked paid.');
  } catch (err) { next(err); }
};

// POST /api/v1/admin/incentives/payouts/:batchId/reverse
exports.adminReverseBatch = async (req, res, next) => {
  try {
    const { reason } = req.body || {};
    const batch = await repo.reverseBatch(req.params.batchId, reason || '');
    return sendSuccess(res, { batch }, 'Batch reversed.');
  } catch (err) { next(err); }
};

// GET /api/v1/admin/incentives/rules
exports.adminGetRules = async (_req, res, next) => {
  try {
    const rules = await repo.getRules();
    return sendSuccess(res, { rules });
  } catch (err) { next(err); }
};

// PUT /api/v1/admin/incentives/rules
exports.adminUpdateRules = async (req, res, next) => {
  try {
    const fields = req.body || {};
    // Lightweight validation — non-negative integers/numerics
    const intKeys = [
      'base_completion_paise','rating_5_paise','rating_4_paise','rating_3_paise',
      'referral_bonus_paise','monthly_target_jobs','monthly_target_bonus_paise',
      'streak_bonus_paise','streak_threshold_months',
      'tier_platinum_paise','tier_gold_paise','tier_silver_paise',
    ];
    const numKeys = [
      'addon_commission_pct',
      'multiplier_platinum','multiplier_gold','multiplier_silver','multiplier_bronze',
    ];
    for (const k of intKeys) {
      if (fields[k] === undefined || fields[k] === null) continue;
      const v = Number(fields[k]);
      if (!Number.isFinite(v) || v < 0 || !Number.isInteger(v)) {
        return sendError(res, `${k} must be a non-negative integer.`, 400);
      }
    }
    for (const k of numKeys) {
      if (fields[k] === undefined || fields[k] === null) continue;
      const v = Number(fields[k]);
      if (!Number.isFinite(v) || v < 0 || v > 10) {
        return sendError(res, `${k} must be a number between 0 and 10.`, 400);
      }
    }
    const rules = await repo.updateRules(fields);
    return sendSuccess(res, { rules }, 'Rules updated.');
  } catch (err) { next(err); }
};
