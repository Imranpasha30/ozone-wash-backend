/**
 * MIS (Management Information System) service.
 *
 * Aggregates data across bookings, jobs, compliance_logs, eco_metrics_log,
 * incident_reports, amc_contracts, users, referrals, payments, wallets,
 * wallet_transactions, rewards, reward_redemptions, incentives, sales_team,
 * sales_targets, marketing_spend and ratings tables into 6 dashboard payloads.
 *
 * Defensive guarantees:
 *   - Every query is wrapped in tryQuery() so a missing column or table
 *     returns `null` (signalling schema gap) rather than 500.
 *   - Numeric helpers return safe defaults (0, []) rather than NaN/null.
 *
 * NOTE on schema mappings:
 *   - The spec mentions `compliance_steps`; the actual table is `compliance_logs`.
 *   - The spec mentions `eco_scores`;     the actual table is `eco_metrics_log`.
 *   - Migration 005 added: payments, wallets, wallet_transactions, rewards,
 *     reward_redemptions, incentives, sales_team, sales_targets,
 *     marketing_spend, ratings.
 */

const db = require('../../config/db');

// ── Helpers ───────────────────────────────────────────────────────────────────

const BENCHMARK_MINUTES_PER_JOB = 90;
const POINTS_TO_RUPEES = 1; // 1 eco-point = ₹1 (per spec)

function defaultRange(from, to) {
  const today = new Date();
  const toDate = to ? new Date(to) : today;
  const fromDate = from
    ? new Date(from)
    : new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  return {
    fromIso: fromDate.toISOString(),
    toIso:   toDate.toISOString(),
  };
}

const num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const pct = (numer, denom) => {
  const n = num(numer);
  const d = num(denom);
  if (d <= 0) return 0;
  return Math.round((n / d) * 1000) / 10; // 1 decimal place
};

// Run a query, swallow "relation does not exist" / "column does not exist"
// errors so a missing table doesn't crash the whole dashboard.
async function tryQuery(label, sql, params = []) {
  try {
    const r = await db.query(sql, params);
    return r.rows;
  } catch (e) {
    if (
      e.code === '42P01' || // undefined_table
      e.code === '42703'    // undefined_column
    ) {
      console.warn(`[MIS:${label}] schema gap — ${e.message}`);
      return null; // signal "schema gap" vs. just "no rows"
    }
    console.error(`[MIS:${label}] query error:`, e.message);
    return null;
  }
}

// ── 1. OPERATIONAL ────────────────────────────────────────────────────────────

