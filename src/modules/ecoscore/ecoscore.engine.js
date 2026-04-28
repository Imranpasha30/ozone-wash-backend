/**
 * EcoScore engine — production-grade computation of a customer's
 * 0..100 hygiene + loyalty rating.
 *
 * Pure(ish) function: reads from DB, returns { score, badge, rationale,
 * streak_days, components } — does NOT write. Persistence is the
 * service layer's job (see ecoscore.service.js -> recalcAndStore).
 *
 * Signals (each normalised 0..1, then weighted):
 *   c_amc_plan     — 0.30 — driven by AMC plan frequency (monthly = best)
 *   c_compliance   — 0.20 — avg steps_logged / 8 across last 5 jobs
 *   c_timeliness   — 0.15 — on_time_jobs / total in last 12 months
 *   c_addons       — 0.10 — % of last 5 jobs with at least one addon
 *   c_ratings      — 0.15 — avg rating customer has GIVEN to crews
 *   c_water_tests  — 0.05 — % of last 5 jobs with pre+post photos
 *   c_referrals    — 0.05 — converted referrals / 3 (cap 1.0)
 *
 * Weights & thresholds live in eco_score_weights (id = 1) so admins
 * can tune without a redeploy.
 */

const { query } = require('../../config/db');

/* ── Plan → loyalty score ──────────────────────────────────────────────
 * Maps an AMC plan_type to a 0..1 loyalty signal. We support both the
 * historical plan strings (monthly/quarterly/halfyearly/...) used in
 * amc_contracts and the new pricing-matrix plan ids.
 */
const PLAN_SIGNAL = {
  monthly:     1.00,
  bimonthly:   0.90,
  quarterly:   0.80,
  '4month':    0.70,
  half_yearly: 0.60,
  halfyearly:  0.60,
  yearly:      0.45,
  one_time:    0.30,
};

/* ── Default weights (mirrored in 007 migration) ─────────────────────── */
const DEFAULT_WEIGHTS = {
  w_amc_plan:    0.30,
  w_compliance:  0.20,
  w_timeliness:  0.15,
  w_addons:      0.10,
  w_ratings:     0.15,
  w_water_tests: 0.05,
  w_referrals:   0.05,
  t_platinum:    90,
  t_gold:        75,
  t_silver:      60,
  t_bronze:      40,
};

/* ── On-time interval (days) per plan ────────────────────────────────── */
const PLAN_INTERVAL_DAYS = {
  monthly:     30,
  bimonthly:   60,
  quarterly:   90,
  '4month':    120,
  half_yearly: 180,
  halfyearly:  180,
  yearly:      365,
  one_time:    null,
};

/* ── Helpers ─────────────────────────────────────────────────────────── */
const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));
const round3  = (n) => Math.round(n * 1000) / 1000;

async function loadWeights() {
  try {
    const { rows } = await query(`SELECT * FROM eco_score_weights WHERE id = 1`);
    if (rows[0]) return rows[0];
  } catch (_) { /* fall through */ }
  return DEFAULT_WEIGHTS;
}

/* ── Signal: AMC plan ────────────────────────────────────────────────── */
async function signalAmcPlan(userId) {
  // Active contract (most recent)
  const { rows } = await query(
    `SELECT plan_type, tank_ids
       FROM amc_contracts
      WHERE customer_id = $1
        AND status = 'active'
      ORDER BY start_date DESC
      LIMIT 1`,
    [userId]
  );

  if (!rows.length) {
    // No active AMC — check for any paid one-time job in last 365 days
    const { rows: jobs } = await query(
      `SELECT 1 FROM jobs j
        WHERE j.customer_id = $1
          AND j.status = 'completed'
          AND j.completed_at >= NOW() - INTERVAL '365 days'
        LIMIT 1`,
      [userId]
    );
    return { value: jobs.length ? 0.30 : 0.0, plan: jobs.length ? 'one_time' : null };
  }

  const plan = rows[0].plan_type;
  let value = PLAN_SIGNAL[plan] ?? 0.30;

  // Multi-tank bonus: +0.05 if more than one tank covered, capped at 1.0
  let tankCount = 0;
  try {
    const tankIds = rows[0].tank_ids;
    if (Array.isArray(tankIds)) tankCount = tankIds.length;
    else if (tankIds && typeof tankIds === 'object') tankCount = Object.keys(tankIds).length;
  } catch (_) {}
  if (tankCount > 1) value = Math.min(1.0, value + 0.05);

  return { value, plan, tank_count: tankCount };
}

