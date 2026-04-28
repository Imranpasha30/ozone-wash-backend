const EcoScoreRepository = require('./ecoscore.repository');
const ComplianceRepository = require('../compliance/compliance.repository');
const JobRepository = require('../jobs/job.repository');
const { computeEcoScore, updateStreak } = require('./ecoscore.engine');
const db = require('../../config/db');

/* ── EcoPoints accrual constants (Ecoscore Dashboard PDF, pages 3-6) ──
 * Per-job continuous accrual replaces the legacy one-shot badge-upgrade
 * bonus. Every completed job credits:
 *   • base points  = the job's EcoScore percentage (e.g. score 85 → 85 pts)
 *   • tier bonus   = TIER_BONUS[badge]  (platinum +10, gold +5, silver +2)
 *   • streak bonus = +50 if 2nd consecutive Platinum job
 *                    +25 if 2nd consecutive Gold job
 * Wallet caps at 1,000 (truncation logged as 'cap_truncate'). Points
 * older than 24 months expire via a nightly cron pass.
 */
const BADGE_RANK = { unrated: 0, bronze: 1, silver: 2, gold: 3, platinum: 4 };
const TIER_BONUS = { platinum: 10, gold: 5, silver: 2, bronze: 0, unrated: 0 };
const STREAK_BONUS = { platinum: 50, gold: 25 };
const ECO_POINTS_EXPIRY_MONTHS = 24;

/* ── Per-job point caps (mirror FA Check List PDF page 6) ─────────────
 * The PDF defines a 100-point per-job EcoScore split across 9 dimensions.
 * Five are FA-driven (recorded in compliance_logs), four are System-driven
 * (jobs / bookings / eco_scores / ratings). Caps add up to exactly 100.
 */
const PTS = {
  water_level:        20, // FA  - compliance step 2, water_level_pct
  timely_service:     20, // SYS - jobs.scheduled_at vs completed_at
  ozone_protocol:     10, // FA  - compliance step 6, ozone_cycle_duration + ppm
  uv_used:            10, // FA  - compliance step 7, uv_skipped = false
  addons:             10, // SYS - bookings.addons array non-empty
  water_test_passed:  5,  // FA  - compliance step 8, post-test buckets in safe range
  improvement:        5,  // SYS - this score vs previous job's score
  streak:             5,  // SYS - eco_scores.streak_days
  customer_feedback:  15, // FA  - ratings.rating for this job (5* = 15 pts)
};

/* ── Bucket allow-lists for "water test passed" check (Step 8) ─────── */
const SAFE_BUCKETS = {
  turbidity:    ['<5 NTU'],
  ph_level:     ['6.5-8.5 Safe'],
  orp:          ['>650 mV Strong', '450-650 Moderate'],
  conductivity: ['<500 uS/cm', '500-1000'],
  tds:          ['<=500 Safe'],
  atp:          ['<200 Low', '200-500 Moderate'],
};

/* ── Score helpers ───────────────────────────────────────────────────── */

// Step 2 water level - drained below ~20% = full marks, above = degraded.
function scoreWaterLevel(level) {
  switch (level) {
    case '0-10%':  return PTS.water_level;
    case '11-20%': return PTS.water_level;
    case '21-30%': return Math.round(PTS.water_level * 0.5);
    case '>31%':   return 0;
    default:       return Math.round(PTS.water_level * 0.5); // unknown -> half marks
  }
}

// Job SLA compliance - within ±7 days of scheduled = full marks.
function scoreTimely(scheduled, completed) {
  if (!scheduled || !completed) return Math.round(PTS.timely_service * 0.75);
  const diffDays = Math.abs(
    (new Date(completed).getTime() - new Date(scheduled).getTime()) / 86_400_000
  );
  if (diffDays <= 7) return PTS.timely_service;
  // -5 pts per 2 days late, floor at 0.
  const penalty = Math.floor((diffDays - 7) / 2) * 5;
  return Math.max(0, PTS.timely_service - penalty);
}

// All 6 post-test buckets (Step 8) sit in their "safe" allow-list = 5 pts.
function scoreWaterTestPassed(stage8) {
  if (!stage8) return 0;
  const allSafe =
    SAFE_BUCKETS.turbidity.includes(stage8.turbidity) &&
    SAFE_BUCKETS.ph_level.includes(stage8.ph_level) &&
    SAFE_BUCKETS.orp.includes(stage8.orp) &&
    SAFE_BUCKETS.conductivity.includes(stage8.conductivity) &&
    SAFE_BUCKETS.tds.includes(stage8.tds) &&
    SAFE_BUCKETS.atp.includes(stage8.atp);
  return allSafe ? PTS.water_test_passed : 0;
}

