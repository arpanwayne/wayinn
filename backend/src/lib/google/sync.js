// Google Hotels sync. Wayne E Solutions is the connectivity partner: one Hotel Center account (partner key)
// serves every Wayinn hotel, each with its own Hotel ID (google_hotels.property_id).
//
// What Google gets, per room type and night, for the next `sync_days` days:
//   rate (before GST and with GST)  → hotel_rate_amount_notif
//   open / stop-sell, minimum stay  → hotel_avail_notif
//   rooms left to sell              → hotel_inv_count_notif
// Only what changed since the last successful push is sent (google_ari_state remembers what Google has).
// A rate change (rate calendar, Rate Guard approval) triggers a push within a minute; bookings are picked up by
// the regular pass every few minutes.
//
// Nothing is sent while GOOGLE_HOTEL_PARTNER_KEY is missing or the hotel's status is draft / paused ("dry run").
import { one, many, tx } from '../../db.js';
import { hotelToday, addDays } from '../dates.js';
import { roomTaxRate, taxOn } from '../money.js';
import { nightlyRates } from '../rates.js';
import { dailyAvailability } from '../../routes/channel.js';
import { bus } from '../events.js';
import { rateGuardAddon } from '../rateguard/engine.js';
import { rateAmountXml, availXml, invCountXml, propertyDataXml, toRanges, parseResponse } from './xml.js';

export const partnerKey = () => process.env.GOOGLE_HOTEL_PARTNER_KEY || null;
const base = () => (process.env.GOOGLE_HOTEL_UPLOAD_BASE || 'https://www.google.com/travel/hotels/uploads').replace(/\/$/, '');
export const ENDPOINTS = {
  rate: () => `${base()}/ota/hotel_rate_amount_notif`,
  avail: () => `${base()}/ota/hotel_avail_notif`,
  inv_count: () => `${base()}/ota/hotel_inv_count_notif`,
  property_data: () => `${base()}/property_data`,
};
const PUSH_STATUSES = ['testing', 'live'];

/** The hotel's Google settings, created with a permanent Hotel ID the first time. */
export async function loadGoogle(hotelId) {
  return one(
    `INSERT INTO google_hotels (hotel_id, property_id) VALUES ($1, $2)
     ON CONFLICT (hotel_id) DO UPDATE SET hotel_id = EXCLUDED.hotel_id RETURNING *`, [hotelId, `WAYINN${Number(hotelId)}`]);
}

export const canPush = (hotel, g) => !!(partnerKey() && g?.enabled && PUSH_STATUSES.includes(g.status) && rateGuardAddon(hotel)
  && ['trial', 'active', 'past_due'].includes(hotel.subscription_status));

/** What Google should show now: Map("rt|date" → state) for [today, today + sync_days). */
export async function desiredState(hotel, g) {
  const from = hotelToday(hotel.timezone);
  const to = addDays(from, g.sync_days || 365);
  const types = await many(
    `SELECT id, name, base_rate_paise, base_occupancy, extra_person_rate_paise FROM room_types WHERE hotel_id = $1 AND active ORDER BY id`, [hotel.id]);
  const grid = await nightlyRates({ many }, hotel.id, from, to, types);
  const avail = Object.fromEntries((await dailyAvailability(hotel.id, from, to)).map((t) => [t.room_type_id, t.nights]));
  const out = new Map();
  for (const t of types) {
    const free = Object.fromEntries((avail[t.id] || []).map((n) => [n.date, n.available]));
    for (const n of grid.get(Number(t.id))) {
      out.set(`${t.id}|${n.date}`, {
        room_type_id: String(t.id), date: n.date, rate_paise: n.rate_paise, after_tax_paise: n.rate_paise + taxOn(n.rate_paise, roomTaxRate(hotel, n.rate_paise)),
        available: free[n.date] ?? 0, min_stay: n.min_stay || 1, closed: n.stop_sell, guests: t.base_occupancy || 2, extra_adult_paise: Number(t.extra_person_rate_paise) || 0,
      });
    }
  }
  return { from, to, state: out };
}

