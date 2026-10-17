import { Router } from 'express';
import { z } from 'zod';
import { one, many, tx } from '../db.js';
import { parse, idParam } from '../lib/validate.js';
import { requireStaff, requirePerm, assertPerm } from '../middleware/auth.js';
import { notFound, badRequest, conflict } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { loadFolio, folioTotals, taxBreakup } from '../lib/folio.js';
import { taxOn, taxSettings } from '../lib/money.js';
import { hotelToday } from '../lib/dates.js';
import { nextInvoiceNo } from '../lib/sequences.js';

const r = Router();
r.use('/folios', requireStaff);

const METHODS = ['cash', 'card', 'upi', 'online', 'bank_transfer', 'other'];

async function getOpenFolio(db, hotelId, id, lock = true) {
  const f = await db.one(`SELECT * FROM folios WHERE id = $1 AND hotel_id = $2 ${lock ? 'FOR UPDATE' : ''}`, [id, hotelId]);
  if (!f) throw notFound('Bill not found');
  return f;
}
const assertOpen = (f) => { if (f.status !== 'open') throw conflict('This bill is closed and invoiced. Changes are not allowed.'); };

/** Close a folio and assign a GST invoice number. Used by checkout and the invoice endpoint. */
export async function issueInvoice(db, req, folioId) {
  const f = await getOpenFolio(db, req.hotelId, folioId);
  if (f.status === 'closed') return { invoice_no: f.invoice_no };
  const totals = await folioTotals(db, folioId);
  if (totals.balance_paise > 0) throw conflict('Settle the pending balance before issuing the final invoice');
  const lines = await db.one(`SELECT count(*)::int AS n FROM folio_lines WHERE folio_id = $1 AND voided_at IS NULL`, [folioId]);
  let invoiceNo = null;
  if (lines.n > 0) invoiceNo = await nextInvoiceNo(db, req.hotelId);
  await db.query(`UPDATE folios SET status = 'closed', invoice_no = $1, invoiced_at = now(), closed_by = $2 WHERE id = $3`,
    [invoiceNo, req.user.id, folioId]);
  await audit(req, 'folio.invoiced', 'folio', folioId, { invoice_no: invoiceNo, total_paise: totals.total_paise }, db);
  return { invoice_no: invoiceNo };
}

r.get('/folios', requirePerm('folio.view'), async (req, res) => {
  // Open folios with outstanding balances (receivables)
  const rows = await many(
    `SELECT f.id, f.kind, f.status, f.invoice_no, f.created_at, g.full_name AS guest_name, b.ref AS booking_ref, s.status AS stay_status,
            r.number AS room_number,
            COALESCE((SELECT SUM(amount_paise + tax_paise) FROM folio_lines l WHERE l.folio_id = f.id AND l.voided_at IS NULL),0)
          - COALESCE((SELECT SUM(CASE WHEN kind = 'refund' THEN -amount_paise ELSE amount_paise END) FROM payments p WHERE p.folio_id = f.id AND p.voided_at IS NULL),0)
            AS balance_paise
       FROM folios f LEFT JOIN guests g ON g.id = f.guest_id LEFT JOIN bookings b ON b.id = f.booking_id
       LEFT JOIN stays s ON s.id = f.stay_id LEFT JOIN rooms r ON r.id = s.room_id
      WHERE f.hotel_id = $1 AND ($2::text IS NULL OR f.status = $2)
      ORDER BY f.id DESC LIMIT 300`, [req.hotelId, req.query.status || null]);
  // "Balance pending" is money owed by guests who have stayed (or a restaurant bill). A reservation whose guest
  // has not checked in yet is not owed money; its bill stays visible under "Open bills".
  res.json(req.query.outstanding
    ? rows.filter((x) => x.balance_paise !== 0 && !['tentative', 'reserved'].includes(x.stay_status))
    : rows);
});

r.get('/folios/:id', requirePerm('folio.view'), async (req, res) => {
  const f = await loadFolio({ one, many }, req.hotelId, idParam(req.params.id));
  if (!f) throw notFound();
  res.json(f);
});

// SAC for manual charges when the staff did not type one.
function defaultSac(ts, category, description = '') {
  if (category === 'food') return ts.food_sac;
  if (category === 'extra_person') return ts.room_sac;
  if (/laundry|dry ?clean|wash|iron|press/i.test(description)) return '999711'; // washing, cleaning and dyeing services
  return ts.service_sac;
}

