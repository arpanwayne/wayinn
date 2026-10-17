import { Router } from 'express';
import { z } from 'zod';
import { one, many, tx } from '../db.js';
import { parse, idParam } from '../lib/validate.js';
import { requireStaff, requirePerm, can } from '../middleware/auth.js';
import { notFound, badRequest, conflict } from '../lib/errors.js';
import { audit } from '../lib/audit.js';

const r = Router();
r.use('/guests', requireStaff);

export const guestSchema = z.object({
  full_name: z.string().trim().min(1),
  phone: z.string().trim().optional().nullable(),
  email: z.string().trim().optional().nullable(),
  address: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  country: z.string().optional().nullable(),
  nationality: z.string().optional().nullable(),
  id_type: z.string().optional().nullable(),
  id_number: z.string().optional().nullable(),
  company_name: z.string().optional().nullable(),
  company_gstin: z.string().optional().nullable(),
  preferences: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  custom_fields: z.record(z.string(), z.any()).optional(),
});

const GUEST_COLS = ['full_name', 'phone', 'email', 'address', 'city', 'country', 'nationality', 'id_type', 'id_number',
  'company_name', 'company_gstin', 'preferences', 'notes', 'custom_fields'];

export async function createGuest(db, hotelId, g) {
  const keys = GUEST_COLS.filter((k) => g[k] !== undefined);
  const vals = keys.map((k) => (k === 'custom_fields' ? JSON.stringify(g[k]) : g[k]));
  return db.one(
    `INSERT INTO guests (hotel_id, ${keys.join(', ')}) VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING *`,
    [hotelId, ...vals]);
}

// Hide ID documents & internal notes from roles without guests.manage
const redact = (req, g) => (can(req, 'guests.manage') ? g : { ...g, id_number: g.id_number ? '••••' + String(g.id_number).slice(-4) : null, notes: undefined });

r.get('/guests', requirePerm('guests.view'), async (req, res) => {
  const q = (req.query.q || '').trim();
  const vals = [req.hotelId];
  let where = 'g.hotel_id = $1';
  if (q) {
    vals.push(`%${q.toLowerCase()}%`);
    // Phones are stored as typed ("+91 98765-43210"), so also match on digits only: any run of digits finds the guest.
    const digits = q.replace(/\D/g, '');
    vals.push(digits.length >= 3 ? `%${digits}%` : null);
    where += ` AND (lower(g.full_name) LIKE $2 OR g.phone LIKE $2 OR ($3::text IS NOT NULL AND regexp_replace(COALESCE(g.phone,''), '\\D', '', 'g') LIKE $3) OR lower(g.email) LIKE $2
               OR EXISTS (SELECT 1 FROM bookings b WHERE b.guest_id = g.id AND lower(b.ref) LIKE $2)
               OR EXISTS (SELECT 1 FROM stays s JOIN rooms rm ON rm.id = s.room_id WHERE s.guest_id = g.id
                          AND s.status = 'checked_in' AND lower(rm.number) = $4))`;
    vals.push(q.toLowerCase());
  }
  const rows = await many(
    `SELECT g.*, (SELECT count(*)::int FROM stays s WHERE s.guest_id = g.id AND s.status = 'checked_out') AS stay_count,
            (SELECT max(check_out_date) FROM stays s WHERE s.guest_id = g.id) AS last_stay
       FROM guests g WHERE ${where} ORDER BY g.created_at DESC LIMIT 100`, vals);
  res.json(rows.map((g) => redact(req, g)));
});

r.get('/guests/:id', requirePerm('guests.view'), async (req, res) => {
  const id = idParam(req.params.id);
  const g = await one('SELECT * FROM guests WHERE id = $1 AND hotel_id = $2', [id, req.hotelId]);
  if (!g) throw notFound();
  g.stays = await many(
    `SELECT s.id, s.booking_id, b.ref, s.check_in_date, s.check_out_date, s.status, r.number AS room_number, rt.name AS room_type,
            f.id AS folio_id
       FROM stays s JOIN bookings b ON b.id = s.booking_id JOIN room_types rt ON rt.id = s.room_type_id
       LEFT JOIN rooms r ON r.id = s.room_id LEFT JOIN folios f ON f.stay_id = s.id
      WHERE s.guest_id = $1 ORDER BY s.check_in_date DESC`, [id]);
  res.json(redact(req, g));
});

