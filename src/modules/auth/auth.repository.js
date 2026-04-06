// ONLY job: talk to the database. No business logic here.
const db = require('../../config/db');

const AuthRepository = {

  findByPhone: async (phone) => {
    const result = await db.query(
      'SELECT * FROM users WHERE phone = $1 LIMIT 1',
      [phone]
    );
    return result.rows[0] || null;
  },

  findById: async (id) => {
    const result = await db.query(
      'SELECT id, phone, email, role, name, lang, fcm_token FROM users WHERE id = $1 LIMIT 1',
      [id]
    );
    return result.rows[0] || null;
  },

  createUser: async ({ phone, role = 'customer', name = null, lang = 'en' }) => {
    const result = await db.query(
      `INSERT INTO users (phone, role, name, lang)
       VALUES ($1, $2, $3, $4)
       RETURNING id, phone, role, name, lang, created_at`,
      [phone, role, name, lang]
    );
    return result.rows[0];
  },

  updateFcmToken: async (userId, fcmToken) => {
    await db.query(
      'UPDATE users SET fcm_token = $1 WHERE id = $2',
      [fcmToken, userId]
    );
  },

  saveOtp: async (phone, otpCode, expiresAt) => {
    await db.query(
      `INSERT INTO otp_codes (phone, code, expires_at, used)
       VALUES ($1, $2, $3, false)
       ON CONFLICT (phone)
       DO UPDATE SET code = $2, expires_at = $3, used = false, created_at = NOW()`,
      [phone, otpCode, expiresAt]
    );
  },

  findValidOtp: async (phone, otpCode) => {
    const result = await db.query(
      `SELECT * FROM otp_codes
       WHERE phone = $1
         AND code = $2
         AND used = false
         AND expires_at > NOW()
       LIMIT 1`,
      [phone, otpCode]
    );
    return result.rows[0] || null;
  },

  markOtpUsed: async (phone) => {
    await db.query(
      'UPDATE otp_codes SET used = true WHERE phone = $1',
      [phone]
    );
  },

};

module.exports = AuthRepository;