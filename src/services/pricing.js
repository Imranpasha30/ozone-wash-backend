/**
 * Pricing service — authoritative source for all booking + AMC prices.
 *
 * Backed by the `pricing_tiers` and `pricing_matrix` tables (see
 * migrations/006_pricing_matrix.sql). All amounts are stored in PAISE
 * (₹1 = 100 paise) and are inclusive of GST 18%.
 *
 * Public API:
 *   tierForLitres(litres)                          -> { id, label, requires_inspection } | null
 *   priceForBooking({ tier_id, plan, tank_count }) -> price result (see below)
 *   listTiers()                                    -> all tiers
 *   listMatrix({ active = true })                  -> [{ tier, plans: [...] }]
 *   updateMatrixRow(matrixId, fields)              -> updated row
 *   freezeAndScheduleNew()                         -> copies active rows with new effective_from = today+1
 *
 * GST split helpers:
 *   exGstFromInc(p) = round(p / 1.18)
 *   gstFromInc(p)   = p - exGstFromInc(p)
 */

const { query } = require('../config/db');

const VALID_PLANS = ['one_time', 'monthly', 'quarterly', 'half_yearly'];

const exGstFromInc = (paise) => Math.round(paise / 1.18);
const gstFromInc   = (paise) => paise - exGstFromInc(paise);

/* ── Tier lookup ────────────────────────────────────────────────── */
async function tierForLitres(litres) {
  const n = Number(litres);
  if (!Number.isFinite(n) || n <= 0) return null;

  const { rows } = await query(
    `SELECT id, label, min_litres, max_litres, requires_inspection
       FROM pricing_tiers
      WHERE $1::int >= min_litres
        AND ($1::int <= max_litres OR max_litres IS NULL)
      ORDER BY id ASC
      LIMIT 1`,
    [Math.floor(n)]
  );
  if (!rows.length) return null;
  const t = rows[0];
  return {
    id: t.id,
    label: t.label,
    min_litres: t.min_litres,
    max_litres: t.max_litres,
    requires_inspection: !!t.requires_inspection,
  };
}

/* ── Price for a booking ────────────────────────────────────────── */
async function priceForBooking({ tier_id, plan, tank_count }) {
  if (!VALID_PLANS.includes(plan)) {
    throw { status: 400, message: `Invalid plan. Must be one of: ${VALID_PLANS.join(', ')}` };
  }
  const tid = Number(tier_id);
  const count = Math.max(1, Math.floor(Number(tank_count) || 1));

  const { rows } = await query(
    `SELECT pm.id, pm.tier_id, pm.plan,
            pm.single_tank_paise, pm.per_tank_2_paise, pm.per_tank_2plus_paise,
            pm.services_per_year, pm.effective_from, pm.notes,
            pt.label, pt.requires_inspection
       FROM pricing_matrix pm
       JOIN pricing_tiers  pt ON pt.id = pm.tier_id
      WHERE pm.tier_id = $1
        AND pm.plan = $2
        AND pm.active = true
        AND pm.effective_from <= CURRENT_DATE
      ORDER BY pm.effective_from DESC
      LIMIT 1`,
    [tid, plan]
  );
  if (!rows.length) {
    throw { status: 404, message: `No active pricing for tier ${tid} / plan ${plan}` };
  }
  const r = rows[0];

  // Pick rate column based on tank count
  let perTankPaise;
  if (count === 1) perTankPaise = r.single_tank_paise;
  else if (count === 2) perTankPaise = r.per_tank_2_paise;
  else perTankPaise = r.per_tank_2plus_paise;

  const totalPaise = perTankPaise * count;
  const exGst = exGstFromInc(totalPaise);
  const gst   = totalPaise - exGst;

  return {
    matrix_id: r.id,
    tier_id: r.tier_id,
    tier_label: r.label,
    plan: r.plan,
    tank_count: count,
    services_per_year: r.services_per_year,
    per_tank_paise: perTankPaise,
    total_paise: totalPaise,
    ex_gst_paise: exGst,
    gst_paise: gst,
    gst_rate_pct: 18,
    requires_inspection: !!r.requires_inspection,
    effective_from: r.effective_from,
    notes: r.notes || null,
  };
}

