# Ozone Wash — Project Status Report
**Prepared for:** Ramesh Sappa, VijRam Health Sense Pvt. Ltd.  
**Prepared by:** Imran Pasha (Developer)  
**Date:** April 7, 2026  
**Version:** 1.0

---

## Executive Summary

The Ozone Wash platform — backend API, customer app, field team app, and admin panel — is **fully coded and deployed**. The backend is live on Railway cloud hosting. A working Android APK has been built and is ready for testing. Several features are **blocked pending credentials and accounts** that need to be provided by VijRam Health Sense. This document details exactly what is done, what is pending, and what requires client action before go-live.

---

## 1. Architecture Overview

| Layer | Technology | Status | Hosted At |
|-------|-----------|--------|-----------|
| Customer + Field + Admin App | React Native (Expo) | ✅ Complete | APK built |
| Backend API | Node.js + Express | ✅ Complete | Railway (live) |
| Database | PostgreSQL via Supabase | ✅ Connected | Supabase (live) |
| File Storage | Cloudflare R2 | ⚠️ Needs real credentials | - |
| Payments | Razorpay | ⚠️ Test mode only | - |
| Push Notifications | Firebase FCM | ⚠️ Needs real credentials | - |
| SMS / OTP | Authkey.io | ✅ Working | Live |
| WhatsApp Notifications | Wati API | ⚠️ Needs account | - |
| Email | Gmail SMTP | ⚠️ Needs credentials | - |

**Backend Live URL:** `https://ozone-wash-backend-production.up.railway.app`  
**Health Check:** `https://ozone-wash-backend-production.up.railway.app/health` → `{"status":"ok","env":"production"}`

---

## 2. What Has Been Completed

### 2.1 Backend API — 58 Endpoints Across 10 Modules

#### Authentication Module
- ✅ `POST /api/v1/auth/send-otp` — Phone OTP login (Authkey.io SMS)
- ✅ `POST /api/v1/auth/verify-otp` — OTP verification + JWT token issuance
- ✅ `GET /api/v1/auth/profile` — User profile fetch
- ✅ `GET /api/v1/auth/users` — Admin: list all users
- ✅ JWT middleware + Role-Based Access Control (customer / field_team / admin)

#### Booking Module
- ✅ `GET /api/v1/bookings/slots` — Available time slots with conflict detection
- ✅ `GET /api/v1/bookings/price` — Live price calculation with addons + GST
- ✅ `POST /api/v1/bookings` — Create booking
- ✅ `GET /api/v1/bookings/my` — Customer's bookings
- ✅ `GET /api/v1/bookings/:id` — Booking details
- ✅ `PATCH /api/v1/bookings/:id/cancel` — Cancel booking
- ✅ `PATCH /api/v1/bookings/:id/confirm` — Admin confirm booking

#### Jobs Module
- ✅ `GET /api/v1/jobs/my` — Field team's assigned jobs
- ✅ `GET /api/v1/jobs/available` — Unassigned jobs for field team to browse
- ✅ `PATCH /api/v1/jobs/:id/assign` — Admin assigns job to team
- ✅ `PATCH /api/v1/jobs/:id/start` — Field team starts job
- ✅ `POST /api/v1/jobs/:id/generate-start-otp` — Generate job start OTP
- ✅ `POST /api/v1/jobs/:id/verify-start-otp` — Field team verifies OTP from customer
- ✅ `POST /api/v1/jobs/:id/generate-end-otp` — Generate job end OTP
- ✅ `POST /api/v1/jobs/:id/verify-end-otp` — Verify end OTP → triggers certificate
- ✅ `POST /api/v1/jobs/:id/transfer` — Transfer job to another team
- ✅ `POST /api/v1/jobs/:id/request` — Field team requests unassigned job
- ✅ `PATCH /api/v1/jobs/requests/:id/approve` — Admin approves job request
- ✅ `GET /api/v1/jobs/stats` — Today's job statistics

#### Compliance Engine (8-Step Checklist)
- ✅ `GET /api/v1/compliance/:jobId/checklist` — Full checklist with step status
- ✅ `POST /api/v1/compliance/step` — Log individual step (photo, GPS, timestamp)
- ✅ `GET /api/v1/compliance/:jobId/status` — Completion % and pending steps
- ✅ `POST /api/v1/compliance/:jobId/complete` — Complete all steps (triggers certificate)
- ✅ Backend gate: certificate blocked until all 8 steps pass — cannot be bypassed

