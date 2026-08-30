/**
 * Dynamic scheduling engine.
 *
 * The admin configures (app_settings.scheduling, editable via
 * PUT /admin/settings/scheduling):
 *   vans                  — concurrent crews; capacity per time window
 *   clean_minutes_by_tier — cleaning minutes PER TANK by size bracket (1..8)
 *   travel_buffer_min     — travel between distinct tank locations (~45 min)
 *   workday_start/end     — bookable window
 *   slot_step_min         — slot granularity
 *
 * Rules:
 *   duration = Σ clean_minutes(tank size)          … every tank
 *            + travel_buffer × (locations − 1)     … multi-location bookings
 *   A slot is offered only if fewer than `vans` existing jobs overlap the
 *   ENTIRE [start, start+duration) window on that date.
 */
const db = require('../config/db');

const DEFAULTS = {
  vans: 2,
  travel_buffer_min: 45,
  workday_start: '08:00',
  workday_end: '18:00',
  slot_step_min: 30,
  clean_minutes_by_tier: { 1: 60, 2: 90, 3: 120, 4: 150, 5: 180, 6: 210, 7: 240, 8: 300 },
};

let _cache = null, _cacheAt = 0;
async function settings() {
  if (_cache && Date.now() - _cacheAt < 60_000) return _cache;
  try {
    const { rows } = await db.query(`SELECT value FROM app_settings WHERE key = 'scheduling'`);
    _cache = { ...DEFAULTS, ...(rows[0]?.value || {}) };
    _cache.clean_minutes_by_tier = { ...DEFAULTS.clean_minutes_by_tier, ...(rows[0]?.value?.clean_minutes_by_tier || {}) };
  } catch { _cache = _cache || DEFAULTS; }
  _cacheAt = Date.now();
  return _cache;
}
const invalidate = () => { _cache = null; };

// Size bracket (mirrors pricing_tiers ranges)
const tierForLitres = (litres) => {
  const n = Number(litres) || 0;
  if (n <= 1000) return 1;
  if (n <= 10000) return 2;
  if (n <= 20000) return 3;
  if (n <= 30000) return 4;
  if (n <= 40000) return 5;
  if (n <= 50000) return 6;
  if (n <= 100000) return 7;
  return 8;
};

/**
 * Total service minutes for a booking.
 *   tanks     — array of litres (or {tank_size_litres, address?})
 *   locations — number of DISTINCT service locations (default derived from
 *               per-tank addresses when objects are passed; min 1)
 */
async function durationFor(tanks = [], locationsArg = null) {
  const s = await settings();
  const list = (tanks.length ? tanks : [{ tank_size_litres: 1000 }])
    .map((t) => (typeof t === 'object' ? t : { tank_size_litres: t }));

  let clean = 0;
  for (const t of list) {
    const tier = tierForLitres(t.tank_size_litres);
    clean += Number(s.clean_minutes_by_tier[tier] ?? s.clean_minutes_by_tier[String(tier)] ?? 120);
  }

  let locations = Number(locationsArg);
  if (!Number.isFinite(locations) || locations < 1) {
    locations = 1 + list.filter((t, i) => i > 0 && t.address).length;
  }
  const travel = Math.max(0, locations - 1) * Number(s.travel_buffer_min);

  return {
    duration_min: clean + travel,
    clean_min: clean,
    travel_min: travel,
    locations,
    per_tank: list.map((t) => ({
      litres: Number(t.tank_size_litres) || 0,
      minutes: Number(s.clean_minutes_by_tier[tierForLitres(t.tank_size_litres)] ?? 120),
    })),
  };
}

const hmToMin = (hm) => {
  const [h, m] = String(hm).split(':').map(Number);
  return h * 60 + (m || 0);
};

/**
 * Capacity-aware slots for a date.
 * Returns [{ time:'08:00', start_iso, end_time:'11:45', available, vans_free }]
 */
