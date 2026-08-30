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

// Legacy/UI plan names → canonical matrix plans. "Yearly" IS "one-time"
// (1 service/yr, 0% discount) per spec — the stray 5% yearly figure in the
// Bench Marking sheet is defined but never applied.
const PLAN_ALIASES = {
  yearly: 'one_time',
  onetime: 'one_time',
  one_time: 'one_time',
  halfyearly: 'half_yearly',
  half_yearly: 'half_yearly',
  quarterly: 'quarterly',
  monthly: 'monthly',
};
const normalizePlan = (plan) => PLAN_ALIASES[String(plan || '').toLowerCase()] || null;

// Legacy app add-on codes → the "Add On for APP" sheet codes.
const ADDON_ALIASES = {
  lime_treatment: 'anti_lime',
  structure_health_check: 'structural_audit',
  advanced_testing: 'pathogen_testing',
};
const normalizeAddonCode = (code) => ADDON_ALIASES[code] || code;

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

  const totalPaise = perTankPaise * count;               // one service visit, all tanks
  const spy = Number(r.services_per_year) || 1;
  const annualPaise = totalPaise * spy;                  // full plan invoice (spec §5)
  const exGst = exGstFromInc(totalPaise);
  const gst   = totalPaise - exGst;

  return {
    matrix_id: r.id,
    tier_id: r.tier_id,
    tier_label: r.label,
    plan: r.plan,
    tank_count: count,
    services_per_year: spy,
    per_tank_paise: perTankPaise,
    per_tank_annual_paise: perTankPaise * spy,
    total_paise: totalPaise,
    annual_total_paise: annualPaise,
    ex_gst_paise: exGst,
    gst_paise: gst,
    annual_ex_gst_paise: exGstFromInc(annualPaise),
    annual_gst_paise: annualPaise - exGstFromInc(annualPaise),
    gst_rate_pct: 18,
    requires_inspection: !!r.requires_inspection,
    effective_from: r.effective_from,
    notes: r.notes || null,
  };
}

/* ── Add-ons ("Add On for APP" buckets) ─────────────────────────── */
// Buckets: small 500–9,999 L · medium 10,000–49,999 L · large 50,000–99,999 L
// · 1,00,000+ L = custom quote (requires inspection).
function addonBucketForLitres(litres) {
  const n = Number(litres) || 0;
  if (n >= 100000) return 'custom';
  if (n >= 50000)  return 'large';
  if (n >= 10000)  return 'medium';
  return 'small';
}

async function listAddons() {
  const { rows } = await query(
    `SELECT code, display_name, price_small_paise, price_medium_paise,
            price_large_paise, coming_soon, active, display_order
       FROM tank_addons
      WHERE active = true
      ORDER BY display_order ASC`
  );
  return rows;
}

/**
 * Price a set of add-on codes for a given tank size (litres).
 * Returns { items: [...], total_paise, requires_inspection } — add-ons in the
 * custom bucket (1,00,000+ L) are flagged, not priced. Coming-soon add-ons
 * (IoT Sensor) and codes not offered in the bucket ("–" cells) are rejected.
 */
async function priceAddons(addonCodes = [], litres = 0) {
  const codes = [...new Set((addonCodes || []).map(normalizeAddonCode))];
  if (!codes.length) return { items: [], total_paise: 0, requires_inspection: false };

  const bucket = addonBucketForLitres(litres);
  const all = await listAddons();
  const byCode = Object.fromEntries(all.map((a) => [a.code, a]));

  const items = [];
  let total = 0;
  let requiresInspection = false;

  for (const code of codes) {
    const addon = byCode[code];
    if (!addon) throw { status: 400, message: `Unknown add-on: ${code}` };
    if (addon.coming_soon) throw { status: 400, message: `${addon.display_name} is coming soon — not yet billable.` };

    if (bucket === 'custom') {
      requiresInspection = true;
      items.push({ code, name: addon.display_name, price_paise: null, custom_quote: true });
      continue;
    }
    const col = { small: 'price_small_paise', medium: 'price_medium_paise', large: 'price_large_paise' }[bucket];
    const price = addon[col];
    if (price == null) throw { status: 400, message: `${addon.display_name} is not offered for this tank size.` };
    items.push({ code, name: addon.display_name, price_paise: price, custom_quote: false });
    total += price;
  }

  return { items, total_paise: total, bucket, requires_inspection: requiresInspection };
}

