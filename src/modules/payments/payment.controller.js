const PaymentService = require('../../services/payment.service');
const BookingRepository = require('../bookings/booking.repository');
const AmcRepository = require('../amc/amc.repository');
const NotificationService = require('../../services/notification.service');
const InvoiceService = require('../invoices/invoice.service');
const { sendSuccess, sendError } = require('../../utils/response');
const db = require('../../config/db');

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
    await activateLinkedAmc({ id: b.rows[0].id, amc_contract_id: b.rows[0].amc_contract_id },
      { order_id: orderId, payment_id: paymentId });
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
  return { status: settled ? 'success' : String(p.status || 'failure').toLowerCase(), bookingId, contractId };
};

/** Web-app return URL (APP_WEB_URL + result query). '' when APP_WEB_URL is unset. */
const buildWebReturnUrl = (status, bookingId, contractId, txnid) => {
  const webBase = (process.env.APP_WEB_URL || '').replace(/\/+$/, '');
  if (!webBase) return '';
  const qs = new URLSearchParams({ ozw_payment: status });
  if (bookingId) qs.set('booking_id', bookingId);
  if (contractId) qs.set('contract_id', contractId);
  if (txnid) qs.set('txnid', txnid);
  return `${webBase}/?${qs.toString()}`;
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
        chargeAmountPaise(booking.amount_paise), booking_id, customer, { channel: req.body.channel });

      await BookingRepository.updatePayment(booking_id, {
        razorpay_order_id: order.order_id,
        razorpay_payment_id: null,
        payment_status: 'pending',
      });

      return sendSuccess(res, {
        gateway: order.gateway,
        order_id: order.order_id,
        amount: order.amount,
        currency: order.currency,
        booking_id,
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
        `INSERT INTO payment_refunds (booking_id, amc_contract_id, amount_paise, gateway, gateway_refund_id, reason, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [isAmc ? null : idVal, isAmc ? idVal : null, refundAmt, gatewayName, refund?.id || null, reason || null, req.user?.id || null]
      );
      await client.query(
        `UPDATE ${table} SET refunded_paise = $1, payment_status = $2, updated_at = NOW() WHERE id = $3`,
        [newRefunded, newStatus, idVal]
      );
      await client.query('COMMIT');

      return sendSuccess(res, {
        refund,
        refunded_paise: newRefunded,
        remaining_paise: Number(row.amount_paise) - newRefunded,
        payment_status: newStatus,
      }, newStatus === 'refunded' ? 'Full refund initiated' : 'Partial refund initiated');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      if (err?.status) return sendError(res, err.message, err.status);
      next(err);
    } finally {
      client.release();
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

    // Mobile app WebView path: relay the result to the RN layer via postMessage.
    // A JS redirect fallback stays in case a browser ever hits this legacy
    // callback directly — but web checkout now uses /payu/callback/web (302).
    const webReturn = buildWebReturnUrl(status, bookingId, contractId, p.txnid);
    res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><body style="font-family:sans-serif;text-align:center;padding-top:40vh;background:#fff">
<p>${status === 'success' ? '✅ Payment successful — returning to app…' : '❌ Payment failed — returning to app…'}</p>
<script>
  var msg = ${JSON.stringify(payload)};
  if (window.ReactNativeWebView) {
    window.ReactNativeWebView.postMessage(msg);                 // mobile app WebView
  } else {
    var ret = ${JSON.stringify(webReturn)};
    if (ret) { window.location.replace(ret); }                  // legacy web fallback
  }
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
    const webReturn = buildWebReturnUrl(status, bookingId, contractId, p.txnid);
    if (webReturn) return res.redirect(302, webReturn);
    // APP_WEB_URL not configured — show a minimal static confirmation instead.
    return res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><body style="font-family:sans-serif;text-align:center;padding-top:40vh;background:#fff">
<p>${status === 'success' ? '✅ Payment successful. You can return to the app.' : '❌ Payment failed. Please return to the app and retry.'}</p>
</body></html>`);
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
        chargeAmountPaise(contract.amount_paise), contract_id, customer, { channel: req.body.channel });

      await AmcRepository.updatePayment(contract_id, {
        razorpay_order_id: order.order_id,
        razorpay_payment_id: null,
        payment_status: 'pending',
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
