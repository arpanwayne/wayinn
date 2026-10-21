// OTA / channel-manager connection.
//
// MakeMyTrip, Goibibo, OYO, Booking.com and Agoda do not let a single small hotel software connect directly:
// they work through approved channel managers (STAAH, eZee, AxisRooms, RateGain…). This API is what such a
// channel manager calls: it reads room types and day-by-day availability, and pushes bookings, changes and
// cancellations. Every call needs the hotel's API key (Setup → Online channels) in the `x-api-key` header.
//
// The iCal feed at the end is for OTAs that accept a calendar link (Airbnb, Booking.com): it lists the nights
// a room type is sold out, so the OTA closes those dates.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { one, many, tx } from '../db.js';
import { parse } from '../lib/validate.js';
import { unauthorized, notFound, badRequest, conflict, HttpError } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { sha256, safeEqual } from '../lib/integrations.js';
import { nextBookingRef } from '../lib/sequences.js';
import { hotelToday, addDays, DATE_RE, nightsBetween, stayNights } from '../lib/dates.js';
import { availability, OTA_SOURCES } from './bookings.js';
import { queueNotification } from '../lib/notify.js';
import { voidUndeliveredCharges } from '../lib/folio.js';

const r = Router();
const limiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });

async function requireChannelKey(req, _res, next) {
  const key = String(req.get('x-api-key') || '');
  const m = /^wyn_(\d+)_[a-f0-9]{40}$/.exec(key);
  if (!m) throw unauthorized('Missing or invalid API key');
  const integ = await one('SELECT channel_key_hash FROM hotel_integrations WHERE hotel_id = $1', [Number(m[1])]);
  if (!integ?.channel_key_hash || !safeEqual(integ.channel_key_hash, sha256(key))) throw unauthorized('Missing or invalid API key');
  const hotel = await one('SELECT * FROM hotels WHERE id = $1', [Number(m[1])]);
  if (!hotel || ['suspended', 'cancelled'].includes(hotel.subscription_status)) throw new HttpError(402, 'Hotel subscription is not active');
  req.hotel = hotel;
  req.hotelId = hotel.id;
  next();
}
r.use('/channel/v1', limiter, requireChannelKey);

const date = z.string().regex(DATE_RE, 'Use YYYY-MM-DD');

r.get('/channel/v1/room-types', async (req, res) => {
  res.json(await many(
    `SELECT id, name, base_occupancy, max_occupancy, base_rate_paise, extra_person_rate_paise,
            (SELECT count(*)::int FROM rooms r WHERE r.room_type_id = rt.id AND r.active) AS rooms
       FROM room_types rt WHERE hotel_id = $1 AND active ORDER BY base_rate_paise`, [req.hotelId]));
});

/** Rooms free per room type for each night in [from, to). Max 90 nights per call. */
r.get('/channel/v1/availability', async (req, res) => {
  const from = parse(date, req.query.from);
  const to = parse(date, req.query.to);
  if (to <= from || nightsBetween(from, to) > 90) throw badRequest('Use a range of 1 to 90 nights');
  res.json(await dailyAvailability(req.hotelId, from, to));
});

export async function dailyAvailability(hotelId, from, to) {
  const types = await many(
    `SELECT id, name, base_rate_paise, (SELECT count(*)::int FROM rooms r WHERE r.room_type_id = rt.id AND r.active AND r.hk_status <> 'out_of_order') AS total
       FROM room_types rt WHERE hotel_id = $1 AND active ORDER BY base_rate_paise`, [hotelId]);
  const booked = await many(
    `SELECT s.room_type_id, d::date::text AS night, count(*)::int AS n
       FROM stays s CROSS JOIN LATERAL generate_series(GREATEST(s.check_in_date, $2::date), LEAST(s.check_out_date, $3::date) - 1, interval '1 day') d
      WHERE s.hotel_id = $1 AND s.status IN ('reserved','checked_in') AND s.check_in_date < $3 AND s.check_out_date > $2
      GROUP BY 1, 2`, [hotelId, from, to]);
  const key = Object.fromEntries(booked.map((b) => [`${b.room_type_id}|${b.night}`, b.n]));
  return types.map((t) => ({
    room_type_id: t.id, name: t.name, rate_paise: t.base_rate_paise,
    nights: stayNights(from, to).map((night) => ({ date: night, available: Math.max(0, t.total - (key[`${t.id}|${night}`] || 0)) })),
  }));
}

