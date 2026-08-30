const PaymentService = require('../../services/payment.service');
const BookingRepository = require('../bookings/booking.repository');
const AmcRepository = require('../amc/amc.repository');
const NotificationService = require('../../services/notification.service');
const InvoiceService = require('../invoices/invoice.service');
const { sendSuccess, sendError } = require('../../utils/response');
const db = require('../../config/db');
const PaymentLedger = require('./payment.ledger');

/**
 * Reinstate the holding job(s) the 5-min hold-sweep cancelled — but ONLY if the
 * slot still has capacity in its resource pool. A late gateway settle can
 * otherwise double-commit a slot that was resold while the payment was in
 * flight (money captured on BOTH bookings). If the slot refilled, leave the job
 * cancelled and raise a critical admin alert so the now-paid booking gets a
 * reschedule/refund — never silently overbook.
 *
 * Serialized under the SAME per-date advisory lock the booking-create path uses,
 * so the capacity read + reinstate is atomic against a concurrent booking that
 * would take the last van. Fail-safe: if capacity can't be verified we do NOT
 * reinstate (never risk a double-commit) and alert instead.
 */
const reinstateHoldingJobs = async (bookingId) => {
  const SchedulingService = require('../../services/scheduling.service');
  const AdminAlertsService = require('../admin-alerts/admin-alerts.service');
  let jobs = [];
  try {
    const { rows } = await db.query(
      `SELECT id, scheduled_at, duration_min, resource_type,
              assigned_team_id, assigned_field_team_id
         FROM jobs WHERE booking_id = $1 AND status = 'cancelled'`,
      [bookingId]
    );
    jobs = rows;
  } catch (e) {
    console.warn('[reinstate] could not load holding jobs:', e?.message);
    return;
  }
  for (const job of jobs) {
    let release = null;
    try {
      release = await SchedulingService.acquireSlotLock(SchedulingService.toDateKey(job.scheduled_at));
      // Re-read under the lock — a racing settle (webhook + verify) may have
      // already reinstated this job. Skip if so (no double-work, no false alert).
      const cur = await db.query(`SELECT status FROM jobs WHERE id = $1`, [job.id]);
      if (!cur.rows.length || cur.rows[0].status !== 'cancelled') continue;

      const cap = await SchedulingService.capacityOk(job.scheduled_at, job.duration_min, job.resource_type || 'tank');
      if (!cap.ok) {
        console.error(`🚨 [reinstate] slot RESOLD for paid booking ${bookingId} (job ${job.id}, ${cap.busy}/${cap.vans} full) — left cancelled, needs reschedule/refund`);
        await AdminAlertsService.recordSlotResold({ bookingId, jobId: job.id, slotTime: job.scheduled_at }).catch(() => {});
        continue;
      }

      if (job.assigned_team_id || job.assigned_field_team_id) {
        // Rare: an admin had already assigned this still-pending hold. The crew
        // may have been booked into an overlapping job (or gone off) during the
        // hold — resurrecting it ASSIGNED would silently double-book. Reinstate
        // UNASSIGNED so it re-enters the guarded assignment flow, and alert ops.
        await db.query(
          `UPDATE jobs SET status = 'scheduled', assigned_team_id = NULL,
                  assigned_field_team_id = NULL, updated_at = NOW()
            WHERE id = $1 AND status = 'cancelled'`,
          [job.id]
        );
        console.warn(`⚠️ [reinstate] job ${job.id} reinstated UNASSIGNED for paid booking ${bookingId} (prior crew must be re-verified)`);
        await AdminAlertsService.recordSlotResold({ bookingId, jobId: job.id, slotTime: job.scheduled_at, reason: 'reinstated_unassigned' }).catch(() => {});
      } else {
        await db.query(
          `UPDATE jobs SET status = 'scheduled', updated_at = NOW() WHERE id = $1 AND status = 'cancelled'`,
          [job.id]
        );
        console.log(`✅ [reinstate] job ${job.id} reinstated for paid booking ${bookingId} (slot still open, ${cap.busy}/${cap.vans})`);
      }
    } catch (e) {
      console.error(`🚨 [reinstate] capacity check failed for booking ${bookingId} (job ${job.id}) — left cancelled:`, e?.message);
      await AdminAlertsService.recordSlotResold({ bookingId, jobId: job.id, slotTime: job.scheduled_at, reason: 'capacity_check_failed' }).catch(() => {});
    } finally {
      if (release) await release().catch(() => {});
    }
  }
};

/** Notify the customer that a refund was initiated (+ booking cancelled on a
 *  full refund). Best-effort push + SMS; never blocks the refund response. */
const notifyRefundCustomer = async ({ isAmc, idVal, refundRupees, cancelled }) => {
  try {
    const q = isAmc
      ? `SELECT u.id, u.name, u.phone, u.fcm_token FROM amc_contracts c JOIN users u ON u.id = c.customer_id WHERE c.id = $1`
      : `SELECT u.id, u.name, u.phone, u.fcm_token FROM bookings b JOIN users u ON u.id = b.customer_id WHERE b.id = $1`;
    const { rows } = await db.query(q, [idVal]);
    if (!rows.length) return;
    const c = rows[0];
    await NotificationService.onRefundInitiated(
      { id: c.id, name: c.name, phone: c.phone, fcm_token: c.fcm_token },
      { amountRupees: refundRupees, cancelled, bookingId: isAmc ? null : idVal }
    );
  } catch (e) { console.warn('[refund] customer notify failed:', e?.message); }
};

/** Issue a GST invoice on payment success — fire-and-forget, never blocks. */
const issueBookingInvoice = (bookingId, result) =>
  InvoiceService.createInvoiceForBooking(bookingId, {
    gateway: result?.gateway, payment_ref: result?.payment_id,
  }).catch((e) => console.error('[invoice] booking invoice failed:', e?.message));

const issueAmcInvoice = (contractId, result) =>
  InvoiceService.createInvoiceForAmc(contractId, {
    gateway: result?.gateway, payment_ref: result?.payment_id,
  }).catch((e) => console.error('[invoice] AMC invoice failed:', e?.message));