async function post(url, xml, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/xml; charset=utf-8' }, body: xml });
  } catch (e) { return { ok: false, error: `Google not reachable: ${e.message}` }; }
  const text = await res.text().catch(() => '');
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${parseResponse(text).error || ''}`.slice(0, 500) };
  return parseResponse(text);
}

const echo = (hotelId, kind) => `w${hotelId}-${kind}-${Date.now().toString(36)}`;
const BATCH = 400; // ranges per message (Google recommends small messages)

async function log(hotelId, message, status, items, echoToken, error = null) {
  await one(`INSERT INTO google_ari_log (hotel_id, message, status, items, echo_token, error) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [hotelId, message, status, items, echoToken, error ? String(error).slice(0, 500) : null]);
}

/**
 * Push what changed. force = send everything again (e.g. after Google asks for a full refresh).
 * dryRun = build the messages but send nothing. Returns per message type { items, sent, error }.
 */
export async function syncHotel(hotel, { force = false, dryRun = null, fetchImpl } = {}) {
  const g = await loadGoogle(hotel.id);
  const dry = dryRun ?? !canPush(hotel, g);
  const { from, state } = await desiredState(hotel, g);
  const sent = force ? new Map() : new Map((await many(
    `SELECT room_type_id::text AS room_type_id, date::text AS date, rate_paise, after_tax_paise, available, min_stay, closed
       FROM google_ari_state WHERE hotel_id = $1 AND date >= $2`, [hotel.id, from])).map((r) => [`${r.room_type_id}|${r.date}`, r]));
  const changed = { rate: [], avail: [], inv_count: [] };
  for (const [k, s] of state) {
    const p = sent.get(k);
    if (!p || Number(p.rate_paise) !== s.rate_paise || Number(p.after_tax_paise) !== s.after_tax_paise) changed.rate.push(s);
    if (!p || p.closed !== s.closed || Number(p.min_stay) !== s.min_stay) changed.avail.push(s);
    if (!p || Number(p.available) !== s.available) changed.inv_count.push(s);
  }
  const build = {
    rate: (items, e) => rateAmountXml({ partnerKey: partnerKey(), hotelCode: g.property_id, echo: e, items }),
    avail: (items, e) => availXml({ partnerKey: partnerKey(), hotelCode: g.property_id, echo: e, items }),
    inv_count: (items, e) => invCountXml({ partnerKey: partnerKey(), hotelCode: g.property_id, echo: e, items }),
  };
  const keys = { rate: ['rate_paise', 'after_tax_paise', 'guests', 'extra_adult_paise'], avail: ['closed', 'min_stay'], inv_count: ['available'] };
  const cols = { rate: ['rate_paise', 'after_tax_paise'], avail: ['min_stay', 'closed'], inv_count: ['available'] };
  const result = { dry_run: dry, hotel_code: g.property_id };
  for (const kind of ['rate', 'avail', 'inv_count']) {
    const ranges = toRanges(changed[kind], keys[kind]);
    result[kind] = { nights: changed[kind].length, items: ranges.length, sent: 0, error: null };
    if (!ranges.length || dry) continue;
    for (let i = 0; i < ranges.length; i += BATCH) {
      const e = echo(hotel.id, kind);
      const xml = build[kind](ranges.slice(i, i + BATCH), e);
      const r = await post(ENDPOINTS[kind](), xml, fetchImpl);
      await log(hotel.id, kind, r.ok ? 'sent' : 'failed', Math.min(BATCH, ranges.length - i), e, r.error);
      if (!r.ok) { result[kind].error = r.error; break; }
      result[kind].sent += Math.min(BATCH, ranges.length - i);
    }
    if (result[kind].error) continue; // keep the old state: the next pass sends these nights again
    // Remember what Google now has, for this message's fields only.
    await tx(async (db) => {
      for (const s of changed[kind]) {
        await db.query(
          `INSERT INTO google_ari_state (hotel_id, room_type_id, date, ${cols[kind].join(', ')}, sent_at)
           VALUES ($1,$2,$3,${cols[kind].map((_, n) => `$${n + 4}`).join(',')}, now())
           ON CONFLICT (room_type_id, date) DO UPDATE SET ${cols[kind].map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, sent_at = now()`,
          [hotel.id, s.room_type_id, s.date, ...cols[kind].map((c) => s[c])]);
      }
    });
  }
  if (!dry) {
    await many(`DELETE FROM google_ari_state WHERE hotel_id = $1 AND date < $2 RETURNING date`, [hotel.id, from]);
    const err = ['rate', 'avail', 'inv_count'].map((k) => result[k].error).filter(Boolean)[0] || null;
    await one(`UPDATE google_hotels SET last_sync_at = now(), last_error = $2 WHERE hotel_id = $1 RETURNING hotel_id`, [hotel.id, err]);
  }
  return result;
}

