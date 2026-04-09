-- Run this entire file in Supabase SQL Editor once
-- Go to: Supabase → SQL Editor → New Query → Paste → Run

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- USERS
CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       VARCHAR(15) UNIQUE NOT NULL,
  email       VARCHAR(255),
  role        VARCHAR(20) NOT NULL DEFAULT 'customer'
                CHECK (role IN ('customer', 'field_team', 'admin')),
  name        VARCHAR(255),
  lang        VARCHAR(5) DEFAULT 'en' CHECK (lang IN ('en', 'te')),
  fcm_token   TEXT,
  created_at  TIMESTAMP DEFAULT NOW(),
  updated_at  TIMESTAMP DEFAULT NOW()
);

-- OTP CODES
CREATE TABLE IF NOT EXISTS otp_codes (
  phone       VARCHAR(15) PRIMARY KEY,
  code        VARCHAR(6) NOT NULL,
  expires_at  TIMESTAMP NOT NULL,
  used        BOOLEAN DEFAULT false,
  created_at  TIMESTAMP DEFAULT NOW()
);

-- BOOKINGS
CREATE TABLE IF NOT EXISTS bookings (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id         UUID NOT NULL REFERENCES users(id),
  tank_type           VARCHAR(50) NOT NULL,
  tank_size_litres    DECIMAL NOT NULL,
  address             TEXT NOT NULL,
  lat                 DECIMAL,
  lng                 DECIMAL,
  slot_time           TIMESTAMP NOT NULL,
  addons              JSONB DEFAULT '[]',
  amc_plan            VARCHAR(20),
  payment_method      VARCHAR(20) NOT NULL,
  payment_status      VARCHAR(20) DEFAULT 'pending',
  razorpay_order_id   TEXT,
  razorpay_payment_id TEXT,
  amount_paise             INTEGER,
  status                   VARCHAR(20) DEFAULT 'pending',
  job_type                 VARCHAR(50) DEFAULT 'tank_cleaning',
  resource_type            VARCHAR(50) DEFAULT 'tank',
  tanks                    JSONB,
  property_type            VARCHAR(50) DEFAULT 'residential',
  contact_name             VARCHAR(255),
  contact_phone            VARCHAR(15),
  eco_discount_pct         DECIMAL,
  eco_discount_amount      INTEGER DEFAULT 0,
  eco_discount_label       VARCHAR(100),
  created_at               TIMESTAMP DEFAULT NOW(),
  updated_at               TIMESTAMP DEFAULT NOW()
);

-- JOBS
CREATE TABLE IF NOT EXISTS jobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id       UUID REFERENCES bookings(id),
  customer_id      UUID NOT NULL REFERENCES users(id),
  assigned_team_id UUID REFERENCES users(id),
  status           VARCHAR(20) DEFAULT 'scheduled'
                     CHECK (status IN ('scheduled', 'in_progress', 'completed', 'cancelled')),
  job_type         VARCHAR(50) DEFAULT 'tank_cleaning',
  resource_type    VARCHAR(50) DEFAULT 'tank',
  scheduled_at     TIMESTAMP NOT NULL,
  started_at       TIMESTAMP,
  completed_at     TIMESTAMP,
  location_lat     DECIMAL,
  location_lng     DECIMAL,
  notes            TEXT,
  start_otp              VARCHAR(6),
  end_otp                VARCHAR(6),
  end_otp_satisfied      VARCHAR(6),
  end_otp_unsatisfied    VARCHAR(6),
  customer_satisfied     BOOLEAN,
  start_otp_verified     BOOLEAN DEFAULT false,
  end_otp_verified       BOOLEAN DEFAULT false,
  created_at             TIMESTAMP DEFAULT NOW(),
  updated_at             TIMESTAMP DEFAULT NOW()
);

-- COMPLIANCE LOGS
CREATE TABLE IF NOT EXISTS compliance_logs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id              UUID NOT NULL REFERENCES jobs(id),
  step_number         INTEGER NOT NULL CHECK (step_number BETWEEN 1 AND 8),
  step_name           VARCHAR(255),
  photo_before_url    TEXT,
  photo_after_url     TEXT,
  ozone_exposure_mins DECIMAL,
  microbial_test_url  TEXT,
  microbial_result    VARCHAR(10) CHECK (microbial_result IN ('pass', 'fail')),
  microbial_notes     TEXT,
  chemical_type       VARCHAR(100),
  chemical_qty_ml     DECIMAL,
  ppe_list            JSONB DEFAULT '[]',
  gps_lat             DECIMAL,
  gps_lng             DECIMAL,
  completed           BOOLEAN DEFAULT false,
  logged_at           TIMESTAMP DEFAULT NOW(),
  job_type            VARCHAR(50) DEFAULT 'tank_cleaning',
  resource_type       VARCHAR(50) DEFAULT 'tank',
  UNIQUE (job_id, step_number)
);