async function getOperational({ from, to } = {}) {
  const { fromIso, toIso } = defaultRange(from, to);

  // Job buckets
  const jobsRows = await tryQuery('jobs.counts', `
    SELECT
      COUNT(*)                                             AS total,
      COUNT(*) FILTER (WHERE status = 'completed')         AS completed,
      COUNT(*) FILTER (WHERE status IN ('scheduled','in_progress')) AS pending,
      COUNT(*) FILTER (WHERE status NOT IN ('completed','cancelled')
                         AND scheduled_at < NOW() - INTERVAL '3 hours') AS overdue
    FROM jobs
    WHERE scheduled_at BETWEEN $1 AND $2
  `, [fromIso, toIso]);

  const jobs = jobsRows?.[0] || {};
  const total     = num(jobs.total);
  const completed = num(jobs.completed);
  const pending   = num(jobs.pending);
  const overdue   = num(jobs.overdue);

  // SLA: a "breach" = completed_at > scheduled_at + 3h, OR still open beyond 3h.
  const breachRows = await tryQuery('jobs.sla_breaches', `
    SELECT j.id AS job_id,
           u.name AS customer,
           ROUND(EXTRACT(EPOCH FROM (
             COALESCE(j.completed_at, NOW()) - (j.scheduled_at + INTERVAL '3 hours')
           )) / 3600.0, 1) AS hours_late
    FROM jobs j
    JOIN users u ON u.id = j.customer_id
    WHERE j.scheduled_at BETWEEN $1 AND $2
      AND (
        (j.status = 'completed' AND j.completed_at > j.scheduled_at + INTERVAL '3 hours')
        OR (j.status NOT IN ('completed','cancelled') AND NOW() > j.scheduled_at + INTERVAL '3 hours')
      )
    ORDER BY hours_late DESC NULLS LAST
    LIMIT 50
  `, [fromIso, toIso]) || [];

  const breachCount = breachRows.length;
  const compliancePct = total > 0 ? Math.max(0, 100 - pct(breachCount, total)) : 100;

  // Avg duration of completed jobs
  const durationRows = await tryQuery('jobs.avg_duration', `
    SELECT AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) / 60.0) AS avg_min
    FROM jobs
    WHERE status = 'completed'
      AND started_at IS NOT NULL
      AND completed_at IS NOT NULL
      AND scheduled_at BETWEEN $1 AND $2
  `, [fromIso, toIso]);
  const avgMinutesPerJob = Math.round(num(durationRows?.[0]?.avg_min));

  // First-time fix = completed jobs with no incident reports raised against them
  const ftfRows = await tryQuery('jobs.first_time_fix', `
    SELECT
      COUNT(*) FILTER (WHERE status = 'completed') AS completed_jobs,
      COUNT(*) FILTER (
        WHERE status = 'completed'
          AND id NOT IN (SELECT job_id FROM incident_reports)
      ) AS clean_jobs
    FROM jobs
    WHERE scheduled_at BETWEEN $1 AND $2
  `, [fromIso, toIso]);
  const firstTimeFixRate = pct(ftfRows?.[0]?.clean_jobs, ftfRows?.[0]?.completed_jobs);

  // Checklist compliance: jobs with all 8 compliance steps completed
  const checklistRows = await tryQuery('compliance.completion', `
    WITH per_job AS (
      SELECT j.id AS job_id,
             COUNT(cl.id) FILTER (WHERE cl.completed = true) AS done_steps
      FROM jobs j
      LEFT JOIN compliance_logs cl ON cl.job_id = j.id
      WHERE j.scheduled_at BETWEEN $1 AND $2
        AND j.status = 'completed'
      GROUP BY j.id
    )
    SELECT
      COUNT(*)                                AS total_completed,
      COUNT(*) FILTER (WHERE done_steps >= 8) AS fully_compliant
    FROM per_job
  `, [fromIso, toIso]);
  const checklistCompliancePct = pct(
    checklistRows?.[0]?.fully_compliant,
    checklistRows?.[0]?.total_completed
  );

  // Digital compliance: % of completed jobs that have at least one photo upload
  // (per spec: jobs with at least one photo upload / total completed jobs).
  const digitalRows = await tryQuery('compliance.digital', `
    SELECT
      COUNT(DISTINCT j.id) AS total_completed,
      COUNT(DISTINCT j.id) FILTER (
        WHERE cl.photo_before_url IS NOT NULL
           OR cl.photo_after_url  IS NOT NULL
      ) AS with_photo
    FROM jobs j
    LEFT JOIN compliance_logs cl ON cl.job_id = j.id
    WHERE j.scheduled_at BETWEEN $1 AND $2
      AND j.status = 'completed'
  `, [fromIso, toIso]);
  const digitalCompliancePct = pct(
    digitalRows?.[0]?.with_photo,
    digitalRows?.[0]?.total_completed
  );

  // Gaps
  const missingChecklistRows = await tryQuery('gaps.missing_checklist', `
    SELECT j.id
    FROM jobs j
    LEFT JOIN compliance_logs cl ON cl.job_id = j.id AND cl.completed = true
    WHERE j.status = 'completed'
      AND j.scheduled_at BETWEEN $1 AND $2
    GROUP BY j.id
    HAVING COUNT(cl.id) < 8
    LIMIT 50
  `, [fromIso, toIso]) || [];

  const incompleteLogsRows = await tryQuery('gaps.incomplete_logs', `
    SELECT DISTINCT cl.job_id
    FROM compliance_logs cl
    JOIN jobs j ON j.id = cl.job_id
    WHERE cl.completed = false
      AND j.scheduled_at BETWEEN $1 AND $2
    LIMIT 50
  `, [fromIso, toIso]) || [];

  // "Delayed uploads" — completed jobs whose photos were logged > 1h after completion.
  const delayedUploadsRows = await tryQuery('gaps.delayed_uploads', `
    SELECT DISTINCT j.id
    FROM jobs j
    JOIN compliance_logs cl ON cl.job_id = j.id
    WHERE j.status = 'completed'
      AND j.completed_at IS NOT NULL
      AND cl.logged_at > j.completed_at + INTERVAL '1 hour'
      AND j.scheduled_at BETWEEN $1 AND $2
    LIMIT 50
  `, [fromIso, toIso]) || [];

  return {
    jobs: { completed, pending, overdue, total },
    sla: {
      compliancePct,
      breachCount,
      breaches: breachRows.slice(0, 20),
    },
    avgMinutesPerJob,
    benchmarkMinutes: BENCHMARK_MINUTES_PER_JOB,
    firstTimeFixRate,
    checklistCompliancePct,
    digitalCompliancePct,
    gaps: {
      missingChecklistJobs: missingChecklistRows.map(r => r.id),
      incompleteLogs:       incompleteLogsRows.map(r => r.job_id),
      delayedUploads:       delayedUploadsRows.map(r => r.id),
    },
  };
}

// ── 2. ECOSCORE ───────────────────────────────────────────────────────────────