r.post('/guests', requirePerm('guests.manage', 'bookings.create'), async (req, res) => {
  const b = parse(guestSchema, req.body);
  const g = await createGuest({ one }, req.hotelId, b);
  await audit(req, 'guest.created', 'guest', g.id);
  res.status(201).json(g);
});

r.put('/guests/:id', requirePerm('guests.manage'), async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(guestSchema.partial(), req.body);
  const keys = GUEST_COLS.filter((k) => b[k] !== undefined);
  if (!keys.length) return res.json(await one('SELECT * FROM guests WHERE id = $1 AND hotel_id = $2', [id, req.hotelId]));
  const vals = keys.map((k) => (k === 'custom_fields' ? JSON.stringify(b[k]) : b[k]));
  const g = await one(
    `UPDATE guests SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}
      WHERE id = $${keys.length + 1} AND hotel_id = $${keys.length + 2} RETURNING *`, [...vals, id, req.hotelId]);
  if (!g) throw notFound();
  await audit(req, 'guest.updated', 'guest', id, { changed: keys });
  res.json(g);
});

// Delete a guest added by mistake. A guest with any booking is part of the records and cannot be deleted
// (merge duplicates instead).
r.delete('/guests/:id', requirePerm('guests.manage'), async (req, res) => {
  const id = idParam(req.params.id);
  const g = await one('SELECT id, full_name FROM guests WHERE id = $1 AND hotel_id = $2', [id, req.hotelId]);
  if (!g) throw notFound();
  const { n } = await one('SELECT count(*)::int AS n FROM bookings WHERE guest_id = $1', [id]);
  if (n) throw conflict(`${g.full_name} has ${n} booking(s) on record, so the profile cannot be deleted. If it is a duplicate, merge it into the other profile.`);
  await one('DELETE FROM guests WHERE id = $1 RETURNING id', [id]);
  await audit(req, 'guest.deleted', 'guest', id, { name: g.full_name });
  res.json({ ok: true });
});

// Merge a duplicate guest into another profile: bookings, stays and bills move over, empty fields are
// filled from the duplicate, and the duplicate is removed.
r.post('/guests/:id/merge', requirePerm('guests.manage'), async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(z.object({ into_guest_id: z.number().int() }), req.body);
  if (b.into_guest_id === id) throw badRequest('Pick a different guest to merge into');
  const out = await tx(async (db) => {
    const from = await db.one('SELECT * FROM guests WHERE id = $1 AND hotel_id = $2 FOR UPDATE', [id, req.hotelId]);
    const into = await db.one('SELECT * FROM guests WHERE id = $1 AND hotel_id = $2 FOR UPDATE', [b.into_guest_id, req.hotelId]);
    if (!from || !into) throw notFound('Guest not found');
    const fill = GUEST_COLS.filter((k) => k !== 'custom_fields' && (into[k] === null || into[k] === '') && from[k] !== null && from[k] !== '');
    if (fill.length) {
      await db.query(`UPDATE guests SET ${fill.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${fill.length + 1}`,
        [...fill.map((k) => from[k]), into.id]);
    }
    if (from.notes && into.notes && from.notes !== into.notes) {
      await db.query(`UPDATE guests SET notes = notes || E'\n' || $1 WHERE id = $2`, [from.notes, into.id]);
    }
    const moved = {};
    for (const t of ['bookings', 'stays', 'folios']) {
      moved[t] = (await db.query(`UPDATE ${t} SET guest_id = $1 WHERE guest_id = $2`, [into.id, id])).rowCount;
    }
    await db.query('DELETE FROM guests WHERE id = $1', [id]);
    await audit(req, 'guest.merged', 'guest', into.id, { merged_guest_id: id, merged_name: from.full_name, filled: fill, moved }, db);
    return db.one('SELECT * FROM guests WHERE id = $1', [into.id]);
  });
  res.json(out);
});

export default r;
