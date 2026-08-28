/**
 * Razorpay gateway adapter.
 *
 * Configured entirely from .env — drop in real keys and it goes live:
 *   RAZORPAY_KEY_ID=rzp_live_xxxx
 *   RAZORPAY_KEY_SECRET=xxxx
 *
 * Without keys, development mode returns mock orders so the flow stays testable.
 */
const crypto = require('crypto');

const PLACEHOLDER_RE = /placeholder|^$|XXXX/i;

const isConfigured = () =>
  !!process.env.RAZORPAY_KEY_ID &&
  !!process.env.RAZORPAY_KEY_SECRET &&
  !PLACEHOLDER_RE.test(process.env.RAZORPAY_KEY_ID) &&
  !PLACEHOLDER_RE.test(process.env.RAZORPAY_KEY_SECRET);

const getClient = () => {
  const Razorpay = require('razorpay');
  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder',
    key_secret: process.env.RAZORPAY_KEY_SECRET || 'placeholder_secret',
  });
};

/** Create an order. refId = booking/contract id (used in the receipt). */
async function createOrder(amountPaise, refId /*, customer */) {
  try {
    const order = await getClient().orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: `booking_${refId}`,
      notes: { booking_id: refId, platform: 'ozone_wash' },
    });
    return {
      gateway: 'razorpay',
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      receipt: order.receipt,
      key_id: process.env.RAZORPAY_KEY_ID,
    };
  } catch (err) {
    console.error('Razorpay create order error:', err.message);
    if (process.env.NODE_ENV === 'development') {
      console.log(`💳 [PAYMENT DEV] Mock razorpay order for: ${refId} | ₹${amountPaise / 100}`);
      return {
        gateway: 'razorpay',
        order_id: `order_dev_${Date.now()}`,
        amount: amountPaise,
        currency: 'INR',
        receipt: `booking_${refId}`,
        key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder',
        dev: true,
      };
    }
    throw { status: 500, message: 'Payment order creation failed.' };
  }
}

/** Verify checkout signature: HMAC-SHA256(order_id|payment_id, key_secret). */
function verifyPayment({ razorpay_order_id, razorpay_payment_id, razorpay_signature }) {
  try {
    const secret = process.env.RAZORPAY_KEY_SECRET || 'placeholder_secret';
    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');
    if (expected !== razorpay_signature) {
      throw { status: 400, message: 'Payment verification failed. Invalid signature.' };
    }
    return { verified: true, gateway: 'razorpay', payment_id: razorpay_payment_id };
  } catch (err) {
    if (err.status) throw err;
    if (process.env.NODE_ENV === 'development') {
      console.log(`💳 [PAYMENT DEV] Mock razorpay verification: ${razorpay_order_id}`);
      return { verified: true, gateway: 'razorpay', payment_id: razorpay_payment_id, dev: true };
    }
    throw { status: 400, message: 'Payment verification failed.' };
  }
}

async function refundPayment(paymentId, amountPaise) {
  try {
    return await getClient().payments.refund(paymentId, {
      amount: amountPaise,
      notes: { reason: 'Customer requested refund' },
    });
  } catch (err) {
    console.error('Razorpay refund error:', err.message);
    if (process.env.NODE_ENV === 'development') {
      console.log(`💳 [PAYMENT DEV] Mock razorpay refund: ${paymentId}`);
      return { id: `refund_dev_${Date.now()}`, dev: true };
    }
    throw { status: 500, message: 'Refund failed.' };
  }
}

async function getPayment(paymentId) {
  try {
    return await getClient().payments.fetch(paymentId);
  } catch (err) {
    console.error('Razorpay fetch payment error:', err.message);
    throw { status: 404, message: 'Payment not found.' };
  }
}

/**
 * Verify a Razorpay webhook: HMAC-SHA256 of the RAW request body with
 * RAZORPAY_WEBHOOK_SECRET, compared to the X-Razorpay-Signature header.
 * Returns true/false (never throws). In development with no secret set, we
 * accept so the flow stays testable; in production a missing secret rejects.
 */
function verifyWebhookSignature(rawBody, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || PLACEHOLDER_RE.test(secret)) {
    return process.env.NODE_ENV === 'development';
  }
  try {
    const expected = crypto.createHmac('sha256', secret)
      .update(rawBody instanceof Buffer ? rawBody : Buffer.from(String(rawBody || '')))
      .digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

module.exports = { name: 'razorpay', isConfigured, createOrder, verifyPayment, refundPayment, getPayment, verifyWebhookSignature };