async function getEcoScore({ from, to } = {}) {
  const { fromIso, toIso } = defaultRange(from, to);

  // Avg score by property segment (domestic / society / industrial)
  const segmentRows = await tryQuery('eco.by_segment', `
    SELECT
      LOWER(COALESCE(b.property_type, 'unknown')) AS segment,
      AVG(em.eco_score)                            AS avg_score
    FROM eco_metrics_log em
    JOIN jobs j     ON j.id = em.job_id
    LEFT JOIN bookings b ON b.id = j.booking_id
    WHERE em.created_at BETWEEN $1 AND $2
    GROUP BY segment
  `, [fromIso, toIso]) || [];

  const avgScoreBySegment = { domestic: 0, society: 0, industrial: 0 };
  for (const r of segmentRows) {
    const seg = String(r.segment || '').toLowerCase();
    if (seg.includes('soci')) avgScoreBySegment.society = Math.round(num(r.avg_score));
    else if (seg.includes('indust') || seg.includes('comm')) avgScoreBySegment.industrial = Math.round(num(r.avg_score));
    else avgScoreBySegment.domestic = Math.round(num(r.avg_score));
  }

  // Badge distribution
  const badgeRows = await tryQuery('eco.badges', `
    SELECT
      COUNT(*) FILTER (WHERE badge_level = 'platinum') AS platinum,
      COUNT(*) FILTER (WHERE badge_level = 'gold')     AS gold,
      COUNT(*) FILTER (WHERE badge_level = 'silver')   AS silver,
      COUNT(*) FILTER (WHERE badge_level = 'bronze')   AS bronze,
      COUNT(*) FILTER (WHERE badge_level IS NULL)      AS unrated
    FROM eco_metrics_log
    WHERE created_at BETWEEN $1 AND $2
  `, [fromIso, toIso]);
  const badgeDistribution = {
    platinum: num(badgeRows?.[0]?.platinum),
    gold:     num(badgeRows?.[0]?.gold),
    silver:   num(badgeRows?.[0]?.silver),
    bronze:   num(badgeRows?.[0]?.bronze),
    unrated:  num(badgeRows?.[0]?.unrated),
  };

  // 6-month trend
  const trendRows = await tryQuery('eco.trend', `
    SELECT TO_CHAR(date_trunc('month', created_at), 'YYYY-MM') AS month,
           ROUND(AVG(eco_score)::numeric, 1)                   AS avg
    FROM eco_metrics_log
    WHERE created_at >= NOW() - INTERVAL '6 months'
    GROUP BY 1
    ORDER BY 1
  `) || [];
  const trend = trendRows.map(r => ({ month: r.month, avg: num(r.avg) }));

  // Feedback impact — read from real ratings table.
  const feedbackRows = await tryQuery('eco.feedback', `
    SELECT
      COUNT(*)            AS rated,
      AVG(rating)::numeric AS avg_rating
    FROM ratings
    WHERE created_at BETWEEN $1 AND $2
  `, [fromIso, toIso]);
  const ratingsCount = num(feedbackRows?.[0]?.rated);
  const avgRating = ratingsCount > 0
    ? Math.round(num(feedbackRows?.[0]?.avg_rating) * 10) / 10
    : 0;

  // Streaks: consecutive platinum scores per customer / per agent
  const custStreakRows = await tryQuery('eco.cust_streak', `
    WITH ordered AS (
      SELECT j.customer_id,
             em.created_at,
             em.badge_level,
             ROW_NUMBER() OVER (PARTITION BY j.customer_id ORDER BY em.created_at DESC) AS rn
      FROM eco_metrics_log em
      JOIN jobs j ON j.id = em.job_id
    ),
    runs AS (
      SELECT customer_id, COUNT(*) AS streak
      FROM ordered
      WHERE rn <= 20
        AND badge_level = 'platinum'
      GROUP BY customer_id
    )
    SELECT COALESCE(MAX(streak), 0) AS top FROM runs
  `);
  const agentStreakRows = await tryQuery('eco.agent_streak', `
    WITH ordered AS (
      SELECT j.assigned_team_id,
             em.created_at,
             em.badge_level,
             ROW_NUMBER() OVER (PARTITION BY j.assigned_team_id ORDER BY em.created_at DESC) AS rn
      FROM eco_metrics_log em
      JOIN jobs j ON j.id = em.job_id
      WHERE j.assigned_team_id IS NOT NULL
    ),
    runs AS (
      SELECT assigned_team_id, COUNT(*) AS streak
      FROM ordered
      WHERE rn <= 20
        AND badge_level IN ('platinum','gold')
      GROUP BY assigned_team_id
    )
    SELECT COALESCE(MAX(streak), 0) AS top FROM runs
  `);

  // Gaps
  const lowScoreRows = await tryQuery('eco.low_jobs', `
    SELECT job_id
    FROM eco_metrics_log
    WHERE eco_score < 50
      AND created_at BETWEEN $1 AND $2
    ORDER BY eco_score ASC
    LIMIT 50
  `, [fromIso, toIso]) || [];

  const repeatBronzeRows = await tryQuery('eco.repeat_bronze', `
    SELECT j.customer_id, COUNT(*) AS bronze_count
    FROM eco_metrics_log em
    JOIN jobs j ON j.id = em.job_id
    WHERE em.badge_level = 'bronze'
      AND em.created_at BETWEEN $1 AND $2
    GROUP BY j.customer_id
    HAVING COUNT(*) >= 2
    LIMIT 50
  `, [fromIso, toIso]) || [];

  // Missing reviews = completed jobs in window that have NO row in `ratings`.
  const missingReviewsRows = await tryQuery('eco.missing_reviews', `
    SELECT j.id
    FROM jobs j
    LEFT JOIN ratings r ON r.job_id = j.id
    WHERE j.status = 'completed'
      AND j.scheduled_at BETWEEN $1 AND $2
      AND r.id IS NULL
    LIMIT 50
  `, [fromIso, toIso]) || [];

  return {
    avgScoreBySegment,
    badgeDistribution,
    trend,
    feedbackImpact: { avgRating, ratingsCount },
    streaks: {
      topPlatinumStreak: num(custStreakRows?.[0]?.top),
      topAgentStreak:    num(agentStreakRows?.[0]?.top),
    },
    gaps: {
      lowScoreJobs:           lowScoreRows.map(r => r.job_id),
      repeatBronzeCustomers:  repeatBronzeRows.map(r => r.customer_id),
      missingReviews:         missingReviewsRows.map(r => r.id),
    },
  };
}

