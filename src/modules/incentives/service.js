/**
 * Incentive service — orchestration layer for the FA incentive system.
 *
 * Two engines live underneath:
 *   - engine.js  — per-job accruals + monthly target/streak (the legacy
 *                  paise-tier system from migration 008)
 *   - engine.js#computeAgentCredits — Phase B credit-based engine
 *                  (migration 011, per the FA Incentive PDF)
 *
 * Public API:
 *   recalcAgentCredits(agent_id)   → persists credits + tier for one agent
 *   recalcAllAgents()              → loops every active field-team agent
 *   applyTierBonusToBatch(batchId) → injects credit_tier_bonus + leave-days
 *                                    onto a payout_batch (called from the
 *                                    repo.markBatchPaid path)
 */

const { query } = require('../../config/db');
const engine = require('./engine');
const repo = require('./repository');

const log  = (m) => console.log(`[incentives.service] ${m}`);
const warn = (m, err) => console.warn(`[incentives.service] ${m}`, err?.message || '');

/* Recalc credits for ONE agent and persist (UPSERT agent_stats + INSERT
   agent_credit_log row). Returns the saved snapshot. */
async function recalcAgentCredits(agent_id) {
  if (!agent_id) return null;
  const month = engine.firstOfMonth();
  const result = await engine.computeAgentCredits({ agent_id, month_start: month });
  await repo.saveAgentCreditSnapshot({
    agent_id,
    month,
    credits_total: result.total,
    breakdown:     result.breakdown,
    tier:          result.tier,
  });
  return { ...result, month };
}

/* Loops every active field-team user (anyone who has been assigned a
   completed job in the last 30 days, OR has an existing agent_stats row).
   Errors on individual agents are logged + swallowed so one bad agent
   doesn't poison the whole nightly run. */
async function recalcAllAgents() {
  const { rows } = await query(
    `SELECT DISTINCT u.id
       FROM users u
       LEFT JOIN jobs j ON j.assigned_team_id = u.id
       LEFT JOIN agent_stats ast ON ast.agent_id = u.id
      WHERE u.role = 'field_team'
        AND (
          (j.completed_at >= now() - INTERVAL '30 days' AND j.status = 'completed')
          OR ast.agent_id IS NOT NULL
        )`
  );
  log(`Recalculating credits for ${rows.length} field-team agents…`);
  let ok = 0, fail = 0;
  for (const r of rows) {
    try {
      await recalcAgentCredits(r.id);
      ok++;
    } catch (err) {
      fail++;
      warn(`agent ${r.id} credit recalc failed`, err);
    }
  }
  log(`Done. ${ok} succeeded, ${fail} failed.`);
  return { processed: rows.length, ok, fail };
}

/* Tier-bonus delivery on payout finalisation.
 *
 * Looks up the agent's tier for the batch's month (preferring the
 * audit-log row written by recalcAgentCredits, falling back to the
 * live agent_stats current_tier), applies cash_bonus_pct_* against
 * total_turnover_30d_paise, and inserts a `credit_tier_bonus` row
 * onto the batch. Also stamps payout_batches.leave_days_awarded.
 *
 * Idempotent: a second call won't insert another bonus row.
 */
async function applyTierBonusToBatch(batchId) {
  if (!batchId) return null;
  const { rows: bRows } = await query(
    `SELECT * FROM payout_batches WHERE id = $1`, [batchId]
  );
  const batch = bRows[0];
  if (!batch) return null;

  // Idempotency guard
  const { rows: existing } = await query(
    `SELECT id FROM incentives
       WHERE batch_id = $1 AND reason = 'credit_tier_bonus' LIMIT 1`,
    [batchId]
  );
  if (existing[0]) return existing[0];

  // Pull the tier the agent earned for THIS month (audit log is source of truth).
  const { rows: logRows } = await query(
    `SELECT tier, credits_total
       FROM agent_credit_log
      WHERE agent_id = $1 AND month = $2::date
      ORDER BY computed_at DESC LIMIT 1`,
    [batch.agent_id, batch.month]
  );
  const { rows: statsRows } = await query(
    `SELECT current_tier, total_turnover_30d_paise
       FROM agent_stats WHERE agent_id = $1`, [batch.agent_id]
  );
  const tier = logRows[0]?.tier || statsRows[0]?.current_tier || 'unrated';
  const turnover = Number(statsRows[0]?.total_turnover_30d_paise || 0);

  const rules = await engine.loadRules();

  let bonusPct = 0;
  let leaveDays = 0;
  switch (tier) {
    case 'platinum':
      bonusPct  = Number(rules.cash_bonus_pct_platinum || 0.15);
      leaveDays = Number(rules.leave_days_platinum     || 2);
      break;
    case 'gold':
      bonusPct  = Number(rules.cash_bonus_pct_gold || 0.10);
      leaveDays = Number(rules.leave_days_gold     || 1);
      break;
    case 'silver':
      bonusPct  = Number(rules.cash_bonus_pct_silver || 0.05);
      leaveDays = 0;
      break;
    default:
      bonusPct  = 0;
      leaveDays = 0;
  }

  const bonusPaise = Math.round(turnover * bonusPct);
  let inserted = null;
  if (bonusPaise > 0) {
    const ins = await query(
      `INSERT INTO incentives
         (agent_id, job_id, amount_paise, reason, tier, batch_id, status)
       VALUES ($1, NULL, $2, 'credit_tier_bonus', $3, $4, 'accrued')
       RETURNING id`,
      [batch.agent_id, bonusPaise, tier, batchId]
    );
    inserted = ins.rows[0];
    // Re-sum the batch total so the admin UI shows the bonus included.
    await query(
      `UPDATE payout_batches
          SET total_paise = (
            SELECT COALESCE(SUM(amount_paise), 0)::int
              FROM incentives
             WHERE batch_id = $1 AND status IN ('accrued','paid')
          )
        WHERE id = $1`,
      [batchId]
    );
  }
  if (leaveDays > 0) {
    await query(
      `UPDATE payout_batches SET leave_days_awarded = $1 WHERE id = $2`,
      [leaveDays, batchId]
    );
  }
  return { inserted, tier, bonusPct, bonusPaise, leaveDays };
}

module.exports = {
  recalcAgentCredits,
  recalcAllAgents,
  applyTierBonusToBatch,
};
