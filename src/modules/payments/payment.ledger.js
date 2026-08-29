const db = require('../../config/db');

/**
 * Payment transaction ledger — one row per gateway order in the `payments` table.
 *
 * This is the authoritative per-transaction record (status: created → captured |
 * failed | refunded). Booking confirmation + GST invoice only ever follow a
 * verified `captured` row. Every write here is BEST-EFFORT (wrapped in try/catch)
 * so a ledger hiccup can never break the live payment/booking flow.
 *
 *   status ∈ created | attempted | captured | failed | refunded | cod_pending | cod_collected
 */
const PaymentLedger = {
  // At create-order: open a 'created' row for this gateway order id.
  recordCreated: async ({ userId, bookingId, contractId, orderId, amountPaise, method, gateway, gstPaise }) => {
    if (!orderId) return;
    try {
      await db.query(
        `INSERT INTO payments (user_id, booking_id, amc_contract_id, razorpay_order_id,
           amount_paise, currency, method, status, gst_paise, notes)
         VALUES ($1,$2,$3,$4,$5,'INR',$6,'created',$7,$8)`,
        [userId || null, bookingId || null, contractId || null, orderId,
         amountPaise || 0, method || gateway || null, gstPaise || 0,
         JSON.stringify({ gateway: gateway || null })]
      );
    } catch (e) { console.warn('[ledger] recordCreated failed:', e?.message); }
  },

  // On VERIFIED success: flip the order's row to 'captured'. Idempotent.
  markCaptured: async (orderId, { paymentId, signature, gateway } = {}) => {
    if (!orderId) return;
    try {
      await db.query(
        `UPDATE payments
            SET status = 'captured',
                razorpay_payment_id = COALESCE($2, razorpay_payment_id),
                razorpay_signature  = COALESCE($3, razorpay_signature),
                captured_at = NOW(),
                notes = COALESCE(notes, '{}'::jsonb) || $4::jsonb
          WHERE razorpay_order_id = $1 AND status <> 'captured'`,
        [orderId, paymentId || null, signature || null,
         JSON.stringify({ gateway: gateway || null, captured: true })]
      );
    } catch (e) { console.warn('[ledger] markCaptured failed:', e?.message); }
  },

  // On failure / abandonment (callback failure, 8-min hold sweep).
  markFailed: async (orderId, reason) => {
    if (!orderId) return;
    try {
      await db.query(
        `UPDATE payments
            SET status = 'failed',
                notes = COALESCE(notes, '{}'::jsonb) || $2::jsonb
          WHERE razorpay_order_id = $1 AND status NOT IN ('captured', 'refunded')`,
        [orderId, JSON.stringify({ failed_reason: reason || null })]
      );
    } catch (e) { console.warn('[ledger] markFailed failed:', e?.message); }
  },

  // On a processed refund.
  markRefunded: async (orderId) => {
    if (!orderId) return;
    try {
      await db.query(
        `UPDATE payments SET status = 'refunded' WHERE razorpay_order_id = $1 AND status = 'captured'`,
        [orderId]
      );
    } catch (e) { console.warn('[ledger] markRefunded failed:', e?.message); }
  },
};

module.exports = PaymentLedger;