// ── 3. REVENUE ────────────────────────────────────────────────────────────────

function tierForTurnover(turnoverInr) {
  if (turnoverInr >= 200000) return 'platinum';
  if (turnoverInr >= 100000) return 'gold';
  if (turnoverInr >= 40000)  return 'silver';
  return 'bronze';
}

async function getRevenue({ from, to } = {}) {
  const { fromIso, toIso } = defaultRange(from, to);

  // Per-agent revenue from `payments` joined via bookings → jobs → assigned agent.
  // Only count captured / cod_collected payments.
  // turnover_ex_gst = (amount_paise - gst_paise) → rupees.
  const byAgentRows = await tryQuery('rev.by_agent', `
    SELECT
      u.id   AS agent_id,
      u.name AS name,
      COALESCE(SUM(p.amount_paise - COALESCE(p.gst_paise, 0))
        FILTER (WHERE p.status IN ('captured','cod_collected'))
      , 0) AS ex_gst_paise,
      COUNT(DISTINCT j.id) AS transactions,
      COUNT(DISTINCT j.id) FILTER (WHERE jsonb_array_length(COALESCE(b.addons, '[]'::jsonb)) > 0) AS jobs_with_addons,
      COALESCE(SUM(i.amount_paise) FILTER (WHERE i.status IN ('accrued','paid')), 0) AS incentive_paise,
      (
        SELECT i2.tier
        FROM incentives i2
        WHERE i2.agent_id = u.id
          AND i2.tier IS NOT NULL
        ORDER BY i2.created_at DESC
        LIMIT 1
      ) AS latest_tier
    FROM users u
    LEFT JOIN jobs j      ON j.assigned_team_id = u.id
                         AND j.status = 'completed'
                         AND j.completed_at BETWEEN $1 AND $2
    LEFT JOIN bookings b  ON b.id = j.booking_id
    LEFT JOIN payments p  ON p.booking_id = b.id
    LEFT JOIN incentives i ON i.agent_id = u.id
                           AND i.created_at BETWEEN $1 AND $2
    WHERE u.role = 'field_team'
    GROUP BY u.id, u.name
    ORDER BY ex_gst_paise DESC
  `, [fromIso, toIso]) || [];

  const byAgent = byAgentRows.map(r => {
    const exGst    = Math.round(num(r.ex_gst_paise) / 100);
    const txns     = num(r.transactions);
    const addons   = num(r.jobs_with_addons);
    const incentiveCredits = Math.round(num(r.incentive_paise) / 100);
    const tier = r.latest_tier || tierForTurnover(exGst);
    return {
      agent_id: r.agent_id,
      name: r.name,
      turnover_ex_gst: exGst,
      transactions: txns,
      addon_conversion_pct: pct(addons, txns),
      incentive_credits: incentiveCredits,
      tier,
    };
  });

  const tierDistribution = { platinum: 0, gold: 0, silver: 0, bronze: 0 };
  for (const a of byAgent) {
    if (tierDistribution[a.tier] !== undefined) tierDistribution[a.tier] += 1;
  }

  // Total incentives paid in window
  const incentivePayoutRows = await tryQuery('rev.incentive_payout', `
    SELECT COALESCE(SUM(amount_paise), 0) AS paise
    FROM incentives
    WHERE status = 'paid'
      AND COALESCE(paid_at, created_at) BETWEEN $1 AND $2
  `, [fromIso, toIso]);
  const incentivePayoutTotal = Math.round(num(incentivePayoutRows?.[0]?.paise) / 100);

  // Revenue uplift = total captured payments in window (rupees, gross)
  const upliftRows = await tryQuery('rev.uplift', `
    SELECT COALESCE(SUM(amount_paise), 0) AS paise
    FROM payments
    WHERE status IN ('captured','cod_collected')
      AND COALESCE(captured_at, created_at) BETWEEN $1 AND $2
  `, [fromIso, toIso]);
  const revenueUplift = Math.round(num(upliftRows?.[0]?.paise) / 100);

  // Gaps
  const lowTurnoverAgents = byAgent.filter(a => a.transactions > 0 && a.turnover_ex_gst < 20000)
    .map(a => ({ agent_id: a.agent_id, name: a.name, turnover_ex_gst: a.turnover_ex_gst }));
  const poorUpsellAgents = byAgent.filter(a => a.transactions >= 5 && a.addon_conversion_pct < 15)
    .map(a => ({ agent_id: a.agent_id, name: a.name, addon_conversion_pct: a.addon_conversion_pct }));
  const stuckBronze = byAgent.filter(a => a.tier === 'bronze' && a.transactions >= 5)
    .map(a => ({ agent_id: a.agent_id, name: a.name }));

  return {
    byAgent,
    tierDistribution,
    incentivePayoutTotal,
    revenueUplift,
    gaps: { lowTurnoverAgents, poorUpsellAgents, stuckBronze },
  };
}

