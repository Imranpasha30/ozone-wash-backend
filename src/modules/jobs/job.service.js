const JobRepository = require('./job.repository');
const RouteService = require('../../services/route.service');
const crypto = require('crypto');
const db = require('../../config/db');

const generateOtp = () => {
  return crypto.randomInt(100000, 999999).toString();
};

const MAX_OTP_ATTEMPTS = 5;       // spec G-2 / G-11
const GEOFENCE_METERS = 200;      // spec G-1

// Haversine distance in meters
const distanceM = (lat1, lng1, lat2, lng2) => {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};

// Append-only OTP audit (spec §13 — immutable trail of OTP events).
const logOtpEvent = (jobId, agentId, kind, event, detail = null) => {
  db.query(
    `INSERT INTO otp_events (job_id, agent_id, otp_kind, event, detail) VALUES ($1,$2,$3,$4,$5)`,
    [jobId, agentId, kind, event, detail]
  ).catch(() => {});
};

// Gate G-0: today's van check must be complete before any job action.
// Tank-cleaning jobs only — auto-wash has its own flow.
const assertVanCheck = async (agentId, job) => {
  if (job.job_type && job.job_type !== 'tank_cleaning') return;
  const FieldOpsService = require('../field-ops/field-ops.service');
  const ok = await FieldOpsService.isVanCheckComplete(agentId);
  if (!ok) {
    throw { status: 423, message: 'Complete van check before starting jobs. (Gate G-0)' };
  }
};

