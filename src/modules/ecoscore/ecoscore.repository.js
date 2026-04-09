const db = require('../../config/db');

const EcoScoreRepository = {

  // Save calculated eco score
  save: async (data) => {
    const result = await db.query(
      `INSERT INTO eco_metrics_log (
        job_id, residual_water_before, water_used_litres,
        chemical_type, chemical_qty_ml, ppe_list,
        eco_score, badge_level, score_breakdown,
        job_type, resource_type
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (job_id)
      DO UPDATE SET
        eco_score = $7,
        badge_level = $8,
        score_breakdown = $9,
        updated_at = NOW()
      RETURNING *`,
      [
        data.job_id,
        data.residual_water_before || 0,
        data.water_used_litres || 0,
        data.chemical_type || null,
        data.chemical_qty_ml || 0,
        JSON.stringify(data.ppe_list || []),
        data.eco_score,
        data.badge_level,
        JSON.stringify(data.score_breakdown),
        'tank_cleaning',
        'tank',
      ]
    );
    return result.rows[0];
  },

  // Get eco score for a job
  findByJob: async (jobId) => {
    const result = await db.query(
      `SELECT * FROM eco_metrics_log WHERE job_id = $1`,
      [jobId]
    );
    return result.rows[0] || null;
  },

  // Get most recent eco score for a customer (for loyalty discount)
  findLatestByCustomer: async (customerId) => {
    const result = await db.query(
      `SELECT e.eco_score, e.badge_level
       FROM eco_metrics_log e
       JOIN jobs j ON j.id = e.job_id
       WHERE j.customer_id = $1
       ORDER BY e.created_at DESC
       LIMIT 1`,
      [customerId]
    );
    return result.rows[0] || null;
  },

  // Get team leaderboard
  getTeamLeaderboard: async () => {
    const result = await db.query(
      `SELECT
        u.id as team_id,
        u.name as team_name,
        COUNT(e.job_id) as total_jobs,
        ROUND(AVG(e.eco_score), 1) as avg_score,
        MAX(e.eco_score) as best_score,
        COUNT(*) FILTER (WHERE e.badge_level = 'platinum') as platinum_count,
        COUNT(*) FILTER (WHERE e.badge_level = 'gold') as gold_count,
        COUNT(*) FILTER (WHERE e.badge_level = 'silver') as silver_count,
        COUNT(*) FILTER (WHERE e.badge_level = 'bronze') as bronze_count
       FROM eco_metrics_log e
       JOIN jobs j ON j.id = e.job_id
       JOIN users u ON u.id = j.assigned_team_id
       GROUP BY u.id, u.name
       ORDER BY avg_score DESC`,
    );
    return result.rows;
  },

  // Get monthly trends for admin dashboard
  getTrends: async () => {
    const result = await db.query(
      `SELECT
        DATE_TRUNC('month', e.created_at) as month,
        ROUND(AVG(e.eco_score), 1) as avg_score,
        COUNT(*) as total_jobs,
        COUNT(*) FILTER (WHERE e.badge_level = 'platinum') as platinum,
        COUNT(*) FILTER (WHERE e.badge_level = 'gold') as gold,
        COUNT(*) FILTER (WHERE e.badge_level = 'silver') as silver,
        COUNT(*) FILTER (WHERE e.badge_level = 'bronze') as bronze
       FROM eco_metrics_log e
       GROUP BY DATE_TRUNC('month', e.created_at)
       ORDER BY month DESC
       LIMIT 12`,
    );
    return result.rows;
  },

};

module.exports = EcoScoreRepository;