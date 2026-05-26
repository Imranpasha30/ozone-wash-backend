# Ozone Wash™ — Complete Technical Brief

> Hand this entire document to Claude (or any AI assistant) to give it full
> project context. No external reading required — everything an engineer or
> AI needs to reason about the product is in this file.

---

## 1. WHAT IS THIS?

**Ozone Wash™** is an app-enabled water tank hygiene service operating in
Hyderabad, India. Field technicians clean residential / commercial water
tanks using a patent-applied **9-step Ozone + UV disinfection process**,
and the platform issues a **QR-signed digital hygiene certificate** as
tamper-evident proof. Customers book through the mobile app or website;
field crews execute through the same app under a different role; admins
manage operations through an admin role.

The product is operated by **VijRam Health Sense Pvt. Ltd.**, a DPIIT-
recognized Start-Up India company.

### Three user roles in one app

| Role | What they do |
|------|---|
| **customer** | Books cleaning, tracks crew, views certificates, AMC plans, EcoScore wallet |
| **field_team** | Accepts jobs, runs 9-step compliance flow with photo uploads, completes service |
| **admin** | Dashboard, manage bookings/customers/crews, view payouts, EcoScore, MIS |

---

## 2. TECH STACK

### Mobile app — `e:\ozone-wash-app`
- **React Native 0.81.5** via **Expo SDK 54** (managed workflow + prebuilt Android)
- **TypeScript 5.9**
- **React 19.1**, **react-native-web 0.21** (same codebase ships web at `ozonewash.in`)
- Navigation: `@react-navigation/native@7` (stack + bottom tabs)
- Auth state: `zustand@5`
- API: `axios@1.13`
- Storage: `@react-native-async-storage/async-storage@2.2`
- Maps: `react-native-maps@1.20.1` (Google Maps Android) with a web mock
- Camera/Image: `expo-camera`, `expo-image-picker`
- Notifications: `expo-notifications` + Firebase Cloud Messaging
- Crash reporting: `@sentry/react-native@7.2`
- Animations: `react-native-reanimated@4`, `react-native-gesture-handler`
- Icons: `phosphor-react-native@3` (re-exported from `src/components/Icons.tsx`)
- Gradients: `expo-linear-gradient`
- SVG: `react-native-svg`
- Live streaming: **removed in v1** (was `react-native-agora` — Coming Soon placeholder remains)

### Backend — `e:\ozone-wash-backend\ozone-wash-backend`
- **Node.js 20+**, **Express 4**
- Database: **PostgreSQL** (hosted on **Supabase**)
- Storage: **Cloudflare R2** (S3-compatible) for photos / certificates / livestream snapshots
- Payments: **Razorpay** (test mode in dev, live keys in prod)
- WhatsApp + SMS: **Wati BSP** for OTP and stage-completion templates
- Push: **Firebase Admin SDK** (FCM)
- Auth: **JWT** signed with HS256, 7-day expiry, phone-OTP based
- Validation: `express-validator`
- Rate limiting: `express-rate-limit` (60 req/15min general, 3/5min for OTP)
- Cron: `node-cron` (nightly EcoScore + incentive jobs, IST schedules)
- Logging: structured console (no Winston / Pino — keeping it simple)

### Hosting (planned)
- Backend: **Railway** or **Render** (auto-deploy on git push to `main`)
- Web frontend: **Vercel** or **Cloudflare Pages** (built from same Expo repo via `npm run web:build`)
- DB: Supabase (already live)
- R2: Cloudflare (already live)

---

## 3. ARCHITECTURE

```
                         ┌──────────────────────────┐
                         │  ozonewash.in (web)      │
                         │  React Native Web build  │
                         │  Cloudflare Pages        │
                         └──────────────────────────┘
                                    │
                                    │ same JS bundle
                                    ▼
   ┌──────────────────┐    ┌──────────────────────────┐     ┌────────────────────┐
   │ Customer mobile  │───▶│  Ozone Wash Backend API  │───▶│  Supabase Postgres │
   │  (Expo Android)  │    │  Node.js + Express       │     │  (primary DB)      │
   └──────────────────┘    │  Railway / Render        │     └────────────────────┘
                           │  api.ozonewash.in        │
   ┌──────────────────┐    │                          │     ┌────────────────────┐
   │ Field crew app   │───▶│  /api/v1/auth            │───▶│ Cloudflare R2      │
   │  (Expo Android)  │    │  /bookings  /jobs        │     │ (photos, certs)    │
   └──────────────────┘    │  /compliance /ecoscore   │     └────────────────────┘
                           │  /certificates /amc      │
   ┌──────────────────┐    │  /incidents  /livestream │     ┌────────────────────┐
   │ Admin web/mobile │───▶│  /mis  /admin  /ratings  │───▶│ Wati BSP (WhatsApp │
   │  (Expo Android)  │    │  /payments /incentives   │     │  templates + SMS)  │
   └──────────────────┘    │  /rewards /uploads       │     └────────────────────┘
                           └──────────────────────────┘
                                    │
                                    ▼
                           ┌──────────────────────────┐
                           │  Razorpay (payments)     │
                           │  Firebase FCM (push)     │
                           │  Sentry (error tracking) │
                           └──────────────────────────┘
```

