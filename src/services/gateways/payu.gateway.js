/**
 * PayU (India) gateway adapter.
 *
 * Configured entirely from .env — drop in real credentials and it goes live:
 *   PAYU_KEY=your_merchant_key
 *   PAYU_SALT=your_merchant_salt
 *   PAYU_ENV=test              # test | prod
 *   PAYMENT_GATEWAY=payu       # select PayU as the active gateway
 *
 * Flow (PayU classic Hosted Checkout, "_payment"):
 *   1. createOrder() computes the request hash and returns the FORM PARAMS +
 *      the action URL. There is NO server-side "initiate" call — the app POSTs
 *      an auto-submitting form to {base}/_payment inside a WebView.
 *        request hash = sha512(key|txnid|amount|productinfo|firstname|email|
 *                              udf1..udf5||||||salt)   (all udf empty here)
 *   2. On completion PayU POSTs the result to our surl/furl callback; the app
 *      WebView also relays it. verifyPayment() validates the REVERSE hash:
 *        sha512(salt|status|udf10..udf1|email|firstname|productinfo|amount|
 *               txnid|key)
 *   3. refundPayment() calls PayU's merchant postservice (cancel_refund_transaction).
 *
 * NB: PayU and Easebuzz share the same hash construction (Easebuzz is a PayU
 * fork), so this mirrors easebuzz.gateway.js by design.
 */
const crypto = require('crypto');
const axios = require('axios');

const sha512 = (s) => crypto.createHash('sha512').update(s).digest('hex');
const PLACEHOLDER_RE = /placeholder|^$|XXXX|your[_-]?/i;

const isConfigured = () =>
  !!process.env.PAYU_KEY && !!process.env.PAYU_SALT &&
  !PLACEHOLDER_RE.test(process.env.PAYU_KEY) && !PLACEHOLDER_RE.test(process.env.PAYU_SALT);

const isProd = () => (process.env.PAYU_ENV || 'test').toLowerCase() === 'prod';
// Hosted payment page ("_payment"); merchant API ("postservice") for refunds.
const paymentBase = () => (isProd() ? 'https://secure.payu.in' : 'https://test.payu.in');
const apiBase = () => (isProd() ? 'https://info.payu.in' : 'https://test.payu.in');

/** Amount must be a rupee string with exactly 2 decimals, e.g. "3500.00". */
const toRupees = (paise) => (paise / 100).toFixed(2);

/**
 * Prepare a PayU hosted-checkout order. Returns the signed form params the app
 * POSTs to payment_url. customer = { name, email, phone }.
 */
async function createOrder(amountPaise, refId, customer = {}) {
  const key = process.env.PAYU_KEY;
  const salt = process.env.PAYU_SALT;
  const txnid = `payu_${String(refId).replace(/-/g, '').slice(0, 20)}_${Date.now().toString(36)}`;
  const amount = toRupees(amountPaise);
  const productinfo = 'Ozone Wash Service';
  const firstname = (customer.name || 'Customer').split(' ')[0].replace(/[^a-zA-Z0-9 ]/g, '') || 'Customer';
  const email = customer.email || 'support@ozonewash.in';
  const phone = customer.phone || '9999999999';
  const appUrl = process.env.APP_URL || 'http://localhost:3100';
  const surl = `${appUrl}/api/v1/payments/payu/callback`;
  const furl = surl;

  if (!isConfigured()) {
    if (process.env.NODE_ENV === 'development') {
      console.log(`💳 [PAYMENT DEV] Mock PayU order for: ${refId} | ₹${amountPaise / 100}`);
      return {
        gateway: 'payu', order_id: txnid,
        payment_url: `${paymentBase()}/_payment`,
        payment_params: { key: key || 'dev', txnid, amount, productinfo, firstname, email, phone, surl, furl, hash: 'dev' },
        amount: amountPaise, currency: 'INR', dev: true,
      };
    }
    throw { status: 500, message: 'PayU is not configured.' };
  }

  // Request hash — all udf fields empty (udf1..udf5 then 5 reserved), then salt.
  const hash = sha512(
    `${key}|${txnid}|${amount}|${productinfo}|${firstname}|${email}|||||||||||${salt}`
  );

  return {
    gateway: 'payu',
    order_id: txnid,                    // our txn reference — stored like an order id
    payment_url: `${paymentBase()}/_payment`,
    // The app auto-submits these as a form POST inside a WebView.
    payment_params: { key, txnid, amount, productinfo, firstname, email, phone, surl, furl, hash },
    amount: amountPaise,
    currency: 'INR',
  };
}

