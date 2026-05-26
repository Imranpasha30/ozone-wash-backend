/**
 * Auto Wash certificate PDF generator.
 * Spec: Master Prompt v2.0 PART 4 + Auto Wash Scope PDF Section 3.4.
 *
 * Uses pdfkit (already in deps) and qrcode (already in deps) — no headless
 * browser required, runs cleanly in serverless.
 *
 * Layout (A4 portrait, 595×842):
 *   ── header band (brand + tagline)
 *   ── certificate title + verified pill
 *   ── EcoScore badge circle (right) + service details block (left)
 *   ── vehicle block (centered)
 *   ── readings grid (4 stats — ozone ppm, fogging min, water used, water saved)
 *   ── QR code + verify URL footer
 *   ── validity statement
 */

const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { R2Service } = require('../../services/r2.service');

const BRAND_BLUE   = '#0C4A6E';
const BRAND_SKY    = '#0EA5E9';
const BRAND_LEAF   = '#22C55E';
const BRAND_GOLD   = '#F59E0B';
const BRAND_GRAY   = '#64748B';
const BRAND_INK    = '#0B1F33';

const BADGE_COLOR = {
  platinum: '#94A3B8',
  gold:     '#F59E0B',
  silver:   '#9CA3AF',
  bronze:   '#B45309',
};

/**
 * Build the PDF buffer for a single auto-wash certificate.
 *
 * @param {object} args
 *   cert            — row from auto_wash_certificates
 *   job             — row from jobs (auto_wash) with v_type / v_reg
 *   customer_name   — string
 *   crew_name       — string | null
 *   ev_unit_code    — string | null
 * @returns {Promise<Buffer>}
 */
