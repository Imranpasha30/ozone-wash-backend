const express = require('express');
const Controller = require('./admin-alerts.controller');
const { authenticate, requireRole } = require('../../middleware/auth.middleware');

const router = express.Router();

router.get('/inbox',    authenticate, requireRole('admin'), Controller.inbox);
router.get('/',         authenticate, requireRole('admin'), Controller.list);
router.get('/count',    authenticate, requireRole('admin'), Controller.count);
router.patch('/:id/ack', authenticate, requireRole('admin'), Controller.acknowledge);

module.exports = router;
