// Guest-facing endpoints: room QR portal and public direct-booking page. No staff auth.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { one, many, tx } from '../db.js';
import { parse } from '../lib/validate.js';
import { signToken, requireGuest } from '../middleware/auth.js';
import { notFound, badRequest, unauthorized, conflict } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { config } from '../config.js';
import { folioTotals } from '../lib/folio.js';
import { createOrder, orderItemInput } from './pos.js';
import { availability } from './bookings.js';
import { nextBookingRef } from '../lib/sequences.js';
import { hotelToday, DATE_RE, nightsBetween } from '../lib/dates.js';
import { taxSettings } from '../lib/money.js';

const r = Router();
const verifyLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Please contact reception.' } });
const publicLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });

async function roomByToken(token) {
  if (!/^[a-f0-9]{32}$/.test(token)) throw notFound('Invalid QR code');
  const room = await one(
    `SELECT r.id, r.number, r.hotel_id, r.qr_token, h.name AS hotel_name, h.phone AS hotel_phone, h.settings, h.timezone, h.subscription_status
       FROM rooms r JOIN hotels h ON h.id = r.hotel_id WHERE r.qr_token = $1 AND r.active`, [token]);
  if (!room || ['suspended', 'cancelled'].includes(room.subscription_status)) throw notFound('Invalid QR code');
  return room;
}
const activeStay = (roomId) => one(
  `SELECT s.*, f.id AS folio_id, g.phone AS guest_phone, g.full_name AS guest_name, b.ref AS booking_ref
     FROM stays s JOIN folios f ON f.stay_id = s.id JOIN guests g ON g.id = s.guest_id JOIN bookings b ON b.id = s.booking_id
    WHERE s.room_id = $1 AND s.status = 'checked_in' LIMIT 1`, [roomId]);

async function qrMenu(hotelId) {
  const categories = await many(`SELECT id, name FROM menu_categories WHERE hotel_id = $1 AND active ORDER BY sort_order, name`, [hotelId]);
  const items = await many(
    `SELECT id, category_id, name, description, price_paise, is_veg, variants, addons, available
       FROM menu_items WHERE hotel_id = $1 AND show_on_qr ORDER BY sort_order, name`, [hotelId]);
  return { categories, items };
}

// ---------------------------------------------------------------
// Room QR portal
// ---------------------------------------------------------------
// Public landing: hotel + room + menu. Exposes NO guest data — only whether the room is in use.
r.get('/portal/:token', publicLimiter, async (req, res) => {
  const room = await roomByToken(req.params.token);
  const stay = await activeStay(room.id);
  res.json({
    hotel: { name: room.hotel_name, phone: room.hotel_phone },
    room: { number: room.number },
    occupied: !!stay,
    menu: await qrMenu(room.hotel_id),
    food_tax_rate: taxSettings({ settings: room.settings }).food_rate,
  });
});

// Verify the guest: last 4 digits of the booking phone, or the portal PIN given at check-in.
r.post('/portal/:token/verify', verifyLimiter, async (req, res) => {
  const b = parse(z.object({ code: z.string().trim().min(4).max(10) }), req.body);
  const room = await roomByToken(req.params.token);
  const stay = await activeStay(room.id);
  if (!stay) throw conflict('This room has no active stay. Please contact reception.');
  const phoneDigits = String(stay.guest_phone || '').replace(/\D/g, '');
  const ok = (stay.portal_pin && b.code === stay.portal_pin) || (phoneDigits.length >= 4 && b.code === phoneDigits.slice(-4));
  if (!ok) {
    await audit({ hotelId: room.hotel_id, ip: req.ip }, 'portal.verify_failed', 'stay', stay.id, { room: room.number });
    throw unauthorized('Code did not match. Use the last 4 digits of your phone or the PIN from reception.');
  }
  await audit({ hotelId: room.hotel_id, auth: { type: 'guest' }, ip: req.ip }, 'portal.verified', 'stay', stay.id, { room: room.number });
  const token = signToken({ type: 'guest', stay_id: stay.id, qr: room.qr_token }, config.guestJwtExpiresIn);
  res.json({ token, guest_name: stay.guest_name.split(' ')[0] });
});

