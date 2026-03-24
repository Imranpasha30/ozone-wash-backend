const express = require('express');
const { body } = require('express-validator');
const BookingController = require('./booking.controller');
const { authenticate, requireRole } = require('../../middleware/auth.middleware');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Bookings
 *   description: Tank cleaning booking management
 */

/**
 * @swagger
 * /bookings/slots:
 *   get:
 *     summary: Get available slots for a date
 *     tags: [Bookings]
 *     parameters:
 *       - in: query
 *         name: date
 *         required: true
 *         schema:
 *           type: string
 *           example: "2026-03-25"
 *     responses:
 *       200:
 *         description: List of available slots
 *
 * /bookings/price:
 *   get:
 *     summary: Calculate price before booking
 *     tags: [Bookings]
 *     parameters:
 *       - in: query
 *         name: tank_type
 *         schema:
 *           type: string
 *           example: "overhead"
 *       - in: query
 *         name: tank_size_litres
 *         schema:
 *           type: number
 *           example: 500
 *       - in: query
 *         name: addons
 *         schema:
 *           type: string
 *           example: "lime_treatment,advanced_testing"
 *       - in: query
 *         name: amc_plan
 *         schema:
 *           type: string
 *           example: "quarterly"
 *     responses:
 *       200:
 *         description: Price breakdown with GST
 *
 * /bookings:
 *   post:
 *     summary: Create a new booking
 *     tags: [Bookings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [tank_type, tank_size_litres, address, slot_time, payment_method]
 *             properties:
 *               tank_type:
 *                 type: string
 *                 example: "overhead"
 *               tank_size_litres:
 *                 type: number
 *                 example: 500
 *               address:
 *                 type: string
 *                 example: "123 Banjara Hills, Hyderabad"
 *               lat:
 *                 type: number
 *                 example: 17.4126
 *               lng:
 *                 type: number
 *                 example: 78.4071
 *               slot_time:
 *                 type: string
 *                 example: "2026-03-25T10:00:00"
 *               addons:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ["lime_treatment"]
 *               amc_plan:
 *                 type: string
 *                 example: "quarterly"
 *               payment_method:
 *                 type: string
 *                 example: "upi"
 *     responses:
 *       201:
 *         description: Booking created successfully
 *       400:
 *         description: Validation error
 *
 *   get:
 *     summary: Get all bookings (admin only)
 *     tags: [Bookings]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           example: "pending"
 *       - in: query
 *         name: date
 *         schema:
 *           type: string
 *           example: "2026-03-25"
 *     responses:
 *       200:
 *         description: List of all bookings
 *
 * /bookings/my:
 *   get:
 *     summary: Get my bookings (customer)
 *     tags: [Bookings]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Customer booking history
 *
 * /bookings/{id}:
 *   get:
 *     summary: Get single booking by ID
 *     tags: [Bookings]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Booking details
 *       404:
 *         description: Booking not found
 *
 * /bookings/{id}/cancel:
 *   patch:
 *     summary: Cancel a booking
 *     tags: [Bookings]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Booking cancelled
 *       400:
 *         description: Cannot cancel
 */

// Validation rules
const createBookingValidation = [
  body('tank_type')
    .notEmpty().withMessage('Tank type is required')
    .isIn(['overhead', 'underground', 'sump'])
    .withMessage('Tank type must be overhead, underground or sump'),
  body('tank_size_litres')
    .notEmpty().withMessage('Tank size is required')
    .isNumeric().withMessage('Tank size must be a number')
    .custom(val => val > 0).withMessage('Tank size must be greater than 0'),
  body('address')
    .notEmpty().withMessage('Address is required')
    .isLength({ min: 10 }).withMessage('Please enter a complete address'),
  body('slot_time')
    .notEmpty().withMessage('Slot time is required')
    .isISO8601().withMessage('Invalid date format. Use ISO format: 2026-03-25T10:00:00'),
  body('payment_method')
    .notEmpty().withMessage('Payment method is required')
    .isIn(['upi', 'card', 'wallet', 'cod'])
    .withMessage('Payment method must be upi, card, wallet or cod'),
  body('addons')
    .optional()
    .isArray().withMessage('Addons must be an array'),
  body('amc_plan')
    .optional()
    .isIn(['monthly', 'bimonthly', 'quarterly', '4month', 'halfyearly', 'yearly'])
    .withMessage('Invalid AMC plan'),
];

// Public routes
router.get('/slots', BookingController.getSlots);
router.get('/price', BookingController.getPrice);

// Customer routes
router.post('/', authenticate, requireRole('customer'), createBookingValidation, BookingController.createBooking);
router.get('/my', authenticate, BookingController.getMyBookings);
router.get('/:id', authenticate, BookingController.getBooking);
router.patch('/:id/cancel', authenticate, BookingController.cancelBooking);

// Admin routes
router.get('/', authenticate, requireRole('admin'), BookingController.getAllBookings);

module.exports = router;