// Manual charge (extra bed, laundry, minibar, etc.)
r.post('/folios/:id/charges', requirePerm('folio.charge'), async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(z.object({
    category: z.enum(['service', 'extra', 'food', 'extra_person']).default('extra'),
    description: z.string().min(2),
    quantity: z.number().positive().default(1),
    unit_price_paise: z.number().int().positive(),
    tax_rate: z.number().min(0).max(40).optional(),
    hsn_sac: z.string().optional(),
  }), req.body);
  const ts = taxSettings(req.hotel);
  const rate = b.tax_rate ?? (b.category === 'food' ? ts.food_rate : ts.service_rate);
  const sac = b.hsn_sac || defaultSac(ts, b.category, b.description);
  const amount = Math.round(b.unit_price_paise * b.quantity);
  const line = await tx(async (db) => {
    const f = await getOpenFolio(db, req.hotelId, id); assertOpen(f);
    const l = await db.one(
      `INSERT INTO folio_lines (hotel_id, folio_id, category, description, hsn_sac, quantity, unit_price_paise, amount_paise,
                                tax_rate, tax_paise, business_date, source_type, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'manual',$12) RETURNING *`,
      [req.hotelId, id, b.category, b.description, sac, b.quantity, b.unit_price_paise, amount, rate, taxOn(amount, rate),
        hotelToday(req.hotel.timezone), req.user.id]);
    await audit(req, 'folio.charge_added', 'folio', id, { line_id: l.id, amount_paise: amount, description: b.description }, db);
    return l;
  });
  res.status(201).json(line);
});

// Discount: recorded as a negative line, never by editing existing charges
r.post('/folios/:id/discount', requirePerm('folio.discount'), async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(z.object({
    reason: z.string().min(2),
    amount_paise: z.number().int().positive().optional(),
    percent: z.number().positive().max(100).optional(),
    apply_to: z.enum(['room', 'all']).default('all'),
  }).refine((x) => x.amount_paise || x.percent, 'Give an amount or percent'), req.body);
  const line = await tx(async (db) => {
    const f = await getOpenFolio(db, req.hotelId, id); assertOpen(f);
    const lines = await db.many(
      `SELECT amount_paise, tax_rate, category FROM folio_lines WHERE folio_id = $1 AND voided_at IS NULL AND category <> 'discount'`, [id]);
    const base = lines.filter((l) => b.apply_to === 'all' || l.category === 'room');
    const baseAmt = base.reduce((a, l) => a + l.amount_paise, 0);
    if (baseAmt <= 0) throw badRequest('Nothing to discount');
    const amt = b.amount_paise ?? Math.round((baseAmt * b.percent) / 100);
    if (amt > baseAmt) throw badRequest('Discount exceeds the charges');
    // A discount reduces the taxable value of each charge at that charge's own GST rate, so it is split per rate
    // (e.g. 5% and 18%) instead of being booked at a made-up blended rate.
    const byRate = new Map();
    for (const x of base) byRate.set(Number(x.tax_rate), (byRate.get(Number(x.tax_rate)) || 0) + x.amount_paise);
    const groups = [...byRate.entries()].sort((a, c) => a[0] - c[0]);
    const shares = groups.map(([rate, amount]) => ({ rate, amount, share: Math.floor((amt * amount) / baseAmt) }));
    let left = amt - shares.reduce((a, x) => a + x.share, 0);
    for (const x of [...shares].sort((a, c) => c.amount - a.amount)) { if (left <= 0) break; x.share += 1; left -= 1; }
    const created = [];
    for (const x of shares.filter((y) => y.share > 0)) {
      created.push(await db.one(
        `INSERT INTO folio_lines (hotel_id, folio_id, category, description, quantity, unit_price_paise, amount_paise, tax_rate, tax_paise,
                                  business_date, source_type, created_by)
         VALUES ($1,$2,'discount',$3,1,$4,$4,$5,$6,$7,'manual',$8) RETURNING *`,
        [req.hotelId, id, `Discount — ${b.reason}${shares.length > 1 ? ` (${x.rate}% items)` : ''}`, -x.share, x.rate, -taxOn(x.share, x.rate),
          hotelToday(req.hotel.timezone), req.user.id]));
    }
    const l = { ...created[0], lines: created };
    await audit(req, 'folio.discount', 'folio', id,
      { line_id: l.id, amount_paise: amt, percent: b.percent ?? Math.round((amt / baseAmt) * 10000) / 100, reason: b.reason }, db);
    return l;
  });
  res.status(201).json(line);
});

r.post('/folios/:id/lines/:lineId/void', requirePerm('folio.void'), async (req, res) => {
  const id = idParam(req.params.id); const lineId = idParam(req.params.lineId);
  const b = parse(z.object({ reason: z.string().min(3) }), req.body);
  const line = await tx(async (db) => {
    const f = await getOpenFolio(db, req.hotelId, id); assertOpen(f);
    const l = await db.one(
      `UPDATE folio_lines SET voided_at = now(), voided_by = $1, void_reason = $2
        WHERE id = $3 AND folio_id = $4 AND voided_at IS NULL RETURNING *`, [req.user.id, b.reason, lineId, id]);
    if (!l) throw notFound('Line not found or already voided');
    if (l.source_type === 'order') await db.query(`UPDATE orders SET settlement = 'unsettled' WHERE id = $1`, [l.source_id]);
    await audit(req, 'folio.line_voided', 'folio', id, { line_id: lineId, amount_paise: l.amount_paise, description: l.description, reason: b.reason }, db);
    return l;
  });
  res.json(line);
});

