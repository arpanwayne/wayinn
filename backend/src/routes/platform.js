// Wayne E Solutions super-admin console: hotel onboarding, plans, subscriptions, support
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { one, many, tx } from '../db.js';
import { parse, idParam } from '../lib/validate.js';
import { requirePlatform, signToken } from '../middleware/auth.js';
import { notFound, badRequest, conflict } from '../lib/errors.js';
import { removeRow } from '../lib/remove.js';
import { audit } from '../lib/audit.js';

const r = Router();
r.use('/platform', (req, res, next) => (req.path.startsWith('/auth/') ? next() : requirePlatform(req, res, next)));

r.get('/platform/stats', async (_req, res) => {
  res.json(await one(
    `SELECT (SELECT count(*)::int FROM hotels) AS hotels,
            (SELECT count(*)::int FROM hotels WHERE subscription_status = 'active') AS active,
            (SELECT count(*)::int FROM hotels WHERE subscription_status = 'trial') AS trial,
            (SELECT count(*)::int FROM hotels WHERE subscription_status IN ('past_due','suspended')) AS at_risk,
            (SELECT count(*)::int FROM rooms WHERE active) AS rooms,
            (SELECT count(*)::int FROM stays WHERE status = 'checked_in') AS guests_in_house,
            (SELECT COALESCE(SUM(p.price_monthly_paise),0) FROM hotels h JOIN plans p ON p.id = h.plan_id WHERE h.subscription_status = 'active') AS mrr_paise`));
});

r.get('/platform/plans', async (_req, res) => res.json(await many(
  'SELECT p.*, (SELECT count(*)::int FROM hotels h WHERE h.plan_id = p.id) AS hotel_count FROM plans p ORDER BY price_monthly_paise')));
