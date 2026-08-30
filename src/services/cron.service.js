const cron = require('node-cron');
const AmcRepository = require('../modules/amc/amc.repository');
const AmcService = require('../modules/amc/amc.service');
const NotificationService = require('./notification.service');
const IncentivesCron = require('../cron/incentivesNightly');
const EcoScoreCron = require('../cron/ecoscoreNightly');
const AdminAlertsService = require('../modules/admin-alerts/admin-alerts.service');
const db = require('../config/db');
const PaymentLedger = require('../modules/payments/payment.ledger');

const CronService = {

  // Start all cron jobs
  start: () => {
    console.log('⏰ Starting cron jobs...');

    // Run every day at 9 AM
    cron.schedule('0 9 * * *', async () => {
      console.log('⏰ Running daily cron jobs...');
      await CronService.checkAmcRenewals();
      await CronService.autoCreateRenewals();
      await CronService.expireEndedContracts();
      await CronService.checkSlaBreaches();
      await CronService.expireCertificates();
      await CronService.processScheduledNotifications();
      // Sweep read/stale in-app notification rows (feed shows unread only)
      await db.query(
        `DELETE FROM in_app_notifications
          WHERE read OR created_at < NOW() - INTERVAL '30 days'`
      ).catch(() => {});
    });

    // SLA breach check every 30 minutes
    cron.schedule('*/30 * * * *', async () => {
      await CronService.checkSlaBreaches();
    });

    // Admin alert sweep — every 5 minutes. Detects time-sensitive issues:
    //   unassigned jobs aging > 3h, jobs starting in <1h with no team,
    //   SLA breaches (scheduled-but-not-started, in_progress overrun),
    //   AMC contracts expiring soon / expired-but-still-active.
    // Idempotent — duplicates within 24h are suppressed by the alerts repo.
    cron.schedule('*/5 * * * *', async () => {
      try {
        const out = await AdminAlertsService.runTimeBasedChecks();
        const total = Object.values(out).reduce((a, b) => a + b, 0);
        if (total > 0) console.log('[alerts] sweep queued', total, 'new alerts:', out);
      } catch (e) { console.error('[alerts] sweep failed:', e?.message); }
    });

    // Release abandoned payment holds every 2 minutes. An online booking is a
    // 'pending' HOLD reserving a van slot while the customer pays; if it's still
    // unpaid 8 minutes after creation the slot is freed for other customers.
    cron.schedule('*/2 * * * *', async () => {
      await CronService.releaseExpiredHolds();
    });

    // Run once on boot so the dashboard isn't empty during the first 5 min window.
    setTimeout(() => {
      AdminAlertsService.runTimeBasedChecks()
        .then((out) => console.log('[alerts] boot sweep:', out))
        .catch(() => {});
    }, 3_000);

    // Nightly EcoScore engine (02:00 IST) — recompute every customer's score
    EcoScoreCron.start();

    // Nightly incentive engine (03:00 IST) — recalc stats, freeze month
    IncentivesCron.start();

    console.log('✅ Cron jobs started');
  },

  // Process due scheduled notifications (spec 6.4):
  //   recleaning_reminder — job_date + 83 days (7 days before 90-day expiry)
  //   amc_upsell          — day 3 post-service for non-AMC customers
  processScheduledNotifications: async () => {
    try {
      const { rows } = await db.query(
        `SELECT sn.*, u.phone, u.name, u.fcm_token
           FROM scheduled_notifications sn
           JOIN users u ON u.id = sn.customer_id
          WHERE sn.sent = FALSE AND sn.due_date <= CURRENT_DATE
          ORDER BY sn.due_date ASC
          LIMIT 200`
      );
      for (const n of rows) {
        try {
          if (n.type === 'recleaning_reminder') {
            await NotificationService.sendWhatsApp(n.phone, 'renewal_reminder', [
              { name: 'customer_name', value: n.name || 'Customer' },
            ]);
            if (n.customer_id || n.fcm_token) {
              await NotificationService.notifyUser({ id: n.customer_id, fcm_token: n.fcm_token },
                '💧 Time for your next tank cleaning',
                'Your hygiene certificate expires in 7 days. Book your next cleaning to keep your water safe.',
                { type: 'recleaning_reminder' });
            }
          } else if (n.type === 'whatsapp_retry') {
            const p = n.payload || {};
            if (p.phone && p.template) {
              await NotificationService.sendWhatsApp(p.phone, p.template, p.params || []);
            }
          } else if (n.type === 'amc_upsell') {
            // Skip if the customer signed an AMC since scheduling
            const { rows: amc } = await db.query(
              `SELECT id FROM amc_contracts WHERE customer_id = $1 AND status = 'active' LIMIT 1`,
              [n.customer_id]
            );
            if (!amc.length) {
              await NotificationService.sendWhatsApp(n.phone, 'amc_followup', [
                { name: 'customer_name', value: n.name || 'Customer' },
              ]);
            }
          }
          await db.query(
            `UPDATE scheduled_notifications SET sent = TRUE, sent_at = NOW() WHERE id = $1`,
            [n.id]
          );
        } catch (e) {
          console.warn('[cron] scheduled notification failed:', n.id, e?.message);
        }
      }
      if (rows.length) console.log(`📆 Processed ${rows.length} scheduled notification(s)`);
    } catch (e) {
      console.error('[cron] processScheduledNotifications failed:', e?.message);
    }
  },

  // Send AMC renewal reminders ONLY on the exact threshold-crossing days
  // (30/14/7 days out). Previously this looped supersets and re-notified every
  // day, sending up to 3 reminders per run and repeating daily.
  checkAmcRenewals: async () => {
    try {
      console.log('🔄 Checking AMC renewals...');
      const REMINDER_DAYS = [30, 14, 7];
      const expiring = await AmcRepository.getExpiringSoon(30); // 0..30 days out

      for (const contract of expiring) {
        const daysLeft = Math.ceil((new Date(contract.end_date).getTime() - Date.now()) / 86400000);
        if (!REMINDER_DAYS.includes(daysLeft)) continue; // notify once per threshold

        const customer = await db.query('SELECT * FROM users WHERE id = $1', [contract.customer_id]);
        if (customer.rows[0]) {
          await NotificationService.onAmcRenewalDue(customer.rows[0], contract, daysLeft);
          await AmcRepository.markRenewalPending(contract.id);
          console.log(`📅 AMC renewal alert sent — Contract ${contract.id} expires in ${daysLeft} days`);
        }
      }
    } catch (err) {
      console.error('AMC renewal cron error:', err.message);
    }
  },

  // Auto-create a payable renewal contract for paid, auto-renew contracts within
  // 7 days of expiry, then nudge the customer to pay in one tap. (Silent
  // auto-charge requires a saved mandate — Razorpay Subscriptions / UPI Autopay —
  // which is a gateway-onboarding step; until then this is one-tap renewal.)
  autoCreateRenewals: async () => {
    try {
      const candidates = await AmcRepository.getAutoRenewCandidates(7);
      for (const contract of candidates) {
        try {
          const renewed = await AmcService.createRenewalFor(contract);
          if (!renewed) continue;
          const amountInr = Math.round((renewed.amount_paise || 0) / 100).toLocaleString('en-IN');
          await NotificationService.notifyUser(
            { id: contract.customer_id, fcm_token: null },
            '🔄 Your AMC renewal is ready',
            `Renew your ${contract.plan_type} plan for ₹${amountInr} to keep uninterrupted service.`,
            { type: 'amc_renewal_ready', contract_id: renewed.id, amount_paise: renewed.amount_paise }
          );
          console.log(`🔁 Auto-created renewal ${renewed.id} for expiring contract ${contract.id}`);
        } catch (e) {
          console.warn('[cron] renewal creation failed for', contract.id, e?.message);
        }
      }
    } catch (err) {
      console.error('AMC auto-renewal cron error:', err.message);
    }
  },

  // Expire active contracts whose term has fully ended.
  expireEndedContracts: async () => {
    try {
      const ended = await AmcRepository.getEndedActive();
      for (const c of ended) {
        await AmcRepository.updateStatus(c.id, 'expired');
        console.log(`⌛ AMC contract ${c.id} expired (end_date ${c.end_date})`);
      }
      if (ended.length) console.log(`⌛ Expired ${ended.length} ended AMC contract(s)`);
    } catch (err) {
      console.error('AMC expiry cron error:', err.message);
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

  // Release abandoned payment holds. A 'pending' online booking reserves a van
  // slot (its job holds capacity) while the customer completes payment. Still
  // unpaid 5 minutes after creation → cancel the booking + its holding job (which
  // frees the slot) and any not-yet-paid AMC bought at checkout.
  releaseExpiredHolds: async () => {
    try {
      const { rows } = await db.query(
        `UPDATE bookings
            SET status = 'cancelled', updated_at = NOW()
          WHERE status = 'pending'
            AND payment_status <> 'paid'
            AND payment_method <> 'cod'
            AND amount_paise > 0
            AND created_at < NOW() - INTERVAL '5 minutes'
          RETURNING id, amc_contract_id, razorpay_order_id`
      );
      for (const b of rows) {
        if (b.razorpay_order_id) PaymentLedger.markFailed(b.razorpay_order_id, 'hold expired');
        // Free the van slot — capacity counts scheduled jobs, so cancelling the
        // holding job releases the window for other customers.
        await db.query(
          `UPDATE jobs SET status = 'cancelled' WHERE booking_id = $1 AND status = 'scheduled'`,
          [b.id]
        ).catch(() => {});
        if (b.amc_contract_id) {
          await db.query(
            `UPDATE amc_contracts SET status = 'cancelled'
              WHERE id = $1 AND payment_status <> 'paid'`,
            [b.amc_contract_id]
          ).catch(() => {});
        }
      }
      if (rows.length) console.log(`🕗 Released ${rows.length} expired payment hold(s) — slots freed`);
    } catch (e) {
      console.error('[cron] releaseExpiredHolds failed:', e?.message);
    }
  },

};

module.exports = CronService;