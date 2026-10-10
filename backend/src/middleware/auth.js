import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { one } from '../db.js';
import { unauthorized, forbidden, HttpError } from '../lib/errors.js';
import { effectivePermissions } from '../lib/permissions.js';

export const signToken = (payload, expiresIn = config.jwtExpiresIn) => jwt.sign(payload, config.jwtSecret, { expiresIn });

function readToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return null;
}

function verify(req) {
  const t = readToken(req);
  if (!t) throw unauthorized();
  try {
    return jwt.verify(t, config.jwtSecret);
  } catch {
    throw unauthorized('Session expired, please log in again');
  }
}

/**
 * Staff auth. Re-loads the user each request so deactivation and permission changes apply immediately.
 * Sets req.auth, req.user, req.hotel, req.hotelId, req.perms.
 */
export async function requireStaff(req, _res, next) {
  const payload = verify(req);
  if (payload.type !== 'staff') throw unauthorized();
  const user = await one('SELECT * FROM users WHERE id = $1', [payload.sub]);
  if (!user || !user.active) throw unauthorized('Account is inactive');
  const hotel = await one('SELECT * FROM hotels WHERE id = $1', [user.hotel_id]);
  if (!hotel) throw unauthorized();
  if (['suspended', 'cancelled'].includes(hotel.subscription_status)) {
    throw new HttpError(402, 'This hotel subscription is not active. Please contact Wayne E Solutions.');
  }
  req.auth = payload;
  req.user = user;
  req.hotel = hotel;
  req.hotelId = hotel.id;
  req.perms = new Set(effectivePermissions(user));
  next();
}

export const can = (req, perm) => req.perms?.has(perm);

/** requirePerm('a') or requirePerm('a','b') → needs ANY of them. */
export const requirePerm = (...perms) => (req, _res, next) => {
  if (!perms.some((p) => req.perms?.has(p))) throw forbidden();
  next();
};

export function assertPerm(req, perm, message) {
  if (!req.perms?.has(perm)) throw forbidden(message);
}

export async function requirePlatform(req, _res, next) {
  const payload = verify(req);
  if (payload.type !== 'platform') throw unauthorized();
  const admin = await one('SELECT id, name, email, active FROM platform_admins WHERE id = $1', [payload.sub]);
  if (!admin?.active) throw unauthorized();
  req.auth = payload;
  req.admin = admin;
  next();
}

/** Guest portal token: scoped to one stay. Expires/invalidates when the stay is no longer checked in. */
export async function requireGuest(req, _res, next) {
  const payload = verify(req);
  if (payload.type !== 'guest') throw unauthorized();
  const stay = await one(`SELECT s.*, r.qr_token FROM stays s JOIN rooms r ON r.id = s.room_id WHERE s.id = $1`, [payload.stay_id]);
  if (!stay || stay.status !== 'checked_in' || stay.qr_token !== payload.qr) throw unauthorized('Your portal session has ended');
  req.auth = payload;
  req.stay = stay;
  req.hotelId = stay.hotel_id;
  next();
}
