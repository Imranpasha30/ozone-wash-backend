/**
 * field_teams + field_team_members repository.
 * Migration: 017_field_teams.sql
 */
const db = require('../../config/db');

const TeamsRepository = {
  // ── Teams ────────────────────────────────────────────────────────────
  create: async ({ name, leader_id, description, created_by }) => {
    const { rows } = await db.query(
      `INSERT INTO field_teams (name, leader_id, description, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name, leader_id, description || null, created_by || null]
    );
    return rows[0];
  },

  // List teams with their leader name + member count.
  list: async ({ activeOnly = true } = {}) => {
    const where = activeOnly ? 'WHERE t.is_active = TRUE' : '';
    const { rows } = await db.query(
      `SELECT t.*,
              u.name as leader_name, u.phone as leader_phone,
              (SELECT COUNT(*) FROM field_team_members m
                WHERE m.team_id = t.id AND m.is_active = TRUE)::int AS member_count
         FROM field_teams t
         JOIN users u ON u.id = t.leader_id
        ${where}
        ORDER BY t.created_at DESC`
    );
    return rows;
  },

  findById: async (id) => {
    const { rows } = await db.query(
      `SELECT t.*, u.name as leader_name, u.phone as leader_phone
         FROM field_teams t
         JOIN users u ON u.id = t.leader_id
        WHERE t.id = $1`,
      [id]
    );
    return rows[0] || null;
  },

  update: async (id, { name, leader_id, description, is_active }) => {
    const sets = [];
    const args = [id];
    let i = 2;
    if (name !== undefined)        { sets.push(`name = $${i++}`);        args.push(name); }
    if (leader_id !== undefined)   { sets.push(`leader_id = $${i++}`);   args.push(leader_id); }
    if (description !== undefined) { sets.push(`description = $${i++}`); args.push(description); }
    if (is_active !== undefined)   { sets.push(`is_active = $${i++}`);   args.push(is_active); }
    if (sets.length === 0) return TeamsRepository.findById(id);
    const { rows } = await db.query(
      `UPDATE field_teams SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      args
    );
    return rows[0] || null;
  },

  remove: async (id) => {
    // Soft delete — set is_active=false and also deactivate all memberships.
    await db.query(
      `UPDATE field_team_members SET is_active = FALSE WHERE team_id = $1`,
      [id]
    );
    const { rows } = await db.query(
      `UPDATE field_teams SET is_active = FALSE WHERE id = $1 RETURNING *`,
      [id]
    );
    return rows[0] || null;
  },

  // ── Members ──────────────────────────────────────────────────────────
  listMembers: async (teamId) => {
    const { rows } = await db.query(
      `SELECT m.*, u.name, u.phone
         FROM field_team_members m
         JOIN users u ON u.id = m.agent_id
        WHERE m.team_id = $1 AND m.is_active = TRUE
        ORDER BY (m.role = 'leader') DESC, m.joined_at`,
      [teamId]
    );
    return rows;
  },

  addMember: async ({ team_id, agent_id, role = 'member', share_pct = 100 }) => {
    // If a previous (now inactive) membership exists, reactivate. Otherwise insert.
    const { rows: existing } = await db.query(
      `SELECT id FROM field_team_members WHERE team_id = $1 AND agent_id = $2`,
      [team_id, agent_id]
    );
    if (existing[0]) {
      const { rows } = await db.query(
        `UPDATE field_team_members
            SET is_active = TRUE, role = $2, share_pct = $3, joined_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [existing[0].id, role, share_pct]
      );
      return rows[0];
    }
    const { rows } = await db.query(
      `INSERT INTO field_team_members (team_id, agent_id, role, share_pct)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [team_id, agent_id, role, share_pct]
    );
    return rows[0];
  },

  removeMember: async (teamId, agentId) => {
    const { rows } = await db.query(
      `UPDATE field_team_members SET is_active = FALSE
        WHERE team_id = $1 AND agent_id = $2
        RETURNING *`,
      [teamId, agentId]
    );
    return rows[0] || null;
  },

  updateMemberShare: async (teamId, agentId, share_pct) => {
    const { rows } = await db.query(
      `UPDATE field_team_members SET share_pct = $3
        WHERE team_id = $1 AND agent_id = $2
        RETURNING *`,
      [teamId, agentId, share_pct]
    );
    return rows[0] || null;
  },

  // Used by the incentive engine — get the full member list (with share_pct
  // and role) for a team. Filters to active members.
  membersForAccrual: async (teamId) => {
    const { rows } = await db.query(
      `SELECT agent_id, role, share_pct
         FROM field_team_members
        WHERE team_id = $1 AND is_active = TRUE`,
      [teamId]
    );
    return rows;
  },

  // Look up an agent's current active team (used by the field UI to show
  // "you're on Team Foxtrot" type chips).
  findTeamForAgent: async (agentId) => {
    const { rows } = await db.query(
      `SELECT t.*, m.role, m.share_pct,
              u.name as leader_name, u.phone as leader_phone
         FROM field_team_members m
         JOIN field_teams t ON t.id = m.team_id
         JOIN users u ON u.id = t.leader_id
        WHERE m.agent_id = $1 AND m.is_active = TRUE AND t.is_active = TRUE
        LIMIT 1`,
      [agentId]
    );
    return rows[0] || null;
  },
};

module.exports = TeamsRepository;
