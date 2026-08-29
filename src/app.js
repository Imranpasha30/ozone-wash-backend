require('dotenv').config({ path: require('path').resolve(__dirname, '../.env.client') });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./config/swagger');

const routes = require('./routes/index');
const { errorHandler, notFound } = require('./middleware/error.middleware');

const app = express();

// Trust Railway's reverse proxy — required for correct IP in rate limiters
app.set('trust proxy', 1);

// ── Security Headers ─────────────────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // Allow R2 image serving
}));

// ── CORS ─────────────────────────────────────────────────────────────────────
// Always allow localhost + LAN-range origins so the web dev server (Expo on
// 8081) can hit the API regardless of NODE_ENV. In production, also allow the
// explicit ALLOWED_ORIGINS list. The function form is required because the
// allow set is dynamic per request origin.
const STATIC_ALLOWED = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(o => o.trim()).filter(Boolean);

// Matches: http://localhost:<port> | http://127.0.0.1:<port> | http://192.168.x.x:<port>
//          http://10.x.x.x:<port>  | http://172.16-31.x.x:<port>  (RFC1918 private ranges)
const PRIVATE_ORIGIN_REGEX = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/;

const corsOriginCheck = (origin, callback) => {
  // Same-origin / no-origin (curl, server-to-server) → allow
  if (!origin) return callback(null, true);
  // Production allow-list
  if (STATIC_ALLOWED.includes(origin)) return callback(null, true);
  // Always allow localhost + RFC1918 dev origins (helps Expo web on LAN)
  if (PRIVATE_ORIGIN_REGEX.test(origin)) return callback(null, true);
  // In non-production, be permissive
  if (process.env.NODE_ENV !== 'production') return callback(null, true);
  callback(new Error(`CORS: origin '${origin}' not allowed`));
};

const corsMiddleware = cors({
  origin: corsOriginCheck,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
  maxAge: 86400, // Browser caches preflight for 24h — reduces OPTIONS requests
});

// Payment-gateway callbacks/webhooks are form POSTs whose Origin is the gateway's
// OWN domain (e.g. https://test.payu.in) — not an app origin. They carry no JWT
// and are hash/signature-verified inside their handlers, so the browser-origin
// allowlist adds no security here; it only makes corsOriginCheck THROW → 500 and
// silently drops the settlement. Bypass CORS for these routes only; every other
// route still goes through the strict allowlist.
const CORS_EXEMPT_PATHS = new Set([
  '/api/v1/payments/payu/callback',
  '/api/v1/payments/payu/callback/web',
  '/api/v1/payments/easebuzz/callback',
  '/api/v1/payments/webhook/razorpay',
]);
app.use((req, res, next) => {
  if (CORS_EXEMPT_PATHS.has(req.path)) return next();
  return corsMiddleware(req, res, next);
});

// ── Compression ───────────────────────────────────────────────────────────────
// Gzip/Brotli — cuts JSON response size by ~70%. Critical for mobile data costs.
app.use(compression({
  level: 6,          // Balanced speed vs compression ratio
  threshold: 1024,   // Only compress responses > 1KB
  filter: (req, res) => {
    // Don't compress if client explicitly says no
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  },
}));

// ── Rate Limiting ─────────────────────────────────────────────────────────────
// Key by JWT user-id when present (multiple techs on the same office Wi-Fi share an
// IP otherwise). Falls back to IP for unauthenticated traffic.
const keyByUserOrIp = (req /*, res */) => {
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) {
    // Cheap signature-skip JWT decode (we don't verify here, just bucket by sub).
    try {
      const payload = auth.slice(7).split('.')[1];
      const decoded = JSON.parse(Buffer.from(payload, 'base64').toString());
      if (decoded?.id || decoded?.sub) return `u:${decoded.id || decoded.sub}`;
    } catch { /* fall through to IP */ }
  }
  return req.ip;
};

// Generous default — covers a busy field-tech doing an 8-step compliance job
// (multiple photo uploads + ecoscore + ratings + status calls). Photo uploads
// have their own multer limit; this is purely API call throttling.
const limiter = rateLimit({
  windowMs: 60 * 1000,                 // 1 minute window
  max: process.env.NODE_ENV === 'production' ? 240 : 2000,  // 240/min ≈ 4 req/sec sustained
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUserOrIp,
  message: { success: false, message: 'Too many requests. Please slow down.' },
  skip: (req) => req.path === '/api-docs' || req.path === '/health',
});
app.use('/api', limiter);

// OTP rate limit — max 5 per 5 minutes per phone (prevents abuse, allows retries)
const otpLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.body?.phone || req.ip,
  message: { success: false, message: 'Too many OTP requests. Please wait 5 minutes.' },
});
app.use('/api/v1/auth/send-otp', otpLimiter);

// Photo upload limit — 60 per minute per user (≈ one full job's worth of photos)
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUserOrIp,
  message: { success: false, message: 'Too many uploads in a row. Please wait a moment.' },
});
app.use('/api/v1/upload', uploadLimiter);

