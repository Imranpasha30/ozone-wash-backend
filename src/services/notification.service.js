const axios = require('axios');

// ── Firebase Admin Setup ──────────────────────────────────────────────────
let firebaseAdmin = null;

const getFirebaseAdmin = () => {
  if (!firebaseAdmin && process.env.FIREBASE_PROJECT_ID) {
    try {
      const admin = require('firebase-admin');
      if (!admin.apps.length) {
        admin.initializeApp({
          credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
          }),
        });
      }
      firebaseAdmin = admin;
    } catch (err) {
      console.warn('Firebase not configured:', err.message);
    }
  }
  return firebaseAdmin;
};

const NotificationService = {

  // ── In-app notification feed ──────────────────────────────────────────
  // Persists a row the Notifications screen polls over REST — works on web
  // where FCM is unavailable. Never throws (feed writes must not break the
  // business action that triggered them).
  sendInApp: async (userId, title, body, data = {}) => {
    if (!userId) return { success: false, reason: 'no_user' };
    try {
      const db = require('../config/db');
      await db.query(
        `INSERT INTO in_app_notifications (user_id, title, body, data)
         VALUES ($1, $2, $3, $4)`,
        [userId, title, body || '', JSON.stringify(data || {})]
      );
      return { success: true };
    } catch (err) {
      console.error('in-app notification error:', err.message);
      return { success: false, error: err.message };
    }
  },

  // Push + in-app feed in one call. `user` needs { id, fcm_token } — either
  // may be missing (web users have no token; some queries only join the token).
  notifyUser: async (user, title, body, data = {}) => {
    await Promise.allSettled([
      NotificationService.sendInApp(user?.id, title, body, data),
      NotificationService.sendPush(user?.fcm_token, title, body, data),
    ]);
  },

  // ── FCM Push Notification ─────────────────────────────────────────────
  sendPush: async (fcmToken, title, body, data = {}) => {
    try {
      if (!fcmToken) {
        console.log(`📲 [PUSH SKIPPED] No FCM token. Title: ${title}`);
        return { success: false, reason: 'no_token' };
      }

      const admin = getFirebaseAdmin();
      if (!admin) {
        console.log(`📲 [PUSH DEV] To: ${fcmToken.substring(0, 20)}... | ${title}: ${body}`);
        return { success: true, dev: true };
      }

      const message = {
        token: fcmToken,
        notification: { title, body },
        data: Object.fromEntries(
          Object.entries(data).map(([k, v]) => [k, String(v)])
        ),
        android: {
          priority: 'high',
          notification: { sound: 'default' },
        },
        apns: {
          payload: {
            aps: { sound: 'default', badge: 1 },
          },
        },
      };

      const response = await admin.messaging().send(message);
      return { success: true, message_id: response };
    } catch (err) {
      console.error('FCM error:', err.message);
      return { success: false, error: err.message };
    }
  },

  // ── WhatsApp (Wati) ───────────────────────────────────────────────────
  sendWhatsApp: async (phone, templateName, params = []) => {
    try {
      if (!process.env.WHATSAPP_API_KEY || !process.env.WHATSAPP_API_URL) {
        console.log(`📱 [WHATSAPP DEV] To: ${phone} | Template: ${templateName} | Params: ${JSON.stringify(params)}`);
        return { success: true, dev: true };
      }

      // Format phone number — add 91 prefix for India
      const formattedPhone = phone.startsWith('91') ? phone : `91${phone}`;

      const response = await axios.post(
        `${process.env.WHATSAPP_API_URL}/sendTemplateMessage`,
        {
          template_name: templateName,
          broadcast_name: templateName,
          parameters: params.map(p => ({ name: p.name, value: p.value })),
          receivers: [{ whatsappNumber: formattedPhone }],
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_API_KEY}`,
            'Content-Type': 'application/json',
          },
          // Hard cap — a hanging BSP endpoint must never stall API requests
          // (Windows TCP gives up after ~4 min without this).
          timeout: 10000,
        }
      );

      return { success: true, data: response.data };
    } catch (err) {
      console.error('WhatsApp error:', err.message);
      // Offline/queue guarantee (spec §1/§12): a failed transactional send is
      // queued and retried by the daily cron instead of being dropped.
      try {
        const db = require('../config/db');
        await db.query(
          `INSERT INTO scheduled_notifications (type, customer_id, due_date, payload)
           SELECT 'whatsapp_retry', u.id, CURRENT_DATE, $2::jsonb
             FROM users u WHERE u.phone = $1 LIMIT 1`,
          [String(phone).replace(/^91/, ''), JSON.stringify({ phone, template: templateName, params })]
        );
      } catch (_) { /* queue table unavailable — logged error above stands */ }
      return { success: false, error: err.message, queued: true };
    }
  },

  // ── SMS ───────────────────────────────────────────────────────────────
  // Providers: authkey (default), fast2sms, msg91
  // Set SMS_PROVIDER in .env to switch
  sendSMS: async (phone, message, otp = null) => {
    try {
      if (!process.env.SMS_API_KEY) {
        console.log(`[SMS DEV] To: ${phone} | Message: ${message}`);
        return { success: true, dev: true };
      }

      const provider = process.env.SMS_PROVIDER || 'authkey';
      // Clean phone — remove +91, spaces, dashes
      const cleanPhone = phone.replace(/^\+?91/, '').replace(/[\s-]/g, '').slice(-10);

      if (provider === 'authkey') {
        // Authkey.io — https://authkey.io
        const params = {
          authkey: process.env.SMS_API_KEY,
          mobile: cleanPhone,
          country_code: '91',
          sid: process.env.AUTHKEY_SID || process.env.SMS_TEMPLATE_ID,
          company: process.env.AUTHKEY_COMPANY || 'Ozone Wash',
        };
        if (otp) params.otp = otp;

        const response = await axios.get('https://api.authkey.io/request', { params, timeout: 30000 });
        const result = response.data;

        if (result?.Message?.includes('Submitted')) {
          console.log(`[SMS] Authkey sent to ${cleanPhone} (LogID: ${result.LogID})`);
          return { success: true, data: result };
        }
        console.error('[SMS] Authkey response:', result);
        return { success: false, error: result?.Message || 'Unknown error' };

      } else if (provider === 'fast2sms') {
        const response = await axios.post(
          'https://www.fast2sms.com/dev/bulkV2',
          {
            route: 'dlt',
            sender_id: process.env.SMS_SENDER_ID || 'OZNWSH',
            message: process.env.SMS_TEMPLATE_ID || message,
            variables_values: message,
            flash: '0',
            numbers: cleanPhone,
          },
          { headers: { authorization: process.env.SMS_API_KEY }, timeout: 10000 }
        );
        return { success: true, data: response.data };

      } else if (provider === 'msg91') {
        const response = await axios.post(
          'https://control.msg91.com/api/v5/flow/',
          {
            template_id: process.env.SMS_TEMPLATE_ID,
            recipients: [{ mobiles: `91${cleanPhone}`, otp: otp || message }],
          },
          {
            headers: {
              authkey: process.env.SMS_API_KEY,
              'Content-Type': 'application/json',
            },
            timeout: 10000,
          }
        );
        return { success: true, data: response.data };

      } else {
        const response = await axios.post(process.env.SMS_API_URL, {
          apikey: process.env.SMS_API_KEY,
          sender: process.env.SMS_SENDER_ID,
          to: cleanPhone,
          message,
        }, { timeout: 10000 });
        return { success: true, data: response.data };
      }
    } catch (err) {
      console.error('SMS error:', err.message);
      return { success: false, error: err.message };
    }
  },

  // ── OTP Delivery (SMS + WhatsApp combined) ────────────────────────────
  // Called by auth.service.js when sending login OTP
  sendOtp: async (phone, otpCode) => {
    // Android SMS Retriever API requires the message to start with "<#>" and
    // end with the app's 11-character SHA-256 hash signature on its own line.
    // The presence of <#> + the hash lets Android verify the SMS belongs to
    // this app and silently auto-fill the OTP — no user permission, no
    // SMS-read permission needed.
    //
    // Set ANDROID_SMS_HASH in .env to the value printed by `keytool` (see
    // docs). If unset, the message falls back to the plain template (auto-
    // fill won't engage; user still gets the OTP normally).
    const hash = process.env.ANDROID_SMS_HASH;
    const message = hash
      ? `<#> ${otpCode} is your Ozone Wash OTP. Valid for 10 minutes. Do not share with anyone. -OZNWSH\n\n${hash}`
      : `${otpCode} is your Ozone Wash OTP. Valid for 10 minutes. Do not share with anyone. -OZNWSH`;

    await Promise.allSettled([
      NotificationService.sendSMS(phone, message, otpCode),
      NotificationService.sendWhatsApp(phone, 'otp_login', [
        { name: 'otp', value: otpCode },
        { name: 'validity', value: '10 minutes' },
      ]),
    ]);
  },

  // ── Email (Nodemailer) ────────────────────────────────────────────────
  sendEmail: async (to, subject, html) => {
    try {
      if (!process.env.EMAIL_USER) {
        console.log(`📧 [EMAIL DEV] To: ${to} | Subject: ${subject}`);
        return { success: true, dev: true };
      }

      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS,
        },
      });

      await transporter.sendMail({
        from: `Ozone Wash <${process.env.EMAIL_USER}>`,
        to,
        subject,
        html,
      });

      return { success: true };
    } catch (err) {
      console.error('Email error:', err.message);
      return { success: false, error: err.message };
    }
  },

  // ── Notification Events ───────────────────────────────────────────────
  // These are called from controllers at specific events

  // 1. Booking confirmed
  onBookingConfirmed: async (customer, job) => {
    const message = `Your Ozone Wash booking is confirmed! Job ID: ${job.id}. Our team will arrive on ${new Date(job.scheduled_at).toLocaleDateString('en-IN')}. -OZNWSH`;

    await Promise.allSettled([
      NotificationService.sendSMS(customer.phone, message),
      NotificationService.sendWhatsApp(customer.phone, 'booking_confirmed', [
        { name: 'customer_name', value: customer.name || 'Customer' },
        { name: 'job_date', value: new Date(job.scheduled_at).toLocaleDateString('en-IN') },
      ]),
      NotificationService.notifyUser(
        customer,
        '✅ Booking Confirmed!',
        `Your tank cleaning is scheduled for ${new Date(job.scheduled_at).toLocaleDateString('en-IN')}`,
        { job_id: job.id, type: 'booking_confirmed' }
      ),
    ]);
  },

  // 2. Field team assigned
  onTeamAssigned: async (teamMember, job) => {
    await NotificationService.notifyUser(
      teamMember,
      '🔧 New Job Assigned',
      `You have a new job on ${new Date(job.scheduled_at).toLocaleDateString('en-IN')}`,
      { job_id: job.id, type: 'job_assigned' }
    );
  },

  // 3. Job started
  onJobStarted: async (customer, job) => {
    await NotificationService.notifyUser(
      customer,
      '🚿 Cleaning Started!',
      'Our team has started cleaning your tank.',
      { job_id: job.id, type: 'job_started' }
    );
  },

  // 4. Compliance step completed
  onStepCompleted: async (customer, stepName, jobId) => {
    await NotificationService.notifyUser(
      customer,
      `✓ ${stepName} Complete`,
      'Your cleaning is in progress.',
      { job_id: jobId, type: 'step_completed' }
    );
  },

  // 5. Certificate generated
  onCertificateGenerated: async (customer, cert) => {
    const smsMessage = `Your Ozone Wash hygiene certificate is ready! EcoScore: ${cert.eco_score}. Download: ${cert.certificate_url} -OZNWSH`;

    await Promise.allSettled([
      NotificationService.sendSMS(customer.phone, smsMessage),
      NotificationService.sendWhatsApp(customer.phone, 'certificate_ready', [
        { name: 'customer_name', value: customer.name || 'Customer' },
        { name: 'cert_url', value: cert.certificate_url },
        { name: 'eco_score', value: String(cert.eco_score) },
      ]),
      NotificationService.notifyUser(
        customer,
        '🏆 Certificate Ready!',
        `Your hygiene certificate is ready. EcoScore: ${cert.eco_score}`,
        { cert_id: cert.id, type: 'certificate_ready' }
      ),
    ]);
  },

  // 6. AMC renewal reminder
  onAmcRenewalDue: async (customer, contract, daysLeft) => {
    const message = `Your Ozone Wash AMC contract expires in ${daysLeft} days. Renew now to continue uninterrupted service. -OZNWSH`;

    await Promise.allSettled([
      NotificationService.sendSMS(customer.phone, message),
      NotificationService.sendWhatsApp(customer.phone, 'amc_renewal_reminder', [
        { name: 'customer_name', value: customer.name || 'Customer' },
        { name: 'days_left', value: String(daysLeft) },
        { name: 'plan_type', value: contract.plan_type },
      ]),
      NotificationService.sendEmail(
        customer.email,
        `AMC Renewal Reminder — ${daysLeft} days left`,
        `
          <h2>Your AMC Contract is expiring soon</h2>
          <p>Dear ${customer.name || 'Customer'},</p>
          <p>Your <strong>${contract.plan_type}</strong> AMC contract expires in <strong>${daysLeft} days</strong>.</p>
          <p>Please renew to continue enjoying uninterrupted tank hygiene services.</p>
          <br/>
          <p>Team Ozone Wash</p>
        `
      ),
    ]);
  },

  // 7. SLA breach
  onSlaBreached: async (adminFcmToken, job) => {
    await NotificationService.sendPush(
      adminFcmToken,
      '⚠️ SLA Breach Alert!',
      `Job ${job.id} is overdue by ${Math.round(job.hours_overdue)} hours`,
      { job_id: job.id, type: 'sla_breach' }
    );
  },

  // 8. Incident reported
  onIncidentReported: async (adminFcmToken, jobId) => {
    await NotificationService.sendPush(
      adminFcmToken,
      '🚨 Incident Reported!',
      'A field team member has reported an incident.',
      { job_id: jobId, type: 'incident_reported' }
    );
  },

  // 9. Payment confirmed
  onPaymentConfirmed: async (customer, booking) => {
    const message = `Payment of ₹${booking.amount_paise / 100} confirmed for your Ozone Wash booking. Thank you! -OZNWSH`;

    await Promise.allSettled([
      NotificationService.sendSMS(customer.phone, message),
      NotificationService.sendWhatsApp(customer.phone, 'payment_confirmed', [
        { name: 'customer_name', value: customer.name || 'Customer' },
        { name: 'amount', value: String(booking.amount_paise / 100) },
      ]),
    ]);
  },

  // 10. Refund initiated — money is on its way back (5-7 working days). When the
  // whole booking was refunded it's also been cancelled.
  onRefundInitiated: async (customer, { amountRupees, cancelled, bookingId }) => {
    const cancelLine = cancelled ? 'Your booking has been cancelled and a' : 'A';
    const message = `${cancelLine} refund of ₹${amountRupees} has been initiated for your Ozone Wash booking. It will be credited to your original payment method within 5-7 working days. -OZNWSH`;
    await Promise.allSettled([
      NotificationService.sendSMS(customer.phone, message),
      NotificationService.notifyUser(
        customer,
        cancelled ? '↩️ Booking cancelled — refund initiated' : '↩️ Refund initiated',
        `₹${amountRupees} will be credited to your original payment method in 5-7 working days.`,
        { booking_id: bookingId || '', type: 'refund_initiated' }
      ),
      NotificationService.sendWhatsApp(customer.phone, 'refund_initiated', [
        { name: 'customer_name', value: customer.name || 'Customer' },
        { name: 'amount', value: String(amountRupees) },
      ]),
    ]);
  },

  // 11. Refund completed — funds actually credited (fired from the gateway
  // refund webhook once PayU settles it).
  onRefundCompleted: async (customer, { amountRupees, bookingId }) => {
    const message = `Your refund of ₹${amountRupees} from Ozone Wash has been processed and credited to your original payment method. -OZNWSH`;
    await Promise.allSettled([
      NotificationService.sendSMS(customer.phone, message),
      NotificationService.notifyUser(
        customer,
        '✅ Refund completed',
        `₹${amountRupees} has been credited to your original payment method.`,
        { booking_id: bookingId || '', type: 'refund_completed' }
      ),
    ]);
  },

  /* ──────────────────────────────────────────────────────────────────────
   * AUTO WASH NOTIFICATIONS
   *
   * Calls the existing `sendWhatsApp(phone, templateName, params)` wrapper.
   * That wrapper is fire-and-forget with try/catch — if a template hasn't
   * been registered on Wati yet, it logs "WhatsApp error: template not found"
   * but does NOT throw, so booking/step lifecycle is never blocked.
   *
   * Template registration spec lives at:
   *   docs/wati-auto-wash-templates.md
   *
   * Each function below also keeps a `console.log` line as a development
   * trace so the ops team can confirm the trigger fires even while Wati
   * templates are being approved (Wati template approval typically
   * takes 24-48h).
   * ───────────────────────────────────────────────────────────────────── */

  autoWashBookingConfirmed: async (customerPhone, customerName, jobId, scheduledAt, packageName) => {
    console.log(`[autowash.notify] booking_confirmed → ${customerPhone} | ${customerName} | job ${jobId} | ${new Date(scheduledAt).toLocaleString()} | ${packageName}`);
    try {
      await NotificationService.sendWhatsApp(customerPhone, 'auto_wash_booking_confirmed', [
        customerName || 'Customer',
        String(jobId).slice(0, 8).toUpperCase(),
        new Date(scheduledAt).toLocaleString('en-IN'),
        packageName || '—',
      ]);
    } catch (e) { /* fire-and-forget */ }
  },

  autoWashCrewAssigned: async (customerPhone, crewName, jobId) => {
    console.log(`[autowash.notify] crew_assigned → ${customerPhone} | crew ${crewName} | job ${jobId}`);
    try {
      await NotificationService.sendWhatsApp(customerPhone, 'auto_wash_crew_assigned', [
        crewName || 'Your crew',
        String(jobId).slice(0, 8).toUpperCase(),
      ]);
    } catch (e) {}
  },

  autoWashStepStarted: async (customerPhone, jobId, stepNumber, stepLabel) => {
    console.log(`[autowash.notify] step_${stepNumber}_started → ${customerPhone} | ${stepLabel} | job ${jobId}`);
    try {
      await NotificationService.sendWhatsApp(customerPhone, 'auto_wash_step_started', [
        String(stepNumber),
        stepLabel || `Step ${stepNumber}`,
      ]);
    } catch (e) {}
  },

  autoWashFoggingStarted: async (customerPhone, jobId) => {
    // SAFETY-CRITICAL message: customer must not re-enter vehicle for 15 min.
    console.log(`[autowash.notify] ⚠️  FOGGING_STARTED → ${customerPhone} | job ${jobId} | Do not enter vehicle for 15 minutes`);
    try {
      await NotificationService.sendWhatsApp(customerPhone, 'auto_wash_fogging_started', [
        String(jobId).slice(0, 8).toUpperCase(),
      ]);
    } catch (e) {}
  },

  autoWashJobComplete: async (customerPhone, customerName, jobId, ecoScore, ecoBadge, waterSaved) => {
    console.log(`[autowash.notify] job_complete → ${customerPhone} | ${customerName} | job ${jobId} | EcoScore ${ecoScore} (${ecoBadge}) | saved ${waterSaved}L`);
    const certUrl = `https://ozonewash.in/verify/AW-${String(jobId).slice(0, 12)}`;
    try {
      await NotificationService.sendWhatsApp(customerPhone, 'auto_wash_job_complete', [
        customerName || 'Customer',
        String(ecoScore),
        String(ecoBadge || '').toUpperCase(),
        String(waterSaved || 0),
        certUrl,
      ]);
    } catch (e) {}
  },

  autoWashSubscriptionRenewalDue: async (customerPhone, planName, daysLeft, priceLabel) => {
    console.log(`[autowash.notify] subscription_renewal_due → ${customerPhone} | ${planName} | ${daysLeft} days | ${priceLabel}`);
    try {
      await NotificationService.sendWhatsApp(customerPhone, 'auto_wash_subscription_renewal_due', [
        planName,
        String(daysLeft),
        priceLabel,
      ]);
    } catch (e) {}
  },

  autoWashCarBirthday: async (customerPhone, nickname, age) => {
    console.log(`[autowash.notify] car_birthday → ${customerPhone} | ${nickname} | ${age}y`);
    try {
      await NotificationService.sendWhatsApp(customerPhone, 'auto_wash_car_birthday', [
        nickname || 'Your car',
        String(age),
      ]);
    } catch (e) {}
  },

};

module.exports = NotificationService;