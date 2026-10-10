import { Router } from 'express';
import { z } from 'zod';
import { one, many, tx } from '../db.js';
import { parse, idParam } from '../lib/validate.js';
import { requireStaff, requirePerm, assertPerm, can } from '../middleware/auth.js';
import { notFound, badRequest, conflict } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { nextBookingRef } from '../lib/sequences.js';
import { hotelToday, addDays, DATE_RE, nightsBetween } from '../lib/dates.js';
import { postRoomNights, folioTotals, loadFolio } from '../lib/folio.js';
import { guestSchema, createGuest } from './guests.js';
import { issueInvoice } from './folios.js';
import { queueNotification } from '../lib/notify.js';

const r = Router();
r.use(['/bookings', '/stays', '/calendar', '/frontdesk', '/availability'], requireStaff);

const date = z.string().regex(DATE_RE, 'Use YYYY-MM-DD');

// ---------------------------------------------------------------
// Availability
// ---------------------------------------------------------------
/**
 * Per room type: sellable rooms, rooms booked in [from,to), and the specific free rooms.
 * Unallocated stays (no room yet) still consume type inventory, preventing overbooking.
 */
export async function availability(db, hotelId, from, to, excludeStayId = null) {
  const types = await db.many(
    `SELECT rt.id, rt.name, rt.base_rate_paise, rt.extra_person_rate_paise, rt.base_occupancy, rt.max_occupancy, rt.amenities, rt.description,
            (SELECT count(*)::int FROM rooms r WHERE r.room_type_id = rt.id AND r.active AND r.hk_status <> 'out_of_order') AS total_rooms,
            (SELECT count(*)::int FROM stays s WHERE s.room_type_id = rt.id AND s.status IN ('reserved','checked_in')
                AND s.check_in_date < $3 AND s.check_out_date > $2 AND ($4::bigint IS NULL OR s.id <> $4)) AS booked
       FROM room_types rt WHERE rt.hotel_id = $1 AND rt.active ORDER BY rt.base_rate_paise`, [hotelId, from, to, excludeStayId]);
  const freeRooms = await db.many(
    `SELECT r.id, r.number, r.floor, r.room_type_id, r.hk_status FROM rooms r
      WHERE r.hotel_id = $1 AND r.active AND r.hk_status <> 'out_of_order'
        AND NOT EXISTS (SELECT 1 FROM stays s WHERE s.room_id = r.id AND s.status IN ('reserved','checked_in')
                         AND s.check_in_date < $3 AND s.check_out_date > $2 AND ($4::bigint IS NULL OR s.id <> $4))
      ORDER BY r.number`, [hotelId, from, to, excludeStayId]);
  return types.map((t) => ({
    ...t,
    available: Math.max(0, t.total_rooms - t.booked),
    free_rooms: freeRooms.filter((x) => x.room_type_id === t.id),
  }));
}

r.get('/availability', requirePerm('bookings.view'), async (req, res) => {
  const from = parse(date, req.query.from);
  const to = parse(date, req.query.to);
  if (to <= from) throw badRequest('Check-out must be after check-in');
  res.json(await availability({ many }, req.hotelId, from, to));
});

// ---------------------------------------------------------------
// Create booking
// ---------------------------------------------------------------
const stayInput = z.object({
  room_type_id: z.number().int(),
  room_id: z.number().int().nullable().optional(),
  check_in_date: date,
  check_out_date: date,
  adults: z.number().int().min(1).default(1),
  children: z.number().int().min(0).default(0),
  nightly_rate_paise: z.number().int().min(0).optional(),
  guest_id: z.number().int().optional(),
  guest: guestSchema.optional(), // individual guest for group bookings
});

const bookingInput = z.object({
  guest_id: z.number().int().optional(),
  guest: guestSchema.optional(),
  source: z.enum(['walk_in', 'phone', 'direct_online', 'staff', 'ota', 'corporate', 'other']).default('staff'),
  status: z.enum(['requested', 'confirmed']).default('confirmed'),
  special_requests: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  group_name: z.string().optional().nullable(),
  stays: z.array(stayInput).min(1).max(50),
  deposit: z.object({
    amount_paise: z.number().int().positive(),
    method: z.enum(['cash', 'card', 'upi', 'online', 'bank_transfer', 'other']),
    reference: z.string().optional().nullable(),
  }).optional(),
  check_in_now: z.boolean().default(false), // walk-in convenience
}).refine((b) => b.guest_id || b.guest, { message: 'Guest is required', path: ['guest'] });