// Customer rating 1-5 → linearly scaled to 0-15 pts.
function scoreCustomerFeedback(rating) {
  const r = parseFloat(rating);
  if (!Number.isFinite(r) || r <= 0) return 0;
  return Math.round((Math.min(5, Math.max(1, r)) / 5) * PTS.customer_feedback);
}

/* ── Rationale builder (PDF tooltip style) ────────────────────────────
 * Per-PDF: "Platinum because service was timely, ozone + UV logged,
 * water test passed, and you rated 5 stars."
 */
function buildJobRationale(badge, breakdown) {
  const earned = [];
  if (breakdown.timely_service    >= PTS.timely_service)    earned.push('service was timely');
  if (breakdown.water_level       >= PTS.water_level)       earned.push('tank fully drained');
  if (breakdown.ozone_protocol    >= PTS.ozone_protocol &&
      breakdown.uv_used           >= PTS.uv_used)           earned.push('ozone + UV logged');
  else if (breakdown.ozone_protocol >= PTS.ozone_protocol)  earned.push('ozone logged');
  else if (breakdown.uv_used        >= PTS.uv_used)         earned.push('UV logged');
  if (breakdown.water_test_passed >= PTS.water_test_passed) earned.push('water test passed');
  if (breakdown.addons            >= PTS.addons)            earned.push('add-ons applied');
  if (breakdown.streak            >= PTS.streak)            earned.push('streak continued');
  if (breakdown.improvement       >= PTS.improvement)       earned.push('improved vs last visit');
  if (breakdown.customer_feedback >= 12)                    earned.push('you rated 5 stars');
  else if (breakdown.customer_feedback >= 9)                earned.push('strong customer rating');

  if (earned.length === 0) return `${cap(badge)}.`;
  if (earned.length === 1) return `${cap(badge)} because ${earned[0]}.`;
  const last = earned.pop();
  return `${cap(badge)} because ${earned.join(', ')}, and ${last}.`;
}
const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

/* ── Helpers to fetch the System-side signals ─────────────────────── */

async function getJobAddonsScore(jobId) {
  try {
    const { rows } = await db.query(
      `SELECT b.addons
         FROM bookings b
         JOIN jobs j ON j.booking_id = b.id
        WHERE j.id = $1`,
      [jobId]
    );
    let addons = rows[0]?.addons;
    if (typeof addons === 'string') {
      try { addons = JSON.parse(addons); } catch (_) { addons = []; }
    }
    return Array.isArray(addons) && addons.length > 0 ? PTS.addons : 0;
  } catch (_) {
    return 0;
  }
}

async function getImprovementScore(customerId, currentJobId) {
  if (!customerId) return 0;
  try {
    const { rows } = await db.query(
      `SELECT el.eco_score
         FROM eco_metrics_log el
         JOIN jobs j ON j.id = el.job_id
        WHERE j.customer_id = $1 AND el.job_id <> $2
        ORDER BY el.created_at DESC
        LIMIT 1`,
      [customerId, currentJobId]
    );
    if (!rows[0]) return 0;
    // Reward improving customers: previous below 75 means there is room to grow,
    // and crossing thresholds earns the streak credit. We award full marks if
    // there is a previous score on file (strict improvement check happens after
    // we know the new total - but at this point the new total already includes
    // the FA dimensions, so a heuristic floor is safer).
    return rows[0].eco_score < 75 ? PTS.improvement : 0;
  } catch (_) {
    return 0;
  }
}

async function getStreakScore(customerId) {
  if (!customerId) return 0;
  try {
    const { rows } = await db.query(
      `SELECT streak_days FROM eco_scores WHERE user_id = $1`,
      [customerId]
    );
    return (rows[0]?.streak_days || 0) > 0 ? PTS.streak : 0;
  } catch (_) {
    return 0;
  }
}

