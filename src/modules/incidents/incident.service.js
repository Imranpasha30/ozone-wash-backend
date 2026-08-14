const IncidentRepository = require('./incident.repository');
const db = require('../../config/db');

const IncidentService = {

  create: async (data) => {
    const validSeverities = ['low', 'medium', 'high', 'critical'];
    if (data.severity && !validSeverities.includes(data.severity)) {
      throw { status: 400, message: 'Invalid severity. Must be low, medium, high, or critical.' };
    }
    const incident = await IncidentRepository.create(data);

    // CRITICAL incident → auto-pause the job (spec 8.2): all field actions
    // (steps, ozone, readings) reject with 423 until admin resumes it.
    if (data.severity === 'critical' && data.job_id) {
      try {
        await db.query(`UPDATE jobs SET paused = TRUE, updated_at = NOW() WHERE id = $1`, [data.job_id]);
      } catch (e) { console.warn('[incidents] job pause failed:', e?.message); }
    }

    // Fire-and-forget: surface in admin inbox so the dashboard banner picks it up.
    try {
      const AdminAlertsService = require('../admin-alerts/admin-alerts.service');
      const sev = (data.severity === 'low' ? 'warning' : 'critical');
      AdminAlertsService.recordIncident({
        jobId: data.job_id,
        teamId: data.reported_by || null,
        summary: (data.severity === 'critical' ? '[JOB PAUSED] ' : '') + (data.description || data.title || 'Field team reported an incident.'),
        severity: sev,
      }).catch((e) => { console.warn('[alerts] incident record failed:', e?.message); });
    } catch (_) {}

    return incident;
  },

  // Admin resumes a paused job after a critical incident is handled.
  resumeJob: async (jobId) => {
    const { rows } = await db.query(
      `UPDATE jobs SET paused = FALSE, updated_at = NOW() WHERE id = $1 RETURNING id, paused`,
      [jobId]
    );
    if (!rows.length) throw { status: 404, message: 'Job not found.' };
    return rows[0];
  },

  getById: async (id) => {
    const incident = await IncidentRepository.findById(id);
    if (!incident) throw { status: 404, message: 'Incident not found.' };
    return incident;
  },

  getByJobId: async (jobId) => {
    return await IncidentRepository.findByJobId(jobId);
  },

  getAll: async (filters) => {
    return await IncidentRepository.findAll(filters);
  },

  resolve: async (id, resolvedBy) => {
    const incident = await IncidentRepository.findById(id);
    if (!incident) throw { status: 404, message: 'Incident not found.' };
    if (incident.status === 'resolved') throw { status: 400, message: 'Incident is already resolved.' };
    return await IncidentRepository.resolve(id, resolvedBy);
  },

  escalate: async (id) => {
    const incident = await IncidentRepository.findById(id);
    if (!incident) throw { status: 404, message: 'Incident not found.' };
    if (incident.status !== 'open') throw { status: 400, message: 'Only open incidents can be escalated.' };
    return await IncidentRepository.escalate(id);
  },

};

module.exports = IncidentService;
