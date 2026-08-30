/**
 * Service layer for admin alerts — the central nervous system for everything
 * that needs admin attention in real time. Alert types this module handles:
 *
 *   slot_conflict       → warning  (slot overbooked: bookings > teams)
 *   no_team_for_slot    → critical (booking exists, zero teams on roster)
 *   team_overcommit     → critical (technician double-booked at same hour)
 *   new_booking         → info     (customer just placed a booking)
 *   incident_reported   → critical (field team logged an incident on a job)
 *   payment_pending     → warning  (COD job completed, payment not collected)
 *   unassigned_aging    → warning  (job created >3 h ago with no team)
 *   starting_soon       → critical (job in <1 h, no team assigned)
 *   sla_breach          → critical (job in_progress > 2 h past slot OR
 *                                   scheduled but never started past slot)
 *   amc_expiring        → info     (AMC contract expires in 30 days)
 *   amc_expired         → warning  (AMC contract expired, not renewed)
 *
 * Public API:
 *   listAlerts({ unackOnly })       → admin list endpoint
 *   countUnack()                    → admin dashboard badge
 *   acknowledge(id, adminId)        → admin dismisses alert
 *   detectBookingConflicts(payload) → run after every booking create / job
 *                                     accept; emits alerts when scheduling
 *                                     pressure crosses a threshold.
 *   recordNewBooking(payload)       → info-level alert on every booking
 *   recordIncident(payload)         → critical alert when team reports incident
 *   recordPaymentPending(payload)   → warning when COD complete but unpaid
 *   runTimeBasedChecks()            → cron-driven sweep for aging/SLA/AMC
 */
const db = require('../../config/db');
const Repo = require('./admin-alerts.repository');