// ── 4. CUSTOMER ENGAGEMENT ────────────────────────────────────────────────────

async function getCustomerEngagement({ from, to } = {}) {
  const { fromIso, toIso } = defaultRange(from, to);

  // Wallet aggregates
  const walletRows = await tryQuery('cust.wallet', `
    SELECT
      COALESCE(AVG(eco_points) FILTER (WHERE eco_points > 0), 0) AS avg_balance,
      COALESCE(SUM(eco_points), 0)                                AS total_outstanding
    FROM wallets
  `);
  const wallet = {
    avgBalance:       Math.round(num(walletRows?.[0]?.avg_balance)),
    totalOutstanding: num(walletRows?.[0]?.total_outstanding),
  };

  // Redemption flow: credits / debits in window.
  const flowRows = await tryQuery('cust.flow', `
    SELECT
      COALESCE(SUM(GREATEST(delta, 0)), 0)      AS accrued,
      COALESCE(SUM(LEAST(delta, 0)) * -1, 0)    AS redeemed
    FROM wallet_transactions
    WHERE created_at BETWEEN $1 AND $2
  `, [fromIso, toIso]);
  const pointsAccrued  = num(flowRows?.[0]?.accrued);
  const pointsRedeemed = num(flowRows?.[0]?.redeemed);
  const redemption = {
    pointsAccrued,
    pointsRedeemed,
    redemptionPct: pct(pointsRedeemed, pointsAccrued),
  };

  // Top 5 rewards by fulfilled redemption count
  const topRewardRows = await tryQuery('cust.top_rewards', `
    SELECT r.id, r.name, r.cost_points, COUNT(rr.id) AS redemptions
    FROM rewards r
    LEFT JOIN reward_redemptions rr ON rr.reward_id = r.id
                                    AND rr.status = 'fulfilled'
                                    AND rr.created_at BETWEEN $1 AND $2
    GROUP BY r.id, r.name, r.cost_points
    ORDER BY redemptions DESC, r.cost_points ASC
    LIMIT 5
  `, [fromIso, toIso]) || [];
  const topRewards = topRewardRows.map(r => ({
    id: r.id,
    name: r.name,
    cost_points: num(r.cost_points),
    redemptions: num(r.redemptions),
  }));

  // Referrals aggregates
  const referralRows = await tryQuery('cust.referrals', `
    SELECT
      COALESCE(SUM(points_awarded), 0)                              AS points,
      COUNT(DISTINCT customer_id) FILTER (WHERE status = 'converted') AS new_customers
    FROM referrals
    WHERE created_at BETWEEN $1 AND $2
  `, [fromIso, toIso]);
  const referrals = {
    pointsEarned:          num(referralRows?.[0]?.points),
    newCustomersAcquired:  num(referralRows?.[0]?.new_customers),
  };

  // AMC renewal rate: contracts ending in window vs the % that have a follow-on.
  const renewalRows = await tryQuery('cust.amc_renewals', `
    WITH ended AS (
      SELECT id, customer_id, end_date
      FROM amc_contracts
      WHERE end_date BETWEEN $1::date AND $2::date
    ),
    renewed AS (
      SELECT e.id
      FROM ended e
      WHERE EXISTS (
        SELECT 1 FROM amc_contracts a2
        WHERE a2.customer_id = e.customer_id
          AND a2.start_date BETWEEN e.end_date - INTERVAL '7 days' AND e.end_date + INTERVAL '30 days'
          AND a2.id <> e.id
      )
    )
    SELECT
      (SELECT COUNT(*) FROM ended)   AS expired,
      (SELECT COUNT(*) FROM renewed) AS renewed
  `, [fromIso, toIso]);
  const expired = num(renewalRows?.[0]?.expired);
  const renewed = num(renewalRows?.[0]?.renewed);
  const amcRenewalRate = pct(renewed, expired);

  // Gaps: high-balance customers who haven't redeemed in last 90 days.
  const highBalanceRows = await tryQuery('cust.high_balance', `
    SELECT w.user_id, u.name, w.eco_points
    FROM wallets w
    LEFT JOIN users u ON u.id = w.user_id
    WHERE w.eco_points >= 200
      AND NOT EXISTS (
        SELECT 1 FROM reward_redemptions rr
        WHERE rr.user_id = w.user_id
          AND rr.created_at >= NOW() - INTERVAL '90 days'
      )
    ORDER BY w.eco_points DESC
    LIMIT 50
  `) || [];

  const lowAmcRows = await tryQuery('cust.low_amc', `
    SELECT a.id, u.name AS customer, a.end_date
    FROM amc_contracts a
    JOIN users u ON u.id = a.customer_id
    WHERE a.status = 'expired'
      AND a.end_date BETWEEN $1::date AND $2::date
      AND NOT EXISTS (
        SELECT 1 FROM amc_contracts a2
        WHERE a2.customer_id = a.customer_id
          AND a2.start_date > a.end_date
      )
    LIMIT 50
  `, [fromIso, toIso]) || [];

  return {
    wallet,
    redemption,
    topRewards,
    referrals,
    amcRenewalRate,
    gaps: {
      highBalanceLowRedemption: highBalanceRows.map(r => ({
        user_id: r.user_id,
        name: r.name,
        eco_points: num(r.eco_points),
      })),
      lowAmcRenewals: lowAmcRows.map(r => ({ id: r.id, customer: r.customer, end_date: r.end_date })),
    },
  };
}

