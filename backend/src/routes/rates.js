// Rate calendar: date-wise rate, minimum stay and stop-sell per room type, the change history and undo.
// Front desk can look; changing needs rates.manage (owner by default).
import { Router } from 'express';
import { z } from 'zod';
import { many, tx } from '../db.js';
import { parse, idParam } from '../lib/validate.js';
import { requireStaff, requirePerm } from '../middleware/auth.js';
import { badRequest, notFound, conflict } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { DATE_RE, hotelToday, addDays, nightsBetween } from '../lib/dates.js';
import { nightlyRates, setCalendar, datesInRange, undoChange } from '../lib/rates.js';
import { dailyAvailability } from './channel.js';

const r = Router();
r.use('/rates', requireStaff);
const date = z.string().regex(DATE_RE, 'Use YYYY-MM-DD');

r.get('/rates/calendar', requirePerm('rates.manage', 'bookings.view'), async (req, res) => {
  const today = hotelToday(req.hotel.timezone);
  const from = req.query.from ? parse(date, req.query.from) : today;
  const to = req.query.to ? parse(date, req.query.to) : addDays(from, 30);
  if (to <= from || nightsBetween(from, to) > 120) throw badRequest('Show 1 to 120 days at a time');
  const types = await many(
    `SELECT id, name, base_rate_paise, extra_person_rate_paise, base_occupancy, max_occupancy FROM room_types
      WHERE hotel_id = $1 AND active ORDER BY base_rate_paise`, [req.hotelId]);
  const grid = await nightlyRates({ many }, req.hotelId, from, to, types);
  const avail = Object.fromEntries((await dailyAvailability(req.hotelId, from, to)).map((t) => [t.room_type_id, t.nights]));
  res.json({
    from, to, today,
    room_types: types.map((t) => {
      const free = Object.fromEntries((avail[t.id] || []).map((n) => [n.date, n.available]));
      return { ...t, nights: grid.get(Number(t.id)).map((n) => ({ ...n, available: free[n.date] ?? 0 })) };
    }),
  });
});

const bulkSchema = z.object({
  room_type_ids: z.array(z.number().int()).min(1).max(20),
  from: date,
  to: date, // inclusive
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  rate_paise: z.number().int().min(0).max(100_000_000).nullable().optional(), // null = back to base rate
  min_stay: z.number().int().min(1).max(30).nullable().optional(),
  stop_sell: z.boolean().optional(),
}).refine((b) => 'rate_paise' in b || 'min_stay' in b || 'stop_sell' in b, { message: 'Nothing to change', path: ['rate_paise'] });

r.put('/rates/calendar', requirePerm('rates.manage'), async (req, res) => {
  const b = parse(bulkSchema, req.body);
  if (b.to < b.from) throw badRequest('The end date is before the start date');
  if (nightsBetween(b.from, b.to) > 500) throw badRequest('Change at most 500 days at a time');
  if (b.to < hotelToday(req.hotel.timezone)) throw badRequest('These dates are in the past');
  const dates = datesInRange(b.from, b.to, b.weekdays).filter((d) => d >= hotelToday(req.hotel.timezone));
  if (!dates.length) throw badRequest('No dates match');
  const patch = {};
  for (const k of ['rate_paise', 'min_stay', 'stop_sell']) if (k in b) patch[k] = b[k];
  const changed = await tx(async (db) => {
    const ok = await db.many('SELECT id FROM room_types WHERE hotel_id = $1 AND id = ANY($2::bigint[])', [req.hotelId, b.room_type_ids]);
    if (ok.length !== new Set(b.room_type_ids).size) throw badRequest('Unknown room type');
    let n = 0;
    for (const id of b.room_type_ids) n += (await setCalendar(db, { hotelId: req.hotelId, roomTypeId: id, dates, patch, userId: req.user.id })).length;
    await audit(req, 'rates.calendar_updated', 'hotel', req.hotelId, { ...b, days: dates.length, changed: n }, db);
    return n;
  });
  res.json({ ok: true, changed });
});

// History of rate changes (manual, Rate Guard approvals, auto-pilot, undo).
r.get('/rates/changes', requirePerm('rates.manage'), async (req, res) => {
  const vals = [req.hotelId];
  const where = ['c.hotel_id = $1'];
  if (req.query.room_type_id) { vals.push(idParam(req.query.room_type_id)); where.push(`c.room_type_id = $${vals.length}`); }
  if (req.query.date) { vals.push(parse(date, req.query.date)); where.push(`c.date = $${vals.length}`); }
  vals.push(Math.min(Number(req.query.limit) || 200, 1000));
  const rows = await many(
    `SELECT c.*, rt.name AS room_type, u.name AS user_name, s.code AS suggestion_code, s.ota_name AS suggestion_ota,
            (c.undone_at IS NULL AND c.source <> 'undo' AND c.id = (SELECT max(x.id) FROM rate_changes x WHERE x.room_type_id = c.room_type_id
                                                                      AND x.date = c.date AND x.undone_at IS NULL)) AS can_undo
       FROM rate_changes c JOIN room_types rt ON rt.id = c.room_type_id
       LEFT JOIN users u ON u.id = c.user_id LEFT JOIN rate_suggestions s ON s.id = c.suggestion_id
      WHERE ${where.join(' AND ')} ORDER BY c.id DESC LIMIT $${vals.length}`, vals);
  res.json(rows);
});

r.post('/rates/changes/:id/undo', requirePerm('rates.manage'), async (req, res) => {
  const id = idParam(req.params.id);
  const out = await tx(async (db) => {
    const u = await undoChange(db, req.hotelId, id, req.user.id);
    if (u.error === 'not_found') throw notFound();
    if (u.error === 'already_undone') throw conflict('This change was already undone');
    if (u.error === 'newer_change') throw conflict('This day was changed again later. Undo the newer change first.');
    await audit(req, 'rates.change_undone', 'rate_change', id, {}, db);
    return u;
  });
  res.json(out);
});

export default r;
