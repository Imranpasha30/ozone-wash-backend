/**
 * IST (Asia/Kolkata) date helpers.
 *
 * The process is pinned to IST via `process.env.TZ` in server.js, which fixes
 * all LOCAL Date methods (getHours/getDate/…) and naive-string parsing. But
 * `Date.prototype.toISOString()` is ALWAYS UTC regardless of TZ — so any place
 * that derived a business "date key" via `toISOString().slice(0,10)` was off by
 * one day for ~5.5h after IST midnight. Use these helpers for business date
 * keys instead.
 *
 * Built on Intl so they stay correct even if the TZ pin is ever removed
 * (defence-in-depth). Do NOT use these to build timestamptz instant boundaries
 * for DB comparisons — those must stay UTC (use toISOString()).
 */

// en-CA formats as YYYY-MM-DD, in the requested time zone.
const _ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' });

/** IST calendar date key 'YYYY-MM-DD' for a Date (or anything Date accepts). */
function istDateKey(d = new Date()) {
  return _ymd.format(d instanceof Date ? d : new Date(d));
}

/** IST year/month/day as zero-padded strings: { y:'2026', m:'08', d:'31' }. */
function istYMD(d = new Date()) {
  const s = istDateKey(d);
  return { y: s.slice(0, 4), m: s.slice(5, 7), d: s.slice(8, 10) };
}

module.exports = { istDateKey, istYMD };