/* ── Signal: Compliance (avg phases_logged / 9 over last 5 jobs) ──────
 * 9-phase model per FA Check List PDF: Stage 0 + Steps 1-8. A skipped UV
 * step (uv_skipped = true) counts as completed for this aggregate.
 */
async function signalCompliance(userId) {
  const { rows } = await query(
    `WITH last_jobs AS (
       SELECT id FROM jobs
        WHERE customer_id = $1 AND status = 'completed'
        ORDER BY completed_at DESC NULLS LAST
        LIMIT 5
     )
     SELECT j.id,
            COALESCE(COUNT(c.id), 0) AS steps_logged
       FROM last_jobs j
       LEFT JOIN compliance_logs c
         ON c.job_id = j.id AND (c.completed = true OR c.uv_skipped = true)
      GROUP BY j.id`,
    [userId]
  );
  if (!rows.length) return { value: 0, jobs_considered: 0 };
  const avg = rows.reduce((s, r) => s + Math.min(9, Number(r.steps_logged) || 0), 0)
              / (rows.length * 9);
  return { value: clamp01(avg), jobs_considered: rows.length };
}

/* ── Signal: Timeliness (last 12 months) ─────────────────────────────── */
async function signalTimeliness(userId, activePlan) {
  const interval = PLAN_INTERVAL_DAYS[activePlan] || 30;          // fallback 30d
  const tolerance = 7;                                             // ±7 days = on-time

  const { rows } = await query(
    `SELECT id, completed_at, scheduled_at
       FROM jobs
      WHERE customer_id = $1
        AND status = 'completed'
        AND completed_at >= NOW() - INTERVAL '365 days'
      ORDER BY completed_at ASC`,
    [userId]
  );

  if (rows.length === 0) return { value: 0, total: 0, on_time: 0 };
  if (rows.length === 1) {
    // single job — give credit if completed within tolerance of scheduled
    const r = rows[0];
    if (!r.completed_at || !r.scheduled_at) return { value: 0.5, total: 1, on_time: 0 };
    const diffDays = Math.abs(
      (new Date(r.completed_at) - new Date(r.scheduled_at)) / 86_400_000
    );
    return diffDays <= tolerance
      ? { value: 1.0, total: 1, on_time: 1 }
      : { value: 0.5, total: 1, on_time: 0 };
  }

  // For >=2 jobs: count gaps that fall within (interval ± tolerance)
  let onTime = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const gap = (new Date(rows[i].completed_at) - new Date(rows[i - 1].completed_at))
                / 86_400_000;
    if (Math.abs(gap - interval) <= tolerance) onTime += 1;
  }
  const total = rows.length - 1;
  return { value: total > 0 ? clamp01(onTime / total) : 0, total, on_time: onTime };
}

/* ── Signal: Addons adoption ─────────────────────────────────────────── */
async function signalAddons(userId) {
  const { rows } = await query(
    `SELECT b.addons
       FROM bookings b
      WHERE b.customer_id = $1
      ORDER BY b.created_at DESC
      LIMIT 5`,
    [userId]
  );
  if (!rows.length) return { value: 0, jobs_considered: 0 };

  let withAddons = 0;
  for (const r of rows) {
    let addons = r.addons;
    if (typeof addons === 'string') {
      try { addons = JSON.parse(addons); } catch (_) { addons = []; }
    }
    if (Array.isArray(addons) && addons.length > 0) withAddons += 1;
  }
  return { value: clamp01(withAddons / rows.length), jobs_considered: rows.length };
}

