/**
 * Field Ops routes — Field App SOP v2 endpoints.
 *
 * ROLE MAP (strict):
 *   field_team  → van checks, gas checks, ozone sessions, water readings,
 *                 damage log, payment collection, closeout, daily MIS
 *   customer    → comparison view (own jobs only)
 *   admin       → comparison view + readings (oversight)
 *
 * Safety gates return HTTP 423 (Locked) with retry_after_minutes where the
 * spec demands a wait-and-recheck loop (G-6, G-7, G-8, G-10).
 */
const express = require('express');
const FieldOpsService = require('./field-ops.service');
const { authenticate, requireRole } = require('../../middleware/auth.middleware');
const { sendSuccess, sendError } = require('../../utils/response');

/**
 * @swagger
 * tags:
 *   name: FieldOps,
 *   description: >
 *     Field App SOP v2 — van checks (G-0), gas checks (G-3), water readings (G-4/G-9/G-10), ozone sessions (G-5..G-8), closure. All field_team-role gated; safety gates return HTTP 423 with retry_after_minutes.
 *
 * Endpoints in this module:
 *   GET   /van-check/today
 *   POST  /van-check
 *   POST  /van-check/post-job-o2
 *   POST  /jobs/:id/gas-check
 *   POST  /jobs/:id/pre-ozone-checklist
 *   POST  /jobs/:id/ozone/start
 *   POST  /jobs/:id/ozone/extend
 *   POST  /jobs/:id/ozone/stop
 *   POST  /jobs/:id/ozone/fan
 *   POST  /jobs/:id/ozone/safety-reading
 *   GET   /jobs/:id/ozone
 *   POST  /jobs/:id/readings
 *   GET   /jobs/:id/readings
 *   GET   /jobs/:id/comparison
 *   POST  /jobs/:id/confirm-tank
 *   POST  /jobs/:id/pre-damage
 *   POST  /jobs/:id/collect-payment
 *   POST  /jobs/:id/closeout
 *   POST  /daily-mis
 */


const router = express.Router();

const h = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (e) {
    if (e?.status) {
      const body = { success: false, message: e.message };
      if (e.retry_after_minutes) body.retry_after_minutes = e.retry_after_minutes;
      return res.status(e.status).json(body);
    }
    next(e);
  }
};

/* ── Van checks (Phase 0 — G-0) ─────────────────────────────────── */
router.get('/van-check/today', authenticate, requireRole('field_team'), h(async (req, res) => {
  const vc = await FieldOpsService.getTodayVanCheck(req.user.id);
  sendSuccess(res, { van_check: vc, equipment_items: FieldOpsService.VAN_EQUIPMENT_ITEMS });
}));

router.post('/van-check', authenticate, requireRole('field_team'), h(async (req, res) => {
  const vc = await FieldOpsService.upsertVanCheck(req.user.id, req.body);
  sendSuccess(res, { van_check: vc }, vc.van_check_complete ? 'Van check complete — jobs unlocked' : 'Van check saved');
}));

router.post('/van-check/post-job-o2', authenticate, requireRole('field_team'), h(async (req, res) => {
  const out = await FieldOpsService.logPostJobO2(req.user.id, req.body.o2_pressure_bar);
  sendSuccess(res, out);
}));

/* ── Safety checks (G-3 gas / G-5 pre-ozone) ────────────────────── */
router.post('/jobs/:id/gas-check', authenticate, requireRole('field_team'), h(async (req, res) => {
  const out = await FieldOpsService.submitGasCheck(req.user.id, req.params.id, req.body);
  sendSuccess(res, out, out.result === 'PASS' ? 'Gas check PASSED' : 'Gas check FAILED — ventilate and recheck');
}));

router.post('/jobs/:id/pre-ozone-checklist', authenticate, requireRole('field_team'), h(async (req, res) => {
  const out = await FieldOpsService.submitPreOzoneChecklist(req.user.id, req.params.id, req.body.checklist || req.body);
  sendSuccess(res, out, 'Pre-ozone safety confirmed — Start Ozone unlocked');
}));

/* ── Ozone sessions (Phase 4 — G-5..G-8) ────────────────────────── */
router.post('/jobs/:id/ozone/start', authenticate, requireRole('field_team'), h(async (req, res) => {
  const out = await FieldOpsService.startOzoneSession(req.user.id, req.params.id, req.body);
  sendSuccess(res, out, 'Ozone session started');
}));

