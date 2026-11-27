// Rate Guard: setup, OTA price dashboard, suggestions (approve / reject), manual prices, monthly report.
// Owner only by default (rates.manage). Price checks need the add-on, which the super admin switches on.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { one, many, tx } from '../db.js';
import { parse, idParam } from '../lib/validate.js';
import { requireStaff, requirePerm } from '../middleware/auth.js';
import { badRequest, notFound, conflict, HttpError } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { DATE_RE, hotelToday, addDays } from '../lib/dates.js';
import { normalizePhone } from '../lib/messages.js';
import { nightlyRates } from '../lib/rates.js';
import { getProvider, providerList } from '../lib/rateguard/providers/index.js';
import { matchOffers } from '../lib/rateguard/rules.js';
import {
  rateGuardAddon, loadConfig, loadRooms, runCheck, addManualOffer, latestOffers, decide, decideAll, sendAlerts,
} from '../lib/rateguard/engine.js';

const r = Router();
r.use('/rate-guard', requireStaff, requirePerm('rates.manage'));
const date = z.string().regex(DATE_RE, 'Use YYYY-MM-DD');
const keyed = (req) => `rg:${req.hotelId}`;

function needAddon(req) {
  if (!rateGuardAddon(req.hotel)) throw new HttpError(402, 'Rate Guard is not active for this hotel. Ask Wayne E Solutions to switch on the add-on.');
}

r.get('/rate-guard', async (req, res) => {
  const cfg = await loadConfig(req.hotelId);
  const runs = await many(
    `SELECT id, stay_date::text AS stay_date, provider, status, offers, error, trigger, started_at, finished_at FROM rate_fetch_runs
      WHERE hotel_id = $1 ORDER BY id DESC LIMIT 20`, [req.hotelId]);
  const counts = await one(
    `SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
            count(*) FILTER (WHERE status IN ('approved','auto_applied') AND decided_at > now() - interval '30 days')::int AS applied_30d
       FROM rate_suggestions WHERE hotel_id = $1`, [req.hotelId]);
  res.json({
    addon: rateGuardAddon(req.hotel), config: cfg, providers: providerList(), rooms: await loadRooms(req.hotelId),
    runs, ...counts, today: hotelToday(req.hotel.timezone),
    whatsapp_ready: !!(await one(`SELECT 1 AS x FROM hotel_integrations WHERE hotel_id = $1 AND whatsapp_phone_number_id IS NOT NULL AND whatsapp_token IS NOT NULL`, [req.hotelId])),
  });
});

const configSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.enum(['serpapi', 'mock', 'manual']).optional(),
  undercut_pct: z.number().min(0).max(50).optional(),
  rounding: z.enum(['49_99', '99', 'none']).optional(),
  min_change_paise: z.number().int().min(0).max(10_000_000).optional(),
  mode: z.enum(['approve', 'auto']).optional(),
  auto_max_change_pct: z.number().min(1).max(50).optional(),
  alert_phones: z.array(z.string().trim().regex(/^\+?[0-9 -]{8,16}$/, 'Phone numbers only')).max(5).optional(),
  alert_on_increase: z.boolean().optional(),
  max_alerts_per_run: z.number().int().min(0).max(20).optional(),
  horizon_days: z.number().int().min(1).max(90).optional(),
  near_days: z.number().int().min(0).max(30).optional(),
  near_every_hours: z.number().int().min(1).max(24).optional(),
  far_every_hours: z.number().int().min(1).max(168).optional(),
  adults: z.number().int().min(1).max(6).optional(),
});

r.put('/rate-guard/config', async (req, res) => {
  const b = parse(configSchema, req.body);
  if (b.enabled) needAddon(req);
  if (b.provider === 'mock' && !providerList().some((p) => p.name === 'mock')) throw badRequest('Demo prices are not available on this server');
  if (b.alert_phones) {
    const bad = b.alert_phones.find((p) => !normalizePhone(p));
    if (bad) throw badRequest(`${bad} is not a valid mobile number`);
    b.alert_phones = [...new Set(b.alert_phones.map(normalizePhone))];
  }
  const cur = await loadConfig(req.hotelId);
  const next = { ...cur, ...b };
  if (next.enabled && next.mode === 'approve' && !next.alert_phones.length) {
    // Approvals also work from the dashboard, so this is allowed; just make it visible.
    res.set('x-warning', 'No WhatsApp number for alerts');
  }
  const cols = Object.keys(b);
  if (cols.length) {
    await one(`INSERT INTO rate_guard_config (hotel_id) VALUES ($1) ON CONFLICT (hotel_id) DO NOTHING RETURNING hotel_id`, [req.hotelId]);
    await one(`UPDATE rate_guard_config SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE hotel_id = $1 RETURNING hotel_id`,
      [req.hotelId, ...cols.map((k) => b[k])]);
    await audit(req, 'rate_guard.config_updated', 'hotel', req.hotelId, b);
  }
  res.json(await loadConfig(req.hotelId));
});