Single Expo codebase. Customer, Field, Admin are **role-routed** at runtime
via `RootNavigator.tsx` after JWT decode (`role` claim in token). Each role
gets its own navigator (`CustomerNavigator` / `FieldNavigator` / `AdminNavigator`).

---

## 4. DATABASE SCHEMA (Supabase Postgres)

**Migrations** under `migrations/`:
- `001_initial_schema.sql` — base tables
- `002_concern_tracking.sql` — customer concerns
- `003_job_requests.sql` — multi-tank job request system
- `004_referrals.sql` — referral codes
- `005_mis_supporting_tables.sql` — MIS report tables
- `006_pricing_matrix.sql` — pricing tiers + matrix
- `007_ecoscore_engine.sql` — EcoScore rating system
- `008_incentive_engine.sql` — field-team incentives
- `009_compliance_pdf_alignment.sql` — 9-step compliance schema (was 8)
- `010_ecopoints_redemption.sql` — EcoPoints wallet + redemptions
- `011_incentive_credit_engine.sql` — Phase B credit snapshot

### Core tables

```
users
├─ id (UUID, PK)
├─ phone (VARCHAR(15), UNIQUE) — Indian 10-digit
├─ email, name, lang ('en'|'te')
├─ role ('customer' | 'field_team' | 'admin')
├─ fcm_token (push notif target)
└─ created_at, updated_at

otp_codes (single row per phone — old OTP gets overwritten on resend)
├─ phone (PK)
├─ code (6-digit)
├─ expires_at, used, created_at

bookings (a customer's request)
├─ id, customer_id (FK→users)
├─ tank_type ('overhead'|'underground'|'plastic'|'multi'), tank_size_litres
├─ address, lat, lng, slot_time
├─ addons (JSONB), amc_plan ('monthly'|'quarterly'|'half_yearly'|'yearly'|NULL)
├─ payment_method, payment_status, razorpay_*, amount_paise
├─ status, job_type, resource_type, tanks (JSONB for multi-tank)
├─ property_type, contact_name, contact_phone
└─ eco_discount_pct, eco_discount_amount, eco_discount_label

jobs (execution of a booking by a crew)
├─ id, booking_id (FK→bookings), customer_id, assigned_team_id
├─ status ('scheduled'|'in_progress'|'completed'|'cancelled')
├─ scheduled_at, started_at, completed_at
├─ location_lat/lng, notes
├─ start_otp, end_otp (6-digit, generated on start)
├─ end_otp_satisfied, end_otp_unsatisfied, customer_satisfied
└─ ...

compliance_logs (one row per step per job)
├─ id, job_id (FK→jobs), step_number (0..8)
├─ step_name, completed (bool), completed_at
├─ photo_url (R2), ppe_list (JSONB)
├─ Stage 0: ladder_check, electrical_check, emergency_kit, spare_tank_water,
│            fence_placed, danger_board, arrival_at
├─ Steps 1+8 (water tests): turbidity, ph_level, orp, conductivity, tds, atp
├─ Step 2: water_level_pct, tank_condition
├─ Step 3: scrub_completed
├─ Step 4: rinse_duration
├─ Step 5: disposal_status
├─ Step 6: ozone_cycle_duration, ozone_ppm_dosed, ozone_exposure_mins
├─ Step 7: uv_cycle_duration, uv_dose, uv_lumines_status, uv_skipped
└─ Step 8: client_signature_url, technician_remarks

certificates (issued on job completion)
├─ id, job_id, booking_id, customer_id
├─ qr_token (unique, used in public verify URL)
├─ pdf_url (R2)
├─ ozone_ppm, atp_reading, ecoscore, before_photo_url, after_photo_url
└─ issued_at, expires_at

ecoscore_snapshots (nightly cron writes one per customer per day)
├─ customer_id, score (0-100), badge ('Platinum'|'Gold'|'Silver'|'Bronze'|'Unrated')
├─ rationale (JSONB array of strings)
└─ tips (JSONB), created_at

ecopoints_wallet
├─ customer_id, points_balance (capped at 1,000)
├─ valid_until (24 months from earned)
└─ history (JSONB transactions)

amc_subscriptions
├─ id, customer_id, plan, frequency_months
├─ tanks_covered, start_date, next_service_date, end_date
├─ discount_pct, status ('active'|'paused'|'expired')

incentive_credits (Phase B field-team incentive)
├─ id, agent_id (FK→users), booking_id, job_id
├─ credit_amount_paise, reason ('job_completed'|'streak'|'rating'|...)
├─ snapshot_at (immutable once written)

ratings
├─ customer_id, job_id, score (1-5), feedback
├─ Created when customer hits End-OTP-Satisfied flow

incidents
├─ reporter_id (field agent), customer_id, booking_id
├─ category ('tank_inaccessible'|'unsafe'|'customer_absent'|...)
├─ description, photo_url, status

job_requests (for the multi-tank flow before booking confirmation)
├─ customer_id, address, tanks (JSONB), requested_slot
├─ status ('pending_inspection'|'priced'|'converted_to_booking'|'rejected')

pricing_tiers + pricing_matrix
├─ Tiered pricing by tank capacity bands
├─ Plans: one_time / monthly / quarterly / half_yearly
├─ Prices in PAISE inclusive of 18% GST
└─ effective_from / effective_to for scheduled price changes

referrals
├─ referrer_id, referred_phone, status, reward_paise, redeemed_at

concerns
├─ customer_id, booking_id, category, description, status
```