/* ── Signal: Ratings GIVEN by this customer ──────────────────────────── */
async function signalRatings(userId) {
  const { rows } = await query(
    `SELECT rating
       FROM ratings
      WHERE customer_id = $1
      ORDER BY created_at DESC
      LIMIT 10`,
    [userId]
  );
  if (rows.length === 0) return { value: 0, count: 0 };

  const avg = rows.reduce((s, r) => s + Number(r.rating || 0), 0) / rows.length;
  // map 1..5 -> 0..1
  let value = clamp01((avg - 1) / 4);
  // Engagement bonus: customers who actually rate get a floor of 0.4 if
  // they've left at least 3 ratings, regardless of value (rewards engagement).
  if (rows.length >= 3) value = Math.max(value, 0.4);
  return { value, count: rows.length, avg: round3(avg) };
}

/* ── Signal: Water tests (pre + post readings in last 5 jobs) ─────────
 * PDF-aligned: a "water test" now means actual bucket readings recorded in
 * compliance_logs.{turbidity,ph_level,orp,conductivity,tds,atp} for both
 * step 1 (Pre-Check) and step 8 (After-Wash). Falls back to photo presence
 * + legacy microbial_test_url for old rows that predate migration 009.
 */
async function signalWaterTests(userId) {
  const { rows } = await query(
    `WITH last_jobs AS (
       SELECT id FROM jobs
        WHERE customer_id = $1 AND status = 'completed'
        ORDER BY completed_at DESC NULLS LAST
        LIMIT 5
     )
     SELECT lj.id,
            -- New schema: step 1 has any of the 6 water-test buckets recorded
            BOOL_OR(c.step_number = 1
                    AND (c.turbidity IS NOT NULL OR c.ph_level IS NOT NULL
                         OR c.orp IS NOT NULL OR c.conductivity IS NOT NULL
                         OR c.tds IS NOT NULL OR c.atp IS NOT NULL))     AS has_pre_buckets,
            BOOL_OR(c.step_number = 8
                    AND (c.turbidity IS NOT NULL OR c.ph_level IS NOT NULL
                         OR c.orp IS NOT NULL OR c.conductivity IS NOT NULL
                         OR c.tds IS NOT NULL OR c.atp IS NOT NULL))     AS has_post_buckets,
            -- Legacy: photo-only signal (old rows)
            BOOL_OR(c.step_number = 1 AND c.photo_before_url IS NOT NULL) AS has_pre_photo,
            BOOL_OR(c.step_number = 8 AND c.photo_after_url IS NOT NULL)  AS has_post_photo,
            -- Legacy: explicit microbial lab test
            BOOL_OR(c.microbial_test_url IS NOT NULL)                     AS has_lab
       FROM last_jobs lj
       LEFT JOIN compliance_logs c ON c.job_id = lj.id
      GROUP BY lj.id`,
    [userId]
  );

  if (!rows.length) return { value: 0, jobs_considered: 0 };

  let qualified = 0;
  for (const r of rows) {
    const newSchema = r.has_pre_buckets && r.has_post_buckets;
    const legacy    = (r.has_pre_photo && r.has_post_photo) || r.has_lab;
    if (newSchema || legacy) qualified += 1;
  }
  return { value: clamp01(qualified / rows.length), jobs_considered: rows.length };
}

/* ── Signal: Referrals (this customer was the source) ────────────────── */
async function signalReferrals(userId) {
  // The referrals table links source_id -> referral_sources, NOT directly to
  // a user. We approximate "referrals from this customer" as referrals where
  // the converted booking belongs to a different user but the source phone
  // matches this user's phone, OR (simpler & cheaper) we look up referral
  // sources whose phone == this user's phone, then count converted referrals.
  const { rows } = await query(
    `SELECT COUNT(*)::int AS cnt
       FROM referrals r
       JOIN referral_sources rs ON rs.id = r.source_id
       JOIN users u ON u.phone = rs.phone
      WHERE u.id = $1
        AND r.status = 'converted'`,
    [userId]
  );
  const cnt = rows[0]?.cnt || 0;
  return { value: clamp01(cnt / 3), count: cnt };
}

