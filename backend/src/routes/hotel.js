import { Router } from 'express';
import { z } from 'zod';
import { one, many } from '../db.js';
import { parse } from '../lib/validate.js';
import { requireStaff, requirePerm } from '../middleware/auth.js';
import { PERMISSIONS, ROLE_PERMISSIONS } from '../lib/permissions.js';
import { taxSettings } from '../lib/money.js';
import { audit } from '../lib/audit.js';

const r = Router();
r.use('/hotel', requireStaff);

r.get('/hotel', async (req, res) => {
  const h = req.hotel;
  const plan = h.plan_id ? await one('SELECT code, name, max_rooms, max_staff FROM plans WHERE id = $1', [h.plan_id]) : null;
  res.json({ ...h, tax: taxSettings(h), plan });
});

const settingsSchema = z.object({
  name: z.string().min(2).optional(),
  legal_name: z.string().nullable().optional(),
  gstin: z.string().regex(/^[0-9A-Z]{15}$/, 'GSTIN must be 15 characters').nullable().optional().or(z.literal('')),
  address: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  state_code: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  currency: z.string().length(3).optional(),
  timezone: z.string().optional(),
  checkin_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  checkout_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  invoice_prefix: z.string().max(6).optional(),
  settings: z.object({
    tax: z.object({
      room_slabs: z.array(z.object({ upto_paise: z.number().int().nullable(), rate: z.number().min(0).max(40) })).optional(),
      food_rate: z.number().min(0).max(40).optional(),
      service_rate: z.number().min(0).max(40).optional(),
      room_sac: z.string().optional(),
      food_sac: z.string().optional(),
      service_sac: z.string().optional(),
    }).optional(),
    qr_orders_require_accept: z.boolean().optional(),
    qr_show_bill: z.boolean().optional(),
    discount_alert_pct: z.number().min(0).max(100).optional(),
    registration_fields: z.array(z.object({ key: z.string(), label: z.string(), required: z.boolean().default(false) })).optional(),
    invoice_footer: z.string().optional(),
  }).partial().optional(),
});

r.put('/hotel', requirePerm('hotel.settings'), async (req, res) => {
  const body = parse(settingsSchema, req.body);
  const { settings, ...cols } = body;
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(cols)) { vals.push(v === '' ? null : v); sets.push(`${k} = $${vals.length}`); }
  if (settings) {
    const merged = { ...req.hotel.settings, ...settings, tax: { ...(req.hotel.settings.tax || {}), ...(settings.tax || {}) } };
    vals.push(JSON.stringify(merged)); sets.push(`settings = $${vals.length}`);
  }
  if (!sets.length) return res.json(req.hotel);
  vals.push(req.hotelId);
  const updated = await one(`UPDATE hotels SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);
  await audit(req, 'hotel.settings_updated', 'hotel', req.hotelId, { changed: Object.keys(body) });
  res.json(updated);
});

r.get('/hotel/permissions', (_req, res) => res.json({ permissions: PERMISSIONS, roles: ROLE_PERMISSIONS }));

// Shift handover notes
r.get('/hotel/handover', async (req, res) => {
  res.json(await many(
    `SELECT h.*, u.name AS user_name FROM handover_notes h LEFT JOIN users u ON u.id = h.user_id
      WHERE h.hotel_id = $1 AND (NOT h.resolved OR h.created_at > now() - interval '2 days')
      ORDER BY h.resolved, h.created_at DESC LIMIT 100`, [req.hotelId]));
});
r.post('/hotel/handover', async (req, res) => {
  const b = parse(z.object({ note: z.string().min(1), department: z.string().default('front_desk') }), req.body);
  res.status(201).json(await one(
    `INSERT INTO handover_notes (hotel_id, user_id, department, note) VALUES ($1,$2,$3,$4) RETURNING *`,
    [req.hotelId, req.user.id, b.department, b.note]));
});
r.patch('/hotel/handover/:id', async (req, res) => {
  const row = await one(`UPDATE handover_notes SET resolved = $1 WHERE id = $2 AND hotel_id = $3 RETURNING *`,
    [!!req.body.resolved, req.params.id, req.hotelId]);
  res.json(row);
});

// Audit / activity history
r.get('/hotel/audit', requirePerm('audit.view'), async (req, res) => {
  const { entity_type, entity_id, limit = 200 } = req.query;
  const vals = [req.hotelId];
  let where = 'a.hotel_id = $1';
  if (entity_type === 'booking' && entity_id) {
    // A booking's history also covers its stays (check-in, modify, cancel, no-show…), which are logged against the stay.
    vals.push(Number(entity_id), String(entity_id));
    where += ` AND ((a.entity_type = 'booking' AND a.entity_id = $${vals.length - 1}) OR (a.entity_type = 'stay' AND a.data->>'booking_id' = $${vals.length}))`;
  } else {
    if (entity_type) { vals.push(entity_type); where += ` AND a.entity_type = $${vals.length}`; }
    if (entity_id) { vals.push(entity_id); where += ` AND a.entity_id = $${vals.length}`; }
  }
  vals.push(Math.min(Number(limit) || 200, 1000));
  res.json(await many(
    `SELECT a.*, u.name AS actor_name FROM audit_logs a
       LEFT JOIN users u ON a.actor_type = 'staff' AND u.id = a.actor_id
      WHERE ${where} ORDER BY a.created_at DESC LIMIT $${vals.length}`, vals));
});

export default r;