### Test users currently in DB
- `9999999999` — "Play Reviewer" (auto-created by reviewer bypass)
- Real customer / field / admin accounts seeded by ops

---

## 5. BACKEND API SURFACE

Base URL: `https://api.ozonewash.in/api/v1` (prod) or `http://localhost:3000/api/v1` (dev)

| Module | Routes (verb /path) | Purpose |
|---|---|---|
| **auth** | POST /auth/send-otp, POST /auth/verify-otp, GET/PATCH /auth/profile, GET /auth/users (admin) | Phone-OTP login → JWT; profile mgmt |
| **bookings** | POST /bookings, GET /bookings, GET /bookings/:id, PATCH /bookings/:id/cancel | Customer booking flow |
| **jobs** | POST /jobs/accept, GET /jobs/my, POST /jobs/:id/start, POST /jobs/:id/start-otp, POST /jobs/:id/end-otp, POST /jobs/:id/end-otp-satisfied | Field-team job flow |
| **compliance** | GET /compliance/:job_id/checklist, POST /compliance/:job_id/step, GET /compliance/:job_id/progress | 9-step compliance flow |
| **ecoscore** | GET /ecoscore/me, GET /ecoscore/me/history, POST /ecoscore/recalc/:customer_id (admin) | EcoScore rating + history |
| **certificates** | GET /certificates/me, GET /certificates/:qr_token (public verify), GET /certificates/:id/pdf | Hygiene certificate viewer |
| **amc** | POST /amc/enroll, GET /amc/me, POST /amc/:id/cancel | AMC subscription mgmt |
| **upload** | POST /upload/photo, POST /upload/signature, POST /upload/pdf | R2 upload helpers (multipart) |
| **payments** | POST /payments/create-order, POST /payments/webhook, GET /payments/:id/status | Razorpay flow + webhook |
| **incidents** | POST /incidents/report, GET /incidents/job/:job_id, PATCH /incidents/:id (admin) | Field incident reporting |
| **livestream** | POST /livestream/start (field), POST /livestream/watch (customer) | Agora token issuer (currently disabled in app v1) |
| **mis** | GET /mis/revenue, /sales, /operational, /engagement, /referrals, /ecoscore | Admin MIS reports |
| **admin** | GET /admin/dashboard, /bookings, /customers, /teams, /payouts, /incidents | Admin management endpoints |
| **incentives** | GET /incentives/me, GET /incentives/me/credits, GET /incentives/me/payouts | Field-team earnings (Phase B credit snapshot model) |
| **ratings** | POST /ratings (customer leaves rating after job) | Customer satisfaction capture |
| **rewards** | GET /rewards/wallet, POST /rewards/redeem, GET /rewards/history | EcoPoints redemption |

### Middleware
- `auth.middleware.js` — `authenticate(req)` decodes JWT, attaches `req.user`
- `auth.middleware.js` — `requireRole('admin')` 403s non-admins
- Rate limiters in `src/app.js`:
  - 60 req / 15 min on all `/api/*` (dev: 1000)
  - 3 req / 5 min on `/auth/send-otp` (OTP brute-force protection)
- Helmet, CORS (env-controlled origins), 2MB body limits, gzip compression

---

## 6. MOBILE APP STRUCTURE

### Navigation tree (`src/navigation/RootNavigator.tsx`)

