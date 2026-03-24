const app = require('./app');
const CronService = require('./services/cron.service');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log('');
  console.log('🚿 ─────────────────────────────────────────');
  console.log('   Ozone Wash API is running!');
  console.log(`   Local:   http://localhost:${PORT}/api/v1`);
  console.log(`   Health:  http://localhost:${PORT}/api/v1/health`);
  console.log(`   Docs:    http://localhost:${PORT}/api-docs`);
  console.log(`   Mode:    ${process.env.NODE_ENV || 'development'}`);
  console.log('─────────────────────────────────────────────');
  console.log('');

  // Start cron jobs
  CronService.start();
});