/** Validate one stay against room type/room and compute pricing. Throws on problems. */
async function prepareStay(db, req, s, excludeStayId = null) {
  if (s.check_out_date <= s.check_in_date) throw badRequest('Check-out must be after check-in');
  if (nightsBetween(s.check_in_date, s.check_out_date) > 90) throw badRequest('Stays longer than 90 nights are not supported');
  const rt = await db.one('SELECT * FROM room_types WHERE id = $1 AND hotel_id = $2 AND active', [s.room_type_id, req.hotelId]);
  if (!rt) throw badRequest('Unknown room type');
  if (s.adults + (s.children || 0) > rt.max_occupancy) throw badRequest(`${rt.name} allows max ${rt.max_occupancy} guests`);
  if (s.room_id) {
    const room = await db.one('SELECT * FROM rooms WHERE id = $1 AND hotel_id = $2 AND active', [s.room_id, req.hotelId]);
    if (!room) throw badRequest('Unknown room');
    if (room.room_type_id !== rt.id) throw badRequest(`Room ${room.number} is not a ${rt.name}`);
    if (room.hk_status === 'out_of_order') throw conflict(`Room ${room.number} is out of order`);
    const clash = await db.one(
      `SELECT s.id, b.ref FROM stays s JOIN bookings b ON b.id = s.booking_id
        WHERE s.room_id = $1 AND s.status IN ('reserved','checked_in') AND s.check_in_date < $3 AND s.check_out_date > $2
          AND ($4::bigint IS NULL OR s.id <> $4) LIMIT 1`, [s.room_id, s.check_in_date, s.check_out_date, excludeStayId]);
    if (clash) throw conflict(`Room ${room.number} is already booked on these dates (booking ${clash.ref})`);
  } else {
    const avail = await availability(db, req.hotelId, s.check_in_date, s.check_out_date, excludeStayId);
    const t = avail.find((a) => a.id === rt.id);
    if (!t || t.available < 1) throw conflict(`No ${rt.name} rooms available for these dates`);
  }
  const rate = s.nightly_rate_paise ?? rt.base_rate_paise;
  if (rate !== rt.base_rate_paise) assertPerm(req, 'rates.override', 'You are not allowed to change the room rate');
  const extraPersons = Math.max(0, s.adults - rt.base_occupancy);
  return { rt, rate, extra: extraPersons * rt.extra_person_rate_paise };
}

r.post('/bookings', requirePerm('bookings.create'), async (req, res) => {
  const b = parse(bookingInput, req.body);
  const today = hotelToday(req.hotel.timezone);
  const result = await tx(async (db) => {
    let guestId = b.guest_id;
    if (guestId) {
      if (!(await db.one('SELECT id FROM guests WHERE id = $1 AND hotel_id = $2', [guestId, req.hotelId]))) throw badRequest('Unknown guest');
    } else {
      guestId = (await createGuest(db, req.hotelId, b.guest)).id;
    }
    // Same room requested twice in one booking with overlapping dates
    const seen = b.stays.filter((s) => s.room_id);
    for (let i = 0; i < seen.length; i++) for (let j = i + 1; j < seen.length; j++) {
      if (seen[i].room_id === seen[j].room_id && seen[i].check_in_date < seen[j].check_out_date && seen[j].check_in_date < seen[i].check_out_date) {
        throw conflict('The same room is selected twice for overlapping dates');
      }
    }
    const ref = await nextBookingRef(db, req.hotelId);
    const booking = await db.one(
      `INSERT INTO bookings (hotel_id, ref, guest_id, source, status, special_requests, notes, group_name, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.hotelId, ref, guestId, b.source, b.status, b.special_requests, b.notes, b.group_name, req.user.id]);
    const stays = [];
    for (const s of b.stays) {
      const { rate, extra } = await prepareStay(db, req, s);
      let stayGuest = s.guest_id || guestId;
      if (s.guest) stayGuest = (await createGuest(db, req.hotelId, s.guest)).id;
      const stay = await db.one(
        `INSERT INTO stays (hotel_id, booking_id, guest_id, room_type_id, room_id, check_in_date, check_out_date,
                            adults, children, nightly_rate_paise, extra_person_paise, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [req.hotelId, booking.id, stayGuest, s.room_type_id, s.room_id || null, s.check_in_date, s.check_out_date,
          s.adults, s.children, rate, extra, b.status === 'requested' ? 'tentative' : 'reserved']);
      const folio = await db.one(
        `INSERT INTO folios (hotel_id, kind, stay_id, booking_id, guest_id) VALUES ($1,'stay',$2,$3,$4) RETURNING id`,
        [req.hotelId, stay.id, booking.id, stayGuest]);
      stays.push({ ...stay, folio_id: folio.id });
    }
    if (b.deposit) {
      assertPerm(req, 'payments.record');
      await db.query(
        `INSERT INTO payments (hotel_id, folio_id, kind, method, amount_paise, reference, received_by)
         VALUES ($1,$2,'deposit',$3,$4,$5,$6)`,
        [req.hotelId, stays[0].folio_id, b.deposit.method, b.deposit.amount_paise, b.deposit.reference, req.user.id]);
    }
    await audit(req, 'booking.created', 'booking', booking.id,
      { ref, stays: stays.length, source: b.source, deposit_paise: b.deposit?.amount_paise || 0 }, db);
    return { booking, stays };
  });

  const warnings = [];
  if (b.check_in_now && b.status === 'confirmed') {
    for (const s of result.stays) {
      if (s.check_in_date !== today || !s.room_id) continue;
      try { await checkIn(req, s.id, {}); } catch (e) { warnings.push(`Booking saved but check-in failed: ${e.message}`); }
    }
  }
  const g = await one('SELECT full_name, phone, email FROM guests WHERE id = $1', [result.booking.guest_id]);
  if (b.status === 'confirmed') {
    await queueNotification(req.hotelId, g, 'booking_confirmation', {
      ref: result.booking.ref, hotel: req.hotel.name, check_in: result.stays[0].check_in_date, check_out: result.stays[0].check_out_date,
    });
  }
  res.status(201).json({ ...(await loadBooking(req.hotelId, result.booking.id)), warnings });
});