/* ── Full invoice quote (spec §5 master formula) ────────────────── */
/**
 * quoteInvoice({ tanks, plan, addon_codes })
 *   tanks       — array of litres numbers OR { tank_size_litres } objects
 *   plan        — one_time | half_yearly | quarterly | monthly (aliases ok)
 *   addon_codes — booking-level add-ons, priced on the LARGEST tank's bucket
 *
 * Formula (all paise, GST-inclusive):
 *   per_tank_base   = tier base × (1 − tank_count_disc)   ← stored in matrix cols
 *   per_tank_annual = per_tank_base × (1 − freq_disc) × services_per_year
 *   invoice         = Σ per_tank_annual + add-ons
 */
async function quoteInvoice({ tanks, plan, addon_codes = [] }) {
  const normPlan = normalizePlan(plan) || 'one_time';
  const litresList = (tanks || [])
    .map((t) => Number(typeof t === 'object' ? t.tank_size_litres : t))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!litresList.length) throw { status: 400, message: 'At least one tank size is required.' };

  const count = litresList.length;
  const col = count === 1 ? 'single_tank_paise' : count === 2 ? 'per_tank_2_paise' : 'per_tank_2plus_paise';

  let perServiceTotal = 0;
  let spy = 1;
  let requiresInspection = false;
  const tankLines = [];
  const rowCache = {};

  for (const litres of litresList) {
    const tier = await tierForLitres(litres);
    if (!tier) throw { status: 400, message: `No pricing tier for ${litres} L.` };

    const cacheKey = `${tier.id}:${normPlan}`;
    if (!rowCache[cacheKey]) {
      const { rows } = await query(
        `SELECT pm.single_tank_paise, pm.per_tank_2_paise, pm.per_tank_2plus_paise,
                pm.services_per_year, pt.label, pt.requires_inspection
           FROM pricing_matrix pm
           JOIN pricing_tiers pt ON pt.id = pm.tier_id
          WHERE pm.tier_id = $1 AND pm.plan = $2 AND pm.active = true
            AND pm.effective_from <= CURRENT_DATE
          ORDER BY pm.effective_from DESC LIMIT 1`,
        [tier.id, normPlan]
      );
      if (!rows.length) throw { status: 404, message: `No active pricing for tier ${tier.id} / ${normPlan}` };
      rowCache[cacheKey] = rows[0];
    }
    const row = rowCache[cacheKey];
    spy = Number(row.services_per_year) || 1;
    if (row.requires_inspection) requiresInspection = true;

    const perTank = row[col];
    perServiceTotal += perTank;
    tankLines.push({
      litres,
      tier_label: row.label,
      per_tank_per_service_paise: perTank,
      per_tank_annual_paise: perTank * spy,
      requires_inspection: !!row.requires_inspection,
    });
  }

  const annualServiceTotal = perServiceTotal * spy;
  const maxLitres = Math.max(...litresList);
  const addons = await priceAddons(addon_codes, maxLitres);
  if (addons.requires_inspection) requiresInspection = true;

  // ── Invoice line items (proper bill: base → discounts → tax split) ──
  // Base = one-time single-tank rate per tank; the matrix columns embed the
  // multi-tank and frequency discounts, so the discount lines are derived by
  // re-quoting each tank at the one_time rates.
  let basePerService = 0;        // Σ one_time single-tank rates
  let afterTankDisc = 0;         // Σ one_time rates at the count column
  for (const litres of litresList) {
    const tier = await tierForLitres(litres);
    const key = `${tier.id}:one_time`;
    if (!rowCache[key]) {
      const { rows } = await query(
        `SELECT pm.single_tank_paise, pm.per_tank_2_paise, pm.per_tank_2plus_paise,
                pm.services_per_year, pt.label, pt.requires_inspection
           FROM pricing_matrix pm JOIN pricing_tiers pt ON pt.id = pm.tier_id
          WHERE pm.tier_id = $1 AND pm.plan = 'one_time' AND pm.active = true
            AND pm.effective_from <= CURRENT_DATE
          ORDER BY pm.effective_from DESC LIMIT 1`,
        [tier.id]
      );
      rowCache[key] = rows[0] || null;
    }
    const ot = rowCache[key];
    if (ot) {
      basePerService += ot.single_tank_paise;
      afterTankDisc += ot[col];
    }
  }
  const tankDiscPerService = Math.max(0, basePerService - afterTankDisc);       // multi-tank saving
  const planDiscPerService = Math.max(0, afterTankDisc - perServiceTotal);      // frequency saving
  const tankDiscPct = count === 1 ? 0 : count === 2 ? 15 : 30;
  const planDiscPct = { one_time: 0, half_yearly: 10, quarterly: 15, monthly: 30 }[normPlan] || 0;
  // Yearly savings vs booking the same visits one-time
  const annualSavings = Math.max(0, (basePerService * spy) - annualServiceTotal);

  // Invoice = full plan (annual) service total + one-time add-ons.
  const invoiceTotal = annualServiceTotal + addons.total_paise;
  const exGst = exGstFromInc(invoiceTotal);
  const gst = invoiceTotal - exGst;
  const cgst = Math.round(gst / 2);

  return {
    plan: normPlan,
    services_per_year: spy,
    tank_count: count,
    tanks: tankLines,
    per_service_total_paise: perServiceTotal,
    annual_service_total_paise: annualServiceTotal,
    addons: addons.items,
    addons_total_paise: addons.total_paise,
    invoice_total_paise: invoiceTotal,
    ex_gst_paise: exGst,
    gst_paise: gst,
    gst_rate_pct: 18,
    requires_inspection: requiresInspection,
    // Itemized bill lines (all GST-inclusive paise; UI renders ₹)
    lines: {
      base_per_service_paise: basePerService,               // before any discount
      tank_discount_pct: tankDiscPct,
      tank_discount_per_service_paise: tankDiscPerService,
      plan_discount_pct: planDiscPct,
      plan_discount_per_service_paise: planDiscPerService,
      per_service_after_discounts_paise: perServiceTotal,
      annual_savings_paise: annualSavings,                  // vs one-time visits
      cgst_paise: cgst,                                     // 9% CGST
      sgst_paise: gst - cgst,                               // 9% SGST
      taxable_value_paise: exGst,
    },
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

/* ── AMC plan catalog (display name / copy only — price lives in the matrix) ── */
async function listAmcPlans() {
  try {
    const { rows } = await query(
      `SELECT plan, display_name, headline, features, display_order, active, updated_at
         FROM amc_plans ORDER BY display_order ASC, plan ASC`
    );
    return rows;
  } catch (e) {
    // Migration 031 not applied yet → fall back to no catalog (app uses its
    // built-in labels). 42P01 = undefined_table.
    if (e && e.code === '42P01') return [];
    throw e;
  }
}

async function updateAmcPlan(plan, fields = {}) {
  const p = normalizePlan(plan) || plan;
  if (!VALID_PLANS.includes(p)) throw { status: 400, message: `Invalid plan: ${plan}` };
  const sets = ['updated_at = NOW()'];
  const params = [];
  let i = 1;
  if (fields.display_name !== undefined) {
    const dn = String(fields.display_name || '').trim();
    if (!dn) throw { status: 400, message: 'display_name cannot be empty.' };
    sets.push(`display_name = $${i++}`); params.push(dn);
  }
  if (fields.headline !== undefined)      { sets.push(`headline = $${i++}`);        params.push(fields.headline == null ? null : String(fields.headline).trim()); }
  if (fields.features !== undefined)      { sets.push(`features = $${i++}::jsonb`); params.push(JSON.stringify(Array.isArray(fields.features) ? fields.features : [])); }
  if (fields.display_order !== undefined) { sets.push(`display_order = $${i++}`);   params.push(parseInt(fields.display_order, 10) || 0); }
  if (fields.active !== undefined)        { sets.push(`active = $${i++}`);          params.push(!!fields.active); }
  params.push(p);
  const { rows } = await query(
    `UPDATE amc_plans SET ${sets.join(', ')} WHERE plan = $${i}
     RETURNING plan, display_name, headline, features, display_order, active, updated_at`,
    params
  );
  if (!rows.length) throw { status: 404, message: `AMC plan '${p}' not found.` };
  return rows[0];
}

module.exports = {
  tierForLitres,
  listAmcPlans,
  updateAmcPlan,
  priceForBooking,
  listTiers,
  listMatrix,
  updateMatrixRow,
  freezeAndScheduleNew,
  exGstFromInc,
  gstFromInc,
  VALID_PLANS,
  normalizePlan,
  normalizeAddonCode,
  addonBucketForLitres,
  listAddons,
  priceAddons,
  quoteInvoice,
};
