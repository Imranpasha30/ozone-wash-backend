const { Pool } = require('pg');
const dns = require('dns');
// app.js already loaded .env.client — don't re-load here, that caused the
// "DATABASE_URL is loaded twice with different values" inconsistency.

// Force IPv4 — Railway does not support IPv6 connections to Supabase.
dns.setDefaultResultOrder('ipv4first');

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL is not set. Set it in Railway / .env.client.');
  process.exit(1);
}

// ── Pool config — tuned for Supabase pgBouncer (port 6543 transaction-pool)
// or direct Postgres (port 5432).  Auto-detected from the URL.
const isPooler = /pooler\.supabase\.com|:6543/.test(process.env.DATABASE_URL);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase always requires SSL, dev or prod.  rejectUnauthorized:false is fine
  // because we trust the Supabase-issued cert (no MITM risk on managed Postgres).
  ssl: { rejectUnauthorized: false },

  // Max sockets.  pgBouncer pooler can handle 200+, direct Postgres ~60 on free tier.
  max: isPooler ? 25 : 10,
  min: 2,                            // keep 2 warm sockets ready (eliminates cold-start latency)
  idleTimeoutMillis: 5 * 60 * 1000,  // keep idle sockets for 5 min — kills the reconnect spam
  connectionTimeoutMillis: 5000,     // 5 s to acquire a socket before throwing
  // Hard query timeout — runaway queries (n+1 joins, missing indexes) can't pile up.
  statement_timeout: 20000,          // 20 s per statement (DB-side enforcement)
  query_timeout: 25000,              // 25 s per query (client-side fallback)
  // Keepalives — Supabase silently drops idle TCP sockets ~10 min, this prevents stale-socket reads
  keepAlive: true,
  keepAliveInitialDelayMillis: 30000,
  application_name: 'ozonewash-api',
});

// ── Logging — collapsed, dev-only, only first few connects so the log isn't spammy
let connectCount = 0;
pool.on('connect', () => {
  connectCount += 1;
  if (process.env.NODE_ENV !== 'production' && connectCount <= 3) {
    console.log(`✅ PostgreSQL pool socket ${connectCount} opened (${isPooler ? 'pooler' : 'direct'})`);
    if (connectCount === 3) console.log('   (further pool socket events silenced)');
  }
});
pool.on('remove', () => { connectCount = Math.max(0, connectCount - 1); });

// Recover from pool errors instead of process.exit — exiting kills cron jobs and
// in-flight requests for a single bad socket, which is way too aggressive.
pool.on('error', (err) => {
  console.error('[db.pool] error on idle client:', err.message);
});

// ── Query helper with slow-query logging
const SLOW_QUERY_MS = 500;
const query = async (text, params) => {
  const t0 = Date.now();
  try {
    const result = await pool.query(text, params);
    const dt = Date.now() - t0;
    if (dt > SLOW_QUERY_MS && process.env.NODE_ENV !== 'production') {
      const snippet = String(text).replace(/\s+/g, ' ').slice(0, 100);
      console.warn(`[db.slow] ${dt}ms · ${snippet}…`);
    }
    return result;
  } catch (err) {
    const snippet = String(text).replace(/\s+/g, ' ').slice(0, 100);
    console.error(`[db.error] ${err.message} · ${snippet}…`);
    throw err;
  }
};

const getClient = () => pool.connect();

// Graceful close — called from server.js on SIGTERM
const closePool = async () => {
  try { await pool.end(); console.log('[db] pool drained'); } catch (e) { /* ignore */ }
};

module.exports = { query, getClient, pool, closePool };