// ---------------------------------------------------------------
// Read
// ---------------------------------------------------------------
async function loadBooking(hotelId, id) {
  const booking = await one(
    `SELECT b.*, g.full_name AS guest_name, g.phone AS guest_phone, g.email AS guest_email, u.name AS created_by_name
       FROM bookings b JOIN guests g ON g.id = b.guest_id LEFT JOIN users u ON u.id = b.created_by
      WHERE b.id = $1 AND b.hotel_id = $2`, [id, hotelId]);
  if (!booking) return null;
  booking.stays = await many(
    `SELECT s.*, rt.name AS room_type, r.number AS room_number, r.hk_status, g.full_name AS guest_name, f.id AS folio_id, f.status AS folio_status
       FROM stays s JOIN room_types rt ON rt.id = s.room_type_id LEFT JOIN rooms r ON r.id = s.room_id
       JOIN guests g ON g.id = s.guest_id LEFT JOIN folios f ON f.stay_id = s.id
      WHERE s.booking_id = $1 ORDER BY s.id`, [id]);
  for (const s of booking.stays) if (s.folio_id) s.folio_totals = await folioTotals({ one }, s.folio_id);
  return booking;
}

r.get('/bookings', requirePerm('bookings.view'), async (req, res) => {
  const { status, from, to, q, source } = req.query;
  const vals = [req.hotelId];
  const conds = ['b.hotel_id = $1'];
  if (status) { vals.push(status); conds.push(`b.status = $${vals.length}`); }
  if (source) { vals.push(source); conds.push(`b.source = $${vals.length}`); }
  if (from) { vals.push(from); conds.push(`EXISTS (SELECT 1 FROM stays s WHERE s.booking_id = b.id AND s.check_out_date > $${vals.length})`); }
  if (to) { vals.push(to); conds.push(`EXISTS (SELECT 1 FROM stays s WHERE s.booking_id = b.id AND s.check_in_date < $${vals.length})`); }
  if (q) {
    vals.push(`%${String(q).toLowerCase()}%`);
    conds.push(`(lower(b.ref) LIKE $${vals.length} OR lower(g.full_name) LIKE $${vals.length} OR g.phone LIKE $${vals.length})`);
  }
  res.json(await many(
    `SELECT b.*, g.full_name AS guest_name, g.phone AS guest_phone,
            min(s.check_in_date) AS check_in_date, max(s.check_out_date) AS check_out_date, count(s.id)::int AS room_count,
            string_agg(DISTINCT r.number, ', ') AS rooms, string_agg(DISTINCT s.status, ',') AS stay_statuses
       FROM bookings b JOIN guests g ON g.id = b.guest_id
       LEFT JOIN stays s ON s.booking_id = b.id LEFT JOIN rooms r ON r.id = s.room_id
      WHERE ${conds.join(' AND ')}
      GROUP BY b.id, g.full_name, g.phone ORDER BY min(s.check_in_date) DESC NULLS LAST, b.id DESC LIMIT 200`, vals));
});