const AdminAlertsService = {
  listAlerts: ({ unackOnly = false, limit = 50 } = {}) =>
    Repo.list({ unackOnly, limit }),

  countUnack: () => Repo.countUnack(),

  acknowledge: async (id, adminId) => {
    const updated = await Repo.acknowledge(id, adminId);
    if (!updated) throw { status: 404, message: 'Alert not found or already acknowledged.' };
    return updated;
  },

  /**
   * Run after a booking is created OR a job request is approved.
   * Detects three failure modes and creates alerts:
   *   slot_conflict     — more bookings scheduled at the same hour than
   *                       there are field_team members available
   *   no_team_for_slot  — booking confirmed but zero teams unassigned
   *   team_overcommit   — a field_team member has overlapping assigned jobs
   *
   * `payload` may carry `bookingId`, `jobId`, `slotTime`, `teamId`. We only
   * run the relevant probes for the fields provided.
   */
  detectBookingConflicts: async ({ bookingId = null, jobId = null, slotTime, teamId = null } = {}) => {
    if (!slotTime) return [];
    const slot = new Date(slotTime);

    const alerts = [];

    // Window: same hour as the slot. Adjust if you want stricter checks.
    const winStart = new Date(slot);
    winStart.setMinutes(0, 0, 0);
    const winEnd = new Date(winStart);
    winEnd.setHours(winEnd.getHours() + 1);

    // 1) Concurrent-bookings-vs-team-count check.
    //
    // How many CONFIRMED non-cancelled bookings/jobs fall in this hour, vs
    // how many active field_team members exist?
    const [{ rows: countRows }, { rows: teamRows }] = await Promise.all([
      db.query(
        `SELECT COUNT(*)::int AS booking_count FROM (
           SELECT id FROM bookings
             WHERE slot_time >= $1 AND slot_time < $2
               AND status IN ('confirmed', 'in_progress')
           UNION ALL
           SELECT id FROM jobs
             WHERE scheduled_at >= $1 AND scheduled_at < $2
               AND job_type = 'auto_wash'
               AND status IN ('scheduled', 'in_progress')
         ) x`,
        [winStart.toISOString(), winEnd.toISOString()]
      ),
      db.query(`SELECT COUNT(*)::int AS team_count FROM users WHERE role = 'field_team'`),
    ]);
    const bookingCount = countRows[0]?.booking_count || 0;
    const teamCount = teamRows[0]?.team_count || 0;

    if (teamCount === 0 && bookingCount > 0) {
      const dup = await Repo.findRecentDuplicate({
        type: 'no_team_for_slot',
        related_booking_id: bookingId, related_job_id: jobId, related_team_id: null,
      });
      if (!dup) {
        alerts.push(await Repo.create({
          type: 'no_team_for_slot',
          severity: 'critical',
          title: 'No field team available',
          message: `Booking for ${slot.toLocaleString('en-IN')} cannot be staffed — no field team members exist.`,
          related_booking_id: bookingId, related_job_id: jobId,
          metadata: { slot_time: slot.toISOString(), booking_count: bookingCount, team_count: teamCount },
        }));
      }
    } else if (bookingCount > teamCount && teamCount > 0) {
      const dup = await Repo.findRecentDuplicate({
        type: 'slot_conflict',
        related_booking_id: bookingId, related_job_id: jobId, related_team_id: null,
      });
      if (!dup) {
        alerts.push(await Repo.create({
          type: 'slot_conflict',
          severity: 'warning',
          title: `Slot overbooked — ${bookingCount} jobs vs ${teamCount} teams`,
          message: `${bookingCount} bookings land in the hour starting ${slot.toLocaleString('en-IN')} but only ${teamCount} field team members are on roster. Re-assign or split slots.`,
          related_booking_id: bookingId, related_job_id: jobId,
          metadata: { slot_time: slot.toISOString(), booking_count: bookingCount, team_count: teamCount },
        }));
      }
    }

    // 2) Per-team overcommit check (only meaningful if a teamId was supplied,
    // i.e. an admin just approved a job request).
    if (teamId) {
      const { rows: overlapRows } = await db.query(
        `SELECT id, scheduled_at FROM jobs
           WHERE assigned_team_id = $1
             AND status IN ('scheduled', 'in_progress')
             AND scheduled_at >= $2 AND scheduled_at < $3
             AND id <> COALESCE($4, '00000000-0000-0000-0000-000000000000'::uuid)
           LIMIT 5`,
        [teamId, winStart.toISOString(), winEnd.toISOString(), jobId]
      );
      if (overlapRows.length > 0) {
        const dup = await Repo.findRecentDuplicate({
          type: 'team_overcommit',
          related_booking_id: bookingId, related_job_id: jobId, related_team_id: teamId,
        });
        if (!dup) {
          alerts.push(await Repo.create({
            type: 'team_overcommit',
            severity: 'critical',
            title: 'Technician double-booked',
            message: `This team already has ${overlapRows.length} other job(s) at ${slot.toLocaleString('en-IN')}. Re-assign one of them.`,
            related_booking_id: bookingId, related_job_id: jobId, related_team_id: teamId,
            metadata: {
              slot_time: slot.toISOString(),
              overlapping_job_ids: overlapRows.map((r) => r.id),
            },
          }));
        }
      }
    }

    return alerts;
  },

  /**
   * Info-level event when a customer places a new booking. Admin sees the
   * booking is in the system; lets them peek without polling the bookings
   * list. Not de-duped per booking (each booking is a separate event).
   */
  recordNewBooking: async ({ bookingId = null, jobId = null, kind, customerName, slotTime, summary }) => {
    return Repo.create({
      type: 'new_booking',
      severity: 'info',
      title: `New ${kind === 'auto_wash' ? 'car wash' : 'tank cleaning'} booking`,
      message: `${customerName || 'A customer'} just booked ${summary || ''} for ${new Date(slotTime).toLocaleString('en-IN')}.`,
      related_booking_id: bookingId,
      related_job_id: jobId,
      metadata: { kind, slot_time: slotTime },
    });
  },

  /**
   * Critical alert when the field team logs an incident on a job (chemical
   * spill, customer dispute, equipment damage, etc).
   */
  recordIncident: async ({ jobId, teamId, summary, severity = 'critical' }) => {
    const dup = await Repo.findRecentDuplicate({
      type: 'incident_reported',
      related_booking_id: null, related_job_id: jobId, related_team_id: teamId,
    });
    if (dup) return null;
    return Repo.create({
      type: 'incident_reported',
      severity,
      title: 'Incident reported on a job',
      message: summary || 'Field team logged an incident — review on the Incidents page.',
      related_job_id: jobId,
      related_team_id: teamId,
    });
  },

  /**
   * Warning when a COD job is marked complete but payment hasn't been
   * collected yet. Customer's amount_paise > 0 and payment_status != 'paid'.
   */
  recordPaymentPending: async ({ bookingId, jobId, amount, customerName }) => {
    const dup = await Repo.findRecentDuplicate({
      type: 'payment_pending',
      related_booking_id: bookingId, related_job_id: jobId, related_team_id: null,
    });
    if (dup) return null;
    return Repo.create({
      type: 'payment_pending',
      severity: 'warning',
      title: 'Payment not collected',
      message: `${customerName || 'Customer'} owes ₹${(amount / 100).toLocaleString('en-IN')} on a completed COD job. Confirm collection with the field team.`,
      related_booking_id: bookingId,
      related_job_id: jobId,
      metadata: { amount_paise: amount },
    });
  },

  /**
   * Critical alert when a late gateway settle can't cleanly reinstate a
   * hold-swept job. Two cases (by `reason`):
   *   - 'reinstated_unassigned' — the slot had room so the job WAS reinstated,
   *     but it had a stale crew assignment that could now overlap, so it came
   *     back UNASSIGNED and needs a crew.
   *   - otherwise — the slot was already resold; the paid booking stays
   *     cancelled and needs a manual reschedule or refund (never overbooked).
   * De-duped per booking/job.
   */
  recordSlotResold: async ({ bookingId = null, jobId = null, slotTime = null, reason = null } = {}) => {
    const dup = await Repo.findRecentDuplicate({
      type: 'slot_resold',
      related_booking_id: bookingId, related_job_id: jobId, related_team_id: null,
    });
    if (dup) return null;
    const when = slotTime ? new Date(slotTime).toLocaleString('en-IN') : 'the held slot';
    const reinstated = reason === 'reinstated_unassigned';
    return Repo.create({
      type: 'slot_resold',
      severity: 'critical',
      title: reinstated ? 'Paid booking reinstated — needs a crew' : 'Paid booking — slot already resold',
      message: reinstated
        ? `A late payment reinstated the ${when} booking, but its earlier crew may now be double-booked — it was reinstated WITHOUT a crew. Assign a crew from the schedule board.`
        : `A payment settled after its ${when} hold expired, but that slot was already taken. The booking is PAID and needs a reschedule or refund — it was NOT auto-reinstated (would have overbooked the crew).`,
      related_booking_id: bookingId,
      related_job_id: jobId,
      metadata: { slot_time: slotTime, reason: reason || 'slot_full' },
    });
  },

  /**
   * Cron-driven sweep that detects time-sensitive conditions:
   *   - jobs created >3 h ago but still unassigned
   *   - jobs scheduled in <1 h with no team
   *   - jobs scheduled but not yet started past their slot (SLA breach)
   *   - jobs in_progress longer than 2 h past slot
   *   - AMC contracts expiring in 30 days
   *   - AMC contracts already expired but still 'active'
   *
   * Idempotent via Repo.findRecentDuplicate, so safe to run every 5 min.
   * Returns the count of newly-created alerts.
   */
  runTimeBasedChecks: async () => {
    const out = { unassigned_aging: 0, starting_soon: 0, sla_breach: 0, amc_expiring: 0, amc_expired: 0 };

    // ── 1) Unassigned jobs aging > 3 h ────────────────────────────────────
    const { rows: aging } = await db.query(
      `SELECT j.id as job_id, j.booking_id, j.scheduled_at, j.created_at,
              c.name as customer_name
         FROM jobs j
         JOIN users c ON c.id = j.customer_id
        WHERE j.status = 'scheduled'
          AND j.assigned_team_id IS NULL
          AND j.created_at < NOW() - INTERVAL '3 hours'
          AND (j.booking_id IS NULL OR EXISTS (
            SELECT 1 FROM bookings b WHERE b.id = j.booking_id AND b.status = 'confirmed'))
        LIMIT 50`
    );
    for (const r of aging) {
      const dup = await Repo.findRecentDuplicate({
        type: 'unassigned_aging',
        related_booking_id: r.booking_id, related_job_id: r.job_id, related_team_id: null,
      });
      if (dup) continue;
      await Repo.create({
        type: 'unassigned_aging',
        severity: 'warning',
        title: 'Job stuck without a team',
        message: `${r.customer_name || 'A customer'}’s job has been in the queue for over 3 hours with no team assigned.`,
        related_booking_id: r.booking_id, related_job_id: r.job_id,
        metadata: { created_at: r.created_at, scheduled_at: r.scheduled_at },
      });
      out.unassigned_aging++;
    }

    // ── 2) Jobs starting in <1 h with no team ─────────────────────────────
    const { rows: imminent } = await db.query(
      `SELECT j.id as job_id, j.booking_id, j.scheduled_at,
              c.name as customer_name
         FROM jobs j
         JOIN users c ON c.id = j.customer_id
        WHERE j.status = 'scheduled'
          AND j.assigned_team_id IS NULL
          AND j.scheduled_at > NOW()
          AND j.scheduled_at < NOW() + INTERVAL '1 hour'
          AND (j.booking_id IS NULL OR EXISTS (
            SELECT 1 FROM bookings b WHERE b.id = j.booking_id AND b.status = 'confirmed'))
        LIMIT 50`
    );
    for (const r of imminent) {
      const dup = await Repo.findRecentDuplicate({
        type: 'starting_soon',
        related_booking_id: r.booking_id, related_job_id: r.job_id, related_team_id: null,
      });
      if (dup) continue;
      await Repo.create({
        type: 'starting_soon',
        severity: 'critical',
        title: 'Job starting in <1 hour with no team',
        message: `${r.customer_name || 'A customer'} is expecting service at ${new Date(r.scheduled_at).toLocaleString('en-IN')} but no field team is assigned.`,
        related_booking_id: r.booking_id, related_job_id: r.job_id,
        metadata: { scheduled_at: r.scheduled_at },
      });
      out.starting_soon++;
    }

    // ── 3) SLA breach — past slot, never started OR in_progress too long ──
    const { rows: breach } = await db.query(
      `SELECT j.id as job_id, j.booking_id, j.status, j.scheduled_at,
              j.assigned_team_id, c.name as customer_name,
              t.name as team_name
         FROM jobs j
         JOIN users c ON c.id = j.customer_id
    LEFT JOIN users t ON t.id = j.assigned_team_id
        WHERE (
          (j.status = 'scheduled'   AND j.scheduled_at < NOW() - INTERVAL '30 minutes') OR
          (j.status = 'in_progress' AND j.scheduled_at < NOW() - INTERVAL '2 hours')
        )
        LIMIT 50`
    );
    for (const r of breach) {
      const dup = await Repo.findRecentDuplicate({
        type: 'sla_breach',
        related_booking_id: r.booking_id, related_job_id: r.job_id, related_team_id: r.assigned_team_id,
      });
      if (dup) continue;
      const reason = r.status === 'scheduled'
        ? `slot was ${new Date(r.scheduled_at).toLocaleString('en-IN')} — job never started`
        : `running over 2 h past the slot (${new Date(r.scheduled_at).toLocaleString('en-IN')})`;
      await Repo.create({
        type: 'sla_breach',
        severity: 'critical',
        title: 'SLA breach on a job',
        message: `${r.customer_name || 'Customer'}’s job: ${reason}. ${r.team_name ? 'Team: ' + r.team_name + '.' : 'No team assigned.'}`,
        related_booking_id: r.booking_id, related_job_id: r.job_id, related_team_id: r.assigned_team_id,
        metadata: { status: r.status, scheduled_at: r.scheduled_at },
      });
      out.sla_breach++;
    }

    // ── 4) AMC contracts expiring in the next 30 days ─────────────────────
    try {
      const { rows: expiring } = await db.query(
        `SELECT id as contract_id, customer_id, end_date, plan_type
           FROM amc_contracts
          WHERE status = 'active'
            AND end_date BETWEEN NOW() AND NOW() + INTERVAL '30 days'
          LIMIT 50`
      );
      for (const r of expiring) {
        // No related_job_id; we dedupe by customer using related_team_id slot.
        // Reusing the dedupe tuple (booking/job/team) — store customer in team slot.
        const dup = await Repo.findRecentDuplicate({
          type: 'amc_expiring',
          related_booking_id: null, related_job_id: null, related_team_id: r.customer_id,
        });
        if (dup) continue;
        await Repo.create({
          type: 'amc_expiring',
          severity: 'info',
          title: 'AMC contract expiring soon',
          message: `${r.plan_type?.toUpperCase()} contract expires on ${new Date(r.end_date).toLocaleDateString('en-IN')}. Nudge the customer to renew.`,
          related_team_id: r.customer_id,
          metadata: { contract_id: r.contract_id, end_date: r.end_date, plan: r.plan_type },
        });
        out.amc_expiring++;
      }

      const { rows: expired } = await db.query(
        `SELECT id as contract_id, customer_id, end_date, plan_type
           FROM amc_contracts
          WHERE status = 'active'
            AND end_date < NOW()
          LIMIT 50`
      );
      for (const r of expired) {
        const dup = await Repo.findRecentDuplicate({
          type: 'amc_expired',
          related_booking_id: null, related_job_id: null, related_team_id: r.customer_id,
        });
        if (dup) continue;
        await Repo.create({
          type: 'amc_expired',
          severity: 'warning',
          title: 'AMC contract expired',
          message: `${r.plan_type?.toUpperCase()} contract expired on ${new Date(r.end_date).toLocaleDateString('en-IN')} but still marked active. Update status or trigger renewal.`,
          related_team_id: r.customer_id,
          metadata: { contract_id: r.contract_id, end_date: r.end_date, plan: r.plan_type },
        });
        out.amc_expired++;
      }
    } catch (_) {} // amc_contracts table may not exist in some envs

    return out;
  },
};

module.exports = AdminAlertsService;
