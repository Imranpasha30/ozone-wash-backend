/**
 * Business logic for the Auto Wash module.
 * Spec: Master Prompt v2.0 PART 4 + Auto Wash Scope PDF.
 *
 * Responsibilities:
 *   • Vehicle profile CRUD
 *   • Pricing computation (package + add-ons + multi-tank / subscription discount)
 *   • Booking creation (creates a jobs row, job_type='auto_wash')
 *   • Pre-inspection photo upload
 *   • 6-step compliance lifecycle (start/end step, complete job)
 *   • EcoScore calculation per wash
 *   • Certificate generation
 *   • Subscriptions (create/pause/cancel/active)
 */

const crypto = require('crypto');
const repo = require('./auto-wash.repository');
const NotificationService = require('../../services/notification.service');
const { generateAndUploadCertPDF } = require('./auto-wash.pdf');
const { query } = require('../../config/db');
const { istDateKey } = require('../../utils/date');

// Best-effort customer lookup for notification stubs.
// Failures are swallowed — never block the booking/step lifecycle on a notify call.
async function _safeLookupCustomer(customerId) {
  try {
    const { rows } = await query(
      `SELECT id, name, phone FROM users WHERE id = $1 LIMIT 1`,
      [customerId],
    );
    return rows[0] || null;
  } catch { return null; }
}

/* ── Constants ──────────────────────────────────────────────────────────── */

const VEHICLE_TYPES = ['hatchback', 'sedan', 'suv_muv', 'luxury', 'two_wheeler'];
const PACKAGE_CODES = ['ecorinse', 'ecoshield', 'ozonecomplete', 'hygieneelite'];
const SERVICE_STEPS_CORE = [
  { n: 1, name: 'mist_prerinse',     label: 'Mist Pre-Rinse' },
  { n: 2, name: 'eco_foam',          label: 'Eco-Foam Application' },
  { n: 3, name: 'ozone_rinse',       label: 'Ozone Rinse' },
  { n: 4, name: 'precision_drying',  label: 'Precision Drying' },
  { n: 5, name: 'interior_steam',    label: 'Interior Steam Clean' },
  { n: 6, name: 'ozone_fogging',     label: 'Ozone Cabin Fogging' },
];

// Min fogging duration before crew can mark step 6 complete (PDF: 8 min minimum).
const MIN_FOGGING_DURATION_MIN = 8;

// EcoScore benchmark: conventional wash uses ~50 L. We treat 50 as the baseline
// for the water_saved metric and use the PDF's threshold table for scoring.
const CONVENTIONAL_WATER_LITRES = 50;

/* ── Helpers ────────────────────────────────────────────────────────────── */

function priceFieldForVehicleType(type) {
  switch (type) {
    case 'hatchback': return 'price_hatchback_paise';
    case 'sedan':     return 'price_sedan_paise';
    case 'suv_muv':   return 'price_suv_paise';
    case 'luxury':    return 'price_luxury_paise';
    case 'two_wheeler': return 'price_hatchback_paise'; // 2W priced at hatchback tier (cheapest)
    default: throw { status: 400, message: `Unsupported vehicle_type: ${type}` };
  }
}

function isoDate(d) { return d instanceof Date ? d.toISOString() : new Date(d).toISOString(); }

