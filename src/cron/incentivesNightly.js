/**
 * Nightly Incentive Engine Cron
 *
 * Schedule: 03:00 IST every day. Sits after the EcoScore cron (02:00 IST)
 * so any rating/score changes from the previous day are already in place.
 *
 * Tasks:
 *   1. Recalc agent_stats for every agent with >0 jobs in the last 30 days.
 *   2. Evaluate monthly target for each active agent (current month).
 *   3. On the 1st of every month, freeze the previous month's open
 *      payout_batches so they're locked for admin payout.
 *
 * Usage:
 *   - Auto-registered when CronService.start() runs (server boot).
 *   - Or run on demand:  node src/cron/incentivesNightly.js
 */

const cron = require('node-cron');
const { query } = require('../config/db');
const engine = require('../modules/incentives/engine');
const repo = require('../modules/incentives/repository');

const log = (m) => console.log(`[incentives.cron] ${m}`);
const warn = (m, err) => console.warn(`[incentives.cron] ${m}`, err?.message || '');

/* ── Find every agent with recent activity ───────────────────────── */
async function activeAgents() {
  const { rows } = await query(
    `SELECT DISTINCT u.id
       FROM users u
       JOIN jobs j ON j.assigned_team_id = u.id
      WHERE u.role = 'field_team'
        AND j.completed_at >= now() - INTERVAL '30 days'
        AND j.status = 'completed'`
  );
  return rows.map(r => r.id);
}

/* ── 1+2: per-agent recalc + monthly-target evaluation ───────────── */
async function recalcAndEvaluate() {
  const ids = await activeAgents();
  log(`Recalculating ${ids.length} active agents…`);
  const month = engine.firstOfMonth();
  for (const agent_id of ids) {
    try {
      await engine.recalcAgentStats({ agent_id });
      await engine.evaluateMonthlyTarget({ agent_id, month });
    } catch (err) {
      warn(`agent ${agent_id} recalc failed`, err);
    }
  }
  log(`Done. ${ids.length} agents processed.`);
}

/* ── 3: month-rollover — freeze prior month's open batches ───────── */
async function freezePriorMonth() {
  const today = new Date();
  if (today.getUTCDate() !== 1) return; // only on the 1st
  const prior = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1))
    .toISOString().slice(0, 10);
  const { rows } = await query(
    `SELECT id FROM payout_batches WHERE month = $1 AND status = 'open'`,
    [prior]
  );
  log(`Month rollover: freezing ${rows.length} open batches for ${prior}…`);
  for (const r of rows) {
    try {
      await repo.freezeBatch(r.id);
    } catch (err) {
      warn(`freeze batch ${r.id} failed`, err);
    }
  }
}

/* ── Public runner — used by both cron and CLI ───────────────────── */
async function runNightly() {
  try {
    await recalcAndEvaluate();
    await freezePriorMonth();
  } catch (err) {
    warn('runNightly failed', err);
  }
}

/* ── Cron registration ───────────────────────────────────────────── */
// node-cron uses server local time. 03:00 IST = 21:30 UTC the previous day.
// We register both so it fires correctly regardless of host TZ.
function start() {
  // 03:00 IST (Asia/Kolkata) — explicit timezone to avoid TZ drift on Railway
  cron.schedule(
    '0 3 * * *',
    () => {
      log('⏰ Running nightly incentive cron (03:00 IST)…');
      runNightly().catch(err => warn('cron tick failed', err));
    },
    { timezone: 'Asia/Kolkata' }
  );
  log('✅ Nightly incentive cron registered (03:00 IST)');
}

module.exports = { start, runNightly, recalcAndEvaluate, freezePriorMonth };

/* ── CLI entry ───────────────────────────────────────────────────── */
if (require.main === module) {
  require('dotenv').config({
    path: require('path').resolve(__dirname, '../../.env.client'),
  });
  runNightly()
    .then(() => { log('CLI run complete'); process.exit(0); })
    .catch((err) => { warn('CLI run failed', err); process.exit(1); });
}