```
RootNavigator (decodes JWT, routes by role)
├─ AuthNavigator (no token)
│  ├─ Landing       — public landing page (web + native)
│  ├─ PhoneInput    — enter phone, request OTP
│  ├─ OTPVerify     — enter OTP, get JWT
│  ├─ Faq           — dedicated FAQ page (web)
│  ├─ About         — about us page
│  └─ Policy        — Privacy/Terms/Refund (type-routed)
│
├─ CustomerNavigator (role = customer)
│  ├─ Tab: Home    → BookingHomeScreen
│  ├─ Tab: Bookings → MyBookingsScreen
│  ├─ Tab: Certs   → CertificatesScreen
│  ├─ Tab: Profile → ProfileScreen
│  └─ Stack: TankDetails / Addons / AddressPicker / DateTime /
│            Payment / BookingConfirmed / BookingDetail /
│            AmcPlans / AmcEnrollment / AmcConfirmed /
│            EcoScoreDetail / CertificateView / LiveWatch
│
├─ FieldNavigator (role = field_team)
│  ├─ Tab: Jobs       → JobListScreen
│  ├─ Tab: Available  → AvailableJobsScreen
│  ├─ Tab: Incentives → IncentiveScreen
│  ├─ Tab: Performance → PerformanceScreen
│  └─ Stack: JobDetail / OtpEntry (start/end) / Checklist /
│            ComplianceStep / IncidentReport / JobTransfer / LiveStream
│
└─ AdminNavigator (role = admin)
   ├─ Tab: Dashboard
   ├─ Tab: Operations (Bookings / Jobs / Teams)
   ├─ Tab: People (Customers / AMC / Incidents)
   └─ Tab: MIS (Revenue / Sales / Operational / Engagement / Referrals / EcoScore)
```

### Key shared screens
- `auth/LandingScreen.tsx` (~4,000 lines) — the marketing landing page rendered identically on web and native, with role-specific rendering branches. Contains: hero, services, add-ons, comparison cards, 9-step process, features, certificate band with QR demo, testimonials, FAQ accordion (native), final CTA, footer. Hamburger menu on mobile screens (links to About / FAQ / Privacy / Terms / Refund).
- `auth/AboutScreen.tsx` — pure RN, identical web+native
- `auth/FaqScreen.tsx` — chat-style FAQ for web
- `shared/PolicyScreen.tsx` — Privacy / Terms / Cancellation, type-routed
- `shared/CertVerifyResultScreen.tsx` — public certificate verifier (opened by scanning the QR on the cert PDF)
- `shared/QrScannerScreen.tsx` — in-app QR scanner

### Shared content modules
- `src/utils/faqContent.ts` — single source of FAQ_DATA (28 entries, 9 categories) used by both LandingScreen inline accordion and FaqScreen
- `src/utils/constants.ts` — colors, dimensions, API base URL config
- `src/utils/responsive.ts` — `useResponsive()` hook → `{ isLarge }` boolean for breakpoint-driven layouts

---

## 7. WEB LANDING PAGE (ozonewash.in)

Same Expo bundle, served as a static web build (`npm run web:build` produces `dist/`).

**Page sections (top to bottom):**