async function slotsForDate(date, tanks = [], locations = null) {
  const s = await settings();
  const need = await durationFor(tanks, locations);

  // Existing load: every active job that day occupies [start, start+duration)
  const { rows: busy } = await db.query(
    `SELECT scheduled_at, COALESCE(duration_min, 120) AS dur
       FROM jobs
      WHERE DATE(scheduled_at) = $1
        AND status IN ('scheduled', 'in_progress')`,
    [date]
  );
  const windows = busy.map((b) => {
    const st = new Date(b.scheduled_at);
    const startMin = st.getHours() * 60 + st.getMinutes();
    return [startMin, startMin + Number(b.dur)];
  });

  const dayStart = hmToMin(s.workday_start);
  const dayEnd = hmToMin(s.workday_end);
  const step = Math.max(15, Number(s.slot_step_min));
  const vans = Math.max(1, Number(s.vans));

  const slots = [];
  for (let t = dayStart; t + need.duration_min <= dayEnd; t += step) {
    const tEnd = t + need.duration_min;
    const overlapping = windows.filter(([a, b]) => a < tEnd && b > t).length;
    const free = vans - overlapping;
    const hh = String(Math.floor(t / 60)).padStart(2, '0');
    const mm = String(t % 60).padStart(2, '0');
    const eh = String(Math.floor(tEnd / 60)).padStart(2, '0');
    const em = String(tEnd % 60).padStart(2, '0');
    slots.push({
      time: `${hh}:${mm}`,
      end_time: `${eh}:${em}`,
      available: free > 0,
      vans_free: Math.max(0, free),
    });
  }

  return {
    date,
    duration_min: need.duration_min,
    clean_min: need.clean_min,
    travel_min: need.travel_min,
    locations: need.locations,
    per_tank: need.per_tank,
    vans_total: vans,
    slots,
  };
}

/** Capacity check for one specific window (booking create). */
async function capacityOk(slotTimeIso, durationMin) {
  const s = await settings();
  const start = new Date(slotTimeIso);
  const end = new Date(start.getTime() + durationMin * 60000);
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n
       FROM jobs
      WHERE status IN ('scheduled', 'in_progress')
        AND scheduled_at < $2
        AND scheduled_at + make_interval(mins => COALESCE(duration_min, 120)) > $1`,
    [start.toISOString(), end.toISOString()]
  );
  return { ok: rows[0].n < Math.max(1, Number(s.vans)), busy: rows[0].n, vans: Number(s.vans) };
}

/**
 * Does crew `teamId` already have a scheduled/in-progress job that OVERLAPS the
 * window [slotTimeIso, slotTimeIso + durationMin)? Duration-aware (not a fixed
 * ±window), excludes the job being (re)assigned. Returns the clashing job or null.
 * This is what prevents booking one crew into two overlapping jobs.
 */
async function crewOverlap(teamId, slotTimeIso, durationMin, excludeJobId = null) {
  if (!teamId) return null;
  const start = new Date(slotTimeIso);
  const end = new Date(start.getTime() + (Number(durationMin) || 120) * 60000);
  const { rows } = await db.query(
    `SELECT id, scheduled_at, duration_min
       FROM jobs
      WHERE assigned_team_id = $1
        AND status IN ('scheduled','in_progress')
        AND ($4::uuid IS NULL OR id <> $4::uuid)
        AND scheduled_at < $3
        AND scheduled_at + make_interval(mins => COALESCE(duration_min, 120)) > $2
      ORDER BY scheduled_at ASC
      LIMIT 1`,
    [teamId, start.toISOString(), end.toISOString(), excludeJobId]
  );
  return rows[0] || null;
}

/**
 * Per-date booking mutex — closes the check-then-insert race.
 *
 * Two customers booking the last free van simultaneously could BOTH pass the
 * capacity read before either insert lands. A Postgres advisory lock keyed by
 * the slot DATE serializes create-booking critical sections; it lives in the
 * database, so it also works across multiple server instances. Bookings on
 * different dates don't contend at all.
 *
 *   const release = await acquireSlotLock('2026-08-20');
 *   try { ...capacity check + booking + job insert... } finally { await release(); }
 *
 * Safety: the lock is session-scoped — if the process dies mid-create, the
 * DB frees it automatically when the connection drops (no deadlock).
 */
async function acquireSlotLock(dateKey) {
  const client = await db.getClient();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [`slots:${dateKey}`]);
  } catch (e) {
    client.release();
    throw e;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`slots:${dateKey}`]); }
    catch (_) { /* connection drop frees the lock anyway */ }
    finally { client.release(); }
  };
}

module.exports = { settings, durationFor, slotsForDate, capacityOk, crewOverlap, tierForLitres, invalidate, acquireSlotLock, DEFAULTS };
