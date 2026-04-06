const PaymentService = require('../../services/payment.service');
const BookingRepository = require('../bookings/booking.repository');
const AmcRepository = require('../amc/amc.repository');
const NotificationService = require('../../services/notification.service');
const { sendSuccess, sendError } = require('../../utils/response');

const PaymentController = {

  // POST /api/v1/payments/create-order
  createOrder: async (req, res, next) => {
    try {
      const { booking_id } = req.body;
      if (!booking_id) {
        return sendError(res, 'Booking ID is required', 400);
      }

      // Get booking
      const booking = await BookingRepository.findById(booking_id);
      if (!booking) {
        return sendError(res, 'Booking not found', 404);
      }

      // Only the customer who owns the booking can pay
      if (booking.customer_id !== req.user.id) {
        return sendError(res, 'Access denied', 403);
      }

      if (booking.payment_status === 'paid') {
        return sendError(res, 'Booking is already paid', 400);
      }

      // Create Razorpay order
      const order = await PaymentService.createOrder(
        booking.amount_paise,
        booking_id
      );

      // Save order ID to booking
      await BookingRepository.updatePayment(booking_id, {
        razorpay_order_id: order.order_id,
        razorpay_payment_id: null,
        payment_status: 'pending',
      });

      return sendSuccess(res, {
        order_id: order.order_id,
        amount: order.amount,
        currency: order.currency,
        booking_id,
        // Send key to frontend for Razorpay SDK
        key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder',
      }, 'Payment order created');
    } catch (err) {
      next(err);
    }
  },

  // POST /api/v1/payments/verify
  verifyPayment: async (req, res, next) => {
    try {
      const { booking_id, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

      if (!booking_id || !razorpay_order_id || !razorpay_payment_id) {
        return sendError(res, 'Missing payment details', 400);
      }

      // Verify signature
      PaymentService.verifyPayment(
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature
      );

      // Update booking payment status
      const booking = await BookingRepository.updatePayment(booking_id, {
        razorpay_order_id,
        razorpay_payment_id,
        payment_status: 'paid',
      });

      // Update booking status to confirmed
      await BookingRepository.updateStatus(booking_id, 'confirmed');

      // Send payment confirmation notification
      const customer = { phone: booking.customer_phone, fcm_token: null };
      await NotificationService.onPaymentConfirmed(customer, booking);

      return sendSuccess(res, {
        payment_status: 'paid',
        booking_id,
      }, 'Payment verified successfully');
    } catch (err) {
      next(err);
    }
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

      const refund = await PaymentService.refundPayment(
        booking.razorpay_payment_id,
        booking.amount_paise
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

      const order = await PaymentService.createOrder(
        contract.amount_paise,
        contract_id
      );

      await AmcRepository.updatePayment(contract_id, {
        razorpay_order_id: order.order_id,
        razorpay_payment_id: null,
        payment_status: 'pending',
      });

      return sendSuccess(res, {
        order_id: order.order_id,
        amount: order.amount,
        currency: order.currency,
        contract_id,
        key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder',
      }, 'AMC payment order created');
    } catch (err) {
      next(err);
    }
  },

  // POST /api/v1/payments/amc/verify
  verifyAmcPayment: async (req, res, next) => {
    try {
      const { contract_id, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

      if (!contract_id || !razorpay_order_id || !razorpay_payment_id) {
        return sendError(res, 'Missing payment details', 400);
      }

      PaymentService.verifyPayment(
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature
      );

      await AmcRepository.updatePayment(contract_id, {
        razorpay_order_id,
        razorpay_payment_id,
        payment_status: 'paid',
      });

      // Activate the contract
      await AmcRepository.updateStatus(contract_id, 'active');

      return sendSuccess(res, {
        payment_status: 'paid',
        contract_id,
      }, 'AMC payment verified successfully');
    } catch (err) {
      next(err);
    }
  },

};

module.exports = PaymentController;