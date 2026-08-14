/**
 * In-app notification feed — backs the Notifications screen (web + app).
 *
 * The screen shows UNREAD only; marking read removes the item from the list.
 * Rows are written by NotificationService.sendInApp/notifyUser at every
 * customer-facing notification site (OTP, crew departed, step progress,
 * certificate ready, reminders). Works for any authenticated role.
 */
const express = require('express');
const { param, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth.middleware');
const { sendSuccess, sendError } = require('../utils/response');
const db = require('../config/db');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return sendError(res, 'Invalid request.', 400);
  next();
};

const handle = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// GET /notifications — unread items, newest first
router.get('/', authenticate, handle(async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, title, body, data, created_at
       FROM in_app_notifications
      WHERE user_id = $1 AND NOT read
      ORDER BY created_at DESC
      LIMIT 50`,
    [req.user.id]
  );
  sendSuccess(res, { notifications: rows, unread: rows.length });
}));

// PUT /notifications/read-all — clear the whole list
router.put('/read-all', authenticate, handle(async (req, res) => {
  await db.query(
    `UPDATE in_app_notifications SET read = TRUE WHERE user_id = $1 AND NOT read`,
    [req.user.id]
  );
  sendSuccess(res, { cleared: true });
}));

// PUT /notifications/:id/read — tapping an item removes it
router.put('/:id/read', authenticate, [param('id').isUUID(), validate], handle(async (req, res) => {
  await db.query(
    `UPDATE in_app_notifications SET read = TRUE WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.user.id]
  );
  sendSuccess(res, { read: true });
}));

module.exports = router;
