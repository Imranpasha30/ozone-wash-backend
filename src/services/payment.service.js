/**
 * Payment service — gateway-agnostic facade.
 *
 * The client hasn't finalized Razorpay vs Easebuzz, so BOTH are wired in and
 * the active one is chosen purely from .env — drop in credentials and it
 * starts working with zero code changes:
 *
 *   PAYMENT_GATEWAY=razorpay | easebuzz   (optional — forces a gateway)
 *
 *   # Razorpay                             # Easebuzz
 *   RAZORPAY_KEY_ID=...                    EASEBUZZ_KEY=...
 *   RAZORPAY_KEY_SECRET=...                EASEBUZZ_SALT=...
 *                                          EASEBUZZ_ENV=test|prod
 *
 * Selection order:
 *   1. PAYMENT_GATEWAY if set to a known gateway
 *   2. Whichever gateway has real credentials configured (razorpay first)
 *   3. Razorpay in dev-mock mode (development only)
 *
 * createOrder() returns a `gateway` discriminator so the app knows which
 * checkout UI to render (Razorpay SDK modal vs Easebuzz payment_url WebView).
 * verifyPayment() auto-detects the gateway from the payload shape.
 */
const razorpay = require('./gateways/razorpay.gateway');
const easebuzz = require('./gateways/easebuzz.gateway');

const GATEWAYS = { razorpay, easebuzz };

function activeGateway() {
  const forced = (process.env.PAYMENT_GATEWAY || '').trim().toLowerCase();
  if (GATEWAYS[forced]) return GATEWAYS[forced];
  if (razorpay.isConfigured()) return razorpay;
  if (easebuzz.isConfigured()) return easebuzz;
  return razorpay; // dev fallback — mock orders
}

/** Which gateway a verify payload belongs to, by field shape. */
function gatewayForPayload(payload = {}) {
  if (payload.gateway && GATEWAYS[payload.gateway]) return GATEWAYS[payload.gateway];
  if (payload.razorpay_order_id || payload.razorpay_signature) return razorpay;
  if (payload.txnid || payload.easepayid) return easebuzz;
  return activeGateway();
}

const PaymentService = {

  /** Name of the currently-active gateway ('razorpay' | 'easebuzz'). */
  activeGatewayName: () => activeGateway().name,

  /**
   * Create a payment order/link.
   *   amountPaise — GST-inclusive total
   *   refId       — booking or contract id
   *   customer    — { name, email, phone } (required by Easebuzz)
   */
  createOrder: async (amountPaise, refId, customer = {}) => {
    return activeGateway().createOrder(amountPaise, refId, customer);
  },

  /**
   * Verify a completed payment.
   * Accepts either the legacy positional razorpay call
   *   verifyPayment(orderId, paymentId, signature)
   * or a single gateway payload object
   *   verifyPayment({ razorpay_* }) / verifyPayment({ txnid, hash, ... })
   */
  verifyPayment: (a, b, c) => {
    const payload = typeof a === 'object' && a !== null
      ? a
      : { razorpay_order_id: a, razorpay_payment_id: b, razorpay_signature: c };
    return gatewayForPayload(payload).verifyPayment(payload);
  },

  /** Refund via whichever gateway captured the payment. */
  refundPayment: async (paymentId, amountPaise, gatewayName) => {
    const gw = GATEWAYS[gatewayName] || activeGateway();
    return gw.refundPayment(paymentId, amountPaise);
  },

  /** Fetch raw payment details (razorpay only). */
  getPayment: async (paymentId) => razorpay.getPayment(paymentId),

};

module.exports = PaymentService;
