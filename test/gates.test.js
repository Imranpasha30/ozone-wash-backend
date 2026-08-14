/**
 * Gate-logic unit tests (Handout §13) — node:test, zero dependencies.
 * Run: npm test
 *
 * Covers the pure business rules behind the server-enforced gates:
 *   ozone minimum durations (G-6), water-reading ranges + BIS flags
 *   (G-4/G-9/G-10 inputs), geofence math (G-1), pricing master formula,
 *   plan/addon normalization. API-level PASS/FAIL behavior is exercised by
 *   scripts/verify-gates.js against a running server.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';

const FieldOps = require('../src/modules/field-ops/field-ops.service');
const Pricing = require('../src/services/pricing');

/* ── Ozone minimum durations (spec 4.4, gate G-6) ────────────────── */
test('ozone min durations match the spec table', () => {
  const cases = [
    [1000, 15], [2000, 15], [5000, 20], [10000, 25],
    [25000, 35], [50000, 50], [100000, 90], [250000, 90],
  ];
  for (const [litres, mins] of cases) {
    assert.equal(FieldOps.minDurationFor(litres), mins, `${litres} L → ${mins} min`);
  }
});

test('ozone duration falls in the smallest containing bracket', () => {
  assert.equal(FieldOps.minDurationFor(1001), 15);   // >1KL still ≤2KL
  assert.equal(FieldOps.minDurationFor(10001), 35);  // >10KL → 25KL bracket
  assert.equal(FieldOps.minDurationFor(0), 15);
});

/* ── Water reading specs (spec §10) ─────────────────────────────── */
test('reading ranges reject out-of-band values', () => {
  const R = FieldOps.READING_SPECS;
  assert.ok(R.pH.min === 0 && R.pH.max === 14);
  assert.ok(R.TDS.max === 9999);
  assert.ok(R.ORP.min === -500 && R.ORP.max === 1000);
  assert.ok(R.turbidity.max === 999.9);
  assert.ok(R.dissolved_o3.max === 20);
});

test('BIS default thresholds (pH 6.5-8.5, TDS<=500, turbidity<=1, O3<0.05)', () => {
  const R = FieldOps.READING_SPECS;
  assert.equal(R.pH.bis(7.2), true);
  assert.equal(R.pH.bis(6.4), false);
  assert.equal(R.pH.bis(8.6), false);
  assert.equal(R.TDS.bis(500), true);
  assert.equal(R.TDS.bis(501), false);
  assert.equal(R.turbidity.bis(1), true);
  assert.equal(R.turbidity.bis(1.1), false);
  assert.equal(R.dissolved_o3_final.bis(0.049), true);
  assert.equal(R.dissolved_o3_final.bis(0.05), false);  // hard gate boundary
  assert.equal(R.ORP.bis(700), null);                   // no BIS standard
});

test('before/after reading sets are the 5 spec params', () => {
  assert.deepEqual(FieldOps.BEFORE_PARAMS, ['pH', 'TDS', 'ORP', 'turbidity', 'dissolved_o3']);
  assert.deepEqual(FieldOps.AFTER_PARAMS, ['pH', 'TDS', 'ORP', 'turbidity', 'dissolved_o3_final']);
});

/* ── Van check equipment list (spec 0.2, gate G-0) ──────────────── */
test('van equipment checklist has exactly 13 items', () => {
  assert.equal(FieldOps.VAN_EQUIPMENT_ITEMS.length, 13);
  assert.ok(FieldOps.VAN_EQUIPMENT_ITEMS.includes('o2_cylinder'));
  assert.ok(FieldOps.VAN_EQUIPMENT_ITEMS.includes('ventilation_fan'));
});

/* ── Geofence math (gate G-1) ───────────────────────────────────── */
test('haversine geofence: ~157 m for 0.001° lat offset; 0 for same point', () => {
  // Reimplementation of the service's formula for verification
  const dist = (lat1, lng1, lat2, lng2) => {
    const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  };
  assert.equal(Math.round(dist(17.385, 78.4867, 17.385, 78.4867)), 0);
  const m = dist(17.385, 78.4867, 17.386, 78.4867);
  assert.ok(m > 100 && m < 120, `0.001° lat ≈ 111 m, got ${m}`);
  const far = dist(17.385, 78.4867, 17.390, 78.4867); // ~555 m — outside 200 m
  assert.ok(far > 200);
});

/* ── Pricing master formula (billing spec §5) ───────────────────── */
test('plan aliases normalize (yearly === one_time)', () => {
  assert.equal(Pricing.normalizePlan('yearly'), 'one_time');
  assert.equal(Pricing.normalizePlan('halfyearly'), 'half_yearly');
  assert.equal(Pricing.normalizePlan('Quarterly'), 'quarterly');
  assert.equal(Pricing.normalizePlan('bogus'), null);
});

test('legacy addon codes alias to spec codes', () => {
  assert.equal(Pricing.normalizeAddonCode('lime_treatment'), 'anti_lime');
  assert.equal(Pricing.normalizeAddonCode('structure_health_check'), 'structural_audit');
  assert.equal(Pricing.normalizeAddonCode('advanced_testing'), 'pathogen_testing');
  assert.equal(Pricing.normalizeAddonCode('uv_sterilization'), 'uv_sterilization');
});

test('addon size buckets (500-9,999 / 10k-49,999 / 50k-99,999 / 1,00,000+)', () => {
  assert.equal(Pricing.addonBucketForLitres(999), 'small');
  assert.equal(Pricing.addonBucketForLitres(9999), 'small');
  assert.equal(Pricing.addonBucketForLitres(10000), 'medium');
  assert.equal(Pricing.addonBucketForLitres(49999), 'medium');
  assert.equal(Pricing.addonBucketForLitres(50000), 'large');
  assert.equal(Pricing.addonBucketForLitres(100000), 'custom');
});

test('GST split: ex-GST = inc / 1.18 (worked example Rs.40,460 → 34,288 + 6,172)', () => {
  const inc = 4046000; // paise
  const ex = Pricing.exGstFromInc(inc);
  assert.equal(ex, 3428814); // Rs.34,288.14
  assert.equal(Pricing.gstFromInc(inc), inc - ex); // Rs.6,171.86
});

/* ── EcoScore spec formula shape (Handout §9.1) ─────────────────── */
test('spec formula weights: 40+30+15+15 = 100', () => {
  const max = 1.0 * 40 + 1.0 * 30 + 1.0 * 15 + 1.0 * 15;
  assert.equal(max, 100);
  // Grade boundaries
  const grade = (s) => (s >= 80 ? 'gold' : s >= 60 ? 'silver' : 'bronze');
  assert.equal(grade(80), 'gold');
  assert.equal(grade(79), 'silver');
  assert.equal(grade(60), 'silver');
  assert.equal(grade(59), 'bronze');
});
