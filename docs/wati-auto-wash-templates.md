# Wati WhatsApp Template Registration — Ozone Auto Wash

> **For the operations team to paste into the Wati BSP dashboard.**
> Backend code already calls `NotificationService.sendWhatsApp(phone, templateName, [params])`
> for each event below. Until each template is *approved* on Wati, the call
> logs a harmless "WhatsApp error: template not found" and the booking
> lifecycle continues unaffected (fire-and-forget design).

---

## Submission checklist

For each template below:

1. Wati Dashboard → **Templates → Add template**
2. **Category:** `UTILITY` (most templates) or `TRANSACTIONAL` — never MARKETING (Meta will reject auto-wash service updates as marketing)
3. **Language:** English (en) — add Telugu (te) later when localisation ships
4. **Buttons:** add CTA buttons where indicated (URL or QUICK_REPLY)
5. **Header media:** none (text-only templates approve faster)
6. **Sample variables:** use the example values shown in each spec
7. Submit → wait for Meta approval (24–48 h typical, can be up to 7 days)

---

## Template 1 — `auto_wash_booking_confirmed`

**Trigger:** Customer just created an auto-wash booking.
**Category:** UTILITY
**Variables in order:** `{{1}}` customer_name, `{{2}}` job_id_short, `{{3}}` scheduled_datetime, `{{4}}` package_name

**Body:**
```
Hi {{1}},

Your Ozone Wash Auto booking is confirmed ✓

Booking ID: #{{2}}
Date & time: {{3}}
Package: {{4}}

Our EV crew will arrive in your slot. Track live in the app.

— Ozone Wash™
```

**Suggested CTA button:** URL → `https://ozonewash.in/app` (text: "Track booking")

---

## Template 2 — `auto_wash_crew_assigned`

**Trigger:** Admin assigned a crew to the auto-wash job.
**Category:** UTILITY
**Variables:** `{{1}}` crew_name, `{{2}}` job_id_short

**Body:**
```
{{1}} has been assigned to your car wash (job #{{2}}).

They will arrive in your scheduled slot. You'll get a notification
when they're on the way.

— Ozone Wash™
```

---

## Template 3 — `auto_wash_step_started`

**Trigger:** Crew tapped "Start" on steps 1–5 (non-fogging steps).
**Category:** UTILITY
**Variables:** `{{1}}` step_number, `{{2}}` step_label

**Body:**
```
Step {{1}} of 6 in progress: {{2}}.

Your car wash is on schedule. Live updates in the app.

— Ozone Wash™
```

> Note: This template fires up to 5× per job. To reduce volume in v1.1 we
> may consolidate into a single "status update" template with the latest step
> as a variable.

---

## Template 4 — `auto_wash_fogging_started` ⚠️ SAFETY-CRITICAL

**Trigger:** Crew tapped "Start" on step 6 (cabin ozone fogging).
**Category:** UTILITY (this is safety, not marketing)
**Variables:** `{{1}}` job_id_short

**Body:**
```
⚠️ Cabin ozone fogging is now in progress (job #{{1}}).

PLEASE DO NOT ENTER THE VEHICLE for the next 15 minutes.
Ozone needs time to dissipate back into oxygen. It is completely
safe once the wait window ends — perfectly normal and standard
to our process.

The crew will notify you when it's safe to re-enter.

— Ozone Wash™
```

> **High priority for Wati approval — this message protects the customer.
> If approval is delayed, fall back to the in-app banner in
> `AutoWashBookingDetailScreen` which shows the same warning during step 6.**

---

## Template 5 — `auto_wash_job_complete`

**Trigger:** Crew tapped "Complete" — certificate issued.
**Category:** UTILITY
**Variables:** `{{1}}` customer_name, `{{2}}` ecoscore, `{{3}}` eco_badge, `{{4}}` water_saved_litres, `{{5}}` verify_url

