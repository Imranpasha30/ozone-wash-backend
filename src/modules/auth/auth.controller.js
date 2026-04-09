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

  // PATCH /api/v1/auth/profile
  updateProfile: async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, 'Validation failed', 400, errors.array());
      }
      const { name, email } = req.body;
      const user = await AuthService.updateProfile(req.user.id, { name, email });
      return sendSuccess(res, { user }, 'Profile updated');
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

  // GET /api/v1/auth/users (admin)
  getAllUsers: async (req, res, next) => {
    try {
      const { role, limit = 50, offset = 0 } = req.query;
      const result = await AuthService.getAllUsers({
        role,
        limit: parseInt(limit),
        offset: parseInt(offset),
      });
      return sendSuccess(res, result);
    } catch (err) {
      next(err);
    }
  },

};

module.exports = AuthController;