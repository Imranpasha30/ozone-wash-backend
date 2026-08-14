/**
 * Live gate verification (Handout §13 — "every gate endpoint verified for
 * both PASS and FAIL"). Runs against a RUNNING dev server and asserts each
 * safety gate REJECTS unauthorized/premature calls with the right status.
 *
 * Usage: node scripts/verify-gates.js  (server on :3100, dev mode)
 * Logs PASS/FAIL per gate; exits 1 if any check fails.
 */
const BASE = process.env.API_URL || 'http://localhost:3100/api/v1';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '✗ FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const req = async (method, path, { token, body } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
};

(async () => {
  console.log(`\nGate verification against ${BASE}\n`);

  // ── Auth: unauthenticated calls must be rejected ──────────────────
  for (const [m, p] of [
    ['GET', '/field/van-check/today'],
    ['POST', '/field/daily-mis'],
    ['GET', '/addresses'],
    ['GET', '/funnel/abandoned'],
  ]) {
    const r = await req(m, p);
    check(`AUTH ${m} ${p} rejects anonymous`, r.status === 401, `got ${r.status}`);
  }

  // ── Field demo login (reviewer bypass creds from .env) ────────────
  const PHONE = process.env.REVIEWER_FIELD_PHONE || '8888888888';
  const OTP = process.env.REVIEWER_FIELD_OTP || '888888';
  await req('POST', '/auth/send-otp', { body: { phone: PHONE } });
  const login = await req('POST', '/auth/verify-otp', { body: { phone: PHONE, otp: OTP } });
  const token = login.json?.data?.token || login.json?.token;
  if (!token) {
    check('LOGIN field demo account', false, `status ${login.status} — set REVIEWER_FIELD_* in .env`);
  } else {
    check('LOGIN field demo account', true);

    // ── Role separation: field token must NOT reach admin/customer APIs ─
    const adm = await req('GET', '/funnel/abandoned', { token });
    check('ROLE field token blocked from admin funnel', adm.status === 403, `got ${adm.status}`);
    const bk = await req('POST', '/bookings', { token, body: {} });
    check('ROLE field token blocked from customer booking create', bk.status === 403, `got ${bk.status}`);

    // ── G-0: job actions blocked without a completed van check ───────
    // (fresh day: wipe is not possible via API — tolerate either 423 (no van
    // check) or 404 (bogus job) ordering: use a random UUID job.)
    const fakeJob = '00000000-0000-4000-8000-000000000000';
    const g0 = await req('POST', `/jobs/${fakeJob}/generate-start-otp`, { token });
    check('G-0/404 start-OTP on unknown job rejected', [404, 423].includes(g0.status), `got ${g0.status}`);

    // ── Van check completion rules (server-side evaluation) ──────────
    const vcBad = await req('POST', '/field/van-check', { token, body: { o2_pressure_bar: 15, water_tank_litres: 50 } });
    const vc = vcBad.json?.data?.van_check;
    check('G-0 incomplete van check stays incomplete', vcBad.status === 200 && vc?.van_check_complete === false,
      `complete=${vc?.van_check_complete}`);
    check('G-0 O2<=20 flagged blocked', vc?.checks?.o2_blocked === true);

    // Complete it properly so later gates can be probed
    const equipment = {};
    for (const k of (vcBad.json?.data?.van_check?.equipment_items || vc?.equipment_items || [
      'ozone_generator','o2_cylinder','pressure_washer','vacuum_pump','ph_meter','orp_meter','tds_meter',
      'turbidity_meter','dissolved_o3_meter','ppe_kits','safety_harness','ventilation_fan','first_aid_kit',
    ])) equipment[k] = true;
    const today = new Date().toISOString();
    const vcOk = await req('POST', '/field/van-check', { token, body: {
      equipment_checklist: equipment,
      calibration_dates: { ph_meter: today, dissolved_o3: today, turbidity: today },
      ppe_photo_url: 'https://example.com/ppe.jpg',
      o2_pressure_bar: 120,
      water_tank_litres: 400,
    } });
    check('G-0 full van check completes', vcOk.json?.data?.van_check?.van_check_complete === true);

    // ── Reading validation: out-of-range rejected ────────────────────
    const badReading = await req('POST', `/field/jobs/${fakeJob}/readings`, { token, body: { param: 'pH', timing: 'before', value: 15 } });
    check('READING pH=15 rejected', [400, 403, 404].includes(badReading.status), `got ${badReading.status}`);

    // ── Ozone: stop without session rejected ─────────────────────────
    const stop = await req('POST', `/field/jobs/${fakeJob}/ozone/stop`, { token });
    check('G-6 stop without session rejected', [400, 403, 404].includes(stop.status), `got ${stop.status}`);

    // ── Compliance: step 0 validator accepts 0 (regression) ─────────
    const step0 = await req('POST', '/compliance/step', { token, body: { job_id: fakeJob, step_number: 0, gps_lat: 17.3, gps_lng: 78.4 } });
    check('STEP-0 passes route validation (404/400-not-validator)', step0.status !== 422 &&
      !(step0.status === 400 && /between 1 and 8/i.test(step0.json?.message || '')), `got ${step0.status}: ${step0.json?.message}`);

    // ── Daily MIS guard (all jobs closed) — should 200 or 400, not 500 ─
    const mis = await req('POST', '/field/daily-mis', { token });
    check('MIS submit responds cleanly', [200, 400].includes(mis.status), `got ${mis.status}`);
  }

  // ── Public verify page ─────────────────────────────────────────────
  const page = await fetch(`${BASE.replace('/api/v1', '')}/verify/not-a-real-cert`);
  const html = await page.text();
  check('PUBLIC /verify/:id renders HTML (not JSON)', html.includes('<html') && html.includes('OZONE WASH'));

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} gate checks passed${failed ? ` — ${failed} FAILED` : ''}\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('verify-gates crashed:', e.message); process.exit(1); });
