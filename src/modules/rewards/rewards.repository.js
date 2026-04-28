/**
 * Rewards repository — DB access for the redemption catalog + redemptions
 * tracker introduced in migration 010.
 *
 * The 'rewards' table existed since migration 005; migration 010 added:
 *   - slug             VARCHAR(60) UNIQUE
 *   - requires_streak  VARCHAR(20)   ('platinum' | 'gold' | NULL)
 *
 * The 'redemptions' table is brand new (migration 010) and tracks delivery
 * status (pending / applied / cancelled).
 */

const db = require('../../config/db');

const RewardsRepository = {

  // ── Catalog ────────────────────────────────────────────────────────────

  /** All active rewards in the catalog. */
  listActive: async () => {
    const { rows } = await db.query(
      `SELECT id, slug, name, description, cost_points, category,
              requires_streak, active, stock, created_at
         FROM rewards
        WHERE active = true
          AND slug IS NOT NULL
        ORDER BY
          CASE category
            WHEN 'amc_renewal' THEN 1
            WHEN 'hygiene'     THEN 2
            WHEN 'partner'     THEN 3
            WHEN 'streak'      THEN 4
            ELSE 99
          END,
          cost_points ASC`
    );
    return rows;
  },

  /** Lookup by slug (used by /redeem). */
  findBySlug: async (slug) => {
    const { rows } = await db.query(
      `SELECT id, slug, name, description, cost_points, category,
              requires_streak, active, stock
         FROM rewards
        WHERE slug = $1`,
      [slug]
    );
    return rows[0] || null;
  },

  // ── Wallet + EcoScore snapshot for the user (for /me) ──────────────────

  getWalletAndBadge: async (userId) => {
    const { rows: wRows } = await db.query(
      `SELECT eco_points, lifetime_earned, lifetime_redeemed, eco_points_capped_at
         FROM wallets WHERE user_id = $1`,
      [userId]
    );
    const wallet = wRows[0] || {
      eco_points: 0,
      lifetime_earned: 0,
      lifetime_redeemed: 0,
      eco_points_capped_at: 1000,
    };
    const { rows: eRows } = await db.query(
      `SELECT score, badge, streak_days
         FROM eco_scores WHERE user_id = $1`,
      [userId]
    );
    const eco = eRows[0] || { score: 0, badge: 'unrated', streak_days: 0 };
    return { wallet, eco };
  },

  // ── Redemption mutations ───────────────────────────────────────────────

  /**
   * Atomically debit the wallet, log the wallet_transaction, and create the
   * redemptions row. Throws on insufficient balance / inactive reward / etc.
   * Returns { redemption, wallet }.
   */
  redeem: async ({ userId, reward }) => {
    const cost = Number(reward.cost_points) || 0;
    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // Lock the wallet row.
      await client.query(
        `INSERT INTO wallets (user_id) VALUES ($1)
           ON CONFLICT (user_id) DO NOTHING`,
        [userId]
      );
      const { rows: wRows } = await client.query(
        `SELECT eco_points FROM wallets WHERE user_id = $1 FOR UPDATE`,
        [userId]
      );
      const balance = wRows[0]?.eco_points || 0;

      if (cost > balance) {
        const e = new Error('Insufficient EcoPoints to redeem this reward.');
        e.status = 400;
        throw e;
      }

      let walletTxId = null;
      if (cost > 0) {
        const { rows: txRows } = await client.query(
          `INSERT INTO wallet_transactions
             (user_id, delta, reason, ref_type, ref_id)
           VALUES ($1, $2, 'reward_redeem', 'reward', $3)
           RETURNING id`,
          [userId, -cost, reward.id]
        );
        walletTxId = txRows[0]?.id || null;

        await client.query(
          `UPDATE wallets
              SET eco_points = eco_points - $2,
                  lifetime_redeemed = lifetime_redeemed + $2,
                  updated_at = NOW()
            WHERE user_id = $1`,
          [userId, cost]
        );
      }

      const { rows: rRows } = await client.query(
        `INSERT INTO redemptions
           (user_id, reward_id, reward_slug, points_spent, wallet_tx_id, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')
         RETURNING *`,
        [userId, reward.id, reward.slug, cost, walletTxId]
      );

      const { rows: wAfter } = await client.query(
        `SELECT eco_points, lifetime_redeemed FROM wallets WHERE user_id = $1`,
        [userId]
      );

      await client.query('COMMIT');
      return { redemption: rRows[0], wallet: wAfter[0] };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  /** A user's redemption history (for the dashboard). */
  listForUser: async (userId, limit = 50) => {
    const { rows } = await db.query(
      `SELECT r.id, r.reward_id, r.reward_slug, r.points_spent, r.status,
              r.applied_at, r.cancelled_at, r.created_at,
              rw.name AS reward_name, rw.category, rw.description
         FROM redemptions r
         JOIN rewards rw ON rw.id = r.reward_id
        WHERE r.user_id = $1
        ORDER BY r.created_at DESC
        LIMIT $2`,
      [userId, limit]
    );
    return rows;
  },
};

module.exports = RewardsRepository;