/* ── Admin reads ────────────────────────────────────────────────── */
async function listTiers() {
  const { rows } = await query(
    `SELECT id, label, min_litres, max_litres, requires_inspection
       FROM pricing_tiers ORDER BY id ASC`
  );
  return rows;
}

async function listMatrix({ active = true } = {}) {
  const { rows } = await query(
    `SELECT pm.id, pm.tier_id, pm.plan,
            pm.single_tank_paise, pm.per_tank_2_paise, pm.per_tank_2plus_paise,
            pm.services_per_year, pm.effective_from, pm.active, pm.notes,
            pm.created_at, pm.updated_at,
            pt.label AS tier_label, pt.requires_inspection
       FROM pricing_matrix pm
       JOIN pricing_tiers  pt ON pt.id = pm.tier_id
      ${active ? 'WHERE pm.active = true' : ''}
      ORDER BY pm.tier_id ASC,
        CASE pm.plan
          WHEN 'one_time'    THEN 1
          WHEN 'half_yearly' THEN 2
          WHEN 'quarterly'   THEN 3
          WHEN 'monthly'     THEN 4
          ELSE 5
        END`
  );
  return rows;
}

/* ── Admin writes ───────────────────────────────────────────────── */
async function updateMatrixRow(matrixId, fields) {
  const allowed = ['single_tank_paise', 'per_tank_2_paise', 'per_tank_2plus_paise', 'notes', 'active'];
  const sets = [];
  const params = [];
  let idx = 1;
  for (const [k, v] of Object.entries(fields || {})) {
    if (!allowed.includes(k)) continue;
    if (k.endsWith('_paise')) {
      const n = Math.floor(Number(v));
      if (!Number.isFinite(n) || n < 0) {
        throw { status: 400, message: `${k} must be a non-negative integer (paise)` };
      }
      sets.push(`${k} = $${idx++}`);
      params.push(n);
    } else {
      sets.push(`${k} = $${idx++}`);
      params.push(v);
    }
  }
  if (!sets.length) throw { status: 400, message: 'No valid fields to update.' };
  sets.push(`updated_at = NOW()`);
  params.push(matrixId);

  const { rows } = await query(
    `UPDATE pricing_matrix SET ${sets.join(', ')}
      WHERE id = $${idx} RETURNING *`,
    params
  );
  if (!rows.length) throw { status: 404, message: 'Pricing row not found.' };
  return rows[0];
}

/**
 * Snapshot pattern: copy the currently-active rows and insert them with
 * `effective_from = tomorrow`, so changes can be audited & rolled back.
 *
 * The new rows start as `active = true` themselves; they take precedence
 * because `priceForBooking` orders by `effective_from DESC`. The old
 * rows remain `active = true` for history but are shadowed once tomorrow
 * arrives. To deactivate them explicitly call updateMatrixRow().
 */
async function freezeAndScheduleNew() {
  const { rows } = await query(
    `INSERT INTO pricing_matrix
       (tier_id, plan, single_tank_paise, per_tank_2_paise, per_tank_2plus_paise,
        services_per_year, effective_from, active, notes)
     SELECT tier_id, plan, single_tank_paise, per_tank_2_paise, per_tank_2plus_paise,
            services_per_year, (CURRENT_DATE + INTERVAL '1 day')::date, true,
            COALESCE(notes,'') || ' [frozen ' || CURRENT_DATE || ']'
       FROM pricing_matrix
      WHERE active = true
        AND effective_from <= CURRENT_DATE
        AND (tier_id, plan, effective_from) NOT IN (
          SELECT tier_id, plan, (CURRENT_DATE + INTERVAL '1 day')::date FROM pricing_matrix
        )
     RETURNING id, tier_id, plan, effective_from`
  );
  return { inserted_count: rows.length, rows };
}

module.exports = {
  tierForLitres,
  priceForBooking,
  listTiers,
  listMatrix,
  updateMatrixRow,
  freezeAndScheduleNew,
  exGstFromInc,
  gstFromInc,
  VALID_PLANS,
};
