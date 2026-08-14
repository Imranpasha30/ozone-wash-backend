const express = require('express');
const { body } = require('express-validator');
const { validationResult } = require('express-validator');
const AddressService = require('./address.service');
const { authenticate } = require('../../middleware/auth.middleware');
const { sendSuccess, sendError } = require('../../utils/response');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Addresses
 *   description: Saved address book (Zomato-style, nickname labelled)
 */

const addressValidation = [
  body('label')
    .trim().notEmpty().withMessage('Nickname is required')
    .isLength({ max: 40 }).withMessage('Nickname must be under 40 characters'),
  body('address')
    .trim().notEmpty().withMessage('Address is required')
    .isLength({ min: 10, max: 500 }).withMessage('Address must be 10–500 characters'),
  body('lat').optional({ nullable: true }).isFloat({ min: -90, max: 90 }),
  body('lng').optional({ nullable: true }).isFloat({ min: -180, max: 180 }),
];

const handle = (fn) => async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return sendError(res, errors.array()[0].msg, 400);
  try { await fn(req, res); } catch (err) { next(err); }
};

// GET /addresses — my saved addresses
router.get('/', authenticate, handle(async (req, res) => {
  const addresses = await AddressService.list(req.user.id);
  sendSuccess(res, { addresses });
}));

// POST /addresses — save a new address with nickname
router.post('/', authenticate, addressValidation, handle(async (req, res) => {
  const address = await AddressService.create(req.user.id, req.body);
  sendSuccess(res, { address }, 'Address saved', 201);
}));

// PUT /addresses/:id — update an existing address
router.put('/:id', authenticate, handle(async (req, res) => {
  const address = await AddressService.update(req.user.id, req.params.id, req.body);
  sendSuccess(res, { address }, 'Address updated');
}));

// PATCH /addresses/:id/default — mark as default
router.patch('/:id/default', authenticate, handle(async (req, res) => {
  const address = await AddressService.setDefault(req.user.id, req.params.id);
  sendSuccess(res, { address }, 'Default address set');
}));

// DELETE /addresses/:id — soft delete
router.delete('/:id', authenticate, handle(async (req, res) => {
  await AddressService.remove(req.user.id, req.params.id);
  sendSuccess(res, { deleted: true }, 'Address removed');
}));

module.exports = router;
