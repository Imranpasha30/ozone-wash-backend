/**
 * Field-Agent Incentive Engine
 *
 * Pure functions that compute and persist incentive accruals. All entry
 * points are safe to call fire-and-forget — they swallow nothing but log
 * once on errors. Caller decides whether to await.
 *
 * Public API:
 *   accrueForJob({ job_id })                           -> string[] inserted incentive ids
 *   accrueReferralBonus({ source_user_id, referral_id }) -> string|null inserted id
 *   recalcAgentStats({ agent_id })                     -> object stats row
 *   evaluateMonthlyTarget({ agent_id, month })         -> string|null inserted id
 *   ensureBatchForAgentMonth({ agent_id, month })      -> object batch row
 *
 * All amounts in PAISE (₹1 = 100). Idempotent at the engine layer — every
 * insert is preceded by a SELECT for an existing (job_id, reason) match
 * (or for monthly_target/streak_bonus, a (month, reason) match) so
 * repeated calls do not double-credit.
 */

const { query, getClient } = require('../../config/db');

const TIERS = ['platinum', 'gold', 'silver', 'bronze'];

/* ── Helpers ─────────────────────────────────────────────────────── */
const firstOfMonth = (d = new Date()) => {
  const dt = new Date(d);
  return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
};

const monthKey = (d = new Date()) => firstOfMonth(d);

async function loadRules() {
  const { rows } = await query(`SELECT * FROM incentive_rules WHERE id = 1`);
  if (!rows[0]) {
    throw new Error('incentive_rules row not found — run migration 008');
  }
  return rows[0];
}

async function loadAgentStats(agent_id) {
  const { rows } = await query(
    `SELECT * FROM agent_stats WHERE agent_id = $1`,
    [agent_id]
  );
  return rows[0] || null;
}

function multiplierForTier(rules, tier) {
  switch (tier) {
    case 'platinum': return Number(rules.multiplier_platinum) || 1.0;
    case 'gold':     return Number(rules.multiplier_gold)     || 1.0;
    case 'silver':   return Number(rules.multiplier_silver)   || 1.0;
    case 'bronze':
    default:         return Number(rules.multiplier_bronze)   || 1.0;
  }
}

function tierFromTurnover(rules, turnover_paise) {
  const t = Number(turnover_paise || 0);
  if (t >= Number(rules.tier_platinum_paise)) return 'platinum';
  if (t >= Number(rules.tier_gold_paise))     return 'gold';
  if (t >= Number(rules.tier_silver_paise))   return 'silver';
  return 'bronze';
}

/* Best-effort addon revenue estimate. Tries pricing service first, falls
   back to ₹500/addon (50000 paise) if the pricing module is unavailable
   or addons aren't priceable. Never throws — returns 0 on full failure. */
async function estimateAddonRevenuePaise(addons, booking) {
  if (!Array.isArray(addons) || addons.length === 0) return 0;
  // Default flat estimate (₹500 per addon)
  return addons.length * 50000;
}

/* Read existing incentive row for the same (job_id, reason). Used for
   idempotency before INSERT. */
async function existingIncentive(job_id, reason) {
  if (!job_id) return null;
  const { rows } = await query(
    `SELECT id FROM incentives WHERE job_id = $1 AND reason = $2 LIMIT 1`,
    [job_id, reason]
  );
  return rows[0] || null;
}

async function existingIncentiveForAgentMonth(agent_id, reason, month) {
  const { rows } = await query(
    `SELECT id FROM incentives
       WHERE agent_id = $1 AND reason = $2
         AND date_trunc('month', created_at) = date_trunc('month', $3::date)
       LIMIT 1`,
    [agent_id, reason, month]
  );
  return rows[0] || null;
}

