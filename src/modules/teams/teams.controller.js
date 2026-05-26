const Service = require('./teams.service');
const { sendSuccess } = require('../../utils/response');

const TeamsController = {
  // POST /api/v1/teams                           (admin)
  create: async (req, res, next) => {
    try {
      const team = await Service.createTeam({
        name: req.body.name,
        leader_id: req.body.leader_id,
        description: req.body.description,
        // req.user.id is admin.id when admin token (auth middleware patches this)
        created_by: req.user?.id || null,
      });
      return sendSuccess(res, { team }, 'Team created', 201);
    } catch (err) { next(err); }
  },

  // GET /api/v1/teams?inactive=0|1               (admin)
  list: async (req, res, next) => {
    try {
      const activeOnly = req.query.inactive !== '1' && req.query.inactive !== 'true';
      const teams = await Service.listTeams({ activeOnly });
      return sendSuccess(res, { teams });
    } catch (err) { next(err); }
  },

  // GET /api/v1/teams/:id                        (admin)
  detail: async (req, res, next) => {
    try {
      const team = await Service.getTeamDetail(req.params.id);
      return sendSuccess(res, { team });
    } catch (err) { next(err); }
  },

  // PATCH /api/v1/teams/:id                      (admin)
  update: async (req, res, next) => {
    try {
      const team = await Service.updateTeam(req.params.id, req.body);
      return sendSuccess(res, { team }, 'Team updated');
    } catch (err) { next(err); }
  },

  // DELETE /api/v1/teams/:id                     (admin) — soft-deactivate
  remove: async (req, res, next) => {
    try {
      const team = await Service.deactivateTeam(req.params.id);
      return sendSuccess(res, { team }, 'Team deactivated');
    } catch (err) { next(err); }
  },

  // POST /api/v1/teams/:id/members               (admin)
  // Pass body.transfer=true to move the agent from any current team.
  addMember: async (req, res, next) => {
    try {
      const member = await Service.addMember({
        team_id: req.params.id,
        agent_id: req.body.agent_id,
        share_pct: req.body.share_pct,
        transfer: !!req.body.transfer,
      });
      return sendSuccess(res, { member }, 'Member added', 201);
    } catch (err) { next(err); }
  },

  // DELETE /api/v1/teams/:id/members/:agentId    (admin)
  removeMember: async (req, res, next) => {
    try {
      const member = await Service.removeMember(req.params.id, req.params.agentId);
      return sendSuccess(res, { member }, 'Member removed');
    } catch (err) { next(err); }
  },

  // PATCH /api/v1/teams/:id/members/:agentId/share  (admin)
  updateShare: async (req, res, next) => {
    try {
      const member = await Service.updateMemberShare(
        req.params.id, req.params.agentId, req.body.share_pct,
      );
      return sendSuccess(res, { member }, 'Share updated');
    } catch (err) { next(err); }
  },

  // GET /api/v1/teams/me                         (field_team)
  myTeam: async (req, res, next) => {
    try {
      const team = await Service.getMyTeam(req.user.id);
      return sendSuccess(res, { team });
    } catch (err) { next(err); }
  },
};

module.exports = TeamsController;
