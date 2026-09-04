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
  // Append-only lifecycle event. THE authoritative money-movement timeline
  // (inflow + outflow + state markers). Best-effort — never breaks the flow.
  recordEvent: async ({
    bookingId, contractId, jobId, orderId, gateway, eventType,
    direction = 'neutral', amountPaise = 0, status, gatewayRef, note, metadata, createdBy,
  } = {}) => {
    if (!eventType) return;
    try {
      await db.query(
        `INSERT INTO payment_events (booking_id, amc_contract_id, job_id, order_id, gateway,
           event_type, direction, amount_paise, status, gateway_ref, note, metadata, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)`,
        [bookingId || null, contractId || null, jobId || null, orderId || null, gateway || null,
         eventType, direction, Math.round(Number(amountPaise) || 0), status || null,
         gatewayRef || null, note || null, JSON.stringify(metadata || {}), createdBy || null]
      );
    } catch (e) { console.warn('[ledger] recordEvent failed:', e?.message); }
  },

  // At create-order: open a 'created' row for this gateway order id.
  recordCreated: async ({ userId, bookingId, contractId, jobId, orderId, amountPaise, method, gateway, gstPaise }) => {
    if (!orderId) return;
    try {
      await db.query(
        `INSERT INTO payments (user_id, booking_id, amc_contract_id, job_id, razorpay_order_id,
           amount_paise, currency, method, status, gst_paise, notes)
         VALUES ($1,$2,$3,$4,$5,$6,'INR',$7,'created',$8,$9)`,
        [userId || null, bookingId || null, contractId || null, jobId || null, orderId,
         amountPaise || 0, method || gateway || null, gstPaise || 0,
         JSON.stringify({ gateway: gateway || null })]
      );
    } catch (e) { console.warn('[ledger] recordCreated failed:', e?.message); }
    PaymentLedger.recordEvent({
      bookingId, contractId, jobId, orderId, gateway, eventType: 'order_created',
      direction: 'in', amountPaise, status: 'created', note: method || null,
    });
  },

  // On VERIFIED success: flip the order's row to 'captured'. Idempotent — the
  // captured event is only logged when THIS call actually made the transition.
  markCaptured: async (orderId, { paymentId, signature, gateway } = {}) => {
    if (!orderId) return;
    try {
      const { rows } = await db.query(
        `UPDATE payments
            SET status = 'captured',
                razorpay_payment_id = COALESCE($2, razorpay_payment_id),
                razorpay_signature  = COALESCE($3, razorpay_signature),
                captured_at = NOW(),
                notes = COALESCE(notes, '{}'::jsonb) || $4::jsonb
          WHERE razorpay_order_id = $1 AND status <> 'captured'
          RETURNING amount_paise, booking_id, amc_contract_id, job_id`,
        [orderId, paymentId || null, signature || null,
         JSON.stringify({ gateway: gateway || null, captured: true })]
      );
      if (rows[0]) {
        PaymentLedger.recordEvent({
          bookingId: rows[0].booking_id, contractId: rows[0].amc_contract_id, jobId: rows[0].job_id,
          orderId, gateway, eventType: 'payment_captured', direction: 'in',
          amountPaise: rows[0].amount_paise, status: 'captured', gatewayRef: paymentId,
        });
      }
    } catch (e) { console.warn('[ledger] markCaptured failed:', e?.message); }
  },

  // On failure / abandonment (callback failure, hold sweep).
  markFailed: async (orderId, reason) => {
    if (!orderId) return;
    try {
      const { rows } = await db.query(
        `UPDATE payments
            SET status = 'failed',
                notes = COALESCE(notes, '{}'::jsonb) || $2::jsonb
          WHERE razorpay_order_id = $1 AND status NOT IN ('captured', 'refunded')
          RETURNING booking_id, amc_contract_id`,
        [orderId, JSON.stringify({ failed_reason: reason || null })]
      );
      if (rows[0]) {
        PaymentLedger.recordEvent({
          bookingId: rows[0].booking_id, contractId: rows[0].amc_contract_id,
          orderId, eventType: 'payment_failed', direction: 'neutral', status: 'failed', note: reason,
        });
      }
    } catch (e) { console.warn('[ledger] markFailed failed:', e?.message); }
  },

  // On a processed refund (summary flip on the order row).
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