const bookingBody = z.object({
  channel: z.enum(OTA_SOURCES),
  external_ref: z.string().trim().min(2).max(80),
  guest: z.object({ full_name: z.string().trim().min(2), phone: z.string().trim().max(20).optional().nullable(), email: z.string().trim().optional().nullable() }),
  rooms: z.array(z.object({
    room_type_id: z.number().int(), adults: z.number().int().min(1).default(2), children: z.number().int().min(0).default(0),
    nightly_rate_paise: z.number().int().min(0).optional(),
  })).min(1).max(10),
  check_in_date: date,
  check_out_date: date,
  paid_to_ota_paise: z.number().int().min(0).default(0), // prepaid at the OTA: recorded as a payment so the desk does not collect again
  special_requests: z.string().max(1000).optional().nullable(),
});

const findBooking = (db, hotelId, channel, ext) => db.one(
  `SELECT * FROM bookings WHERE hotel_id = $1 AND source = $2 AND external_ref = $3`, [hotelId, channel, ext]);

/** New OTA booking. Sending the same channel + external_ref again returns the existing booking (safe to retry). */
r.post('/channel/v1/bookings', async (req, res) => {
  const b = parse(bookingBody, req.body);
  if (b.check_out_date <= b.check_in_date) throw badRequest('Check-out must be after check-in');
  if (nightsBetween(b.check_in_date, b.check_out_date) > 90) throw badRequest('Stays longer than 90 nights are not supported');
  const existing = await findBooking({ one }, req.hotelId, b.channel, b.external_ref);
  if (existing) return res.json(await channelBookingView(req.hotelId, existing.id, true));

  const id = await tx(async (db) => {
    await db.query('SELECT id FROM hotels WHERE id = $1 FOR UPDATE', [req.hotelId]); // one OTA booking at a time per hotel: no overselling
    await checkRooms(db, req.hotelId, b.rooms, b.check_in_date, b.check_out_date);
    const g = await upsertGuest(db, req.hotelId, b.guest);
    const ref = await nextBookingRef(db, req.hotelId);
    const bk = await db.one(
      `INSERT INTO bookings (hotel_id, ref, guest_id, source, status, special_requests, external_ref, notes)
       VALUES ($1,$2,$3,$4,'confirmed',$5,$6,$7) RETURNING *`,
      [req.hotelId, ref, g.id, b.channel, b.special_requests || null, b.external_ref, `${b.channel} booking ${b.external_ref}`]);
    let firstFolio = null;
    for (const room of b.rooms) {
      const rt = await db.one('SELECT * FROM room_types WHERE id = $1', [room.room_type_id]);
      const rate = room.nightly_rate_paise ?? rt.base_rate_paise;
      const extra = Math.max(0, room.adults - rt.base_occupancy) * rt.extra_person_rate_paise;
      const s = await db.one(
        `INSERT INTO stays (hotel_id, booking_id, guest_id, room_type_id, check_in_date, check_out_date, adults, children, nightly_rate_paise, extra_person_paise, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'reserved') RETURNING id`,
        [req.hotelId, bk.id, g.id, rt.id, b.check_in_date, b.check_out_date, room.adults, room.children, rate, room.nightly_rate_paise !== undefined ? 0 : extra]);
      const f = await db.one(`INSERT INTO folios (hotel_id, kind, stay_id, booking_id, guest_id) VALUES ($1,'stay',$2,$3,$4) RETURNING id`, [req.hotelId, s.id, bk.id, g.id]);
      firstFolio = firstFolio || f.id;
    }
    if (b.paid_to_ota_paise > 0) {
      await db.query(
        `INSERT INTO payments (hotel_id, folio_id, kind, method, amount_paise, reference, notes) VALUES ($1,$2,'deposit','online',$3,$4,$5)`,
        [req.hotelId, firstFolio, b.paid_to_ota_paise, `${b.channel}:${b.external_ref}`, `Prepaid at ${b.channel}`]);
    }
    await audit({ hotelId: req.hotelId, ip: req.ip }, 'booking.created_by_channel', 'booking', bk.id,
      { ref, channel: b.channel, external_ref: b.external_ref, rooms: b.rooms.length, paid_to_ota_paise: b.paid_to_ota_paise }, db);
    return bk.id;
  });
  const view = await channelBookingView(req.hotelId, id, false);
  await queueNotification(req.hotelId, b.guest, 'booking_confirmation',
    { ref: view.ref, hotel: req.hotel.name, check_in: b.check_in_date, check_out: b.check_out_date });
  res.status(201).json(view);
});

