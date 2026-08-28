const express = require('express');
const InvoiceController = require('./invoice.controller');
const { authenticate, requireRole } = require('../../middleware/auth.middleware');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Invoices
 *   description: GST tax invoices for bookings and AMC contracts
 */

// ── Admin (declare BEFORE '/:id' so these literals aren't captured as ids) ──
router.get('/', authenticate, requireRole('admin'), InvoiceController.listInvoices);
router.get('/tax-summary', authenticate, requireRole('admin'), InvoiceController.getTaxSummary);

// ── Customer ────────────────────────────────────────────────────────────
router.get('/my', authenticate, requireRole('customer'), InvoiceController.getMyInvoices);

// ── Owner-or-admin ──────────────────────────────────────────────────────
router.get('/:id', authenticate, InvoiceController.getInvoice);
router.get('/:id/pdf', authenticate, InvoiceController.getInvoicePdf);
router.post('/:id/regenerate', authenticate, requireRole('admin'), InvoiceController.regenerate);

module.exports = router;