r.get('/bookings/:id', requirePerm('bookings.view'), async (req, res) => {
  const b = await loadBooking(req.hotelId, idParam(req.params.id));
  if (!b) throw notFound();
  res.json(b);
});

r.patch('/bookings/:id', requirePerm('bookings.modify'), async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(z.object({
    special_requests: z.string().nullable().optional(), notes: z.string().nullable().optional(),
    group_name: z.string().nullable().optional(), source: z.string().optional(),
  }), req.body);
  const keys = Object.keys(b);
  if (keys.length) {
    const row = await one(`UPDATE bookings SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}
      WHERE id = $${keys.length + 1} AND hotel_id = $${keys.length + 2} RETURNING id`, [...keys.map((k) => b[k]), id, req.hotelId]);
    if (!row) throw notFound();
    await audit(req, 'booking.updated', 'booking', id, { changed: keys });
  }
  res.json(await loadBooking(req.hotelId, id));
});

// Confirm an online booking request: tentative stays become reserved (overlap constraint enforced here)
r.post('/bookings/:id/confirm', requirePerm('bookings.create'), async (req, res) => {
  const id = idParam(req.params.id);
  await tx(async (db) => {
    const bk = await db.one(`SELECT * FROM bookings WHERE id = $1 AND hotel_id = $2 FOR UPDATE`, [id, req.hotelId]);
    if (!bk) throw notFound();
    if (bk.status !== 'requested') throw badRequest('Only requested bookings can be confirmed');
    const stays = await db.many(`SELECT * FROM stays WHERE booking_id = $1 AND status = 'tentative'`, [id]);
    for (const s of stays) {
      await prepareStay(db, req, { ...s, nightly_rate_paise: s.nightly_rate_paise, children: s.children }, s.id);
      await db.query(`UPDATE stays SET status = 'reserved' WHERE id = $1`, [s.id]);
    }
    await db.query(`UPDATE bookings SET status = 'confirmed' WHERE id = $1`, [id]);
    await audit(req, 'booking.confirmed', 'booking', id, {}, db);
  });
  const bk = await loadBooking(req.hotelId, id);
  await queueNotification(req.hotelId, { phone: bk.guest_phone, email: bk.guest_email, full_name: bk.guest_name }, 'booking_confirmation',
    { ref: bk.ref, hotel: req.hotel.name, check_in: bk.stays[0]?.check_in_date, check_out: bk.stays[0]?.check_out_date });
  res.json(bk);
});

r.post('/bookings/:id/cancel', requirePerm('bookings.cancel'), async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(z.object({ reason: z.string().min(2), cancellation_fee_paise: z.number().int().min(0).default(0) }), req.body);
  await tx(async (db) => {
    const bk = await db.one(`SELECT * FROM bookings WHERE id = $1 AND hotel_id = $2 FOR UPDATE`, [id, req.hotelId]);
    if (!bk) throw notFound();
    if (bk.status === 'cancelled') throw badRequest('Booking is already cancelled');
    const live = await db.one(`SELECT count(*)::int AS n FROM stays WHERE booking_id = $1 AND status IN ('checked_in','checked_out')`, [id]);
    if (live.n) throw conflict('Booking has stays already checked in; check out or cancel individual reserved rooms instead');
    await db.query(`UPDATE stays SET status = 'cancelled' WHERE booking_id = $1 AND status IN ('tentative','reserved')`, [id]);
    await db.query(`UPDATE bookings SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2 WHERE id = $1`, [id, b.reason]);
    if (b.cancellation_fee_paise > 0) {
      const f = await db.one(`SELECT f.id FROM folios f JOIN stays s ON s.id = f.stay_id WHERE s.booking_id = $1 ORDER BY f.id LIMIT 1`, [id]);
      await db.query(
        `INSERT INTO folio_lines (hotel_id, folio_id, category, description, unit_price_paise, amount_paise, business_date, source_type, created_by)
         VALUES ($1,$2,'service','Cancellation charge',$3,$3,$4,'manual',$5)`,
        [req.hotelId, f.id, b.cancellation_fee_paise, hotelToday(req.hotel.timezone), req.user.id]);
    }
    await audit(req, 'booking.cancelled', 'booking', id, b, db);
  });
  res.json(await loadBooking(req.hotelId, id));
});