// Service request (towels, housekeeping…) — allowed with just the room QR while a stay is active.
r.post('/portal/:token/requests', publicLimiter, async (req, res) => {
  const b = parse(z.object({
    type: z.enum(['towels', 'housekeeping', 'maintenance', 'amenity', 'checkout', 'reception', 'other']),
    message: z.string().max(500).optional().nullable(),
  }), req.body);
  const room = await roomByToken(req.params.token);
  const stay = await activeStay(room.id);
  if (!stay) throw conflict('This room has no active stay. Please contact reception.');
  const open = await one(`SELECT count(*)::int AS n FROM service_requests WHERE stay_id = $1 AND status = 'open'`, [stay.id]);
  if (open.n >= 10) throw conflict('You have many open requests. Reception will reach you shortly.');
  const row = await tx(async (db) => {
    const sr = await db.one(
      `INSERT INTO service_requests (hotel_id, room_id, stay_id, type, message) VALUES ($1,$2,$3,$4,$5) RETURNING id, type, status, created_at`,
      [room.hotel_id, room.id, stay.id, b.type, b.message || null]);
    if (['towels', 'housekeeping', 'amenity'].includes(b.type)) {
      await db.query(
        `INSERT INTO hk_tasks (hotel_id, room_id, task_type, priority, trigger, service_request_id, notes)
         VALUES ($1,$2,'request','high','guest_request',$3,$4)`, [room.hotel_id, room.id, sr.id, `${b.type}${b.message ? `: ${b.message}` : ''}`]);
    } else if (b.type === 'maintenance') {
      await db.query(
        `INSERT INTO maintenance_requests (hotel_id, room_id, title, description, priority, service_request_id)
         VALUES ($1,$2,'Guest reported issue',$3,'high',$4)`, [room.hotel_id, room.id, b.message || null, sr.id]);
    }
    return sr;
  });
  res.status(201).json(row);
});

// ----- Verified guest endpoints -----
r.get('/guest/me', requireGuest, async (req, res) => {
  const s = req.stay;
  const hotel = await one('SELECT name, phone, settings, checkout_time FROM hotels WHERE id = $1', [s.hotel_id]);
  const info = await one(
    `SELECT g.full_name, b.ref, r.number AS room_number, rt.name AS room_type FROM stays s
       JOIN guests g ON g.id = s.guest_id JOIN bookings b ON b.id = s.booking_id JOIN rooms r ON r.id = s.room_id
       JOIN room_types rt ON rt.id = s.room_type_id WHERE s.id = $1`, [s.id]);
  const out = {
    guest_name: info.full_name, booking_ref: info.ref, room: info.room_number, room_type: info.room_type,
    check_in: s.check_in_date, check_out: s.check_out_date, checkout_time: hotel.checkout_time, hotel: { name: hotel.name, phone: hotel.phone },
  };
  if (hotel.settings?.qr_show_bill !== false) {
    const f = await one('SELECT id FROM folios WHERE stay_id = $1', [s.id]);
    const lines = await many(
      `SELECT description, category, amount_paise, tax_paise, business_date FROM folio_lines WHERE folio_id = $1 AND voided_at IS NULL ORDER BY business_date, id`, [f.id]);
    out.bill = { lines, totals: await folioTotals({ one }, f.id) };
  }
  res.json(out);
});

r.get('/guest/orders', requireGuest, async (req, res) => {
  res.json(await many(
    `SELECT o.id, o.order_no, o.status, o.total_paise, o.created_at,
            (SELECT json_agg(json_build_object('name', i.name, 'variant', i.variant, 'quantity', i.quantity)) FROM order_items i WHERE i.order_id = o.id AND NOT i.cancelled) AS items
       FROM orders o WHERE o.stay_id = $1 ORDER BY o.id DESC`, [req.stay.id]));
});

r.post('/guest/orders', requireGuest, async (req, res) => {
  const b = parse(z.object({ items: z.array(orderItemInput).min(1).max(30), notes: z.string().max(300).optional().nullable() }), req.body);
  const hotel = await one('SELECT * FROM hotels WHERE id = $1', [req.stay.hotel_id]);
  const pending = await one(`SELECT count(*)::int AS n FROM orders WHERE stay_id = $1 AND status = 'received'`, [req.stay.id]);
  if (pending.n >= 3) throw conflict('You have orders waiting for confirmation. Please wait or call reception.');
  const order = await tx(async (db) => {
    const o = await createOrder(db, {
      hotel, source: 'guest_qr', input: { order_type: 'room_service', room_id: req.stay.room_id, notes: b.notes, items: b.items },
    });
    await audit({ hotelId: hotel.id, auth: { type: 'guest' }, ip: req.ip }, 'order.created_by_guest', 'order', o.id, { order_no: o.order_no, total_paise: o.total_paise }, db);
    return o;
  });
  res.status(201).json({ id: order.id, order_no: order.order_no, status: order.status, total_paise: order.total_paise });
});

r.get('/guest/requests', requireGuest, async (req, res) => {
  res.json(await many(`SELECT id, type, message, status, created_at FROM service_requests WHERE stay_id = $1 ORDER BY id DESC`, [req.stay.id]));
});

// ---------------------------------------------------------------
// Public direct-booking page
// ---------------------------------------------------------------
async function hotelBySlug(slug) {
  const h = await one(`SELECT * FROM hotels WHERE slug = $1 AND subscription_status IN ('trial','active','past_due')`, [slug]);
  if (!h || h.settings?.online_booking === false) throw notFound('Hotel not found');
  return h;
}

