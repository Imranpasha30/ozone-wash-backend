require('dotenv').config();

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
const ALLOWED_ORIGINS = process.env.NODE_ENV === 'production'
  ? (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean)
  : true; // Allow all in dev

app.use(cors({
  origin: ALLOWED_ORIGINS,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
  maxAge: 86400, // Browser caches preflight for 24h — reduces OPTIONS requests
}));

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
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'production' ? 60 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please slow down.' },
  skip: (req) => req.path === '/api-docs', // Don't rate-limit docs
});
app.use('/api', limiter);

// OTP rate limit — max 3 per 5 minutes per IP
const otpLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many OTP requests. Please wait 5 minutes.' },
});
app.use('/api/v1/auth/send-otp', otpLimiter);

// ── Body Parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' })); // Tighter limit in production
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

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/v1', routes);

// ── Error Handlers ────────────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

module.exports = app;
