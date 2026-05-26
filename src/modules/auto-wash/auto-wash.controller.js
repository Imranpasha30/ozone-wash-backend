/**
 * HTTP layer for the Auto Wash module.
 * Errors thrown as { status, message } are converted to error responses by
 * the global error handler. Other thrown errors → 500.
 */

const service = require('./auto-wash.service');
const { sendSuccess, sendError } = require('../../utils/response');

const AutoWashController = {

  /* ── Catalog (public) ─────────────────────────────────────────────────── */

  listPackages: async (req, res, next) => {
    try { return sendSuccess(res, { packages: await service.getPackages() }); }
    catch (e) { next(e); }
  },

  listAddons: async (req, res, next) => {
    try { return sendSuccess(res, { addons: await service.getAddons() }); }
    catch (e) { next(e); }
  },

  listSubscriptionPlans: async (req, res, next) => {
    try { return sendSuccess(res, { plans: await service.getSubscriptionPlans() }); }
    catch (e) { next(e); }
  },

  quote: async (req, res, next) => {
    try {
      const { vehicle_type, package_code, addon_codes, subscription_code } = req.body;
      const q = await service.quotePrice({
        vehicle_type, package_code,
        addon_codes: addon_codes || [],
        subscription_code: subscription_code || null,
      });
      return sendSuccess(res, q);
    } catch (e) { next(e); }
  },

  /* ── Vehicles (customer) ──────────────────────────────────────────────── */

  addVehicle: async (req, res, next) => {
    try {
      const v = await service.addVehicle(req.user.id, req.body);
      return sendSuccess(res, { vehicle: v }, 'Vehicle added');
    } catch (e) { next(e); }
  },

  listVehicles: async (req, res, next) => {
    try { return sendSuccess(res, { vehicles: await service.listVehicles(req.user.id) }); }
    catch (e) { next(e); }
  },

  updateVehicle: async (req, res, next) => {
    try {
      const v = await service.updateVehicle(req.user.id, req.params.id, req.body);
      return sendSuccess(res, { vehicle: v }, 'Vehicle updated');
    } catch (e) { next(e); }
  },

  deleteVehicle: async (req, res, next) => {
    try {
      await service.deleteVehicle(req.user.id, req.params.id);
      return sendSuccess(res, null, 'Vehicle deleted');
    } catch (e) { next(e); }
  },

  /* ── Bookings (customer) ──────────────────────────────────────────────── */

  createBooking: async (req, res, next) => {
    try {
      const result = await service.createBooking({
        customer_id: req.user.id,
        vehicle_id: req.body.vehicle_id,
        package_code: req.body.package_code,
        addon_codes: req.body.addon_codes || [],
        scheduled_at: req.body.scheduled_at,
        location_lat: req.body.location_lat,
        location_lng: req.body.location_lng,
        location_address: req.body.location_address,
        gated_community: !!req.body.gated_community,
        notes: req.body.notes,
        subscription_code: req.body.subscription_code || null,
        additional_stops: Array.isArray(req.body.additional_stops) ? req.body.additional_stops : [],
      });
      return sendSuccess(res, result, 'Booking created');
    } catch (e) { next(e); }
  },

  getBookingById: async (req, res, next) => {
    try {
      const result = await service.getBookingById(req.user.id, req.params.id);
      return sendSuccess(res, result);
    } catch (e) { next(e); }
  },

  bookingHistory: async (req, res, next) => {
    try {
      const limit  = Math.min(parseInt(req.query.limit, 10) || 25, 100);
      const offset = parseInt(req.query.offset, 10) || 0;
      const jobs = await service.listBookingHistory(req.user.id, { limit, offset });
      return sendSuccess(res, { jobs, limit, offset });
    } catch (e) { next(e); }
  },

  /* ── Field crew flow ──────────────────────────────────────────────────── */

  jobsToday: async (req, res, next) => {
    try { return sendSuccess(res, { jobs: await service.listJobsForCrewToday(req.user.id) }); }
    catch (e) { next(e); }
  },

  preInspection: async (req, res, next) => {
    try {
      const r = await service.uploadPreInspection(req.user.id, req.params.id, req.body.photo_urls);
      return sendSuccess(res, r, 'Pre-inspection uploaded');
    } catch (e) { next(e); }
  },

  startStep: async (req, res, next) => {
    try {
      const stepNo = parseInt(req.params.step_no, 10);
      const r = await service.startStep(req.user.id, req.params.id, stepNo);
      return sendSuccess(res, { step: r }, `Step ${stepNo} started`);
    } catch (e) { next(e); }
  },

  endStep: async (req, res, next) => {
    try {
      const stepNo = parseInt(req.params.step_no, 10);
      const r = await service.endStep(req.user.id, req.params.id, stepNo, req.body);
      return sendSuccess(res, { step: r }, `Step ${stepNo} complete`);
    } catch (e) { next(e); }
  },

  completeJob: async (req, res, next) => {
    try {
      const r = await service.completeJob(req.user.id, req.params.id, req.body);
      return sendSuccess(res, r, 'Job completed, certificate issued');
    } catch (e) { next(e); }
  },

  /* ── Public verify ────────────────────────────────────────────────────── */

  verifyCertificate: async (req, res, next) => {
    try {
      const cert = await service.verifyCertificate(req.params.qr_token);
      return sendSuccess(res, { certificate: cert });
    } catch (e) { next(e); }
  },

  /* ── Subscriptions (customer) ─────────────────────────────────────────── */

  createSubscription: async (req, res, next) => {
    try {
      const r = await service.createSubscription(req.user.id, {
        plan_type: req.body.plan_type,
        vehicle_ids: req.body.vehicle_ids,
      });
      return sendSuccess(res, { subscription: r }, 'Subscription created');
    } catch (e) { next(e); }
  },

  activeSubscription: async (req, res, next) => {
    try {
      const sub = await service.getActiveSubscription(req.user.id);
      return sendSuccess(res, { subscription: sub });
    } catch (e) { next(e); }
  },

  pauseSubscription: async (req, res, next) => {
    try {
      const pauseUntil = req.body.pause_until;
      if (!pauseUntil) throw { status: 400, message: 'pause_until is required' };
      const r = await service.pauseSubscription(req.user.id, req.params.id, pauseUntil);
      return sendSuccess(res, { subscription: r }, 'Subscription paused');
    } catch (e) { next(e); }
  },

  cancelSubscription: async (req, res, next) => {
    try {
      const r = await service.cancelSubscription(req.user.id, req.params.id);
      return sendSuccess(res, { subscription: r }, 'Subscription cancelled');
    } catch (e) { next(e); }
  },

  /* ── Admin ────────────────────────────────────────────────────────────── */

  listEvUnits: async (req, res, next) => {
    try { return sendSuccess(res, { ev_units: await service.listEvUnits() }); }
    catch (e) { next(e); }
  },

  adminDashboard: async (req, res, next) => {
    try { return sendSuccess(res, await service.adminDashboard()); }
    catch (e) { next(e); }
  },

  adminListJobs: async (req, res, next) => {
    try {
      const limit  = Math.min(parseInt(req.query.limit, 10)  || 100, 500);
      const offset = parseInt(req.query.offset, 10) || 0;
      const jobs = await service.adminListJobs({
        status: req.query.status || null,
        fromDate: req.query.from || null,
        toDate: req.query.to || null,
        limit, offset,
      });
      return sendSuccess(res, { jobs, limit, offset });
    } catch (e) { next(e); }
  },

  adminAssignJob: async (req, res, next) => {
    try {
      const { crew_id, ev_unit_id } = req.body;
      if (!crew_id) throw { status: 400, message: 'crew_id is required' };
      const r = await service.adminAssignJob(req.params.id, crew_id, ev_unit_id || null);
      return sendSuccess(res, { job: r }, 'Job assigned');
    } catch (e) { next(e); }
  },

  adminAddonAnalytics: async (req, res, next) => {
    try {
      const fromDate = req.query.from || null;
      const rows = await service.adminAddonAnalytics({ fromDate });
      return sendSuccess(res, { analytics: rows });
    } catch (e) { next(e); }
  },
};

module.exports = AutoWashController;
