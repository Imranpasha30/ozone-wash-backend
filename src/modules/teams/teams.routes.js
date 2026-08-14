const express = require('express');
const Controller = require('./teams.controller');
const { authenticate, requireRole } = require('../../middleware/auth.middleware');

/**
 * @swagger
 * tags:
 *   name: Teams,
 *   description: >
 *     Field team management — create teams, assign leaders, manage member shares.
 *
 * Endpoints in this module:
 *   GET   /me
 *   POST  /
 *   GET   /
 *   GET   /:id
 *   PATCH /:id
 *   DELETE/:id
 *   POST  /:id/members
 *   DELETE/:id/members/:agentId
 *   PATCH /:id/members/:agentId/share
 */


const router = express.Router();

// Field-team-facing — agent can see which team they belong to.
router.get('/me', authenticate, requireRole('field_team'), Controller.myTeam);

// Admin-only — team CRUD + membership management.
router.post('/',                              authenticate, requireRole('admin'), Controller.create);
router.get('/',                               authenticate, requireRole('admin'), Controller.list);
router.get('/:id',                            authenticate, requireRole('admin'), Controller.detail);
router.patch('/:id',                          authenticate, requireRole('admin'), Controller.update);
router.delete('/:id',                         authenticate, requireRole('admin'), Controller.remove);
router.post('/:id/members',                   authenticate, requireRole('admin'), Controller.addMember);
router.delete('/:id/members/:agentId',        authenticate, requireRole('admin'), Controller.removeMember);
router.patch('/:id/members/:agentId/share',   authenticate, requireRole('admin'), Controller.updateShare);

module.exports = router;
