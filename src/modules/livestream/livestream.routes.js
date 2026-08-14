const express = require('express');
const LivestreamController = require('./livestream.controller');
const { authenticate } = require('../../middleware/auth.middleware');

/**
 * @swagger
 * tags:
 *   name: Livestream,
 *   description: >
 *     Agora-based live cleaning streams (field broadcasts, customer watches).
 *
 * Endpoints in this module:
 *   GET   /token
 */


const router = express.Router();

// GET /api/v1/livestream/token — field team (publisher) or customer (subscriber)
router.get('/token', authenticate, LivestreamController.getToken);

module.exports = router;