**Body:**
```
Hi {{1}},

Your car is hygiene-certified ✨

EcoScore: {{2}} ({{3}})
Water saved vs traditional wash: {{4}} L

Your QR-signed certificate is ready. Share with anyone — it's
tamper-evident and links to a server-verified record:

{{5}}

Book your next wash any time in the app.

— Ozone Wash™
```

**Suggested CTA buttons:**
- URL → `{{5}}` (text: "View certificate")
- QUICK_REPLY → "Book next wash"

---

## Template 6 — `auto_wash_subscription_renewal_due`

**Trigger:** Nightly cron — fires 7 days before next_billing_date.
**Category:** UTILITY
**Variables:** `{{1}}` plan_name, `{{2}}` days_left, `{{3}}` price_label

**Body:**
```
Your Ozone Wash {{1}} subscription renews in {{2}} days
for {{3}}.

To pause, upgrade, or cancel — open the app under Profile →
Subscriptions. No lock-in for monthly plans.

— Ozone Wash™
```

---

## Template 7 — `auto_wash_car_birthday`

**Trigger:** Nightly cron — fires on the anniversary of `vehicles.registration_date`.
**Category:** UTILITY
**Variables:** `{{1}}` vehicle_nickname, `{{2}}` age_years

**Body:**
```
🎂 Your {{1}} just turned {{2}} years old!

Treat it to a HygieneElite wash and keep that "new car" feel.
Book in 60 seconds in the app.

— Ozone Wash™
```

---

## Template 8 — `auto_wash_wash_due` (optional, future cron)

**Trigger:** 20 days after last wash if customer has an active subscription with unused washes.
**Category:** UTILITY
**Variables:** `{{1}}` plan_name, `{{2}}` washes_remaining, `{{3}}` days_since_last_wash, `{{4}}` cycle_end_date

**Body:**
```
You have {{2}} washes remaining in your {{1}} cycle
(ends {{4}}).

Your last wash was {{3}} days ago. Book your next one in
the app to make the most of your plan.

— Ozone Wash™
```

---

## Production rollout checklist

```
[ ] Template 1 — auto_wash_booking_confirmed       submitted ___  approved ___
[ ] Template 2 — auto_wash_crew_assigned            submitted ___  approved ___
[ ] Template 3 — auto_wash_step_started             submitted ___  approved ___
[ ] Template 4 — auto_wash_fogging_started  ⚠️       submitted ___  approved ___
[ ] Template 5 — auto_wash_job_complete             submitted ___  approved ___
[ ] Template 6 — auto_wash_subscription_renewal_due submitted ___  approved ___
[ ] Template 7 — auto_wash_car_birthday             submitted ___  approved ___
[ ] Template 8 — auto_wash_wash_due (optional)      submitted ___  approved ___
```

---

## How to verify a template fires end-to-end

1. Backend log will show `[autowash.notify] booking_confirmed → 9876543210 ...`
   immediately when the event triggers — this confirms the call-site is correct.
2. Wati log will show the `sendWhatsApp` attempt — this confirms the API
   credentials and template names match.
3. WhatsApp on the customer's phone will show the message within 30 seconds
   — this confirms Meta approved the template and it's deliverable.

If only step 1 shows but step 2 doesn't: check `WATI_API_KEY` env var in prod.
If steps 1+2 show but step 3 doesn't: the template name on Wati doesn't match
the string we send — confirm it's exactly `auto_wash_booking_confirmed` (no
capital letters, no dashes).

---

## Code reference

- Call sites: `src/modules/auto-wash/auto-wash.service.js` (in `createBooking`,
  `startStep`, `completeJob`, `adminAssignJob`)
- Wrapper functions: `src/services/notification.service.js` — search for
  `autoWashBookingConfirmed`, `autoWashCrewAssigned`, etc.
- Underlying transport: `NotificationService.sendWhatsApp(phone, templateName, params)`
  in the same file — already implements Wati BSP with try/catch fallback.

Template names + variable order are the **contract**. Once approved on Wati,
the existing code immediately starts sending real messages with no redeploy.