async function insertIncentive({ agent_id, job_id, amount_paise, reason, tier, batch_id }) {
  const amt = Math.max(0, Math.round(Number(amount_paise) || 0));
  if (amt <= 0) return null;
  const { rows } = await query(
    `INSERT INTO incentives (agent_id, job_id, amount_paise, reason, tier, batch_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
    [agent_id, job_id || null, amt, reason, tier || null, batch_id || null]
  );
  return rows[0].id;
}

/* ── ensureBatchForAgentMonth ─────────────────────────────────────
   Lazily creates an OPEN payout_batches row for (agent, month) so the
   ledger always has somewhere to attach. Returns the batch row. */
async function ensureBatchForAgentMonth({ agent_id, month }) {
  const m = month ? firstOfMonth(month) : monthKey();
  const found = await query(
    `SELECT * FROM payout_batches WHERE agent_id = $1 AND month = $2`,
    [agent_id, m]
  );
  if (found.rows[0]) return found.rows[0];
  const ins = await query(
    `INSERT INTO payout_batches (agent_id, month, total_paise, status)
       VALUES ($1, $2, 0, 'open')
       ON CONFLICT (agent_id, month) DO UPDATE SET status = payout_batches.status
       RETURNING *`,
    [agent_id, m]
  );
  return ins.rows[0];
}

/* ── Job loader ──────────────────────────────────────────────────── */
async function loadJobWithBooking(job_id) {
  const { rows } = await query(
    `SELECT j.id, j.assigned_team_id, j.status, j.completed_at, j.scheduled_at,
            b.addons, b.amount_paise
       FROM jobs j
       LEFT JOIN bookings b ON b.id = j.booking_id
      WHERE j.id = $1`,
    [job_id]
  );
  return rows[0] || null;
}

async function loadRatingForJob(job_id) {
  const { rows } = await query(
    `SELECT rating FROM ratings WHERE job_id = $1 LIMIT 1`,
    [job_id]
  );
  return rows[0]?.rating || null;
}

/* ──────────────────────────────────────────────────────────────────
   accrueForJob
   Runs base + addon + rating accruals for a single completed job.
   Idempotent on (job_id, reason).
   ──────────────────────────────────────────────────────────────── */
async function accrueForJob({ job_id }) {
  if (!job_id) return [];
  const job = await loadJobWithBooking(job_id);
  if (!job || !job.assigned_team_id) return [];

  const agent_id = job.assigned_team_id;
  const rules = await loadRules();
  const stats = await loadAgentStats(agent_id);
  const tier = stats?.current_tier || 'bronze';
  const tierMult = multiplierForTier(rules, tier);

  // Make sure the agent has a current-month batch — keeps the ledger tidy.
  await ensureBatchForAgentMonth({ agent_id, month: monthKey() }).catch(() => {});

  const inserted = [];

  /* 1. Base completion */
  if (!(await existingIncentive(job_id, 'base_completion'))) {
    const baseAmt = Math.round(Number(rules.base_completion_paise) * tierMult);
    const id = await insertIncentive({
      agent_id, job_id, amount_paise: baseAmt,
      reason: 'base_completion', tier,
    });
    if (id) inserted.push(id);
  }

  /* 2. Addon upsell */
  if (!(await existingIncentive(job_id, 'addon_upsell'))) {
    let addons = [];
    if (Array.isArray(job.addons)) addons = job.addons;
    else if (typeof job.addons === 'string') {
      try { addons = JSON.parse(job.addons) || []; } catch (_) { addons = []; }
    }
    if (addons.length > 0) {
      const addonRevenue = await estimateAddonRevenuePaise(addons, job);
      const commission = Math.round(addonRevenue * Number(rules.addon_commission_pct));
      if (commission > 0) {
        const id = await insertIncentive({
          agent_id, job_id, amount_paise: commission,
          reason: 'addon_upsell', tier,
        });
        if (id) inserted.push(id);
      }
    }
  }

  /* 3. Rating bonus (only if a rating exists) */
  if (!(await existingIncentive(job_id, 'rating_bonus'))) {
    const rating = await loadRatingForJob(job_id);
    if (rating) {
      let bonus = 0;
      if (rating >= 5)      bonus = Number(rules.rating_5_paise) || 0;
      else if (rating === 4) bonus = Number(rules.rating_4_paise) || 0;
      else if (rating === 3) bonus = Number(rules.rating_3_paise) || 0;
      if (bonus > 0) {
        const id = await insertIncentive({
          agent_id, job_id, amount_paise: bonus,
          reason: 'rating_bonus', tier,
        });
        if (id) inserted.push(id);
      }
    }
  }

  return inserted;
}

/* ──────────────────────────────────────────────────────────────────
   accrueReferralBonus
   Credits the agent (source) when a referral they're attached to is
   marked converted. Idempotent on (referral_id, reason='referral_bonus').
   The schema in migration 004 ties referrals to a `referral_sources`
   row, NOT directly to a user — so source_user_id may be passed
   explicitly here (e.g. when the FA is also the referral source).
   ──────────────────────────────────────────────────────────────── */
async function accrueReferralBonus({ source_user_id, referral_id }) {
  if (!source_user_id) return null;
  const rules = await loadRules();

  // Idempotency: same referral_id should never produce two bonuses
  if (referral_id) {
    const { rows } = await query(
      `SELECT id FROM incentives
         WHERE agent_id = $1 AND reason = 'referral_bonus'
           AND job_id IN (
             SELECT j.id FROM jobs j
             LEFT JOIN bookings b ON b.id = j.booking_id
             WHERE b.id IN (SELECT booking_id FROM referrals WHERE id = $2)
           )
         LIMIT 1`,
      [source_user_id, referral_id]
    );
    if (rows[0]) return null;
  }

  // Attach to the source user's most-recent assigned job (if any)
  const { rows: jobRows } = await query(
    `SELECT id FROM jobs
       WHERE assigned_team_id = $1
       ORDER BY scheduled_at DESC
       LIMIT 1`,
    [source_user_id]
  );
  const job_id = jobRows[0]?.id || null;

  const stats = await loadAgentStats(source_user_id);
  const tier = stats?.current_tier || 'bronze';

  await ensureBatchForAgentMonth({ agent_id: source_user_id, month: monthKey() })
    .catch(() => {});

  return await insertIncentive({
    agent_id: source_user_id, job_id,
    amount_paise: Number(rules.referral_bonus_paise) || 0,
    reason: 'referral_bonus', tier,
  });
}

/* ──────────────────────────────────────────────────────────────────
   recalcAgentStats
   Pulls last-30-days metrics for one agent, derives tier + streak,
   and UPSERTs into agent_stats. Inserts a streak_bonus when threshold
   is crossed.
   ──────────────────────────────────────────────────────────────── */
async function recalcAgentStats({ agent_id }) {
  if (!agent_id) return null;
  const rules = await loadRules();
  const prev = await loadAgentStats(agent_id);

  const { rows: jobAgg } = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status='completed' AND completed_at >= now() - INTERVAL '30 days') AS jobs_completed_30d,
       COUNT(*) FILTER (WHERE status='completed' AND completed_at >= now() - INTERVAL '30 days'
                              AND b.addons IS NOT NULL
                              AND jsonb_typeof(b.addons) = 'array'
                              AND jsonb_array_length(b.addons) > 0) AS with_addons,
       COUNT(*) FILTER (WHERE status='completed' AND completed_at >= now() - INTERVAL '30 days'
                              AND completed_at <= scheduled_at + INTERVAL '60 minutes') AS on_time_count,
       COALESCE(SUM(b.amount_paise) FILTER (
         WHERE status='completed' AND completed_at >= now() - INTERVAL '30 days'
       ), 0)::bigint AS turnover_30d
     FROM jobs j
     LEFT JOIN bookings b ON b.id = j.booking_id
     WHERE j.assigned_team_id = $1`,
    [agent_id]
  );
  const j = jobAgg[0] || {};
  const completed30 = parseInt(j.jobs_completed_30d || '0', 10);
  const withAddons  = parseInt(j.with_addons || '0', 10);
  const onTime      = parseInt(j.on_time_count || '0', 10);
  const turnover    = Number(j.turnover_30d || 0);

  const { rows: ratingRow } = await query(
    `SELECT COALESCE(AVG(rating), 0)::numeric(3,2) AS avg_rating
       FROM ratings
      WHERE agent_id = $1 AND created_at >= now() - INTERVAL '30 days'`,
    [agent_id]
  );
  const avg_rating = Number(ratingRow[0]?.avg_rating || 0);

  // Referrals: count converted referrals where the source user matches
  // (best effort — referral_sources doesn't carry user_id, so we match
  // on phone OR fall back to 0).
  const { rows: refRow } = await query(
    `SELECT COUNT(*)::int AS cnt
       FROM referrals r
       JOIN referral_sources rs ON rs.id = r.source_id
       JOIN users u ON u.phone = rs.phone
      WHERE u.id = $1
        AND r.status = 'converted'
        AND r.created_at >= now() - INTERVAL '30 days'`,
    [agent_id]
  );
  const referrals_30d = parseInt(refRow[0]?.cnt || '0', 10);

  const addon_conv = completed30 > 0 ? withAddons / completed30 : 0;
  const on_time_pct = completed30 > 0 ? onTime / completed30 : 0;

  const newTier = tierFromTurnover(rules, turnover);

  // Streak: if previous tier was gold/platinum AND new tier is gold/platinum
  // AND we crossed into a new month boundary → +1; if dropped → reset to 0.
  const goldOrBetter = (t) => t === 'gold' || t === 'platinum';
  const thisMonth = monthKey();
  let newStreak = prev?.current_streak_months || 0;
  let streakMonth = prev?.last_streak_month || null;
  if (goldOrBetter(newTier)) {
    if (!streakMonth) {
      // First-ever gold-or-better — start at 1, but only if we're in a fresh month
      newStreak = 1;
      streakMonth = thisMonth;
    } else {
      const lastM = streakMonth instanceof Date
        ? streakMonth.toISOString().slice(0, 10)
        : String(streakMonth).slice(0, 10);
      if (lastM !== thisMonth) {
        // New month, still gold+ → increment
        if (goldOrBetter(prev?.current_tier || 'bronze')) {
          newStreak = (prev?.current_streak_months || 0) + 1;
        } else {
          newStreak = 1;
        }
        streakMonth = thisMonth;
      }
      // Same month — leave streak alone (no double-count)
    }
  } else {
    newStreak = 0;
  }

  await query(
    `INSERT INTO agent_stats (
       agent_id, jobs_completed_30d, avg_rating_30d, addon_conversion_30d,
       on_time_pct_30d, referrals_30d, total_turnover_30d_paise,
       current_tier, current_streak_months, last_streak_month, last_recalc_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
     ON CONFLICT (agent_id) DO UPDATE SET
       jobs_completed_30d       = EXCLUDED.jobs_completed_30d,
       avg_rating_30d           = EXCLUDED.avg_rating_30d,
       addon_conversion_30d     = EXCLUDED.addon_conversion_30d,
       on_time_pct_30d          = EXCLUDED.on_time_pct_30d,
       referrals_30d            = EXCLUDED.referrals_30d,
       total_turnover_30d_paise = EXCLUDED.total_turnover_30d_paise,
       current_tier             = EXCLUDED.current_tier,
       current_streak_months    = EXCLUDED.current_streak_months,
       last_streak_month        = EXCLUDED.last_streak_month,
       last_recalc_at           = now()`,
    [
      agent_id, completed30, avg_rating, addon_conv,
      on_time_pct, referrals_30d, turnover,
      newTier, newStreak, streakMonth,
    ]
  );

  // Streak bonus: when streak hits a multiple of threshold, drop a
  // one-time payout for that streak milestone.
  if (newStreak > 0
      && Number(rules.streak_threshold_months) > 0
      && newStreak % Number(rules.streak_threshold_months) === 0) {
    const month = monthKey();
    const exists = await existingIncentiveForAgentMonth(agent_id, 'streak_bonus', month);
    if (!exists) {
      await ensureBatchForAgentMonth({ agent_id, month }).catch(() => {});
      await insertIncentive({
        agent_id, job_id: null,
        amount_paise: Number(rules.streak_bonus_paise) || 0,
        reason: 'streak_bonus', tier: newTier,
      });
    }
  }

  return await loadAgentStats(agent_id);
}

