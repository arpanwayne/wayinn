import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { one, query } from '../db.js';
import { parse } from '../lib/validate.js';
import { unauthorized, badRequest } from '../lib/errors.js';
import { signToken, requireStaff, requirePlatform } from '../middleware/auth.js';
import { effectivePermissions } from '../lib/permissions.js';
import { audit } from '../lib/audit.js';

const r = Router();
const loginSchema = z.object({ email: z.string().trim().toLowerCase().min(3), password: z.string().min(1) });

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, hotel_id: u.hotel_id });
const publicHotel = (h) => ({
  id: h.id, name: h.name, slug: h.slug, currency: h.currency, timezone: h.timezone,
  subscription_status: h.subscription_status, settings: h.settings,
});

r.post('/auth/login', async (req, res) => {
  const { email, password } = parse(loginSchema, req.body);
  const user = await one('SELECT * FROM users WHERE lower(email) = $1', [email]);
  if (!user || !user.active || !(await bcrypt.compare(password, user.password_hash))) throw unauthorized('Invalid email or password');
  const hotel = await one('SELECT * FROM hotels WHERE id = $1', [user.hotel_id]);
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  await audit({ hotelId: user.hotel_id, auth: { type: 'staff', sub: user.id }, ip: req.ip }, 'auth.login', 'user', user.id);
  res.json({
    token: signToken({ type: 'staff', sub: user.id, hotel_id: user.hotel_id }),
    user: publicUser(user), hotel: publicHotel(hotel), permissions: effectivePermissions(user),
  });
});

r.get('/auth/me', requireStaff, async (req, res) => {
  res.json({ user: publicUser(req.user), hotel: publicHotel(req.hotel), permissions: [...req.perms] });
});

r.post('/auth/change-password', requireStaff, async (req, res) => {
  const { current_password, new_password } = parse(
    z.object({ current_password: z.string(), new_password: z.string().min(8) }), req.body);
  if (!(await bcrypt.compare(current_password, req.user.password_hash))) throw badRequest('Current password is wrong');
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(new_password, 10), req.user.id]);
  await audit(req, 'auth.password_changed', 'user', req.user.id);
  res.json({ ok: true });
});

r.post('/platform/auth/login', async (req, res) => {
  const { email, password } = parse(loginSchema, req.body);
  const admin = await one('SELECT * FROM platform_admins WHERE lower(email) = $1', [email]);
  if (!admin || !admin.active || !(await bcrypt.compare(password, admin.password_hash))) throw unauthorized('Invalid email or password');
  res.json({ token: signToken({ type: 'platform', sub: admin.id }), admin: { id: admin.id, name: admin.name, email: admin.email } });
});

r.get('/platform/auth/me', requirePlatform, (req, res) => res.json({ admin: req.admin }));

export default r;
