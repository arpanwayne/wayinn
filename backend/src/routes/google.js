// Google Hotels: what Google fetches from us (hotel list feed, landing page link) and the owner's setup screen.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { one, many } from '../db.js';
import { parse } from '../lib/validate.js';
import { requireStaff, requirePerm } from '../middleware/auth.js';
import { notFound, badRequest, HttpError } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { config } from '../config.js';
import { DATE_RE, addDays, hotelToday } from '../lib/dates.js';
import { safeEqual } from '../lib/integrations.js';
import { rateGuardAddon } from '../lib/rateguard/engine.js';
import { hotelListXml, rateAmountXml, availXml, invCountXml, toRanges } from '../lib/google/xml.js';
import { loadGoogle, canPush, partnerKey, desiredState, syncHotel, sendPropertyData, propertyDataFor } from '../lib/google/sync.js';

const r = Router();
const appUrl = () => config.publicAppUrl.replace(/\/$/, '');
const apiUrl = () => `${appUrl()}/api`;

/** Landing page template to enter in Hotel Center → Landing pages. */
export const landingTemplate = () =>
  `${apiUrl()}/google/landing?hotel=(PARTNER-HOTEL-ID)&checkin=(CHECKINYEAR)-(CHECKINMONTH)-(CHECKINDAY)&nights=(LENGTH)&room=(PARTNER-ROOM-ID)`;

// ---- Public (Google) --------------------------------------------------------------------------------
// Hotel list feed for Hotel Center ("Hotel list pull"). Protected by GOOGLE_FEED_TOKEN in the URL.
r.get('/google/hotel-list.xml', rateLimit({ windowMs: 60 * 1000, limit: 30 }), async (req, res) => {
  const token = process.env.GOOGLE_FEED_TOKEN;
  if (!token || !safeEqual(String(req.query.token || ''), token)) throw notFound();
  const rows = await many(
    `SELECT g.property_id AS id, h.name, h.address, h.city, h.state, g.postal_code, g.latitude AS lat, g.longitude AS lng, h.phone, g.category, h.settings
       FROM google_hotels g JOIN hotels h ON h.id = g.hotel_id
      WHERE g.enabled AND g.status IN ('testing','live') AND h.subscription_status IN ('trial','active','past_due') ORDER BY g.property_id`);
  res.type('application/xml').send(hotelListXml(rows.filter((x) => x.settings?.addons?.rate_guard === true).map((x) => ({ ...x, country: 'IN' }))));
});

// Where Google sends the guest: our booking page with the dates and room already chosen.
r.get('/google/landing', rateLimit({ windowMs: 60 * 1000, limit: 120 }), async (req, res) => {
  const id = String(req.query.hotel || '').slice(0, 40);
  const g = id ? await one(
    `SELECT h.slug, h.timezone FROM google_hotels g JOIN hotels h ON h.id = g.hotel_id WHERE g.property_id = $1 AND h.subscription_status IN ('trial','active','past_due')`, [id]) : null;
  if (!g) return res.redirect(302, appUrl());
  const q = new URLSearchParams({ src: 'google' });
  const checkin = DATE_RE.test(String(req.query.checkin || '')) ? String(req.query.checkin) : null;
  if (checkin && checkin >= hotelToday(g.timezone)) {
    q.set('checkin', checkin);
    const nights = Math.min(Math.max(Number.parseInt(req.query.nights, 10) || 1, 1), 30);
    q.set('checkout', DATE_RE.test(String(req.query.checkout || '')) && req.query.checkout > checkin ? String(req.query.checkout) : addDays(checkin, nights));
  }
  if (/^\d{1,12}$/.test(String(req.query.room || ''))) q.set('room', String(req.query.room));
  res.redirect(302, `${appUrl()}/book/${encodeURIComponent(g.slug)}?${q}`);
});

// ---- Owner -------------------------------------------------------------------------------------------
r.use('/google', requireStaff, requirePerm('rates.manage'));