/** Customer contact details for gateways that need them (Easebuzz). */
const customerForUser = async (userId) => {
  try {
    const { rows } = await db.query(
      `SELECT name, phone, email FROM users WHERE id = $1`, [userId]
    );
    return rows[0] || {};
  } catch { return {}; }
};

/**
 * TEST-ONLY charge override. When PAYMENT_TEST_AMOUNT_PAISE is set (e.g. 100 for
 * a ₹1 smoke test) the gateway is charged that amount instead of the real one.
 * The booking/contract amount and the GST invoice are UNCHANGED — this only
 * affects what the gateway captures. Leave the env var UNSET in production.
 */
const chargeAmountPaise = (realPaise) => {
  const t = Number(process.env.PAYMENT_TEST_AMOUNT_PAISE);
  if (Number.isFinite(t) && t > 0) {
    console.warn(`⚠️  [PAYMENT_TEST_AMOUNT] charging ₹${t / 100} instead of ₹${realPaise / 100} (test override)`);
    return t;
  }
  return realPaise;
};

/** Booking payments can carry an AMC-at-checkout purchase — activate it. */
const activateLinkedAmc = async (booking, paymentRefs) => {
  if (!booking?.amc_contract_id) return;
  try {
    await AmcRepository.updatePayment(booking.amc_contract_id, {
      razorpay_order_id: paymentRefs.order_id || null,
      razorpay_payment_id: paymentRefs.payment_id || null,
      payment_status: 'paid',
    });
    await AmcRepository.updateStatus(booking.amc_contract_id, 'active');
    console.log(`✅ [AMC] Contract ${booking.amc_contract_id} activated via booking ${booking.id} (visit 1 = this service)`);
  } catch (e) {
    console.error('[AMC] checkout-upsell activation failed:', e?.message);
  }
};

/**
 * Settle a booking or AMC contract from a captured payment's order id.
 * gateway defaults to 'razorpay' but is passed through for PayU/Easebuzz callbacks.
 * The pending->paid flip is done as an ATOMIC conditional UPDATE so two
 * concurrent captures (e.g. payment.captured + order.paid) can't both run the
 * side-effects — only the row-modifying update proceeds.
 */
const settleByOrderId = async (orderId, paymentId, gateway = 'razorpay') => {
  if (!orderId) return;
  // Atomically claim the booking (only the transition off 'paid' wins).
  const b = await db.query(
    `UPDATE bookings
        SET razorpay_payment_id = COALESCE($2, razorpay_payment_id),
            payment_status = 'paid', updated_at = NOW()
      WHERE razorpay_order_id = $1 AND payment_status <> 'paid'
      RETURNING id, amc_contract_id`,
    [orderId, paymentId]
  );
  if (b.rows.length) {
    await BookingRepository.updateStatus(b.rows[0].id, 'confirmed');
    // If the hold-sweep had already cancelled the holding job (payment landed
    // late), reinstate it — but ONLY if the slot still has capacity. A resold
    // slot is left cancelled + flagged for reschedule/refund (no double-commit).
    await reinstateHoldingJobs(b.rows[0].id).catch((e) => console.warn('[reinstate] settle path:', e?.message));
    await activateLinkedAmc({ id: b.rows[0].id, amc_contract_id: b.rows[0].amc_contract_id },
      { order_id: orderId, payment_id: paymentId });
    PaymentLedger.markCaptured(orderId, { paymentId, gateway });
    issueBookingInvoice(b.rows[0].id, { gateway, payment_id: paymentId });
    console.log(`✅ [gw:${gateway}] booking ${b.rows[0].id} settled via capture`);
    return;
  }
  // A booking exists for this order but was already paid → nothing to do.
  const already = await db.query(`SELECT 1 FROM bookings WHERE razorpay_order_id = $1 LIMIT 1`, [orderId]);
  if (already.rows.length) return;

  // Otherwise try an AMC contract with the same atomic guard.
  const c = await db.query(
    `UPDATE amc_contracts
        SET razorpay_payment_id = COALESCE($2, razorpay_payment_id),
            payment_status = 'paid', updated_at = NOW()
      WHERE razorpay_order_id = $1 AND payment_status <> 'paid'
      RETURNING id`,
    [orderId, paymentId]
  );
  if (c.rows.length) {
    await AmcRepository.updateStatus(c.rows[0].id, 'active');
    PaymentLedger.markCaptured(orderId, { paymentId, gateway });
    issueAmcInvoice(c.rows[0].id, { gateway, payment_id: paymentId });
    console.log(`✅ [gw:${gateway}] AMC ${c.rows[0].id} settled via capture`);
  }
};

/** Dispatch a verified Razorpay webhook event. */
const handleRazorpayEvent = async (evt) => {
  switch (evt?.event) {
    case 'payment.captured':
    case 'order.paid': {
      const pay = evt?.payload?.payment?.entity || {};
      await settleByOrderId(pay.order_id, pay.id);
      break;
    }
    case 'payment.failed': {
      const pay = evt?.payload?.payment?.entity || {};
      console.warn(`[webhook] payment.failed for order ${pay.order_id} (${pay.error_description || 'no reason'})`);
      break;
    }
    default:
      // Other events (refund.processed, etc.) are stored for audit; no action.
      break;
  }
};

/**
 * Verify + settle a PayU surl/furl POST. Shared by the mobile (postMessage) and
 * web (302 redirect) callbacks. Returns the resolved status + what it settled.
 */
