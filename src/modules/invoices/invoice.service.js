/**
 * Invoice service — issues GST tax invoices for paid bookings and AMC
 * contracts, on top of the (GST-inclusive) pricing engine.
 *
 * Responsibilities:
 *   - allocate a per-fiscal-year sequential invoice number (atomic)
 *   - split the GST-inclusive total into taxable value + CGST + SGST
 *   - snapshot the bill-to details and line items at issue time
 *   - render a PDF (invoice.pdf.js) → upload to R2 → store the URL
 *   - deliver the invoice (email + in-app feed), fire-and-forget
 *
 * Idempotent: one issued invoice per booking / per AMC contract. Safe to call
 * from every payment-success path (verify, easebuzz callback, webhook).
 *
 * All amounts are PAISE, GST-INCLUSIVE (matches services/pricing.js).
 */

const db = require('../../config/db');
const { exGstFromInc } = require('../../services/pricing');
const { buildInvoicePDF } = require('./invoice.pdf');
const { R2Service } = require('../../services/r2.service');
const NotificationService = require('../../services/notification.service');

/** Seller (issuer) details — GSTIN is env-driven; the rest is company-fixed. */
const SELLER = {
  legal_name: 'VijRam Health Sense Pvt. Ltd.',
  brand: 'Ozone Wash™',
  address: 'Flat No 201, Sai Krishna Thakur Residency, Padmaraonagar, Secunderabad, Hyderabad – 500025',
  cin: 'U96010TS2025PTC205265',
  gstin: process.env.SELLER_GSTIN || null,   // MUST be set before go-live for a valid tax invoice
  email: 'hello@ozonewash.in',
  phone: '+91 81 79 69 59 59',
  state: 'Telangana',
  state_code: '36',
};

const SAC_TANK = '998534';   // tank hygiene services
const SAC_AUTO = '998538';   // auto wash (reserved; auto-wash has its own cert flow)

/* ── Fiscal year (India: Apr 1 – Mar 31) ──────────────────────────────── */
function fiscalYearFor(date = new Date()) {
  // Derive year/month in IST (Asia/Kolkata) — the server may run in UTC
  // (Railway), which would put invoices issued late on Mar 31 / early Apr 1
  // into the wrong FY and number series.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: 'numeric',
  }).formatToParts(date);
  const y = Number(parts.find((p) => p.type === 'year').value);
  const m = Number(parts.find((p) => p.type === 'month').value) - 1; // 0 = Jan
  const startYear = m >= 3 ? y : y - 1;         // Apr (index 3) starts the FY
  const endYY = String((startYear + 1) % 100).padStart(2, '0');
  return `${startYear}-${endYY}`;               // e.g. 2026-27
}

/** Atomically allocate the next invoice number for the current fiscal year. */
async function allocateInvoiceNumber(client, fiscalYear) {
  const { rows } = await client.query(
    `INSERT INTO invoice_sequences (fiscal_year, last_seq)
       VALUES ($1, 1)
     ON CONFLICT (fiscal_year)
       DO UPDATE SET last_seq = invoice_sequences.last_seq + 1, updated_at = NOW()
     RETURNING last_seq`,
    [fiscalYear]
  );
  const seq = rows[0].last_seq;
  const invoice_number = `OW/${fiscalYear}/${String(seq).padStart(5, '0')}`;
  return { seq, invoice_number };
}

/* ── GST split from a GST-inclusive total ─────────────────────────────── */
function splitGst(totalPaise) {
  const total = Math.max(0, Math.round(Number(totalPaise) || 0));
  const taxable = exGstFromInc(total);
  const gst = total - taxable;
  const cgst = Math.round(gst / 2);
  const sgst = gst - cgst;
  return { taxable_value_paise: taxable, cgst_paise: cgst, sgst_paise: sgst, total_paise: total };
}

