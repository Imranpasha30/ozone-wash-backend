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
        }
      );

      return { success: true, data: response.data };
    } catch (err) {
      console.error('WhatsApp error:', err.message);
      return { success: false, error: err.message };
    }
  },

  // ── SMS (DLT Gateway) ─────────────────────────────────────────────────
  sendSMS: async (phone, message) => {
    try {
      if (!process.env.SMS_API_KEY) {
        console.log(`📩 [SMS DEV] To: ${phone} | Message: ${message}`);
        return { success: true, dev: true };
      }

      const response = await axios.post(process.env.SMS_API_URL, {
        apikey: process.env.SMS_API_KEY,
        sender: process.env.SMS_SENDER_ID,
        to: phone,
        message,
      });

      return { success: true, data: response.data };
    } catch (err) {
      console.error('SMS error:', err.message);
      return { success: false, error: err.message };
    }
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
      NotificationService.sendPush(
        customer.fcm_token,
        '✅ Booking Confirmed!',
        `Your tank cleaning is scheduled for ${new Date(job.scheduled_at).toLocaleDateString('en-IN')}`,
        { job_id: job.id, type: 'booking_confirmed' }
      ),
    ]);
  },

  // 2. Field team assigned
  onTeamAssigned: async (teamMember, job) => {
    await NotificationService.sendPush(
      teamMember.fcm_token,
      '🔧 New Job Assigned',
      `You have a new job on ${new Date(job.scheduled_at).toLocaleDateString('en-IN')}`,
      { job_id: job.id, type: 'job_assigned' }
    );
  },

  // 3. Job started
  onJobStarted: async (customer, job) => {
    await NotificationService.sendPush(
      customer.fcm_token,
      '🚿 Cleaning Started!',
      'Our team has started cleaning your tank.',
      { job_id: job.id, type: 'job_started' }
    );
  },

  // 4. Compliance step completed
  onStepCompleted: async (customer, stepName, jobId) => {
    await NotificationService.sendPush(
      customer.fcm_token,
      `✓ ${stepName} Complete`,
      'Your cleaning is in progress.',
      { job_id: jobId, type: 'step_completed' }
    );
  },

  // 5. Certificate generated
  onCertificateGenerated: async (customer, cert) => {
    const message = `Your Ozone Wash hygiene certificate is ready! Download: ${cert.certificate_url} -OZNWSH`;

    await Promise.allSettled([
      NotificationService.sendWhatsApp(customer.phone, 'certificate_ready', [
        { name: 'customer_name', value: customer.name || 'Customer' },
        { name: 'cert_url', value: cert.certificate_url },
        { name: 'eco_score', value: String(cert.eco_score) },
      ]),
      NotificationService.sendPush(
        customer.fcm_token,
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

};

module.exports = NotificationService;