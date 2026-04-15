/**
 * Database migration runner
 *
 * Usage:
 *   npm run migrate          — apply all pending migrations
 *   npm run migrate:status   — show which migrations are applied / pending
 *
 * How it works:
 *   1. Creates a `schema_migrations` table if it doesn't exist
 *   2. Reads all *.sql files from /migrations ordered by filename (001_, 002_, …)
 *   3. Skips migrations already recorded in schema_migrations
 *   4. Runs each pending migration inside a transaction — rolls back on error
 *   5. Records the migration name in schema_migrations on success
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env.client') });

const { Pool } = require('pg');
const fs   = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '../migrations');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* ── helpers ─────────────────────────────────────────────────────── */
const log  = (msg) => console.log(`[migrate] ${msg}`);
const ok   = (msg) => console.log(`[migrate] ✓ ${msg}`);
const skip = (msg) => console.log(`[migrate] – ${msg} (already applied)`);
const err  = (msg) => console.error(`[migrate] ✗ ${msg}`);

/* ── ensure tracking table exists ───────────────────────────────── */
async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         SERIAL PRIMARY KEY,
      name       VARCHAR(255) UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

/* ── get already-applied migration names ────────────────────────── */
async function getApplied(client) {
  const { rows } = await client.query(
    'SELECT name FROM schema_migrations ORDER BY id'
  );
  return new Set(rows.map(r => r.name));
}

/* ── get all migration files sorted by name ─────────────────────── */
function getMigrationFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort(); // lexicographic — 001_ < 002_ < 003_
}

/* ── run a single migration inside a transaction ────────────────── */
async function runMigration(client, filename) {
  const filepath = path.join(MIGRATIONS_DIR, filename);
  const sql = fs.readFileSync(filepath, 'utf8');

  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query(
      'INSERT INTO schema_migrations (name) VALUES ($1)',
      [filename]
    );
    await client.query('COMMIT');
    ok(filename);
  } catch (e) {
    await client.query('ROLLBACK');
    err(`${filename} — ${e.message}`);
    throw e;
  }
}

/* ── status command — just print what's applied / pending ───────── */
async function statusCommand() {
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await getApplied(client);
    const files   = getMigrationFiles();

    console.log('\n Migration Status\n' + '─'.repeat(50));
    if (files.length === 0) {
      console.log('  No migration files found in /migrations');
    } else {
      for (const f of files) {
        const state = applied.has(f) ? '✓ applied ' : '○ pending ';
        console.log(`  ${state}  ${f}`);
      }
    }
    console.log('─'.repeat(50) + '\n');
  } finally {
    client.release();
    await pool.end();
  }
}

/* ── main migrate command ────────────────────────────────────────── */
async function migrateCommand() {
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await getApplied(client);
    const files   = getMigrationFiles();

    const pending = files.filter(f => !applied.has(f));

    if (pending.length === 0) {
      log('All migrations already applied. Database is up to date.');
      return;
    }

    log(`Found ${pending.length} pending migration(s):`);
    for (const f of pending) {
      log(`  → ${f}`);
    }
    console.log('');

    for (const f of pending) {
      await runMigration(client, f);
    }

    console.log('');
    log(`Done. ${pending.length} migration(s) applied successfully.`);

    // Print files that were already applied
    const alreadyApplied = files.filter(f => applied.has(f));
    if (alreadyApplied.length > 0) {
      for (const f of alreadyApplied) {
        skip(f);
      }
    }
  } catch (e) {
    err(`Migration failed. All changes rolled back.`);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

/* ── entry point ─────────────────────────────────────────────────── */
const command = process.argv[2];

if (command === 'status') {
  statusCommand().catch(() => process.exit(1));
} else {
  migrateCommand().catch(() => process.exit(1));
}