/** Date change from the OTA. Only before check-in; the rooms keep their room types. */
r.patch('/channel/v1/bookings/:channel/:externalRef', async (req, res) => {
  const channel = parse(z.enum(OTA_SOURCES), req.params.channel);
  const b = parse(z.object({ check_in_date: date, check_out_date: date, special_requests: z.string().max(1000).optional().nullable() }), req.body);
  if (b.check_out_date <= b.check_in_date) throw badRequest('Check-out must be after check-in');
  const id = await tx(async (db) => {
    await db.query('SELECT id FROM hotels WHERE id = $1 FOR UPDATE', [req.hotelId]);
    const bk = await findBooking(db, req.hotelId, channel, req.params.externalRef);
    if (!bk) throw notFound('Booking not found');
    if (bk.status === 'cancelled') throw conflict('Booking is cancelled');
    const stays = await db.many(`SELECT * FROM stays WHERE booking_id = $1 AND status <> 'cancelled'`, [bk.id]);
    if (stays.some((s) => s.status !== 'reserved')) throw conflict('The guest has already checked in; ask the hotel to change it');
    // Check room-type availability with this booking's own rooms left out.
    const need = {};
    for (const s of stays) need[s.room_type_id] = (need[s.room_type_id] || 0) + 1;
    for (const [typeId, n] of Object.entries(need)) {
      const types = await availability(db, req.hotelId, b.check_in_date, b.check_out_date);
      const t = types.find((x) => String(x.id) === typeId);
      const own = stays.filter((s) => String(s.room_type_id) === typeId && s.check_in_date < b.check_out_date && s.check_out_date > b.check_in_date).length;
      if (!t || t.available + own < n) throw conflict(`Not enough ${t?.name || 'rooms'} free for the new dates`);
    }
    try {
      await db.query(`UPDATE stays SET check_in_date = $2, check_out_date = $3 WHERE booking_id = $1 AND status = 'reserved'`,
        [bk.id, b.check_in_date, b.check_out_date]);
    } catch (e) {
      if (e.code === '23P01') throw conflict('An assigned room is already booked on the new dates; ask the hotel to move the room');
      throw e;
    }
    if (b.special_requests !== undefined) await db.query('UPDATE bookings SET special_requests = $2 WHERE id = $1', [bk.id, b.special_requests]);
    await audit({ hotelId: req.hotelId, ip: req.ip }, 'booking.modified_by_channel', 'booking', bk.id,
      { channel, external_ref: req.params.externalRef, check_in: b.check_in_date, check_out: b.check_out_date }, db);
    return bk.id;
  });
  res.json(await channelBookingView(req.hotelId, id, false));
});

r.post('/channel/v1/bookings/:channel/:externalRef/cancel', async (req, res) => {
  const channel = parse(z.enum(OTA_SOURCES), req.params.channel);
  const b = parse(z.object({ reason: z.string().max(300).default('Cancelled on the OTA') }), req.body || {});
  const id = await tx(async (db) => {
    const bk = await findBooking(db, req.hotelId, channel, req.params.externalRef);
    if (!bk) throw notFound('Booking not found');
    if (bk.status === 'cancelled') return bk.id;
    const live = await db.one(`SELECT count(*)::int AS n FROM stays WHERE booking_id = $1 AND status IN ('checked_in','checked_out')`, [bk.id]);
    if (live.n) throw conflict('The guest has already checked in; the hotel must handle this');
    const cancelled = await db.many(`UPDATE stays SET status = 'cancelled' WHERE booking_id = $1 AND status IN ('tentative','reserved') RETURNING id`, [bk.id]);
    for (const s of cancelled) await voidUndeliveredCharges(db, s.id, null, 'Cancelled on the OTA');
    await db.query(`UPDATE bookings SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2 WHERE id = $1`, [bk.id, b.reason]);
    await audit({ hotelId: req.hotelId, ip: req.ip }, 'booking.cancelled_by_channel', 'booking', bk.id, { channel, external_ref: req.params.externalRef, reason: b.reason }, db);
    return bk.id;
  });
  res.json(await channelBookingView(req.hotelId, id, false));
});

r.get('/channel/v1/bookings/:channel/:externalRef', async (req, res) => {
  const channel = parse(z.enum(OTA_SOURCES), req.params.channel);
  const bk = await findBooking({ one }, req.hotelId, channel, req.params.externalRef);
  if (!bk) throw notFound('Booking not found');
  res.json(await channelBookingView(req.hotelId, bk.id, false));
});

