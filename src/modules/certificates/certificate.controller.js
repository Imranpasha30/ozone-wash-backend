const CertificateService = require('./certificate.service');
const { sendSuccess, sendError } = require('../../utils/response');

const CertificateController = {

  // POST /api/v1/certificates/generate
  generate: async (req, res, next) => {
    try {
      const { job_id } = req.body;
      if (!job_id) {
        return sendError(res, 'Job ID is required', 400);
      }
      const result = await CertificateService.generate(job_id);
      return sendSuccess(res, result, 'Certificate generated successfully');
    } catch (err) {
      next(err);
    }
  },

  // GET /api/v1/certificates/job/:jobId
  getCertificate: async (req, res, next) => {
    try {
      const cert = await CertificateService.getCertificate(req.params.jobId);
      return sendSuccess(res, { certificate: cert });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/v1/certificates/verify/:certId (PUBLIC — no auth needed)
  verifyCertificate: async (req, res, next) => {
    try {
      const result = await CertificateService.verifyCertificate(req.params.certId);
      return sendSuccess(res, result);
    } catch (err) {
      next(err);
    }
  },

  // PATCH /api/v1/certificates/:certId/revoke (admin only)
  revokeCertificate: async (req, res, next) => {
    try {
      const { reason } = req.body;
      if (!reason) {
        return sendError(res, 'Revocation reason is required', 400);
      }
      const result = await CertificateService.revokeCertificate(
        req.params.certId,
        req.user.id,
        reason
      );
      return sendSuccess(res, { certificate: result }, 'Certificate revoked');
    } catch (err) {
      next(err);
    }
  },

};

module.exports = CertificateController;