async function buildCertificatePDF({ cert, job, customer_name, crew_name, ev_unit_code }) {
  const verifyUrl = `https://ozonewash.in/verify/AW-${cert.qr_token}`;
  const qrDataUrl = await QRCode.toDataURL(verifyUrl, { errorCorrectionLevel: 'M', margin: 1, width: 280 });
  const qrBase64 = qrDataUrl.split(',')[1];
  const qrBuffer = Buffer.from(qrBase64, 'base64');

  const badgeFill = BADGE_COLOR[cert.eco_badge] || BRAND_GOLD;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── HEADER BAND ────────────────────────────────────────────────────────
    doc.rect(0, 0, 595, 130).fill(BRAND_INK);
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(26).text('OZONE WASH™ AUTO', 50, 36);
    doc.fillColor(BRAND_LEAF).font('Helvetica-Bold').fontSize(10)
       .text('🌿 EV-POWERED · ZERO EMISSIONS', 50, 70);
    doc.fillColor('#94A3B8').font('Helvetica').fontSize(9)
       .text('VijRam Health Sense Pvt. Ltd. · DPIIT #DIPP227416 · Hyderabad, Telangana', 50, 90);
    doc.fillColor('#94A3B8').fontSize(8.5)
       .text('ozonewash.in · hello@ozonewash.in · +91 81 79 69 59 59', 50, 105);

    // ── VERIFIED PILL ──────────────────────────────────────────────────────
    doc.roundedRect(465, 38, 88, 22, 11).fill(BRAND_LEAF);
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(10)
       .text('✓ VERIFIED', 480, 44);

    // ── CERTIFICATE TITLE ──────────────────────────────────────────────────
    doc.fillColor(BRAND_INK).font('Helvetica-Bold').fontSize(20)
       .text('CERTIFICATE OF CABIN HYGIENE', 0, 158, { align: 'center', width: 595 });
    doc.fillColor(BRAND_GRAY).font('Helvetica').fontSize(9.5)
       .text(`Cert ID · AW-${String(cert.qr_token).slice(0, 12).toUpperCase()}`, 0, 184, { align: 'center', width: 595 });

    // ── ECOSCORE BADGE (right side) ────────────────────────────────────────
    const badgeX = 470, badgeY = 230;
    doc.circle(badgeX, badgeY, 48).fill(badgeFill);
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(26)
       .text(String(cert.eco_score), badgeX - 22, badgeY - 18, { width: 44, align: 'center' });
    doc.fontSize(10).text(String(cert.eco_badge || 'rated').toUpperCase(), badgeX - 30, badgeY + 14, { width: 60, align: 'center' });
    doc.fillColor(BRAND_GRAY).fontSize(8.5).font('Helvetica')
       .text('EcoScore™', badgeX - 30, badgeY + 38, { width: 60, align: 'center' });

    // ── SERVICE DETAILS (left side) ────────────────────────────────────────
    let y = 220;
    doc.fillColor(BRAND_INK).font('Helvetica-Bold').fontSize(13).text('SERVICE DETAILS', 50, y);
    y += 24;
    const labelFont = () => doc.font('Helvetica').fillColor(BRAND_GRAY).fontSize(9.5);
    const valueFont = () => doc.font('Helvetica-Bold').fillColor(BRAND_INK).fontSize(11);

    const detailLine = (label, value) => {
      labelFont().text(label.toUpperCase(), 50, y);
      valueFont().text(value, 50, y + 12, { width: 360 });
      y += 32;
    };

    detailLine('Customer',      customer_name || '—');
    detailLine('Vehicle',       `${String(job.v_type || job.vehicle_type || '').replace('_', ' ').toUpperCase()}  ····  ${String(job.v_reg || job.registration_number || '').slice(-4).padStart(4, '*')}`);
    detailLine('Package',       String(cert.service_package || '').toUpperCase());
    detailLine('Service date',  new Date(cert.generated_at || Date.now()).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }));

    // ── READINGS GRID ──────────────────────────────────────────────────────
    const gridY = 440;
    doc.rect(50, gridY, 495, 1).fill(BRAND_GRAY);
    doc.fillColor(BRAND_INK).font('Helvetica-Bold').fontSize(13).text('HYGIENE READINGS', 50, gridY + 18);

    const stats = [
      { label: 'Exterior ozone',  value: cert.ozone_ppm_exterior != null ? `${cert.ozone_ppm_exterior} ppm` : '—' },
      { label: 'Cabin ozone',     value: cert.ozone_ppm_cabin != null ? `${cert.ozone_ppm_cabin} ppm` : '—' },
      { label: 'Fogging time',    value: cert.fogging_duration_min != null ? `${cert.fogging_duration_min} min` : '—' },
      { label: 'Water used',      value: cert.water_used_litres != null ? `${cert.water_used_litres} L` : '—' },
    ];
    let sx = 50, sy = gridY + 50;
    const boxW = 117, boxH = 70;
    stats.forEach((s, i) => {
      const x = sx + (boxW + 5) * i;
      doc.roundedRect(x, sy, boxW, boxH, 6).fillAndStroke('#F4F8FB', '#E2E8F0');
      doc.fillColor(BRAND_GRAY).font('Helvetica-Bold').fontSize(8).text(s.label.toUpperCase(), x + 10, sy + 12);
      doc.fillColor(BRAND_INK).font('Helvetica-Bold').fontSize(18).text(s.value, x + 10, sy + 30, { width: boxW - 20 });
    });

    // Water savings highlight
    if (cert.water_saved_litres != null && cert.water_saved_litres > 0) {
      doc.roundedRect(50, sy + boxH + 12, 495, 38, 8).fillAndStroke('rgba(34,197,94,0.10)', BRAND_LEAF);
      doc.fillColor(BRAND_LEAF).font('Helvetica-Bold').fontSize(11)
         .text(`💧 ${cert.water_saved_litres}L saved vs traditional wash`, 60, sy + boxH + 24);
      doc.fillColor(BRAND_GRAY).font('Helvetica').fontSize(9)
         .text('Ozone disinfects with a fraction of the water — measurable environmental impact.', 270, sy + boxH + 26);
    }

    // ── QR CODE FOOTER ─────────────────────────────────────────────────────
    const qY = 660;
    doc.image(qrBuffer, 50, qY, { width: 110, height: 110 });
    doc.fillColor(BRAND_INK).font('Helvetica-Bold').fontSize(11)
       .text('Scan to verify', 180, qY + 8);
    doc.fillColor(BRAND_GRAY).font('Helvetica').fontSize(9.5)
       .text(verifyUrl, 180, qY + 26, { width: 360 });
    doc.fillColor(BRAND_INK).font('Helvetica-Bold').fontSize(9)
       .text('TAMPER-EVIDENT · QR-SIGNED', 180, qY + 50);

    // Crew + EV unit attribution
    if (crew_name || ev_unit_code) {
      doc.fillColor(BRAND_GRAY).font('Helvetica').fontSize(9)
         .text(`Crew: ${crew_name || '—'}    ·    EV Unit: ${ev_unit_code || '—'}`, 180, qY + 70);
    }
    doc.fillColor(BRAND_GRAY).font('Helvetica-Oblique').fontSize(8.5)
       .text(`Valid until ${cert.valid_until}. Recommended next wash within 30 days for continuous cabin hygiene.`, 180, qY + 88, { width: 360 });

    // ── FOOTER BAR ─────────────────────────────────────────────────────────
    doc.rect(0, 802, 595, 40).fill(BRAND_INK);
    doc.fillColor('#94A3B8').font('Helvetica').fontSize(8)
       .text('© VijRam Health Sense Pvt. Ltd.  ·  Patent-applied Ozone process  ·  This certificate is issued only after a fully-completed compliance flow.', 50, 818, { align: 'center', width: 495 });

    doc.end();
  });
}

/**
 * Generate + upload to R2. Returns { key, url } from R2Service.
 */
async function generateAndUploadCertPDF({ cert, job, customer_name, crew_name, ev_unit_code }) {
  const buffer = await buildCertificatePDF({ cert, job, customer_name, crew_name, ev_unit_code });
  const fileName = `auto-wash-cert-${cert.id}.pdf`;
  return R2Service.uploadFile(buffer, fileName, 'auto-wash/certificates');
}

module.exports = { buildCertificatePDF, generateAndUploadCertPDF };
