const express = require('express');
const { body, query } = require('express-validator');
const BookingController = require('./booking.controller');
const { authenticate, requireRole } = require('../../middleware/auth.middleware');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Bookings
 *   description: Tank cleaning booking management
 */

// ── Validation rules ──────────────────────────────────────────────────────────

const VALID_ADDONS = [
  // Spec v2 codes ("Add On for APP" sheet)
  'uv_sterilization', 'anti_algae', 'anti_lime', 'pathogen_testing', 'structural_audit', 'iot_sensor',
  // Legacy codes (auto-aliased in the pricing service)
  'lime_treatment', 'structure_health_check', 'advanced_testing',
];

const VALID_PLAN_INPUTS = ['one_time', 'yearly', 'half_yearly', 'halfyearly', 'quarterly', 'monthly'];

const createBookingValidation = [
  body('tank_type')
    .notEmpty().withMessage('Tank type is required')
    .isIn(['overhead', 'underground', 'sump', 'sintex']).withMessage('Tank type must be overhead, underground, sump or sintex'),
  body('tank_size_litres')
    .notEmpty().withMessage('Tank size is required')
    .isNumeric().withMessage('Tank size must be a number')
    .custom(val => val > 0).withMessage('Tank size must be greater than 0'),
  body('address')
    .trim().escape()
    .notEmpty().withMessage('Address is required')
    .isLength({ min: 10, max: 500 }).withMessage('Address must be 10–500 characters'),
  body('slot_time')
    .notEmpty().withMessage('Slot time is required')
    .isISO8601().withMessage('Invalid date format'),
  body('payment_method')
    .notEmpty().withMessage('Payment method is required')
    .isIn(['upi', 'card', 'wallet', 'cod']).withMessage('Invalid payment method'),
  body('addons')
    .optional()
    .isArray().withMessage('Addons must be an array'),
  body('addons.*')
    .optional()
    .isIn(VALID_ADDONS).withMessage('Invalid addon value'),
  // Service frequency plan (spec §4). One-time = single service; anything else
  // is an AMC — billed annually and a contract is created at checkout.
  body('plan')
    .optional()
    .isIn(VALID_PLAN_INPUTS).withMessage('Invalid plan'),
  // AMC upsell chosen on the payment step (overrides `plan`)
  body('purchase_amc_plan')
    .optional({ nullable: true, checkFalsy: true })
    .isIn(VALID_PLAN_INPUTS.filter(p => p !== 'one_time' && p !== 'yearly')).withMessage('Invalid AMC plan'),
  body('amc_plan')
    .optional()
    .isIn(['monthly', 'bimonthly', 'quarterly', '4month', 'halfyearly', 'yearly']).withMessage('Invalid AMC plan'),
  // Multi-tank: each tank may carry its own location (per-tank address)
  body('tanks')
    .optional()
    .isArray({ max: 20 }).withMessage('tanks must be an array'),
  body('tanks.*.tank_type')
    .optional()
    .isIn(['overhead', 'underground', 'sump', 'sintex']).withMessage('Invalid tank type'),
  body('tanks.*.tank_size_litres')
    .optional()
    .isNumeric().withMessage('Tank size must be a number'),
  body('tanks.*.address')
    .optional({ nullable: true })
    .isLength({ max: 500 }).withMessage('Tank address too long'),
  body('lat')
    .optional()
    .isFloat({ min: -90, max: 90 }).withMessage('Invalid latitude'),
  body('lng')
    .optional()
    .isFloat({ min: -180, max: 180 }).withMessage('Invalid longitude'),
];

// Query param validation for admin GET /bookings
const listBookingsValidation = [
  query('status')
    .optional()
    .isIn(['pending', 'confirmed', 'cancelled', 'completed']).withMessage('Invalid status filter'),
  query('date')
    .optional()
    .isDate({ format: 'YYYY-MM-DD' }).withMessage('Date must be YYYY-MM-DD'),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 }).withMessage('Limit must be 1–100'),
  query('offset')
    .optional()
    .isInt({ min: 0 }).withMessage('Offset must be >= 0'),
];

// Query param validation for GET /bookings/slots
const slotsValidation = [
  query('date')
    .notEmpty().withMessage('Date is required')
    .isDate({ format: 'YYYY-MM-DD' }).withMessage('Date must be YYYY-MM-DD'),
];

// Query param validation for GET /bookings/price
//   Two modes:
//     (a) matrix:  ?tank_size_litres=2000&tank_count=1&plan=quarterly
//     (b) legacy:  ?tank_type=overhead&tank_size_litres=500&addons=lime_treatment
const priceValidation = [
  query('tank_size_litres')
    .notEmpty().withMessage('tank_size_litres is required')
    .isNumeric().withMessage('Must be a number')
    .custom(val => Number(val) > 0).withMessage('Must be > 0'),
  query('tank_type')
    .optional()
    .isIn(['overhead', 'underground', 'sump']).withMessage('Invalid tank type'),
  query('plan')
    .optional()
    .isIn(['one_time', 'yearly', 'monthly', 'quarterly', 'half_yearly', 'halfyearly']).withMessage('Invalid plan'),
  query('tank_count')
    .optional()
    .isInt({ min: 1, max: 50 }).withMessage('tank_count must be 1-50'),
  query('tank_sizes')
    .optional()
    .isString(),
  query('addons')
    .optional()
    .isString(),
  query('amc_plan')
    .optional()
    .isIn(['', 'monthly', 'bimonthly', 'quarterly', '4month', 'halfyearly', 'yearly']).withMessage('Invalid AMC plan'),
];

// ── Routes ────────────────────────────────────────────────────────────────────

// Public
router.get('/slots', slotsValidation, BookingController.getSlots);
router.get('/price', authenticate, priceValidation, BookingController.getPrice);

// Add-on catalogue priced for a tank size (?tank_size_litres=15000).
// Prices come from tank_addons buckets; 1,00,000+ L → custom_quote flags.
router.get('/addons', authenticate, async (req, res, next) => {
  try {
    const PricingService = require('../../services/pricing');
    const litres = parseFloat(req.query.tank_size_litres) || 1000;
    const bucket = PricingService.addonBucketForLitres(litres);
    const all = await PricingService.listAddons();
    const col = { small: 'price_small_paise', medium: 'price_medium_paise', large: 'price_large_paise' }[bucket];
    const addons = all.map((a) => ({
      code: a.code,
      name: a.display_name,
      coming_soon: a.coming_soon,
      custom_quote: bucket === 'custom',
      price_paise: bucket === 'custom' ? null : a[col],
      available: !a.coming_soon && (bucket === 'custom' || a[col] != null),
    }));
    res.json({ success: true, message: 'Success', data: { bucket, addons } });
  } catch (err) { next(err); }
});

// Customer
router.post('/', authenticate, requireRole('customer'), createBookingValidation, BookingController.createBooking);
router.get('/my', authenticate, BookingController.getMyBookings);
router.get('/:id', authenticate, BookingController.getBooking);
router.patch('/:id/cancel', authenticate, BookingController.cancelBooking);

// Admin
router.get('/', authenticate, requireRole('admin'), listBookingsValidation, BookingController.getAllBookings);
router.patch('/:id/confirm', authenticate, requireRole('admin'), BookingController.confirmBooking);

module.exports = router;
