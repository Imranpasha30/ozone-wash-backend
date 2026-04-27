const db = require('../../config/db');

const EcoScoreRepository = {

  // ─── Legacy per-job snapshot (eco_metrics_log) ───────────────────────────

  // Save calculated eco score for a single job
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
        score_breakdown = $9
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

  findByJob: async (jobId) => {
    const result = await db.query(
      `SELECT * FROM eco_metrics_log WHERE job_id = $1`,
      [jobId]
    );
    return result.rows[0] || null;
  },

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

  // ─── New rolling per-customer EcoScore (eco_scores) ──────────────────────

  getCurrent: async (userId) => {
    const { rows } = await db.query(
      `SELECT * FROM eco_scores WHERE user_id = $1`,
      [userId]
    );
    return rows[0] || null;
  },

  upsertCurrent: async ({ user_id, score, badge, rationale, streak_days, components }) => {
    const c = components || {};
    const { rows } = await db.query(
      `INSERT INTO eco_scores (
         user_id, score, badge, rationale, streak_days, last_recalc_at,
         c_amc_plan, c_compliance, c_timeliness, c_addons,
         c_ratings, c_water_tests, c_referrals
       ) VALUES (
         $1,$2,$3,$4,$5, NOW(),
         $6,$7,$8,$9,$10,$11,$12
       )
       ON CONFLICT (user_id) DO UPDATE SET
         score = EXCLUDED.score,
         badge = EXCLUDED.badge,
         rationale = EXCLUDED.rationale,
         streak_days = EXCLUDED.streak_days,
         last_recalc_at = NOW(),
         c_amc_plan = EXCLUDED.c_amc_plan,
         c_compliance = EXCLUDED.c_compliance,
         c_timeliness = EXCLUDED.c_timeliness,
         c_addons = EXCLUDED.c_addons,
         c_ratings = EXCLUDED.c_ratings,
         c_water_tests = EXCLUDED.c_water_tests,
         c_referrals = EXCLUDED.c_referrals
       RETURNING *`,
      [
        user_id, score, badge, rationale, streak_days || 0,
        c.c_amc_plan || 0, c.c_compliance || 0, c.c_timeliness || 0,
        c.c_addons || 0, c.c_ratings || 0, c.c_water_tests || 0,
        c.c_referrals || 0,
      ]
    );
    return rows[0];
  },

  insertHistory: async ({ user_id, score, badge, delta, trigger, trigger_ref, rationale, components }) => {
    const { rows } = await db.query(
      `INSERT INTO eco_score_history
         (user_id, score, badge, delta, trigger, trigger_ref, rationale, components)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       RETURNING *`,
      [
        user_id, score, badge, delta, trigger || null,
        trigger_ref || null, rationale || null,
        JSON.stringify(components || {}),
      ]
    );
    return rows[0];
  },

  getHistory: async (userId, limit = 30) => {
    const { rows } = await db.query(
      `SELECT * FROM eco_score_history
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [userId, limit]
    );
    return rows;
  },

  // Top-N for leaderboard. Joins users for first-name + city (city derived
  // from the most recent booking address — it's not a column on users).
  getTopUsers: async (limit = 50) => {
    const { rows } = await db.query(
      `SELECT
         es.user_id, es.score, es.badge, es.rationale, es.streak_days,
         u.name AS full_name,
         (SELECT b.address FROM bookings b
           WHERE b.customer_id = es.user_id
           ORDER BY b.created_at DESC LIMIT 1) AS last_address
       FROM eco_scores es
       JOIN users u ON u.id = es.user_id
       WHERE es.badge != 'unrated'
       ORDER BY es.score DESC, es.streak_days DESC
       LIMIT $1`,
      [limit]
    );
    return rows;
  },

  getBottomUsers: async (limit = 20) => {
    const { rows } = await db.query(
      `SELECT
         es.user_id, es.score, es.badge, es.rationale,
         es.last_recalc_at, u.name AS full_name, u.phone
       FROM eco_scores es
       JOIN users u ON u.id = es.user_id
       ORDER BY es.score ASC, es.last_recalc_at ASC
       LIMIT $1`,
      [limit]
    );
    return rows;
  },

  // List ALL active customer ids (for the nightly cron)
  listActiveCustomerIds: async () => {
    const { rows } = await db.query(
      `SELECT id FROM users WHERE role = 'customer'`
    );
    return rows.map((r) => r.id);
  },

  // ─── Weights (admin tunable) ─────────────────────────────────────────────
  getWeights: async () => {
    const { rows } = await db.query(`SELECT * FROM eco_score_weights WHERE id = 1`);
    return rows[0] || null;
  },

  updateWeights: async (fields) => {
    const allowed = [
      'w_amc_plan','w_compliance','w_timeliness','w_addons',
      'w_ratings','w_water_tests','w_referrals',
      't_platinum','t_gold','t_silver','t_bronze',
    ];
    const sets = []; const params = []; let idx = 1;
    for (const [k, v] of Object.entries(fields || {})) {
      if (!allowed.includes(k)) continue;
      sets.push(`${k} = $${idx++}`);
      params.push(v);
    }
    if (!sets.length) throw { status: 400, message: 'No valid weights to update.' };
    sets.push('updated_at = NOW()');
    const { rows } = await db.query(
      `UPDATE eco_score_weights SET ${sets.join(', ')} WHERE id = 1 RETURNING *`,
      params
    );
    return rows[0];
  },

  // ─── Wallet bonus on badge upgrade ───────────────────────────────────────
  ensureWallet: async (userId) => {
    await db.query(
      `INSERT INTO wallets (user_id) VALUES ($1)
         ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );
  },

  creditBadgeBonus: async ({ user_id, points, ref_id }) => {
    if (!points || points <= 0) return null;
    await EcoScoreRepository.ensureWallet(user_id);
    await db.query(
      `INSERT INTO wallet_transactions
         (user_id, delta, reason, ref_type, ref_id)
       VALUES ($1,$2,'ecoscore_badge_up','ecoscore',$3)`,
      [user_id, points, ref_id || user_id]
    );
    await db.query(
      `UPDATE wallets
          SET eco_points = eco_points + $2,
              lifetime_earned = lifetime_earned + $2,
              updated_at = NOW()
        WHERE user_id = $1`,
      [user_id, points]
    );
    return { credited: points };
  },
};

module.exports = EcoScoreRepository;