// ── 5. SALES ──────────────────────────────────────────────────────────────────

async function getSales({ from, to } = {}) {
  const { fromIso, toIso } = defaultRange(from, to);

  // Funnel: pull from marketing_spend (leads / customers acquired).
  const funnelRows = await tryQuery('sales.funnel', `
    SELECT
      COALESCE(SUM(leads_generated), 0)    AS leads,
      COALESCE(SUM(customers_acquired), 0) AS converted
    FROM marketing_spend
    WHERE month BETWEEN date_trunc('month', $1::timestamptz)::date
                    AND date_trunc('month', $2::timestamptz)::date
  `, [fromIso, toIso]);
  const leads     = num(funnelRows?.[0]?.leads);
  const converted = num(funnelRows?.[0]?.converted);
  const funnel = {
    leads,
    converted,
    lost: Math.max(0, leads - converted),
  };

  // Revenue segments (rupees).
  // amcRenewals  = payments tagged to an AMC contract AND notes->>'is_renewal'='true'
  // newContracts = payments tagged to an AMC contract AND NOT renewal
  // addons       = payments whose notes JSON has an 'addons' key
  // partner      = marketing_spend(channel='partner').spend (in rupees, as a rough channel-cost proxy)
  const segRows = await tryQuery('sales.segments', `
    SELECT
      COALESCE(SUM(amount_paise) FILTER (
        WHERE amc_contract_id IS NOT NULL
          AND notes IS NOT NULL
          AND notes->>'is_renewal' = 'true'
      ), 0) AS amc_renewals,
      COALESCE(SUM(amount_paise) FILTER (
        WHERE amc_contract_id IS NOT NULL
          AND (notes IS NULL OR notes->>'is_renewal' IS DISTINCT FROM 'true')
      ), 0) AS new_contracts,
      COALESCE(SUM(amount_paise) FILTER (
        WHERE notes IS NOT NULL AND notes ? 'addons'
      ), 0) AS addons
    FROM payments
    WHERE status IN ('captured','cod_collected')
      AND COALESCE(captured_at, created_at) BETWEEN $1 AND $2
  `, [fromIso, toIso]);
  const partnerRows = await tryQuery('sales.partner_spend', `
    SELECT COALESCE(SUM(spend_paise), 0) AS paise
    FROM marketing_spend
    WHERE channel = 'partner'
      AND month BETWEEN date_trunc('month', $1::timestamptz)::date
                    AND date_trunc('month', $2::timestamptz)::date
  `, [fromIso, toIso]);
  const seg = segRows?.[0] || {};
  const revenueSegments = {
    amcRenewals:  Math.round(num(seg.amc_renewals)  / 100),
    newContracts: Math.round(num(seg.new_contracts) / 100),
    addons:       Math.round(num(seg.addons)        / 100),
    partner:      Math.round(num(partnerRows?.[0]?.paise) / 100),
  };

  // CAC: total marketing spend / customers_acquired in window.
  const cacRows = await tryQuery('sales.cac', `
    SELECT
      COALESCE(SUM(spend_paise), 0)        AS spend,
      COALESCE(SUM(customers_acquired), 0) AS customers
    FROM marketing_spend
    WHERE month BETWEEN date_trunc('month', $1::timestamptz)::date
                    AND date_trunc('month', $2::timestamptz)::date
  `, [fromIso, toIso]);
  const totalSpendRupees = Math.round(num(cacRows?.[0]?.spend) / 100);
  const customersAcq     = num(cacRows?.[0]?.customers);
  const cac = customersAcq > 0 ? Math.round(totalSpendRupees / customersAcq) : 0;

  // LTV: avg lifetime captured payment per paying user.
  const ltvRows = await tryQuery('sales.ltv', `
    SELECT COALESCE(AVG(per_user.total), 0) AS avg_total
    FROM (
      SELECT user_id, SUM(amount_paise) AS total
      FROM payments
      WHERE status IN ('captured','cod_collected')
        AND user_id IS NOT NULL
      GROUP BY user_id
    ) per_user
  `);
  const ltv = Math.round(num(ltvRows?.[0]?.avg_total) / 100);
  const cacVsLtv = {
    cac,
    ltv,
    ratio: cac > 0 ? Math.round((ltv / cac) * 100) / 100 : 0,
  };

  // Segment profitability — avg captured payment by booking property_type.
  const profitRows = await tryQuery('sales.profitability', `
    SELECT LOWER(COALESCE(b.property_type, 'unknown')) AS segment,
           COALESCE(AVG(p.amount_paise), 0)            AS avg_paise
    FROM payments p
    JOIN bookings b ON b.id = p.booking_id
    WHERE p.status IN ('captured','cod_collected')
      AND COALESCE(p.captured_at, p.created_at) BETWEEN $1 AND $2
    GROUP BY segment
  `, [fromIso, toIso]) || [];
  const segmentProfitability = { domestic: 0, society: 0, industrial: 0 };
  for (const r of profitRows) {
    const v = Math.round(num(r.avg_paise) / 100);
    const s = String(r.segment || '');
    if (s.includes('soci')) segmentProfitability.society = v;
    else if (s.includes('indust') || s.includes('comm')) segmentProfitability.industrial = v;
    else segmentProfitability.domestic = v;
  }

  // Growth trend — last 6 months of captured payments (rupees).
  const growthRows = await tryQuery('sales.growth', `
    SELECT TO_CHAR(date_trunc('month', COALESCE(captured_at, created_at)), 'YYYY-MM') AS month,
           COALESCE(SUM(amount_paise), 0)                                              AS paise
    FROM payments
    WHERE COALESCE(captured_at, created_at) >= NOW() - INTERVAL '6 months'
      AND status IN ('captured','cod_collected')
    GROUP BY 1
    ORDER BY 1
  `) || [];
  const growthTrend = growthRows.map(r => ({
    month: r.month,
    revenue: Math.round(num(r.paise) / 100),
  }));

  // Cross-sell rate: % of jobs whose booking has addons.
  const crossSellRows = await tryQuery('sales.cross_sell', `
    SELECT
      COUNT(DISTINCT j.id) AS jobs,
      COUNT(DISTINCT j.id) FILTER (
        WHERE jsonb_array_length(COALESCE(b.addons, '[]'::jsonb)) > 0
      ) AS with_addons
    FROM jobs j
    LEFT JOIN bookings b ON b.id = j.booking_id
    WHERE j.scheduled_at BETWEEN $1 AND $2
  `, [fromIso, toIso]);
  const crossSell = { rate: pct(crossSellRows?.[0]?.with_addons, crossSellRows?.[0]?.jobs) };

  // Sales team — JOIN sales_team + sales_targets for current month.
  const salesTeamRows = await tryQuery('sales.team', `
    SELECT st.id,
           st.name,
           st.region,
           st.active,
           t.target_revenue_paise,
           t.achieved_revenue_paise
    FROM sales_team st
    LEFT JOIN sales_targets t
           ON t.sales_team_id = st.id
          AND t.month = date_trunc('month', CURRENT_DATE)::date
    WHERE st.active = true
    ORDER BY st.name
  `) || [];
  const salesTeam = salesTeamRows.map(r => {
    const target   = Math.round(num(r.target_revenue_paise)   / 100);
    const achieved = Math.round(num(r.achieved_revenue_paise) / 100);
    return {
      id: r.id,
      name: r.name,
      region: r.region,
      target_revenue: target,
      achieved_revenue: achieved,
      attainment_pct: pct(achieved, target),
    };
  });

  // Gaps
  const decliningRenewals = []; // would require historical comparison window
  const highCacSegments   = []; // CAC currently aggregated, not per-segment

  const weakUpsellRows = await tryQuery('sales.weak_upsell', `
    SELECT id, customer_id
    FROM bookings
    WHERE created_at BETWEEN $1 AND $2
      AND payment_status = 'paid'
      AND (addons IS NULL OR jsonb_array_length(COALESCE(addons, '[]'::jsonb)) = 0)
    LIMIT 50
  `, [fromIso, toIso]) || [];

  return {
    funnel,
    revenueSegments,
    cacVsLtv,
    segmentProfitability,
    growthTrend,
    salesTeam,
    crossSell,
    gaps: {
      decliningRenewals,
      highCacSegments,
      weakUpsell: weakUpsellRows.map(r => r.id),
    },
  };
}