#### EcoScore Engine
- ✅ `POST /api/v1/ecoscore/calculate` — Auto-calculates score on compliance completion
- ✅ `GET /api/v1/ecoscore/:jobId` — Score for specific job
- ✅ `GET /api/v1/ecoscore/leaderboard` — Team leaderboard
- ✅ `GET /api/v1/ecoscore/trends` — Monthly trends for admin
- ✅ Algorithm: Water usage (25pts) + Chemical usage (20pts) + PPE compliance (25pts) + On-time (15pts) + Residual water (15pts)
- ✅ Badges: Bronze / Silver / Gold / Platinum

#### Hygiene Certificate Module
- ✅ `POST /api/v1/certificates/generate` — Auto-triggered PDF generation
- ✅ `GET /api/v1/certificates/job/:jobId` — Certificate for a job
- ✅ `GET /api/v1/certificates/verify/:certId` — Public QR verification (no auth)
- ✅ `PATCH /api/v1/certificates/:certId/revoke` — Admin revoke certificate
- ✅ PDF includes: EcoScore badge, QR code, SHA-256 digital signature, 6-month validity

#### AMC (Annual Maintenance Contract)
- ✅ `GET /api/v1/amc/plans` — Available plans (monthly/quarterly/halfyearly/yearly)
- ✅ `POST /api/v1/amc/contracts` — Create AMC contract with e-signature
- ✅ `GET /api/v1/amc/contracts/my` — Customer's active contracts
- ✅ `POST /api/v1/amc/contracts/:id/sign` — Customer e-signature
- ✅ `POST /api/v1/amc/contracts/:id/admin-sign` — Admin e-signature
- ✅ `PATCH /api/v1/amc/contracts/:id/renew` — Contract renewal
- ✅ `GET /api/v1/amc/expiring` — Contracts expiring within 30 days
- ✅ `GET /api/v1/amc/sla-breaches` — Jobs that breached SLA

#### Payments (Razorpay)
- ✅ `POST /api/v1/payments/create-order` — Create Razorpay order
- ✅ `POST /api/v1/payments/verify` — HMAC-SHA256 signature verification
- ✅ `POST /api/v1/payments/refund` — Admin-triggered refund
- ✅ `POST /api/v1/payments/amc/create-order` — AMC payment order
- ✅ `POST /api/v1/payments/amc/verify` — AMC payment verification
- ⚠️ Currently on **test mode** — needs live Razorpay keys from client

#### Incident Reporting
- ✅ `POST /api/v1/incidents` — Field team files incident
- ✅ `GET /api/v1/incidents` — Admin views all incidents
- ✅ `PATCH /api/v1/incidents/:id/resolve` — Admin resolves incident
- ✅ `PATCH /api/v1/incidents/:id/escalate` — Admin escalates incident

#### File Upload (Cloudflare R2)
- ✅ `POST /api/v1/upload/photo` — Single photo upload
- ✅ `POST /api/v1/upload/photos` — Multiple photos
- ✅ `POST /api/v1/upload/document` — PDF/document upload
- ⚠️ Needs real Cloudflare R2 credentials from client

#### Cron Jobs (Automated Background Tasks)
- ✅ **Every 30 minutes** — SLA breach detection, admin FCM alert
- ✅ **Daily 9 AM** — AMC renewal checks (30, 14, 7 days before expiry)
- ✅ **Daily 9 AM** — Auto-expire certificates past validity date

---

### 2.2 Mobile App — 34 Screens, 3 User Roles

#### Auth Screens (2)
- ✅ Phone number entry screen
- ✅ OTP verification screen (6-digit input, auto-submit)

#### Customer Screens (15)
- ✅ Home / Booking CTA with EcoScore badge + AMC status
- ✅ Tank type & size selector with address + GPS
- ✅ Date & time slot picker (calendar + 8 slots per day)
- ✅ Add-ons screen with live price updates (Lime Descaling, UV Sterilization, Microbial Test, Tank Health Check, Anti-Algae)
- ✅ Payment screen — Razorpay UPI/Card + Pay on Site option
- ✅ Booking confirmed screen with booking ID
- ✅ My Bookings list with status tracking
- ✅ Booking detail screen with job progress
- ✅ Certificates list screen
- ✅ Individual certificate viewer
- ✅ AMC plans screen
- ✅ AMC enrollment + e-signature
- ✅ AMC confirmed screen
- ✅ Notifications screen
- ✅ Customer profile screen