1. **Sticky nav** + **In-hero nav** — logo + tagline ("Hygiene you can see. Health you can feel.") + nav links (desktop) + hamburger menu (mobile) + Book CTA
2. **Hero** — "Pure Tanks. Proven Hygiene." heading with gradient on "Proven Hygiene.", 3 highlighted bullet pills, primary + "Watch Demo" CTAs, India patent badge, animated tank illustration with floating proof cards (Water Purity 96%, Crew #214 Certify Step 4/4, QR Cert #OW-DEMO clickable, EcoScore A+)
3. **Stats glass** — 4 stats (500+ tanks, 100+ households, 8-step process, 1st patent applied)
4. **Services** — 3 tank-type cards (Overhead / Sump / Plastic)
5. **Add-Ons (Hygiene Upgrades)** — 6 cards (UV Sterilization Pass, Anti-Algae Spray, Anti-Lime, Pathogen Testing, Structural Audit, IoT Sensors with "Coming Soon" badge)
6. **Comparison** — Old Way (AVOID) vs Ozone Wash™ (RECOMMENDED) inline-pill cards
7. **8-Step Process (How It Works)** — animated grid (desktop) / timeline (mobile) with expandable 8-step panel
8. **Features (Visible Purity. Proven Safety.)** — 3D rotating tank with feature chips (desktop) / 4-card grid (mobile)
9. **Digital Certificate band** — "Every visit ends with a QR-signed hygiene certificate" + bulleted list (Ozone readings, ATP, Before/after photos, Crew ID & signature) + Shareable Proof + Sample Certificate card with **live QR opening a real demo cert PDF on Cloudflare R2**
10. **Testimonials** — Railway-style infinite marquee (web), simple list (native)
11. **FAQ** — chat UI on web, inline accordion on native — same 28 questions from `faqContent.ts`
12. **Final CTA** — "Hygiene you can see. Health you can feel." + Get Started Free button + phone
13. **Footer** — brand, Hyderabad, Terms / Privacy / Refund links, "Powered by Shyra.pro"

**Web-only flourishes:**
- Floating Download App FAB (bottom-right, auto-expands every 7s, hover-expands)
- CSS keyframes for hover animations on service cards, FAQ items, nav
- Real scannable QR via `api.qrserver.com` on the cert demo card
- Parallax on hero floating cards (mouse-tracked)
- Bubble particle effects on the hero gradient

**Native-only sections:**
- Mobile sticky bottom CTA bar ("Book Your Clean Now")
- Inline FAQ accordion (since web has the dedicated FaqScreen page)
- Simpler tank illustration with 4 floating cards (Water Purity / QR Cert / Crew / EcoScore)

---

## 8. BUSINESS LOGIC

### 8.1 Pricing engine — `src/services/pricing.js`
- All prices in **paise** (₹1 = 100 paise), inclusive of **18% GST**
- Tiered by tank capacity (e.g., 500-9,999L / 10,000-49,999L / 50,000-99,999L / 100,000+)
- Plans: `one_time`, `monthly`, `quarterly`, `half_yearly`
- Multi-tank discount: 15% for 2 tanks, 30% for 2+ tanks
- AMC discounts (vs one-time): Monthly 30%, Quarterly 15%, Half-Yearly 10%, Yearly 5%
- Pricing matrix is row-versioned with `effective_from` so price changes can be scheduled

### 8.2 EcoScore™ engine — `src/modules/ecoscore`
- 0-100 score recalculated nightly per customer (cron at 02:00 IST)
- Badges: Platinum (90+), Gold (75-89), Silver (60-74), Bronze (40-59), Unrated (<40)
- Inputs: timeliness of cleaning, completion of all 9 compliance steps, water test pass, AMC compliance, customer rating
- Rationale array (e.g., "Last clean within 90 days ✓", "Ozone + UV cycles logged ✓") shown in app
- Tips array (improvement suggestions) shown when score is below Gold

### 8.3 EcoPoints redemption — `src/modules/rewards`
- 1 EcoScore percentage point = 1 EcoPoint (e.g., score 87 → 87 points earned)
- Bonus points for badges (Gold +20, Platinum +50) and streaks (3 on-time AMC services = +100)
- Wallet capped at 1,000 points, valid 24 months from earned date
- Redeemable against: AMC renewal discounts, hygiene upgrade add-ons, partner benefits, streak rewards
- Repository: `src/modules/rewards/rewards.repository.js`

### 8.4 Field incentive engine (Phase B credit snapshot) — `src/modules/incentives`
- Field technicians earn credits per completed job
- Credits are **immutable snapshots** (Phase B model — once written, never updated, even if booking is later refunded)
- Reasons: `job_completed`, `streak_bonus`, `rating_bonus`, `same_day_bonus`
- Nightly cron at 03:00 IST aggregates credits → payouts
- Admin views payouts at `AdminPayoutsScreen`; field user sees own credits at `IncentiveScreen` + `PerformanceScreen`

### 8.5 AMC plans — `src/modules/amc`
- Customer enrolls in monthly / quarterly / half-yearly / yearly plan
- Backend auto-schedules next service date on enrollment + after each AMC service
- Service uses booking flow but tagged with `amc_plan` so pricing applies the right discount
- Missed services flagged on EcoScore but can be rescheduled within the same cycle
- Cancellation: pro-rated refund based on services delivered (excludes EcoPoints already used, hygiene upgrades already consumed)

---

## 9. THE 9-STEP COMPLIANCE FLOW (the SOP for every cleaning)

Each step requires a **mandatory photo upload** (compliance proof) and writes a row to `compliance_logs`. WhatsApp template `compliance_stage_N_complete` is sent to customer after each step.

| # | Step Name | Required Fields | Photo Tag |
|---|---|---|---|
| **0** | **PPE & Safety Discipline** (pre-flight) | PPE list (mask/gloves/boots/coverall/face_shield/o3_sensor), ladder_check (Secured/Unsafe), electrical_check (Safe/Risk), emergency_kit, spare_tank_water, fence_placed, danger_board, arrival_at timestamp | PPE proof photo |
| **1** | **Pre-Check & Setup** | 6 water-test buckets: turbidity, ph_level, orp, conductivity, tds, atp | Before-wash tank photo |
| **2** | **Drain & Inspect** | water_level_pct, tank_condition | Tank before commencement |
| **3** | **Mechanical Scrub & Rotary Jet** | scrub_completed (bool) | Mid-scrub photo |
| **4** | **High-Pressure Rinse** | rinse_duration (`<10 min` / `10-20` / `>20`) | Rinse photo |
| **5** | **Sludge Removal** | disposal_status (Per-protocol / Custom) | Drained sludge photo |
| **6** | **Ozone Disinfection** | ozone_cycle_duration, ozone_ppm_dosed (1-2 ppm target) | Ozone cycle live photo |
| **7** | **UV Double Lock** (optional — has Skip toggle) | uv_cycle_duration, uv_dose (20-60 mJ/cm²), uv_lumines_status, uv_skipped (bool) | UV add-on photo |
| **8** | **After-Wash Testing & Proof Delivery** | Same 6 water-test buckets as step 1 (re-tested), client_signature_url (signature pad), technician_remarks | Final post-test photo |

Until all 9 steps are `completed=true` (or step 7 has `uv_skipped=true`), the **End OTP** to close the job will not be issued and the certificate cannot be generated.

After step 8 completes:
- `certificates` row is created with QR token, all readings, before/after photos
- PDF is rendered server-side and uploaded to R2
- WhatsApp template `compliance_stage_8_complete` sent with certificate link
- EcoScore is recalculated (synchronous, not waiting for cron)

---

## 10. AUTHENTICATION & PLAY REVIEWER BYPASS

### Real-user flow
1. App calls `POST /auth/send-otp` with `{ phone }`
2. Backend generates 6-digit OTP, writes to `otp_codes`, sends via Wati WhatsApp + fallback SMS
3. User enters OTP → app calls `POST /auth/verify-otp` with `{ phone, otp, fcm_token? }`
4. Backend checks `otp_codes` row exists, not expired, not used → marks `used=true` → finds/creates `users` row → issues 7-day JWT
5. App stores JWT in AsyncStorage and uses it as `Authorization: Bearer <token>` for all subsequent requests

### Reviewer bypass (added v1.0.1, commit `de21c89`)
Triggered when **both** `REVIEWER_PHONE` and `REVIEWER_OTP` env vars are set on the backend AND the request matches:

- `sendOtp`: skips DB write, skips Wati / SMS, returns success
- `verifyOtp`: skips OTP table lookup, finds-or-creates a customer-role user with `name='Play Reviewer'`, issues normal JWT

Production env values:
```
REVIEWER_PHONE=9999999999
REVIEWER_OTP=999999
```

These are documented in Play Console under **App content → App access** for the Google reviewer.

### JWT shape
```json
{
  "id": "<UUID>",
  "phone": "9876543210",
  "role": "customer | field_team | admin",
  "iat": 1779089116,
  "exp": 1779693916
}
```

Signed HS256 with `JWT_SECRET` env var.

---

## 11. NOTIFICATIONS & INTEGRATIONS

### Wati BSP — WhatsApp + SMS
- All OTPs sent via Wati template `otp_login` (variable: `{{otp_code}}`)
- 9 compliance stage templates: `compliance_stage_0_complete` … `compliance_stage_8_complete` — **need registration + approval on Wati side before going live** (currently a documented blocker)
- Booking confirmation, slot reminder, certificate-ready, AMC renewal nudge templates
- Backend wrapper at `src/services/notification.service.js` — fire-and-forget with `Promise.allSettled` so a failing template doesn't break the request

### Firebase Cloud Messaging
- Push notifications for booking status, crew arrival, certificate-ready, EcoScore badge change
- Token captured at login from `expo-notifications` and stored on `users.fcm_token`
- Backend Admin SDK config from `EXPO_PUBLIC_FIREBASE_*` env vars

### Razorpay
- Test mode in dev (`rzp_test_*` keys)
- Live mode in prod (`rzp_live_*` — to be set before launch)
- Webhook URL: `POST /api/v1/payments/webhook` (verify signature with `RAZORPAY_KEY_SECRET`)
- Mock orders auto-generated in dev if keys are missing

### Cloudflare R2 storage
- Bucket: `kaizernews` (shared with other Shyra products; prefix `ozonewash/` isolates Ozone Wash keys)
- Used for: compliance step photos, signature captures, certificate PDFs, agent profile photos
- Endpoint + access keys in env vars
- Public read via R2 dev URL or custom domain (`cdn.ozonewash.in` planned)

### Sentry
- DSN in `EXPO_PUBLIC_SENTRY_DSN` for app + `SENTRY_DSN` for backend (to be set in prod)
- Captures uncaught exceptions, navigation breadcrumbs, network errors

---

## 12. DEPLOYMENT

### Backend
- Auto-deploy on push to `main` (Railway / Render)
- Required prod env vars:
  ```
  DATABASE_URL (Supabase postgres connection)
  SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY
  JWT_SECRET, JWT_EXPIRES_IN=7d
  PORT=3000, NODE_ENV=production
  APP_URL=https://api.ozonewash.in
  ALLOWED_ORIGINS=https://admin.ozonewash.in,https://ozonewash.in
  RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET
  R2_ACCOUNT_ID, R2_ACCESS_KEY, R2_SECRET_KEY, R2_BUCKET, R2_ENDPOINT
  WATI_API_URL, WATI_API_KEY, WATI_TEMPLATE_PREFIX
  FCM_PROJECT_ID, FCM_PRIVATE_KEY, FCM_CLIENT_EMAIL
  SENTRY_DSN
  REVIEWER_PHONE=9999999999, REVIEWER_OTP=999999   (Play reviewer bypass)
  ```
- Health check: `GET /api/v1/health` returns `{ status: 'OK' }`

### Android app (Play Store)
- Bundle ID: `in.ozonewash.app`
- Signed with `e:\ozone-wash-app\devsharkify__ozone-wash-app.jks` (SHA-256: `FD:BC:67:A0:03:25:1B:BD:DB:0A:33:F1:73:E7:B6:D7:7F:C4:00:92:31:8B:59:06:63:34:AE:77:63:33:A4:F3`)
- Current AAB: `e:\ozone-wash-app\android\app\build\outputs\bundle\release\app-release.aab` (68 MB, version 1.0.1 / versionCode 2)
- Build command:
  ```powershell
  cd e:\ozone-wash-app\android
  .\gradlew.bat bundleRelease `
    "-Pandroid.injected.signing.store.file=e:\ozone-wash-app\devsharkify__ozone-wash-app.jks" `
    "-Pandroid.injected.signing.store.password=<keystore_password>" `
    "-Pandroid.injected.signing.key.alias=<alias>" `
    "-Pandroid.injected.signing.key.password=<key_password>" `
    --no-daemon
  ```
- Architectures: all 4 (`armeabi-v7a, arm64-v8a, x86, x86_64`) — Play Store splits per device
- Permissions in manifest: CAMERA, FINE_LOCATION, COARSE_LOCATION, POST_NOTIFICATIONS, READ_MEDIA_IMAGES, READ_EXTERNAL_STORAGE, INTERNET, NETWORK_STATE, VIBRATE, RECEIVE_BOOT_COMPLETED, WAKE_LOCK
- **No** FOREGROUND_SERVICE_MEDIA_PROJECTION (removed in v1 by uninstalling `react-native-agora`)

### iOS — not yet started (0% progress)

---

## 13. CURRENT STATE (as of session end)

### ✅ Done
- Backend feature-complete (all 15 modules wired, cron jobs running)
- Database migrations 001-011 applied; reviewer bypass live
- Mobile app v1.0.1 functionally complete: customer + field + admin flows
- Web landing page redesigned (hero, Add-Ons, Digital Certificate band, hamburger menu, Download App FAB)
- AAB built, signed, 68 MB, uploaded to Play Console
- Privacy / Terms / Cancellation policies (verbatim spec) wired
- Live-stream removed (Agora dep dropped, "Coming Soon" placeholder remains)
- Play Reviewer bypass deployed (commit `de21c89` on `main`)
- 4.9★ rating removed from stats (Play Store metadata policy compliance)

### 🔴 Blocking Play Store launch (next 1-2 days)
1. Re-export feature graphic (1024×500) without the 4.9★ stat
2. Re-take screenshots without the testimonials section ("Best ₹999 spent" — Sai P. quote)
3. Update Play Console **App access** form with reviewer credentials (`9999999999` / `999999`)
4. Verify backend production deployment has `REVIEWER_PHONE` + `REVIEWER_OTP` env vars set
5. Set Production → Countries/regions → India
6. Finish Data Safety form (answers prepared)
7. Content rating questionnaire (Everyone / 3+)
8. Submit appeal for the metadata + login rejections

### 🟠 Pre-launch operations (before real customers)
- Wati BSP — register 9 stage-completion WhatsApp templates and get them approved
- Backend prod env vars in Railway/Render (Razorpay live keys, Wati keys, R2 creds, FCM service account)
- Web deploy `ozonewash.in` (Vercel/Cloudflare Pages); DNS + SSL
- Privacy URL `https://ozonewash.in/privacy` must be live before submit
- Promotional video (optional, YouTube)

### 🟡 v1.1 cleanup (post-launch)
- Migrate `expo-image-picker` to Android Photo Picker → drop READ_MEDIA_IMAGES + READ_EXTERNAL_STORAGE
- Audit transitive permissions (RECORD_AUDIO, MODIFY_AUDIO_SETTINGS, SYSTEM_ALERT_WINDOW — likely unused)
- ProGuard/R8 minification + resource shrinking → ~10-15 MB AAB shrink
- Re-introduce live streaming with iOS-compatible WebRTC (replaces removed Agora)
- iOS launch from scratch (keystore, App Store Connect, IPA build)
- Hindi + Telugu localization

### 🟢 Future roadmap features
- IoT Sensor Integration (currently "Coming Soon" tag in Add-Ons)
- Terra Environ Labs pathogen testing report ingestion (API endpoints stubbed)
- Bangalore / Chennai / Mumbai market expansion

---

## 14. KEY FILES TO KNOW

### Backend critical paths
- `src/server.js` — entry point, starts Express + cron
- `src/app.js` — middleware stack, dotenv config (loads `.env.client`), routes
- `src/routes/index.js` — mounts all 15 module routers
- `src/config/db.js` — Postgres pool (20 connections, 30s idle timeout)
- `src/modules/auth/auth.service.js` — login + reviewer bypass
- `src/modules/compliance/compliance.service.js` — 9-step orchestration
- `src/modules/compliance/compliance.repository.js` — step persistence
- `src/services/pricing.js` — tier lookup + price computation
- `src/services/notification.service.js` — Wati WhatsApp + SMS dispatcher
- `src/services/cron.service.js` — registers nightly EcoScore + incentive crons

### Mobile app critical paths
- `App.tsx` — app root, providers, gesture handler, navigation container
- `src/navigation/RootNavigator.tsx` — role-based routing
- `src/services/api.ts` — axios instance with auth interceptor, all API helpers
- `src/screens/auth/LandingScreen.tsx` — the marketing page (web + native)
- `src/screens/field/ChecklistScreen.tsx` — 9-step compliance dashboard
- `src/screens/field/ComplianceStepScreen.tsx` — per-step form (water tests, photo, signature)
- `src/screens/customer/PaymentScreen.tsx` — Razorpay integration
- `src/screens/shared/PolicyScreen.tsx` — legal pages (Privacy / Terms / Cancellation)
- `src/utils/faqContent.ts` — shared FAQ source-of-truth

### Storage layout (Cloudflare R2)
- `ozonewash/compliance/<job_id>/step_<n>_<timestamp>.jpg` — step photos
- `ozonewash/signatures/<job_id>.png` — client signatures
- `ozonewash/certificates/<cert_id>.pdf` — generated certificate PDFs
- `ozonewash/profile/<user_id>.jpg` — user profile photos (optional)

---

## 15. CONTACT & OWNERSHIP

**Company:** VijRam Health Sense Pvt. Ltd.
**Address:** Flat No 201, Sai Krishna Thakur Residency, Padmaraonagar, Secunderabad, Hyderabad – 500025
**Email:** hello@ozonewash.in
**Phone:** +91 81 79 69 59 59
**Website:** ozonewash.in

**Founders:**
- Ramesh Kumar Sappa (Co-founder) — IIM-trained, 30+ years across FMCG, insurance, telecom, forex, travel
- Shanmuga Valli S (Co-founder) — financial consultancy, execution, compliance, customer-centric ops

**Active developer:** Imran Pasha (Imranpasha30 on GitHub)
**Codebase repos:**
- App: `https://github.com/Imranpasha30/ozone-wash-app`
- Backend: `https://github.com/Imranpasha30/ozone-wash-backend`
- DB: Supabase project `agpmowedfkvovfdbzoav`

---

## 16. HOW TO READ THIS DOC

If you are an AI assistant being briefed on this project:
- The **product** is a service-platform app (booking + compliance + certification)
- The **stack** is React Native (Expo) + Node/Express + Supabase Postgres + Cloudflare R2
- There are **three user roles** in one codebase, role-routed at runtime by JWT claim
- The **compliance flow has 9 mandatory steps** with photo uploads — this is the heart of the product
- **Pricing** is tiered by tank capacity, AMC-discounted, GST-inclusive, stored in paise
- **EcoScore** is a gamified rating that drives **EcoPoints** wallet redemptions
- The app is **in submission to Google Play Store**; reviewer bypass is live
- iOS has not been started yet
- Live streaming is a documented "Coming Soon" — removed in v1 because Agora dep added a Play Store-flagged permission

Anything not in this doc, ask the developer or grep the codebase. The repo structure mirrors the module list above 1:1.