r.get('/google', async (req, res) => {
  const g = await loadGoogle(req.hotelId);
  const logs = await many(`SELECT id, message, status, items, error, created_at FROM google_ari_log WHERE hotel_id = $1 ORDER BY id DESC LIMIT 30`, [req.hotelId]);
  const sent = await one(`SELECT count(*)::int AS nights, max(sent_at) AS last FROM google_ari_state WHERE hotel_id = $1`, [req.hotelId]);
  res.json({
    addon: rateGuardAddon(req.hotel), partner_configured: !!partnerKey(), pushing: canPush(req.hotel, g), config: g, logs, sent,
    landing_template: landingTemplate(), booking_page: `${appUrl()}/book/${req.hotel.slug}`,
    missing: [!req.hotel.address && 'address', !req.hotel.city && 'city', !req.hotel.phone && 'phone', g.latitude === null && 'map location (latitude / longitude)']
      .filter(Boolean),
  });
});

r.put('/google', async (req, res) => {
  const b = parse(z.object({
    enabled: z.boolean().optional(),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
    postal_code: z.string().trim().max(12).nullable().optional(),
    category: z.enum(['hotel', 'guest_house', 'homestay', 'resort', 'hostel', 'lodge', 'motel']).optional(),
    refundable_days: z.number().int().min(0).max(30).nullable().optional(),
    breakfast_included: z.boolean().optional(),
    photo_urls: z.array(z.string().trim().url().max(500)).max(10).optional(),
    sync_days: z.number().int().min(30).max(500).optional(),
  }), req.body);
  if (b.enabled && !rateGuardAddon(req.hotel)) throw new HttpError(402, 'Google Hotels comes with the Rate Guard add-on. Ask Wayne E Solutions to switch it on.');
  await loadGoogle(req.hotelId);
  const keys = Object.keys(b);
  if (keys.length) {
    await one(`UPDATE google_hotels SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE hotel_id = $1 RETURNING hotel_id`,
      [req.hotelId, ...keys.map((k) => b[k])]);
    // New package terms (refund, breakfast) or photos: send the property data again.
    if (['refundable_days', 'breakfast_included', 'photo_urls'].some((k) => k in b)) {
      await one(`UPDATE google_hotels SET property_data_sent_at = NULL WHERE hotel_id = $1 RETURNING hotel_id`, [req.hotelId]);
    }
    await audit(req, 'google.updated', 'hotel', req.hotelId, b);
  }
  res.json(await loadGoogle(req.hotelId));
});

// Push now (only changes; ?full=1 resends everything).
r.post('/google/sync', rateLimit({ windowMs: 10 * 60 * 1000, limit: 10, keyGenerator: (req) => `g:${req.hotelId}` }), async (req, res) => {
  const g = await loadGoogle(req.hotelId);
  if (canPush(req.hotel, g) && !g.property_data_sent_at) await sendPropertyData(req.hotel, { fetchImpl: req.app.locals.googleFetch });
  const out = await syncHotel(req.hotel, { force: req.query.full === '1', fetchImpl: req.app.locals.googleFetch });
  await audit(req, 'google.synced', 'hotel', req.hotelId, { full: req.query.full === '1', dry_run: out.dry_run });
  res.json(out);
});

r.post('/google/property-data', async (req, res) => {
  const out = await sendPropertyData(req.hotel, { fetchImpl: req.app.locals.googleFetch });
  if (out.dry_run) throw badRequest('Google is not switched on for this hotel yet (or the partner key is not set)');
  if (!out.ok) throw badRequest(`Google did not accept the room data: ${out.error}`);
  res.json(out);
});

// The XML Google would get, for checking (first 60 days, everything, not only changes).
r.get('/google/preview', async (req, res) => {
  const kind = parse(z.enum(['rate', 'avail', 'inv_count', 'property_data']), req.query.kind || 'rate');
  const g = await loadGoogle(req.hotelId);
  if (kind === 'property_data') return res.type('application/xml').send(await propertyDataFor(req.hotel, g));
  const { from, state } = await desiredState(req.hotel, { ...g, sync_days: 60 });
  const rows = [...state.values()].filter((s) => s.date < addDays(from, 60));
  const args = { partnerKey: partnerKey() || 'PARTNER_KEY', hotelCode: g.property_id, echo: 'preview' };
  const xml = kind === 'rate' ? rateAmountXml({ ...args, items: toRanges(rows, ['rate_paise', 'after_tax_paise', 'guests', 'extra_adult_paise']) })
    : kind === 'avail' ? availXml({ ...args, items: toRanges(rows, ['closed', 'min_stay']) })
      : invCountXml({ ...args, items: toRanges(rows, ['available']) });
  res.type('application/xml').send(xml);
});

export default r;