const JobService = {

  // Get all jobs (admin)
  getAllJobs: async (filters) => {
    return await JobRepository.findAll(filters);
  },

  // Get today's jobs for field team
  getMyJobs: async (teamId) => {
    return await JobRepository.findByTeam(teamId);
  },

  // Get single job details
  getJob: async (jobId, userId, userRole) => {
    const job = await JobRepository.findById(jobId);
    if (!job) {
      throw { status: 404, message: 'Job not found.' };
    }

    // Field team can only see their own assigned jobs
    if (userRole === 'field_team' && job.assigned_team_id !== userId) {
      throw { status: 403, message: 'Access denied.' };
    }

    // Customer can only see their own jobs
    if (userRole === 'customer' && job.customer_id !== userId) {
      throw { status: 403, message: 'Access denied.' };
    }

    return job;
  },

  // Assign field team to a job (admin only). Blocks double-booking one crew into
  // overlapping jobs; pass opts.force=true to override deliberately.
  assignTeam: async (jobId, teamId, opts = {}) => {
    // Check job exists
    const job = await JobRepository.findById(jobId);
    if (!job) {
      throw { status: 404, message: 'Job not found.' };
    }

    if (job.status === 'cancelled') {
      throw { status: 400, message: 'Cannot assign team to a cancelled job.' };
    }

    if (job.status === 'completed') {
      throw { status: 400, message: 'Cannot assign team to a completed job.' };
    }

    // Conflict guard: prevent putting one crew on two OVERLAPPING jobs. Serialize
    // per crew+date with an advisory lock so two concurrent assigns can't both
    // pass the check. Default is BLOCK (409); opts.force is an explicit override.
    if (teamId && !opts.force) {
      const SchedulingService = require('../../services/scheduling.service');
      const dateKey = String(job.scheduled_at).slice(0, 10);
      const release = await SchedulingService.acquireSlotLock(`crew:${teamId}:${dateKey}`);
      try {
        const clash = await SchedulingService.crewOverlap(teamId, job.scheduled_at, job.duration_min, jobId);
        if (clash) {
          const when = new Date(clash.scheduled_at).toLocaleString('en-IN', {
            day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true,
          });
          throw { status: 409, message: `That crew already has an overlapping job on ${when}. Reassign that first, or override.` };
        }
        return await JobRepository.assignTeam(jobId, teamId);
      } finally {
        await release();
      }
    }

    // No team (unassign) or explicit override → assign directly.
    const updated = await JobRepository.assignTeam(jobId, teamId);
    return updated;
  },

  // Start a job (field team)
  startJob: async (jobId, teamId) => {
    const job = await JobRepository.findById(jobId);
    if (!job) {
      throw { status: 404, message: 'Job not found.' };
    }

    if (job.assigned_team_id !== teamId) {
      throw { status: 403, message: 'This job is not assigned to you.' };
    }

    if (job.status !== 'scheduled') {
      throw { status: 400, message: `Cannot start a job with status: ${job.status}` };
    }

    await assertVanCheck(teamId, job);

    const updated = await JobRepository.updateStatus(jobId, 'in_progress');
    if (job.booking_id) {
      await db.query(
        `UPDATE bookings SET status = 'in_progress', updated_at = NOW() WHERE id = $1`,
        [job.booking_id]
      ).catch(() => {});
    }
    return updated;
  },

  // Crew tapped Navigate — log departure (spec step 1.1)
  markEnRoute: async (jobId, teamId) => {
    const job = await JobRepository.findById(jobId);
    if (!job) throw { status: 404, message: 'Job not found.' };
    if (job.assigned_team_id !== teamId) throw { status: 403, message: 'This job is not assigned to you.' };
    if (job.status !== 'scheduled') throw { status: 400, message: `Cannot mark en-route with status: ${job.status}` };
    await assertVanCheck(teamId, job);
    // Keep today's departure if already logged; a stale one from a previous
    // day is overwritten — each shift starts fresh (matches daily G-0).
    const { rows } = await db.query(
      `UPDATE jobs
          SET departure_time = CASE
                WHEN departure_time::date = CURRENT_DATE THEN departure_time
                ELSE NOW()
              END,
              updated_at = NOW()
        WHERE id = $1 RETURNING id, departure_time`,
      [jobId]
    );
    return rows[0];
  },

  // Complete a job — HARD gate G-11: customer's end OTP must be verified.
  completeJob: async (jobId) => {
    const job = await JobRepository.findById(jobId);
    if (!job) {
      throw { status: 404, message: 'Job not found.' };
    }

    if (job.status !== 'in_progress') {
      throw { status: 400, message: 'Job must be in progress to complete.' };
    }

    if (job.job_type === 'tank_cleaning' && !job.end_otp_verified) {
      throw { status: 423, message: 'Customer end OTP not verified. Verify the stop OTP before closing the job. (Gate G-11)' };
    }

    const updated = await JobRepository.updateStatus(jobId, 'completed');

    // Keep the customer-facing booking in sync — its status timeline reads
    // bookings.status, not the job row.
    if (job.booking_id) {
      await db.query(
        `UPDATE bookings SET status = 'completed', updated_at = NOW() WHERE id = $1`,
        [job.booking_id]
      ).catch(() => {});
    }

    // Auto-schedule (spec 6.4): recleaning reminder 7 days before the 90-day
    // certificate expiry (+83d) and a day-3 AMC upsell for non-AMC customers.
    if (job.job_type === 'tank_cleaning' && job.customer_id) {
      (async () => {
        try {
          await db.query(
            `INSERT INTO scheduled_notifications (type, customer_id, job_id, due_date, payload)
             VALUES ('recleaning_reminder', $1, $2, CURRENT_DATE + 83, $3::jsonb)`,
            [job.customer_id, jobId, JSON.stringify({ phone: job.customer_phone })]
          );
          const { rows: amc } = await db.query(
            `SELECT id FROM amc_contracts WHERE customer_id = $1 AND status = 'active' LIMIT 1`,
            [job.customer_id]
          );
          if (!amc.length) {
            await db.query(
              `INSERT INTO scheduled_notifications (type, customer_id, job_id, due_date, payload)
               VALUES ('amc_upsell', $1, $2, CURRENT_DATE + 3, $3::jsonb)`,
              [job.customer_id, jobId, JSON.stringify({ phone: job.customer_phone })]
            );
          }
        } catch (e) { console.warn('[jobs] reminder scheduling failed:', e?.message); }
      })();
    }

    return updated;
  },

  // ── OTP Methods ──────────────────────────────────────────────────────────

  // Generate start OTP and notify customer. Gate G-0: van check first.
  generateStartOtp: async (jobId, teamId) => {
    const job = await JobRepository.findById(jobId);
    if (!job) throw { status: 404, message: 'Job not found.' };
    if (job.assigned_team_id !== teamId) throw { status: 403, message: 'This job is not assigned to you.' };
    if (job.status !== 'scheduled') throw { status: 400, message: `Cannot generate start OTP for a job with status: ${job.status}` };

    await assertVanCheck(teamId, job);

    // Reuse existing OTP if already generated and not yet verified — prevents overwrite race condition
    if (job.start_otp && !job.start_otp_verified) {
      return { job_id: jobId, otp_sent: true };
    }

    const otp = generateOtp();
    await JobRepository.storeStartOtp(jobId, otp);
    logOtpEvent(jobId, teamId, 'start', 'generated');
    return { job_id: jobId, otp_sent: true };
  },

  // Verify start OTP entered by agent.
  // Gates: G-0 van check · G-1 geofence (200m) · G-2 max 5 attempts.
  // extras: { gps_lat, gps_lng, arrival_photo_url } — arrival photo (step 1.3)
  // is mandatory for tank-cleaning jobs.
  verifyStartOtp: async (jobId, teamId, otp, gps = {}) => {
    const job = await JobRepository.findById(jobId);
    if (!job) throw { status: 404, message: 'Job not found.' };
    if (job.assigned_team_id !== teamId) throw { status: 403, message: 'This job is not assigned to you.' };
    if (job.status !== 'scheduled') throw { status: 400, message: `Cannot verify start OTP for a job with status: ${job.status}` };
    if (!job.start_otp) throw { status: 400, message: 'Start OTP has not been generated yet.' };

    await assertVanCheck(teamId, job);

    // G-2: attempt limiting
    if (Number(job.start_otp_attempts) >= MAX_OTP_ATTEMPTS) {
      logOtpEvent(jobId, teamId, 'start', 'locked');
      throw { status: 429, message: 'Maximum OTP attempts reached. Ask the customer to regenerate the OTP or contact admin.' };
    }

    // Arrival photo (step 1.3) — live-camera proof required at the site
    if (job.job_type === 'tank_cleaning' && !gps.arrival_photo_url && !job.arrival_photo_url) {
      throw { status: 400, message: 'Arrival photo required — capture the van + building before verifying the OTP.' };
    }

    // G-1: geofence — multi-location aware. A booking's tanks may sit at
    // DIFFERENT addresses; the crew may legitimately start at any of them,
    // so verification passes if the agent is within 200 m of ANY tank
    // location (primary site + every per-tank coordinate).
    const agentLat = Number(gps.gps_lat), agentLng = Number(gps.gps_lng);
    const sites = [];
    if (Number.isFinite(Number(job.location_lat)) && Number.isFinite(Number(job.location_lng))) {
      sites.push([Number(job.location_lat), Number(job.location_lng)]);
    }
    if (job.job_type === 'tank_cleaning' && job.booking_id) {
      try {
        const BookingRepository = require('../bookings/booking.repository');
        const bk = await BookingRepository.findById(job.booking_id);
        const tanks = Array.isArray(bk?.tanks) ? bk.tanks : [];
        for (const t of tanks) {
          if (Number.isFinite(Number(t?.lat)) && Number.isFinite(Number(t?.lng))) {
            sites.push([Number(t.lat), Number(t.lng)]);
          }
        }
      } catch (_) { /* geofence falls back to the primary site */ }
    }
    // DEV ONLY: GEOFENCE_BYPASS=true skips G-1 so the flow is testable away
    // from the real site. Must NOT be set in the production .env.
    const geofenceBypassed = process.env.GEOFENCE_BYPASS === 'true';
    if (geofenceBypassed) {
      console.warn(`⚠️ [G-1 BYPASSED] Geofence skipped for job ${jobId} (GEOFENCE_BYPASS=true — dev only)`);
    }
    if (!geofenceBypassed && job.job_type === 'tank_cleaning' && sites.length) {
      if (!Number.isFinite(agentLat) || !Number.isFinite(agentLng)) {
        throw { status: 400, message: 'GPS location required to verify the start OTP at the job site.' };
      }
      const nearest = Math.min(...sites.map(([la, ln]) => distanceM(la, ln, agentLat, agentLng)));
      if (nearest > GEOFENCE_METERS) {
        throw { status: 423, message: `You are not at any of this booking's tank locations (nearest ${Math.round(nearest)} m away, limit ${GEOFENCE_METERS} m). Move closer and retry. (Gate G-1)` };
      }
    }

    if (job.start_otp !== otp) {
      await db.query(`UPDATE jobs SET start_otp_attempts = start_otp_attempts + 1, updated_at = NOW() WHERE id = $1`, [jobId]);
      logOtpEvent(jobId, teamId, 'start', 'verify_fail');
      const left = MAX_OTP_ATTEMPTS - Number(job.start_otp_attempts) - 1;
      throw { status: 400, message: `Invalid OTP. ${Math.max(0, left)} attempt(s) remaining.` };
    }

    const updated = await JobRepository.verifyStartOtp(jobId);
    if (job.booking_id) {
      await db.query(
        `UPDATE bookings SET status = 'in_progress', updated_at = NOW() WHERE id = $1`,
        [job.booking_id]
      ).catch(() => {});
    }
    // Log arrival (geofenced + photo) + reset the attempt counter
    await db.query(
      `UPDATE jobs SET arrived_at = COALESCE(arrived_at, NOW()),
              arrival_gps_lat = COALESCE($2, arrival_gps_lat),
              arrival_gps_lng = COALESCE($3, arrival_gps_lng),
              arrival_photo_url = COALESCE($4, arrival_photo_url),
              start_otp_attempts = 0, updated_at = NOW()
        WHERE id = $1`,
      [jobId, Number.isFinite(agentLat) ? agentLat : null, Number.isFinite(agentLng) ? agentLng : null,
       gps.arrival_photo_url || null]
    );
    logOtpEvent(jobId, teamId, 'start', 'verify_ok');
    return updated;
  },

  // Generate end OTPs (satisfied + unsatisfied).
  // Gates G-9/G-10: all compliance phases + after-readings + final O₃ safe.
  generateEndOtp: async (jobId, teamId) => {
    const job = await JobRepository.findById(jobId);
    if (!job) throw { status: 404, message: 'Job not found.' };
    if (job.assigned_team_id !== teamId) throw { status: 403, message: 'This job is not assigned to you.' };
    if (job.status !== 'in_progress') throw { status: 400, message: 'Job must be in progress to generate end OTP.' };

    if (job.job_type === 'tank_cleaning') {
      // G-9a: all 9 compliance phases complete
      const ComplianceRepository = require('../compliance/compliance.repository');
      const allComplete = await ComplianceRepository.areAllStepsComplete(jobId);
      if (!allComplete) {
        throw { status: 423, message: 'All compliance phases must be complete before the stop OTP. (Gate G-9)' };
      }
      // G-9b: all 5 after-readings recorded
      const FieldOpsService = require('../field-ops/field-ops.service');
      const after = await FieldOpsService.afterReadingsComplete(jobId);
      if (!after.complete) {
        throw { status: 423, message: `After-readings incomplete: ${after.missing.join(', ')}. Record all 5 readings first. (Gate G-9)` };
      }
      // G-10: final dissolved O₃ must be < 0.05 mg/L
      if (job.o3_final_safe !== true) {
        throw { status: 423, message: 'Final dissolved O₃ reading missing or unsafe (must be <0.05 mg/L). Not safe for consumption yet. (Gate G-10)', retry_after_minutes: 10 };
      }
    }

    // Generate two unique OTPs — one for satisfied, one for unsatisfied
    const satisfiedOtp = generateOtp();
    let unsatisfiedOtp = generateOtp();
    while (unsatisfiedOtp === satisfiedOtp) {
      unsatisfiedOtp = generateOtp();
    }

    await JobRepository.storeEndOtp(jobId, satisfiedOtp, unsatisfiedOtp);
    logOtpEvent(jobId, teamId, 'end', 'generated');
    return { job_id: jobId, otp_sent: true };
  },

  // Verify end OTP entered by agent — determines customer satisfaction.
  // Gate G-11: max 5 attempts.
  verifyEndOtp: async (jobId, teamId, otp) => {
    const job = await JobRepository.findById(jobId);
    if (!job) throw { status: 404, message: 'Job not found.' };
    if (job.assigned_team_id !== teamId) throw { status: 403, message: 'This job is not assigned to you.' };
    if (job.status !== 'in_progress') throw { status: 400, message: 'Job must be in progress to verify end OTP.' };
    if (!job.end_otp_satisfied && !job.end_otp_unsatisfied) throw { status: 400, message: 'End OTP has not been generated yet.' };

    if (Number(job.end_otp_attempts) >= MAX_OTP_ATTEMPTS) {
      logOtpEvent(jobId, teamId, 'end', 'locked');
      throw { status: 429, message: 'Maximum OTP attempts reached. Regenerate the end OTP or contact admin.' };
    }

    // Check which OTP was entered
    let satisfied = null;
    if (job.end_otp_satisfied && otp === job.end_otp_satisfied) {
      satisfied = true;
    } else if (job.end_otp_unsatisfied && otp === job.end_otp_unsatisfied) {
      satisfied = false;
    } else {
      await db.query(`UPDATE jobs SET end_otp_attempts = end_otp_attempts + 1, updated_at = NOW() WHERE id = $1`, [jobId]);
      logOtpEvent(jobId, teamId, 'end', 'verify_fail');
      const left = MAX_OTP_ATTEMPTS - Number(job.end_otp_attempts) - 1;
      throw { status: 400, message: `Invalid OTP. ${Math.max(0, left)} attempt(s) remaining.` };
    }

    const updated = await JobRepository.verifyEndOtp(jobId, satisfied);
    await db.query(`UPDATE jobs SET end_otp_attempts = 0, updated_at = NOW() WHERE id = $1`, [jobId]);
    logOtpEvent(jobId, teamId, 'end', 'verify_ok', satisfied ? 'satisfied' : 'unsatisfied');
    return { ...updated, customer_satisfied: satisfied };
  },

  // Customer requests start OTP generation (when technician is present)
  customerRequestStartOtp: async (jobId, customerId) => {
    const job = await JobRepository.findById(jobId);
    if (!job) throw { status: 404, message: 'Job not found.' };
    if (job.customer_id !== customerId) throw { status: 403, message: 'Access denied.' };
    if (!job.assigned_team_id) throw { status: 400, message: 'No technician assigned yet.' };
    if (job.status !== 'scheduled') throw { status: 400, message: `Cannot generate OTP for a job with status: ${job.status}` };

    // Reuse existing OTP if already generated and not yet verified — prevents overwrite race condition
    if (job.start_otp && !job.start_otp_verified) {
      return { job_id: jobId, otp: job.start_otp };
    }

    const otp = generateOtp();
    await JobRepository.storeStartOtp(jobId, otp);
    return { job_id: jobId, otp };
  },

  // ── Transfer ────────────────────────────────────────────────────────────

  transferJob: async (jobId, newTeamId, reason, userId, userRole) => {
    const job = await JobRepository.findById(jobId);
    if (!job) throw { status: 404, message: 'Job not found.' };

    // Field team can only transfer their own jobs
    if (userRole === 'field_team' && job.assigned_team_id !== userId) {
      throw { status: 403, message: 'This job is not assigned to you.' };
    }

    if (job.status === 'completed' || job.status === 'cancelled') {
      throw { status: 400, message: `Cannot transfer a ${job.status} job.` };
    }

    if (job.assigned_team_id === newTeamId) {
      throw { status: 400, message: 'Job is already assigned to this team member.' };
    }

    const updated = await JobRepository.transferJob(jobId, newTeamId, reason);
    return updated;
  },

  // Get list of all field team members (admin — for assignment dropdown)
  getTeamList: async () => {
    return await JobRepository.getTeamList();
  },

  // Get today's stats (admin dashboard)
  getTodayStats: async (teamId = null) => {
    return await JobRepository.getTodayStats(teamId);
  },

  // ── Available Jobs & Requests ─────────────────────────────────────────

  // Get unassigned scheduled jobs (field team can browse)
  getAvailableJobs: async () => {
    return await JobRepository.findAvailable();
  },

  // Field team requests a job
  requestJob: async (jobId, teamId) => {
    const job = await JobRepository.findById(jobId);
    if (!job) throw { status: 404, message: 'Job not found.' };
    if (job.assigned_team_id) throw { status: 400, message: 'This job is already assigned.' };
    if (job.status !== 'scheduled') throw { status: 400, message: 'Only scheduled jobs can be requested.' };

    // Check for duplicate pending request
    const existing = await JobRepository.findRequestByJobAndTeam(jobId, teamId);
    if (existing) throw { status: 400, message: 'You have already requested this job.' };

    const request = await JobRepository.createRequest(jobId, teamId);
    return request;
  },

  // Get all job requests (admin)
  getJobRequests: async (filters) => {
    return await JobRepository.findRequests(filters);
  },

  // Get the field team member's own requests (any status).
  getMyJobRequests: async (teamId) => {
    return await JobRepository.findRequestsByTeam(teamId);
  },

  // Admin approves a job request (assigns the team)
  approveJobRequest: async (requestId) => {
    const request = await JobRepository.findRequestById(requestId);
    if (!request) throw { status: 404, message: 'Request not found.' };
    if (request.status !== 'pending') throw { status: 400, message: 'Request is no longer pending.' };
    if (request.job_status !== 'scheduled') throw { status: 400, message: 'Job is no longer available.' };
    if (request.assigned_team_id) throw { status: 400, message: 'Job is already assigned.' };

    // Resolve the requester's current team. If they belong to one, the
    // whole team takes the job (assigned_field_team_id is set so every
    // member sees it in "My Jobs" and the incentive engine splits the
    // accruals). The legacy single-agent column also gets set to the
    // requester so older queries stay valid.
    const TeamsRepo = require('../teams/teams.repository');
    const team = await TeamsRepo.findTeamForAgent(request.team_id);

    if (team) {
      await JobRepository.assignToFieldTeam(request.job_id, team.id, request.team_id);
    } else {
      await JobRepository.assignTeam(request.job_id, request.team_id);
    }

    // Approve this request and reject all other pending requests for this job
    await JobRepository.updateRequestStatus(requestId, 'approved');
    await JobRepository.rejectOtherRequests(request.job_id, request.team_id);

    // Fire-and-forget: did we just overcommit this technician?
    try {
      const job = await JobRepository.findById(request.job_id);
      const AdminAlertsService = require('../admin-alerts/admin-alerts.service');
      AdminAlertsService.detectBookingConflicts({
        jobId: request.job_id,
        slotTime: job?.scheduled_at,
        teamId: request.team_id,
      }).catch((e) => { console.warn('[alerts] approve detect failed:', e?.message); });
    } catch (_) {}

    return {
      job_id: request.job_id,
      team_id: request.team_id,
      team_name: request.team_name,
      field_team_id: team?.id || null,
      field_team_name: team?.name || null,
    };
  },

  // Admin rejects a job request
  rejectJobRequest: async (requestId) => {
    const request = await JobRepository.findRequestById(requestId);
    if (!request) throw { status: 404, message: 'Request not found.' };
    if (request.status !== 'pending') throw { status: 400, message: 'Request is no longer pending.' };

    await JobRepository.updateRequestStatus(requestId, 'rejected');
    return { message: 'Request rejected.' };
  },

  // Count pending requests (for admin dashboard)
  getPendingRequestCount: async () => {
    return await JobRepository.countPendingRequests();
  },

  // ── Conflict Detection & Concerns ────────────────────────────────────────

  // Check if a team has a conflicting job at the given time (±60 min)
  checkConflict: async (teamId, scheduledAt, excludeJobId = null) => {
    const conflicts = await JobRepository.checkConflict(teamId, scheduledAt, excludeJobId);
    return { has_conflict: conflicts.length > 0, conflicts };
  },

  // Field team raises a scheduling concern
  raiseConcern: async (jobId, teamId, message) => {
    const job = await JobRepository.findById(jobId);
    if (!job) throw { status: 404, message: 'Job not found.' };
    if (job.assigned_team_id !== teamId) throw { status: 403, message: 'This job is not assigned to you.' };
    if (!message?.trim()) throw { status: 400, message: 'Concern message is required.' };
    const updated = await JobRepository.raiseConcern(jobId, teamId, message.trim());
    if (!updated) throw { status: 400, message: 'Could not raise concern. Job not found or not assigned to you.' };
    return updated;
  },

  // Admin: get all unresolved concerns
  getConcerns: async () => {
    return await JobRepository.findConcerns();
  },

  // Admin: resolve a concern
  resolveConcern: async (jobId) => {
    const job = await JobRepository.findById(jobId);
    if (!job) throw { status: 404, message: 'Job not found.' };
    return await JobRepository.resolveConcern(jobId);
  },

  // Optimize route for field team's day jobs
  optimizeRoute: async (teamId, originLat, originLng) => {
    const jobs = await JobRepository.findByTeam(teamId);
    // Only optimize scheduled/in_progress jobs
    const active = jobs.filter(j => j.status === 'scheduled' || j.status === 'in_progress');
    if (active.length === 0) return { optimized: [], method: 'none' };
    return await RouteService.optimizeRoute(active, originLat, originLng);
  },

};

module.exports = JobService;