function generateQrToken() {
  // 32-char URL-safe random token
  return crypto.randomBytes(24).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/* ── EcoScore engine ────────────────────────────────────────────────────── */

/**
 * Spec: Auto Wash Scope PDF Section 10.1.
 *   Water Efficiency:    40 pts  (≤3L=40 | 3-4L=30 | 4-5L=20 | 5-6L=10 | >6L=0)
 *   Ozone Dosing:        20 pts  (exterior 0.05-0.2 ppm logged)
 *   Cabin Fogging:       15 pts  (8-12 min=15 | 6-8 min=10 | <6 min=0)
 *   PPE Compliance:      15 pts  (full PPE checklist confirmed)
 *   Zero Chemicals:      10 pts  (no chemical detergents used)
 */
function calculateEcoScore({ water_used_litres, ozone_ppm_exterior, fogging_duration_min, ppe_full, zero_chemicals }) {
  let score = 0;

  // Water efficiency (40 pts)
  if (water_used_litres == null) { /* skip */ }
  else if (water_used_litres <= 3)  score += 40;
  else if (water_used_litres <= 4)  score += 30;
  else if (water_used_litres <= 5)  score += 20;
  else if (water_used_litres <= 6)  score += 10;

  // Ozone dosing (20 pts)
  if (ozone_ppm_exterior != null && ozone_ppm_exterior >= 0.05 && ozone_ppm_exterior <= 0.2) {
    score += 20;
  }

  // Cabin fogging duration (15 pts)
  if (fogging_duration_min == null) { /* skip */ }
  else if (fogging_duration_min >= 8 && fogging_duration_min <= 12) score += 15;
  else if (fogging_duration_min >= 6)                                score += 10;

  // PPE (15 pts)
  if (ppe_full) score += 15;

  // Zero chemicals (10 pts)
  if (zero_chemicals !== false) score += 10; // default true unless crew logged a chemical

  return Math.max(0, Math.min(100, score));
}

function badgeForScore(score) {
  if (score >= 85) return 'platinum';
  if (score >= 70) return 'gold';
  if (score >= 50) return 'silver';
  return 'bronze';
}

/* ── Public catalog ─────────────────────────────────────────────────────── */

async function getPackages() {
  return repo.listPackages();
}

async function getAddons() {
  return repo.listAddons();
}

async function getSubscriptionPlans() {
  return repo.listSubscriptionPlans();
}

/* ── Pricing engine ─────────────────────────────────────────────────────── */

/**
 * Quote a booking: { vehicle_type, package_code, addon_codes[], subscription_code? }
 *   → { items[], subtotal_paise, discount_paise, total_paise, ecoscore_preview_water_saved_litres }
 *
 * Notes:
 *   • All prices include 18% GST (matches existing system convention).
 *   • Subscription discount applies to add-ons only (per PDF Section 3.2 Step 5).
 *   • If subscription provides washes_per_cycle > 0, the package itself is free (covered).
 */
async function quotePrice({ vehicle_type, package_code, addon_codes = [], subscription_code = null }) {
  if (!VEHICLE_TYPES.includes(vehicle_type)) {
    throw { status: 400, message: `Invalid vehicle_type. Must be one of: ${VEHICLE_TYPES.join(', ')}` };
  }
  if (!PACKAGE_CODES.includes(package_code)) {
    throw { status: 400, message: `Invalid package_code. Must be one of: ${PACKAGE_CODES.join(', ')}` };
  }

  const pkg = await repo.getPackageByCode(package_code);
  if (!pkg) throw { status: 404, message: 'Package not found.' };
  const priceField = priceFieldForVehicleType(vehicle_type);

  const items = [];
  let subtotal = 0;

  // Subscription decides whether the base package is included.
  let sub = null;
  if (subscription_code) {
    sub = await repo.getSubscriptionPlan(subscription_code);
    if (!sub) throw { status: 404, message: `Subscription plan '${subscription_code}' not found.` };
  }

  if (!sub || sub.washes_per_cycle === 0) {
    const basePaise = pkg[priceField];
    items.push({
      kind: 'package',
      code: pkg.code,
      name: pkg.display_name,
      price_paise: basePaise,
    });
    subtotal += basePaise;
  } else {
    items.push({
      kind: 'package',
      code: pkg.code,
      name: `${pkg.display_name} (included in subscription)`,
      price_paise: 0,
    });
  }

  if (addon_codes.length) {
    const addons = await repo.getAddonsByCodes(addon_codes);
    const missing = addon_codes.filter(c => !addons.find(a => a.code === c));
    if (missing.length) {
      throw { status: 400, message: `Unknown add-on codes: ${missing.join(', ')}` };
    }
    for (const a of addons) {
      const addonPaise = a[priceField];
      items.push({
        kind: 'addon',
        code: a.code,
        name: a.display_name,
        price_paise: addonPaise,
      });
      subtotal += addonPaise;
    }
  }

  let discount = 0;
  if (sub && sub.addon_discount_pct > 0) {
    const addonSubtotal = items.filter(i => i.kind === 'addon').reduce((s, i) => s + i.price_paise, 0);
    discount = Math.floor(addonSubtotal * sub.addon_discount_pct / 100);
  }

  const total = subtotal - discount;

  // EcoScore preview: target 3L water vs 50L conventional.
  const ecoscore_preview_water_saved_litres = CONVENTIONAL_WATER_LITRES - 3;

  return {
    items,
    subtotal_paise: subtotal,
    discount_paise: discount,
    total_paise: total,
    ecoscore_preview_water_saved_litres,
  };
}

/* ── Vehicles ───────────────────────────────────────────────────────────── */

async function addVehicle(customerId, fields) {
  if (!VEHICLE_TYPES.includes(fields.vehicle_type)) {
    throw { status: 400, message: `Invalid vehicle_type.` };
  }
  if (!fields.registration_number || !String(fields.registration_number).trim()) {
    throw { status: 400, message: 'registration_number is required.' };
  }
  return repo.createVehicle({
    customer_id: customerId,
    vehicle_type: fields.vehicle_type,
    registration_number: String(fields.registration_number).trim().toUpperCase(),
    make: fields.make,
    model: fields.model,
    year: fields.year ? Number(fields.year) : null,
    nickname: fields.nickname,
    registration_date: fields.registration_date || null,
    is_primary: !!fields.is_primary,
  });
}

async function listVehicles(customerId) {
  return repo.listVehiclesForCustomer(customerId);
}

async function updateVehicle(customerId, vehicleId, fields) {
  const existing = await repo.findVehicleById(vehicleId, customerId);
  if (!existing) throw { status: 404, message: 'Vehicle not found.' };
  if (fields.vehicle_type && !VEHICLE_TYPES.includes(fields.vehicle_type)) {
    throw { status: 400, message: 'Invalid vehicle_type.' };
  }
  if (fields.registration_number) {
    fields.registration_number = String(fields.registration_number).trim().toUpperCase();
  }
  return repo.updateVehicle({ id: vehicleId, customer_id: customerId, fields });
}

async function deleteVehicle(customerId, vehicleId) {
  const ok = await repo.deleteVehicle(vehicleId, customerId);
  if (!ok) throw { status: 404, message: 'Vehicle not found.' };
}

/* ── Bookings ───────────────────────────────────────────────────────────── */

async function createBooking({
  customer_id, vehicle_id, package_code, addon_codes = [],
  scheduled_at, location_lat, location_lng, location_address,
  gated_community, notes, subscription_code = null,
  additional_stops = [], // [{ vehicle_id, location_address, location_lat, location_lng }]
}) {
  if (!scheduled_at) throw { status: 400, message: 'scheduled_at is required.' };
  if (!location_address?.trim()) throw { status: 400, message: 'Service address is required.' };

  // Confirm primary vehicle belongs to this customer.
  const vehicle = await repo.findVehicleById(vehicle_id, customer_id);
  if (!vehicle) throw { status: 400, message: 'vehicle_id is invalid or not yours.' };

  // Validate all additional-stop vehicles up front (atomic-ish: any bad
  // entry aborts the whole booking before we start writing).
  for (const s of additional_stops) {
    if (!s.vehicle_id) throw { status: 400, message: 'Each additional stop needs a vehicle_id.' };
    if (!s.location_address?.trim()) {
      throw { status: 400, message: 'Each additional stop needs an address.' };
    }
    const v = await repo.findVehicleById(s.vehicle_id, customer_id);
    if (!v) throw { status: 400, message: `Stop vehicle ${s.vehicle_id} is invalid or not yours.` };
  }

  // Re-quote price server-side (never trust client total).
  const quote = await quotePrice({
    vehicle_type: vehicle.vehicle_type,
    package_code,
    addon_codes,
    subscription_code,
  });

  const job = await repo.createAutoWashJob({
    customer_id,
    scheduled_at: new Date(scheduled_at),
    location_lat,
    location_lng,
    location_address: location_address.trim(),
    notes,
    vehicle_id,
    service_package: package_code,
    addons_booked: addon_codes,
    gated_community,
    base_price_paise:   quote.items.filter(i => i.kind === 'package').reduce((s, i) => s + i.price_paise, 0),
    addons_price_paise: quote.items.filter(i => i.kind === 'addon').reduce((s, i) => s + i.price_paise, 0),
    total_price_paise:  quote.total_paise,
  });

  // v1: auto-wash is COD-only — Razorpay integration deferred to v1.1.
  // Booking is held at status='scheduled' awaiting crew assignment + on-site payment.
  // Fire booking_confirmed notification stub (logs only until Wati templates are live).
  _safeLookupCustomer(customer_id).then((customer) => {
    if (!customer?.phone) return;
    const pkgName = quote.items.find(i => i.kind === 'package')?.name || package_code;
    NotificationService.autoWashBookingConfirmed(
      customer.phone, customer.name || 'Customer',
      job.id, job.scheduled_at, pkgName,
    ).catch(() => {});
  });

  // Fire-and-forget conflict detection so admin gets a banner when this
  // auto-wash booking creates a slot collision or no team is available.
  try {
    const AdminAlertsService = require('../admin-alerts/admin-alerts.service');
    AdminAlertsService.detectBookingConflicts({
      jobId: job.id,
      slotTime: job.scheduled_at,
    }).catch((e) => { console.warn('[alerts] auto-wash conflict detect failed:', e?.message); });

    // Info-level new-booking alert so admin sees auto-wash activity too.
    _safeLookupCustomer(customer_id).then((cust) => {
      AdminAlertsService.recordNewBooking({
        jobId: job.id,
        kind: 'auto_wash',
        customerName: cust?.name,
        slotTime: job.scheduled_at,
        summary: `${vehicle?.vehicle_type || 'vehicle'} ${vehicle?.registration_number || ''} · ${package_code}`,
      }).catch(() => {});
    });
  } catch (_) {}

  // ── Additional stops (extra vehicles at other locations) ──────────────
  //
  // Each entry creates its own job with the same package, addons, scheduled
  // slot and subscription as the primary stop. We re-quote per stop because
  // the vehicle type can differ (which changes pricing).
  const additionalJobs = [];
  for (const s of additional_stops) {
    const stopVehicle = await repo.findVehicleById(s.vehicle_id, customer_id);
    const stopQuote = await quotePrice({
      vehicle_type: stopVehicle.vehicle_type,
      package_code,
      addon_codes,
      subscription_code,
    });
    const stopJob = await repo.createAutoWashJob({
      customer_id,
      scheduled_at: new Date(scheduled_at),
      location_lat: s.location_lat ?? null,
      location_lng: s.location_lng ?? null,
      location_address: s.location_address.trim(),
      notes,
      vehicle_id: s.vehicle_id,
      service_package: package_code,
      addons_booked: addon_codes,
      gated_community: !!s.gated_community,
      base_price_paise:   stopQuote.items.filter(i => i.kind === 'package').reduce((sum, i) => sum + i.price_paise, 0),
      addons_price_paise: stopQuote.items.filter(i => i.kind === 'addon').reduce((sum, i) => sum + i.price_paise, 0),
      total_price_paise:  stopQuote.total_paise,
    });
    additionalJobs.push({ job: stopJob, quote: stopQuote });

    // Same alert + notification fan-out per stop. Each stop is a real job.
    try {
      const AdminAlertsService = require('../admin-alerts/admin-alerts.service');
      AdminAlertsService.detectBookingConflicts({ jobId: stopJob.id, slotTime: stopJob.scheduled_at }).catch(() => {});
      _safeLookupCustomer(customer_id).then((cust) => {
        AdminAlertsService.recordNewBooking({
          jobId: stopJob.id, kind: 'auto_wash',
          customerName: cust?.name, slotTime: stopJob.scheduled_at,
          summary: `${stopVehicle.vehicle_type} ${stopVehicle.registration_number || ''} · ${package_code} (extra stop)`,
        }).catch(() => {});
      });
    } catch (_) {}
  }

  // Combined total across all stops so the client can show a single grand total.
  const grandTotal = quote.total_paise + additionalJobs.reduce((s, a) => s + a.quote.total_paise, 0);

  return {
    job,
    quote,
    additional_jobs: additionalJobs.map((a) => a.job),
    stops_count: 1 + additionalJobs.length,
    grand_total_paise: grandTotal,
  };
}

async function getBookingById(customer_id, jobId) {
  const job = await repo.findAutoWashJobById(jobId);
  if (!job || job.customer_id !== customer_id) {
    throw { status: 404, message: 'Booking not found.' };
  }
  const steps = await repo.listStepsForJob(jobId);
  return { job, steps };
}

async function listBookingHistory(customer_id, { limit, offset } = {}) {
  return repo.listAutoWashJobsForCustomer(customer_id, { limit, offset });
}

/* ── Crew flow ──────────────────────────────────────────────────────────── */

async function uploadPreInspection(crewId, jobId, photoUrls) {
  const job = await repo.findAutoWashJobById(jobId);
  if (!job) throw { status: 404, message: 'Job not found.' };
  if (job.assigned_team_id !== crewId) throw { status: 403, message: 'Job not assigned to you.' };
  if (!Array.isArray(photoUrls) || photoUrls.length < 5) {
    // Minimum 5 photos per PDF Section 4.2: front, rear, left, right, dents
    throw { status: 400, message: 'At least 5 pre-inspection photos required.' };
  }
  await repo.setPreInspectionPhotos(jobId, photoUrls);
  await repo.setJobInProgress(jobId);
  return { ok: true, photos_uploaded: photoUrls.length };
}

async function startStep(crewId, jobId, stepNumber) {
  const job = await repo.findAutoWashJobById(jobId);
  if (!job) throw { status: 404, message: 'Job not found.' };
  if (job.assigned_team_id !== crewId) throw { status: 403, message: 'Job not assigned to you.' };

  const stepMeta = SERVICE_STEPS_CORE.find(s => s.n === stepNumber);
  if (!stepMeta) throw { status: 400, message: 'Invalid core step number (1-6).' };

  await repo.setJobInProgress(jobId);
  const row = await repo.startStep({
    job_id: jobId,
    step_number: stepNumber,
    step_name: stepMeta.name,
    step_type: 'core',
  });

  // Notify customer on each step start (especially the safety-critical fogging step).
  NotificationService.notifyUser(
    { id: job.customer_id },
    stepNumber === 6 ? '🌫️ Cabin fogging started' : `🚗 ${stepMeta.name} started`,
    `Wash step ${stepNumber} of 6 is underway on your vehicle.`,
    { job_id: jobId, type: 'wash_step', step: String(stepNumber) },
  ).catch(() => {});
  _safeLookupCustomer(job.customer_id).then((customer) => {
    if (!customer?.phone) return;
    if (stepNumber === 6) {
      NotificationService.autoWashFoggingStarted(customer.phone, jobId).catch(() => {});
    } else {
      NotificationService.autoWashStepStarted(customer.phone, jobId, stepNumber, stepMeta.label || stepMeta.name).catch(() => {});
    }
  });

  return row;
}

async function endStep(crewId, jobId, stepNumber, body) {
  const job = await repo.findAutoWashJobById(jobId);
  if (!job) throw { status: 404, message: 'Job not found.' };
  if (job.assigned_team_id !== crewId) throw { status: 403, message: 'Job not assigned to you.' };

  // Step-specific validation
  if (stepNumber === 3) {
    // Ozone Rinse: ozone ppm 0.05-0.2 expected
    const ppm = Number(body.ozone_ppm);
    if (!Number.isFinite(ppm) || ppm < 0 || ppm > 5) {
      throw { status: 400, message: 'ozone_ppm must be a valid reading.' };
    }
  }
  if (stepNumber === 6) {
    // Ozone Cabin Fogging: must run ≥ 8 minutes
    const dur = Number(body.fogging_duration_min);
    if (!Number.isFinite(dur) || dur < MIN_FOGGING_DURATION_MIN) {
      throw {
        status: 400,
        message: `Cabin fogging must run ≥ ${MIN_FOGGING_DURATION_MIN} minutes before marking complete.`,
      };
    }
    if (body.windows_closed !== true) {
      throw { status: 400, message: 'Confirm all windows closed before marking fogging complete.' };
    }
  }

  const row = await repo.endStep({
    job_id: jobId,
    step_number: stepNumber,
    photo_urls: body.photo_urls,
    ozone_ppm: body.ozone_ppm,
    notes: body.notes,
    passed_validation: true,
  });

  NotificationService.notifyUser(
    { id: job.customer_id },
    `✅ Wash step ${stepNumber} of 6 complete`,
    'Track live progress in your booking.',
    { job_id: jobId, type: 'wash_step', step: String(stepNumber) },
  ).catch(() => {});

  return row;
}

async function completeJob(crewId, jobId, body) {
  const job = await repo.findAutoWashJobById(jobId);
  if (!job) throw { status: 404, message: 'Job not found.' };
  if (job.assigned_team_id !== crewId) throw { status: 403, message: 'Job not assigned to you.' };
  if (job.status === 'completed') throw { status: 400, message: 'Job already completed.' };

  // Validate all 6 core steps are ended.
  const steps = await repo.listStepsForJob(jobId);
  const completedCoreSteps = steps.filter(s => s.step_type === 'core' && s.ended_at).length;
  if (completedCoreSteps < SERVICE_STEPS_CORE.length) {
    throw {
      status: 400,
      message: `Cannot complete: only ${completedCoreSteps}/${SERVICE_STEPS_CORE.length} core steps ended.`,
    };
  }

  // Pull aggregated readings
  const ozoneRinse = steps.find(s => s.step_number === 3);
  const fogging    = steps.find(s => s.step_number === 6);
  const water_used = Number(body.water_used_litres);
  if (!Number.isFinite(water_used) || water_used <= 0) {
    throw { status: 400, message: 'water_used_litres is required to complete the job.' };
  }
  const water_saved = Math.max(0, CONVENTIONAL_WATER_LITRES - water_used);
  const ppe_full = body.ppe_full !== false;          // crew confirms via checkbox
  const zero_chemicals = body.zero_chemicals !== false;

  const eco_score = calculateEcoScore({
    water_used_litres: water_used,
    ozone_ppm_exterior: ozoneRinse?.ozone_ppm,
    fogging_duration_min: body.fogging_duration_min ?? null,
    ppe_full,
    zero_chemicals,
  });
  const eco_badge = badgeForScore(eco_score);

  await repo.completeJobWithReadings(jobId, {
    ozone_ppm_reading: ozoneRinse?.ozone_ppm,
    fogging_ppm_reading: fogging?.ozone_ppm,
    fogging_duration_min: body.fogging_duration_min ?? null,
    water_used_litres: water_used,
    water_saved_litres: water_saved,
    addons_completed: body.addons_completed || job.addons_booked || [],
  });

  // Auto-generate certificate
  const validUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
  const cert = await repo.createCertificate({
    job_id: jobId,
    vehicle_id: job.vehicle_id,
    service_package: job.service_package,
    addons_included: body.addons_completed || job.addons_booked || [],
    ozone_ppm_exterior: ozoneRinse?.ozone_ppm,
    ozone_ppm_cabin: fogging?.ozone_ppm,
    fogging_duration_min: body.fogging_duration_min ?? null,
    water_used_litres: water_used,
    water_saved_litres: water_saved,
    eco_score,
    eco_badge,
    crew_id: crewId,
    ev_unit_id: job.ev_unit_id || null,
    qr_token: generateQrToken(),
    certificate_pdf_url: null,                              // populated by certificate-generation job
    valid_until: istDateKey(validUntil),  // IST calendar date shown on the cert / QR
  });

  // Render + upload the certificate PDF, then persist the URL. Failures are
  // swallowed so a transient R2 hiccup doesn't block job completion — the
  // cert row is still issued and a cron can retry PDF rendering later.
  const customer = await _safeLookupCustomer(job.customer_id);
  (async () => {
    try {
      const uploaded = await generateAndUploadCertPDF({
        cert,
        job,
        customer_name: customer?.name || 'Customer',
        crew_name: null,                              // populated below if lookup succeeds
        ev_unit_code: null,
      });
      if (uploaded?.url) {
        await repo.updateCertificatePdfUrl(cert.id, uploaded.url);
        cert.certificate_pdf_url = uploaded.url;
      }
    } catch (e) {
      console.error('[auto-wash] PDF generation failed for cert', cert.id, '—', e.message);
    }
  })();

  // Fire job-complete notification (stub today, real Wati once templates registered).
  if (customer?.phone) {
    NotificationService.autoWashJobComplete(
      customer.phone, customer.name || 'Customer',
      jobId, eco_score, eco_badge, water_saved,
    ).catch(() => {});
  }

  return { eco_score, eco_badge, water_saved_litres: water_saved, certificate: cert };
}

/* ── Public certificate verification ────────────────────────────────────── */

async function verifyCertificate(qrToken) {
  const cert = await repo.findCertificateByQrToken(qrToken);
  if (!cert) throw { status: 404, message: 'Certificate not found or revoked.' };
  return {
    job_id: cert.job_id,
    service_package: cert.service_package,
    eco_score: cert.eco_score,
    eco_badge: cert.eco_badge,
    ozone_ppm_exterior: cert.ozone_ppm_exterior,
    ozone_ppm_cabin: cert.ozone_ppm_cabin,
    fogging_duration_min: cert.fogging_duration_min,
    water_used_litres: cert.water_used_litres,
    water_saved_litres: cert.water_saved_litres,
    valid_until: cert.valid_until,
    generated_at: cert.generated_at,
    vehicle: {
      type: cert.v_type,
      // Privacy: show only last 4 chars of reg
      reg_last4: cert.v_reg ? String(cert.v_reg).slice(-4) : null,
    },
    crew_name: cert.crew_name,
    ev_unit_code: cert.ev_unit_code,
  };
}

/* ── Subscriptions ──────────────────────────────────────────────────────── */

async function createSubscription(customerId, { plan_type, vehicle_ids }) {
  const plan = await repo.getSubscriptionPlan(plan_type);
  if (!plan) throw { status: 404, message: 'Subscription plan not found.' };

  const existing = await repo.getActiveSubscription(customerId);
  if (existing) throw { status: 409, message: 'You already have an active subscription. Cancel it first.' };

  // For now, use hatchback pricing — Sprint 4 will pick correct vehicle tier.
  const price = plan.price_hatchback_paise;
  if (price === 0 && plan_type !== 'fleet' && plan_type !== 'family') {
    throw { status: 400, message: 'This plan requires sales contact.' };
  }

  const nextBilling = new Date(Date.now() + plan.cycle_days * 24 * 60 * 60 * 1000);

  return repo.createSubscription({
    customer_id: customerId,
    plan_type,
    vehicle_ids: vehicle_ids || [],
    washes_per_cycle: plan.washes_per_cycle,
    price_per_cycle_paise: price,
    next_billing_date: istDateKey(nextBilling),  // IST calendar date the next charge is due
    addon_discount_pct: plan.addon_discount_pct,
  });
}

async function getActiveSubscription(customerId) {
  return repo.getActiveSubscription(customerId);
}

async function pauseSubscription(customerId, id, pauseUntil) {
  const row = await repo.pauseSubscription(id, customerId, pauseUntil);
  if (!row) throw { status: 404, message: 'Active subscription not found.' };
  return row;
}

async function cancelSubscription(customerId, id) {
  const row = await repo.cancelSubscription(id, customerId);
  if (!row) throw { status: 404, message: 'Subscription not found or already cancelled.' };
  return row;
}

/* ── Crew job list ──────────────────────────────────────────────────────── */

async function listJobsForCrewToday(crewId) {
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const endOfDay   = new Date(); endOfDay.setHours(23, 59, 59, 999);
  return repo.listAutoWashJobsForCrew(crewId, { fromDate: startOfDay, toDate: endOfDay });
}

/* ── Admin ──────────────────────────────────────────────────────────────── */

async function listEvUnits() {
  return repo.listEvUnits();
}

async function adminDashboard() {
  const [today, mrr] = await Promise.all([
    repo.adminDashboardToday(),
    repo.adminSubscriptionMRR(),
  ]);
  return {
    today: {
      completed: Number(today.completed),
      in_progress: Number(today.in_progress),
      scheduled: Number(today.scheduled),
      revenue_paise: Number(today.revenue_paise),
      water_saved_litres: Number(today.water_saved_litres),
      avg_ticket_paise: Number(today.avg_ticket_paise),
      addon_conversion_pct: today.addon_conversion_pct == null ? 0 : Number(today.addon_conversion_pct).toFixed(1),
    },
    subscriptions: {
      active_count: Number(mrr.active_count),
      mrr_paise: Number(mrr.mrr_paise),
    },
  };
}

async function adminListJobs(filters) {
  return repo.adminListJobs(filters);
}

async function adminAssignJob(jobId, crewId, evUnitId, opts = {}) {
  // Run the SAME crew guard as tank jobs — a physical crew can only be in one
  // place at a time, and tank + auto-wash jobs share assigned_team_id, so an
  // auto-wash assign must not double-book a crew already on an overlapping job
  // (or one marked leave/sick/off). crewOverlap is resource-agnostic, so it
  // catches tank↔auto-wash clashes too. opts.force overrides (409 otherwise).
  const existing = await repo.findAutoWashJobById(jobId);
  if (!existing) throw { status: 404, message: 'Auto-wash job not found.' };
  const JobService = require('../jobs/job.service');
  const row = await JobService._guardedAssign(
    { id: jobId, scheduled_at: existing.scheduled_at, duration_min: existing.duration_min },
    crewId, opts,
    () => repo.adminAssignJobToCrew(jobId, crewId, evUnitId)
  );
  if (!row) throw { status: 404, message: 'Auto-wash job not found.' };

  // Notify customer that a crew has been assigned (stub — Wati TODO).
  const job = await repo.findAutoWashJobById(jobId);
  if (job?.customer_id) {
    Promise.all([
      _safeLookupCustomer(job.customer_id),
      _safeLookupCustomer(crewId),
    ]).then(([customer, crew]) => {
      if (!customer?.phone) return;
      NotificationService.autoWashCrewAssigned(
        customer.phone, crew?.name || 'Your crew', jobId,
      ).catch(() => {});
    });
  }

  return row;
}

async function adminAddonAnalytics({ fromDate } = {}) {
  return repo.adminAddonAnalytics({ fromDate });
}

module.exports = {
  // catalog
  getPackages,
  getAddons,
  getSubscriptionPlans,
  quotePrice,
  // vehicles
  addVehicle,
  listVehicles,
  updateVehicle,
  deleteVehicle,
  // bookings
  createBooking,
  getBookingById,
  listBookingHistory,
  // crew
  uploadPreInspection,
  startStep,
  endStep,
  completeJob,
  listJobsForCrewToday,
  // certificates
  verifyCertificate,
  // subscriptions
  createSubscription,
  getActiveSubscription,
  pauseSubscription,
  cancelSubscription,
  // admin
  listEvUnits,
  adminDashboard,
  adminListJobs,
  adminAssignJob,
  adminAddonAnalytics,

  // exposed for testing
  _calculateEcoScore: calculateEcoScore,
  _badgeForScore: badgeForScore,
  SERVICE_STEPS_CORE,
  VEHICLE_TYPES,
};
