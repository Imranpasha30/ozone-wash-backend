const express = require('express');
const LivestreamController = require('./livestream.controller');
const { authenticate } = require('../../middleware/auth.middleware');

const router = express.Router();

// GET /api/v1/livestream/token — field team (publisher) or customer (subscriber)
router.get('/token', authenticate, LivestreamController.getToken);

module.exports = router;
