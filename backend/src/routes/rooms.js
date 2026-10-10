import { Router } from 'express';
import { z } from 'zod';
import { one, many, tx } from '../db.js';
import { parse, idParam } from '../lib/validate.js';
import { requireStaff, requirePerm } from '../middleware/auth.js';
import { notFound, badRequest, conflict } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { roomBoard } from '../lib/rooms.js';
import { hotelToday } from '../lib/dates.js';
import { config } from '../config.js';

const r = Router();
r.use(['/room-types', '/rooms'], requireStaff);

// ---------- Room types ----------
const rtSchema = z.object({
  name: z.string().min(1), code: z.string().optional().nullable(), description: z.string().optional().nullable(),
  base_occupancy: z.number().int().min(1).default(2), max_occupancy: z.number().int().min(1).default(3),
  base_rate_paise: z.number().int().min(0), extra_person_rate_paise: z.number().int().min(0).default(0),
  amenities: z.array(z.string()).default([]), active: z.boolean().default(true),
});

r.get('/room-types', async (req, res) => {
  res.json(await many(
    `SELECT rt.*, (SELECT count(*)::int FROM rooms WHERE room_type_id = rt.id AND active) AS room_count
       FROM room_types rt WHERE hotel_id = $1 ORDER BY base_rate_paise`, [req.hotelId]));
});

r.post('/room-types', requirePerm('rooms.manage'), async (req, res) => {
  const b = parse(rtSchema, req.body);
  if (b.max_occupancy < b.base_occupancy) throw badRequest('Max occupancy must be ≥ base occupancy');
  const row = await one(
    `INSERT INTO room_types (hotel_id, name, code, description, base_occupancy, max_occupancy, base_rate_paise,
                             extra_person_rate_paise, amenities, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [req.hotelId, b.name, b.code, b.description, b.base_occupancy, b.max_occupancy, b.base_rate_paise,
      b.extra_person_rate_paise, b.amenities, b.active]);
  await audit(req, 'room_type.created', 'room_type', row.id, b);
  res.status(201).json(row);
});

r.put('/room-types/:id', requirePerm('rooms.manage'), async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(rtSchema.partial(), req.body);
  const before = await one('SELECT * FROM room_types WHERE id = $1 AND hotel_id = $2', [id, req.hotelId]);
  if (!before) throw notFound();
  const keys = Object.keys(b);
  if (!keys.length) return res.json(before);
  const vals = keys.map((k) => b[k]);
  const row = await one(
    `UPDATE room_types SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}
      WHERE id = $${keys.length + 1} AND hotel_id = $${keys.length + 2} RETURNING *`, [...vals, id, req.hotelId]);
  const rateChanged = b.base_rate_paise !== undefined && b.base_rate_paise !== before.base_rate_paise;
  await audit(req, rateChanged ? 'room_type.rate_changed' : 'room_type.updated', 'room_type', id,
    { changed: keys, ...(rateChanged ? { from: before.base_rate_paise, to: b.base_rate_paise } : {}) });
  res.json(row);
});

// ---------- Rooms ----------
const roomSchema = z.object({
  number: z.string().min(1), room_type_id: z.number().int(), floor: z.string().optional().nullable(),
  notes: z.string().optional().nullable(), active: z.boolean().default(true),
});

async function enforceRoomLimit(req, adding = 1) {
  if (!req.hotel.plan_id) return;
  const plan = await one('SELECT max_rooms FROM plans WHERE id = $1', [req.hotel.plan_id]);
  const { n } = await one('SELECT count(*)::int AS n FROM rooms WHERE hotel_id = $1 AND active', [req.hotelId]);
  if (plan && n + adding > plan.max_rooms) throw badRequest(`Your plan allows up to ${plan.max_rooms} rooms`);
}

r.get('/rooms', async (req, res) => {
  res.json(await many(
    `SELECT r.*, rt.name AS room_type FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id
      WHERE r.hotel_id = $1 ORDER BY r.floor NULLS FIRST, r.number`, [req.hotelId]));
});

r.get('/rooms/board', async (req, res) => {
  res.json(await roomBoard(req.hotelId, hotelToday(req.hotel.timezone)));
});

r.post('/rooms', requirePerm('rooms.manage'), async (req, res) => {
  const b = parse(roomSchema, req.body);
  await enforceRoomLimit(req);
  const rt = await one('SELECT id FROM room_types WHERE id = $1 AND hotel_id = $2', [b.room_type_id, req.hotelId]);
  if (!rt) throw badRequest('Unknown room type');
  const row = await one(
    `INSERT INTO rooms (hotel_id, room_type_id, number, floor, notes, active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.hotelId, b.room_type_id, b.number, b.floor, b.notes, b.active]);
  await audit(req, 'room.created', 'room', row.id, { number: row.number });
  res.status(201).json(row);
});