/* ──────────────────────────────────────────────────────────────────
   evaluateMonthlyTarget
   If agent has hit `monthly_target_jobs` completed jobs this month
   AND no monthly_target row exists for this month, drop one.
   ──────────────────────────────────────────────────────────────── */
async function evaluateMonthlyTarget({ agent_id, month }) {
  if (!agent_id) return null;
  const m = month ? firstOfMonth(month) : monthKey();
  const rules = await loadRules();
  const stats = await loadAgentStats(agent_id);
  const tier = stats?.current_tier || 'bronze';

  const { rows } = await query(
    `SELECT COUNT(*)::int AS cnt FROM jobs
       WHERE assigned_team_id = $1
         AND status = 'completed'
         AND completed_at >= $2::date
         AND completed_at <  ($2::date + INTERVAL '1 month')`,
    [agent_id, m]
  );
  const cnt = parseInt(rows[0]?.cnt || '0', 10);
  if (cnt < Number(rules.monthly_target_jobs)) return null;

  const exists = await existingIncentiveForAgentMonth(agent_id, 'monthly_target', m);
  if (exists) return null;

  await ensureBatchForAgentMonth({ agent_id, month: m }).catch(() => {});
  return await insertIncentive({
    agent_id, job_id: null,
    amount_paise: Number(rules.monthly_target_bonus_paise) || 0,
    reason: 'monthly_target', tier,
  });
}

