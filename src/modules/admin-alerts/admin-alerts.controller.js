const Service = require('./admin-alerts.service');
const InboxService = require('./inbox.service');
const { sendSuccess } = require('../../utils/response');

const AdminAlertsController = {
  // GET /api/v1/admin/alerts/inbox
  // Unified feed: alerts + pending requests + unassigned jobs.
  // The dashboard uses this single call to render the live notification panel.
  inbox: async (req, res, next) => {
    try {
      const inbox = await InboxService.getInbox();
      return sendSuccess(res, inbox);
    } catch (err) { next(err); }
  },

  // GET /api/v1/admin/alerts?unack=1
  list: async (req, res, next) => {
    try {
      const unackOnly = req.query.unack === '1' || req.query.unack === 'true';
      const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
      const alerts = await Service.listAlerts({ unackOnly, limit });
      return sendSuccess(res, { alerts });
    } catch (err) { next(err); }
  },

  // GET /api/v1/admin/alerts/count  (for the dashboard badge)
  count: async (req, res, next) => {
    try {
      const count = await Service.countUnack();
      return sendSuccess(res, { count });
    } catch (err) { next(err); }
  },

  // PATCH /api/v1/admin/alerts/:id/ack
  acknowledge: async (req, res, next) => {
    try {
      // req.user is set by authenticate middleware. Admin tokens map to
      // { id: <admin.id>, role: 'admin', admin_role, ... } per the patched
      // auth.middleware.js.
      const adminId = req.user?.id || null;
      const alert = await Service.acknowledge(req.params.id, adminId);
      return sendSuccess(res, { alert }, 'Alert acknowledged');
    } catch (err) { next(err); }
  },
};

module.exports = AdminAlertsController;
