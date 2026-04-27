const app = require('./app');
const CronService = require('./services/cron.service');
const { closePool } = require('./config/db');

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log('');
  console.log('🚿 ─────────────────────────────────────────');
  console.log('   Ozone Wash API is running!');
  console.log(`   Local:   http://localhost:${PORT}/api/v1`);
  console.log(`   Health:  http://localhost:${PORT}/api/v1/health`);
  console.log(`   Docs:    http://localhost:${PORT}/api-docs`);
  console.log(`   Mode:    ${process.env.NODE_ENV || 'development'}`);
  console.log('─────────────────────────────────────────────');
  console.log('');

  CronService.start();
});

// ── Graceful shutdown ───────────────────────────────────────────────────────
// nodemon sends SIGTERM on file-change restarts. Without this, Node exits
// before the OS releases port 3000 → next start hits EADDRINUSE.  Same applies
// to Ctrl-C (SIGINT), and Windows-only Ctrl-Break (SIGBREAK).
let shuttingDown = false;
const shutdown = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[${signal}] Closing HTTP server…`);
  // Close cron timers so process can exit cleanly
  try { CronService.stop && CronService.stop(); } catch (_) {}
  server.close(async (err) => {
    if (err) console.error('[shutdown] server.close error:', err.message);
    await closePool();
    console.log('[shutdown] Port released. Bye 👋');
    process.exit(err ? 1 : 0);
  });
  // Hard-exit fallback if some keep-alive socket refuses to close
  setTimeout(() => {
    console.warn('[shutdown] Forcing exit after 5 s timeout');
    process.exit(0);
  }, 5000).unref();
};

['SIGTERM', 'SIGINT', 'SIGBREAK'].forEach((sig) => process.on(sig, () => shutdown(sig)));

// Surface unhandled rejections instead of letting Node print a deprecation
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});