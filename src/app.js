require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./config/swagger');

const routes = require('./routes/index');
const { errorHandler, notFound } = require('./middleware/error.middleware');

const app = express();

// Security
app.use(helmet());
app.use(cors());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { success: false, message: 'Too many requests. Please slow down.' },
});
app.use('/api', limiter);

// OTP rate limit - max 3 requests per 5 minutes
const otpLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 3,
  message: { success: false, message: 'Too many OTP requests. Please wait 5 minutes.' },
});
app.use('/api/v1/auth/send-otp', otpLimiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging in development
if (process.env.NODE_ENV === 'development') {
  app.use((req, res, next) => {
    console.log(`→ ${req.method} ${req.path}`);
    next();
  });
}


app.use('/certificates', express.static(
  require('path').join(process.cwd(), 'certificates')
));

// Swagger UI — http://localhost:3000/api-docs
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customSiteTitle: 'Ozone Wash API Docs',
  customCss: '.swagger-ui .topbar { background-color: #1a1a2e; }',
}));

// All routes live under /api/v1
app.use('/api/v1', routes);

// Error handlers — must be last
app.use(notFound);
app.use(errorHandler);

module.exports = app;