/* ── Line items from a booking's stored pricing quote ─────────────────── */
function lineItemsFromBooking(booking) {
  const p = booking.pricing || null;
  const items = [];
  const total = Number(booking.amount_paise) || 0;

  if (p && (p.annual_service_total_paise || p.per_service_total_paise)) {
    const svc = Number(p.annual_service_total_paise || p.per_service_total_paise) || 0;
    const planLabel = String(p.plan || booking.plan || 'one_time').replace(/_/g, '-');
    const spy = Number(p.services_per_year) || 1;
    const tanks = Number(p.tank_count) || (Array.isArray(booking.tanks) ? booking.tanks.length : 1);
    items.push({
      description: `Ozone tank hygiene — ${planLabel} plan (${tanks} tank${tanks > 1 ? 's' : ''}, ${spy} visit${spy > 1 ? 's' : ''}/yr)`,
      qty: 1,
      amount_paise: svc,
    });
    for (const a of (p.addons || [])) {
      if (a.price_paise == null) continue;
      items.push({ description: `Add-on — ${a.name}`, qty: 1, amount_paise: Number(a.price_paise) || 0 });
    }
  }

  // Fallback / reconciliation: if no priced lines or they don't sum to the
  // charged total, bill a single service line for the exact amount charged.
  const sum = items.reduce((s, i) => s + (Number(i.amount_paise) || 0), 0);
  if (!items.length || sum !== total) {
    return [{
      description: 'Ozone tank hygiene service',
      qty: 1,
      amount_paise: total,
    }];
  }
  return items;
}

/* ── Core: create (or return existing) invoice ────────────────────────── */

async function _fetchCustomer(customerId) {
  try {
    const { rows } = await db.query(
      `SELECT id, name, phone, email FROM users WHERE id = $1`, [customerId]
    );
    return rows[0] || {};
  } catch { return {}; }
}

async function _generateAndAttachPdf(invoice) {
  try {
    const buffer = await buildInvoicePDF({ invoice, seller: SELLER });
    const up = await R2Service.uploadFile(buffer, `invoice-${invoice.invoice_number.replace(/\//g, '-')}.pdf`, 'invoices');
    await db.query(
      `UPDATE invoices SET pdf_key = $1, pdf_url = $2, updated_at = NOW() WHERE id = $3`,
      [up.key, up.url, invoice.id]
    );
    invoice.pdf_key = up.key;
    invoice.pdf_url = up.url;
  } catch (e) {
    console.error('[invoice] PDF generation failed:', e?.message);
  }
  return invoice;
}

async function _deliver(invoice) {
  // Fire-and-forget — invoice delivery must never break the payment flow.
  const amount = (invoice.total_paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 });
  NotificationService.notifyUser(
    { id: invoice.customer_id, fcm_token: null },
    '🧾 Invoice ready',
    `Tax invoice ${invoice.invoice_number} for ₹${amount} is ready to download.`,
    { type: 'invoice_ready', invoice_id: invoice.id, invoice_number: invoice.invoice_number }
  ).catch(() => {});

  if (invoice.customer_email) {
    NotificationService.sendEmail(
      invoice.customer_email,
      `Your Ozone Wash tax invoice ${invoice.invoice_number}`,
      `<h2>Tax Invoice ${invoice.invoice_number}</h2>
       <p>Dear ${invoice.customer_name || 'Customer'},</p>
       <p>Thank you for your payment. Your GST tax invoice for <strong>₹${amount}</strong> is attached/available in the app.</p>
       ${invoice.pdf_url ? `<p><a href="${invoice.pdf_url}">Download your invoice (PDF)</a></p>` : ''}
       <p>SAC ${invoice.sac_code} · GST ${invoice.gst_rate_pct}% · ${SELLER.legal_name}</p>
       <br/><p>Team Ozone Wash</p>`
    ).catch(() => {});
  }
}

/**
 * Issue a tax invoice for a paid booking. Idempotent.
 * @param {string} bookingId
 * @param {{ gateway?: string, payment_ref?: string }} pay
 */
