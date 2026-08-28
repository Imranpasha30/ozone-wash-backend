const InvoiceService = require('./invoice.service');
const { sendSuccess, sendError } = require('../../utils/response');

const ownsOrAdmin = (req, invoice) =>
  req.user?.role === 'admin' || invoice.customer_id === req.user?.id;

const InvoiceController = {

  // GET /api/v1/invoices/my  (customer)
  getMyInvoices: async (req, res, next) => {
    try {
      const rows = await InvoiceService.listForCustomer(req.user.id);
      return sendSuccess(res, { invoices: rows }, 'Invoices fetched');
    } catch (err) { next(err); }
  },

  // GET /api/v1/invoices/:id  (owner or admin)
  getInvoice: async (req, res, next) => {
    try {
      const invoice = await InvoiceService.getById(req.params.id);
      if (!invoice) return sendError(res, 'Invoice not found', 404);
      if (!ownsOrAdmin(req, invoice)) return sendError(res, 'Access denied', 403);
      return sendSuccess(res, { invoice }, 'Invoice fetched');
    } catch (err) { next(err); }
  },

  // GET /api/v1/invoices/:id/pdf  (owner or admin) → redirect to stored PDF
  getInvoicePdf: async (req, res, next) => {
    try {
      const invoice = await InvoiceService.getById(req.params.id);
      if (!invoice) return sendError(res, 'Invoice not found', 404);
      if (!ownsOrAdmin(req, invoice)) return sendError(res, 'Access denied', 403);
      if (!invoice.pdf_url) {
        // Not generated yet (async gen may have failed) — regenerate on demand.
        const fresh = await InvoiceService.regeneratePdf(invoice.id);
        if (!fresh.pdf_url) return sendError(res, 'Invoice PDF is not available yet', 409);
        return res.redirect(302, fresh.pdf_url);
      }
      return res.redirect(302, invoice.pdf_url);
    } catch (err) { next(err); }
  },

  // GET /api/v1/invoices  (admin) — list with optional ?from=&to=&limit=
  listInvoices: async (req, res, next) => {
    try {
      const { from, to, limit } = req.query;
      const rows = await InvoiceService.listAll({ from, to, limit });
      return sendSuccess(res, { invoices: rows }, 'Invoices fetched');
    } catch (err) { next(err); }
  },

  // GET /api/v1/invoices/tax-summary  (admin) — GST settlement figures
  getTaxSummary: async (req, res, next) => {
    try {
      const { from, to } = req.query;
      const summary = await InvoiceService.taxSummary({ from, to });
      return sendSuccess(res, summary, 'Tax summary computed');
    } catch (err) { next(err); }
  },

  // POST /api/v1/invoices/:id/regenerate  (admin)
  regenerate: async (req, res, next) => {
    try {
      const invoice = await InvoiceService.regeneratePdf(req.params.id);
      return sendSuccess(res, { invoice }, 'Invoice PDF regenerated');
    } catch (err) {
      if (err?.status) return sendError(res, err.message, err.status);
      next(err);
    }
  },
};

module.exports = InvoiceController;
