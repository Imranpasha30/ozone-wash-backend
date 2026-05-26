/**
 * Field-team service. Wraps the repo with validation + business rules.
 *
 * Rules:
 *   - Leader must be a field_team-role user.
 *   - Leader is automatically added as a member with role='leader'.
 *   - At most one ACTIVE membership per agent (DB-enforced).
 *   - Removing the leader is allowed only after another member is promoted.
 *   - share_pct is relative (e.g. 60/40); engine normalizes at payout.
 */
const TeamsRepository = require('./teams.repository');
const db = require('../../config/db');

async function ensureFieldAgent(userId) {
  const { rows } = await db.query(`SELECT id, role FROM users WHERE id = $1`, [userId]);
  if (!rows[0]) throw { status: 404, message: 'User not found.' };
  if (rows[0].role !== 'field_team') {
    throw { status: 400, message: 'Only field-team users can join a team.' };
  }
  return rows[0];
}

const TeamsService = {
  createTeam: async ({ name, leader_id, description, created_by }) => {
    if (!name?.trim()) throw { status: 400, message: 'Team name is required.' };
    if (!leader_id)     throw { status: 400, message: 'Leader is required.' };
    await ensureFieldAgent(leader_id);

    const team = await TeamsRepository.create({
      name: name.trim(),
      leader_id,
      description,
      created_by,
    });
    // Auto-add leader as a 'leader' member with a slightly higher default share.
    await TeamsRepository.addMember({
      team_id: team.id,
      agent_id: leader_id,
      role: 'leader',
      share_pct: 120,  // leader gets 20% more than a default member
    });
    return TeamsRepository.findById(team.id);
  },

  listTeams: ({ activeOnly = true } = {}) =>
    TeamsRepository.list({ activeOnly }),

  getTeamDetail: async (id) => {
    const team = await TeamsRepository.findById(id);
    if (!team) throw { status: 404, message: 'Team not found.' };
    const members = await TeamsRepository.listMembers(id);
    return { ...team, members };
  },

  updateTeam: async (id, payload) => {
    if (payload.leader_id) {
      await ensureFieldAgent(payload.leader_id);
      // Make sure new leader is on the team — auto-add as leader if not.
      const members = await TeamsRepository.listMembers(id);
      if (!members.some((m) => m.agent_id === payload.leader_id)) {
        await TeamsRepository.addMember({
          team_id: id, agent_id: payload.leader_id, role: 'leader', share_pct: 120,
        });
      } else {
        // Demote everyone else from 'leader' role (only one leader at a time).
        await db.query(
          `UPDATE field_team_members
              SET role = CASE WHEN agent_id = $2 THEN 'leader' ELSE 'member' END
            WHERE team_id = $1 AND is_active = TRUE`,
          [id, payload.leader_id]
        );
      }
    }
    const updated = await TeamsRepository.update(id, payload);
    if (!updated) throw { status: 404, message: 'Team not found.' };
    return TeamsService.getTeamDetail(id);
  },

  deactivateTeam: async (id) => {
    const removed = await TeamsRepository.remove(id);
    if (!removed) throw { status: 404, message: 'Team not found.' };
    return removed;
  },

  addMember: async ({ team_id, agent_id, share_pct, transfer = false }) => {
    await ensureFieldAgent(agent_id);
    const team = await TeamsRepository.findById(team_id);
    if (!team) throw { status: 404, message: 'Team not found.' };
    if (!team.is_active) throw { status: 400, message: 'Team is deactivated.' };

    // If agent is already in a different ACTIVE team, either transfer them
    // (deactivate the old membership first) or refuse — depending on the
    // `transfer` flag the admin passed.
    const existing = await TeamsRepository.findTeamForAgent(agent_id);
    if (existing && existing.id !== team_id) {
      if (!transfer) {
        throw {
          status: 409,  // 409 Conflict — frontend uses this to prompt for confirmation
          message: `Agent is already in team "${existing.name}".`,
          existing_team: { id: existing.id, name: existing.name },
        };
      }
      // Same constraint as removeMember — can't strip the leader unless
      // the admin promotes someone else first (via the team-update path).
      if (existing.leader_id === agent_id) {
        throw {
          status: 400,
          message: `${existing.name} would lose its leader. Promote another member first.`,
        };
      }
      await TeamsRepository.removeMember(existing.id, agent_id);
    }
    return TeamsRepository.addMember({
      team_id, agent_id,
      role: 'member',
      share_pct: share_pct || 100,
    });
  },

  removeMember: async (teamId, agentId) => {
    const team = await TeamsRepository.findById(teamId);
    if (!team) throw { status: 404, message: 'Team not found.' };
    if (team.leader_id === agentId) {
      throw {
        status: 400,
        message: 'Cannot remove the team leader. Promote another member first via PATCH /teams/:id.',
      };
    }
    const removed = await TeamsRepository.removeMember(teamId, agentId);
    if (!removed) throw { status: 404, message: 'Member not found in this team.' };
    return removed;
  },

  updateMemberShare: async (teamId, agentId, share_pct) => {
    if (!share_pct || share_pct < 1 || share_pct > 1000) {
      throw { status: 400, message: 'share_pct must be between 1 and 1000.' };
    }
    const updated = await TeamsRepository.updateMemberShare(teamId, agentId, share_pct);
    if (!updated) throw { status: 404, message: 'Member not found in this team.' };
    return updated;
  },

  getMyTeam: (agentId) => TeamsRepository.findTeamForAgent(agentId),
};

module.exports = TeamsService;
