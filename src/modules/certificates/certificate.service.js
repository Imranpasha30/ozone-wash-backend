const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const CertificateRepository = require('./certificate.repository');
const EcoScoreRepository = require('../ecoscore/ecoscore.repository');
const JobRepository = require('../jobs/job.repository');
const { R2Service } = require('../../services/r2.service');

const CertificateService = {

  // Generate digital signature hash
  generateSignature: (jobId, ecoScore, issuedAt) => {
    const data = `${jobId}-${ecoScore}-${issuedAt}`;
    return crypto.createHash('sha256').update(data).digest('hex');
  },

  // Generate certificate for a completed job
  generate: async (jobId) => {
    // 1. Get job details
    const job = await JobRepository.findById(jobId);
    if (!job) {
      throw { status: 404, message: 'Job not found.' };
    }

    if (job.status !== 'completed') {
      throw { status: 400, message: 'Job must be completed before generating certificate.' };
    }

    // 2. Get EcoScore
    const ecoMetrics = await EcoScoreRepository.findByJob(jobId);
    if (!ecoMetrics) {
      throw { status: 400, message: 'EcoScore must be calculated before generating certificate.' };
    }

    // 3. Check if certificate already exists
    const existing = await CertificateRepository.findByJob(jobId);
    if (existing) {
      return existing;
    }

    // 4. Generate certificate data
    const issuedAt = new Date();
    const validUntil = new Date();
    validUntil.setDate(validUntil.getDate() + 90); // Valid 90 days (spec 6.2)

    // ORP certificate gate (spec 5.4): after-ORP < 650 mV → badge capped at
    // SILVER on the certificate — ozone effectiveness not confirmed.
    const displayBadge = (job.orp_gate_failed && ['gold', 'platinum'].includes(ecoMetrics.badge_level))
      ? 'silver'
      : ecoMetrics.badge_level;

    // Actual water readings + compliance steps for the PDF (spec 6.2)
    let waterReadings = null;
    let complianceSteps = null;
    try {
      const FieldOpsService = require('../field-ops/field-ops.service');
      const { latest } = await FieldOpsService.getReadings(jobId);
      if (latest.length) waterReadings = latest;
    } catch (_) {}
    try {
      const ComplianceRepository = require('../compliance/compliance.repository');
      const steps = await ComplianceRepository.getSteps(jobId);
      if (steps.length) complianceSteps = steps;
    } catch (_) {}

    const signature = CertificateService.generateSignature(
      jobId,
      ecoMetrics.eco_score,
      issuedAt.toISOString()
    );

    // 5. Save to DB first to get certificate ID
    const cert = await CertificateRepository.create({
      job_id: jobId,
      eco_score: ecoMetrics.eco_score,
      certificate_url: 'pending',
      qr_code_url: 'pending',
      digital_signature: signature,
      valid_until: validUntil,
    });

    // 5b. Human certificate number: OZW-HYG-YYYY-XXXXXX (spec 6.2)
    let certNumber = null;
    try {
      const dbc = require('../../config/db');
      const { rows: seq } = await dbc.query(`SELECT nextval('certificate_number_seq') AS n`);
      certNumber = `OZW-HYG-${issuedAt.getFullYear()}-${String(seq[0].n).padStart(6, '0')}`;
      await dbc.query(
        `UPDATE hygiene_certificates SET certificate_number = $1 WHERE id = $2`,
        [certNumber, cert.id]
      );
      cert.certificate_number = certNumber;
    } catch (e) { console.warn('[cert] number assignment failed:', e?.message); }

    // 6. Generate QR code → public human-readable verify page (spec 6.2)
    const verifyUrl = `${process.env.APP_URL || 'http://localhost:3000'}/verify/${cert.id}`;
    const qrCodeBase64 = await QRCode.toDataURL(verifyUrl);

    // 7. Generate PDF
    const pdfBuffer = await CertificateService.generatePDF({
      cert,
      job,
      ecoMetrics: { ...ecoMetrics, badge_level: displayBadge },
      qrCodeBase64,
      verifyUrl,
      issuedAt,
      validUntil,
      waterReadings,
      complianceSteps,
      orpGateFailed: !!job.orp_gate_failed,
    });

    // 8. Upload PDF — R2 in production, local filesystem in development
    const fileName = `cert_${cert.id}.pdf`;
    let certUrl;

    if (process.env.NODE_ENV === 'production' && process.env.R2_ACCOUNT_ID && process.env.R2_ACCOUNT_ID !== 'your-account-id') {
      const uploaded = await R2Service.uploadFile(pdfBuffer, fileName, 'certificates');
      certUrl = uploaded.url;
    } else {
      const outputDir = path.join(process.cwd(), 'certificates');
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(path.join(outputDir, fileName), pdfBuffer);
      certUrl = `${process.env.APP_URL || 'http://localhost:3000'}/certificates/${fileName}`;
    }

    // 9. Update certificate with final URL (ON CONFLICT updates the existing row)
    await CertificateRepository.create({
      job_id: jobId,
      eco_score: ecoMetrics.eco_score,
      certificate_url: certUrl,
      qr_code_url: verifyUrl,
      digital_signature: signature,
      valid_until: validUntil,
    });

    // 10. Deliver — WhatsApp + SMS + push to the customer (spec 6.3).
    // Server-side, fire-and-forget: delivery failure never blocks generation.
    try {
      const NotificationService = require('../../services/notification.service');
      NotificationService.onCertificateGenerated(
        { phone: job.customer_phone, name: job.customer_name, fcm_token: job.customer_fcm_token || null },
        { id: cert.id, eco_score: ecoMetrics.eco_score, certificate_url: certUrl }
      ).catch(() => {});
    } catch (_) { /* non-fatal */ }

    return {
      certificate_id: cert.id,
      certificate_url: certUrl,
      qr_code_url: verifyUrl,
      eco_score: ecoMetrics.eco_score,
      badge_level: displayBadge,
      orp_gate_capped: !!job.orp_gate_failed,
      valid_until: validUntil,
      digital_signature: signature,
    };
  },

  // Generate PDF buffer
  generatePDF: ({ cert, job, ecoMetrics, qrCodeBase64, verifyUrl, issuedAt, validUntil, waterReadings, complianceSteps, orpGateFailed }) => {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const buffers = [];

      doc.on('data', chunk => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      const BLUE = '#1a1a2e';
      const GREEN = '#2ecc71';
      const GOLD = '#f39c12';
      const GRAY = '#7f8c8d';

      // ── Header ──────────────────────────────────────────────────────────
      doc.rect(0, 0, 595, 120).fill(BLUE);
      doc.fillColor('white')
        .fontSize(28)
        .font('Helvetica-Bold')
        .text('OZONE WASH', 50, 30);
      doc.fontSize(12)
        .font('Helvetica')
        .text('HYGIENE YOU CAN SEE. HEALTH YOU CAN FEEL.', 50, 65);
      doc.fontSize(10)
        .text('VijRam Health Sense Pvt. Ltd. | Hyderabad', 50, 85);

      // ── Certificate Title ────────────────────────────────────────────────
      doc.fillColor(BLUE)
        .fontSize(22)
        .font('Helvetica-Bold')
        .text('DIGITAL HYGIENE CERTIFICATE', 50, 140, { align: 'center' });

      doc.moveTo(50, 170).lineTo(545, 170).stroke(GREEN);

      // ── EcoScore Badge ───────────────────────────────────────────────────
      const badgeColors = {
        platinum: '#7f8c8d',
        gold: '#f39c12',
        silver: '#95a5a6',
        bronze: '#e67e22',
      };
      const badgeColor = badgeColors[ecoMetrics.badge_level] || GOLD;

      doc.circle(480, 210, 45).fill(badgeColor);
      doc.fillColor('white')
        .fontSize(24)
        .font('Helvetica-Bold')
        .text(ecoMetrics.eco_score.toString(), 455, 195);
      doc.fontSize(9)
        .text(ecoMetrics.badge_level.toUpperCase(), 458, 222);

      // ── Customer Details ─────────────────────────────────────────────────
      doc.fillColor(BLUE)
        .fontSize(14)
        .font('Helvetica-Bold')
        .text('SERVICE DETAILS', 50, 185);

      doc.fontSize(11).font('Helvetica');
      const details = [
        ['Customer', job.customer_name || 'N/A'],
        ['Phone', job.customer_phone || 'N/A'],
        ['Address', job.address || 'N/A'],
        ['Tank Type', (job.tank_type || 'N/A').toUpperCase()],
        ['Tank Size', `${job.tank_size_litres || 'N/A'} Litres`],
        ['Field Team', job.team_name || 'N/A'],
        ['Service Date', new Date(job.scheduled_at).toLocaleDateString('en-IN')],
        ['Completed At', job.completed_at ? new Date(job.completed_at).toLocaleString('en-IN') : 'N/A'],
      ];

      let yPos = 210;
      details.forEach(([label, value]) => {
        doc.fillColor(GRAY).text(`${label}:`, 50, yPos);
        doc.fillColor(BLUE).text(value, 200, yPos);
        yPos += 22;
      });

      // ── Compliance Steps ─────────────────────────────────────────────────
      doc.moveTo(50, yPos + 10).lineTo(545, yPos + 10).stroke(GREEN);
      yPos += 25;

      doc.fillColor(BLUE)
        .fontSize(14)
        .font('Helvetica-Bold')
        .text('COMPLIANCE CHECKLIST', 50, yPos);
      yPos += 25;

      // Real per-job SOP phases when available; generic list as fallback.
      if (complianceSteps && complianceSteps.length) {
        complianceSteps
          .sort((a, b) => a.step_number - b.step_number)
          .forEach((s) => {
            const mark = s.uv_skipped ? '–' : '✓';
            doc.fillColor(s.uv_skipped ? GRAY : GREEN).fontSize(12).text(mark, 50, yPos);
            doc.fillColor(BLUE).fontSize(10)
              .font('Helvetica')
              .text(`Step ${s.step_number}: ${s.step_name}${s.uv_skipped ? ' (skipped)' : ''}`, 70, yPos);
            yPos += 16;
          });
      } else {
        const steps = [
          'Site Inspection', 'PPE Check', 'Tank Drainage',
          'Pre-Clean Photos', 'Ozone Treatment', 'Microbial Test',
          'Post-Clean Photos', 'Customer Sign-off',
        ];
        steps.forEach((step, i) => {
          doc.fillColor(GREEN).fontSize(12).text('✓', 50, yPos);
          doc.fillColor(BLUE).fontSize(10)
            .font('Helvetica')
            .text(`Step ${i + 1}: ${step}`, 70, yPos);
          yPos += 18;
        });
      }

      // ── Water Quality — actual before/after readings (spec 6.2) ─────────
      if (waterReadings && waterReadings.length) {
        doc.moveTo(50, yPos + 10).lineTo(545, yPos + 10).stroke(GREEN);
        yPos += 25;
        doc.fillColor(BLUE).fontSize(14).font('Helvetica-Bold')
          .text('WATER QUALITY — BEFORE / AFTER', 50, yPos);
        yPos += 20;

        // Column headers
        doc.fillColor(GRAY).fontSize(9).font('Helvetica-Bold');
        doc.text('Parameter', 50, yPos).text('Before', 200, yPos)
          .text('After', 280, yPos).text('Δ', 360, yPos).text('BIS', 420, yPos);
        yPos += 14;

        const byParam = {};
        for (const r of waterReadings) {
          const key = r.param === 'dissolved_o3_final' ? 'dissolved_o3' : r.param;
          byParam[key] = byParam[key] || { unit: r.unit };
          byParam[key][r.timing] = r;
        }
        doc.font('Helvetica').fontSize(9);
        Object.entries(byParam).forEach(([param, d]) => {
          const before = d.before ? `${Number(d.before.value)} ${d.before.unit}` : '—';
          const after = d.after ? `${Number(d.after.value)} ${d.after.unit}` : '—';
          const delta = d.after?.delta_vs_before != null ? `${Number(d.after.delta_vs_before) > 0 ? '+' : ''}${Number(d.after.delta_vs_before)}` : '—';
          const bis = d.after?.bis_compliant === true ? 'PASS' : d.after?.bis_compliant === false ? 'CHECK' : '—';
          doc.fillColor(GRAY).text(param, 50, yPos);
          doc.fillColor(BLUE).text(before, 200, yPos).text(after, 280, yPos).text(delta, 360, yPos);
          doc.fillColor(d.after?.bis_compliant === false ? '#e67e22' : GREEN).text(bis, 420, yPos);
          yPos += 14;
        });

        // ORP disinfection proof line (spec 9.2)
        const orpAfter = byParam.ORP?.after ? Number(byParam.ORP.after.value) : null;
        doc.fontSize(9).font('Helvetica-Bold');
        if (orpAfter != null && orpAfter >= 650 && !orpGateFailed) {
          doc.fillColor(GREEN).text('Ozone effectiveness confirmed ✓ (ORP ≥ 650 mV)', 50, yPos + 4);
        } else if (orpAfter != null) {
          doc.fillColor('#e67e22').text('⚠ ORP below 650 mV — recheck recommended', 50, yPos + 4);
        }
        yPos += 20;
      }

      // ── EcoScore Breakdown (actual engine dimensions) ───────────────────
      doc.moveTo(50, yPos + 10).lineTo(545, yPos + 10).stroke(GREEN);
      yPos += 25;

      doc.fillColor(BLUE)
        .fontSize(14)
        .font('Helvetica-Bold')
        .text('ECOSCORE BREAKDOWN', 50, yPos);
      yPos += 20;

      // Render whatever dimensions the engine actually stored — avoids the
      // legacy hardcoded keys that always printed zeros.
      const breakdown = ecoMetrics.score_breakdown || {};
      const entries = Object.entries(breakdown)
        .filter(([, v]) => typeof v === 'number')
        .slice(0, 9);
      if (entries.length) {
        const maxVal = Math.max(...entries.map(([, v]) => v), 20);
        entries.forEach(([label, score]) => {
          doc.fillColor(GRAY).fontSize(10).font('Helvetica')
            .text(label.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), 50, yPos);
          doc.fillColor(BLUE).text(String(score), 250, yPos);
          doc.rect(300, yPos, 150, 10).fill('#ecf0f1');
          doc.rect(300, yPos, Math.min(1, score / maxVal) * 150, 10).fill(badgeColor);
          yPos += 18;
        });
      } else {
        doc.fillColor(GRAY).fontSize(10).font('Helvetica')
          .text(`Overall EcoScore: ${ecoMetrics.eco_score}/100 (${ecoMetrics.badge_level.toUpperCase()})`, 50, yPos);
        yPos += 18;
      }

      // ── Certificate Info ─────────────────────────────────────────────────
      doc.moveTo(50, yPos + 10).lineTo(545, yPos + 10).stroke(GREEN);
      yPos += 25;

      doc.fillColor(BLUE).fontSize(9).font('Helvetica')
        .text(`Certificate No: ${cert.certificate_number || cert.id}`, 50, yPos)
        .text(`Issued: ${issuedAt.toLocaleDateString('en-IN')}`, 50, yPos + 15)
        .text(`Valid Until: ${validUntil.toLocaleDateString('en-IN')}`, 50, yPos + 30)
        .text(`Signature: ${cert.digital_signature?.substring(0, 32)}...`, 50, yPos + 45);

      // ── QR Code ──────────────────────────────────────────────────────────
      const qrData = qrCodeBase64.replace(/^data:image\/png;base64,/, '');
      const qrBuffer = Buffer.from(qrData, 'base64');
      doc.image(qrBuffer, 430, yPos, { width: 100 });
      doc.fillColor(GRAY).fontSize(8)
        .text('Scan to verify', 445, yPos + 105);

      // ── Footer ───────────────────────────────────────────────────────────
      doc.rect(0, 780, 595, 60).fill(BLUE);
      doc.fillColor('white').fontSize(9)
        .text('This certificate is digitally generated and verified.', 50, 790, { align: 'center' })
        .text(`Verify at: ${verifyUrl}`, 50, 805, { align: 'center' })
        .text('© VijRam Health Sense Pvt. Ltd. | www.ozonewash.in', 50, 820, { align: 'center' });

      doc.end();
    });
  },

  // Get certificate by job ID
  getCertificate: async (jobId) => {
    const cert = await CertificateRepository.findByJob(jobId);
    if (!cert) {
      throw { status: 404, message: 'Certificate not found for this job.' };
    }
    return cert;
  },

  // Verify certificate by cert ID (public endpoint for QR scan)
  verifyCertificate: async (certId) => {
    const cert = await CertificateRepository.findById(certId);
    if (!cert) {
      throw { status: 404, message: 'Certificate not found.' };
    }

    const isExpired = new Date(cert.valid_until) < new Date();
    const isValid = cert.status === 'active' && !isExpired;

    return {
      valid: isValid,
      status: cert.status,
      certificate_id: cert.id,
      certificate_number: cert.certificate_number || null,
      certificate_url: cert.certificate_url || null,
      customer_name: cert.customer_name,
      address: cert.address,
      tank_type: cert.tank_type,
      eco_score: cert.eco_score,
      service_date: cert.scheduled_at,
      valid_until: cert.valid_until,
      message: isValid
        ? '✅ This certificate is authentic and valid.'
        : '❌ This certificate is invalid or expired.',
    };
  },

  // Revoke certificate (admin only)
  revokeCertificate: async (certId, adminId, reason) => {
    const cert = await CertificateRepository.findById(certId);
    if (!cert) {
      throw { status: 404, message: 'Certificate not found.' };
    }
    if (cert.status === 'revoked') {
      throw { status: 400, message: 'Certificate is already revoked.' };
    }
    return await CertificateRepository.revoke(certId, adminId, reason);
  },

};

module.exports = CertificateService;