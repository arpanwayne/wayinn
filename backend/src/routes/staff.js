import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { one, many } from '../db.js';
import { parse, idParam } from '../lib/validate.js';
import { requireStaff, requirePerm } from '../middleware/auth.js';
import { ROLES, PERMISSIONS, effectivePermissions } from '../lib/permissions.js';
import { forbidden, notFound, badRequest } from '../lib/errors.js';
import { audit } from '../lib/audit.js';

const r = Router();
r.use('/staff', requireStaff, requirePerm('staff.manage'));

const permList = z.array(z.string().refine((p) => p in PERMISSIONS, 'Unknown permission'));
const cols = 'id, hotel_id, name, email, phone, role, extra_permissions, revoked_permissions, active, last_login_at, created_at';

r.get('/staff', async (req, res) => {
  const rows = await many(`SELECT ${cols} FROM users WHERE hotel_id = $1 ORDER BY active DESC, name`, [req.hotelId]);
  res.json(rows.map((u) => ({ ...u, permissions: effectivePermissions(u) })));
});

r.post('/staff', async (req, res) => {
  const b = parse(z.object({
    name: z.string().min(2), email: z.string().trim().toLowerCase().min(3), phone: z.string().optional(),
    password: z.string().min(8), role: z.enum(ROLES),
    extra_permissions: permList.default([]), revoked_permissions: permList.default([]),
  }), req.body);
  if (b.role === 'owner' && req.user.role !== 'owner') throw forbidden('Only an owner can create another owner');
  const plan = req.hotel.plan_id ? await one('SELECT max_staff FROM plans WHERE id = $1', [req.hotel.plan_id]) : null;
  if (plan?.max_staff) {
    const { n } = await one('SELECT count(*)::int AS n FROM users WHERE hotel_id = $1 AND active', [req.hotelId]);
    if (n >= plan.max_staff) throw badRequest(`Your plan allows ${plan.max_staff} active staff accounts`);
  }
  const u = await one(
    `INSERT INTO users (hotel_id, name, email, phone, password_hash, role, extra_permissions, revoked_permissions)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${cols}`,
    [req.hotelId, b.name, b.email, b.phone || null, await bcrypt.hash(b.password, 10), b.role, b.extra_permissions, b.revoked_permissions]);
  await audit(req, 'staff.created', 'user', u.id, { role: u.role, email: u.email });
  res.status(201).json(u);
});

r.patch('/staff/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const existing = await one('SELECT * FROM users WHERE id = $1 AND hotel_id = $2', [id, req.hotelId]);
  if (!existing) throw notFound();
  const b = parse(z.object({
    name: z.string().min(2).optional(), phone: z.string().nullable().optional(), role: z.enum(ROLES).optional(),
    active: z.boolean().optional(), password: z.string().min(8).optional(),
    extra_permissions: permList.optional(), revoked_permissions: permList.optional(),
  }), req.body);
  if ((existing.role === 'owner' || b.role === 'owner') && req.user.role !== 'owner') throw forbidden('Only an owner can change owner accounts');
  if (id === req.user.id && (b.active === false || (b.role && b.role !== existing.role))) throw badRequest('You cannot deactivate or change your own role');
  const sets = []; const vals = [];
  for (const k of ['name', 'phone', 'role', 'active', 'extra_permissions', 'revoked_permissions']) {
    if (b[k] !== undefined) { vals.push(b[k]); sets.push(`${k} = $${vals.length}`); }
  }
  if (b.password) { vals.push(await bcrypt.hash(b.password, 10)); sets.push(`password_hash = $${vals.length}`); }
  if (!sets.length) return res.json(existing);
  vals.push(id, req.hotelId);
  const u = await one(`UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND hotel_id = $${vals.length} RETURNING ${cols}`, vals);
  await audit(req, 'staff.updated', 'user', id, { changed: Object.keys(b).filter((k) => k !== 'password'), password_reset: !!b.password });
  res.json(u);
});

export default r;