// ---------------------------------------------------------------
// Stay operations
// ---------------------------------------------------------------
async function loadStay(db, hotelId, id, lock = false) {
  return db.one(
    `SELECT s.*, r.number AS room_number, f.id AS folio_id FROM stays s
       LEFT JOIN rooms r ON r.id = s.room_id LEFT JOIN folios f ON f.stay_id = s.id
      WHERE s.id = $1 AND s.hotel_id = $2 ${lock ? 'FOR UPDATE OF s' : ''}`, [id, hotelId]);
}

r.patch('/stays/:id', requirePerm('bookings.modify'), async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(z.object({
    room_id: z.number().int().nullable().optional(),
    room_type_id: z.number().int().optional(),
    check_in_date: date.optional(),
    check_out_date: date.optional(),
    adults: z.number().int().min(1).optional(),
    children: z.number().int().min(0).optional(),
    nightly_rate_paise: z.number().int().min(0).optional(),
    reason: z.string().optional(),
  }), req.body);
  const today = hotelToday(req.hotel.timezone);
  await tx(async (db) => {
    const s = await loadStay(db, req.hotelId, id, true);
    if (!s) throw notFound();
    if (!['tentative', 'reserved', 'checked_in'].includes(s.status)) throw badRequest(`Cannot modify a ${s.status} stay`);
    if (s.status === 'checked_in' && b.check_in_date && b.check_in_date !== s.check_in_date) throw badRequest('Guest is already checked in; check-in date cannot change');
    if (s.status === 'checked_in' && b.check_out_date && b.check_out_date < today) throw badRequest('Check-out date cannot be in the past');
    const next = {
      room_type_id: b.room_type_id ?? s.room_type_id,
      room_id: b.room_id !== undefined ? b.room_id : s.room_id,
      check_in_date: b.check_in_date ?? s.check_in_date,
      check_out_date: b.check_out_date ?? s.check_out_date,
      adults: b.adults ?? s.adults,
      children: b.children ?? s.children,
      nightly_rate_paise: b.nightly_rate_paise ?? (b.room_type_id && b.room_type_id !== s.room_type_id ? undefined : s.nightly_rate_paise),
    };
    if (s.status === 'checked_in' && !next.room_id) throw badRequest('A checked-in guest must have a room');
    // keep current rate unless explicitly changed; only rate changes need rates.override
    const rtCur = await db.one('SELECT base_rate_paise FROM room_types WHERE id = $1', [next.room_type_id]);
    const rateForCheck = next.nightly_rate_paise ?? rtCur.base_rate_paise;
    if (b.nightly_rate_paise !== undefined && b.nightly_rate_paise !== s.nightly_rate_paise) assertPerm(req, 'rates.override', 'You are not allowed to change the room rate');
    const { extra } = await prepareStay(db, { ...req, perms: new Set([...req.perms, 'rates.override']) },
      { ...next, nightly_rate_paise: rateForCheck }, id);
    await db.query(
      `UPDATE stays SET room_type_id=$1, room_id=$2, check_in_date=$3, check_out_date=$4, adults=$5, children=$6,
              nightly_rate_paise=$7, extra_person_paise=$8 WHERE id = $9`,
      [next.room_type_id, next.room_id, next.check_in_date, next.check_out_date, next.adults, next.children, rateForCheck, extra, id]);
    // Room move while in house: old room needs cleaning
    if (s.status === 'checked_in' && s.room_id && next.room_id !== s.room_id) {
      await db.query(`UPDATE rooms SET hk_status = 'dirty' WHERE id = $1`, [s.room_id]);
      await db.query(`INSERT INTO hk_tasks (hotel_id, room_id, task_type, priority, trigger, notes, created_by)
                      VALUES ($1,$2,'cleaning','normal','system','Room change — guest moved out',$3)`, [req.hotelId, s.room_id, req.user.id]);
    }
    // Shortened stay: void room-night charges posted for nights that no longer exist
    if (next.check_out_date < s.check_out_date) {
      await db.query(
        `UPDATE folio_lines SET voided_at = now(), voided_by = $1, void_reason = 'Stay shortened'
          WHERE source_type = 'stay_night' AND source_id = $2 AND business_date >= $3 AND voided_at IS NULL`,
        [req.user.id, id, next.check_out_date]);
    }
    await audit(req, 'stay.modified', 'stay', id, {
      booking_id: s.booking_id, reason: b.reason,
      from: { room_id: s.room_id, check_in: s.check_in_date, check_out: s.check_out_date, rate: s.nightly_rate_paise },
      to: { room_id: next.room_id, check_in: next.check_in_date, check_out: next.check_out_date, rate: rateForCheck },
    }, db);
  });
  res.json(await loadStay({ one }, req.hotelId, id));
});