const planSchema = z.object({
  code: z.string().min(2), name: z.string().min(2), max_rooms: z.number().int().positive(), max_staff: z.number().int().positive().nullable().optional(),
  price_monthly_paise: z.number().int().min(0), features: z.record(z.string(), z.any()).default({}), active: z.boolean().default(true),
});
r.post('/platform/plans', async (req, res) => {
  const b = parse(planSchema, req.body);
  res.status(201).json(await one(
    `INSERT INTO plans (code, name, max_rooms, max_staff, price_monthly_paise, features, active) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [b.code, b.name, b.max_rooms, b.max_staff ?? null, b.price_monthly_paise, JSON.stringify(b.features), b.active]));
});
r.put('/platform/plans/:id', async (req, res) => {
  const b = parse(planSchema.partial(), req.body);
  const keys = Object.keys(b);
  const row = await one(`UPDATE plans SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1} RETURNING *`,
    [...keys.map((k) => (k === 'features' ? JSON.stringify(b[k]) : b[k])), idParam(req.params.id)]);
  if (!row) throw notFound();
  res.json(row);
});

// A plan can be deleted only while no hotel is on it; otherwise switch it off (active = false) so it
// is no longer offered to new hotels.
r.delete('/platform/plans/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const { n } = await one('SELECT count(*)::int AS n FROM hotels WHERE plan_id = $1', [id]);
  if (n) throw conflict(`${n} hotel(s) are on this plan. Move them to another plan, or switch the plan off instead.`);
  const row = await removeRow('DELETE FROM plans WHERE id = $1 RETURNING id, name', [id], 'This plan is still in use.');
  await audit({ ...req, hotelId: null }, 'platform.plan_deleted', 'plan', id, { name: row.name, by: req.admin.email });
  res.json({ ok: true });
});

r.get('/platform/hotels', async (_req, res) => {
  res.json(await many(
    `SELECT h.id, h.name, h.slug, h.city, h.phone, h.email, h.subscription_status, h.trial_ends_at, h.created_at, p.name AS plan, p.max_rooms,
            (SELECT count(*)::int FROM rooms r WHERE r.hotel_id = h.id AND r.active) AS rooms,
            (SELECT count(*)::int FROM users u WHERE u.hotel_id = h.id AND u.active) AS staff,
            (SELECT max(created_at) FROM audit_logs a WHERE a.hotel_id = h.id) AS last_activity
       FROM hotels h LEFT JOIN plans p ON p.id = h.plan_id ORDER BY h.created_at DESC`));
});

r.get('/platform/hotels/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const h = await one('SELECT * FROM hotels WHERE id = $1', [id]);
  if (!h) throw notFound();
  h.users = await many('SELECT id, name, email, role, active, last_login_at FROM users WHERE hotel_id = $1 ORDER BY role, name', [id]);
  res.json(h);
});

// Onboard a hotel together with its owner account
r.post('/platform/hotels', async (req, res) => {
  const b = parse(z.object({
    name: z.string().min(2), slug: z.string().regex(/^[a-z0-9-]{3,40}$/, 'lowercase letters, numbers and dashes'),
    city: z.string().optional(), state: z.string().optional(), phone: z.string().optional(), email: z.string().optional(),
    gstin: z.string().optional(), plan_id: z.number().int().optional(), trial_days: z.number().int().min(0).max(90).default(14),
    owner: z.object({ name: z.string().min(2), email: z.string().trim().toLowerCase(), phone: z.string().optional(), password: z.string().min(8) }),
  }), req.body);
  const out = await tx(async (db) => {
    const h = await db.one(
      `INSERT INTO hotels (name, slug, city, state, phone, email, gstin, state_code, plan_id, subscription_status, trial_ends_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'trial', now() + ($10 || ' days')::interval) RETURNING *`,
      [b.name, b.slug, b.city ?? null, b.state ?? null, b.phone ?? null, b.email ?? null, b.gstin ?? null,
        b.gstin && /^\d{2}/.test(b.gstin) ? b.gstin.slice(0, 2) : null, b.plan_id ?? null, b.trial_days]);
    const owner = await db.one(
      `INSERT INTO users (hotel_id, name, email, phone, password_hash, role) VALUES ($1,$2,$3,$4,$5,'owner') RETURNING id, name, email`,
      [h.id, b.owner.name, b.owner.email, b.owner.phone ?? null, await bcrypt.hash(b.owner.password, 10)]);
    await db.query(`INSERT INTO stations (hotel_id, name) VALUES ($1,'Kitchen')`, [h.id]);
    await audit({ ...req, hotelId: h.id }, 'platform.hotel_onboarded', 'hotel', h.id, { by: req.admin.email }, db);
    return { hotel: h, owner };
  });
  res.status(201).json(out);
});

r.patch('/platform/hotels/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(z.object({
    plan_id: z.number().int().nullable().optional(),
    subscription_status: z.enum(['trial', 'active', 'past_due', 'suspended', 'cancelled']).optional(),
    trial_ends_at: z.string().nullable().optional(), name: z.string().min(2).optional(),
    city: z.string().nullable().optional(), state: z.string().nullable().optional(),
    phone: z.string().nullable().optional(), email: z.string().nullable().optional(),
  }), req.body);
  const keys = Object.keys(b);
  if (!keys.length) throw badRequest('Nothing to update');
  if (b.plan_id) {
    const plan = await one('SELECT id FROM plans WHERE id = $1', [b.plan_id]);
    if (!plan) throw badRequest('Unknown plan');
  }
  const row = await one(`UPDATE hotels SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1} RETURNING *`,
    [...keys.map((k) => b[k]), id]);
  if (!row) throw notFound();
  await audit({ ...req, hotelId: id }, 'platform.hotel_updated', 'hotel', id, { ...b, by: req.admin.email });
  res.json(row);
});

// Permanently remove a hotel and ALL its data. Only for hotels already marked cancelled, and the
// hotel's link name (slug) must be typed to confirm. Download the export first if the data is needed.
r.delete('/platform/hotels/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(z.object({ confirm: z.string() }), req.body || {});
  const h = await one('SELECT id, name, slug, subscription_status FROM hotels WHERE id = $1', [id]);
  if (!h) throw notFound();
  if (h.subscription_status !== 'cancelled') throw conflict('Set the hotel to "cancelled" before deleting it.');
  if (b.confirm.trim() !== h.slug) throw badRequest(`Type the hotel link name "${h.slug}" to confirm`);
  await tx(async (db) => {
    await db.query('DELETE FROM hotels WHERE id = $1', [id]);
    await audit({ ...req, hotelId: null }, 'platform.hotel_deleted', 'hotel', id, { name: h.name, slug: h.slug, by: req.admin.email }, db);
  });
  res.json({ ok: true });
});

// Support access: short-lived token as the hotel owner (audited)
r.post('/platform/hotels/:id/support-login', async (req, res) => {
  const id = idParam(req.params.id);
  const owner = await one(`SELECT id FROM users WHERE hotel_id = $1 AND role = 'owner' AND active ORDER BY id LIMIT 1`, [id]);
  if (!owner) throw notFound('No active owner');
  await audit({ ...req, hotelId: id }, 'platform.support_login', 'hotel', id, { by: req.admin.email });
  res.json({ token: signToken({ type: 'staff', sub: owner.id, hotel_id: id, support: req.admin.id }, '1h') });
});

// Data export for offboarding (JSON dump of the hotel's records)
r.get('/platform/hotels/:id/export', async (req, res) => {
  const id = idParam(req.params.id);
  const tables = ['hotels', 'room_types', 'rooms', 'guests', 'bookings', 'stays', 'folios', 'folio_lines', 'payments', 'menu_categories', 'menu_items',
    'orders', 'order_items', 'hk_tasks', 'maintenance_requests', 'lost_found'];
  const data = {};
  for (const t of tables) data[t] = await many(`SELECT * FROM ${t} WHERE ${t === 'hotels' ? 'id' : 'hotel_id'} = $1`, [id]);
  await audit({ ...req, hotelId: id }, 'platform.data_exported', 'hotel', id, { by: req.admin.email });
  res.setHeader('Content-Disposition', `attachment; filename="hotel-${id}-export.json"`);
  res.json(data);
});

export default r;
