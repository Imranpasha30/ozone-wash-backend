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

// Calendar-date key for a slot. Prefers the ISO date prefix (client-sent
// strings), else falls back to the LOCAL date components (consistent with how
// slot hours are interpreted below via Date#getHours). True IST pinning is a
// separate Wave-6 task; date-level matching is stable within business hours.
const toDateKey = (v) => {
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return s.slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

// Statuses that make a crew unavailable for a date (removes one unit of
// concurrent capacity and blocks assigning that crew).
const UNAVAILABLE_STATUSES = ['leave', 'sick', 'off'];

// Base concurrent-capacity pool for a resource type. Tank cleaning and
// auto-wash draw from SEPARATE pools so an auto-wash job can't consume a tank
// van (and vice-versa). Admin may set per-resource sizes via
// scheduling.vans_by_resource = { tank: 2, vehicle: 1 }; falls back to the
// flat `vans` for any resource without an explicit override.
const poolBase = (s, resourceType) => {
  const byRes = s.vans_by_resource || {};
  const raw = resourceType != null && byRes[resourceType] != null ? byRes[resourceType] : s.vans;
  return Math.max(0, Number(raw) || 0);
};

// How many crews are marked leave/sick/off on `date`. 0 if the table or data
// is absent — so capacity degrades to the configured fleet, never to zero on a
// day the admin hasn't touched.
async function unavailableCrewCount(date) {
  try {
    // A "van"/crew = an active FIELD TEAM, keyed on its lead agent (the board
    // sets availability on leader_id and the guard keys on assigned_team_id =
    // leader_id). So count off-LEADERS only: a non-leader member marked off
    // removes no van and must NOT deflate capacity. DISTINCT guards the (rare)
    // case of one agent leading multiple teams.
    const { rows } = await db.query(
      `SELECT COUNT(DISTINCT t.id)::int AS n
         FROM crew_availability ca
         JOIN field_teams t ON t.leader_id = ca.agent_id AND t.is_active = TRUE
        WHERE ca.date = $1 AND ca.status = ANY($2)`,
      [toDateKey(date), UNAVAILABLE_STATUSES]
    );
    return rows[0]?.n || 0;
  } catch (_) {
    return 0; // table may not exist yet — fall back to the configured fleet
  }
}

/**
 * Effective concurrent capacity for a date + resource pool:
 *   configured pool  −  crews marked unavailable that day  (floored at 0).
 * Replaces the static `vans` integer everywhere capacity is evaluated.
 */
async function effectiveVans(date, resourceType = null) {
  const s = await settings();
  const base = poolBase(s, resourceType);
  const out = await unavailableCrewCount(date);
  return Math.max(0, base - out);
}

/**
 * Is crew `teamId` unavailable for the window [slotTimeIso, +durationMin)?
 * Returns a human reason string (leave/sick/off, or job outside shift) or null
 * when the crew is free to take it. No record → available (null).
 */
async function crewAvailabilityBlock(teamId, slotTimeIso, durationMin) {
  if (!teamId) return null;
  let row;
  try {
    const { rows } = await db.query(
      `SELECT status, shift_start, shift_end FROM crew_availability
        WHERE agent_id = $1 AND date = $2`,
      [teamId, toDateKey(slotTimeIso)]
    );
    row = rows[0];
  } catch (_) {
    return null; // table absent — don't block
  }
  if (!row) return null;
  if (UNAVAILABLE_STATUSES.includes(row.status)) {
    return `That crew is marked ${row.status} on ${toDateKey(slotTimeIso)}.`;
  }
  // Shift window (optional): the whole job must fit inside [start, end).
  if (row.shift_start && row.shift_end) {
    const start = new Date(slotTimeIso);
    const jobStart = start.getHours() * 60 + start.getMinutes();
    const jobEnd = jobStart + (Number(durationMin) || 120);
    const shiftStart = hmToMin(row.shift_start);
    const shiftEnd = hmToMin(row.shift_end);
    if (jobStart < shiftStart || jobEnd > shiftEnd) {
      return `That crew's shift on ${toDateKey(slotTimeIso)} is ${String(row.shift_start).slice(0, 5)}–${String(row.shift_end).slice(0, 5)}; this job falls outside it.`;
    }
  }
  return null;
}

/**
 * Capacity-aware slots for a date.
 * Returns [{ time:'08:00', start_iso, end_time:'11:45', available, vans_free }]
 */
async function slotsForDate(date, tanks = [], locations = null, resourceType = 'tank') {
  const s = await settings();
  const need = await durationFor(tanks, locations);

  // Existing load in THIS resource pool: every active job of the same
  // resource_type that day occupies [start, start+duration). Filtering by
  // resource_type keeps auto-wash jobs from consuming tank-cleaning capacity
  // (and vice-versa) — they draw from separate pools.
  const { rows: busy } = await db.query(
    `SELECT scheduled_at, COALESCE(duration_min, 120) AS dur
       FROM jobs
      WHERE DATE(scheduled_at) = $1
        AND status IN ('scheduled', 'in_progress')
        AND ($2::text IS NULL OR resource_type = $2)`,
    [date, resourceType]
  );
  const windows = busy.map((b) => {
    const st = new Date(b.scheduled_at);
    const startMin = st.getHours() * 60 + st.getMinutes();
    return [startMin, startMin + Number(b.dur)];
  });

  const dayStart = hmToMin(s.workday_start);
  const dayEnd = hmToMin(s.workday_end);
  const step = Math.max(15, Number(s.slot_step_min));
  // Effective capacity: pool base for this resource minus crews on leave/sick/
  // off that day. May legitimately be 0 (all crews out → no slots offered).
  const vans = await effectiveVans(date, resourceType);

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

/**
 * Capacity check for one specific window (booking create / hold reinstatement).
 * Counts only jobs in the SAME resource pool and compares against the effective
 * van count (configured pool minus crews unavailable that day). Pass
 * resourceType null to check across all pools (legacy behaviour).
 */
async function capacityOk(slotTimeIso, durationMin, resourceType = 'tank') {
  const start = new Date(slotTimeIso);
  const end = new Date(start.getTime() + (Number(durationMin) || 120) * 60000);
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n
       FROM jobs
      WHERE status IN ('scheduled', 'in_progress')
        AND ($3::text IS NULL OR resource_type = $3)
        AND scheduled_at < $2
        AND scheduled_at + make_interval(mins => COALESCE(duration_min, 120)) > $1`,
    [start.toISOString(), end.toISOString(), resourceType]
  );
  const vans = await effectiveVans(toDateKey(slotTimeIso), resourceType);
  return { ok: rows[0].n < vans, busy: rows[0].n, vans };
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

module.exports = {
  settings, durationFor, slotsForDate, capacityOk, crewOverlap,
  effectiveVans, unavailableCrewCount, crewAvailabilityBlock,
  tierForLitres, invalidate, acquireSlotLock, toDateKey,
  UNAVAILABLE_STATUSES, DEFAULTS,
};