const roomSchema = z.object({
  room_type_id: z.number().int(),
  enabled: z.boolean().default(true),
  floor_paise: z.number().int().min(0),
  ceiling_paise: z.number().int().min(0),
  match_keywords: z.string().trim().max(200).nullable().optional(),
  meal_plan: z.enum(['any', 'room_only', 'breakfast']).default('any'),
  refundable: z.enum(['any', 'refundable', 'non_refundable']).default('any'),
});

r.put('/rate-guard/rooms', async (req, res) => {
  const list = parse(z.array(roomSchema).max(30), req.body);
  await tx(async (db) => {
    for (const m of list) {
      if (!(await db.one('SELECT id FROM room_types WHERE id = $1 AND hotel_id = $2', [m.room_type_id, req.hotelId]))) throw badRequest('Unknown room type');
      if (m.ceiling_paise < m.floor_paise) throw badRequest('The ceiling price must be at least the floor price');
      await db.query(
        `INSERT INTO rate_guard_rooms (room_type_id, hotel_id, enabled, floor_paise, ceiling_paise, match_keywords, meal_plan, refundable, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
         ON CONFLICT (room_type_id) DO UPDATE SET enabled = $3, floor_paise = $4, ceiling_paise = $5, match_keywords = $6, meal_plan = $7, refundable = $8, updated_at = now()`,
        [m.room_type_id, req.hotelId, m.enabled, m.floor_paise, m.ceiling_paise, m.match_keywords || null, m.meal_plan, m.refundable]);
    }
    await audit(req, 'rate_guard.rooms_updated', 'hotel', req.hotelId, { rooms: list }, db);
  });
  res.json(await loadRooms(req.hotelId));
});

// Find the hotel on Google Hotels (one paid search per call).
r.get('/rate-guard/property-search', rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, keyGenerator: keyed }), async (req, res) => {
  needAddon(req);
  const q = parse(z.string().trim().min(3).max(120), req.query.q);
  const cfg = await loadConfig(req.hotelId);
  const provider = getProvider(cfg.provider);
  if (!provider.ready()) throw badRequest(`${provider.label} is not set up on the server yet`);
  const checkIn = addDays(hotelToday(req.hotel.timezone), 7);
  try {
    res.json(await provider.search(q, { checkIn, checkOut: addDays(checkIn, 1) }, req.app.locals.rateFetch));
  } catch (e) { throw badRequest(e.message); }
});

r.put('/rate-guard/property', async (req, res) => {
  const b = parse(z.object({ token: z.string().trim().min(3).max(300), name: z.string().trim().min(2).max(200), address: z.string().trim().max(300).nullable().optional() }), req.body);
  await one(`INSERT INTO rate_guard_config (hotel_id, property_token, property_name, property_address) VALUES ($1,$2,$3,$4)
             ON CONFLICT (hotel_id) DO UPDATE SET property_token = $2, property_name = $3, property_address = $4, updated_at = now() RETURNING hotel_id`,
  [req.hotelId, b.token, b.name, b.address || null]);
  await audit(req, 'rate_guard.property_linked', 'hotel', req.hotelId, { name: b.name });
  res.json(await loadConfig(req.hotelId));
});