-- ECO METRICS
CREATE TABLE IF NOT EXISTS eco_metrics_log (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                 UUID NOT NULL REFERENCES jobs(id) UNIQUE,
  residual_water_before  DECIMAL,
  water_used_litres      DECIMAL,
  chemical_type          VARCHAR(100),
  chemical_qty_ml        DECIMAL,
  ppe_list               JSONB DEFAULT '[]',
  eco_score              INTEGER CHECK (eco_score BETWEEN 0 AND 100),
  badge_level            VARCHAR(20) CHECK (badge_level IN ('bronze', 'silver', 'gold', 'platinum')),
  score_breakdown        JSONB,
  job_type               VARCHAR(50) DEFAULT 'tank_cleaning',
  resource_type          VARCHAR(50) DEFAULT 'tank',
  created_at             TIMESTAMP DEFAULT NOW()
);

-- HYGIENE CERTIFICATES
CREATE TABLE IF NOT EXISTS hygiene_certificates (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id             UUID NOT NULL REFERENCES jobs(id) UNIQUE,
  eco_score          INTEGER,
  certificate_url    TEXT,
  qr_code_url        TEXT,
  digital_signature  TEXT,
  valid_until        DATE,
  badge_level        VARCHAR(20) CHECK (badge_level IN ('bronze', 'silver', 'gold', 'platinum')),
  status             VARCHAR(20) DEFAULT 'active'
                       CHECK (status IN ('active', 'revoked', 'expired')),
  revoked_reason     TEXT,
  revoked_by         UUID REFERENCES users(id),
  issued_at          TIMESTAMP DEFAULT NOW()
);

-- AMC CONTRACTS
CREATE TABLE IF NOT EXISTS amc_contracts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      UUID NOT NULL REFERENCES users(id),
  tank_ids         JSONB DEFAULT '[]',
  plan_type        VARCHAR(20) NOT NULL
                     CHECK (plan_type IN ('monthly','bimonthly','quarterly','4month','halfyearly','yearly')),
  sla_terms        JSONB,
  start_date       DATE NOT NULL,
  end_date         DATE NOT NULL,
  renewal_pending  BOOLEAN DEFAULT false,
  status           VARCHAR(20) DEFAULT 'pending_payment'
                     CHECK (status IN ('pending_payment', 'active', 'paused', 'cancelled', 'expired')),
  customer_esign   TEXT,
  admin_esign      TEXT,
  amount_paise     INTEGER,
  razorpay_order_id   TEXT,
  razorpay_payment_id TEXT,
  payment_status      VARCHAR(20) DEFAULT 'pending',
  job_type         VARCHAR(50) DEFAULT 'tank_cleaning',
  resource_type    VARCHAR(50) DEFAULT 'tank',
  created_at       TIMESTAMP DEFAULT NOW(),
  updated_at       TIMESTAMP DEFAULT NOW()
);

-- NOTIFICATIONS LOG
CREATE TABLE IF NOT EXISTS notifications_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users(id),
  type          VARCHAR(20) NOT NULL CHECK (type IN ('whatsapp', 'sms', 'push', 'email')),
  template_name VARCHAR(100),
  status        VARCHAR(20) DEFAULT 'sent' CHECK (status IN ('sent', 'failed')),
  error_message TEXT,
  sent_at       TIMESTAMP DEFAULT NOW()
);

-- INCIDENT REPORTS
CREATE TABLE IF NOT EXISTS incident_reports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID NOT NULL REFERENCES jobs(id),
  reported_by   UUID NOT NULL REFERENCES users(id),
  description   TEXT NOT NULL,
  photo_url     TEXT,
  audio_url     TEXT,
  severity      VARCHAR(20) DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status        VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'escalated')),
  resolved_by   UUID REFERENCES users(id),
  resolved_at   TIMESTAMP,
  created_at    TIMESTAMP DEFAULT NOW()
);

-- INDEXES
CREATE INDEX IF NOT EXISTS idx_jobs_customer    ON jobs(customer_id);
CREATE INDEX IF NOT EXISTS idx_jobs_team        ON jobs(assigned_team_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status      ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_scheduled   ON jobs(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_compliance_job   ON compliance_logs(job_id);
CREATE INDEX IF NOT EXISTS idx_bookings_customer ON bookings(customer_id);
CREATE INDEX IF NOT EXISTS idx_amc_customer     ON amc_contracts(customer_id);