const express = require('express');
const PaymentController = require('./payment.controller');
const { authenticate, requireRole } = require('../../middleware/auth.middleware');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Payments
 *   description: Razorpay payment integration
 */

/**
 * @swagger
 * /payments/create-order:
 *   post:
 *     summary: Create Razorpay payment order
 *     tags: [Payments]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [booking_id]
 *             properties:
 *               booking_id:
 *                 type: string
 *                 example: "c2a9c434-5ea8-450e-800e-207b2bb8874d"
 *     responses:
 *       200:
 *         description: Razorpay order created with key_id and order_id
 *
 * /payments/verify:
 *   post:
 *     summary: Verify Razorpay payment after completion
 *     tags: [Payments]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [booking_id, razorpay_order_id, razorpay_payment_id]
 *             properties:
 *               booking_id:
 *                 type: string
 *               razorpay_order_id:
 *                 type: string
 *               razorpay_payment_id:
 *                 type: string
 *               razorpay_signature:
 *                 type: string
 *     responses:
 *       200:
 *         description: Payment verified successfully
 *
 * /payments/refund:
 *   post:
 *     summary: Refund a payment (admin only)
 *     tags: [Payments]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [booking_id]
 *             properties:
 *               booking_id:
 *                 type: string
 *     responses:
 *       200:
 *         description: Refund initiated
 */

router.post('/create-order', authenticate, requireRole('customer'), PaymentController.createOrder);
router.post('/verify', authenticate, requireRole('customer'), PaymentController.verifyPayment);
router.post('/refund', authenticate, requireRole('admin'), PaymentController.refundPayment);

// Easebuzz surl/furl target — hit by the Easebuzz checkout (server-to-browser
// form POST, no JWT possible). Signature-verified inside the handler.
router.post('/easebuzz/callback', PaymentController.easebuzzCallback);

// PayU surl/furl target — hit by the PayU hosted checkout (form POST, no JWT).
// Reverse-hash-verified inside the handler. Mobile (WebView) uses this one.
router.post('/payu/callback', PaymentController.payuCallback);
// Web checkout variant — settles identically but replies with a server-side 302
// back to the web app instead of a postMessage page.
router.post('/payu/callback/web', PaymentController.payuCallbackWeb);
// PayU server-to-server webhook — fires directly from PayU (not the browser), so a
// captured payment settles even if the app/WebView died before the surl/furl POST.
// Reverse-hash-verified + idempotent inside the handler. Set the URL in PayU
// Dashboard → Developers → Webhooks (separate TEST and LIVE URLs).
router.post('/payu/webhook', PaymentController.payuWebhook);

// Razorpay webhook — server-to-server, no JWT. Verified against
// RAZORPAY_WEBHOOK_SECRET (raw-body HMAC) inside the handler.
router.post('/webhook/razorpay', PaymentController.razorpayWebhook);

// AMC payment routes
router.post('/amc/create-order', authenticate, requireRole('customer'), PaymentController.createAmcOrder);
router.post('/amc/verify', authenticate, requireRole('customer'), PaymentController.verifyAmcPayment);

module.exports = router;