export async function checkIn(req, stayId, opts) {
  const today = hotelToday(req.hotel.timezone);
  return tx(async (db) => {
    const s = await loadStay(db, req.hotelId, stayId, true);
    if (!s) throw notFound();
    if (s.status !== 'reserved') throw badRequest(s.status === 'tentative' ? 'Confirm the booking first' : `Stay is ${s.status}`);
    if (s.check_in_date > today) throw badRequest(`This stay starts on ${s.check_in_date}. Change the dates to check in early.`);
    if (s.check_out_date <= today) throw badRequest('Stay dates are in the past; modify the dates first');
    let roomId = opts.room_id || s.room_id;
    if (!roomId) throw badRequest('Assign a room before check-in');
    if (opts.room_id && opts.room_id !== s.room_id) {
      await prepareStay(db, { ...req, perms: new Set([...req.perms, 'rates.override']) },
        { ...s, room_id: opts.room_id, nightly_rate_paise: s.nightly_rate_paise }, s.id);
      await db.query('UPDATE stays SET room_id = $1 WHERE id = $2', [opts.room_id, s.id]);
    }
    const room = await db.one('SELECT * FROM rooms WHERE id = $1', [roomId]);
    if (!['ready', 'inspected'].includes(room.hk_status) && !opts.force) {
      throw conflict(`Room ${room.number} is ${room.hk_status.replace('_', ' ')}. Mark it ready or check in anyway.`, { needs_force: true });
    }
    const occupied = await db.one(`SELECT id FROM stays WHERE room_id = $1 AND status = 'checked_in' AND id <> $2`, [roomId, s.id]);
    if (occupied) throw conflict(`Room ${room.number} still has a guest checked in`);
    const guest = await db.one('SELECT * FROM guests WHERE id = $1', [s.guest_id]);
    if (req.hotel.settings?.require_id_at_checkin !== false && !guest.id_number && !opts.skip_id) {
      throw badRequest('Guest ID details are required at check-in', { needs_id: true });
    }
    const pin = String(Math.floor(1000 + Math.random() * 9000));
    await db.query(
      `UPDATE stays SET status = 'checked_in', checked_in_at = now(), checked_in_by = $1, portal_pin = $2, early_check_in = $3 WHERE id = $4`,
      [req.user.id, pin, !!opts.early, s.id]);
    const fresh = { ...s, room_id: roomId, room_number: room.number };
    await postRoomNights(db, req.hotel, fresh, s.folio_id, today, req.user.id);
    await audit(req, 'stay.checked_in', 'stay', s.id, { booking_id: s.booking_id, room: room.number, forced: !!opts.force }, db);
    return { ...fresh, portal_pin: pin, status: 'checked_in' };
  });
}

r.post('/stays/:id/checkin', requirePerm('bookings.checkin'), async (req, res) => {
  const b = parse(z.object({
    room_id: z.number().int().optional(), force: z.boolean().default(false), early: z.boolean().default(false), skip_id: z.boolean().default(false),
  }), req.body || {});
  const stay = await checkIn(req, idParam(req.params.id), b);
  const g = await one('SELECT full_name, phone, email FROM guests WHERE id = $1', [stay.guest_id]);
  await queueNotification(req.hotelId, g, 'checkin_welcome', { hotel: req.hotel.name, room: stay.room_number, pin: stay.portal_pin });
  res.json(stay);
});