#### Field Team Screens (10)
- ✅ My Jobs list (today's assignments, status chips)
- ✅ Available Jobs browser (request unassigned jobs)
- ✅ Job detail screen (customer info, map, navigate button)
- ✅ 8-step compliance checklist screen with progress bar
- ✅ Compliance step logger (photo before/after, GPS capture, ozone timer)
- ✅ OTP entry screen (start OTP + end OTP)
- ✅ Incident report screen (severity, photos, description)
- ✅ Job transfer screen (reason + pick new agent)
- ✅ Performance stats screen (jobs, earnings, EcoScore, rating)
- ✅ Field team profile screen

#### Admin Screens (9)
- ✅ Admin dashboard (KPI cards: bookings, jobs, revenue, incidents)
- ✅ Bookings management (confirm, cancel, view details)
- ✅ Jobs management (assign teams, view status)
- ✅ Field teams management (view team list, approve job requests)
- ✅ Customers list
- ✅ Incidents management (resolve, escalate)
- ✅ Revenue analytics
- ✅ AMC contract management
- ✅ Admin profile screen

#### Shared Screens (2)
- ✅ QR code scanner (scan hygiene certificates)
- ✅ Certificate verification result screen

---

### 2.3 Infrastructure & Deployment
- ✅ Backend deployed on Railway cloud — live at `ozone-wash-backend-production.up.railway.app`
- ✅ Database on Supabase (PostgreSQL) — IPv4 pooler connection configured
- ✅ Full DB schema with all tables: users, bookings, jobs, compliance_logs, eco_metrics_log, hygiene_certificates, amc_contracts, otp_codes
- ✅ Android APK built and ready for testing
- ✅ Express trust proxy configured (correct IP detection behind Railway)
- ✅ Rate limiting: 60 requests/15 min; OTP 3 requests/5 min
- ✅ HTTPS + security headers (Helmet)
- ✅ Gzip/Brotli compression

---

## 3. Pending — Blocked on Client Action

These features are **coded but not live** because they require credentials or accounts from VijRam Health Sense.

### 3.1 CRITICAL — Must resolve before public launch

| Item | Status | What Client Must Do |
|------|--------|---------------------|
| **Razorpay Live Keys** | Test mode only | Login to Razorpay → Settings → API Keys → Generate Live Keys → Share `KEY_ID` and `KEY_SECRET` |
| **DLT SMS Registration** | ⚠️ OTP works via Authkey.io but may be flagged on some carriers | Complete DLT registration with TRAI for Sender ID `OZNWSH` and OTP template. Takes 3–5 business days. |
| **Firebase Credentials** | Push notifications disabled | Create Firebase project → Enable FCM → Download `google-services.json` → Share `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` |

### 3.2 IMPORTANT — For full functionality

| Item | Status | What Client Must Do |
|------|--------|---------------------|
| **Cloudflare R2 Storage** | Photo uploads not saving | Create Cloudflare account → Create R2 bucket named `ozone-wash-assets` → Share `R2_ACCOUNT_ID`, `R2_ACCESS_KEY`, `R2_SECRET_KEY`, `R2_PUBLIC_URL` |
| **WhatsApp Business API** | Booking notifications disabled | Create Wati (or equivalent) account → Get WhatsApp API Key → Complete Meta FB Business Verification → Share `WHATSAPP_API_KEY` and `WHATSAPP_API_URL` |
| **Email (Gmail)** | Email notifications disabled | Create Gmail account for business (`ozonewash@gmail.com`) → Enable 2FA → Generate App Password → Share `EMAIL_USER` and `EMAIL_PASS` |

### 3.3 FOR GO-LIVE

| Item | Status | What Client Must Do |
|------|--------|---------------------|
| **Domain** | Not configured | Purchase `ozonewash.in` → Point to Railway backend URL → Update `APP_URL` and `ALLOWED_ORIGINS` in Railway env vars |
| **Google Play Account** | App not published | Create Google Play Developer account under **VijRam Health Sense Pvt. Ltd.** (₹1,750 one-time) → Share access |
| **Apple App Store** | App not published | Create Apple Developer account ($99/year) → Share access |

---

## 4. Functionality Not Built (Phase 2)

These items were marked as **Phase 2** in the original plan and are **not included** in the current build:

| Feature | Notes |
|---------|-------|
| Admin Web Portal | React.js web dashboard not built — admin access is via the mobile app admin panel |
| Live GPS Tracking | Map on tracking screen shows static location; real-time agent GPS tracking is Phase 2 |
| Dynamic EcoScore ML | Current EcoScore uses fixed algorithm; ML-based dynamic scoring is Phase 2 |
| In-app Chat | Customer ↔ Agent real-time chat is Phase 2 |
| Review & Rating System | Agent ratings not collected yet |
| Multi-city Expansion | Current system is single-city (Hyderabad) |
| Offline Sync | Field team compliance data requires network; full offline-first mode is Phase 2 |
| Automated Refund Processing | Admin can initiate refunds manually via Razorpay dashboard; auto-refunds are Phase 2 |
| Agent Onboarding Portal | Admin manually creates agent accounts |
| AMC Management UI (Full) | Basic AMC enrollment and viewing is done; full contract lifecycle management UI is Phase 2 |

---

## 5. Known Limitations in Current Build

| Item | Impact | Fix |
|------|--------|-----|
| No Expo push notifications in production APK | FCM push won't work until Firebase credentials are set | Set `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` in Railway |
| Photos upload to fallback URL (not R2) | Compliance photos not permanently stored | Set real Cloudflare R2 credentials |
| Razorpay test mode | Real payments cannot be collected | Provide live Razorpay keys |
| WhatsApp messages disabled | Booking/job notifications via WhatsApp not sent | Set up Wati account |
| SMS OTP on Authkey.io test plan | OTP delivery may be limited | Confirm Authkey.io plan has sufficient credits; complete DLT |

---

## 6. Environment Variables Required from Client

Add these to Railway → your service → Variables:

```
# Razorpay (Live)
RAZORPAY_KEY_ID=rzp_live_...
RAZORPAY_KEY_SECRET=...

# Cloudflare R2
R2_ACCOUNT_ID=...
R2_ACCESS_KEY=...
R2_SECRET_KEY=...
R2_BUCKET=ozone-wash-assets
R2_PUBLIC_URL=https://pub-xxxx.r2.dev

# Firebase
FIREBASE_PROJECT_ID=...
FIREBASE_CLIENT_EMAIL=firebase-adminsdk@your-project.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"

# WhatsApp (Wati)
WHATSAPP_API_KEY=...
WHATSAPP_API_URL=https://live-mt-server.wati.io/api/v1

# Email
EMAIL_USER=ozonewash@gmail.com
EMAIL_PASS=your-app-password

# Domain (after purchase)
APP_URL=https://api.ozonewash.in
ALLOWED_ORIGINS=https://ozonewash.in,https://app.ozonewash.in
```

---

## 7. Testing the Current Build

### Backend (Live)
```
Health check:    GET  https://ozone-wash-backend-production.up.railway.app/health
Send OTP:        POST https://ozone-wash-backend-production.up.railway.app/api/v1/auth/send-otp
                 Body: {"phone": "9999999999"}
```

### Mobile App
- **Android APK** is ready — install on Android phone, allow unknown sources
- Login with any phone number → receive OTP via SMS → login
- OTP arrives via Authkey.io (live)
- Booking flow, compliance checklist, EcoScore, certificates — all functional
- Payments are in **test mode** (use Razorpay test cards)
- Photo uploads will use placeholder URLs until R2 is configured
- Push notifications require Firebase setup

---

## 8. What Needs to Happen Before Public Launch

**Checklist for Go-Live:**

- [ ] Client provides Razorpay live keys → set in Railway
- [ ] Client sets up Cloudflare R2 → credentials set in Railway
- [ ] Client sets up Firebase project → credentials set in Railway → rebuild APK
- [ ] Client sets up Wati WhatsApp API → credentials set in Railway
- [ ] Client completes DLT registration for OTP SMS
- [ ] Client purchases domain (ozonewash.in) → Railway custom domain configured
- [ ] Client creates Google Play Developer account → APK submitted
- [ ] Final APK rebuild with all credentials → submit to Play Store
- [ ] Client creates Apple Developer account → iOS build (separate task)

---

## 9. Summary Table

| Module | Backend | App | Live? | Notes |
|--------|---------|-----|-------|-------|
| OTP Login | ✅ | ✅ | ✅ | Working end-to-end |
| Booking Engine | ✅ | ✅ | ✅ | Working (test payments) |
| Job Management | ✅ | ✅ | ✅ | Working |
| 8-Step Compliance | ✅ | ✅ | ✅ | Photos need R2 |
| EcoScore | ✅ | ✅ | ✅ | Working |
| Hygiene Certificate | ✅ | ✅ | ✅ | PDF generation working |
| AMC Contracts | ✅ | ✅ | ✅ | Payments in test mode |
| Razorpay Payments | ✅ | ✅ | ⚠️ | Test mode — needs live keys |
| Firebase Push | ✅ | ✅ | ❌ | Needs Firebase credentials |
| WhatsApp Notifications | ✅ | N/A | ❌ | Needs Wati account |
| Photo/File Uploads | ✅ | ✅ | ❌ | Needs Cloudflare R2 |
| Incident Reporting | ✅ | ✅ | ✅ | Working |
| Admin Panel | ✅ | ✅ | ✅ | In-app (not web portal) |
| Certificate QR Verify | ✅ | ✅ | ✅ | Public endpoint live |
| AMC Cron/Alerts | ✅ | N/A | ⚠️ | Cron runs but notifications need Firebase/WhatsApp |

---

*For any questions contact the developer. All credentials shared must be kept confidential and added only to Railway environment variables — never committed to code.*
