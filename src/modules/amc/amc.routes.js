const express = require('express');
const { body } = require('express-validator');
const AmcController = require('./amc.controller');
const { authenticate, requireRole } = require('../../middleware/auth.middleware');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: AMC
 *   description: Annual Maintenance Contract management
 */

/**
 * @swagger
 * /amc/plans:
 *   get:
 *     summary: Get all AMC plan options and pricing
 *     tags: [AMC]
 *     security: []
 *     responses:
 *       200:
 *         description: List of AMC plans with pricing
 *
 * /amc/contracts:
 *   post:
 *     summary: Create a new AMC contract
 *     tags: [AMC]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [plan_type]
 *             properties:
 *               plan_type:
 *                 type: string
 *                 example: "quarterly"
 *               tank_ids:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ["tank-001", "tank-002"]
 *               start_date:
 *                 type: string
 *                 example: "2026-03-25"
 *               sla_terms:
 *                 type: object
 *                 example: {"response_hrs": 24, "cleaning_freq": 3}
 *     responses:
 *       201:
 *         description: Contract created successfully
 *
 *   get:
 *     summary: Get all contracts (admin only)
 *     tags: [AMC]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           example: "active"
 *     responses:
 *       200:
 *         description: List of all contracts
 *
 * /amc/contracts/my:
 *   get:
 *     summary: Get my AMC contracts (customer)
 *     tags: [AMC]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Customer contracts
 *
 * /amc/contracts/{id}:
 *   get:
 *     summary: Get single contract details
 *     tags: [AMC]
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
 *         description: Contract details
 *
 * /amc/contracts/{id}/sign:
 *   post:
 *     summary: Customer signs AMC contract
 *     tags: [AMC]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [customer_esign]
 *             properties:
 *               customer_esign:
 *                 type: string
 *                 example: "data:image/png;base64,iVBORw0KGgo..."
 *     responses:
 *       200:
 *         description: Contract signed
 *
 * /amc/contracts/{id}/admin-sign:
 *   post:
 *     summary: Admin signs AMC contract
 *     tags: [AMC]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [admin_esign]
 *             properties:
 *               admin_esign:
 *                 type: string
 *                 example: "data:image/png;base64,iVBORw0KGgo..."
 *     responses:
 *       200:
 *         description: Contract signed by admin
 *
 * /amc/contracts/{id}/renew:
 *   patch:
 *     summary: Renew an AMC contract
 *     tags: [AMC]
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
 *         description: Contract renewed successfully
 *
 * /amc/contracts/{id}/cancel:
 *   patch:
 *     summary: Cancel an AMC contract (admin only)
 *     tags: [AMC]
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
 *         description: Contract cancelled
 *
 * /amc/expiring:
 *   get:
 *     summary: Get contracts expiring soon (admin)
 *     tags: [AMC]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: days
 *         schema:
 *           type: integer
 *           example: 30
 *     responses:
 *       200:
 *         description: Contracts expiring within X days
 *
 * /amc/sla-breaches:
 *   get:
 *     summary: Get SLA breaches (admin)
 *     tags: [AMC]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of SLA breaches
 */

// Validation
const createContractValidation = [
  body('plan_type')
    .notEmpty().withMessage('Plan type is required')
    .isIn(['monthly', 'bimonthly', 'quarterly', '4month', 'halfyearly', 'yearly'])
    .withMessage('Invalid plan type'),
  body('tank_ids')
    .optional()
    .isArray().withMessage('Tank IDs must be an array'),
  body('start_date')
    .optional()
    .isISO8601().withMessage('Invalid start date format'),
];

// Public routes
router.get('/plans', AmcController.getPlans);

// Customer routes
router.post('/contracts', authenticate, requireRole('customer'), createContractValidation, AmcController.createContract);
router.get('/contracts/my', authenticate, requireRole('customer'), AmcController.getMyContracts);
router.post('/contracts/:id/sign', authenticate, requireRole('customer'), AmcController.signContract);
router.patch('/contracts/:id/renew', authenticate, AmcController.renewContract);

// Admin routes
router.get('/contracts', authenticate, requireRole('admin'), AmcController.getAllContracts);
router.post('/contracts/:id/admin-sign', authenticate, requireRole('admin'), AmcController.adminSignContract);
router.patch('/contracts/:id/cancel', authenticate, requireRole('admin'), AmcController.cancelContract);
router.get('/expiring', authenticate, requireRole('admin'), AmcController.getExpiringSoon);
router.get('/sla-breaches', authenticate, requireRole('admin'), AmcController.getSlaBreaches);

// Shared routes
router.get('/contracts/:id', authenticate, AmcController.getContract);

module.exports = router;