r.post('/folios/:id/payments', requirePerm('payments.record'), async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(z.object({
    kind: z.enum(['payment', 'deposit', 'refund']).default('payment'),
    method: z.enum(METHODS), amount_paise: z.number().int().positive(),
    reference: z.string().optional().nullable(), notes: z.string().optional().nullable(),
  }), req.body);
  if (b.kind === 'refund') assertPerm(req, 'payments.refund', 'You are not allowed to issue refunds');
  const p = await tx(async (db) => {
    const f = await getOpenFolio(db, req.hotelId, id);
    // Payments against a closed folio are allowed only to clear an outstanding balance (receivable)
    const totals = await folioTotals(db, id);
    if (b.kind === 'refund') {
      const netPaid = totals.paid_paise - totals.refunded_paise;
      if (b.amount_paise > netPaid) throw badRequest('Refund cannot exceed the amount paid');
      if (!b.notes && !b.reference) throw badRequest('Add a note or reference for the refund');
    } else if (f.status === 'closed' && b.amount_paise > totals.balance_paise) {
      throw badRequest('Bill is closed; payment exceeds the outstanding balance');
    }
    const row = await db.one(
      `INSERT INTO payments (hotel_id, folio_id, kind, method, amount_paise, reference, notes, received_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.hotelId, id, b.kind, b.method, b.amount_paise, b.reference, b.notes, req.user.id]);
    await audit(req, `payment.${b.kind}`, 'folio', id, { payment_id: row.id, method: b.method, amount_paise: b.amount_paise }, db);
    return row;
  });
  res.status(201).json(p);
});

r.post('/folios/:id/payments/:pid/void', requirePerm('payments.void'), async (req, res) => {
  const id = idParam(req.params.id); const pid = idParam(req.params.pid);
  const b = parse(z.object({ reason: z.string().min(3) }), req.body);
  const p = await tx(async (db) => {
    const f = await getOpenFolio(db, req.hotelId, id); assertOpen(f);
    const row = await db.one(
      `UPDATE payments SET voided_at = now(), voided_by = $1, void_reason = $2 WHERE id = $3 AND folio_id = $4 AND voided_at IS NULL RETURNING *`,
      [req.user.id, b.reason, pid, id]);
    if (!row) throw notFound('Payment not found or already voided');
    await audit(req, 'payment.voided', 'folio', id, { payment_id: pid, amount_paise: row.amount_paise, reason: b.reason }, db);
    return row;
  });
  res.json(p);
});

r.put('/folios/:id/bill-to', requirePerm('folio.charge'), async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(z.object({ bill_to_name: z.string().nullable(), bill_to_gstin: z.string().regex(/^[0-9A-Z]{15}$/).nullable().or(z.literal('')) }), req.body);
  const f = await getOpenFolio({ one }, req.hotelId, id, false); assertOpen(f);
  await one(`UPDATE folios SET bill_to_name = $1, bill_to_gstin = $2 WHERE id = $3 RETURNING id`, [b.bill_to_name, b.bill_to_gstin || null, id]);
  res.json({ ok: true });
});

r.post('/folios/:id/invoice', requirePerm('invoice.issue'), async (req, res) => {
  const id = idParam(req.params.id);
  const inv = await tx((db) => issueInvoice(db, req, id));
  res.json(inv);
});

// Printable invoice data (works for open folios as a proforma, closed ones as a tax invoice)
r.get('/folios/:id/invoice', requirePerm('folio.view'), async (req, res) => {
  const f = await loadFolio({ one, many }, req.hotelId, idParam(req.params.id));
  if (!f) throw notFound();
  const h = req.hotel;
  const guest = f.guest_id ? await one('SELECT company_name, company_gstin FROM guests WHERE id = $1', [f.guest_id]) : null;
  const guestGstin = f.bill_to_gstin || guest?.company_gstin || null;
  // With a company GSTIN the invoice is made out to the company, not the person who stays.
  const billName = f.bill_to_name || (guestGstin && guest?.company_name) || f.guest_name;
  const hotelState = h.state_code || (h.gstin ? h.gstin.slice(0, 2) : null);
  const interState = !!(guestGstin && hotelState && guestGstin.slice(0, 2) !== hotelState);
  const live = f.lines.filter((l) => !l.voided_at);
  res.json({
    type: f.status === 'closed' ? 'TAX INVOICE' : 'PROFORMA / INTERIM BILL',
    hotel: { name: h.name, legal_name: h.legal_name, gstin: h.gstin, address: h.address, city: h.city, state: h.state,
      state_code: h.state_code, phone: h.phone, email: h.email, footer: h.settings?.invoice_footer },
    invoice_no: f.invoice_no, invoiced_at: f.invoiced_at,
    bill_to: { name: billName, gstin: guestGstin, phone: f.guest_phone, guest_name: billName !== f.guest_name ? f.guest_name : null },
    stay: f.stay_id ? { room: f.room_number, check_in: f.check_in_date, check_out: f.check_out_date, booking_ref: f.booking_ref } : null,
    lines: live, payments: f.payments.filter((p) => !p.voided_at), totals: f.totals,
    tax_breakup: taxBreakup(live, interState), inter_state: interState,
    disclaimer: 'GST fields are configurable; validate tax settings with your accountant.',
  });
});

export default r;