// Check prices now: one date, or the next `near_days` dates. No WhatsApp alerts for checks started here.
r.post('/rate-guard/check', rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, keyGenerator: keyed }), async (req, res) => {
  needAddon(req);
  const b = parse(z.object({ date: date.optional(), days: z.number().int().min(1).max(14).optional() }), req.body || {});
  const cfg = await loadConfig(req.hotelId);
  const provider = getProvider(cfg.provider);
  if (!provider.manual && !provider.ready()) throw badRequest(`${provider.label} is not set up on the server yet`);
  if (!provider.manual && !cfg.property_token) throw badRequest('Link the hotel to its Google Hotels listing first');
  const today = hotelToday(req.hotel.timezone);
  if (b.date && b.date < today) throw badRequest('That date has passed');
  const dates = b.date ? [b.date] : Array.from({ length: b.days || Math.max(1, Math.min(cfg.near_days || 7, 14)) }, (_, i) => addDays(today, i));
  const out = { checked: 0, offers: 0, suggestions: 0, errors: [] };
  for (const d of dates) {
    const x = await runCheck(req.hotel, cfg, d, { trigger: 'manual', fetchImpl: req.app.locals.rateFetch });
    out.checked++; out.offers += x.offers; out.suggestions += x.suggestions.length;
    if (x.error) { out.errors.push(`${d}: ${x.error}`); if (x.retry === false) break; }
  }
  await audit(req, 'rate_guard.checked', 'hotel', req.hotelId, { dates: dates.length, offers: out.offers });
  res.json(out);
});

// Date-wise table: our rate, each OTA's (matched) price, the cheapest, and the open suggestion.
r.get('/rate-guard/dashboard', async (req, res) => {
  const today = hotelToday(req.hotel.timezone);
  const from = req.query.from ? parse(date, req.query.from) : today;
  const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 60);
  const to = addDays(from, days);
  const rooms = await loadRooms(req.hotelId);
  const grid = await nightlyRates({ many }, req.hotelId, from, to, rooms);
  const offers = (await latestOffers(req.hotelId, from, to, 72)).map((o) => ({ ...o, pretax: Number(o.pretax_paise) }));
  const pending = await many(
    `SELECT id, room_type_id, stay_date::text AS stay_date, code, current_rate_paise, suggested_rate_paise, ota_name, ota_rate_paise, reason, alerted_at
       FROM rate_suggestions WHERE hotel_id = $1 AND status = 'pending' AND stay_date >= $2 AND stay_date < $3`, [req.hotelId, from, to]);
  const otaNames = {};
  const out = rooms.map((rm) => ({
    id: rm.id, name: rm.name, mapping: rm.mapping,
    days: grid.get(Number(rm.id)).map((n) => {
      const all = offers.filter((o) => o.stay_date === n.date);
      const matched = rm.mapping ? matchOffers(all, rm.mapping, rooms.filter((x) => x.id !== rm.id && x.mapping?.enabled).map((x) => x.mapping.match_keywords)) : [];
      const otas = {};
      for (const o of matched) {
        otaNames[o.ota] = o.ota_name;
        if (!otas[o.ota] || o.pretax < otas[o.ota].pretax) otas[o.ota] = { name: o.ota_name, rate_paise: o.rate_paise, pretax: o.pretax, room_name: o.room_name, link: o.link, seen: o.observed_at };
      }
      const cheapest = Object.values(otas).sort((a, b) => a.pretax - b.pretax)[0] || null;
      const official = all.find((o) => o.official) || null;
      return {
        date: n.date, our_rate_paise: n.rate_paise, overridden: n.overridden, stop_sell: n.stop_sell, otas, cheapest,
        official: official ? { rate_paise: official.rate_paise, pretax: Number(official.pretax_paise) } : null,
        suggestion: pending.find((p) => p.room_type_id === rm.id && p.stay_date === n.date) || null,
      };
    }),
  }));
  res.json({ from, to, today, otas: Object.entries(otaNames).map(([key, name]) => ({ key, name })), room_types: out });
});

r.get('/rate-guard/suggestions', async (req, res) => {
  const status = req.query.status || 'pending';
  const vals = [req.hotelId];
  let where = 's.hotel_id = $1';
  if (status !== 'all') { vals.push(status); where += ` AND s.status = $${vals.length}`; }
  res.json(await many(
    `SELECT s.*, s.stay_date::text AS stay_date, rt.name AS room_type, u.name AS decided_by_name
       FROM rate_suggestions s JOIN room_types rt ON rt.id = s.room_type_id LEFT JOIN users u ON u.id = s.decided_by
      WHERE ${where} ORDER BY ${status === 'pending' ? 's.stay_date, rt.base_rate_paise' : 's.id DESC'} LIMIT 300`, vals));
});

