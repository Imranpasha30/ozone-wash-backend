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

  // POST /api/v1/payments/refund
  refundPayment: async (req, res, next) => {
    try {
      const { booking_id } = req.body;

      const booking = await BookingRepository.findById(booking_id);
      if (!booking) {
        return sendError(res, 'Booking not found', 404);
      }
      if (booking.payment_status !== 'paid') {
        return sendError(res, 'Booking is not paid', 400);
      }

      const gatewayName = String(booking.razorpay_order_id || '').startsWith('ozw_') ? 'easebuzz' : 'razorpay';
      const refund = await PaymentService.refundPayment(
        booking.razorpay_payment_id,
        booking.amount_paise,
        gatewayName
      );

      await BookingRepository.updatePayment(booking_id, {
        razorpay_order_id: booking.razorpay_order_id,
        razorpay_payment_id: booking.razorpay_payment_id,
        payment_status: 'refunded',
      });

      return sendSuccess(res, { refund }, 'Refund initiated successfully');
    } catch (err) {
      next(err);
    }
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