/* ── Rationale builder (top 2-3 contributors) ────────────────────────── */
function buildRationale({ components, weights, plan }) {
  const contribs = [
    { key: 'amc_plan',    label: plan ? `${planLabel(plan)} plan` : 'one-time service',  weighted: components.c_amc_plan * weights.w_amc_plan },
    { key: 'compliance',  label: 'high compliance',     weighted: components.c_compliance * weights.w_compliance },
    { key: 'timeliness',  label: 'on-time streak',      weighted: components.c_timeliness * weights.w_timeliness },
    { key: 'addons',      label: 'add-on upgrades',     weighted: components.c_addons * weights.w_addons },
    { key: 'ratings',     label: 'service ratings',     weighted: components.c_ratings * weights.w_ratings },
    { key: 'water_tests', label: 'lab-test discipline', weighted: components.c_water_tests * weights.w_water_tests },
    { key: 'referrals',   label: 'referrals',           weighted: components.c_referrals * weights.w_referrals },
  ];
  const top = contribs
    .filter((c) => c.weighted > 0.02)
    .sort((a, b) => b.weighted - a.weighted)
    .slice(0, 3)
    .map((c) => c.label);
  if (top.length === 0) return 'No service history yet';
  if (top.length === 1) return `Driven by ${top[0]}`;
  return top.join(' + ');
}

function planLabel(plan) {
  const map = {
    monthly: 'Monthly',
    bimonthly: 'Bimonthly',
    quarterly: 'Quarterly',
    '4month': '4-month',
    halfyearly: 'Half-yearly',
    half_yearly: 'Half-yearly',
    yearly: 'Yearly',
    one_time: 'One-time',
  };
  return map[plan] || plan;
}

function pickBadge(score, w) {
  if (score >= w.t_platinum) return 'platinum';
  if (score >= w.t_gold)     return 'gold';
  if (score >= w.t_silver)   return 'silver';
  if (score >= w.t_bronze)   return 'bronze';
  return 'unrated';
}

/* ── Streak update ───────────────────────────────────────────────────── */
function updateStreak(prev, newBadge) {
  const goldOrBetter = (b) => b === 'gold' || b === 'platinum';
  if (!prev) return goldOrBetter(newBadge) ? 1 : 0;
  if (goldOrBetter(prev.badge) && goldOrBetter(newBadge)) {
    const elapsedDays = Math.max(
      1,
      Math.floor((Date.now() - new Date(prev.last_recalc_at).getTime()) / 86_400_000)
    );
    return (prev.streak_days || 0) + elapsedDays;
  }
  return goldOrBetter(newBadge) ? 1 : 0;
}

/* ── Main entry ──────────────────────────────────────────────────────── */
async function computeEcoScore({ user_id }) {
  if (!user_id) throw new Error('computeEcoScore: user_id is required');

  const weights = await loadWeights();

  const amc = await signalAmcPlan(user_id);
  const [compliance, timeliness, addons, ratings, waterTests, referrals] =
    await Promise.all([
      signalCompliance(user_id),
      signalTimeliness(user_id, amc.plan),
      signalAddons(user_id),
      signalRatings(user_id),
      signalWaterTests(user_id),
      signalReferrals(user_id),
    ]);

  const components = {
    c_amc_plan:    round3(amc.value),
    c_compliance:  round3(compliance.value),
    c_timeliness:  round3(timeliness.value),
    c_addons:      round3(addons.value),
    c_ratings:     round3(ratings.value),
    c_water_tests: round3(waterTests.value),
    c_referrals:   round3(referrals.value),
  };

  const weighted =
      components.c_amc_plan    * Number(weights.w_amc_plan)
    + components.c_compliance  * Number(weights.w_compliance)
    + components.c_timeliness  * Number(weights.w_timeliness)
    + components.c_addons      * Number(weights.w_addons)
    + components.c_ratings     * Number(weights.w_ratings)
    + components.c_water_tests * Number(weights.w_water_tests)
    + components.c_referrals   * Number(weights.w_referrals);

  const score = Math.max(0, Math.min(100, Math.round(weighted * 100)));
  const badge = pickBadge(score, weights);
  const rationale = buildRationale({ components, weights, plan: amc.plan });

  return {
    score,
    badge,
    rationale,
    components,
    diagnostics: {
      amc, compliance, timeliness, addons, ratings,
      water_tests: waterTests, referrals,
      weights_used: weights,
    },
  };
}

module.exports = {
  computeEcoScore,
  pickBadge,
  updateStreak,
  PLAN_SIGNAL,
  PLAN_INTERVAL_DAYS,
};