// Bulk create e.g. 101-110
r.post('/rooms/bulk', requirePerm('rooms.manage'), async (req, res) => {
  const b = parse(z.object({
    room_type_id: z.number().int(), from: z.number().int(), to: z.number().int(), floor: z.string().optional().nullable(), prefix: z.string().default(''),
  }), req.body);
  if (b.to < b.from || b.to - b.from > 100) throw badRequest('Invalid range');
  await enforceRoomLimit(req, b.to - b.from + 1);
  const rows = await tx(async (db) => {
    const out = [];
    for (let n = b.from; n <= b.to; n++) {
      out.push(await db.one(
        `INSERT INTO rooms (hotel_id, room_type_id, number, floor) VALUES ($1,$2,$3,$4) RETURNING *`,
        [req.hotelId, b.room_type_id, `${b.prefix}${n}`, b.floor ?? null]));
    }
    return out;
  });
  await audit(req, 'room.bulk_created', 'room', null, { count: rows.length });
  res.status(201).json(rows);
});

r.put('/rooms/:id', requirePerm('rooms.manage'), async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(roomSchema.partial(), req.body);
  const keys = Object.keys(b);
  if (!keys.length) throw badRequest('Nothing to update');
  const row = await one(
    `UPDATE rooms SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}
      WHERE id = $${keys.length + 1} AND hotel_id = $${keys.length + 2} RETURNING *`, [...keys.map((k) => b[k]), id, req.hotelId]);
  if (!row) throw notFound();
  await audit(req, 'room.updated', 'room', id, { changed: keys });
  res.json(row);
});

const HK_FLOW = ['dirty', 'cleaning', 'inspected', 'ready', 'out_of_order'];
r.patch('/rooms/:id/status', requirePerm('rooms.status'), async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(z.object({ hk_status: z.enum(HK_FLOW), reason: z.string().optional() }), req.body);
  const room = await one('SELECT * FROM rooms WHERE id = $1 AND hotel_id = $2', [id, req.hotelId]);
  if (!room) throw notFound();
  if (b.hk_status === 'out_of_order') {
    if (!b.reason) throw badRequest('A reason is required to mark a room out of order');
    const occ = await one(`SELECT id FROM stays WHERE room_id = $1 AND status = 'checked_in'`, [id]);
    if (occ) throw conflict('Room is occupied; move the guest before marking it out of order');
  }
  const row = await one(
    `UPDATE rooms SET hk_status = $1, out_of_order_reason = $2 WHERE id = $3 RETURNING *`,
    [b.hk_status, b.hk_status === 'out_of_order' ? b.reason : null, id]);
  await audit(req, 'room.status_changed', 'room', id, { from: room.hk_status, to: b.hk_status, reason: b.reason });
  res.json(row);
});

r.post('/rooms/:id/regenerate-qr', requirePerm('rooms.manage'), async (req, res) => {
  const id = idParam(req.params.id);
  const row = await one(`UPDATE rooms SET qr_token = encode(gen_random_bytes(16),'hex') WHERE id = $1 AND hotel_id = $2 RETURNING id, number, qr_token`, [id, req.hotelId]);
  if (!row) throw notFound();
  await audit(req, 'room.qr_regenerated', 'room', id);
  res.json({ ...row, portal_url: `${config.publicAppUrl}/g/${row.qr_token}` });
});

r.get('/rooms/qr-sheet', requirePerm('rooms.manage'), async (req, res) => {
  const rows = await many(`SELECT id, number, qr_token FROM rooms WHERE hotel_id = $1 AND active ORDER BY number`, [req.hotelId]);
  res.json(rows.map((x) => ({ ...x, portal_url: `${config.publicAppUrl}/g/${x.qr_token}` })));
});

export default r;
