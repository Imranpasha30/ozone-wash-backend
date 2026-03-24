const express = require('express');
const { body } = require('express-validator');
const AuthController = require('./auth.controller');
const { authenticate } = require('../../middleware/auth.middleware');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: OTP login and JWT authentication
 */

/**
 * @swagger
 * /auth/send-otp:
 *   post:
 *     summary: Send OTP to phone number
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [phone]
 *             properties:
 *               phone:
 *                 type: string
 *                 example: "9876543210"
 *     responses:
 *       200:
 *         description: OTP sent successfully
 *       400:
 *         description: Validation error
 *
 * /auth/verify-otp:
 *   post:
 *     summary: Verify OTP and get JWT token
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [phone, otp]
 *             properties:
 *               phone:
 *                 type: string
 *                 example: "9876543210"
 *               otp:
 *                 type: string
 *                 example: "123456"
 *               fcm_token:
 *                 type: string
 *                 example: "firebase-token-optional"
 *     responses:
 *       200:
 *         description: Login successful — returns JWT token and user object
 *       400:
 *         description: Invalid or expired OTP
 *
 * /auth/profile:
 *   get:
 *     summary: Get current logged in user profile
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User profile returned
 *       401:
 *         description: No token or invalid token
 */

// Validation rules
const sendOtpValidation = [
  body('phone')
    .trim()
    .notEmpty().withMessage('Phone number is required')
    .matches(/^[6-9]\d{9}$/).withMessage('Enter a valid 10-digit Indian mobile number'),
];

const verifyOtpValidation = [
  body('phone')
    .trim()
    .notEmpty().withMessage('Phone number is required')
    .matches(/^[6-9]\d{9}$/).withMessage('Enter a valid 10-digit Indian mobile number'),
  body('otp')
    .trim()
    .notEmpty().withMessage('OTP is required')
    .isLength({ min: 6, max: 6 }).withMessage('OTP must be 6 digits')
    .isNumeric().withMessage('OTP must contain only numbers'),
];

// Public routes
router.post('/send-otp', sendOtpValidation, AuthController.sendOtp);
router.post('/verify-otp', verifyOtpValidation, AuthController.verifyOtp);

// Protected route
router.get('/profile', authenticate, AuthController.getProfile);

module.exports = router;
