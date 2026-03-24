const crypto = require('crypto');

// Initialize Razorpay — works with placeholder keys in development
const getRazorpay = () => {
  const Razorpay = require('razorpay');
  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder',
    key_secret: process.env.RAZORPAY_KEY_SECRET || 'placeholder_secret',
  });
};

const PaymentService = {

  // Create Razorpay order — called when customer clicks Pay
  createOrder: async (amountPaise, bookingId, currency = 'INR') => {
    try {
      const razorpay = getRazorpay();

      const order = await razorpay.orders.create({
        amount: amountPaise,
        currency,
        receipt: `booking_${bookingId}`,
        notes: {
          booking_id: bookingId,
          platform: 'ozone_wash',
        },
      });

      return {
        order_id: order.id,
        amount: order.amount,
        currency: order.currency,
        receipt: order.receipt,
      };
    } catch (err) {
      console.error('Razorpay create order error:', err.message);

      // In development return mock order
      if (process.env.NODE_ENV === 'development') {
        console.log(`💳 [PAYMENT DEV] Mock order for booking: ${bookingId} | Amount: ₹${amountPaise / 100}`);
        return {
          order_id: `order_dev_${Date.now()}`,
          amount: amountPaise,
          currency,
          receipt: `booking_${bookingId}`,
          dev: true,
        };
      }

      throw { status: 500, message: 'Payment order creation failed.' };
    }
  },

  // Verify Razorpay payment signature — CRITICAL security check
  verifyPayment: (orderId, paymentId, signature) => {
    try {
      const secret = process.env.RAZORPAY_KEY_SECRET || 'placeholder_secret';
      const body = `${orderId}|${paymentId}`;
      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(body)
        .digest('hex');

      const isValid = expectedSignature === signature;

      if (!isValid) {
        throw { status: 400, message: 'Payment verification failed. Invalid signature.' };
      }

      return { verified: true };
    } catch (err) {
      if (err.status) throw err;

      // Dev mode — accept mock payments
      if (process.env.NODE_ENV === 'development') {
        console.log(`💳 [PAYMENT DEV] Mock verification for order: ${orderId}`);
        return { verified: true, dev: true };
      }

      throw { status: 400, message: 'Payment verification failed.' };
    }
  },

  // Get payment details from Razorpay
  getPayment: async (paymentId) => {
    try {
      const razorpay = getRazorpay();
      return await razorpay.payments.fetch(paymentId);
    } catch (err) {
      console.error('Razorpay fetch payment error:', err.message);
      throw { status: 404, message: 'Payment not found.' };
    }
  },

  // Refund a payment
  refundPayment: async (paymentId, amountPaise) => {
    try {
      const razorpay = getRazorpay();
      const refund = await razorpay.payments.refund(paymentId, {
        amount: amountPaise,
        notes: { reason: 'Customer requested refund' },
      });
      return refund;
    } catch (err) {
      console.error('Razorpay refund error:', err.message);

      if (process.env.NODE_ENV === 'development') {
        console.log(`💳 [PAYMENT DEV] Mock refund for payment: ${paymentId}`);
        return { id: `refund_dev_${Date.now()}`, dev: true };
      }

      throw { status: 500, message: 'Refund failed.' };
    }
  },

};

module.exports = PaymentService;