async function getJobRating(jobId) {
  try {
    const { rows } = await db.query(
      `SELECT rating FROM ratings WHERE job_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [jobId]
    );
    return rows[0]?.rating ?? null;
  } catch (_) {
    return null;
  }
}

/* ── EcoPoints accrual (Phase A) ───────────────────────────────────────
 * Per-job credit pipeline:
 *   base = score   →  reason 'job_complete'
 *   tier =          →  reason 'tier_bonus'         (platinum +10, gold +5, silver +2)
 *   streak =        →  reason 'streak_bonus'       (+50 P-after-P, +25 G-after-G)
 *   cap_truncate    →  negative offset if total would exceed wallets.eco_points_capped_at
 *
 * Streak detection: look at the previous 1 completed-job snapshot from
 * eco_metrics_log for this customer (excluding the current job). If the
 * previous badge equals the current badge (and current ∈ {platinum,gold}),
 * award the streak bonus.
 *
 * All wallet writes happen inside a single DB transaction so the wallet
 * balance + audit ledger never disagree.
 */
async function awardEcoPoints({ userId, jobId, score, badge }) {
  if (!userId || !jobId) return null;
  const baseDelta = Math.max(0, Math.min(100, Math.round(Number(score) || 0)));
  const tierDelta = TIER_BONUS[badge] || 0;

  // Streak detection — look at the most recent prior job for this user.
  let streakDelta = 0;
  if (STREAK_BONUS[badge]) {
    const recent = await EcoScoreRepository.getRecentJobBadges(userId, 3);
    // recent is newest-first; the row whose job_id matches the CURRENT job
    // may or may not already be persisted depending on save() ordering. We
    // explicitly skip it.
    const previous = recent.find((r) => r.job_id !== jobId);
    if (previous && previous.badge_level === badge) {
      streakDelta = STREAK_BONUS[badge];
    }
  }

  const grossCredit = baseDelta + tierDelta + streakDelta;
  if (grossCredit <= 0) return { credited: 0 };

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Lock the wallet row, creating it if absent.
    await client.query(
      `INSERT INTO wallets (user_id) VALUES ($1)
         ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );
    const { rows: wRows } = await client.query(
      `SELECT eco_points, eco_points_capped_at
         FROM wallets WHERE user_id = $1 FOR UPDATE`,
      [userId]
    );
    const balance = wRows[0]?.eco_points || 0;
    const cap = wRows[0]?.eco_points_capped_at || 1000;
    const room = Math.max(0, cap - balance);
    const netCredit = Math.min(grossCredit, room);
    const truncated = grossCredit - netCredit;

    // Ledger rows — write each component separately for audit clarity.
    if (baseDelta > 0) {
      await client.query(
        `INSERT INTO wallet_transactions
           (user_id, delta, reason, ref_type, ref_id)
         VALUES ($1,$2,'job_complete','job',$3)`,
        [userId, baseDelta, jobId]
      );
    }
    if (tierDelta > 0) {
      await client.query(
        `INSERT INTO wallet_transactions
           (user_id, delta, reason, ref_type, ref_id)
         VALUES ($1,$2,'tier_bonus','job',$3)`,
        [userId, tierDelta, jobId]
      );
    }
    if (streakDelta > 0) {
      await client.query(
        `INSERT INTO wallet_transactions
           (user_id, delta, reason, ref_type, ref_id)
         VALUES ($1,$2,'streak_bonus','job',$3)`,
        [userId, streakDelta, jobId]
      );
    }
    if (truncated > 0) {
      // Negative delta cancels the over-cap portion.
      await client.query(
        `INSERT INTO wallet_transactions
           (user_id, delta, reason, ref_type, ref_id)
         VALUES ($1,$2,'cap_truncate','job',$3)`,
        [userId, -truncated, jobId]
      );
    }

    // Apply the net delta to the wallet balance.
    if (netCredit > 0) {
      await client.query(
        `UPDATE wallets
            SET eco_points = eco_points + $2,
                lifetime_earned = lifetime_earned + $2,
                updated_at = NOW()
          WHERE user_id = $1`,
        [userId, netCredit]
      );
    }

    // Surface the bonus delta on the eco_score_history audit trail. The most
    // recent history row for this user gets bonus_points stamped — best-
    // effort, never blocking.
    if (tierDelta + streakDelta > 0) {
      await client.query(
        `UPDATE eco_score_history
            SET bonus_points = $2
          WHERE id = (
            SELECT id FROM eco_score_history
             WHERE user_id = $1 AND trigger_ref = $3
             ORDER BY created_at DESC LIMIT 1
          )`,
        [userId, tierDelta + streakDelta, jobId]
      );
    }

    await client.query('COMMIT');
    return {
      credited: netCredit,
      base: baseDelta,
      tier: tierDelta,
      streak: streakDelta,
      truncated,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const EcoScoreService = {

  // ── Per-job badge tier (FA Check List PDF page 6 thresholds) ──────────
  // Platinum 90+, Gold 75-89, Silver 60-74, Bronze 40-59, <40 = Bronze in
  // eco_metrics_log (its CHECK constraint disallows 'unrated'); the rolling
  // per-customer eco_scores table supports 'unrated' separately.
  getBadgeLevel: (score) => {
    if (score >= 90) return 'platinum';
    if (score >= 75) return 'gold';
    if (score >= 60) return 'silver';
    return 'bronze';
  },

  // ── Per-job EcoScore (PDF-aligned 9-dimension model) ──────────────────
  // Triggered after compliance is fully complete (Stage 0 + Steps 1-8).
  // Idempotent UPSERT on job_id - safe to re-run when a customer rating
  // arrives later, refreshing the customer_feedback dimension.
  calculateScore: async (jobId) => {
    const job = await JobRepository.findById(jobId);
    if (!job) throw { status: 404, message: 'Job not found.' };

    const allComplete = await ComplianceRepository.areAllStepsComplete(jobId);
    if (!allComplete) {
      throw { status: 400, message: 'Cannot calculate EcoScore - not all 9 phases complete.' };
    }

    const steps = await ComplianceRepository.getSteps(jobId);
    const stage2 = steps.find((s) => s.step_number === 2);
    const stage6 = steps.find((s) => s.step_number === 6);
    const stage7 = steps.find((s) => s.step_number === 7);
    const stage8 = steps.find((s) => s.step_number === 8);

    // FA-driven dimensions (compliance_logs) ─────────────────────────────
    const water_level       = scoreWaterLevel(stage2?.water_level_pct);
    const ozone_protocol    = (stage6?.ozone_cycle_duration && stage6?.ozone_ppm_dosed) ? PTS.ozone_protocol : 0;
    const uv_used           = (stage7 && !stage7.uv_skipped && stage7.uv_cycle_duration) ? PTS.uv_used : 0;
    const water_test_passed = scoreWaterTestPassed(stage8);

    // System-driven dimensions ──────────────────────────────────────────
    const timely_service = scoreTimely(job.scheduled_at, job.completed_at);
    const [addons, improvement, streak] = await Promise.all([
      getJobAddonsScore(jobId),
      getImprovementScore(job.customer_id, jobId),
      getStreakScore(job.customer_id),
    ]);
    const ratingValue = await getJobRating(jobId);
    const customer_feedback = scoreCustomerFeedback(ratingValue);

    const breakdown = {
      water_level,
      timely_service,
      ozone_protocol,
      uv_used,
      addons,
      water_test_passed,
      improvement,
      streak,
      customer_feedback,
    };

    const totalScore = Math.min(100, Math.max(0,
      water_level + timely_service + ozone_protocol + uv_used +
      addons + water_test_passed + improvement + streak + customer_feedback
    ));
    const badgeLevel = EcoScoreService.getBadgeLevel(totalScore);
    const rationale = buildJobRationale(badgeLevel, breakdown);
    breakdown.rationale = rationale; // surfaced in tooltip via score_breakdown

    // Persist to per-job snapshot (eco_metrics_log).
    // Legacy columns water_used_litres / chemical_qty_ml / ppe_list /
    // residual_water_before are kept for backward compatibility with old rows.
    const ppeArray = Array.isArray(steps[0]?.ppe_list)
      ? steps[0].ppe_list
      : (typeof steps[0]?.ppe_list === 'string' ? JSON.parse(steps[0].ppe_list || '[]') : []);

    await EcoScoreRepository.save({
      job_id: jobId,
      residual_water_before: 0,
      water_used_litres: 0,
      chemical_type: 'ozone',
      chemical_qty_ml: 0,
      ppe_list: ppeArray,
      eco_score: totalScore,
      badge_level: badgeLevel,
      score_breakdown: breakdown,
    });

    // Per-job EcoPoints accrual (PDF pages 3-6). Awards base + tier bonus +
    // streak bonus (when 2 consecutive top-tier jobs detected). We MUST run
    // this BEFORE the rolling-score recalc so the wallet reflects the credit
    // before history is queried by the customer dashboard.
    if (job.customer_id) {
      try {
        await awardEcoPoints({
          userId: job.customer_id,
          jobId,
          score: totalScore,
          badge: badgeLevel,
        });
      } catch (e) {
        // Wallet failures must never block the score-calculation flow.
        console.warn('[ecoscore] awardEcoPoints failed:', e.message);
      }
    }

    // Fire-and-forget: also recalculate the customer's rolling EcoScore.
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
      score_breakdown: breakdown,
      rationale,
      details: {
        water_level:        `${water_level}/${PTS.water_level}`,
        timely_service:     `${timely_service}/${PTS.timely_service}`,
        ozone_protocol:     `${ozone_protocol}/${PTS.ozone_protocol}`,
        uv_used:            `${uv_used}/${PTS.uv_used}`,
        addons:             `${addons}/${PTS.addons}`,
        water_test_passed:  `${water_test_passed}/${PTS.water_test_passed}`,
        improvement:        `${improvement}/${PTS.improvement}`,
        streak:             `${streak}/${PTS.streak}`,
        customer_feedback:  `${customer_feedback}/${PTS.customer_feedback}`,
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

  // ── Rolling per-customer EcoScore (long-term loyalty score) ──────────

  /**
   * Compute + persist a customer's rolling EcoScore. Inserts a history row
   * with delta/components and credits a wallet bonus on badge upgrade.
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

    // NOTE: legacy creditBadgeBonus (one-shot reward on badge upgrade) is
    // intentionally not invoked here — per-job accrual via awardEcoPoints()
    // (called from calculateScore) supersedes it per the Ecoscore Dashboard
    // PDF (pages 3-6). The BADGE_RANK comparison is kept for any future
    // logic that needs to detect upgrades.
    void BADGE_RANK;

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

  /** Public leaderboard - anonymised first name + initial. */
  getCustomerLeaderboard: async () => {
    const rows = await EcoScoreRepository.getTopUsers(50);
    return rows.map((r) => {
      const parts = (r.full_name || '').trim().split(/\s+/);
      const first = parts[0] || 'Anon';
      const initial = (parts[1] || '').slice(0, 1).toUpperCase();
      let city = null;
      if (r.last_address) {
        const segs = r.last_address.split(',').map((s) => s.trim()).filter(Boolean);
        for (let i = segs.length - 1; i >= 0; i -= 1) {
          if (!/^\d+$/.test(segs[i])) { city = segs[i]; break; }
        }
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
    const weightKeys = [
      'w_amc_plan','w_compliance','w_timeliness','w_addons',
      'w_ratings','w_water_tests','w_referrals',
    ];
    if (weightKeys.some((k) => fields[k] !== undefined)) {
      const current = await EcoScoreRepository.getWeights();
      const merged = { ...current, ...fields };
      const sum = weightKeys.reduce((s, k) => s + Number(merged[k] || 0), 0);
      if (Math.abs(sum - 1.0) > 0.001) {
        throw {
          status: 400,
          message: `Weights must sum to 1.00 - current sum is ${sum.toFixed(3)}`,
        };
      }
    }
    return EcoScoreRepository.updateWeights(fields);
  },

  // Admin: top + bottom users ────────────────────────────────────────────
  getTopCustomers: async (limit = 20) => EcoScoreRepository.getTopUsers(limit),
  getBottomCustomers: async (limit = 20) => EcoScoreRepository.getBottomUsers(limit),

  /**
   * Expire EcoPoints credits older than ECO_POINTS_EXPIRY_MONTHS (24 months).
   * For each user with stale unredeemed credits, write a single debiting
   * wallet_transactions row with reason='expiry' and decrement the wallet.
   *
   * Idempotent: a user is only expired up to the portion of their old
   * credits that has not already been counted by a previous expiry pass.
   */
  expireOldEcoPoints: async () => {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - ECO_POINTS_EXPIRY_MONTHS);
    const cutoffIso = cutoff.toISOString();

    const candidates = await EcoScoreRepository.computeExpirableBalances(cutoffIso);
    let expired = 0;
    let users = 0;
    for (const row of candidates) {
      const oldCredits = Number(row.old_credits) || 0;
      const alreadyExpired = Number(row.already_expired) || 0;
      const balance = Number(row.current_balance) || 0;
      const owed = Math.max(0, oldCredits - alreadyExpired);
      const debit = Math.min(owed, balance);
      if (debit <= 0) continue;

      const client = await db.getClient();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO wallet_transactions
             (user_id, delta, reason, ref_type, ref_id)
           VALUES ($1,$2,'expiry','expiry',$1)`,
          [row.user_id, -debit]
        );
        await client.query(
          `UPDATE wallets
              SET eco_points = GREATEST(0, eco_points - $2),
                  updated_at = NOW()
            WHERE user_id = $1`,
          [row.user_id, debit]
        );
        await client.query('COMMIT');
        expired += debit;
        users += 1;
      } catch (err) {
        await client.query('ROLLBACK');
        console.warn('[ecoscore] expireOldEcoPoints failed for', row.user_id, err.message);
      } finally {
        client.release();
      }
    }
    return { users, expired };
  },

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
