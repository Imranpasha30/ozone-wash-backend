const IncidentRepository = require('./incident.repository');

const IncidentService = {

  create: async (data) => {
    const validSeverities = ['low', 'medium', 'high', 'critical'];
    if (data.severity && !validSeverities.includes(data.severity)) {
      throw { status: 400, message: 'Invalid severity. Must be low, medium, high, or critical.' };
    }
    const incident = await IncidentRepository.create(data);

    // Fire-and-forget: surface in admin inbox so the dashboard banner picks it up.
    try {
      const AdminAlertsService = require('../admin-alerts/admin-alerts.service');
      const sev = (data.severity === 'low' ? 'warning' : 'critical');
      AdminAlertsService.recordIncident({
        jobId: data.job_id,
        teamId: data.reported_by || null,
        summary: data.description || data.title || 'Field team reported an incident.',
        severity: sev,
      }).catch((e) => { console.warn('[alerts] incident record failed:', e?.message); });
    } catch (_) {}

    return incident;
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
