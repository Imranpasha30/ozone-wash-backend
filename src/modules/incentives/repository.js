/**
 * Incentive repository — raw SQL helpers used by both the controller and
 * the engine. Keeps SQL out of business logic.
 */

const { query, getClient } = require('../../config/db');

const repo = {

  /* ── Field-team self view ────────────────────────────────────── */

  // Current month total + breakdown
  async monthSummary(agent_id, monthDate) {
    const { rows } = await query(
      `SELECT reason,
              COUNT(*)::int AS count,
              COALESCE(SUM(amount_paise), 0)::int AS total_paise
         FROM incentives
        WHERE agent_id = $1
          AND status IN ('accrued','paid')
          AND created_at >= $2::date
          AND created_at <  ($2::date + INTERVAL '1 month')
        GROUP BY reason`,
      [agent_id, monthDate]
    );
    const total = rows.reduce((s, r) => s + parseInt(r.total_paise, 10), 0);
    return { breakdown: rows, total_paise: total };
  },

  async last30Lines(agent_id, limit = 30) {
    const { rows } = await query(
      `SELECT i.id, i.job_id, i.amount_paise, i.reason, i.tier, i.status,
              i.created_at, i.paid_at,
              j.scheduled_at, b.address, c.name AS customer_name
         FROM incentives i
         LEFT JOIN jobs j ON j.id = i.job_id
         LEFT JOIN bookings b ON b.id = j.booking_id
         LEFT JOIN users c ON c.id = j.customer_id
        WHERE i.agent_id = $1
        ORDER BY i.created_at DESC
        LIMIT $2`,
      [agent_id, limit]
    );
    return rows;
  },

  async historyPage(agent_id, limit, offset) {
    const { rows } = await query(
      `SELECT i.id, i.job_id, i.amount_paise, i.reason, i.tier, i.status,
              i.created_at, i.paid_at, i.batch_id
         FROM incentives i
        WHERE i.agent_id = $1
        ORDER BY i.created_at DESC
        LIMIT $2 OFFSET $3`,
      [agent_id, limit, offset]
    );
    return rows;
  },

  async lastPaidBatch(agent_id) {
    const { rows } = await query(
      `SELECT id, month, total_paise, paid_at, payment_ref
         FROM payout_batches
        WHERE agent_id = $1 AND status = 'paid'
        ORDER BY paid_at DESC NULLS LAST
        LIMIT 1`,
      [agent_id]
    );
    return rows[0] || null;
  },

  /* ── Admin payouts ───────────────────────────────────────────── */

  async listBatchesForMonth(monthDate) {
    const { rows } = await query(
      `SELECT pb.id, pb.agent_id, pb.month, pb.total_paise, pb.status,
              pb.payment_ref, pb.notes, pb.created_at, pb.paid_at,
              u.name AS agent_name, u.phone AS agent_phone,
              ast.current_tier,
              (SELECT COUNT(*)::int FROM jobs j
                 WHERE j.assigned_team_id = pb.agent_id
                   AND j.status = 'completed'
                   AND j.completed_at >= pb.month
                   AND j.completed_at <  pb.month + INTERVAL '1 month'
              ) AS jobs_completed,
              (SELECT COALESCE(SUM(amount_paise),0)::int FROM incentives
                 WHERE agent_id = pb.agent_id
                   AND status IN ('accrued','paid')
                   AND created_at >= pb.month
                   AND created_at <  pb.month + INTERVAL '1 month'
              ) AS computed_total_paise
         FROM payout_batches pb
         LEFT JOIN users u ON u.id = pb.agent_id
         LEFT JOIN agent_stats ast ON ast.agent_id = pb.agent_id
        WHERE pb.month = $1
        ORDER BY computed_total_paise DESC NULLS LAST, u.name ASC`,
      [monthDate]
    );
    return rows;
  },

  async findBatch(batchId) {
    const { rows } = await query(
      `SELECT * FROM payout_batches WHERE id = $1`,
      [batchId]
    );
    return rows[0] || null;
  },

  /* Freeze: lock all accrued + un-batched incentives in this batch's month
     to this batch.id, sum them into batch.total_paise, set status='frozen'. */
  async freezeBatch(batchId) {
    const client = await getClient();
    try {
      await client.query('BEGIN');
      const b = (await client.query(
        `SELECT * FROM payout_batches WHERE id = $1 FOR UPDATE`,
        [batchId]
      )).rows[0];
      if (!b) throw { status: 404, message: 'Batch not found.' };
      if (b.status !== 'open') {
        throw { status: 400, message: `Batch is already ${b.status}.` };
      }

      // Attach all unbatched accrued incentives in this month
      await client.query(
        `UPDATE incentives
            SET batch_id = $1
          WHERE agent_id = $2
            AND batch_id IS NULL
            AND status = 'accrued'
            AND created_at >= $3::date
            AND created_at <  ($3::date + INTERVAL '1 month')`,
        [batchId, b.agent_id, b.month]
      );

      const { rows: sumRows } = await client.query(
        `SELECT COALESCE(SUM(amount_paise),0)::int AS total
           FROM incentives WHERE batch_id = $1 AND status = 'accrued'`,
        [batchId]
      );
      const total = sumRows[0].total;

      const { rows: upd } = await client.query(
        `UPDATE payout_batches
            SET status = 'frozen', total_paise = $1
          WHERE id = $2
          RETURNING *`,
        [total, batchId]
      );
      await client.query('COMMIT');
      return upd[0];
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },

  async markBatchPaid(batchId, payment_ref, notes) {
    const client = await getClient();
    try {
      await client.query('BEGIN');
      const b = (await client.query(
        `SELECT * FROM payout_batches WHERE id = $1 FOR UPDATE`,
        [batchId]
      )).rows[0];
      if (!b) throw { status: 404, message: 'Batch not found.' };
      if (b.status !== 'frozen') {
        throw { status: 400, message: `Batch must be frozen before being paid (current: ${b.status}).` };
      }

      const { rows: upd } = await client.query(
        `UPDATE payout_batches
            SET status = 'paid', payment_ref = $1, notes = $2, paid_at = now()
          WHERE id = $3
          RETURNING *`,
        [payment_ref || null, notes || null, batchId]
      );

      await client.query(
        `UPDATE incentives
            SET status = 'paid', paid_at = now()
          WHERE batch_id = $1 AND status = 'accrued'`,
        [batchId]
      );

      await client.query('COMMIT');
      return upd[0];
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },

  async reverseBatch(batchId, reason) {
    const client = await getClient();
    try {
      await client.query('BEGIN');
      const b = (await client.query(
        `SELECT * FROM payout_batches WHERE id = $1 FOR UPDATE`,
        [batchId]
      )).rows[0];
      if (!b) throw { status: 404, message: 'Batch not found.' };
      if (b.status === 'cancelled') {
        throw { status: 400, message: 'Batch is already cancelled.' };
      }

      const { rows: upd } = await client.query(
        `UPDATE payout_batches
            SET status = 'cancelled',
                notes = COALESCE(notes,'') || $1
          WHERE id = $2
          RETURNING *`,
        [`\n[Reversed] ${reason || 'No reason provided'}`, batchId]
      );

      await client.query(
        `UPDATE incentives
            SET status = 'reversed'
          WHERE batch_id = $1`,
        [batchId]
      );

      await client.query('COMMIT');
      return upd[0];
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },

  /* ── Credit engine (Phase B / migration 011) ─────────────────── */

  /* UPSERT the latest credit recalculation into agent_stats AND insert a
     row in agent_credit_log for audit. The `month` is the first-of-month
     date the credits were computed against. */
  async saveAgentCreditSnapshot({ agent_id, month, credits_total, breakdown, tier }) {
    if (!agent_id) return null;
    const client = await getClient();
    try {
      await client.query('BEGIN');

      // Make sure an agent_stats row exists, then patch the credit fields.
      // We don't touch the existing turnover/jobs/avg_rating columns — the
      // legacy recalcAgentStats engine path keeps owning those.
      await client.query(
        `INSERT INTO agent_stats (agent_id, current_tier, credits_current_month,
                                  credits_breakdown, last_credit_recalc_at)
              VALUES ($1, $2, $3, $4::jsonb, now())
         ON CONFLICT (agent_id) DO UPDATE SET
           current_tier            = EXCLUDED.current_tier,
           credits_current_month   = EXCLUDED.credits_current_month,
           credits_breakdown       = EXCLUDED.credits_breakdown,
           last_credit_recalc_at   = now()`,
        [agent_id, tier, credits_total, JSON.stringify(breakdown || {})]
      );

      const { rows } = await client.query(
        `INSERT INTO agent_credit_log
           (agent_id, month, credits_total, credits_breakdown, tier)
         VALUES ($1, $2::date, $3, $4::jsonb, $5)
         RETURNING *`,
        [agent_id, month, credits_total, JSON.stringify(breakdown || {}), tier]
      );

      await client.query('COMMIT');
      return rows[0];
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },

  /* Returns the latest credits + breakdown + tier for one agent (from
     agent_stats — the live "current" view). Falls back to a zero
     snapshot if the agent has never been recalculated. */
  async getAgentCredits(agent_id) {
    const { rows } = await query(
      `SELECT agent_id, current_tier, credits_current_month, credits_breakdown,
              avg_job_minutes_30d, tat_compliance_pct_30d, avg_eco_score_30d,
              escalation_count_30d, last_credit_recalc_at
         FROM agent_stats
        WHERE agent_id = $1`,
      [agent_id]
    );
    if (!rows[0]) {
      return {
        agent_id,
        current_tier: 'unrated',
        credits_current_month: 0,
        credits_breakdown: {},
        avg_job_minutes_30d: 0,
        tat_compliance_pct_30d: 0,
        avg_eco_score_30d: 0,
        escalation_count_30d: 0,
        last_credit_recalc_at: null,
      };
    }
    return rows[0];
  },

  /* Admin-side "all-agents-for-this-month" view, sourced from the
     audit log (agent_credit_log) so we get exactly what was computed
     for that month — even if agent_stats has since rolled forward. */
  async getAllAgentCreditsForMonth(monthDate) {
    const { rows } = await query(
      `SELECT DISTINCT ON (acl.agent_id)
              acl.agent_id, acl.month, acl.credits_total,
              acl.credits_breakdown, acl.tier, acl.computed_at,
              u.name AS agent_name, u.phone AS agent_phone
         FROM agent_credit_log acl
         LEFT JOIN users u ON u.id = acl.agent_id
        WHERE acl.month = $1::date
        ORDER BY acl.agent_id, acl.computed_at DESC`,
      [monthDate]
    );
    return rows;
  },

  /* ── Rules ──────────────────────────────────────────────────── */

  async getRules() {
    const { rows } = await query(`SELECT * FROM incentive_rules WHERE id = 1`);
    return rows[0] || null;
  },

  async updateRules(fields) {
    const allowed = [
      'base_completion_paise','addon_commission_pct',
      'rating_5_paise','rating_4_paise','rating_3_paise',
      'referral_bonus_paise',
      'multiplier_platinum','multiplier_gold','multiplier_silver','multiplier_bronze',
      'monthly_target_jobs','monthly_target_bonus_paise',
      'streak_bonus_paise','streak_threshold_months',
      'tier_platinum_paise','tier_gold_paise','tier_silver_paise',
      // Credit-engine (Phase B / migration 011)
      'weight_turnover','weight_avg_time','weight_tat','weight_transactions',
      'weight_checklist','weight_ecoscore','weight_feedback','weight_addon',
      'weight_escalation',
      'benchmark_job_minutes',
      'tier_credits_platinum','tier_credits_gold',
      'tier_credits_silver','tier_credits_bronze',
      'cash_bonus_pct_platinum','cash_bonus_pct_gold','cash_bonus_pct_silver',
      'leave_days_platinum','leave_days_gold',
    ];
    const sets = [];
    const params = [];
    let i = 1;
    for (const [k, v] of Object.entries(fields || {})) {
      if (!allowed.includes(k)) continue;
      sets.push(`${k} = $${i++}`);
      params.push(v);
    }
    if (sets.length === 0) return await repo.getRules();
    sets.push(`updated_at = now()`);
    params.push(1);
    const { rows } = await query(
      `UPDATE incentive_rules SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      params
    );
    return rows[0];
  },

};

module.exports = repo;
