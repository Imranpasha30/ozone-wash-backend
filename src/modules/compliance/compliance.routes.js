const express = require('express');
const { body } = require('express-validator');
const ComplianceController = require('./compliance.controller');
const { authenticate, requireRole } = require('../../middleware/auth.middleware');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Compliance
 *   description: 8-step compliance checklist for field team
 */

/**
 * @swagger
 * /compliance/{jobId}/checklist:
 *   get:
 *     summary: Get full checklist for a job
 *     tags: [Compliance]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Full 8-step checklist with completion status
 *
 * /compliance/step:
 *   post:
 *     summary: Log a compliance step
 *     tags: [Compliance]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [job_id, step_number, gps_lat, gps_lng]
 *             properties:
 *               job_id:
 *                 type: string
 *                 example: "d858bb65-e918-4bea-93eb-9d4a38ba3d3f"
 *               step_number:
 *                 type: integer
 *                 example: 1
 *               photo_before_url:
 *                 type: string
 *                 example: "https://r2.ozonewash.in/photos/before.jpg"
 *               photo_after_url:
 *                 type: string
 *                 example: "https://r2.ozonewash.in/photos/after.jpg"
 *               gps_lat:
 *                 type: number
 *                 example: 17.4126
 *               gps_lng:
 *                 type: number
 *                 example: 78.4071
 *               ozone_exposure_mins:
 *                 type: number
 *                 example: 45
 *               microbial_test_url:
 *                 type: string
 *                 example: "https://r2.ozonewash.in/tests/result.jpg"
 *               chemical_type:
 *                 type: string
 *                 example: "ozone"
 *               chemical_qty_ml:
 *                 type: number
 *                 example: 500
 *               ppe_list:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ["mask", "gloves", "boots", "suit"]
 *     responses:
 *       200:
 *         description: Step logged successfully
 *       400:
 *         description: Missing required fields or validation error
 *
 * /compliance/{jobId}/status:
 *   get:
 *     summary: Get compliance completion status
 *     tags: [Compliance]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Completion percentage and pending steps
 *
 * /compliance/{jobId}/complete:
 *   post:
 *     summary: Complete compliance — triggers certificate generation
 *     tags: [Compliance]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: All steps verified — job completed
 *       400:
 *         description: Not all steps complete — cannot proceed
 */

// Validation for logging a step
const logStepValidation = [
  body('job_id')
    .notEmpty().withMessage('Job ID is required')
    .isUUID().withMessage('Job ID must be a valid UUID'),
  body('step_number')
    .notEmpty().withMessage('Step number is required')
    .isInt({ min: 1, max: 8 }).withMessage('Step number must be between 1 and 8'),
  body('gps_lat')
    .notEmpty().withMessage('GPS latitude is required')
    .isFloat({ min: -90, max: 90 }).withMessage('Invalid latitude'),
  body('gps_lng')
    .notEmpty().withMessage('GPS longitude is required')
    .isFloat({ min: -180, max: 180 }).withMessage('Invalid longitude'),
  body('ppe_list')
    .optional()
    .isArray().withMessage('PPE list must be an array'),
  body('ozone_exposure_mins')
    .optional()
    .isFloat({ min: 0 }).withMessage('Ozone exposure must be a positive number'),
];

// Field team routes
router.post('/step', authenticate, requireRole('field_team'), logStepValidation, ComplianceController.logStep);
router.post('/:jobId/complete', authenticate, requireRole('field_team'), ComplianceController.completeCompliance);

// Shared routes (field team + admin)
router.get('/:jobId/checklist', authenticate, ComplianceController.getChecklist);
router.get('/:jobId/status', authenticate, ComplianceController.getStatus);

module.exports = router;