const decided = (out) => {
  if (out.error === 'not_found') throw notFound('This suggestion is no longer open');
  if (out.error === 'expired') throw conflict('This date has passed');
  return out.suggestion;
};
r.post('/rate-guard/suggestions/:id/approve', async (req, res) => {
  res.json(decided(await decide(req.hotel, { id: idParam(req.params.id) }, true, { userId: req.user.id, via: 'dashboard' })));
});
r.post('/rate-guard/suggestions/:id/reject', async (req, res) => {
  res.json(decided(await decide(req.hotel, { id: idParam(req.params.id) }, false, { userId: req.user.id, via: 'dashboard' })));
});
r.post('/rate-guard/suggestions/approve-all', async (req, res) => {
  res.json({ approved: await decideAll(req.hotel, true, { userId: req.user.id, via: 'dashboard' }) });
});
r.post('/rate-guard/suggestions/reject-all', async (req, res) => {
  res.json({ rejected: await decideAll(req.hotel, false, { userId: req.user.id, via: 'dashboard' }) });
});

// An OTA price typed in by hand (manual provider, or a price the data missed).
r.post('/rate-guard/observations', async (req, res) => {
  const b = parse(z.object({
    stay_date: date, ota_name: z.string().trim().min(2).max(60), room_name: z.string().trim().max(120).nullable().optional(),
    rate_paise: z.number().int().min(100).max(100_000_000), includes_tax: z.boolean().default(true),
    breakfast: z.boolean().nullable().optional(), refundable: z.boolean().nullable().optional(),
  }), req.body);
  if (b.stay_date < hotelToday(req.hotel.timezone)) throw badRequest('That date has passed');
  const cfg = await loadConfig(req.hotelId);
  const created = await addManualOffer(req.hotel, cfg, { ...b, pretax_paise: b.includes_tax ? null : b.rate_paise });
  if (cfg.enabled) await sendAlerts(req.hotel, cfg, created);
  await audit(req, 'rate_guard.price_added', 'hotel', req.hotelId, b);
  res.status(201).json({ suggestions: created.length });
});

// Monthly report: direct vs OTA bookings and the OTA commission the direct ones saved.
r.get('/rate-guard/report', async (req, res) => {
  const month = req.query.month && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : hotelToday(req.hotel.timezone).slice(0, 7);
  const pct = Math.min(Math.max(Number(req.query.commission_pct) || Number(req.hotel.settings?.ota_commission_pct) || 18, 0), 40);
  const from = `${month}-01`;
  const to = addDays(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 10), 0);
  const rows = await many(
    `SELECT b.source, count(DISTINCT b.id)::int AS bookings,
            COALESCE(sum(s.nightly_rate_paise * (s.check_out_date - s.check_in_date)), 0)::bigint AS room_revenue_paise
       FROM bookings b JOIN stays s ON s.booking_id = b.id
      WHERE b.hotel_id = $1 AND b.status <> 'cancelled' AND s.status NOT IN ('cancelled','no_show')
        AND b.created_at >= ($2::date AT TIME ZONE $4) AND b.created_at < ($3::date AT TIME ZONE $4)
      GROUP BY b.source`, [req.hotelId, from, to, req.hotel.timezone]);
  const DIRECT = ['direct_online', 'google'];
  const OTA = ['makemytrip', 'goibibo', 'oyo', 'booking_com', 'agoda', 'airbnb', 'expedia', 'channel_manager', 'ota'];
  const sum = (keys, f) => rows.filter((x) => keys.includes(x.source)).reduce((a, x) => a + Number(x[f]), 0);
  const changes = await one(
    `SELECT count(*) FILTER (WHERE source = 'rate_guard')::int AS approved, count(*) FILTER (WHERE source = 'auto_pilot')::int AS auto
       FROM rate_changes WHERE hotel_id = $1 AND undone_at IS NULL AND created_at >= ($2::date AT TIME ZONE $4) AND created_at < ($3::date AT TIME ZONE $4)`,
    [req.hotelId, from, to, req.hotel.timezone]);
  const directRevenue = sum(DIRECT, 'room_revenue_paise');
  res.json({
    month, commission_pct: pct, by_source: rows,
    direct: { bookings: sum(DIRECT, 'bookings'), room_revenue_paise: directRevenue, from_google: rows.find((x) => x.source === 'google')?.bookings || 0 },
    ota: { bookings: sum(OTA, 'bookings'), room_revenue_paise: sum(OTA, 'room_revenue_paise') },
    commission_saved_paise: Math.round((directRevenue * pct) / 100),
    rate_changes: changes,
  });
});

export default r;