async function checkRooms(db, hotelId, rooms, from, to) {
  const need = {};
  for (const room of rooms) {
    const rt = await db.one('SELECT * FROM room_types WHERE id = $1 AND hotel_id = $2 AND active', [room.room_type_id, hotelId]);
    if (!rt) throw badRequest(`Unknown room type ${room.room_type_id}`);
    if (room.adults + room.children > rt.max_occupancy) throw badRequest(`${rt.name} allows max ${rt.max_occupancy} guests`);
    need[rt.id] = (need[rt.id] || 0) + 1;
  }
  const avail = await availability(db, hotelId, from, to);
  for (const [typeId, n] of Object.entries(need)) {
    const t = avail.find((a) => String(a.id) === typeId);
    if (!t || t.available < n) throw conflict(`Not enough ${t?.name || 'rooms'} free for these dates`);
  }
}

async function upsertGuest(db, hotelId, g) {
  if (g.phone) {
    const found = await db.one(`SELECT * FROM guests WHERE hotel_id = $1 AND phone = $2 ORDER BY id DESC LIMIT 1`, [hotelId, g.phone]);
    if (found) return found;
  }
  return db.one(`INSERT INTO guests (hotel_id, full_name, phone, email) VALUES ($1,$2,$3,$4) RETURNING *`, [hotelId, g.full_name, g.phone || null, g.email || null]);
}

async function channelBookingView(hotelId, id, duplicate) {
  const bk = await one(`SELECT b.id, b.ref, b.source AS channel, b.external_ref, b.status, b.created_at, g.full_name AS guest_name
                          FROM bookings b JOIN guests g ON g.id = b.guest_id WHERE b.id = $1 AND b.hotel_id = $2`, [id, hotelId]);
  bk.rooms = await many(
    `SELECT s.id AS stay_id, rt.name AS room_type, s.room_type_id, s.check_in_date, s.check_out_date, s.status, s.nightly_rate_paise, r.number AS room_number
       FROM stays s JOIN room_types rt ON rt.id = s.room_type_id LEFT JOIN rooms r ON r.id = s.room_id WHERE s.booking_id = $1 ORDER BY s.id`, [id]);
  bk.duplicate = duplicate;
  return bk;
}

// ---- iCal: sold-out nights per room type --------------------------------------------------------------
r.get('/channel/ical/:token/:file', rateLimit({ windowMs: 60 * 1000, limit: 30 }), async (req, res) => {
  const m = /^(\d+)\.ics$/.exec(req.params.file);
  if (!/^[a-f0-9]{32}$/.test(req.params.token) || !m) throw notFound();
  const integ = await one('SELECT hotel_id FROM hotel_integrations WHERE ical_token = $1', [req.params.token]);
  if (!integ) throw notFound();
  const hotel = await one('SELECT id, name, timezone FROM hotels WHERE id = $1', [integ.hotel_id]);
  const rt = await one('SELECT id, name FROM room_types WHERE id = $1 AND hotel_id = $2', [Number(m[1]), hotel.id]);
  if (!rt) throw notFound();
  const from = hotelToday(hotel.timezone);
  const days = (await dailyAvailability(hotel.id, from, addDays(from, 365))).find((t) => t.room_type_id === rt.id)?.nights || [];
  res.type('text/calendar').send(icalFor(hotel, rt, days));
});

const icsDate = (d) => d.replace(/-/g, '');
const icsEscape = (s) => String(s).replace(/([,;\\])/g, '\\$1');

export function icalFor(hotel, rt, nights) {
  // Merge consecutive sold-out nights into one event.
  const blocks = [];
  for (const n of nights) {
    if (n.available > 0) continue;
    const last = blocks[blocks.length - 1];
    if (last && last.end === n.date) last.end = addDays(n.date, 1);
    else blocks.push({ start: n.date, end: addDays(n.date, 1) });
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Wayne E Solutions//Wayinn//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(`${hotel.name} — ${rt.name}`)}`,
    ...blocks.flatMap((b) => ['BEGIN:VEVENT', `UID:wayinn-${hotel.id}-${rt.id}-${b.start}@wayinn`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(b.start)}`, `DTEND;VALUE=DATE:${icsDate(b.end)}`, 'SUMMARY:Not available', 'END:VEVENT']),
    'END:VCALENDAR', '',
  ].join('\r\n');
}

export default r;
