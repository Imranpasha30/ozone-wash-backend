const { validationResult } = require('express-validator');
const BookingService = require('./booking.service');
const NotificationService = require('../../services/notification.service');
const AuthRepository = require('../auth/auth.repository');
const { sendSuccess, sendError } = require('../../utils/response');

const BookingController = {

  // GET /api/v1/bookings/slots?date=2026-03-24
  getSlots: async (req, res, next) => {
    try {
      const { date } = req.query;
      if (!date) {
        return sendError(res, 'Date is required. Format: YYYY-MM-DD', 400);
      }
      const slots = await BookingService.getAvailableSlots(date);
      return sendSuccess(res, { slots });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/v1/bookings/price?tank_type=overhead&tank_size_litres=500&addons=lime_treatment
  // AMC discount is auto-detected from the logged-in user's active contract
  getPrice: async (req, res, next) => {
    try {
      const { tank_type, tank_size_litres, addons } = req.query;
      const addonList = addons ? addons.split(',') : [];

      // Auto-detect active AMC for this user
      let activePlan = null;
      if (req.user) {
        try {
          const AmcRepository = require('../amc/amc.repository');
          const contracts = await AmcRepository.findByCustomer(req.user.id);
          const active = contracts.find(c => c.status === 'active');
          if (active) activePlan = active.plan_type;
        } catch (_) {}
      }

      const pricing = BookingService.calculatePrice(
        tank_type,
        parseFloat(tank_size_litres) || 500,
        addonList,
        activePlan
      );
      pricing.amc_plan = activePlan;
      return sendSuccess(res, { pricing });
    } catch (err) {
      next(err);
    }
  },

  // POST /api/v1/bookings
  createBooking: async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, 'Validation failed', 400, errors.array());
      }
      const result = await BookingService.createBooking(req.user.id, req.body);
      AuthRepository.findById(req.user.id).then(customer => {
        NotificationService.onBookingConfirmed(
          { phone: req.user.phone, name: customer?.name, fcm_token: customer?.fcm_token },
          result.job
        );
      }).catch(() => {});
      return sendSuccess(res, result, 'Booking created successfully', 201);
    } catch (err) {
      next(err);
    }
  },

  // GET /api/v1/bookings/my
  getMyBookings: async (req, res, next) => {
    try {
      const bookings = await BookingService.getMyBookings(req.user.id);
      return sendSuccess(res, { bookings });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/v1/bookings/:id
  getBooking: async (req, res, next) => {
    try {
      const booking = await BookingService.getBooking(
        req.params.id,
        req.user.id,
        req.user.role
      );
      return sendSuccess(res, { booking });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/v1/bookings (admin only)
  getAllBookings: async (req, res, next) => {
    try {
      const { status, date, limit, offset } = req.query;
      const bookings = await BookingService.getAllBookings({
        status,
        date,
        limit: parseInt(limit) || 20,
        offset: parseInt(offset) || 0,
      });
      return sendSuccess(res, { bookings });
    } catch (err) {
      next(err);
    }
  },

  // PATCH /api/v1/bookings/:id/confirm (admin only)
  confirmBooking: async (req, res, next) => {
    try {
      const booking = await BookingService.updateBookingStatus(req.params.id, 'confirmed');
      return sendSuccess(res, { booking });
    } catch (err) {
      next(err);
    }
  },

  // PATCH /api/v1/bookings/:id/cancel
  cancelBooking: async (req, res, next) => {
    try {
      const result = await BookingService.cancelBooking(
        req.params.id,
        req.user.id,
        req.user.role
      );
      return sendSuccess(res, result);
    } catch (err) {
      next(err);
    }
  },

};

module.exports = BookingController;