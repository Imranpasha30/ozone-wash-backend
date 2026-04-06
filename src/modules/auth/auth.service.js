// ONLY job: business logic. Calls repository for data.
const jwt = require('jsonwebtoken');
const AuthRepository = require('./auth.repository');
const NotificationService = require('../../services/notification.service');

const AuthService = {

  sendOtp: async (phone) => {
    // Generate 6-digit OTP
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

    // Expires in 10 minutes
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    // Save to DB (replaces any existing unused OTP for this phone)
    await AuthRepository.saveOtp(phone, otpCode, expiresAt);

    // Always log OTP in development for easy testing without SMS credits
    if (process.env.NODE_ENV !== 'production') {
      console.log(`📱 OTP for ${phone}: ${otpCode}`);
    }

    // Send via SMS and WhatsApp — both are fire-and-forget.
    // If API keys are not set, NotificationService falls back to console.log silently.
    await Promise.allSettled([
      NotificationService.sendOtp(phone, otpCode),
    ]);

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

  getAllUsers: async ({ role, limit, offset }) => {
    const [users, total] = await Promise.all([
      AuthRepository.findAllUsers({ role, limit, offset }),
      AuthRepository.countUsers(role),
    ]);
    return { users, total };
  },

};

module.exports = AuthService;