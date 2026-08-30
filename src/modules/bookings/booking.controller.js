const { validationResult } = require('express-validator');
const BookingService = require('./booking.service');
const NotificationService = require('../../services/notification.service');
const AuthRepository = require('../auth/auth.repository');
const PricingService = require('../../services/pricing');
const EcoScoreService = require('../ecoscore/ecoscore.service');
const { sendSuccess, sendError } = require('../../utils/response');

const BookingController = {

  // GET /api/v1/bookings/slots?date=2026-03-24
  //   &tank_sizes=15000,5000&locations=2   → DYNAMIC capacity-aware slots:
  //   duration = Σ per-tank clean minutes (admin-set, by size) + travel
  //   buffer × (locations−1); a slot shows only while a van is free for the
  //   whole window. Legacy fixed slots kept when no tank params are sent.
  getSlots: async (req, res, next) => {
    try {
      const { date, tank_sizes, locations } = req.query;
      if (!date) {
        return sendError(res, 'Date is required. Format: YYYY-MM-DD', 400);
      }

      if (tank_sizes) {
        const SchedulingService = require('../../services/scheduling.service');
        const sizes = String(tank_sizes).split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0);
        const out = await SchedulingService.slotsForDate(date, sizes, locations ? Number(locations) : null, 'tank');
        return sendSuccess(res, out);
      }

      const slots = await BookingService.getAvailableSlots(date);
      return sendSuccess(res, { slots });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/v1/bookings/price
  //   ?tank_size_litres=2000&tank_count=1&plan=quarterly             (matrix mode — preferred)
  //   ?tank_type=overhead&tank_size_litres=500&addons=lime_treatment (legacy add-ons mode)
  //
  // When `plan` is provided, returns the authoritative matrix price for the
  // chosen tier × plan × tank_count. When `plan` is omitted we fall back to
  // the legacy one-time-with-addons calculator so older clients keep working.
  getPrice: async (req, res, next) => {
    try {
      const { tank_type, tank_size_litres, addons, plan, tank_count } = req.query;
      const litres = parseFloat(tank_size_litres) || 0;

      // ── New mode: full invoice quote (spec §5 master formula) ─────────
      // ?plan=quarterly&tank_size_litres=15000&tank_count=2
      // ?plan=quarterly&tank_sizes=15000,5000&addons=uv_sterilization,anti_lime
      // Per-tank rates come from the admin-editable pricing matrix; add-ons
      // from tank_addons buckets. All figures GST-inclusive.
      if (plan) {
        const sizesCsv = req.query.tank_sizes;
        const tanksList = sizesCsv
          ? sizesCsv.split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0)
          : Array(parseInt(tank_count, 10) || 1).fill(litres);
        const addonList = addons ? addons.split(',').filter(Boolean) : [];

        const quote = await PricingService.quoteInvoice({
          tanks: tanksList,
          plan,
          addon_codes: addonList,
        });

        const pricing = {
          ...quote,
          billing_version: 2,
          // Legacy keys so existing clients keep parsing this as "pricing"
          base_price: Math.round(quote.annual_service_total_paise / 100),
          per_service_price: Math.round(quote.per_service_total_paise / 100),
          addon_total: Math.round(quote.addons_total_paise / 100),
          subtotal: Math.round(quote.ex_gst_paise / 100),
          gst: Math.round(quote.gst_paise / 100),
          grand_total: Math.round(quote.invoice_total_paise / 100),
          amount_paise: quote.invoice_total_paise,
          amc_covered: false,
        };
        return sendSuccess(res, { pricing });
      }

      // ── Legacy mode: tank_type + addons one-time pricing ──────────────
      const addonList = addons ? addons.split(',') : [];
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
        litres || 500,
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
      // EcoScore: refresh customer's rolling score (fire-and-forget — never block)
      EcoScoreService.recalcOnEvent({
        event: 'booking_created',
        user_id: req.user.id,
        ref: result?.booking?.id,
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