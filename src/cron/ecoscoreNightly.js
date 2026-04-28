/**
 * Nightly EcoScore Cron
 *
 * Schedule: 02:00 IST every day. Recomputes the rolling EcoScore for every
 * customer in the system. Sits BEFORE the incentive cron (03:00 IST) so any
 * badge changes flow through into agent stats.
 *
 * Concurrency is intentionally small (5) — Supabase free tier has limited
 * connection slots and we don't want to starve the live API.
 *
 * Usage:
 *   - Auto-registered when CronService.start() runs (server boot).
 *   - Or run on demand:  node src/cron/ecoscoreNightly.js
 */

const cron = require('node-cron');
const EcoScoreService = require('../modules/ecoscore/ecoscore.service');

const log = (m) => console.log(`[ecoscore.cron] ${m}`);
const warn = (m, err) => console.warn(`[ecoscore.cron] ${m}`, err?.message || '');

async function runNightly() {
  try {
    const start = Date.now();
    log('Recomputing EcoScores for all customers…');
    const result = await EcoScoreService.recalcAllCustomers({ concurrency: 5 });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    log(`Done in ${elapsed}s — total=${result.total} ok=${result.ok} fail=${result.fail}`);

    // Phase A: expire EcoPoints older than 24 months. Runs after the
    // recompute so the wallet reflects fresh credits before stale ones are
    // pruned. Failure here must NOT mark the cron as failed.
    try {
      log('Expiring EcoPoints older than 24 months…');
      const expiry = await EcoScoreService.expireOldEcoPoints();
      log(`Expiry done — users=${expiry.users} points_expired=${expiry.expired}`);
    } catch (e) {
      warn('expireOldEcoPoints failed', e);
    }

    return result;
  } catch (err) {
    warn('runNightly failed', err);
    return null;
  }
}

function start() {
  // 02:00 IST (Asia/Kolkata)
  cron.schedule(
    '0 2 * * *',
    () => {
      log('⏰ Running nightly EcoScore cron (02:00 IST)…');
      runNightly().catch((err) => warn('cron tick failed', err));
    },
    { timezone: 'Asia/Kolkata' }
  );
  log('✅ Nightly EcoScore cron registered (02:00 IST)');
}

module.exports = { start, runNightly };

/* ── CLI entry ───────────────────────────────────────────────────── */
if (require.main === module) {
  require('dotenv').config({
    path: require('path').resolve(__dirname, '../../.env.client'),
  });
  runNightly()
    .then(() => { log('CLI run complete'); process.exit(0); })
    .catch((err) => { warn('CLI run failed', err); process.exit(1); });
}
