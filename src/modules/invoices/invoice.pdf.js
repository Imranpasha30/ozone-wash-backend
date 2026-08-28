/**
 * GST Tax-Invoice PDF generator (pdfkit, no headless browser).
 *
 * Renders a compliant Indian tax invoice: seller GSTIN/SAC, sequential invoice
 * number, bill-to snapshot, line items, taxable value + CGST/SGST split,
 * amount in words, and a place-of-supply line. All amounts are GST-inclusive
 * paise; the taxable value and tax are shown separately per GST rules.
 */

const PDFDocument = require('pdfkit');

const INK   = '#0B1F33';
const BLUE  = '#0C4A6E';
const SKY   = '#0EA5E9';
const GRAY  = '#64748B';
const LINE  = '#E2E8F0';
const ALT   = '#F4F8FB';

const rupees = (paise) =>
  `Rs. ${((Number(paise) || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/* ── Indian-system amount in words (rupees + paise) ─────────────────────── */
function amountInWords(paise) {
  const rupeesN = Math.floor((Number(paise) || 0) / 100);
  const paiseN = Math.round((Number(paise) || 0) % 100);
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = (n) => n < 20 ? ones[n] : `${tens[Math.floor(n / 10)]}${n % 10 ? ' ' + ones[n % 10] : ''}`;
  const three = (n) => {
    const h = Math.floor(n / 100), r = n % 100;
    return `${h ? ones[h] + ' Hundred' + (r ? ' ' : '') : ''}${r ? two(r) : ''}`;
  };
  const inr = (n) => {
    if (n === 0) return 'Zero';
    const crore = Math.floor(n / 10000000); n %= 10000000;
    const lakh = Math.floor(n / 100000); n %= 100000;
    const thousand = Math.floor(n / 1000); n %= 1000;
    const hundred = n;
    let out = '';
    if (crore) out += `${inr(crore)} Crore `;
    if (lakh) out += `${two(lakh)} Lakh `;
    if (thousand) out += `${two(thousand)} Thousand `;
    if (hundred) out += three(hundred);
    return out.trim();
  };
  let words = `Rupees ${inr(rupeesN)}`;
  if (paiseN) words += ` and ${two(paiseN)} Paise`;
  return `${words} only`;
}

function buildInvoicePDF({ invoice, seller }) {
  let items = invoice.line_items;
  if (typeof items === 'string') { try { items = JSON.parse(items); } catch { items = []; } }
  if (!Array.isArray(items)) items = [];

  const issued = new Date(invoice.issued_at || Date.now());
  const dateStr = issued.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const L = 40, R = 555; // content left/right
    const W = R - L;

    // ── Header band ──────────────────────────────────────────────────────
    doc.rect(0, 0, 595, 96).fill(INK);
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(20).text(seller.brand, L, 26);
    doc.fillColor('#94A3B8').font('Helvetica').fontSize(8.5)
       .text(seller.legal_name, L, 52)
       .text(seller.address, L, 64, { width: 330 });
    // Title pill
    doc.fillColor(SKY).font('Helvetica-Bold').fontSize(16).text('TAX INVOICE', 380, 30, { width: 175, align: 'right' });
    doc.fillColor('#94A3B8').font('Helvetica').fontSize(8)
       .text(`CIN: ${seller.cin}`, 380, 56, { width: 175, align: 'right' })
       .text(seller.gstin ? `GSTIN: ${seller.gstin}` : 'GSTIN: (to be configured)', 380, 68, { width: 175, align: 'right' });

    // ── Meta + Bill-to row ───────────────────────────────────────────────
    let y = 116;
    const colW = (W - 16) / 2;

    // Left: Bill To
    doc.roundedRect(L, y, colW, 108, 6).fillAndStroke(ALT, LINE);
    doc.fillColor(GRAY).font('Helvetica-Bold').fontSize(8).text('BILL TO', L + 12, y + 10);
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(11).text(invoice.customer_name || 'Customer', L + 12, y + 24, { width: colW - 24 });
    doc.fillColor(GRAY).font('Helvetica').fontSize(9);
    let by = y + 42;
    if (invoice.customer_phone) { doc.text(`Phone: ${invoice.customer_phone}`, L + 12, by, { width: colW - 24 }); by += 13; }
    if (invoice.customer_email) { doc.text(`Email: ${invoice.customer_email}`, L + 12, by, { width: colW - 24 }); by += 13; }
    if (invoice.billing_address) { doc.text(invoice.billing_address, L + 12, by, { width: colW - 24 }); by += 24; }
    if (invoice.customer_gstin) { doc.font('Helvetica-Bold').fillColor(INK).text(`GSTIN: ${invoice.customer_gstin}`, L + 12, by, { width: colW - 24 }); }

    // Right: Invoice meta
    const mx = L + colW + 16;
    doc.roundedRect(mx, y, colW, 108, 6).fillAndStroke(ALT, LINE);
    const metaRow = (label, value, ry) => {
      doc.fillColor(GRAY).font('Helvetica').fontSize(9).text(label, mx + 12, ry, { width: colW * 0.45 });
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(9).text(value, mx + 12 + colW * 0.45, ry, { width: colW * 0.55 - 24, align: 'right' });
    };
    metaRow('Invoice No.', invoice.invoice_number, y + 12);
    metaRow('Invoice Date', dateStr, y + 30);
    metaRow('Place of Supply', invoice.place_of_supply || '—', y + 48);
    metaRow('SAC Code', invoice.sac_code || '998534', y + 66);
    metaRow('Payment', `${(invoice.payment_gateway || 'online').toUpperCase()}${invoice.payment_status === 'paid' ? ' · PAID' : ''}`, y + 84);

    // ── Line-items table ─────────────────────────────────────────────────
    y += 128;
    const cDesc = L + 10, cQty = L + 330, cAmt = R - 10;
    doc.rect(L, y, W, 22).fill(BLUE);
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(9)
       .text('DESCRIPTION', cDesc, y + 7)
       .text('QTY', cQty, y + 7, { width: 40, align: 'center' })
       .text('AMOUNT (incl. GST)', L + 380, y + 7, { width: R - (L + 380) - 10, align: 'right' });
    y += 22;

    doc.font('Helvetica').fontSize(9.5);
    items.forEach((it, idx) => {
      const rowH = 26;
      if (idx % 2 === 1) doc.rect(L, y, W, rowH).fill(ALT);
      doc.fillColor(INK).font('Helvetica').fontSize(9.5)
         .text(it.description || 'Service', cDesc, y + 8, { width: 300 });
      doc.text(String(it.qty || 1), cQty, y + 8, { width: 40, align: 'center' });
      doc.font('Helvetica-Bold').text(rupees(it.amount_paise), L + 380, y + 8, { width: R - (L + 380) - 10, align: 'right' });
      y += rowH;
    });
    doc.moveTo(L, y).lineTo(R, y).strokeColor(LINE).stroke();

    // ── Totals block (right-aligned) ─────────────────────────────────────
    y += 12;
    const tX = 320, tW = R - tX;
    const totalRow = (label, value, bold = false, big = false) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(bold ? INK : GRAY).fontSize(big ? 12 : 9.5)
         .text(label, tX, y, { width: tW * 0.55 });
      doc.font('Helvetica-Bold').fillColor(INK).fontSize(big ? 12 : 9.5)
         .text(value, tX + tW * 0.55, y, { width: tW * 0.45 - 10, align: 'right' });
      y += big ? 22 : 16;
    };
    totalRow('Taxable Value', rupees(invoice.taxable_value_paise));
    totalRow(`CGST @ ${(invoice.gst_rate_pct / 2)}%`, rupees(invoice.cgst_paise));
    totalRow(`SGST @ ${(invoice.gst_rate_pct / 2)}%`, rupees(invoice.sgst_paise));
    doc.moveTo(tX, y + 2).lineTo(R, y + 2).strokeColor(LINE).stroke();
    y += 8;
    doc.roundedRect(tX, y - 2, tW, 26, 4).fill(ALT);
    totalRow('Grand Total', rupees(invoice.total_paise), true, true);

    // ── Amount in words ──────────────────────────────────────────────────
    y += 8;
    doc.fillColor(GRAY).font('Helvetica').fontSize(9).text('Amount in words:', L, y);
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(9.5).text(amountInWords(invoice.total_paise), L, y + 13, { width: W });

    // ── Declaration / footer ─────────────────────────────────────────────
    y += 48;
    doc.roundedRect(L, y, W, 64, 6).fillAndStroke('#FFFFFF', LINE);
    doc.fillColor(GRAY).font('Helvetica').fontSize(8)
       .text('Price is inclusive of 18% GST (CGST 9% + SGST 9%). This is a computer-generated tax invoice and does not require a physical signature.', L + 12, y + 10, { width: W * 0.6 });
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(9)
       .text(`For ${seller.legal_name}`, L + W * 0.62, y + 12, { width: W * 0.36, align: 'right' });
    doc.fillColor(GRAY).font('Helvetica').fontSize(8)
       .text('Authorised Signatory', L + W * 0.62, y + 44, { width: W * 0.36, align: 'right' });

    // ── Footer bar ───────────────────────────────────────────────────────
    doc.rect(0, 802, 595, 40).fill(INK);
    doc.fillColor('#94A3B8').font('Helvetica').fontSize(8)
       .text(`${seller.email}  ·  ${seller.phone}  ·  ozonewash.in`, 0, 818, { align: 'center', width: 595 });

    doc.end();
  });
}

module.exports = { buildInvoicePDF, amountInWords };
