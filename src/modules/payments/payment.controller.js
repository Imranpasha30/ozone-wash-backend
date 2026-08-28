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

/** Settle a booking or AMC contract from a captured payment's order id. */
const settleByOrderId = async (orderId, paymentId) => {
  if (!orderId) return;
  const b = await db.query(
    `SELECT id, payment_status FROM bookings WHERE razorpay_order_id = $1 LIMIT 1`, [orderId]
  );
  if (b.rows.length) {
    if (b.rows[0].payment_status === 'paid') return; // already settled by client verify
    const booking = await BookingRepository.updatePayment(b.rows[0].id, {
      razorpay_order_id: orderId, razorpay_payment_id: paymentId, payment_status: 'paid',
    });
    await BookingRepository.updateStatus(b.rows[0].id, 'confirmed');
    await activateLinkedAmc(booking, { order_id: orderId, payment_id: paymentId });
    issueBookingInvoice(b.rows[0].id, { gateway: 'razorpay', payment_id: paymentId });
    console.log(`✅ [webhook] booking ${b.rows[0].id} settled via razorpay capture`);
    return;
  }
  const c = await db.query(
    `SELECT id, payment_status FROM amc_contracts WHERE razorpay_order_id = $1 LIMIT 1`, [orderId]
  );
  if (c.rows.length) {
    if (c.rows[0].payment_status === 'paid') return;
    await AmcRepository.updatePayment(c.rows[0].id, {
      razorpay_order_id: orderId, razorpay_payment_id: paymentId, payment_status: 'paid',
    });
    await AmcRepository.updateStatus(c.rows[0].id, 'active');
    issueAmcInvoice(c.rows[0].id, { gateway: 'razorpay', payment_id: paymentId });
    console.log(`✅ [webhook] AMC ${c.rows[0].id} settled via razorpay capture`);
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
      const order = await PaymentService.createOrder(booking.amount_paise, booking_id, customer);

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
        // Razorpay checkout SDK needs the key; Easebuzz needs the hosted URL.
        key_id: order.key_id || null,
        payment_url: order.payment_url || null,
        access_key: order.access_key || null,
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

      const result = PaymentService.verifyPayment(req.body);

      const booking = await BookingRepository.updatePayment(booking_id, {
        razorpay_order_id: req.body.razorpay_order_id || req.body.txnid || null,
        razorpay_payment_id: result.payment_id || null,
        payment_status: 'paid',
      });

      await BookingRepository.updateStatus(booking_id, 'confirmed');

      // AMC purchased at checkout → activate; this booking = visit #1 of the plan.
      await activateLinkedAmc(booking, {
        order_id: req.body.razorpay_order_id || req.body.txnid,
        payment_id: result.payment_id,
      });

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
  // Body: { booking_id, amount_paise?, reason? }
  // Omit amount_paise for a full refund of the remaining balance; pass it for
  // a partial refund. Refunds are tracked in the payment_refunds ledger and the
  // booking flips to 'refunded' once fully refunded, else 'partially_refunded'.
  refundPayment: async (req, res, next) => {
    try {
      const { booking_id, amount_paise, reason } = req.body;

      const booking = await BookingRepository.findById(booking_id);
      if (!booking) return sendError(res, 'Booking not found', 404);
      if (!['paid', 'partially_refunded'].includes(booking.payment_status)) {
        return sendError(res, 'Booking is not in a refundable state', 400);
      }

      const alreadyRefunded = Number(booking.refunded_paise) || 0;
      const remaining = Number(booking.amount_paise) - alreadyRefunded;
      if (remaining <= 0) return sendError(res, 'Booking is already fully refunded', 400);

      // Default: refund whatever's left. Otherwise validate the partial amount.
      let refundAmt = amount_paise == null ? remaining : Math.floor(Number(amount_paise));
      if (!Number.isFinite(refundAmt) || refundAmt <= 0) {
        return sendError(res, 'amount_paise must be a positive integer', 400);
      }
      if (refundAmt > remaining) {
        return sendError(res, `Refund exceeds refundable balance (₹${remaining / 100})`, 400);
      }

      const gatewayName = String(booking.razorpay_order_id || '').startsWith('ozw_') ? 'easebuzz' : 'razorpay';
      const refund = await PaymentService.refundPayment(booking.razorpay_payment_id, refundAmt, gatewayName);

      const newRefunded = alreadyRefunded + refundAmt;
      const newStatus = newRefunded >= Number(booking.amount_paise) ? 'refunded' : 'partially_refunded';

      // Ledger + booking update
      await db.query(
        `INSERT INTO payment_refunds (booking_id, amount_paise, gateway, gateway_refund_id, reason, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [booking_id, refundAmt, gatewayName, refund?.id || null, reason || null, req.user?.id || null]
      );
      await db.query(
        `UPDATE bookings SET refunded_paise = $1, payment_status = $2, updated_at = NOW() WHERE id = $3`,
        [newRefunded, newStatus, booking_id]
      );

      return sendSuccess(res, {
        refund,
        refunded_paise: newRefunded,
        remaining_paise: Number(booking.amount_paise) - newRefunded,
        payment_status: newStatus,
      }, newStatus === 'refunded' ? 'Full refund initiated' : 'Partial refund initiated');
    } catch (err) {
      if (err?.status) return sendError(res, err.message, err.status);
      next(err);
    }
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
    // Idempotency: first insert wins; a redelivery is a no-op.
    try {
      const ins = await db.query(
        `INSERT INTO webhook_events (gateway, event_id, event_type, payload)
         VALUES ('razorpay', $1, $2, $3)
         ON CONFLICT (gateway, event_id) DO NOTHING RETURNING id`,
        [String(eventId), evt.event || null, JSON.stringify(evt)]
      );
      if (!ins.rows.length) return res.status(200).json({ success: true, deduped: true });
    } catch (e) {
      console.warn('[webhook] idempotency store unavailable:', e?.message);
    }

    try {
      await handleRazorpayEvent(evt);
    } catch (e) {
      console.error('[webhook] handler error:', e?.message);
    }
    // Always ack 200 once stored, so Razorpay stops retrying.
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
      const order = await PaymentService.createOrder(contract.amount_paise, contract_id, customer);

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

      const result = PaymentService.verifyPayment(req.body);

      await AmcRepository.updatePayment(contract_id, {
        razorpay_order_id: req.body.razorpay_order_id || req.body.txnid || null,
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
      next(err);
    }
  },

};

module.exports = PaymentController;