async function createInvoiceForBooking(bookingId, pay = {}) {
  const existing = await db.query(
    `SELECT * FROM invoices WHERE booking_id = $1 AND status = 'issued' LIMIT 1`, [bookingId]
  );
  if (existing.rows.length) return existing.rows[0];

  const bq = await db.query(
    `SELECT b.*, u.name AS customer_name, u.phone AS customer_phone, u.email AS customer_email
       FROM bookings b JOIN users u ON u.id = b.customer_id
      WHERE b.id = $1`, [bookingId]
  );
  const booking = bq.rows[0];
  if (!booking) throw { status: 404, message: 'Booking not found for invoicing' };

  // Normalise JSONB that may arrive as string
  if (typeof booking.pricing === 'string') { try { booking.pricing = JSON.parse(booking.pricing); } catch { booking.pricing = null; } }
  if (typeof booking.tanks === 'string')   { try { booking.tanks = JSON.parse(booking.tanks); } catch { booking.tanks = null; } }

  const tax = splitGst(booking.amount_paise);
  const items = lineItemsFromBooking(booking);
  const fiscalYear = fiscalYearFor();

  const client = await db.pool.connect();
  let invoice;
  try {
    await client.query('BEGIN');
    const { seq, invoice_number } = await allocateInvoiceNumber(client, fiscalYear);
    const ins = await client.query(
      `INSERT INTO invoices (
         invoice_number, fiscal_year, seq, source_type, booking_id, customer_id,
         customer_name, customer_phone, customer_email, billing_address,
         sac_code, place_of_supply, gst_rate_pct, line_items,
         taxable_value_paise, cgst_paise, sgst_paise, total_paise,
         payment_gateway, payment_ref, payment_status
       ) VALUES ($1,$2,$3,'booking',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'paid')
       RETURNING *`,
      [
        invoice_number, fiscalYear, seq, bookingId, booking.customer_id,
        booking.customer_name, booking.customer_phone, booking.customer_email, booking.address,
        SAC_TANK, `${SELLER.state} (${SELLER.state_code})`, 18.0, JSON.stringify(items),
        tax.taxable_value_paise, tax.cgst_paise, tax.sgst_paise, tax.total_paise,
        pay.gateway || null, pay.payment_ref || null,
      ]
    );
    await client.query('COMMIT');
    invoice = ins.rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    // Unique-index race: another path issued it first — return that one.
    if (e && e.code === '23505') {
      const again = await db.query(`SELECT * FROM invoices WHERE booking_id = $1 AND status = 'issued' LIMIT 1`, [bookingId]);
      if (again.rows.length) return again.rows[0];
    }
    throw e;
  } finally {
    client.release();
  }

  await _generateAndAttachPdf(invoice);
  await _deliver(invoice);
  return invoice;
}

/**
 * Issue a tax invoice for a paid AMC contract. Idempotent.
 * @param {string} contractId
 * @param {{ gateway?: string, payment_ref?: string }} pay
 */
async function createInvoiceForAmc(contractId, pay = {}) {
  const existing = await db.query(
    `SELECT * FROM invoices WHERE amc_contract_id = $1 AND status = 'issued' LIMIT 1`, [contractId]
  );
  if (existing.rows.length) return existing.rows[0];

  const cq = await db.query(
    `SELECT c.*, u.name AS customer_name, u.phone AS customer_phone, u.email AS customer_email
       FROM amc_contracts c JOIN users u ON u.id = c.customer_id
      WHERE c.id = $1`, [contractId]
  );
  const contract = cq.rows[0];
  if (!contract) throw { status: 404, message: 'Contract not found for invoicing' };

  const spy = Number(contract.services_per_year) || 1;
  const items = [{
    description: `Ozone Wash AMC — ${String(contract.plan_type || '').replace(/_/g, '-')} plan (${spy} scheduled visit${spy > 1 ? 's' : ''}/yr)`,
    qty: 1,
    amount_paise: Number(contract.amount_paise) || 0,
  }];
  const tax = splitGst(contract.amount_paise);
  const fiscalYear = fiscalYearFor();

  const client = await db.pool.connect();
  let invoice;
  try {
    await client.query('BEGIN');
    const { seq, invoice_number } = await allocateInvoiceNumber(client, fiscalYear);
    const ins = await client.query(
      `INSERT INTO invoices (
         invoice_number, fiscal_year, seq, source_type, amc_contract_id, customer_id,
         customer_name, customer_phone, customer_email,
         sac_code, place_of_supply, gst_rate_pct, line_items,
         taxable_value_paise, cgst_paise, sgst_paise, total_paise,
         payment_gateway, payment_ref, payment_status
       ) VALUES ($1,$2,$3,'amc',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'paid')
       RETURNING *`,
      [
        invoice_number, fiscalYear, seq, contractId, contract.customer_id,
        contract.customer_name, contract.customer_phone, contract.customer_email,
        SAC_TANK, `${SELLER.state} (${SELLER.state_code})`, 18.0, JSON.stringify(items),
        tax.taxable_value_paise, tax.cgst_paise, tax.sgst_paise, tax.total_paise,
        pay.gateway || null, pay.payment_ref || null,
      ]
    );
    await client.query('COMMIT');
    invoice = ins.rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    if (e && e.code === '23505') {
      const again = await db.query(`SELECT * FROM invoices WHERE amc_contract_id = $1 AND status = 'issued' LIMIT 1`, [contractId]);
      if (again.rows.length) return again.rows[0];
    }
    throw e;
  } finally {
    client.release();
  }

  await _generateAndAttachPdf(invoice);
  await _deliver(invoice);
  return invoice;
}

