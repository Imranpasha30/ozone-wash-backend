/**
 * Easebuzz gateway adapter.
 *
 * Configured entirely from .env — drop in real credentials and it goes live,
 * no code changes needed:
 *   EASEBUZZ_KEY=your_merchant_key
 *   EASEBUZZ_SALT=your_merchant_salt
 *   EASEBUZZ_ENV=test          # test | prod
 *
 * Flow (Easebuzz "Initiate Payment" API):
 *   1. POST /payment/initiateLink with SHA-512 request hash
 *        hash = sha512(key|txnid|amount|productinfo|firstname|email|
 *                      udf1..udf10|salt)
 *   2. Response { status: 1, data: <access_key> }
 *      → checkout page: {base}/pay/<access_key> (rendered in the app WebView)
 *   3. Easebuzz POSTs the result to our surl/furl callback; the client also
 *      calls /payments/verify with that payload.
 *   4. Response hash verify (REVERSE order):
 *        sha512(salt|status|udf10..udf1|email|firstname|productinfo|amount|
 *               txnid|key)
 */
const crypto = require('crypto');
const axios = require('axios');

const sha512 = (s) => crypto.createHash('sha512').update(s).digest('hex');

const isConfigured = () => !!process.env.EASEBUZZ_KEY && !!process.env.EASEBUZZ_SALT;

const baseUrl = () =>
  (process.env.EASEBUZZ_ENV || 'test').toLowerCase() === 'prod'
    ? 'https://pay.easebuzz.in'
    : 'https://testpay.easebuzz.in';

/** Amount must be a rupee string with exactly 2 decimals, e.g. "3500.00". */
const toRupees = (paise) => (paise / 100).toFixed(2);

/**
 * Create a payment link. customer = { name, email, phone } — Easebuzz requires
 * firstname/email/phone on initiation (falls back to safe defaults).
 */
async function createOrder(amountPaise, refId, customer = {}) {
  const key = process.env.EASEBUZZ_KEY;
  const salt = process.env.EASEBUZZ_SALT;
  const txnid = `ozw_${String(refId).replace(/-/g, '').slice(0, 20)}_${Date.now().toString(36)}`;
  const amount = toRupees(amountPaise);
  const productinfo = 'Ozone Wash Service';
  const firstname = (customer.name || 'Customer').split(' ')[0].replace(/[^a-zA-Z0-9 ]/g, '') || 'Customer';
  const email = customer.email || 'support@ozonewash.in';
  const phone = customer.phone || '9999999999';
  const appUrl = process.env.APP_URL || 'http://localhost:3100';
  const surl = `${appUrl}/api/v1/payments/easebuzz/callback`;
  const furl = surl;

  const hash = sha512(
    `${key}|${txnid}|${amount}|${productinfo}|${firstname}|${email}|||||||||||${salt}`
  );

  try {
    const form = new URLSearchParams({
      key, txnid, amount, productinfo, firstname, phone, email, surl, furl, hash,
    });
    const { data } = await axios.post(`${baseUrl()}/payment/initiateLink`, form.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    });

    if (!data || Number(data.status) !== 1 || !data.data) {
      console.error('Easebuzz initiate failed:', JSON.stringify(data));
      throw new Error(data?.error_desc || data?.data || 'initiate failed');
    }

    return {
      gateway: 'easebuzz',
      order_id: txnid,               // our txn reference — stored like an order id
      access_key: data.data,
      payment_url: `${baseUrl()}/pay/${data.data}`,
      amount: amountPaise,
      currency: 'INR',
    };
  } catch (err) {
    console.error('Easebuzz create order error:', err.message);
    if (process.env.NODE_ENV === 'development') {
      console.log(`💳 [PAYMENT DEV] Mock easebuzz order for: ${refId} | ₹${amountPaise / 100}`);
      return {
        gateway: 'easebuzz',
        order_id: txnid,
        access_key: `dev_${Date.now()}`,
        payment_url: `${baseUrl()}/pay/dev_${Date.now()}`,
        amount: amountPaise,
        currency: 'INR',
        dev: true,
      };
    }
    throw { status: 500, message: 'Payment order creation failed.' };
  }
}

/**
 * Verify the Easebuzz response payload (from surl/furl POST or app relay).
 * Reverse-order hash: salt|status|udf10..udf1|email|firstname|productinfo|amount|txnid|key
 */
function verifyPayment(payload = {}) {
  try {
    const key = process.env.EASEBUZZ_KEY;
    const salt = process.env.EASEBUZZ_SALT;
    const {
      txnid, amount, productinfo, firstname, email, status, hash,
      udf1 = '', udf2 = '', udf3 = '', udf4 = '', udf5 = '',
      udf6 = '', udf7 = '', udf8 = '', udf9 = '', udf10 = '',
      easepayid,
    } = payload;

    if (!txnid || !hash) throw { status: 400, message: 'Missing Easebuzz payment details.' };

    const expected = sha512(
      `${salt}|${status}|${udf10}|${udf9}|${udf8}|${udf7}|${udf6}|${udf5}|${udf4}|${udf3}|${udf2}|${udf1}|${email}|${firstname}|${productinfo}|${amount}|${txnid}|${key}`
    );

    if (expected !== hash) {
      throw { status: 400, message: 'Payment verification failed. Invalid signature.' };
    }
    if (String(status).toLowerCase() !== 'success') {
      throw { status: 400, message: `Payment not successful (status: ${status}).` };
    }
    return { verified: true, gateway: 'easebuzz', payment_id: easepayid || txnid };
  } catch (err) {
    if (err.status) throw err;
    if (process.env.NODE_ENV === 'development') {
      console.log(`💳 [PAYMENT DEV] Mock easebuzz verification: ${payload?.txnid}`);
      return { verified: true, gateway: 'easebuzz', payment_id: payload?.easepayid || payload?.txnid, dev: true };
    }
    throw { status: 400, message: 'Payment verification failed.' };
  }
}

/** Easebuzz refund API (v1). Amount in rupees. */
async function refundPayment(easepayid, amountPaise) {
  const key = process.env.EASEBUZZ_KEY;
  const salt = process.env.EASEBUZZ_SALT;
  const refundAmount = toRupees(amountPaise);
  try {
    const hash = sha512(`${key}|${easepayid}|${refundAmount}|${salt}`);
    const form = new URLSearchParams({
      key, easebuzz_id: easepayid, refund_amount: refundAmount, hash,
    });
    const { data } = await axios.post(`${baseUrl()}/transaction/v1/refund`, form.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    });
    if (!data || data.status !== true) throw new Error(data?.reason || 'refund failed');
    return data;
  } catch (err) {
    console.error('Easebuzz refund error:', err.message);
    if (process.env.NODE_ENV === 'development') {
      console.log(`💳 [PAYMENT DEV] Mock easebuzz refund: ${easepayid}`);
      return { id: `refund_dev_${Date.now()}`, dev: true };
    }
    throw { status: 500, message: 'Refund failed.' };
  }
}

module.exports = { name: 'easebuzz', isConfigured, createOrder, verifyPayment, refundPayment };