const settlePayuFromCallback = async (p) => {
  let settled = false, bookingId = null, contractId = null;
  try {
    const result = PaymentService.verifyPayment({ ...p, gateway: 'payu' });
    // Defense-in-depth amount check: the reverse hash already binds `amount`, but
    // independently refuse to settle if the captured amount is below what we
    // recorded for this order. The configured ₹1 test override is whitelisted.
    const amt = await db.query(
      `SELECT amount_paise FROM (
         SELECT amount_paise FROM bookings      WHERE razorpay_order_id = $1
         UNION ALL
         SELECT amount_paise FROM amc_contracts WHERE razorpay_order_id = $1
       ) u LIMIT 1`, [p.txnid]
    );
    const expectedPaise = amt.rows.length ? Number(amt.rows[0].amount_paise) : null;
    const capturedPaise = Math.round(Number(p.amount) * 100);
    const testPaise = Number(process.env.PAYMENT_TEST_AMOUNT_PAISE);
    const testOk = Number.isFinite(testPaise) && testPaise > 0 && capturedPaise === testPaise;
    if (expectedPaise != null && Number.isFinite(capturedPaise) && capturedPaise < expectedPaise && !testOk) {
      console.error(`🚨 [payu] amount mismatch for ${p.txnid}: captured ₹${capturedPaise / 100} < expected ₹${expectedPaise / 100} — refusing to settle`);
      PaymentLedger.markFailed(p.txnid, `amount mismatch: captured ${capturedPaise} < expected ${expectedPaise}`);
      return { status: 'failure', bookingId: null, contractId: null };
    }
    // txnid was saved as the order id on the booking/contract at order time.
    await settleByOrderId(p.txnid, result.payment_id, 'payu');
    const b = await db.query(`SELECT id, payment_status FROM bookings WHERE razorpay_order_id = $1 LIMIT 1`, [p.txnid]);
    if (b.rows.length) {
      bookingId = b.rows[0].id;
      settled = b.rows[0].payment_status === 'paid';
    } else {
      const c = await db.query(`SELECT id, payment_status FROM amc_contracts WHERE razorpay_order_id = $1 LIMIT 1`, [p.txnid]);
      if (c.rows.length) { contractId = c.rows[0].id; settled = c.rows[0].payment_status === 'paid'; }
    }
  } catch (e) {
    console.warn('[payu] callback verify failed:', e?.message);
  }
  const status = settled ? 'success' : String(p.status || 'failure').toLowerCase();
  if (status !== 'success') PaymentLedger.markFailed(p.txnid, `callback ${p.status || 'unknown'}`);
  return { status, bookingId, contractId };
};

/**
 * Allowlist of permitted web-return bases. Set APP_WEB_URLS to a comma-separated
 * list (first entry is the default), e.g.
 *   APP_WEB_URLS=https://app.ozonewash.in,http://localhost:8081
 * so prod redirects to prod and local testing redirects to localhost. Falls back
 * to the single APP_WEB_URL for backwards-compat.
 */
const webReturnBases = () =>
  (process.env.APP_WEB_URLS || process.env.APP_WEB_URL || '')
    .split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);

/** Pick a return base from a client-supplied candidate, but ONLY if it's on the
 *  allowlist (prevents open-redirect). Otherwise use the default (first) base. */
const pickWebBase = (candidate) => {
  const bases = webReturnBases();
  const c = String(candidate || '').trim().replace(/\/+$/, '');
  return bases.includes(c) ? c : (bases[0] || '');
};

/** Web-app return URL (allowlisted base + result query). '' when none configured.
 *  `rt` is the initiating origin echoed back via the surl — validated here so a
 *  client can only ever be redirected to a base the server explicitly allows. */
const buildWebReturnUrl = (status, bookingId, contractId, txnid, rt) => {
  const webBase = pickWebBase(rt);
  if (!webBase) return '';
  const qs = new URLSearchParams({ ozw_payment: status });
  if (bookingId) qs.set('booking_id', bookingId);
  if (contractId) qs.set('contract_id', contractId);
  if (txnid) qs.set('txnid', txnid);
  return `${webBase}/?${qs.toString()}`;
};

/** In-app (mobile WebView) return sentinel on APP_URL. The RN WebView intercepts
 *  this navigation via onShouldStartLoadWithRequest (it never actually loads) and
 *  routes in-app — reliable even when the callback's postMessage is dropped. */
const buildAppReturnUrl = (status, bookingId, contractId, txnid) => {
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  const qs = new URLSearchParams({ ozw_payment: status });
  if (bookingId) qs.set('booking_id', bookingId);
  if (contractId) qs.set('contract_id', contractId);
  if (txnid) qs.set('txnid', txnid);
  return `${base}/payu-app-return?${qs.toString()}`;
};

