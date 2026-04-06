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

// AMC payment routes
router.post('/amc/create-order', authenticate, requireRole('customer'), PaymentController.createAmcOrder);
router.post('/amc/verify', authenticate, requireRole('customer'), PaymentController.verifyAmcPayment);

module.exports = router;