r.get('/public/hotels/:slug', publicLimiter, async (req, res) => {
  const h = await hotelBySlug(req.params.slug);
  const types = await many(
    `SELECT id, name, description, base_occupancy, max_occupancy, base_rate_paise, extra_person_rate_paise, amenities
       FROM room_types WHERE hotel_id = $1 AND active ORDER BY base_rate_paise`, [h.id]);
  res.json({ name: h.name, address: h.address, city: h.city, phone: h.phone, email: h.email, checkin_time: h.checkin_time,
    checkout_time: h.checkout_time, room_types: types, today: hotelToday(h.timezone) });
});

r.get('/public/hotels/:slug/availability', publicLimiter, async (req, res) => {
  const h = await hotelBySlug(req.params.slug);
  const from = parse(z.string().regex(DATE_RE), req.query.from);
  const to = parse(z.string().regex(DATE_RE), req.query.to);
  if (to <= from || from < hotelToday(h.timezone)) throw badRequest('Choose valid future dates');
  const a = await availability({ many }, h.id, from, to);
  // Public view: counts only, never specific rooms
  res.json(a.map(({ id, name, base_rate_paise, max_occupancy, available }) => ({ id, name, base_rate_paise, max_occupancy, available: Math.min(available, 5) })));
});

r.post('/public/hotels/:slug/booking-requests', rateLimit({ windowMs: 60 * 60 * 1000, limit: 10 }), async (req, res) => {
  const h = await hotelBySlug(req.params.slug);
  const b = parse(z.object({
    full_name: z.string().trim().min(2), phone: z.string().trim().min(7).max(20), email: z.string().trim().optional().nullable(),
    room_type_id: z.number().int(), rooms: z.number().int().min(1).max(5).default(1),
    check_in_date: z.string().regex(DATE_RE), check_out_date: z.string().regex(DATE_RE),
    adults: z.number().int().min(1).default(2), children: z.number().int().min(0).default(0),
    special_requests: z.string().max(500).optional().nullable(),
  }), req.body);
  if (b.check_out_date <= b.check_in_date || b.check_in_date < hotelToday(h.timezone)) throw badRequest('Choose valid dates');
  if (nightsBetween(b.check_in_date, b.check_out_date) > 30) throw badRequest('For stays over 30 nights please call the hotel');
  const rt = await one('SELECT * FROM room_types WHERE id = $1 AND hotel_id = $2 AND active', [b.room_type_id, h.id]);
  if (!rt) throw badRequest('Unknown room type');
  const avail = (await availability({ many }, h.id, b.check_in_date, b.check_out_date)).find((x) => x.id === rt.id);
  if (!avail || avail.available < b.rooms) throw conflict('Not enough rooms available for these dates');
  const booking = await tx(async (db) => {
    let g = await db.one(`SELECT id FROM guests WHERE hotel_id = $1 AND phone = $2 ORDER BY id DESC LIMIT 1`, [h.id, b.phone]);
    if (!g) g = await db.one(`INSERT INTO guests (hotel_id, full_name, phone, email) VALUES ($1,$2,$3,$4) RETURNING id`, [h.id, b.full_name, b.phone, b.email || null]);
    const ref = await nextBookingRef(db, h.id);
    const bk = await db.one(
      `INSERT INTO bookings (hotel_id, ref, guest_id, source, status, special_requests) VALUES ($1,$2,$3,'direct_online','requested',$4) RETURNING *`,
      [h.id, ref, g.id, b.special_requests || null]);
    const perRoomAdults = Math.max(1, Math.ceil(b.adults / b.rooms));
    for (let i = 0; i < b.rooms; i++) {
      const extra = Math.max(0, perRoomAdults - rt.base_occupancy) * rt.extra_person_rate_paise;
      const s = await db.one(
        `INSERT INTO stays (hotel_id, booking_id, guest_id, room_type_id, check_in_date, check_out_date, adults, children, nightly_rate_paise, extra_person_paise, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'tentative') RETURNING id`,
        [h.id, bk.id, g.id, rt.id, b.check_in_date, b.check_out_date, perRoomAdults, i === 0 ? b.children : 0, rt.base_rate_paise, extra]);
      await db.query(`INSERT INTO folios (hotel_id, kind, stay_id, booking_id, guest_id) VALUES ($1,'stay',$2,$3,$4)`, [h.id, s.id, bk.id, g.id]);
    }
    await audit({ hotelId: h.id, ip: req.ip }, 'booking.requested_online', 'booking', bk.id, { ref, rooms: b.rooms }, db);
    return bk;
  });
  res.status(201).json({ ref: booking.ref, status: 'requested', message: 'Request received. The hotel will confirm your booking shortly.' });
});

export default r;