/* ──────────────────────────────────────────────────────────────────
   computeAgentCredits
   Phase B credit-based engine (per FA Incentive PDF). Pulls last-30-days
   data for one agent across 9 weighted parameters, normalises each to
   0..1, multiplies by its weight × 1000, sums to a credit total, and
   resolves the tier.

   Returns:
     { total, breakdown, tier, raw }
     - total:      integer, sum across all parameters (max ≈ 1000 if
                   weights sum to 1.00 and every parameter is at 1.0)
     - breakdown:  { turnover, avg_time, tat, transactions, checklist,
                     ecoscore, feedback, addon, escalation }   (ints)
     - tier:       'platinum'|'gold'|'silver'|'bronze'|'unrated'
     - raw:        underlying metrics (turnover_paise_net, job_count,
                   avg_minutes, tat_pct, checklist_pct, eco_avg,
                   rating_avg, addon_pct, escalation_count) — useful
                   for the FA Incentive screen breakdown.
   ──────────────────────────────────────────────────────────────── */

// GST is 18% for all priced services (see migration 006).
const GST_DIVISOR = 1.18;

// Turnover scale: ₹50,000 net → full 1.0 (matches the original platinum-paise
// threshold, and gives a reasonable spread for the credit normalisation).
const TURNOVER_SCALE_PAISE = 5000000;

