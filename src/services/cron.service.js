const cron = require('node-cron');
const AmcRepository = require('../modules/amc/amc.repository');
const NotificationService = require('./notification.service');
const IncentivesCron = require('../cron/incentivesNightly');
const EcoScoreCron = require('../cron/ecoscoreNightly');
const db = require('../config/db');

const CronService = {

  // Start all cron jobs
  start: () => {
    console.log('⏰ Starting cron jobs...');

    // Run every day at 9 AM
    cron.schedule('0 9 * * *', async () => {
      console.log('⏰ Running daily cron jobs...');
      await CronService.checkAmcRenewals();
      await CronService.checkSlaBreaches();
      await CronService.expireCertificates();
    });

    // SLA breach check every 30 minutes
    cron.schedule('*/30 * * * *', async () => {
      await CronService.checkSlaBreaches();
    });

    // Nightly EcoScore engine (02:00 IST) — recompute every customer's score
    EcoScoreCron.start();

    // Nightly incentive engine (03:00 IST) — recalc stats, freeze month
    IncentivesCron.start();

    console.log('✅ Cron jobs started');
  },

  // Check AMC contracts expiring in 30, 14, 7 days
  checkAmcRenewals: async () => {
    try {
      console.log('🔄 Checking AMC renewals...');

      for (const days of [30, 14, 7]) {
        const expiring = await AmcRepository.getExpiringSoon(days);

        for (const contract of expiring) {
          // Get customer details
          const customer = await db.query(
            'SELECT * FROM users WHERE id = $1',
            [contract.customer_id]
          );

          if (customer.rows[0]) {
            await NotificationService.onAmcRenewalDue(
              customer.rows[0],
              contract,
              days
            );

            // Mark renewal pending if within 30 days
            if (days === 30) {
              await AmcRepository.markRenewalPending(contract.id);
            }

            console.log(`📅 AMC renewal alert sent — Contract: ${contract.id} expires in ${days} days`);
          }
        }
      }
    } catch (err) {
      console.error('AMC renewal cron error:', err.message);
    }
  },

  // Check for SLA breaches
  checkSlaBreaches: async () => {
    try {
      const breaches = await AmcRepository.getSlaBreaches();

      if (breaches.length === 0) return;

      console.log(`⚠️ Found ${breaches.length} SLA breaches`);

      // Get admin users
      const admins = await db.query(
        'SELECT * FROM users WHERE role = $1',
        ['admin']
      );

      for (const admin of admins.rows) {
        for (const breach of breaches) {
          await NotificationService.onSlaBreached(
            admin.fcm_token,
            breach
          );
        }
      }
    } catch (err) {
      console.error('SLA breach cron error:', err.message);
    }
  },

  // Expire old certificates
  expireCertificates: async () => {
    try {
      const result = await db.query(
        `UPDATE hygiene_certificates
         SET status = 'expired'
         WHERE valid_until < CURRENT_DATE
           AND status = 'active'
         RETURNING id`
      );

      if (result.rows.length > 0) {
        console.log(`📋 Expired ${result.rows.length} certificates`);
      }
    } catch (err) {
      console.error('Certificate expiry cron error:', err.message);
    }
  },

};

module.exports = CronService;