/**
 * Verify a PayU response payload (from surl/furl POST or app relay).
 * Reverse-order hash: salt|status|udf10..udf1|email|firstname|productinfo|amount|txnid|key
 */
function verifyPayment(payload = {}) {
  try {
    const key = process.env.PAYU_KEY;
    const salt = process.env.PAYU_SALT;
    const {
      txnid, amount, productinfo, firstname, email, status, hash, mihpayid,
      udf1 = '', udf2 = '', udf3 = '', udf4 = '', udf5 = '',
      udf6 = '', udf7 = '', udf8 = '', udf9 = '', udf10 = '',
      additionalCharges,
    } = payload;

    if (!txnid || !hash) throw { status: 400, message: 'Missing PayU payment details.' };

    // PayU prefixes the reverse hash with additionalCharges when present.
    const core = `${salt}|${status}|${udf10}|${udf9}|${udf8}|${udf7}|${udf6}|${udf5}|${udf4}|${udf3}|${udf2}|${udf1}|${email}|${firstname}|${productinfo}|${amount}|${txnid}|${key}`;
    const expected = additionalCharges
      ? sha512(`${additionalCharges}|${core}`)
      : sha512(core);

    if (expected !== hash) {
      throw { status: 400, message: 'Payment verification failed. Invalid signature.' };
    }
    if (String(status).toLowerCase() !== 'success') {
      throw { status: 400, message: `Payment not successful (status: ${status}).` };
    }
    return { verified: true, gateway: 'payu', payment_id: mihpayid || txnid };
  } catch (err) {
    if (err.status) throw err;
    if (process.env.NODE_ENV === 'development') {
      console.log(`💳 [PAYMENT DEV] Mock PayU verification: ${payload?.txnid}`);
      return { verified: true, gateway: 'payu', payment_id: payload?.mihpayid || payload?.txnid, dev: true };
    }
    throw { status: 400, message: 'Payment verification failed.' };
  }
}

/**
 * Refund via PayU merchant postservice (command = cancel_refund_transaction).
 * paymentId = mihpayid. A unique refund token is generated per call.
 * hash = sha512(key|command|var1|salt).
 */
async function refundPayment(paymentId, amountPaise) {
  const key = process.env.PAYU_KEY;
  const salt = process.env.PAYU_SALT;
  const command = 'cancel_refund_transaction';
  const var1 = paymentId;                                        // mihpayid
  const var2 = `rfnd_${Date.now().toString(36)}`;                // unique refund token
  const var3 = toRupees(amountPaise);                            // refund amount (rupees)
  try {
    const hash = sha512(`${key}|${command}|${var1}|${salt}`);
    const form = new URLSearchParams({ key, command, var1, var2, var3, hash });
    const { data } = await axios.post(`${apiBase()}/merchant/postservice?form=2`, form.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    });
    if (!data || Number(data.status) !== 1) {
      throw new Error(data?.msg || data?.error_code || 'refund failed');
    }
    return { id: data.request_id || var2, ...data };
  } catch (err) {
    console.error('PayU refund error:', err.message);
    if (process.env.NODE_ENV === 'development') {
      console.log(`💳 [PAYMENT DEV] Mock PayU refund: ${paymentId}`);
      return { id: `refund_dev_${Date.now()}`, dev: true };
    }
    throw { status: 500, message: 'Refund failed.' };
  }
}

module.exports = { name: 'payu', isConfigured, createOrder, verifyPayment, refundPayment };