/* ── Reads ────────────────────────────────────────────────────────────── */
async function getById(id) {
  const { rows } = await db.query(`SELECT * FROM invoices WHERE id = $1`, [id]);
  return rows[0] || null;
}

/** Re-render + re-upload the PDF for an existing invoice (admin repair). */
async function regeneratePdf(id) {
  const inv = await getById(id);
  if (!inv) throw { status: 404, message: 'Invoice not found' };
  await _generateAndAttachPdf(inv);
  return inv;
}

async function listForCustomer(customerId) {
  const { rows } = await db.query(
    `SELECT id, invoice_number, source_type, booking_id, amc_contract_id,
            total_paise, taxable_value_paise, cgst_paise, sgst_paise,
            sac_code, status, pdf_url, issued_at
       FROM invoices
      WHERE customer_id = $1 AND status = 'issued'
      ORDER BY issued_at DESC`, [customerId]
  );
  return rows;
}

async function listAll({ from, to, limit = 200 } = {}) {
  const where = [`status = 'issued'`];
  const params = [];
  let i = 1;
  if (from) { where.push(`issued_at >= $${i++}`); params.push(from); }
  if (to)   { where.push(`issued_at < ($${i++}::date + INTERVAL '1 day')`); params.push(to); }
  params.push(Math.min(1000, Number(limit) || 200));
  const { rows } = await db.query(
    `SELECT id, invoice_number, source_type, customer_name, customer_phone,
            total_paise, taxable_value_paise, cgst_paise, sgst_paise,
            sac_code, payment_gateway, pdf_url, issued_at
       FROM invoices
      WHERE ${where.join(' AND ')}
      ORDER BY issued_at DESC
      LIMIT $${i}`, params
  );
  return rows;
}

/**
 * GST settlement summary for a period — the numbers an accountant needs for a
 * GSTR filing: taxable value, CGST, SGST, total, and invoice count, plus a
 * daily breakdown.
 */
async function taxSummary({ from, to } = {}) {
  const params = [];
  let i = 1;
  const where = [`status = 'issued'`];
  if (from) { where.push(`issued_at >= $${i++}`); params.push(from); }
  if (to)   { where.push(`issued_at < ($${i++}::date + INTERVAL '1 day')`); params.push(to); }
  const clause = where.join(' AND ');

  const totalsQ = await db.query(
    `SELECT COUNT(*)::int AS invoice_count,
            COALESCE(SUM(taxable_value_paise),0)::bigint AS taxable_value_paise,
            COALESCE(SUM(cgst_paise),0)::bigint AS cgst_paise,
            COALESCE(SUM(sgst_paise),0)::bigint AS sgst_paise,
            COALESCE(SUM(total_paise),0)::bigint AS total_paise
       FROM invoices WHERE ${clause}`, params
  );
  const byDayQ = await db.query(
    `SELECT to_char(issued_at, 'YYYY-MM-DD') AS day,
            COUNT(*)::int AS invoice_count,
            COALESCE(SUM(taxable_value_paise),0)::bigint AS taxable_value_paise,
            COALESCE(SUM(cgst_paise),0)::bigint AS cgst_paise,
            COALESCE(SUM(sgst_paise),0)::bigint AS sgst_paise,
            COALESCE(SUM(total_paise),0)::bigint AS total_paise
       FROM invoices WHERE ${clause}
      GROUP BY day ORDER BY day DESC`, params
  );
  const bySacQ = await db.query(
    `SELECT sac_code,
            COUNT(*)::int AS invoice_count,
            COALESCE(SUM(taxable_value_paise),0)::bigint AS taxable_value_paise,
            COALESCE(SUM(cgst_paise),0)::bigint AS cgst_paise,
            COALESCE(SUM(sgst_paise),0)::bigint AS sgst_paise,
            COALESCE(SUM(total_paise),0)::bigint AS total_paise
       FROM invoices WHERE ${clause}
      GROUP BY sac_code ORDER BY sac_code`, params
  );

  return {
    period: { from: from || null, to: to || null },
    gst_rate_pct: 18,
    totals: totalsQ.rows[0],
    by_day: byDayQ.rows,
    by_sac: bySacQ.rows,
    seller_gstin: SELLER.gstin,
  };
}

module.exports = {
  SELLER, SAC_TANK, SAC_AUTO,
  fiscalYearFor, splitGst,
  createInvoiceForBooking, createInvoiceForAmc,
  getById, listForCustomer, listAll, taxSummary, regeneratePdf,
};
