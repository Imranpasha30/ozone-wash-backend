/**
 * Rewards routes — mounted at /api/v1/rewards (see src/routes/index.js).
 *
 *   GET  /              public catalog
 *   GET  /me            authenticated — wallet + eligible rewards + history
 *   POST /redeem        authenticated — body { reward_slug }
 */

const express = require('express');
const { body } = require('express-validator');
const RewardsController = require('./rewards.controller');
const { authenticate } = require('../../middleware/auth.middleware');

const router = express.Router();

const redeemValidation = [
  body('reward_slug')
    .trim()
    .notEmpty().withMessage('reward_slug is required')
    .isLength({ max: 60 }).withMessage('reward_slug too long')
    .matches(/^[a-z0-9_]+$/).withMessage('reward_slug must be snake_case'),
];

router.get('/',        RewardsController.getCatalog);
router.get('/me',      authenticate, RewardsController.getMyRewards);
router.post('/redeem', authenticate, redeemValidation, RewardsController.redeem);

module.exports = router;
