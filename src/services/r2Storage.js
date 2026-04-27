/**
 * Cloudflare R2 storage helper.
 *
 * The bucket (e.g. `kaizernews`) is shared across multiple products, so EVERY
 * key written from this service is automatically prefixed with R2_KEY_PREFIX
 * (default `ozonewash/`) to guarantee no collisions.
 *
 * Public access is served via the R2 public dev URL (R2_PUBLIC_BASE_URL /
 * R2_PUBLIC_URL). The returned `publicUrl` always points at that base.
 *
 * Use the `buildJobKey` / `buildCustomerKey` / `buildCertKey` helpers to
 * generate consistent, deterministic key paths instead of constructing strings
 * by hand at the call site.
 */

const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
const ACCOUNT_ID  = process.env.R2_ACCOUNT_ID;
const ACCESS_KEY  = process.env.R2_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY;
const SECRET_KEY  = process.env.R2_SECRET_ACCESS_KEY || process.env.R2_SECRET_KEY;
const BUCKET      = process.env.R2_BUCKET || 'kaizernews';
const ENDPOINT    = process.env.R2_ENDPOINT
  || (ACCOUNT_ID ? `https://${ACCOUNT_ID}.r2.cloudflarestorage.com` : null);
const PUBLIC_BASE = (process.env.R2_PUBLIC_BASE_URL || process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
const KEY_PREFIX  = (process.env.R2_KEY_PREFIX || 'ozonewash/').replace(/^\/+|\/+$/g, '') + '/';

// Treat as "configured" only when we have real-looking credentials. Placeholder
// values from `.env.example` start with `your-` and should fall back to demo URLs.
const isConfigured = !!(
  ACCOUNT_ID && ACCESS_KEY && SECRET_KEY && ENDPOINT &&
  !ACCOUNT_ID.startsWith('your-') && !ACCESS_KEY.startsWith('your-')
);

// Lazy-built client so loading this module never throws when R2 isn't set up
let _client = null;
function getClient() {
  if (_client) return _client;
  _client = new S3Client({
    region: 'auto',
    endpoint: ENDPOINT,
    credentials: {
      accessKeyId: ACCESS_KEY || 'placeholder',
      secretAccessKey: SECRET_KEY || 'placeholder',
    },
  });
  return _client;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Strip path traversal / weird chars from filenames before they hit R2.
function sanitizeFilename(name) {
  if (!name) return `file-${Date.now()}`;
  const base = path.basename(String(name)).replace(/[^a-zA-Z0-9._-]/g, '_');
  return base.length > 120 ? base.slice(-120) : base;
}

// Strip the global prefix from a key, then re-add it. Idempotent — safe to
// call with either a bare key (`jobs/abc/before/...`) or an already-prefixed
// one (`ozonewash/jobs/abc/...`).
function withPrefix(key) {
  const stripped = String(key).replace(/^\/+/, '').replace(new RegExp(`^${KEY_PREFIX}`), '');
  return `${KEY_PREFIX}${stripped}`;
}

function buildPublicUrl(prefixedKey) {
  if (!PUBLIC_BASE) return null;
  return `${PUBLIC_BASE}/${prefixedKey}`;
}

// ── Key builders ──────────────────────────────────────────────────────────────

/**
 * Build a key path for files attached to a job.
 *  phase: 'before' | 'after' | 'incident' | 'compliance-step-N' | 'livestream-thumbnail' | etc.
 *  Returns a key like `jobs/<jobId>/<phase>/<timestamp>-<filename>` (NO prefix).
 *  The prefix is added automatically by `uploadBuffer`.
 */
function buildJobKey({ jobId, phase, filename }) {
  if (!jobId) throw new Error('buildJobKey: jobId is required');
  if (!phase) throw new Error('buildJobKey: phase is required');
  const safePhase = String(phase).replace(/[^a-zA-Z0-9_-]/g, '-');
  const safeName  = sanitizeFilename(filename);
  return `jobs/${jobId}/${safePhase}/${Date.now()}-${safeName}`;
}

/**
 * Build a key path for files attached to a customer (cert, profile pic, address proof, …).
 * `phone` is used as the namespace because it's the user's natural id.
 */
function buildCustomerKey({ phone, kind, filename }) {
  if (!phone) throw new Error('buildCustomerKey: phone is required');
  if (!kind)  throw new Error('buildCustomerKey: kind is required');
  const safePhone = String(phone).replace(/[^0-9+]/g, '');
  const safeKind  = String(kind).replace(/[^a-zA-Z0-9_-]/g, '-');
  const safeName  = sanitizeFilename(filename);
  return `customers/${safePhone}/${safeKind}/${Date.now()}-${safeName}`;
}

/**
 * Build a key path for hygiene certificates.
 */
function buildCertKey({ certId, filename }) {
  if (!certId) throw new Error('buildCertKey: certId is required');
  const safeName = sanitizeFilename(filename);
  return `certificates/${certId}/${safeName}`;
}

// ── Core upload ───────────────────────────────────────────────────────────────

/**
 * Upload a buffer to R2 under `<KEY_PREFIX><key>` and return a public URL.
 *
 * @param {Buffer} buffer
 * @param {Object} opts
 * @param {string} opts.key           — relative key (no prefix); will be prefixed automatically
 * @param {string} opts.contentType   — MIME type
 * @returns {Promise<{ key: string, publicUrl: string }>}
 */
async function uploadBuffer(buffer, { key, contentType } = {}) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('uploadBuffer: buffer must be a Buffer');
  }
  if (!key) {
    throw new Error('uploadBuffer: key is required');
  }

  const finalKey = withPrefix(key);

  // If R2 isn't configured (placeholder env), return a demo URL so dev/CI work.
  if (!isConfigured) {
    console.warn(`[R2 DEMO] Upload skipped (R2 not configured). Key=${finalKey}`);
    return {
      key: finalKey,
      publicUrl: PUBLIC_BASE
        ? `${PUBLIC_BASE}/${finalKey}`
        : `https://demo-placeholder.ozonewash.in/${finalKey}`,
    };
  }

  await getClient().send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: finalKey,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream',
    CacheControl: 'public, max-age=31536000, immutable',
  }));

  return {
    key: finalKey,
    publicUrl: buildPublicUrl(finalKey),
  };
}

/**
 * Delete an object from R2. Accepts a prefixed or bare key.
 */
async function deleteObject(key) {
  if (!isConfigured) return;
  try {
    await getClient().send(new DeleteObjectCommand({
      Bucket: BUCKET,
      Key: withPrefix(key),
    }));
  } catch (err) {
    console.error('[R2] delete failed:', err.message);
  }
}

module.exports = {
  uploadBuffer,
  deleteObject,
  buildJobKey,
  buildCustomerKey,
  buildCertKey,
  // Exported for tests / debugging only:
  _internal: { isConfigured, KEY_PREFIX, BUCKET, PUBLIC_BASE },
};