r.post('/stays/:id/checkout', requirePerm('bookings.checkout'), async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(z.object({
    allow_balance: z.boolean().default(false), late: z.boolean().default(false), issue_invoice: z.boolean().default(true),
  }), req.body || {});
  const today = hotelToday(req.hotel.timezone);
  const out = await tx(async (db) => {
    const s = await loadStay(db, req.hotelId, id, true);
    if (!s) throw notFound();
    if (s.status !== 'checked_in') throw badRequest(`Stay is ${s.status}`);
    // Early departure: shorten the stay to today (min 1 night)
    let checkOutDate = s.check_out_date;
    if (today < s.check_out_date) {
      checkOutDate = today > s.check_in_date ? today : addDays(s.check_in_date, 1);
      if (checkOutDate !== s.check_out_date) {
        await db.query('UPDATE stays SET check_out_date = $1 WHERE id = $2', [checkOutDate, id]);
        await db.query(
          `UPDATE folio_lines SET voided_at = now(), voided_by = $1, void_reason = 'Early departure'
            WHERE source_type = 'stay_night' AND source_id = $2 AND business_date >= $3 AND voided_at IS NULL`, [req.user.id, id, checkOutDate]);
      }
    }
    await postRoomNights(db, req.hotel, { ...s, check_out_date: checkOutDate }, s.folio_id, addDays(checkOutDate, -1), req.user.id);
    const pendingOrders = await db.many(
      `SELECT order_no, status FROM orders WHERE stay_id = $1 AND status <> 'cancelled' AND settlement = 'unsettled'`, [id]);
    if (pendingOrders.length) {
      throw conflict(`Unsettled food orders: ${pendingOrders.map((o) => o.order_no).join(', ')}. Post them to the room or settle them first.`,
        { pending_orders: pendingOrders });
    }
    const totals = await folioTotals(db, s.folio_id);
    if (totals.balance_paise > 0 && !b.allow_balance) {
      throw conflict(`Pending balance of ₹${(totals.balance_paise / 100).toFixed(2)}. Collect payment before checkout.`,
        { balance_paise: totals.balance_paise });
    }
    if (totals.balance_paise > 0) assertPerm(req, 'payments.refund', 'Only a manager can check out with an unpaid balance');
    await db.query(
      `UPDATE stays SET status = 'checked_out', checked_out_at = now(), checked_out_by = $1, late_check_out = $2, portal_pin = NULL WHERE id = $3`,
      [req.user.id, b.late, id]);
    await db.query(`UPDATE rooms SET hk_status = 'dirty' WHERE id = $1`, [s.room_id]);
    const arrivingToday = await db.one(
      `SELECT id FROM stays WHERE room_id = $1 AND status = 'reserved' AND check_in_date = $2`, [s.room_id, today]);
    await db.query(
      `INSERT INTO hk_tasks (hotel_id, room_id, task_type, priority, trigger, notes, created_by)
       VALUES ($1,$2,'cleaning',$3,'checkout',$4,$5)`,
      [req.hotelId, s.room_id, arrivingToday ? 'urgent' : 'high', arrivingToday ? 'Checkout clean — arrival expected today' : 'Checkout clean', req.user.id]);
    let invoice = null;
    if (b.issue_invoice && totals.balance_paise <= 0) invoice = await issueInvoice(db, req, s.folio_id);
    await audit(req, 'stay.checked_out', 'stay', id,
      { booking_id: s.booking_id, room: s.room_number, balance_paise: totals.balance_paise, early: checkOutDate !== s.check_out_date }, db);
    return { stay_id: id, totals, invoice };
  });
  res.json({ ...out, folio: await loadFolio({ one, many }, req.hotelId, (await one('SELECT id FROM folios WHERE stay_id = $1', [id])).id) });
});

r.post('/stays/:id/cancel', requirePerm('bookings.cancel'), async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(z.object({ reason: z.string().min(2) }), req.body);
  const s = await one(`UPDATE stays SET status = 'cancelled' WHERE id = $1 AND hotel_id = $2 AND status IN ('tentative','reserved') RETURNING *`, [id, req.hotelId]);
  if (!s) throw badRequest('Only reserved stays can be cancelled');
  const remaining = await one(`SELECT count(*)::int AS n FROM stays WHERE booking_id = $1 AND status <> 'cancelled'`, [s.booking_id]);
  if (!remaining.n) await one(`UPDATE bookings SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2 WHERE id = $1 RETURNING id`, [s.booking_id, b.reason]);
  await audit(req, 'stay.cancelled', 'stay', id, { booking_id: s.booking_id, reason: b.reason });
  res.json(s);
});

r.post('/stays/:id/no-show', requirePerm('bookings.cancel'), async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(z.object({ charge_first_night: z.boolean().default(false) }), req.body || {});
  const today = hotelToday(req.hotel.timezone);
  const s = await tx(async (db) => {
    const st = await loadStay(db, req.hotelId, id, true);
    if (!st || st.status !== 'reserved') throw badRequest('Only reserved stays can be marked no-show');
    if (st.check_in_date > today) throw badRequest('Arrival date has not come yet');
    await db.query(`UPDATE stays SET status = 'no_show' WHERE id = $1`, [id]);
    if (b.charge_first_night) {
      await db.query(
        `INSERT INTO folio_lines (hotel_id, folio_id, category, description, unit_price_paise, amount_paise, business_date, source_type, created_by)
         VALUES ($1,$2,'service','No-show charge',$3,$3,$4,'manual',$5)`, [req.hotelId, st.folio_id, st.nightly_rate_paise, today, req.user.id]);
    }
    await audit(req, 'stay.no_show', 'stay', id, { booking_id: st.booking_id, charged: b.charge_first_night }, db);
    return st;
  });
  res.json({ ...s, status: 'no_show' });
});