const PaymentController = {

  // POST /api/v1/payments/create-order
  createOrder: async (req, res, next) => {
    try {
      const { booking_id } = req.body;
      if (!booking_id) {
        return sendError(res, 'Booking ID is required', 400);
      }

      const booking = await BookingRepository.findById(booking_id);
      if (!booking) {
        return sendError(res, 'Booking not found', 404);
      }
      if (booking.customer_id !== req.user.id) {
        return sendError(res, 'Access denied', 403);
      }
      if (booking.payment_status === 'paid') {
        return sendError(res, 'Booking is already paid', 400);
      }

      const customer = await customerForUser(req.user.id);
      const order = await PaymentService.createOrder(
        chargeAmountPaise(booking.amount_paise), booking_id, customer,
        { channel: req.body.channel, returnBase: req.headers.origin });

      await BookingRepository.updatePayment(booking_id, {
        razorpay_order_id: order.order_id,
        razorpay_payment_id: null,
        payment_status: 'pending',
      });
      PaymentLedger.recordCreated({
        userId: req.user.id, bookingId: booking_id, orderId: order.order_id,
        // Ledger records the ACTUAL amount charged at the gateway (the money that
        // really moves) — equals booking.amount_paise in prod, or the ₹1 test
        // override in sandbox. The booking/invoice keep the full service price.
        amountPaise: chargeAmountPaise(booking.amount_paise), method: booking.payment_method, gateway: order.gateway,
      });

      return sendSuccess(res, {
        gateway: order.gateway,
        order_id: order.order_id,
        amount: order.amount,
        currency: order.currency,
        booking_id,
        // Payment-hold expiry — the van slot is reserved until this instant
        // (booking created_at + 5 min). The app shows a countdown to it; the
        // sweep releases the hold if it lapses. Null for COD / ₹0 (no hold).
        hold_expires_at: booking.status === 'pending'
          ? new Date(new Date(booking.created_at).getTime() + 5 * 60 * 1000).toISOString()
          : null,
        // Razorpay checkout SDK needs the key; Easebuzz needs the hosted URL;
        // PayU needs the signed form params to POST to payment_url.
        key_id: order.key_id || null,
        payment_url: order.payment_url || null,
        access_key: order.access_key || null,
        payment_params: order.payment_params || null,
      }, 'Payment order created');
    } catch (err) {
      next(err);
    }
  },

  // POST /api/v1/payments/verify
  // Accepts razorpay fields ({ razorpay_order_id, razorpay_payment_id,
  // razorpay_signature }) OR the Easebuzz response payload ({ txnid, status,
  // hash, easepayid, ... }) — the service auto-detects the gateway.
  verifyPayment: async (req, res, next) => {
    try {
      const { booking_id } = req.body;
      if (!booking_id) {
        return sendError(res, 'Missing booking_id', 400);
      }

      // Load + authorize BEFORE trusting the payload. The Razorpay signature only
      // proves the (order_id,payment_id) pair is genuine — it does NOT bind that
      // payment to this booking. Without these guards a customer could replay a
      // valid signature from a cheap order to settle any expensive booking.
      const existing = await BookingRepository.findById(booking_id);
      if (!existing) return sendError(res, 'Booking not found', 404);
      if (existing.customer_id !== req.user.id) return sendError(res, 'Access denied', 403);
      if (existing.payment_status === 'paid') {
        return sendSuccess(res, { payment_status: 'paid', booking_id }, 'Booking already paid');
      }
      if (existing.payment_status !== 'pending') {
        return sendError(res, 'Booking is not awaiting payment', 400);
      }

      const result = PaymentService.verifyPayment(req.body);

      // Bind the verified payment to THIS booking: the signed order id must equal
      // the order created for this booking at create-order time.
      const providedOrderId = req.body.razorpay_order_id || req.body.txnid || null;
      if (!existing.razorpay_order_id || !providedOrderId || existing.razorpay_order_id !== providedOrderId) {
        return sendError(res, 'Payment does not match this booking', 400);
      }

      const booking = await BookingRepository.updatePayment(booking_id, {
        razorpay_order_id: providedOrderId,
        razorpay_payment_id: result.payment_id || null,
        payment_status: 'paid',
      });

      await BookingRepository.updateStatus(booking_id, 'confirmed');
      // Reinstate the holding job if the sweep cancelled it (late payment) —
      // capacity-checked so a resold slot isn't silently double-committed.
      await reinstateHoldingJobs(booking_id).catch((e) => console.warn('[reinstate] verify path:', e?.message));
      PaymentLedger.markCaptured(providedOrderId, { paymentId: result.payment_id, gateway: result.gateway });

      // AMC purchased at checkout → activate; this booking = visit #1 of the plan.
      await activateLinkedAmc(booking, { order_id: providedOrderId, payment_id: result.payment_id });

      const customer = { phone: booking.customer_phone, fcm_token: null };
      NotificationService.onPaymentConfirmed(customer, booking).catch(() => {});

      // GST tax invoice (covers the linked AMC too when purchased at checkout).
      issueBookingInvoice(booking_id, result);

      return sendSuccess(res, {
        payment_status: 'paid',
        gateway: result.gateway,
        booking_id,
      }, 'Payment verified successfully');
    } catch (err) {
      if (err?.status) return sendError(res, err.message, err.status);
      next(err);
    }
  },

  // POST /api/v1/payments/easebuzz/callback
  // Easebuzz surl/furl target (form-encoded POST from their checkout). Renders
  // a tiny page that relays the payload to the app's WebView via postMessage.
  // Also settles the booking/contract server-side so payment is captured even
  // if the WebView is closed before the relay.
  easebuzzCallback: async (req, res) => {
    const p = req.body || {};
    let settled = false;
    try {
      const result = PaymentService.verifyPayment({ ...p, gateway: 'easebuzz' });
      // txnid was saved as the order id on the booking/contract at order time.
      const { rows } = await db.query(
        `SELECT id, amc_contract_id FROM bookings WHERE razorpay_order_id = $1 LIMIT 1`, [p.txnid]
      );
      if (rows.length) {
        const booking = await BookingRepository.updatePayment(rows[0].id, {
          razorpay_order_id: p.txnid,
          razorpay_payment_id: result.payment_id,
          payment_status: 'paid',
        });
        await BookingRepository.updateStatus(rows[0].id, 'confirmed');
        // Same capacity-checked reinstate as the verify / PayU / Razorpay paths —
        // a late Easebuzz settle must not strand a paid booking with a cancelled
        // job (invisible to the crew) or silently overbook a resold slot.
        await reinstateHoldingJobs(rows[0].id).catch((e) => console.warn('[reinstate] easebuzz path:', e?.message));
        await activateLinkedAmc(booking, { order_id: p.txnid, payment_id: result.payment_id });
        issueBookingInvoice(rows[0].id, result);
        settled = true;
      } else {
        const amc = await db.query(
          `SELECT id FROM amc_contracts WHERE razorpay_order_id = $1 LIMIT 1`, [p.txnid]
        );
        if (amc.rows.length) {
          await AmcRepository.updatePayment(amc.rows[0].id, {
            razorpay_order_id: p.txnid,
            razorpay_payment_id: result.payment_id,
            payment_status: 'paid',
          });
          await AmcRepository.updateStatus(amc.rows[0].id, 'active');
          issueAmcInvoice(amc.rows[0].id, result);
          settled = true;
        }
      }
    } catch (e) {
      console.warn('[easebuzz] callback verify failed:', e?.message);
    }

    const status = settled ? 'success' : (String(p.status || 'failed').toLowerCase());
    const payload = JSON.stringify({ source: 'easebuzz', status, txnid: p.txnid || null });
    res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><body style="font-family:sans-serif;text-align:center;padding-top:40vh;background:#fff">
<p>${status === 'success' ? '✅ Payment successful — returning to app…' : '❌ Payment failed — returning to app…'}</p>
<script>
  var msg = ${JSON.stringify(payload)};
  if (window.ReactNativeWebView) { window.ReactNativeWebView.postMessage(msg); }
</script>
</body></html>`);
  },

  // POST /api/v1/payments/refund  (admin)
  // Body: { booking_id | contract_id, amount_paise?, reason? }
  // Omit amount_paise for a full refund of the remaining balance; pass it for a
  // partial refund. Runs inside a transaction with SELECT ... FOR UPDATE on the
  // target row so two concurrent refunds of the same booking/contract cannot
  // both call the gateway (no double-refund). Tracked in payment_refunds; the
  // row flips to 'refunded' once fully refunded, else 'partially_refunded'.
  refundPayment: async (req, res, next) => {
    const { booking_id, contract_id, amount_paise, reason } = req.body;
    if (!booking_id && !contract_id) {
      return sendError(res, 'booking_id or contract_id is required', 400);
    }
    const isAmc = !!contract_id && !booking_id;
    const table = isAmc ? 'amc_contracts' : 'bookings';   // fixed set — safe to interpolate
    const idVal = isAmc ? contract_id : booking_id;
    const label = isAmc ? 'Contract' : 'Booking';

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the row for the duration of the refund.
      const { rows } = await client.query(
        `SELECT id, amount_paise, refunded_paise, payment_status, razorpay_order_id, razorpay_payment_id
           FROM ${table} WHERE id = $1 FOR UPDATE`, [idVal]
      );
      if (!rows.length) { await client.query('ROLLBACK'); return sendError(res, `${label} not found`, 404); }
      const row = rows[0];
      if (!['paid', 'partially_refunded'].includes(row.payment_status)) {
        await client.query('ROLLBACK'); return sendError(res, `${label} is not in a refundable state`, 400);
      }

      const alreadyRefunded = Number(row.refunded_paise) || 0;
      const remaining = Number(row.amount_paise) - alreadyRefunded;
      if (remaining <= 0) { await client.query('ROLLBACK'); return sendError(res, `${label} is already fully refunded`, 400); }

      let refundAmt = amount_paise == null ? remaining : Math.floor(Number(amount_paise));
      if (!Number.isFinite(refundAmt) || refundAmt <= 0) {
        await client.query('ROLLBACK'); return sendError(res, 'amount_paise must be a positive integer', 400);
      }
      if (refundAmt > remaining) {
        await client.query('ROLLBACK'); return sendError(res, `Refund exceeds refundable balance (₹${remaining / 100})`, 400);
      }

      const oid = String(row.razorpay_order_id || '');
      const gatewayName = oid.startsWith('ozw_') ? 'easebuzz' : oid.startsWith('payu_') ? 'payu' : 'razorpay';
      // Gateway call inside the lock: on failure we ROLLBACK (no ledger row, no
      // status change) so a failed refund never half-commits.
      const refund = await PaymentService.refundPayment(row.razorpay_payment_id, refundAmt, gatewayName);

      const newRefunded = alreadyRefunded + refundAmt;
      const newStatus = newRefunded >= Number(row.amount_paise) ? 'refunded' : 'partially_refunded';

      await client.query(
        `INSERT INTO payment_refunds (booking_id, amc_contract_id, amount_paise, gateway, gateway_refund_id, reason, created_by, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'queued')`,
        [isAmc ? null : idVal, isAmc ? idVal : null, refundAmt, gatewayName, refund?.id || null, reason || null, req.user?.id || null]
      );
      await client.query(
        `UPDATE ${table} SET refunded_paise = $1, payment_status = $2, updated_at = NOW() WHERE id = $3`,
        [newRefunded, newStatus, idVal]
      );
      // Full refund → cancel the booking/contract (and its job) atomically, so a
      // fully-refunded booking is no longer serviced. Partial refunds leave it.
      if (newStatus === 'refunded') {
        if (isAmc) {
          await client.query(`UPDATE amc_contracts SET status = 'cancelled', updated_at = NOW() WHERE id = $1`, [idVal]);
        } else {
          await client.query(`UPDATE bookings SET status = 'cancelled', updated_at = NOW() WHERE id = $1`, [idVal]);
          await client.query(`UPDATE jobs SET status = 'cancelled', updated_at = NOW() WHERE booking_id = $1 AND status IN ('scheduled','in_progress')`, [idVal]);
        }
      }
      await client.query('COMMIT');

      // ── Post-commit side effects (best-effort; never roll back the refund) ──
      // Flip the order ledger row so MIS stops counting refunded gross as revenue.
      if (newStatus === 'refunded') PaymentLedger.markRefunded(oid);
      // Append the outflow lifecycle events (full timeline: initiated → …webhook…).
      PaymentLedger.recordEvent({
        bookingId: isAmc ? null : idVal, contractId: isAmc ? idVal : null,
        orderId: oid, gateway: gatewayName, eventType: 'refund_initiated', direction: 'out',
        amountPaise: refundAmt, status: 'queued', gatewayRef: refund?.id || null,
        note: reason || null, createdBy: req.user?.id || null,
      });
      if (newStatus === 'refunded') {
        PaymentLedger.recordEvent({
          bookingId: isAmc ? null : idVal, contractId: isAmc ? idVal : null,
          orderId: oid, gateway: gatewayName, eventType: 'booking_cancelled',
          direction: 'neutral', note: 'auto-cancel on full refund', createdBy: req.user?.id || null,
        });
      }
      // Tell the customer: refund initiated (+ booking cancelled on full refund).
      notifyRefundCustomer({ isAmc, idVal, refundRupees: refundAmt / 100, cancelled: newStatus === 'refunded' });

      return sendSuccess(res, {
        refund,
        refunded_paise: newRefunded,
        remaining_paise: Number(row.amount_paise) - newRefunded,
        payment_status: newStatus,
        refund_status: 'queued',
        booking_status: newStatus === 'refunded' ? 'cancelled' : undefined,
      }, newStatus === 'refunded' ? 'Full refund initiated · booking cancelled' : 'Partial refund initiated');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      if (err?.status) return sendError(res, err.message, err.status);
      next(err);
    } finally {
      client.release();
    }
  },

  // POST /api/v1/payments/refund/close  (admin)
  // Body: { booking_id | contract_id, note? }
  // Close a refund case at whatever has ALREADY been refunded — the remaining
  // refundable balance is treated as SETTLED (waived), no gateway call, no more
  // money movement. Flips payment_status to 'refunded' (settled) and clears any
  // in-flight refund rows. Use when admin agrees a partial refund fully settles
  // the account.
  closeRefundCase: async (req, res, next) => {
    try {
      const { booking_id, contract_id, note } = req.body || {};
      if (!booking_id && !contract_id) return sendError(res, 'booking_id or contract_id is required', 400);
      const isAmc = !!contract_id && !booking_id;
      const table = isAmc ? 'amc_contracts' : 'bookings';   // fixed set — safe to interpolate
      const idVal = isAmc ? contract_id : booking_id;
      const label = isAmc ? 'Contract' : 'Booking';

      const { rows } = await db.query(
        `SELECT id, amount_paise, refunded_paise, payment_status, razorpay_order_id FROM ${table} WHERE id = $1`, [idVal]);
      if (!rows.length) return sendError(res, `${label} not found`, 404);
      const row = rows[0];
      if (!['paid', 'partially_refunded'].includes(row.payment_status)) {
        return sendError(res, `${label} is already '${row.payment_status}' — nothing to settle.`, 400);
      }
      const refunded = Number(row.refunded_paise) || 0;
      const settledBalance = Math.max(0, Number(row.amount_paise) - refunded);

      // Mark the account settled (closed). Keep refunded_paise as the real amount.
      await db.query(`UPDATE ${table} SET payment_status = 'refunded', updated_at = NOW() WHERE id = $1`, [idVal]);
      // Any in-flight refund rows are now considered settled.
      await db.query(
        `UPDATE payment_refunds SET status = 'processed', processed_at = COALESCE(processed_at, NOW())
          WHERE ${isAmc ? 'amc_contract_id' : 'booking_id'} = $1 AND status IN ('initiated','queued','processing')`,
        [idVal]);

      PaymentLedger.markRefunded(String(row.razorpay_order_id || ''));
      PaymentLedger.recordEvent({
        bookingId: isAmc ? null : idVal, contractId: isAmc ? idVal : null,
        orderId: row.razorpay_order_id, eventType: 'refund_settled', direction: 'neutral',
        amountPaise: refunded, status: 'settled',
        note: note || `Case closed — refunded ₹${refunded / 100} of ₹${Number(row.amount_paise) / 100}; ₹${settledBalance / 100} balance settled`,
        createdBy: req.user?.id || null,
      });

      return sendSuccess(res, {
        payment_status: 'refunded',
        refunded_paise: refunded,
        settled_balance_paise: settledBalance,
        refund_status: 'processed',
      }, `Case closed — ₹${refunded / 100} refunded, ₹${settledBalance / 100} balance settled.`);
    } catch (err) {
      if (err?.status) return sendError(res, err.message, err.status);
      next(err);
    }
  },

  // POST /api/v1/payments/payu/callback  (no auth — hash-verified)
  // PayU surl/furl target (form POST from the hosted checkout). Verifies the
  // reverse hash, settles the booking/contract server-side (idempotent, atomic),
  // and relays the result to the app WebView via postMessage.
  payuCallback: async (req, res) => {
    const p = req.body || {};
    const { status, bookingId, contractId } = await settlePayuFromCallback(p);
    const payload = JSON.stringify({ source: 'payu', status, txnid: p.txnid || null, booking_id: bookingId, contract_id: contractId });
    const appReturn = buildAppReturnUrl(status, bookingId, contractId, p.txnid);
    res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><body style="font-family:sans-serif;text-align:center;padding-top:40vh;background:#fff">
<p>${status === 'success' ? '✅ Payment successful — returning to app…' : '❌ Payment failed — returning to app…'}</p>
<script>
  var msg = ${JSON.stringify(payload)};
  // Fast path: notify the RN layer directly.
  if (window.ReactNativeWebView) { try { window.ReactNativeWebView.postMessage(msg); } catch (e) {} }
  // Reliable path: navigate to the in-app return sentinel. The RN WebView
  // intercepts this (onShouldStartLoadWithRequest) and routes in-app — so the
  // payment completes even when postMessage is dropped (Android WebView quirk).
  setTimeout(function(){ window.location.replace(${JSON.stringify(appReturn)}); }, 400);
</script>
</body></html>`);
  },

  // POST /api/v1/payments/payu/callback/web  (no auth — reverse-hash-verified)
  // Web checkout is a full-page redirect, so there is no RN WebView to postMessage
  // to. Settle exactly like the mobile callback, then issue a real server-side
  // HTTP 302 back to the web app. The redirect target (APP_WEB_URL) is set on the
  // SERVER, so a client can't influence where the browser lands.
  payuCallbackWeb: async (req, res) => {
    const p = req.body || {};
    const { status, bookingId, contractId } = await settlePayuFromCallback(p);
    const webReturn = buildWebReturnUrl(status, bookingId, contractId, p.txnid, req.query.rt);
    if (webReturn) return res.redirect(302, webReturn);
    // APP_WEB_URL not configured — show a minimal static confirmation instead.
    return res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><body style="font-family:sans-serif;text-align:center;padding-top:40vh;background:#fff">
<p>${status === 'success' ? '✅ Payment successful. You can return to the app.' : '❌ Payment failed. Please return to the app and retry.'}</p>
</body></html>`);
  },

  // POST /api/v1/payments/payu/webhook  (no auth — reverse-hash-verified, S2S)
  // PayU server-to-server webhook. Fires directly from PayU on payment events,
  // INDEPENDENT of the browser/WebView surl/furl callback — so a captured payment
  // still settles even if the app was killed before the browser callback landed
  // (closes the Android-WebView "money taken, no booking" gap). Configure this URL
  // in PayU Dashboard → Developers → Webhooks (a SEPARATE one for TEST and LIVE).
  // Idempotent: a re-delivery and a racing browser callback settle at most once.
  payuWebhook: async (req, res) => {
    const p = req.body || {};
    console.log('[payu webhook]', JSON.stringify({ txnid: p.txnid, mihpayid: p.mihpayid, status: p.status, amount: p.amount, event: p.event || p.eventType }));

    // PayU verifies a new webhook URL with a dummy POST carrying no txnid — ack it.
    if (!p.txnid) return res.status(200).json({ received: true });

    // Dedup on txnid+status (webhooks can be re-delivered). Settlement is atomic +
    // idempotent regardless, so this is an optimization, not the safety net.
    const eventId = `${p.txnid}_${String(p.status || '').toLowerCase()}`;
    try {
      const seen = await db.query(`SELECT 1 FROM webhook_events WHERE gateway='payu' AND event_id=$1 LIMIT 1`, [eventId]);
      if (seen.rows.length) return res.status(200).json({ received: true, deduped: true });
    } catch (_) { /* fall through — settlement is idempotent anyway */ }

    // Verify the reverse hash + settle (shared with the browser callback path).
    const { status } = await settlePayuFromCallback(p);

    // If PayU reports success but we couldn't settle (transient DB error, or a
    // salt/config mismatch), return 5xx so PayU RETRIES — do NOT record the event.
    if (String(p.status || '').toLowerCase() === 'success' && status !== 'success') {
      console.error(`[payu webhook] success event ${p.txnid} did not settle — asking PayU to retry`);
      return res.status(500).json({ received: false });
    }

    try {
      await db.query(
        `INSERT INTO webhook_events (gateway, event_id, event_type, payload)
         VALUES ('payu', $1, $2, $3) ON CONFLICT (gateway, event_id) DO NOTHING`,
        [eventId, String(p.status || '').toLowerCase(), JSON.stringify(p)]
      );
    } catch (e) { console.warn('[payu webhook] could not record event:', e?.message); }

    return res.status(200).json({ received: true });
  },

  // POST /api/v1/payments/webhook/razorpay  (no auth — signature-verified)
  // Belt-and-suspenders settlement: even if the app closes mid-checkout, the
  // captured payment settles the booking/AMC and issues the invoice.
  razorpayWebhook: async (req, res) => {
    const razorpay = require('../../services/gateways/razorpay.gateway');
    const signature = req.headers['x-razorpay-signature'];
    const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    if (!razorpay.verifyWebhookSignature(raw, signature)) {
      return res.status(400).json({ success: false, message: 'Invalid webhook signature' });
    }

    const evt = req.body || {};
    const eventId = req.headers['x-razorpay-event-id'] || `${evt.event}_${evt.created_at || ''}`;

    // Fast-path dedup: if this event was already fully processed, ack 200.
    try {
      const seen = await db.query(
        `SELECT 1 FROM webhook_events WHERE gateway='razorpay' AND event_id=$1 LIMIT 1`, [String(eventId)]
      );
      if (seen.rows.length) return res.status(200).json({ success: true, deduped: true });
    } catch (_) { /* fall through — settlement below is idempotent anyway */ }

    // Process FIRST. Settlement (atomic paid-guard) + invoicing (unique index)
    // are idempotent, so re-processing a redelivery is safe. If processing
    // throws, return 5xx so Razorpay RETRIES — do NOT mark the event processed.
    try {
      await handleRazorpayEvent(evt);
    } catch (e) {
      console.error('[webhook] handler error — asking gateway to retry:', e?.message);
      return res.status(500).json({ success: false, message: 'Processing failed; please retry' });
    }

    // Record as processed only after success (best-effort; dedup is an optimization).
    try {
      await db.query(
        `INSERT INTO webhook_events (gateway, event_id, event_type, payload)
         VALUES ('razorpay', $1, $2, $3) ON CONFLICT (gateway, event_id) DO NOTHING`,
        [String(eventId), evt.event || null, JSON.stringify(evt)]
      );
    } catch (e) {
      console.warn('[webhook] could not record processed event:', e?.message);
    }
    return res.status(200).json({ success: true });
  },

  // POST /api/v1/payments/payu/refund-webhook  (no auth — PayU S2S)
  // Fires when a refund changes state. Best-effort + idempotent: it only ever
  // UPDATES an existing refund row's status + timeline and notifies the customer
  // when the money is actually credited. No money movement here, so it can't
  // over-refund. Field mapping is defensive across PayU's refund payload shapes.
  payuRefundWebhook: async (req, res) => {
    const p = req.body || {};
    const refId = String(p.request_id || p.requestId || p.token_id || p.refund_id || p.mihpayid || '').trim();
    const rawStatus = String(p.status || p.refund_status || p.refundStatus || p.action_status || '').toLowerCase();
    console.log('[payu refund webhook]', JSON.stringify({ mihpayid: p.mihpayid, refId, status: rawStatus, amount: p.refund_amount || p.amount }));
    if (!refId) return res.status(200).json({ received: true }); // verification ping

    const eventId = `refund_${refId}_${rawStatus || 'update'}`;
    try {
      const seen = await db.query(`SELECT 1 FROM webhook_events WHERE gateway='payu' AND event_id=$1 LIMIT 1`, [eventId]);
      if (seen.rows.length) return res.status(200).json({ received: true, deduped: true });
    } catch (_) { /* dedup is an optimization */ }

    const failed = /fail|reject|error|declin/.test(rawStatus);
    const done = !failed && /success|refunded|processed|settled|complete|paid/.test(rawStatus);
    const newStatus = failed ? 'failed' : (done ? 'processed' : 'processing');

    // Match our refund row by the stored gateway_refund_id, else by mihpayid → booking.
    let rf = null;
    try {
      const q1 = await db.query(
        `SELECT id, booking_id, amc_contract_id, amount_paise FROM payment_refunds
          WHERE gateway_refund_id = $1 ORDER BY created_at DESC LIMIT 1`, [refId]);
      rf = q1.rows[0] || null;
      if (!rf && p.mihpayid) {
        const q2 = await db.query(
          `SELECT r.id, r.booking_id, r.amc_contract_id, r.amount_paise
             FROM payment_refunds r JOIN bookings b ON b.id = r.booking_id
            WHERE b.razorpay_payment_id = $1 ORDER BY r.created_at DESC LIMIT 1`, [String(p.mihpayid)]);
        rf = q2.rows[0] || null;
      }
    } catch (e) { console.warn('[payu refund webhook] lookup failed:', e?.message); }

    if (rf) {
      const settle = newStatus === 'processed' || newStatus === 'failed';
      try {
        // NB: keep `status` as the only use of its param — reusing one param as
        // both a varchar value and inside an IN(...) list makes Postgres throw
        // "inconsistent types deduced for parameter". Gate processed_at with a
        // separate boolean param instead.
        await db.query(
          `UPDATE payment_refunds
              SET status = $1,
                  processed_at = CASE WHEN $2 THEN NOW() ELSE processed_at END
            WHERE id = $3`, [newStatus, settle, rf.id]);
      } catch (e) { console.warn('[payu refund webhook] status update failed:', e?.message); }
      PaymentLedger.recordEvent({
        bookingId: rf.booking_id, contractId: rf.amc_contract_id, gateway: 'payu',
        eventType: failed ? 'refund_failed' : (done ? 'refund_processed' : 'refund_processing'),
        direction: 'out', amountPaise: rf.amount_paise, status: newStatus, gatewayRef: refId,
        metadata: { via: 'webhook', raw_status: rawStatus },
      });
      if (done) {
        try {
          const { rows } = await db.query(
            rf.amc_contract_id
              ? `SELECT u.id, u.name, u.phone, u.fcm_token FROM amc_contracts c JOIN users u ON u.id = c.customer_id WHERE c.id = $1`
              : `SELECT u.id, u.name, u.phone, u.fcm_token FROM bookings b JOIN users u ON u.id = b.customer_id WHERE b.id = $1`,
            [rf.amc_contract_id || rf.booking_id]);
          if (rows[0]) {
            NotificationService.onRefundCompleted(
              { id: rows[0].id, name: rows[0].name, phone: rows[0].phone, fcm_token: rows[0].fcm_token },
              { amountRupees: (rf.amount_paise || 0) / 100, bookingId: rf.booking_id }
            ).catch(() => {});
          }
        } catch (_) {}
      }
    } else {
      console.warn('[payu refund webhook] no matching refund row for', refId);
    }

    try {
      await db.query(
        `INSERT INTO webhook_events (gateway, event_id, event_type, payload)
         VALUES ('payu', $1, $2, $3) ON CONFLICT (gateway, event_id) DO NOTHING`,
        [eventId, `refund_${rawStatus || 'update'}`, JSON.stringify(p)]);
    } catch (e) { console.warn('[payu refund webhook] record failed:', e?.message); }
    return res.status(200).json({ received: true });
  },

  // POST /api/v1/payments/amc/create-order
  createAmcOrder: async (req, res, next) => {
    try {
      const { contract_id } = req.body;
      if (!contract_id) {
        return sendError(res, 'Contract ID is required', 400);
      }

      const contract = await AmcRepository.findById(contract_id);
      if (!contract) {
        return sendError(res, 'Contract not found', 404);
      }
      if (contract.customer_id !== req.user.id) {
        return sendError(res, 'Access denied', 403);
      }
      if (contract.payment_status === 'paid') {
        return sendError(res, 'Contract is already paid', 400);
      }

      const customer = await customerForUser(req.user.id);
      const order = await PaymentService.createOrder(
        chargeAmountPaise(contract.amount_paise), contract_id, customer,
        { channel: req.body.channel, returnBase: req.headers.origin });

      await AmcRepository.updatePayment(contract_id, {
        razorpay_order_id: order.order_id,
        razorpay_payment_id: null,
        payment_status: 'pending',
      });
      PaymentLedger.recordCreated({
        userId: req.user.id, contractId: contract_id, orderId: order.order_id,
        // Actual charged amount (real money moved) — see createOrder note.
        amountPaise: chargeAmountPaise(contract.amount_paise), method: 'amc', gateway: order.gateway,
      });

      return sendSuccess(res, {
        gateway: order.gateway,
        order_id: order.order_id,
        amount: order.amount,
        currency: order.currency,
        contract_id,
        key_id: order.key_id || null,
        payment_url: order.payment_url || null,
        access_key: order.access_key || null,
        payment_params: order.payment_params || null,
      }, 'AMC payment order created');
    } catch (err) {
      next(err);
    }
  },

  // POST /api/v1/payments/amc/verify
  verifyAmcPayment: async (req, res, next) => {
    try {
      const { contract_id } = req.body;
      if (!contract_id) {
        return sendError(res, 'Missing contract_id', 400);
      }

      // Authorize + bind before trusting the signature (see verifyPayment).
      const existing = await AmcRepository.findById(contract_id);
      if (!existing) return sendError(res, 'Contract not found', 404);
      if (existing.customer_id !== req.user.id) return sendError(res, 'Access denied', 403);
      if (existing.payment_status === 'paid') {
        return sendSuccess(res, { payment_status: 'paid', contract_id }, 'Contract already paid');
      }
      if (existing.payment_status !== 'pending') {
        return sendError(res, 'Contract is not awaiting payment', 400);
      }

      const result = PaymentService.verifyPayment(req.body);

      const providedOrderId = req.body.razorpay_order_id || req.body.txnid || null;
      if (!existing.razorpay_order_id || !providedOrderId || existing.razorpay_order_id !== providedOrderId) {
        return sendError(res, 'Payment does not match this contract', 400);
      }

      await AmcRepository.updatePayment(contract_id, {
        razorpay_order_id: providedOrderId,
        razorpay_payment_id: result.payment_id || null,
        payment_status: 'paid',
      });

      await AmcRepository.updateStatus(contract_id, 'active');

      // GST tax invoice for the standalone AMC contract.
      issueAmcInvoice(contract_id, result);

      return sendSuccess(res, {
        payment_status: 'paid',
        gateway: result.gateway,
        contract_id,
      }, 'AMC payment verified successfully');
    } catch (err) {
      if (err?.status) return sendError(res, err.message, err.status);
      next(err);
    }
  },

};

module.exports = PaymentController;