// ── 6. REFERRALS ──────────────────────────────────────────────────────────────

async function getReferrals({ from, to } = {}) {
  const { fromIso, toIso } = defaultRange(from, to);

  // Per-source aggregates
  const sourceRows = await tryQuery('ref.sources', `
    SELECT s.id, s.type, s.name, s.phone,
           COUNT(r.booking_id)      AS jobs_acquired,
           COUNT(r.amc_contract_id) AS amcs_acquired,
           COALESCE(SUM(r.points_awarded), 0) AS points_earned
    FROM referral_sources s
    LEFT JOIN referrals r ON r.source_id = s.id
                          AND r.created_at BETWEEN $1 AND $2
    WHERE s.active = true
    GROUP BY s.id, s.type, s.name, s.phone
    ORDER BY jobs_acquired DESC
  `, [fromIso, toIso]);

  if (sourceRows === null) {
    // Migration not applied — return an empty but valid payload
    return {
      sources: [],
      tierBreakdown: { tier1_3: 0, tier4_6: 0, tier7plus: 0 },
      totalReferrals: 0,
      conversionPct: 0,
      incentivesDisbursed: 0,
      roiUplift: 0,
      topSources: [],
      gaps: { inactiveSocieties: [], unengagedManagers: [] },
      _note: 'referrals tables not migrated yet — run migration 004_referrals.sql',
    };
  }

  const sources = sourceRows.map(r => ({
    type:           r.type,
    name:           r.name,
    phone:          r.phone,
    jobs_acquired:  num(r.jobs_acquired),
    amcs_acquired:  num(r.amcs_acquired),
    points_earned:  num(r.points_earned),
  }));

  // Tier breakdown by jobs acquired
  const tierBreakdown = { tier1_3: 0, tier4_6: 0, tier7plus: 0 };
  for (const s of sources) {
    if (s.jobs_acquired >= 7) tierBreakdown.tier7plus += 1;
    else if (s.jobs_acquired >= 4) tierBreakdown.tier4_6 += 1;
    else if (s.jobs_acquired >= 1) tierBreakdown.tier1_3 += 1;
  }

  // Totals & conversion
  const totalRows = await tryQuery('ref.totals', `
    SELECT
      COUNT(*)                                          AS total,
      COUNT(*) FILTER (WHERE status = 'converted')      AS converted
    FROM referrals
    WHERE created_at BETWEEN $1 AND $2
  `, [fromIso, toIso]);
  const totalReferrals      = num(totalRows?.[0]?.total);
  const convertedReferrals  = num(totalRows?.[0]?.converted);
  const conversionPct       = pct(convertedReferrals, totalReferrals);

  // Incentives disbursed = sum of referral_credit wallet transactions × points→₹.
  const incentiveRows = await tryQuery('ref.incentives', `
    SELECT COALESCE(SUM(GREATEST(delta, 0)), 0) AS points
    FROM wallet_transactions
    WHERE reason = 'referral_credit'
      AND created_at BETWEEN $1 AND $2
  `, [fromIso, toIso]);
  const incentivesDisbursed = Math.round(num(incentiveRows?.[0]?.points) * POINTS_TO_RUPEES);

  // ROI uplift = total captured payments from referred customers in window (rupees).
  const roiRows = await tryQuery('ref.roi', `
    SELECT COALESCE(SUM(p.amount_paise), 0) AS paise
    FROM referrals r
    JOIN payments p ON p.booking_id = r.booking_id
    WHERE p.status IN ('captured','cod_collected')
      AND COALESCE(p.captured_at, p.created_at) BETWEEN $1 AND $2
  `, [fromIso, toIso]);
  let roiUplift = Math.round(num(roiRows?.[0]?.paise) / 100);

  // Fallback to bookings.amount_paise if payments table is empty for these bookings.
  if (roiUplift === 0) {
    const fallbackRows = await tryQuery('ref.roi_fallback', `
      SELECT COALESCE(SUM(b.amount_paise), 0) AS paise
      FROM referrals r
      JOIN bookings b ON b.id = r.booking_id
      WHERE b.payment_status = 'paid'
        AND r.created_at BETWEEN $1 AND $2
    `, [fromIso, toIso]);
    roiUplift = Math.round(num(fallbackRows?.[0]?.paise) / 100);
  }

  // Top sources by composite score (jobs * 1 + amcs * 5)
  const topSources = sources
    .map(s => ({
      name: s.name,
      phone: s.phone,
      score: s.jobs_acquired + s.amcs_acquired * 5,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  // Gaps
  const inactiveSocieties = sources
    .filter(s => s.type === 'society_secretary' && s.jobs_acquired === 0)
    .map(s => ({ name: s.name, phone: s.phone }));
  const unengagedManagers = sources
    .filter(s => (s.type === 'facilities_manager' || s.type === 'apartment_manager')
              && s.jobs_acquired === 0)
    .map(s => ({ name: s.name, phone: s.phone }));

  return {
    sources,
    tierBreakdown,
    totalReferrals,
    conversionPct,
    incentivesDisbursed,
    roiUplift,
    topSources,
    gaps: { inactiveSocieties, unengagedManagers },
  };
}

module.exports = {
  getOperational,
  getEcoScore,
  getRevenue,
  getCustomerEngagement,
  getSales,
  getReferrals,
};