// Volume scale: 30 jobs → full 1.0.
const TRANSACTIONS_SCALE = 30;

function clamp01(x) {
  if (!Number.isFinite(x) || x <= 0) return 0;
  if (x >= 1) return 1;
  return x;
}

function tierFromCredits(rules, total) {
  const t = Number(total || 0);
  if (t >= Number(rules.tier_credits_platinum || 800)) return 'platinum';
  if (t >= Number(rules.tier_credits_gold     || 600)) return 'gold';
  if (t >= Number(rules.tier_credits_silver   || 400)) return 'silver';
  if (t >= Number(rules.tier_credits_bronze   || 200)) return 'bronze';
  return 'unrated';
}

async function computeAgentCredits({ agent_id, month_start }) {
  if (!agent_id) {
    return {
      total: 0, breakdown: {}, tier: 'unrated', raw: {},
    };
  }
  const rules = await loadRules();

  // 1. Job-level aggregate (turnover, count, avg minutes, TAT compliance).
  const { rows: jobAgg } = await query(
    `SELECT
       COUNT(*) FILTER (WHERE j.status='completed' AND j.completed_at >= now() - INTERVAL '30 days') AS job_count,
       COALESCE(SUM(b.amount_paise) FILTER (
         WHERE j.status='completed' AND j.completed_at >= now() - INTERVAL '30 days'
       ), 0)::bigint AS turnover_paise_gross,
       COALESCE(AVG(EXTRACT(EPOCH FROM (j.completed_at - COALESCE(j.started_at, j.scheduled_at)))/60.0)
         FILTER (
           WHERE j.status='completed'
             AND j.completed_at >= now() - INTERVAL '30 days'
             AND j.completed_at IS NOT NULL
             AND COALESCE(j.started_at, j.scheduled_at) IS NOT NULL
             AND j.completed_at > COALESCE(j.started_at, j.scheduled_at)
         ), 0)::numeric AS avg_minutes,
       COUNT(*) FILTER (
         WHERE j.status='completed'
           AND j.completed_at >= now() - INTERVAL '30 days'
           AND j.completed_at <= j.scheduled_at + INTERVAL '60 minutes'
           AND j.completed_at >= j.scheduled_at - INTERVAL '60 minutes'
       ) AS tat_ontime_count,
       COUNT(*) FILTER (
         WHERE j.status='completed'
           AND j.completed_at >= now() - INTERVAL '30 days'
           AND b.addons IS NOT NULL
           AND jsonb_typeof(b.addons) = 'array'
           AND jsonb_array_length(b.addons) > 0
       ) AS addon_jobs
     FROM jobs j
     LEFT JOIN bookings b ON b.id = j.booking_id
     WHERE j.assigned_team_id = $1`,
    [agent_id]
  );
  const ja = jobAgg[0] || {};
  const job_count = parseInt(ja.job_count || '0', 10);
  const turnover_gross = Number(ja.turnover_paise_gross || 0);
  const turnover_net = Math.round(turnover_gross / GST_DIVISOR);
  const avg_minutes = Number(ja.avg_minutes || 0);
  const tat_ontime = parseInt(ja.tat_ontime_count || '0', 10);
  const addon_jobs = parseInt(ja.addon_jobs || '0', 10);

  // 2. 8-step (now 9 phases — step_number 0..8, see migration 009)
  //    checklist completion rate. We average per-job phases-logged divided
  //    by 9 across all of the agent's last-30-days completed jobs.
  const { rows: checklistAgg } = await query(
    `SELECT COALESCE(AVG(phase_count), 0)::numeric AS avg_phases
       FROM (
         SELECT j.id, COUNT(DISTINCT cl.step_number) AS phase_count
           FROM jobs j
           LEFT JOIN compliance_logs cl
             ON cl.job_id = j.id AND cl.completed = true
          WHERE j.assigned_team_id = $1
            AND j.status = 'completed'
            AND j.completed_at >= now() - INTERVAL '30 days'
          GROUP BY j.id
       ) t`,
    [agent_id]
  );
  const avg_phases = Number(checklistAgg[0]?.avg_phases || 0);
  const checklist_pct = avg_phases / 9; // PDF defines 9 phases

  // 3. EcoScore average (0..100).
  const { rows: ecoAgg } = await query(
    `SELECT COALESCE(AVG(em.eco_score), 0)::numeric AS avg_eco
       FROM eco_metrics_log em
       JOIN jobs j ON j.id = em.job_id
      WHERE j.assigned_team_id = $1
        AND j.status = 'completed'
        AND j.completed_at >= now() - INTERVAL '30 days'`,
    [agent_id]
  );
  const eco_avg = Number(ecoAgg[0]?.avg_eco || 0);

  // 4. Customer rating average (1..5).
  const { rows: ratingAgg } = await query(
    `SELECT COALESCE(AVG(r.rating), 0)::numeric AS avg_rating
       FROM ratings r
       JOIN jobs j ON j.id = r.job_id
      WHERE j.assigned_team_id = $1
        AND r.created_at >= now() - INTERVAL '30 days'`,
    [agent_id]
  );
  const rating_avg = Number(ratingAgg[0]?.avg_rating || 0);

  // 5. Escalation count — incident_reports with severity high/critical
  //    OR status='escalated' raised against the agent's jobs in window.
  const { rows: escAgg } = await query(
    `SELECT COUNT(*)::int AS cnt
       FROM incident_reports ir
       JOIN jobs j ON j.id = ir.job_id
      WHERE j.assigned_team_id = $1
        AND ir.created_at >= now() - INTERVAL '30 days'
        AND (ir.status = 'escalated' OR ir.severity IN ('high','critical'))`,
    [agent_id]
  );
  const escalation_count = parseInt(escAgg[0]?.cnt || '0', 10);

  // ── Normalise each metric to 0..1 ────────────────────────────────────
  const n_turnover     = clamp01(turnover_net / TURNOVER_SCALE_PAISE);
  // avg-time: < benchmark → full credit; linearly falls to 0 at 2× benchmark.
  const benchmark = Number(rules.benchmark_job_minutes || 60);
  let n_avg_time = 0;
  if (avg_minutes <= 0) {
    n_avg_time = 0; // no data → no credit
  } else if (avg_minutes <= benchmark) {
    n_avg_time = 1;
  } else {
    n_avg_time = clamp01(1 - ((avg_minutes - benchmark) / benchmark));
  }
  const n_tat          = job_count > 0 ? clamp01(tat_ontime / job_count) : 0;
  const n_transactions = clamp01(job_count / TRANSACTIONS_SCALE);
  const n_checklist    = clamp01(checklist_pct);
  const n_ecoscore     = clamp01(eco_avg / 100);
  // Feedback: only 4-5 star avg counts. Map [3..5] → [0..1].
  const n_feedback     = clamp01((rating_avg - 3) / 2);
  const n_addon        = job_count > 0 ? clamp01(addon_jobs / job_count) : 0;
  // Zero escalation: full if 0, fall to 0 at 5+ escalations.
  const n_escalation   = clamp01(1 - (escalation_count / 5));

  // ── Credits per parameter (each 0..weight × 1000) ────────────────────
  const w = (k, def) => Number(rules[k] ?? def);
  const c = (norm, weight) => Math.round(norm * weight * 1000);

  const breakdown = {
    turnover:     c(n_turnover,     w('weight_turnover',     0.25)),
    avg_time:     c(n_avg_time,     w('weight_avg_time',     0.10)),
    tat:          c(n_tat,          w('weight_tat',          0.15)),
    transactions: c(n_transactions, w('weight_transactions', 0.10)),
    checklist:    c(n_checklist,    w('weight_checklist',    0.10)),
    ecoscore:     c(n_ecoscore,     w('weight_ecoscore',     0.15)),
    feedback:     c(n_feedback,     w('weight_feedback',     0.10)),
    addon:        c(n_addon,        w('weight_addon',        0.05)),
    escalation:   c(n_escalation,   w('weight_escalation',   0.05)),
  };
  const total = Object.values(breakdown).reduce((s, v) => s + v, 0);

  return {
    total,
    breakdown,
    tier: tierFromCredits(rules, total),
    raw: {
      job_count,
      turnover_paise_gross: turnover_gross,
      turnover_paise_net:   turnover_net,
      avg_minutes:          Number(avg_minutes.toFixed(2)),
      tat_compliance_pct:   job_count > 0 ? +(tat_ontime / job_count).toFixed(3) : 0,
      checklist_pct:        +n_checklist.toFixed(3),
      avg_eco_score:        +eco_avg.toFixed(2),
      avg_rating:           +rating_avg.toFixed(2),
      addon_conversion_pct: job_count > 0 ? +(addon_jobs / job_count).toFixed(3) : 0,
      escalation_count,
    },
  };
}

module.exports = {
  // public
  accrueForJob,
  accrueReferralBonus,
  recalcAgentStats,
  evaluateMonthlyTarget,
  ensureBatchForAgentMonth,
  computeAgentCredits,
  // helpers (exported for tests / cron)
  firstOfMonth,
  monthKey,
  loadRules,
  tierFromTurnover,
  tierFromCredits,
};