// ---------------------------------------------------------------
// Calendar & front desk
// ---------------------------------------------------------------
r.get('/calendar', requirePerm('bookings.view'), async (req, res) => {
  const from = parse(date, req.query.from || hotelToday(req.hotel.timezone));
  const to = parse(date, req.query.to || addDays(from, 14));
  const rooms = await many(
    `SELECT r.id, r.number, r.floor, r.hk_status, rt.id AS room_type_id, rt.name AS room_type
       FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id WHERE r.hotel_id = $1 AND r.active ORDER BY rt.base_rate_paise, r.number`, [req.hotelId]);
  const stays = await many(
    `SELECT s.id, s.booking_id, b.ref, s.room_id, s.room_type_id, s.check_in_date, s.check_out_date, s.status, s.adults, s.children,
            g.full_name AS guest_name, b.source
       FROM stays s JOIN bookings b ON b.id = s.booking_id JOIN guests g ON g.id = s.guest_id
      WHERE s.hotel_id = $1 AND s.status IN ('tentative','reserved','checked_in','checked_out')
        AND s.check_in_date < $3 AND s.check_out_date > $2 ORDER BY s.check_in_date`, [req.hotelId, from, to]);
  res.json({ from, to, rooms, stays: stays.filter((s) => s.room_id), unallocated: stays.filter((s) => !s.room_id && s.status !== 'checked_out') });
});

r.get('/frontdesk', requirePerm('bookings.view'), async (req, res) => {
  const today = hotelToday(req.hotel.timezone);
  const base = `SELECT s.id, s.booking_id, b.ref, s.room_id, r.number AS room_number, r.hk_status, rt.name AS room_type,
                       s.check_in_date, s.check_out_date, s.status, s.adults, s.children, g.full_name AS guest_name, g.phone AS guest_phone,
                       b.special_requests, f.id AS folio_id
                  FROM stays s JOIN bookings b ON b.id = s.booking_id JOIN guests g ON g.id = s.guest_id
                  JOIN room_types rt ON rt.id = s.room_type_id LEFT JOIN rooms r ON r.id = s.room_id
                  LEFT JOIN folios f ON f.stay_id = s.id WHERE s.hotel_id = $1`;
  const [arrivals, departures, inHouse, requested] = await Promise.all([
    many(`${base} AND s.status = 'reserved' AND s.check_in_date <= $2 ORDER BY s.check_in_date, g.full_name`, [req.hotelId, today]),
    many(`${base} AND s.status = 'checked_in' AND s.check_out_date <= $2 ORDER BY r.number`, [req.hotelId, today]),
    many(`${base} AND s.status = 'checked_in' ORDER BY r.number`, [req.hotelId]),
    many(`SELECT b.id, b.ref, b.created_at, g.full_name AS guest_name, g.phone AS guest_phone, min(s.check_in_date) AS check_in_date,
                 max(s.check_out_date) AS check_out_date, count(s.id)::int AS room_count
            FROM bookings b JOIN guests g ON g.id = b.guest_id JOIN stays s ON s.booking_id = b.id
           WHERE b.hotel_id = $1 AND b.status = 'requested' GROUP BY b.id, g.full_name, g.phone ORDER BY b.created_at`, [req.hotelId]),
  ]);
  for (const d of departures) d.balance_paise = (await folioTotals({ one }, d.folio_id)).balance_paise;
  const rooms = await many(`SELECT hk_status, count(*)::int AS n FROM rooms WHERE hotel_id = $1 AND active GROUP BY hk_status`, [req.hotelId]);
  const totalRooms = rooms.reduce((a, x) => a + x.n, 0);
  res.json({
    today, arrivals, departures, in_house: inHouse, requested,
    counts: {
      total_rooms: totalRooms,
      occupied: inHouse.length,
      vacant: totalRooms - inHouse.length - (rooms.find((x) => x.hk_status === 'out_of_order')?.n || 0),
      out_of_order: rooms.find((x) => x.hk_status === 'out_of_order')?.n || 0,
      dirty: rooms.find((x) => x.hk_status === 'dirty')?.n || 0,
      arrivals_pending: arrivals.length,
      departures_pending: departures.length,
      unallocated_arrivals: arrivals.filter((a) => !a.room_id).length,
    },
  });
});

export default r;