/** Rooms and the BAR package (Transaction / Property Data). Sent on demand and before the first ARI push. */
export async function propertyDataFor(hotel, g) {
  const rooms = await many(`SELECT id, name, description, max_occupancy FROM room_types WHERE hotel_id = $1 AND active ORDER BY id`, [hotel.id]);
  return propertyDataXml({
    partnerKey: partnerKey(), hotelCode: g.property_id, id: `w${hotel.id}-pd-${Date.now().toString(36)}`,
    rooms: rooms.map((r, i) => ({ id: String(r.id), name: r.name, description: r.description, capacity: r.max_occupancy, photos: i === 0 ? g.photo_urls : [] })),
    pkg: { refundable_days: g.refundable_days, breakfast: g.breakfast_included, internet: true, name: 'Best available rate', description: `Book direct with ${hotel.name}` },
  });
}

export async function sendPropertyData(hotel, { fetchImpl } = {}) {
  const g = await loadGoogle(hotel.id);
  if (!canPush(hotel, g)) return { dry_run: true };
  const r = await post(ENDPOINTS.property_data(), await propertyDataFor(hotel, g), fetchImpl);
  await log(hotel.id, 'property_data', r.ok ? 'sent' : 'failed', 1, null, r.error);
  if (r.ok) await one(`UPDATE google_hotels SET property_data_sent_at = now() WHERE hotel_id = $1 RETURNING hotel_id`, [hotel.id]);
  return { dry_run: false, ...r };
}

// ---------------------------------------------------------------
// Background
// ---------------------------------------------------------------
const soon = new Set();
bus.on('rates.changed', ({ hotelId }) => soon.add(Number(hotelId)));

async function pushableHotels(ids = null) {
  const rows = await many(
    `SELECT h.* FROM hotels h JOIN google_hotels g ON g.hotel_id = h.id
      WHERE g.enabled AND g.status = ANY($1) AND h.subscription_status IN ('trial','active','past_due') ${ids ? 'AND h.id = ANY($2::bigint[])' : ''}`,
    ids ? [PUSH_STATUSES, ids] : [PUSH_STATUSES]);
  return rows.filter((h) => rateGuardAddon(h));
}

/** Hotels whose rates just changed (every minute) or all pushable hotels (every few minutes). */
export async function googleTick({ all = false, fetchImpl } = {}) {
  if (!partnerKey()) { soon.clear(); return []; }
  const ids = all ? null : [...soon];
  soon.clear();
  if (ids && !ids.length) return [];
  const out = [];
  for (const h of await pushableHotels(ids)) {
    try {
      const g = await loadGoogle(h.id);
      if (!g.property_data_sent_at) await sendPropertyData(h, { fetchImpl });
      out.push({ hotel_id: h.id, ...(await syncHotel(h, { fetchImpl })) });
    } catch (e) {
      console.error(`google sync failed for hotel ${h.id}:`, e.message);
    }
  }
  return out;
}
