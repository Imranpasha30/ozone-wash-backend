const express = require('express');
const path = require('path');
const CertificateController = require('./certificate.controller');
const { authenticate, requireRole } = require('../../middleware/auth.middleware');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Certificates
 *   description: Digital hygiene certificate generation and verification
 */

/**
 * @swagger
 * /certificates/generate:
 *   post:
 *     summary: Generate hygiene certificate for a completed job
 *     tags: [Certificates]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [job_id]
 *             properties:
 *               job_id:
 *                 type: string
 *                 example: "d858bb65-e918-4bea-93eb-9d4a38ba3d3f"
 *     responses:
 *       200:
 *         description: Certificate generated with PDF URL and QR code
 *       400:
 *         description: Job not completed or EcoScore missing
 *
 * /certificates/job/{jobId}:
 *   get:
 *     summary: Get certificate for a job
 *     tags: [Certificates]
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
 *         description: Certificate details
 *       404:
 *         description: Certificate not found
 *
 * /certificates/verify/{certId}:
 *   get:
 *     summary: Verify certificate authenticity (PUBLIC — no login needed)
 *     tags: [Certificates]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: certId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Certificate verification result
 *
 * /certificates/{certId}/revoke:
 *   patch:
 *     summary: Revoke a certificate (admin only)
 *     tags: [Certificates]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: certId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reason]
 *             properties:
 *               reason:
 *                 type: string
 *                 example: "Incorrect data entered by field team"
 *     responses:
 *       200:
 *         description: Certificate revoked
 */

// Public route — no auth needed (for QR code scanning)
router.get('/verify/:certId', CertificateController.verifyCertificate);

// Protected routes
router.post('/generate', authenticate, requireRole('field_team', 'admin'), CertificateController.generate);
router.get('/job/:jobId', authenticate, CertificateController.getCertificate);
router.patch('/:certId/revoke', authenticate, requireRole('admin'), CertificateController.revokeCertificate);

module.exports = router;