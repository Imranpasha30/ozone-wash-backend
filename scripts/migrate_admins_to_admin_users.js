/**
 * One-time data migration: move existing users.role='admin' rows into the new
 * admin_users table introduced by migration 012.
 *
 * Spec: Master Prompt v2.0 PART 2.2.7 (Migration Safety Note)
 *
 * Run BEFORE applying migration 013 (which drops 'admin' from users.role).
 *
 * What this script does for each admin row in users:
 *   1. Generate a username from the user's name (lowercased, dotted, deduped).
 *   2. Generate a random 16-char temporary password (bcrypt hashed at cost 12).
 *   3. Insert an admin_users row with admin_role='super_admin'
 *      (existing admins were already top-tier in the old model).
 *   4. Print the username + temporary password to stdout so the operator can
 *      share these credentials out-of-band with each admin.
 *
 * Idempotent: skips users that already exist in admin_users by email.
 * Does NOT delete the user row — migration 013's CHECK guard handles that
 * by raising an exception until you clean up manually.
 *
 * Usage:
 *   cd ozone-wash-backend
 *   node scripts/migrate_admins_to_admin_users.js
 *
 * Output: a table of (username, email, temp_password). Save it securely.
 */

const crypto = require('crypto');
const bcrypt = require('bcrypt');
require('dotenv').config({
  path: require('path').resolve(__dirname, '../.env.client'),
});

const { query, closePool } = require('../src/config/db');

const BCRYPT_COST = 12;

function randomPassword() {
  // 16-char base64 (no padding), URL-safe
  return crypto.randomBytes(12).toString('base64')
    .replace(/\+/g, '@')
    .replace(/\//g, '!')
    .replace(/=+$/, '');
}

function deriveUsername(name, phone, takenSet) {
  const safe = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join('.');
  let base = safe || `admin.${String(phone || '').slice(-4)}`;
  let candidate = base;
  let n = 1;
  while (takenSet.has(candidate)) {
    candidate = `${base}${n}`;
    n += 1;
  }
  takenSet.add(candidate);
  return candidate;
}

async function main() {
  console.log('\n→ Fetching existing admin rows from users…');
  const { rows: oldAdmins } = await query(
    `SELECT id, phone, email, name FROM users WHERE role = 'admin' ORDER BY created_at ASC`
  );

  if (oldAdmins.length === 0) {
    console.log('✓ No users with role=admin found. Nothing to migrate.\n');
    return;
  }

  console.log(`  Found ${oldAdmins.length} admin user(s) to migrate.\n`);

  const { rows: takenRows } = await query(`SELECT username FROM admin_users`);
  const takenUsernames = new Set(takenRows.map((r) => r.username));

  const results = [];
  for (const u of oldAdmins) {
    // Skip if an admin_users row already exists for this email
    if (u.email) {
      const { rows: existing } = await query(
        `SELECT id FROM admin_users WHERE email = $1`,
        [u.email]
      );
      if (existing.length) {
        results.push({
          name: u.name,
          email: u.email,
          username: existing[0].username || '(existing)',
          temp_password: '(already migrated — skipped)',
        });
        continue;
      }
    }

    const username = deriveUsername(u.name, u.phone, takenUsernames);
    const email = u.email || `${username}@ozonewash.in`;
    const tempPassword = randomPassword();
    const passwordHash = await bcrypt.hash(tempPassword, BCRYPT_COST);

    await query(
      `INSERT INTO admin_users (username, email, password_hash, full_name, phone, admin_role, is_active)
       VALUES ($1, $2, $3, $4, $5, 'super_admin', true)`,
      [username, email, passwordHash, u.name || username, u.phone || null]
    );

    results.push({
      name: u.name || '(no name)',
      email,
      username,
      temp_password: tempPassword,
    });
  }

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  ADMIN MIGRATION COMPLETE — save these credentials securely:');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Each admin must change their password on first login.\n');

  console.table(results);

  console.log('\nNext steps:');
  console.log('  1. Securely share each admin\'s temp_password out-of-band.');
  console.log('  2. Apply migration 013_remove_admin_from_users_role.sql.');
  console.log('  3. Verify all admins can log in via /api/v1/admin-auth/login.');
  console.log('  4. Force every admin to change their password via the app.\n');
}

main()
  .catch((err) => {
    console.error('✖ Migration failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await closePool();
  });
