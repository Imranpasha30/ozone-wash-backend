# OZONE WASH — Complete Project Status & Handover Report

**Client:** Ramesh Sappa — VijRam Health Sense Pvt. Ltd., Hyderabad  
**Developer:** Imran Pasha  
**Report Date:** April 7, 2026  
**Project Version:** Phase 1 — v1.0  
**Document Type:** Technical Status + Client Handover

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Architecture](#2-system-architecture)
3. [Database Schema](#3-database-schema)
4. [Backend API — All 58 Endpoints](#4-backend-api)
5. [Mobile App — All 34 Screens](#5-mobile-app)
6. [Third-Party Integrations Status](#6-third-party-integrations)
7. [Deployment & Live URLs](#7-deployment--live-urls)
8. [What Is Complete](#8-what-is-complete)
9. [What Is Pending — Client Action Required](#9-what-is-pending--client-action-required)
10. [Phase 2 — Not Yet Built](#10-phase-2--not-yet-built)
11. [Go-Live Checklist](#11-go-live-checklist)
12. [Environment Variables Reference](#12-environment-variables-reference)

---

## 1. Executive Summary

The Ozone Wash Phase 1 platform is **fully coded and deployed**. This includes:

- **Backend API** — 58 REST endpoints across 10 modules, live on Railway cloud
- **Mobile App** — 34 screens covering Customer, Field Team, and Admin roles
- **Database** — All 9 tables live on Supabase PostgreSQL
- **Android APK** — Built and ready for client testing

The system handles the complete service lifecycle: customer books → admin assigns → field team completes 8-step compliance checklist → EcoScore calculated → hygiene certificate auto-generated and delivered.

**Current Status:** Backend is live. App is testable via APK. Several third-party services (Razorpay live mode, Firebase, Cloudflare R2, WhatsApp) are **blocked pending credentials from VijRam Health Sense.**

---

## 2. System Architecture

```
┌──────────────────────────────────────────────────────┐
│                   REACT NATIVE APP                    │
│         Customer | Field Team | Admin                 │
│         (Single APK — role-based navigation)          │
└─────────────────────┬────────────────────────────────┘
                      │ HTTPS REST API
                      ▼
┌──────────────────────────────────────────────────────┐
│              NODE.JS + EXPRESS BACKEND                │
│         Railway Cloud — Production                    │
│   ozone-wash-backend-production.up.railway.app        │
│                                                       │
│  Auth │ Bookings │ Jobs │ Compliance │ EcoScore       │
│  Certificates │ AMC │ Payments │ Incidents │ Uploads  │
└──────┬──────────────────┬───────────────┬────────────┘
       │                  │               │
       ▼                  ▼               ▼
┌────────────┐   ┌──────────────┐  ┌──────────────┐
│ SUPABASE   │   │ CLOUDFLARE   │  │  RAZORPAY    │
│ PostgreSQL │   │     R2       │  │  Payments    │
│  Database  │   │ File Storage │  │  UPI/Cards   │
└────────────┘   └──────────────┘  └──────────────┘
       │
       ▼
┌────────────┐   ┌──────────────┐  ┌──────────────┐
│  FIREBASE  │   │  AUTHKEY.IO  │  │    WATI      │
│    FCM     │   │  SMS / OTP   │  │  WhatsApp    │
│   Push     │   │   Gateway    │  │  Business    │
└────────────┘   └──────────────┘  └──────────────┘
```

### Technology Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Mobile App | React Native (Expo) | SDK 53 |
| Backend | Node.js + Express | Node 20+ |
| Database | PostgreSQL via Supabase | PG 15 |
| File Storage | Cloudflare R2 (S3-compatible) | — |
| Payments | Razorpay | v1 |
| Push Notifications | Firebase FCM | v9 |
| SMS / OTP | Authkey.io | — |
| WhatsApp | Wati Business API | — |
| Email | Nodemailer (Gmail SMTP) | — |
| State Management | Zustand | — |
| API Client | Axios (with caching) | — |
| PDF Generation | PDFKit + QRCode | — |
| Auth | JWT + OTP (passwordless) | — |
| Hosting | Railway.app | — |
| CI/CD | GitHub (auto-deploy on push) | — |

---

## 3. Database Schema

All tables include `job_type` and `resource_type` columns for Phase 2 (IoT) and Phase 3 (Laundry) extensibility without refactoring.

### 3.1 users
| Column | Type | Description |
|--------|------|-------------|
| id | UUID PK | Auto-generated |
| phone | VARCHAR(15) UNIQUE | Login identifier |
| email | VARCHAR(255) | Optional |
| role | VARCHAR(20) | `customer` / `field_team` / `admin` |
| name | VARCHAR(255) | Full name |
| lang | VARCHAR(5) | `en` / `te` (Telugu) |
| fcm_token | TEXT | Firebase push token |
| created_at | TIMESTAMP | — |
| updated_at | TIMESTAMP | — |

### 3.2 otp_codes
| Column | Type | Description |
|--------|------|-------------|
| phone | VARCHAR(15) PK | Phone number |
| code | VARCHAR(6) | 6-digit OTP |
| expires_at | TIMESTAMP | 10-minute expiry |
| used | BOOLEAN | Marks as consumed |
| created_at | TIMESTAMP | — |

### 3.3 bookings
| Column | Type | Description |
|--------|------|-------------|
| id | UUID PK | — |
| customer_id | UUID FK → users | — |
| tank_type | VARCHAR(50) | overhead / underground / syntax |
| tank_size_litres | DECIMAL | 500 / 1000 / 2000 / 5000 |
| address | TEXT | Full service address |
| lat / lng | DECIMAL | GPS coordinates |
| slot_time | TIMESTAMP | Booked slot |
| addons | JSONB | Array of selected add-ons |
| amc_plan | VARCHAR(20) | If booked with AMC |
| payment_method | VARCHAR(20) | upi / card / cod |
| payment_status | VARCHAR(20) | pending / paid |
| razorpay_order_id | TEXT | Razorpay order reference |
| razorpay_payment_id | TEXT | Razorpay payment reference |
| amount_paise | INTEGER | Total in paise |
| status | VARCHAR(20) | pending / confirmed / cancelled |
| job_type | VARCHAR(50) | `tank_cleaning` (extensible) |
| resource_type | VARCHAR(50) | `tank` (extensible) |

### 3.4 jobs
| Column | Type | Description |
|--------|------|-------------|
| id | UUID PK | — |
| booking_id | UUID FK → bookings | — |
| customer_id | UUID FK → users | — |
| assigned_team_id | UUID FK → users | Field team assigned |
| status | VARCHAR(20) | scheduled / in_progress / completed / cancelled |
| job_type | VARCHAR(50) | `tank_cleaning` |
| resource_type | VARCHAR(50) | `tank` |
| scheduled_at | TIMESTAMP | — |
| started_at | TIMESTAMP | When field team started |
| completed_at | TIMESTAMP | When job closed |
| location_lat / lng | DECIMAL | Job site GPS |
| start_otp | VARCHAR(6) | 6-digit start verification OTP |
| end_otp | VARCHAR(6) | 6-digit end verification OTP |
| start_otp_verified | BOOLEAN | Checklist unlock gate |
| end_otp_verified | BOOLEAN | Job close gate |

### 3.5 compliance_logs
| Column | Type | Description |
|--------|------|-------------|
| id | UUID PK | — |
| job_id | UUID FK → jobs | — |
| step_number | INTEGER (1–8) | Checklist step |
| step_name | VARCHAR | e.g. "Ozone Treatment" |
| photo_before_url | TEXT | Cloudflare R2 URL |
| photo_after_url | TEXT | Cloudflare R2 URL |
| ozone_exposure_mins | DECIMAL | Step 4 only |
| microbial_test_url | TEXT | Step 6 only |
| chemical_type | VARCHAR | Chemical used |
| chemical_qty_ml | DECIMAL | Quantity |
| ppe_list | JSONB | ["mask","gloves","boots","suit"] |
| gps_lat / gps_lng | DECIMAL | Captured on every step |
| completed | BOOLEAN | Step gate |
| logged_at | TIMESTAMP | Server timestamp |

### 3.6 eco_metrics_log
| Column | Type | Description |
|--------|------|-------------|
| id | UUID PK | — |
| job_id | UUID FK → jobs (UNIQUE) | One record per job |
| residual_water_before | DECIMAL | % remaining before clean |
| water_used_litres | DECIMAL | Actual water used |
| chemical_type | VARCHAR | Chemical used |
| chemical_qty_ml | DECIMAL | Quantity |
| ppe_list | JSONB | PPE used |
| eco_score | INTEGER (0–100) | Calculated score |
| badge_level | VARCHAR | bronze / silver / gold / platinum |
| score_breakdown | JSONB | Per-category scores |

### 3.7 hygiene_certificates
| Column | Type | Description |
|--------|------|-------------|
| id | UUID PK | — |
| job_id | UUID FK → jobs (UNIQUE) | One cert per job |
| eco_score | INTEGER | Score at time of issue |
| certificate_url | TEXT | R2 URL of PDF |
| qr_code_url | TEXT | Links to public verify endpoint |
| digital_signature | TEXT | SHA-256 tamper detection |
| valid_until | DATE | 6 months from issue |
| status | VARCHAR | active / revoked / expired |
| revoked_reason | TEXT | Admin notes |
| issued_at | TIMESTAMP | — |

### 3.8 amc_contracts
| Column | Type | Description |
|--------|------|-------------|
| id | UUID PK | — |
| customer_id | UUID FK → users | — |
| plan_type | VARCHAR | monthly / bimonthly / quarterly / 4month / halfyearly / yearly |
| sla_terms | JSONB | {response_hrs, cleaning_freq, incident_resolution_hrs} |
| start_date / end_date | DATE | Contract period |
| renewal_pending | BOOLEAN | True at 30 days before expiry |
| status | VARCHAR | pending_payment / active / paused / cancelled / expired |
| customer_esign | TEXT | Base64 signature |
| admin_esign | TEXT | Base64 signature |
| amount_paise | INTEGER | Contract value |
| razorpay_order_id | TEXT | Payment reference |
| payment_status | VARCHAR | pending / paid |

### 3.9 incident_reports
| Column | Type | Description |
|--------|------|-------------|
| id | UUID PK | — |
| job_id | UUID FK → jobs | — |
| reported_by | UUID FK → users | Field team member |
| description | TEXT | Incident details |
| photo_url | TEXT | Evidence photo |
| severity | VARCHAR | low / medium / high / critical |
| status | VARCHAR | open / resolved / escalated |
| resolved_by | UUID FK → users | Admin who resolved |

### 3.10 notifications_log
| Column | Type | Description |
|--------|------|-------------|
| id | UUID PK | — |
| user_id | UUID FK → users | Recipient |
| type | VARCHAR | whatsapp / sms / push / email |
| template_name | VARCHAR | Template used |
| status | VARCHAR | sent / failed |
| error_message | TEXT | Failure reason if any |
| sent_at | TIMESTAMP | — |

---

## 4. Backend API

**Base URL (Production):** `https://ozone-wash-backend-production.up.railway.app/api/v1`

### 4.1 Authentication

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/auth/send-otp` | Public | Send 6-digit OTP via Authkey.io SMS |
| POST | `/auth/verify-otp` | Public | Verify OTP → issue JWT with role |
| GET | `/auth/profile` | Any | Get current user's profile |
| GET | `/auth/users` | Admin | List all users with role filter |

### 4.2 Bookings

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/bookings/slots?date=` | Public | Available time slots for a date |
| GET | `/bookings/price` | Any | Live price: tank + addons + GST |
| POST | `/bookings` | Customer | Create new booking |
| GET | `/bookings/my` | Customer | Customer's own bookings |
| GET | `/bookings/:id` | Any | Booking details + job + OTPs |
| PATCH | `/bookings/:id/cancel` | Customer | Cancel a booking |
| GET | `/bookings` | Admin | All bookings with filters |
| PATCH | `/bookings/:id/confirm` | Admin | Confirm a booking |

**Pricing Formula:**
```
Total = (Base Price + Add-ons) × (1 - EcoScore Discount%) × 1.18 (18% GST)
```

**Base Prices:** 500L → ₹799 | 1000L → ₹999 | 2000L → ₹1,299 | 5000L → ₹1,999

**Add-ons:** Lime Descaling ₹299 | UV Sterilization ₹499 | Microbial Test ₹199 | Tank Health Check ₹149 | Anti-Algae ₹349

### 4.3 Jobs

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/jobs/my` | Field Team | Today's assigned jobs |
| GET | `/jobs/available` | Field Team | Unassigned jobs to request |
| POST | `/jobs/:id/request` | Field Team | Request an available job |
| PATCH | `/jobs/:id/start` | Field Team | Mark job as started |
| POST | `/jobs/:id/generate-start-otp` | Field Team | Generate start OTP |
| POST | `/jobs/:id/verify-start-otp` | Field Team | Verify OTP from customer → unlock checklist |
| POST | `/jobs/:id/generate-end-otp` | Field Team | Generate end OTP |
| POST | `/jobs/:id/verify-end-otp` | Field Team | Verify end OTP → trigger certificate |
| POST | `/jobs/:id/customer-request-otp` | Customer | Customer requests OTP display |
| POST | `/jobs/:id/transfer` | Field Team | Transfer job to another team |
| PATCH | `/jobs/:id/complete` | Admin / Field | Mark job complete |
| PATCH | `/jobs/:id/assign` | Admin | Assign job to field team |
| GET | `/jobs/requests` | Admin | Pending job requests |
| GET | `/jobs/requests/count` | Admin | Count of pending requests |
| PATCH | `/jobs/requests/:id/approve` | Admin | Approve field team request |
| PATCH | `/jobs/requests/:id/reject` | Admin | Reject field team request |
| GET | `/jobs/stats` | Admin / Field | Today's statistics |
| GET | `/jobs/teams` | Admin | List of all field teams |
| GET | `/jobs` | Admin | All jobs with filters |
| GET | `/jobs/:id` | Any | Single job detail |

### 4.4 Compliance Engine (8-Step Checklist)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/compliance/:jobId/checklist` | Any | All 8 steps with completion status |
| POST | `/compliance/step` | Field Team | Log a compliance step |
| GET | `/compliance/:jobId/status` | Any | Completion % and pending steps |
| POST | `/compliance/:jobId/complete` | Field Team | Mark all done → trigger certificate |

**Step Log Payload:**
```json
{
  "job_id": "uuid",
  "step_number": 1-8,
  "photo_before_url": "R2 URL",
  "photo_after_url": "R2 URL",
  "gps_lat": 17.385,
  "gps_lng": 78.486,
  "ozone_exposure_mins": 30,     // step 4 only
  "microbial_test_url": "R2 URL", // step 6 only
  "chemical_type": "anti-bacterial",
  "chemical_qty_ml": 500,
  "ppe_list": ["mask","gloves","boots","suit"]
}
```

**Compliance Gate:** `POST /compliance/:jobId/complete` returns `400` if any step is incomplete. This gate is enforced at backend level — cannot be bypassed even by direct API calls.

**The 8 Steps:**
1. Initial Inspection & Setup — Auto-completed on Start OTP verify
2. Tank Draining — Auto-completed on Start OTP verify
3. Manual Scrubbing — Auto-completed on Start OTP verify
4. Ozone / UV Treatment — Auto-completed on Start OTP verify
5. Chemical Treatment — Auto-completed on Start OTP verify
6. Microbial Testing — Agent manually logs
7. Refilling & Inspection — Agent manually logs
8. Sign-off & Certificate — Agent manually logs

### 4.5 EcoScore Engine

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/ecoscore/calculate` | Field / Admin | Calculate score for job |
| GET | `/ecoscore/:jobId` | Any | Score for specific job |
| GET | `/ecoscore/leaderboard` | Any | Team leaderboard |
| GET | `/ecoscore/trends` | Admin | Monthly trends |

**EcoScore Algorithm (0–100 points):**
| Category | Max Points | Rule |
|----------|-----------|------|
| Water Usage | 25 | Benchmark = tank_size × 0.3L. Each 10% over = -5pts |
| Chemical Usage | 20 | Minimal effective dose = full 20pts. Overuse = deduction |
| PPE Compliance | 25 | All 4 items (mask, gloves, boots, suit) = 25pts. Each missing = -6pts |
| On-Time Completion | 15 | Within schedule = 15pts. Each 30 min late = -5pts |
| Residual Water Mgmt | 15 | Proper drainage before clean = 15pts |

**Badge Levels:** 0–40 = Bronze | 41–65 = Silver | 66–85 = Gold | 86–100 = Platinum

### 4.6 Hygiene Certificates

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/certificates/generate` | Field / Admin | Auto-triggered certificate generation |
| GET | `/certificates/job/:jobId` | Any | Certificate for a job |
| GET | `/certificates/verify/:certId` | **Public** | QR code verification (no auth required) |
| PATCH | `/certificates/:certId/revoke` | Admin | Revoke with reason |

**Certificate Contents:**
- Certificate ID: `OZW-HYG-YYYY-XXXXXX`
- Customer name, address, tank details
- Service date, field team name
- All 8 compliance steps with timestamps
- EcoScore + Badge (Bronze/Silver/Gold/Platinum)
- QR Code → `/certificates/verify/:certId`
- SHA-256 digital signature
- Valid until (6 months from issue)

### 4.7 AMC (Annual Maintenance Contract)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/amc/plans` | Public | Available plan options |
| POST | `/amc/contracts` | Customer | Create new contract |
| GET | `/amc/contracts/my` | Customer | Customer's contracts |
| GET | `/amc/contracts/:id` | Any | Single contract |
| POST | `/amc/contracts/:id/sign` | Customer | E-signature |
| POST | `/amc/contracts/:id/admin-sign` | Admin | Admin e-signature |
| PATCH | `/amc/contracts/:id/renew` | Any | Renew contract |
| GET | `/amc/contracts` | Admin | All contracts |
| PATCH | `/amc/contracts/:id/cancel` | Admin | Cancel contract |
| GET | `/amc/expiring` | Admin | Expiring within 30 days |
| GET | `/amc/sla-breaches` | Admin | Jobs that breached SLA |

**AMC Plans:** Monthly | Bimonthly | Quarterly | 4-Month | Half-yearly | Yearly

### 4.8 Payments (Razorpay)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/payments/create-order` | Customer | Create Razorpay booking order |
| POST | `/payments/verify` | Customer | Verify HMAC-SHA256 signature |
| POST | `/payments/refund` | Admin | Process refund |
| POST | `/payments/amc/create-order` | Customer | Create AMC payment order |
| POST | `/payments/amc/verify` | Customer | Verify AMC payment |

### 4.9 Incidents

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/incidents` | Field Team | File incident report |
| GET | `/incidents/job/:jobId` | Any | Incidents for a job |
| GET | `/incidents` | Admin | All incidents |
| GET | `/incidents/:id` | Any | Single incident |
| PATCH | `/incidents/:id/resolve` | Admin | Resolve incident |
| PATCH | `/incidents/:id/escalate` | Admin | Escalate incident |

**Severity Levels:** low / medium / high / critical  
**Critical incidents** → immediate admin FCM push alert

### 4.10 File Uploads

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/upload/photo` | Any | Upload single photo → Cloudflare R2 |
| POST | `/upload/photos` | Any | Upload multiple photos |
| POST | `/upload/document` | Any | Upload PDF / document |

### 4.11 Cron Jobs (Automated)

| Schedule | Task |
|----------|------|
| Every 30 minutes | Check for SLA breaches → push alert to admin |
| Daily 9:00 AM | Check AMC contracts expiring in 30, 14, 7 days → WhatsApp + push alerts |
| Daily 9:00 AM | Mark certificates as expired past validity date |

---

## 5. Mobile App

**Single APK / IPA. Role is determined at login — same app for all 3 roles.**

### 5.1 Navigation Structure

```
App opens
│
├── Not logged in → Auth Stack
│   ├── PhoneInputScreen
│   └── OTPVerifyScreen
│
├── role: customer → Customer Stack
│   ├── Bottom Tabs: Book | My Bookings | Certificates | Profile
│   └── Stack: TankDetails → DateTime → Addons → Payment → Confirmed
│             BookingDetail | CertificateView | AMC Screens
│
├── role: field_team → Field Stack
│   ├── Bottom Tabs: My Jobs | Available Jobs | Stats | Profile
│   └── Stack: JobDetail → Checklist → ComplianceStep → OTP Entry
│             IncidentReport | JobTransfer
│
└── role: admin → Admin Stack
    ├── Bottom Tabs: Dashboard | Bookings | Jobs | Profile
    └── Stack: Teams | Customers | Incidents | Revenue | AMC
```

### 5.2 Auth Screens

| Screen | Description |
|--------|-------------|
| PhoneInputScreen | Enter 10-digit mobile number with +91 prefix |
| OTPVerifyScreen | 6-box OTP input, auto-submit on completion |

### 5.3 Customer Screens (15)

| Screen | Description |
|--------|-------------|
| BookingHomeScreen | Dashboard: book CTA, active AMC status, EcoScore badge, last service |
| TankDetailsScreen | Tank type selector, size input, address + GPS capture |
| DateTimeScreen | 6-day date carousel + 8 time slots per day |
| AddonsScreen | Add-on toggles with live price update |
| PaymentScreen | Razorpay SDK + Pay on Site option, price summary + GST |
| BookingConfirmedScreen | Booking ID, ETA, WhatsApp confirmation |
| MyBookingsScreen | List of all bookings with status chips |
| BookingDetailScreen | Full booking info + job progress timeline + OTP buttons |
| CertificatesScreen | List of all certificates |
| CertificateScreen | Full certificate viewer with download button |
| AmcPlansScreen | Plan comparison table with pricing |
| AmcEnrollmentScreen | Contract form + e-signature canvas |
| AmcConfirmedScreen | Contract confirmation |
| NotificationsScreen | Push notification history |
| ProfileScreen | Phone, name, language preference, logout |

### 5.4 Field Team Screens (10)

| Screen | Description |
|--------|-------------|
| JobListScreen | Today's jobs sorted by slot time, status chips |
| AvailableJobsScreen | Browse and request unassigned jobs |
| JobDetailScreen | Customer name, address, tank specs, navigate button, actions |
| ChecklistScreen | 8-step progress bar, step cards, complete button |
| ComplianceStepScreen | Photo capture (before/after), GPS, ozone timer, chemical log, PPE |
| OtpEntryScreen | Numpad for start OTP and end OTP entry |
| IncidentReportScreen | Severity selector, description, photo evidence |
| JobTransferScreen | Reason selector, available agent picker |
| PerformanceScreen | Jobs done, earnings, EcoScore, rating — weekly/monthly/all-time |
| ProfileScreen | Name, phone, availability toggle, logout |

### 5.5 Admin Screens (9)

| Screen | Description |
|--------|-------------|
| AdminDashboardScreen | KPI cards: bookings today, jobs, revenue, SLA breaches |
| AdminBookingsScreen | Full booking list with filters, confirm/cancel actions |
| AdminJobsScreen | Job management, assign teams, status tracking |
| AdminTeamsScreen | Field team list, job requests approval |
| AdminCustomersScreen | Customer directory |
| AdminIncidentsScreen | Open incidents, resolve/escalate controls |
| AdminRevenueScreen | Revenue charts and analytics |
| AdminAmcScreen | AMC contracts management, SLA status |
| ProfileScreen | Admin profile |

### 5.6 Shared Screens (2)

| Screen | Description |
|--------|-------------|
| QrScannerScreen | Camera QR scanner for certificate verification |
| CertVerifyResultScreen | Certificate data, validity, EcoScore display |

### 5.7 App State Management (Zustand)

| Store | State Managed |
|-------|--------------|
| auth.store.ts | user, token, isAuthenticated, isLoading |
| booking.store.ts | Multi-step booking draft (tank → slot → addons → payment) |
| premium.store.ts | AMC membership status → drives Black & Gold UI theme |

### 5.8 API Caching Strategy

| Endpoint | Cache TTL |
|----------|----------|
| `/bookings/slots` | 5 minutes |
| `/bookings/price` | 2 minutes |
| `/amc/plans` | 10 minutes |
| `/ecoscore/leaderboard` | 5 minutes |
| All other GETs | 30 seconds |

In-flight deduplication prevents duplicate simultaneous requests.

---

## 6. Third-Party Integrations Status

| Service | Purpose | Status | Action Needed |
|---------|---------|--------|---------------|
| **Authkey.io** | SMS OTP delivery | ✅ Live | Confirm credit balance |
| **Supabase** | PostgreSQL database | ✅ Live | — |
| **Railway** | Backend hosting | ✅ Live | — |
| **Razorpay** | Payments | ⚠️ Test mode | Client to provide live keys |
| **Firebase FCM** | Push notifications | ❌ Not configured | Client to set up Firebase project |
| **Cloudflare R2** | Photo/PDF storage | ❌ Not configured | Client to set up R2 bucket |
| **Wati (WhatsApp)** | Booking notifications | ❌ Not configured | Client to set up Wati account |
| **Gmail SMTP** | Email notifications | ❌ Not configured | Client to provide Gmail app password |

---

## 7. Deployment & Live URLs

| Resource | URL / Details |
|----------|--------------|
| Backend (Production) | `https://ozone-wash-backend-production.up.railway.app` |
| Health Check | `https://ozone-wash-backend-production.up.railway.app/health` |
| API Base | `https://ozone-wash-backend-production.up.railway.app/api/v1` |
| QR Verify (Public) | `https://ozone-wash-backend-production.up.railway.app/api/v1/certificates/verify/:id` |
| Database | Supabase PostgreSQL (project: agpmowedfkvovfdbzoav) |
| Android APK | Built — available for download/distribution |
| Code Repository | GitHub — ozone-wash-backend + ozone-wash-app |

---

## 8. What Is Complete

### Backend ✅
- All 58 API endpoints across 10 modules
- JWT authentication + role-based access control
- 8-step compliance engine with backend gate (cannot bypass)
- EcoScore algorithm (5 categories, 100 points, 4 badge levels)
- PDF hygiene certificate generation with QR code + SHA-256 signature
- Razorpay payment integration (test + live ready)
- AMC contract lifecycle with e-signature
- Incident reporting and escalation
- Cron jobs: AMC renewal alerts, SLA breach detection, certificate expiry
- Rate limiting, security headers, HTTPS
- Cloudflare R2 file upload service
- Firebase FCM push notification service
- WhatsApp (Wati) notification service
- Email (Nodemailer) notification service
- All 9 database tables with proper indexes

### Mobile App ✅
- 34 screens across 3 user roles
- Complete customer booking flow (5 steps)
- Complete field team job lifecycle (OTP → checklist → certificate)
- Admin panel with KPI dashboard and management screens
- AMC enrollment with e-signature
- Certificate QR scanner and public verification
- Push notification integration
- Razorpay SDK integration
- Photo capture and upload
- GPS coordinate capture
- Multi-step form state management
- API caching and in-flight deduplication
- Role-based navigation with auto-login
- Black & Gold premium UI for AMC members

### Infrastructure ✅
- Backend deployed and live on Railway
- Database live on Supabase with IPv4 pooler (Railway-compatible)
- Android APK built via EAS with production API URL
- Express trust proxy configured for Railway reverse proxy
- All production environment variables set

---

## 9. What Is Pending — Client Action Required

### 🔴 CRITICAL (blocks core features)

#### Razorpay Live Keys
- **Impact:** App is on test mode. Real payments cannot be collected.
- **Action:** Login to [razorpay.com](https://razorpay.com) → Settings → API Keys → Generate Live Keys
- **Share:** `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`

#### Firebase Project
- **Impact:** Push notifications completely disabled. Customers and field team won't receive any alerts.
- **Action:** Go to [console.firebase.google.com](https://console.firebase.google.com) → Create project → Enable Cloud Messaging → Project Settings → Service Accounts → Generate new private key
- **Share:** `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`
- **Also:** Download `google-services.json` for Android build

#### DLT SMS Registration
- **Impact:** OTP SMS may be blocked by telecom carriers in India without DLT registration.
- **Action:** Register with TRAI DLT portal → Register Sender ID `OZNWSH` → Register OTP template
- **Timeline:** Takes 3–5 business days
- **Note:** Current OTP via Authkey.io works but may be flagged as promotional

### 🟡 IMPORTANT (affects notifications and file storage)

#### Cloudflare R2 Storage
- **Impact:** Compliance photos and certificates not permanently stored. PDFs saved to temporary URL.
- **Action:** [cloudflare.com](https://cloudflare.com) → R2 Storage → Create bucket named `ozone-wash-assets` → Create API token with R2 permissions
- **Share:** `R2_ACCOUNT_ID`, `R2_ACCESS_KEY`, `R2_SECRET_KEY`, `R2_PUBLIC_URL`

#### WhatsApp Business API (Wati)
- **Impact:** No WhatsApp notifications for booking confirmations, job updates, certificates, AMC reminders.
- **Action:** Sign up at [wati.io](https://wati.io) → Connect WhatsApp Business number → Complete Meta FB Business Verification (takes 2–5 days)
- **Share:** `WHATSAPP_API_KEY`, `WHATSAPP_API_URL`
- **Note:** WhatsApp templates for OTP, booking confirmation, certificate delivery need to be created and approved in Wati dashboard

#### Email Notifications
- **Impact:** No email receipts or AMC renewal reminders.
- **Action:** Create `ozonewash@gmail.com` → Enable 2-Factor Auth → Google Account → Security → App Passwords → Generate
- **Share:** `EMAIL_USER`, `EMAIL_PASS`

### 🟢 FOR GO-LIVE

#### Domain (ozonewash.in)
- **Impact:** App uses Railway URL. QR codes on certificates point to Railway URL instead of branded domain.
- **Action:** Purchase `ozonewash.in` → Point to Railway → Update Railway env vars: `APP_URL=https://api.ozonewash.in`, `ALLOWED_ORIGINS=https://ozonewash.in`

#### Google Play Developer Account
- **Impact:** App cannot be published to Play Store.
- **Action:** [play.google.com/console](https://play.google.com/console) → Create account under **VijRam Health Sense Pvt. Ltd.** (₹1,750 one-time registration)
- **Important:** Account must be in company name, not individual

#### Apple Developer Account
- **Impact:** iOS app cannot be built or published.
- **Action:** [developer.apple.com](https://developer.apple.com) → Enroll as organization ($99/year)
- **Important:** Requires D-U-N-S number (free from Dun & Bradstreet, takes 5 business days)

---

## 10. Phase 2 — Not Yet Built

These were scoped as Phase 2 in the original plan. None are included in the current build.

| Feature | Description |
|---------|-------------|
| Admin Web Portal | React.js dashboard for KPIs, compliance audit, MIS reports. Currently admin access is via mobile app only. |
| Live GPS Tracking | Real-time agent location on customer's map. Currently shows static map. Agent GPS tracking requires background location service implementation. |
| Offline Mode | Field team app currently requires network. Full offline-first mode with AsyncStorage queue and auto-sync when reconnected. |
| Dynamic EcoScore (ML) | Current EcoScore uses fixed algorithm. Phase 2 adds ML-based model trained on historical job data. |
| In-App Chat | Customer ↔ Agent real-time chat during service. |
| Review & Rating System | Customer rates agent after job completion. Rating affects EcoScore. |
| Automated Refunds | Admin currently processes refunds manually via Razorpay dashboard. Phase 2 automates from admin panel. |
| Multi-City Expansion | Current system configured for Hyderabad only. |
| Agent Onboarding Portal | Admin currently creates agent accounts manually. Phase 2 adds self-service onboarding. |
| IoT Integration | Tank sensor integration for predictive cleaning scheduling (Phase 2 per original plan). |
| Laundry Module | Separate service type (Phase 3 per original plan). |

---

## 11. Go-Live Checklist

```
BEFORE LAUNCH — complete all items:

CLIENT PROVIDES:
[ ] Razorpay live keys → Developer sets in Railway
[ ] Firebase project credentials → Developer sets in Railway + rebuilds APK
[ ] Cloudflare R2 account + bucket → Developer sets in Railway
[ ] WhatsApp Wati account + approved templates → Developer sets in Railway
[ ] DLT SMS registration completed (Sender ID + OTP template)
[ ] Gmail app password → Developer sets in Railway
[ ] Domain (ozonewash.in) purchased + DNS configured
[ ] Google Play developer account created (under VijRam Health Sense)
[ ] Apple developer account created (under VijRam Health Sense)
[ ] Logo + brand assets in high resolution (for APK icons and certificates)

DEVELOPER DOES:
[ ] Set all client credentials in Railway environment variables
[ ] Rebuild APK with Firebase google-services.json baked in
[ ] Test end-to-end flow with real payment (₹1 test transaction)
[ ] Verify OTP SMS delivery to multiple carriers (Airtel, Jio, Vi)
[ ] Verify WhatsApp templates working for all notification events
[ ] Verify Cloudflare R2 photo upload and retrieval
[ ] Verify certificate PDF generation with real job data
[ ] Submit APK to Google Play (requires client's Play Console access)
[ ] Configure custom domain on Railway
[ ] Final APK QA on minimum 2 Android devices
```

---

## 12. Environment Variables Reference

All variables below must be set in **Railway → your service → Variables**.

```bash
# ── Database ──────────────────────────────────────────────
DATABASE_URL=postgresql://postgres.agpmowedfkvovfdbzoav:[PASSWORD]@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres
SUPABASE_URL=https://agpmowedfkvovfdbzoav.supabase.co
SUPABASE_ANON_KEY=[anon key]
SUPABASE_SERVICE_KEY=[service role key]

# ── App ───────────────────────────────────────────────────
NODE_ENV=production
PORT=8080
APP_URL=https://api.ozonewash.in          # after domain setup
ALLOWED_ORIGINS=https://ozonewash.in      # after domain setup
JWT_SECRET=[strong random string]
JWT_EXPIRES_IN=7d

# ── Payments (Razorpay) — needs client ───────────────────
RAZORPAY_KEY_ID=rzp_live_...              # ⚠️ LIVE keys needed
RAZORPAY_KEY_SECRET=...                   # ⚠️ LIVE keys needed

# ── File Storage (Cloudflare R2) — needs client ──────────
R2_ACCOUNT_ID=...                         # ⚠️ needs client setup
R2_ACCESS_KEY=...
R2_SECRET_KEY=...
R2_BUCKET=ozone-wash-assets
R2_PUBLIC_URL=https://pub-xxxx.r2.dev

# ── Firebase Push — needs client ─────────────────────────
FIREBASE_PROJECT_ID=...                   # ⚠️ needs client setup
FIREBASE_CLIENT_EMAIL=...
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"

# ── WhatsApp (Wati) — needs client ───────────────────────
WHATSAPP_API_KEY=...                      # ⚠️ needs client setup
WHATSAPP_API_URL=https://live-mt-server.wati.io/api/v1

# ── SMS (Authkey.io) — already set ───────────────────────
SMS_PROVIDER=authkey
SMS_API_KEY=[current key]                 # ✅ already configured
AUTHKEY_SID=[current SID]
AUTHKEY_COMPANY=Ozone Wash

# ── Email — needs client ──────────────────────────────────
EMAIL_USER=ozonewash@gmail.com            # ⚠️ needs client setup
EMAIL_PASS=[gmail app password]
```

---

## Summary

| Category | Status |
|----------|--------|
| Backend code | ✅ 100% complete |
| Mobile app code | ✅ 100% complete |
| Database schema | ✅ Live and running |
| Backend deployment | ✅ Live on Railway |
| Android APK | ✅ Built and testable |
| OTP login (SMS) | ✅ Working end-to-end |
| Booking flow | ✅ Working (test payments) |
| Compliance + checklist | ✅ Working (photos need R2) |
| EcoScore + certificates | ✅ Working |
| AMC contracts | ✅ Working (test payments) |
| Razorpay live payments | ⚠️ Needs live keys from client |
| Push notifications | ❌ Needs Firebase from client |
| WhatsApp notifications | ❌ Needs Wati account from client |
| Photo permanent storage | ❌ Needs Cloudflare R2 from client |
| Play Store submission | ❌ Needs Google Play account from client |
| iOS build | ❌ Needs Apple Developer account from client |

---

*All code is committed to GitHub. All credentials are stored securely in Railway environment variables — never in code. For questions contact the developer.*

---
**Prepared by:** Imran Pasha  
**Project:** Ozone Wash — VijRam Health Sense Pvt. Ltd.  
**Date:** April 7, 2026
