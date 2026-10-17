import { roomTaxRate, taxOn, taxSettings } from './money.js';
import { stayNights, addDays } from './dates.js';

/** Charges, payments and balance for a folio. `db` is pool helpers or a tx client. */
export async function folioTotals(db, folioId) {
  const c = await db.one(
    `SELECT COALESCE(SUM(amount_paise),0) AS subtotal, COALESCE(SUM(tax_paise),0) AS tax
       FROM folio_lines WHERE folio_id = $1 AND voided_at IS NULL`, [folioId]);
  const p = await db.one(
    `SELECT COALESCE(SUM(CASE WHEN kind IN ('payment','deposit') THEN amount_paise ELSE 0 END),0) AS paid,
            COALESCE(SUM(CASE WHEN kind = 'refund' THEN amount_paise ELSE 0 END),0) AS refunded
       FROM payments WHERE folio_id = $1 AND voided_at IS NULL`, [folioId]);
  const charges = c.subtotal + c.tax;
  const netPaid = p.paid - p.refunded;
  return {
    subtotal_paise: c.subtotal,
    tax_paise: c.tax,
    total_paise: charges,
    paid_paise: p.paid,
    refunded_paise: p.refunded,
    balance_paise: charges - netPaid, // >0 guest owes, <0 hotel owes guest
  };
}

/**
 * Post room-night charges for a stay for every night up to and including `uptoDate`
 * (capped at the last night of the stay). Idempotent via a partial unique index.
 */
export async function postRoomNights(db, hotel, stay, folioId, uptoDate, userId = null) {
  const lastNight = addDays(stay.check_out_date, -1);
  const until = uptoDate < lastNight ? uptoDate : lastNight;
  const ts = taxSettings(hotel);
  const roomNo = stay.room_number ? `Room ${stay.room_number}` : 'Room';
  const tariff = Number(stay.nightly_rate_paise) + Number(stay.extra_person_paise || 0);
  const rate = roomTaxRate(hotel, tariff);
  let posted = 0;
  for (const night of stayNights(stay.check_in_date, addDays(until, 1))) {
    const r = await db.query(
      `INSERT INTO folio_lines (hotel_id, folio_id, category, description, hsn_sac, quantity, unit_price_paise,
                                amount_paise, tax_rate, tax_paise, business_date, source_type, source_id, created_by)
       VALUES ($1,$2,'room',$3,$4,1,$5,$5,$6,$7,$8,'stay_night',$9,$10)
       ON CONFLICT (source_id, business_date) WHERE source_type = 'stay_night' AND voided_at IS NULL DO NOTHING`,
      [hotel.id, folioId, `${roomNo} — night of ${night}`, ts.room_sac, tariff, rate, taxOn(tariff, rate), night, stay.id, userId]);
    posted += r.rowCount;
  }
  return posted;
}

/** Load a folio with its lines, payments and totals. */
export async function loadFolio(db, hotelId, folioId) {
  const folio = await db.one(
    `SELECT f.*, g.full_name AS guest_name, g.phone AS guest_phone, g.email AS guest_email,
            s.check_in_date, s.check_out_date, s.status AS stay_status, r.number AS room_number, b.ref AS booking_ref
       FROM folios f
       LEFT JOIN guests g ON g.id = f.guest_id
       LEFT JOIN stays s ON s.id = f.stay_id
       LEFT JOIN rooms r ON r.id = s.room_id
       LEFT JOIN bookings b ON b.id = f.booking_id
      WHERE f.id = $1 AND f.hotel_id = $2`, [folioId, hotelId]);
  if (!folio) return null;
  folio.lines = await db.many(
    `SELECT l.*, u.name AS created_by_name, v.name AS voided_by_name
       FROM folio_lines l LEFT JOIN users u ON u.id = l.created_by LEFT JOIN users v ON v.id = l.voided_by
      WHERE l.folio_id = $1 ORDER BY l.business_date, l.id`, [folioId]);
  folio.payments = await db.many(
    `SELECT p.*, u.name AS received_by_name FROM payments p LEFT JOIN users u ON u.id = p.received_by
      WHERE p.folio_id = $1 ORDER BY p.id`, [folioId]);
  folio.totals = await folioTotals(db, folioId);
  return folio;
}

/** Tax breakup grouped by rate, split into CGST/SGST (intra-state) or IGST (inter-state). */
export function taxBreakup(lines, interState = false) {
  const byRate = {};
  for (const l of lines.filter((x) => !x.voided_at)) {
    const k = Number(l.tax_rate);
    byRate[k] ??= { rate: k, taxable_paise: 0, tax_paise: 0 };
    byRate[k].taxable_paise += Number(l.amount_paise);
    byRate[k].tax_paise += Number(l.tax_paise);
  }
  return Object.values(byRate).map((r) => interState
    ? { ...r, igst_paise: r.tax_paise }
    : { ...r, cgst_paise: Math.floor(r.tax_paise / 2), sgst_paise: r.tax_paise - Math.floor(r.tax_paise / 2) });
}

// Fee lines that a cancellation or no-show is allowed to leave on the bill.
export const FEE_SOURCES = ['cancellation_fee', 'no_show_fee'];

/**
 * A guest who never checked in never received anything that was pre-posted on the bill (laundry, food,
 * pickup…), so when the stay is cancelled or marked no-show those lines are voided, with a reason. Only a
 * cancellation / no-show fee (added after this) stays. Payments are untouched: an advance becomes credit to refund.
 * Returns { lines, amount_paise } voided. Closed (invoiced) bills are never changed.
 */
export async function voidUndeliveredCharges(db, stayId, userId, reason) {
  const rows = await db.many(
    `UPDATE folio_lines l SET voided_at = now(), voided_by = $2, void_reason = $3
       FROM folios f JOIN stays s ON s.id = f.stay_id
      WHERE f.stay_id = $1 AND l.folio_id = f.id AND f.status = 'open' AND s.checked_in_at IS NULL
        AND l.voided_at IS NULL AND COALESCE(l.source_type, '') <> ALL($4)
      RETURNING l.amount_paise`, [stayId, userId, reason, FEE_SOURCES]);
  return { lines: rows.length, amount_paise: rows.reduce((a, x) => a + Number(x.amount_paise), 0) };
}