router.post('/jobs/:id/ozone/extend', authenticate, requireRole('field_team'), h(async (req, res) => {
  const out = await FieldOpsService.extendOzoneSession(req.user.id, req.params.id, req.body);
  sendSuccess(res, out, 'Ozone timer extended');
}));

router.post('/jobs/:id/ozone/stop', authenticate, requireRole('field_team'), h(async (req, res) => {
  const out = await FieldOpsService.stopOzoneSession(req.user.id, req.params.id);
  sendSuccess(res, out, 'Generator stopped — venting started');
}));

router.post('/jobs/:id/ozone/fan', authenticate, requireRole('field_team'), h(async (req, res) => {
  const out = await FieldOpsService.confirmFan(req.user.id, req.params.id);
  sendSuccess(res, out, 'Fan confirmed — 15-minute venting lock running');
}));

router.post('/jobs/:id/ozone/safety-reading', authenticate, requireRole('field_team'), h(async (req, res) => {
  const out = await FieldOpsService.submitOzoneSafetyReading(req.user.id, req.params.id, req.body);
  sendSuccess(res, out, out.refill_unlocked ? 'Both safety readings PASSED — refill unlocked' : 'Reading recorded');
}));

router.get('/jobs/:id/ozone', authenticate, requireRole('field_team', 'admin'), h(async (req, res) => {
  const session = await FieldOpsService.activeSession(req.params.id);
  sendSuccess(res, { session });
}));

/* ── Water readings (Phases 2 & 5 — G-4/G-9/G-10) ───────────────── */
router.post('/jobs/:id/readings', authenticate, requireRole('field_team'), h(async (req, res) => {
  const out = await FieldOpsService.submitReading(req.user.id, req.params.id, req.body);
  sendSuccess(res, out, 'Reading recorded');
}));

router.get('/jobs/:id/readings', authenticate, requireRole('field_team', 'admin', 'customer'), h(async (req, res) => {
  // Customers may only read their own job's readings
  if (req.user.role === 'customer') {
    const JobRepository = require('../jobs/job.repository');
    const job = await JobRepository.findById(req.params.id);
    if (!job || job.customer_id !== req.user.id) return sendError(res, 'Access denied', 403);
  }
  const out = await FieldOpsService.getReadings(req.params.id);
  sendSuccess(res, out);
}));

/* ── Comparison view (step 7.1 — customer + field + admin) ──────── */
router.get('/jobs/:id/comparison', authenticate, h(async (req, res) => {
  const out = await FieldOpsService.comparisonView(req.params.id, req.user.id, req.user.role);
  sendSuccess(res, out);
}));

/* ── Arrival & closure ──────────────────────────────────────────── */
router.post('/jobs/:id/confirm-tank', authenticate, requireRole('field_team'), h(async (req, res) => {
  const out = await FieldOpsService.confirmTank(req.user.id, req.params.id, req.body);
  sendSuccess(res, out, out.changed ? 'Tank corrected — admin alerted for repricing' : 'Tank details confirmed');
}));

router.post('/jobs/:id/pre-damage', authenticate, requireRole('field_team'), h(async (req, res) => {
  const out = await FieldOpsService.logPreDamage(req.user.id, req.params.id, req.body);
  sendSuccess(res, out, 'Damage log saved');
}));

router.post('/jobs/:id/collect-payment', authenticate, requireRole('field_team'), h(async (req, res) => {
  const out = await FieldOpsService.collectPayment(req.user.id, req.params.id, req.body);
  sendSuccess(res, out, out.already_paid ? 'Pre-paid — skipped' : 'Payment collected');
}));

router.post('/jobs/:id/closeout', authenticate, requireRole('field_team'), h(async (req, res) => {
  const out = await FieldOpsService.logCloseout(req.user.id, req.params.id, req.body);
  sendSuccess(res, out, 'Closeout saved');
}));

router.post('/daily-mis', authenticate, requireRole('field_team'), h(async (req, res) => {
  const out = await FieldOpsService.submitDailyMis(req.user.id);
  sendSuccess(res, { mis: out }, 'Daily MIS submitted');
}));

module.exports = router;
