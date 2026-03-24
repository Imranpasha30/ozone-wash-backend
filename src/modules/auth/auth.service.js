// ONLY job: business logic. Calls repository for data.
const jwt = require('jsonwebtoken');
const AuthRepository = require('./auth.repository');

const AuthService = {

  sendOtp: async (phone) => {
    // Generate 6-digit OTP
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

    // Expires in 5 minutes
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    // Save to DB
    await AuthRepository.saveOtp(phone, otpCode, expiresAt);

    // In development just log it — no SMS needed for testing
    if (process.env.NODE_ENV === 'development') {
      console.log(`📱 OTP for ${phone}: ${otpCode}`);
    }

    return { message: 'OTP sent successfully' };
  },

  verifyOtp: async (phone, otpCode, fcmToken = null) => {
    // Check OTP is valid
    const validOtp = await AuthRepository.findValidOtp(phone, otpCode);

    if (!validOtp) {
      throw { status: 400, message: 'Invalid or expired OTP. Please request a new one.' };
    }

    // Mark OTP as used so it cannot be reused
    await AuthRepository.markOtpUsed(phone);

    // Find existing user or create new one
    let user = await AuthRepository.findByPhone(phone);
    if (!user) {
      user = await AuthRepository.createUser({ phone, role: 'customer' });
    }

    // Save FCM token if provided
    if (fcmToken) {
      await AuthRepository.updateFcmToken(user.id, fcmToken);
    }

    // Issue JWT
    const token = jwt.sign(
      { id: user.id, phone: user.phone, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    return {
      token,
      user: {
        id: user.id,
        phone: user.phone,
        role: user.role,
        name: user.name,
        lang: user.lang,
      },
    };
  },

  getProfile: async (userId) => {
    const user = await AuthRepository.findById(userId);
    if (!user) {
      throw { status: 404, message: 'User not found.' };
    }
    return user;
  },

};

module.exports = AuthService;