// ONLY job: handle HTTP. Read req, call service, send res.
const { validationResult } = require('express-validator');
const AuthService = require('./auth.service');
const { sendSuccess, sendError } = require('../../utils/response');

const AuthController = {

  // POST /api/v1/auth/send-otp
  sendOtp: async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, 'Validation failed', 400, errors.array());
      }
      const { phone } = req.body;
      const result = await AuthService.sendOtp(phone);
      return sendSuccess(res, result, 'OTP sent successfully');
    } catch (err) {
      next(err);
    }
  },

  // POST /api/v1/auth/verify-otp
  verifyOtp: async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, 'Validation failed', 400, errors.array());
      }
      const { phone, otp, fcm_token } = req.body;
      const result = await AuthService.verifyOtp(phone, otp, fcm_token);
      return sendSuccess(res, result, 'Login successful');
    } catch (err) {
      next(err);
    }
  },

  // GET /api/v1/auth/profile
  getProfile: async (req, res, next) => {
    try {
      const user = await AuthService.getProfile(req.user.id);
      return sendSuccess(res, { user });
    } catch (err) {
      next(err);
    }
  },

};

module.exports = AuthController;