// ── Body Parsing ──────────────────────────────────────────────────────────────
// Capture the raw body so gateway webhooks (Razorpay) can be signature-verified
// against the exact bytes received — JSON.stringify(req.body) is NOT byte-stable.
app.use(express.json({
  limit: '2mb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ── Cache-Control for static assets ──────────────────────────────────────────
app.use('/certificates', (_req, res, next) => {
  res.set('Cache-Control', 'public, max-age=86400'); // 1 day
  next();
});
app.use('/certificates', express.static(
  require('path').join(process.cwd(), 'certificates')
));

// ── Request Logging (dev only) ────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  app.use((req, res, next) => {
    console.log(`→ ${req.method} ${req.path}`);
    next();
  });
}

// ── Swagger Docs ──────────────────────────────────────────────────────────────
// Disabled in production — only serve in dev/staging
if (process.env.NODE_ENV !== 'production') {
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    customSiteTitle: 'Ozone Wash API Docs',
    customCss: '.swagger-ui .topbar { background-color: #1a1a2e; }',
  }));
}

// ── Health Check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', env: process.env.NODE_ENV, ts: Date.now() });
});

// ── Public certificate verify page (QR target — no auth) ─────────────────────
// The certificate QR encodes {APP_URL}/verify/<certId>; anyone scanning gets a
// human-readable validity page instead of raw API JSON (spec 6.2 / 9.2).
app.get('/verify/:certId', async (req, res) => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let body;
  try {
    const CertificateService = require('./modules/certificates/certificate.service');
    const v = await CertificateService.verifyCertificate(req.params.certId);
    const ok = v?.valid === true;
    body = `
      <div class="badge ${ok ? 'ok' : 'bad'}">${ok ? '&#10003; VALID CERTIFICATE' : '&#10007; NOT VALID'}</div>
      <h2>Digital Hygiene Certificate</h2>
      <table>
        <tr><td>Certificate No</td><td>${esc(v.certificate_number || req.params.certId)}</td></tr>
        <tr><td>Customer</td><td>${esc(v.customer_name || '—')}</td></tr>
        <tr><td>Tank</td><td>${esc((v.tank_type || '—').toUpperCase())}</td></tr>
        <tr><td>EcoScore</td><td>${esc(v.eco_score ?? '—')}</td></tr>
        <tr><td>Service date</td><td>${v.service_date ? new Date(v.service_date).toLocaleDateString('en-IN') : '—'}</td></tr>
        <tr><td>Valid until</td><td>${v.valid_until ? new Date(v.valid_until).toLocaleDateString('en-IN') : '—'}</td></tr>
      </table>
      ${v.certificate_url ? `<a class="btn" href="${esc(v.certificate_url)}">Download PDF</a>` : ''}`;
  } catch (e) {
    body = `<div class="badge bad">&#10007; CERTIFICATE NOT FOUND</div>
      <p class="reason">${esc(e?.message || 'This certificate could not be verified.')}</p>`;
  }
  res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OzoneWash — Certificate Verification</title>
<style>
  body{font-family:system-ui,sans-serif;background:#f4f6f9;margin:0;padding:24px;color:#16324f}
  .card{max-width:420px;margin:6vh auto;background:#fff;border-radius:16px;padding:28px;box-shadow:0 8px 30px rgba(22,50,79,.12);text-align:center}
  .brand{font-weight:800;letter-spacing:.5px;color:#1a1a2e;font-size:20px;margin-bottom:18px}
  .badge{display:inline-block;padding:8px 18px;border-radius:999px;font-weight:800;font-size:14px;margin-bottom:14px}
  .badge.ok{background:#e8f7ee;color:#16a34a}.badge.bad{background:#fdecec;color:#dc2626}
  h2{font-size:17px;margin:6px 0 16px}
  table{width:100%;border-collapse:collapse;font-size:14px;text-align:left}
  td{padding:8px 4px;border-bottom:1px solid #eef1f5}td:first-child{color:#6b7280}
  .btn{display:inline-block;margin-top:18px;background:#2563EB;color:#fff;text-decoration:none;padding:11px 22px;border-radius:10px;font-weight:700;font-size:14px}
  .reason{color:#6b7280;font-size:13px}
  .foot{margin-top:16px;font-size:11px;color:#9ca3af}
</style></head><body><div class="card">
  <div class="brand">OZONE WASH</div>
  ${body}
  <div class="foot">VijRam Health Sense Pvt. Ltd. · ozonewash.in</div>
</div></body></html>`);
});

// In-app payment-return sentinel. The mobile checkout WebView intercepts this
// navigation and routes in-app (it never actually loads it). Shown only if a
// plain browser happens to land here.
app.get('/payu-app-return', (req, res) => {
  const ok = String(req.query.ozw_payment) === 'success';
  res.set('Content-Type', 'text/html').send(`<!doctype html><html><body style="font-family:sans-serif;text-align:center;padding-top:40vh;background:#fff">
<p>${ok ? '✅ Payment successful.' : '❌ Payment failed.'} You can return to the Ozone Wash app.</p></body></html>`);
});

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/v1', routes);


// ── Error Handlers ────────────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

module.exports = app;
