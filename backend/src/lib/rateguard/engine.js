// Rate Guard engine.
//
//  1. Price check: ask the data provider what every OTA charges for the hotel for one night (stay date).
//     The scheduler checks the next `near_days` dates every `near_every_hours` hours and the rest of the
//     `horizon_days` once every `far_every_hours` hours.
//  2. Evaluate: per room type, compare the cheapest matching OTA price with our rate for that date and make a
//     suggestion (rules.js). One open suggestion per room type and date; a newer one replaces it.
//  3. Approve mode: the owner gets a WhatsApp alert and replies YES <code> / NO <code> (or uses the dashboard).
//     Auto mode: a suggestion within ±auto_max_change_pct of the day's starting rate is applied straight away;
//     bigger moves still wait for approval.
//  4. An approved rate goes into the rate calendar (setCalendar), so the booking page, front desk, channel
//     manager API and Google all use it.
import { one, many, tx } from '../../db.js';
import { hotelToday, addDays } from '../dates.js';
import { getProvider, RateDataError } from './providers/index.js';
import { otaKey, offerPretax, matchOffers, suggestRate, withinAutoLimit, newCode } from './rules.js';
import { ratesOn, setCalendar } from '../rates.js';
import { queueToPhones } from '../notify.js';
import { normalizePhone } from '../messages.js';

/** The add-on is switched on per hotel by Wayne E Solutions (super admin), because price data costs money. */
export const rateGuardAddon = (hotel) => hotel?.settings?.addons?.rate_guard === true;

export const DEFAULT_CONFIG = {
  enabled: false, provider: 'serpapi', property_token: null, property_name: null, property_address: null, undercut_pct: 5, rounding: '49_99',
  min_change_paise: 5000, mode: 'approve', auto_max_change_pct: 15, alert_phones: [], alert_on_increase: true, max_alerts_per_run: 3,
  horizon_days: 30, near_days: 7, near_every_hours: 3, far_every_hours: 24, adults: 2,
};

export async function loadConfig(hotelId, db = { one }) {
  const row = await db.one('SELECT * FROM rate_guard_config WHERE hotel_id = $1', [hotelId]);
  return { ...DEFAULT_CONFIG, hotel_id: hotelId, ...(row || {}), undercut_pct: Number(row?.undercut_pct ?? 5), auto_max_change_pct: Number(row?.auto_max_change_pct ?? 15) };
}

/** Active room types with their Rate Guard mapping (null when not set up). */
export async function loadRooms(hotelId, db = { many }) {
  const rows = await db.many(
    `SELECT rt.id, rt.name, rt.base_rate_paise, rt.base_occupancy,
            m.enabled, m.floor_paise, m.ceiling_paise, m.match_keywords, m.meal_plan, m.refundable
       FROM room_types rt LEFT JOIN rate_guard_rooms m ON m.room_type_id = rt.id
      WHERE rt.hotel_id = $1 AND rt.active ORDER BY rt.base_rate_paise`, [hotelId]);
  return rows.map((r) => ({
    id: r.id, name: r.name, base_rate_paise: r.base_rate_paise, base_occupancy: r.base_occupancy,
    mapping: r.floor_paise === null ? null : {
      enabled: r.enabled, floor_paise: r.floor_paise, ceiling_paise: r.ceiling_paise, match_keywords: r.match_keywords, meal_plan: r.meal_plan, refundable: r.refundable,
    },
  }));
}

// ---------------------------------------------------------------
// Price checks
// ---------------------------------------------------------------
async function saveOffers(hotel, runId, stayDate, provider, offers) {
  for (const o of offers) {
    await one(
      `INSERT INTO rate_observations (hotel_id, run_id, stay_date, ota, ota_name, room_name, rate_paise, pretax_paise, breakfast, refundable, official, link, provider)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [hotel.id, runId, stayDate, otaKey(o.ota_name, o.official), String(o.ota_name).slice(0, 80), o.room_name ? String(o.room_name).slice(0, 200) : null,
        o.rate_paise, offerPretax(hotel, o), o.breakfast ?? null, o.refundable ?? null, !!o.official, o.link ? String(o.link).slice(0, 1000) : null, provider]);
  }
}

/**
 * Check OTA prices for one stay date, save them and evaluate suggestions.
 * Returns { run_id, offers, suggestions, error }.
 */
export async function runCheck(hotel, cfg, stayDate, { trigger = 'schedule', fetchImpl } = {}) {
  const provider = getProvider(cfg.provider);
  if (provider.manual) return { run_id: null, offers: 0, suggestions: await evaluateDate(hotel, cfg, stayDate) };
  const run = await one(`INSERT INTO rate_fetch_runs (hotel_id, stay_date, provider, trigger) VALUES ($1,$2,$3,$4) RETURNING id`,
    [hotel.id, stayDate, provider.name, trigger]);
  let offers;
  try {
    const roomTypes = await many('SELECT id, name, base_rate_paise FROM room_types WHERE hotel_id = $1 AND active', [hotel.id]);
    ({ offers } = await provider.fetchOffers({
      token: cfg.property_token, name: cfg.property_name, checkIn: stayDate, checkOut: addDays(stayDate, 1), adults: cfg.adults, ctx: { roomTypes },
    }, fetchImpl));
    await saveOffers(hotel, run.id, stayDate, provider.name, offers);
    await one(`UPDATE rate_fetch_runs SET status = 'ok', offers = $2, finished_at = now() WHERE id = $1 RETURNING id`, [run.id, offers.length]);
  } catch (e) {
    await one(`UPDATE rate_fetch_runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1 RETURNING id`, [run.id, String(e.message).slice(0, 500)]);
    return { run_id: run.id, offers: 0, suggestions: [], error: e.message, retry: !(e instanceof RateDataError) || e.retry };
  }
  return { run_id: run.id, offers: offers.length, suggestions: await evaluateDate(hotel, cfg, stayDate) };
}

/** An OTA price typed in by the owner / front desk (manual provider, or to correct the data). */
export async function addManualOffer(hotel, cfg, o) {
  await saveOffers(hotel, null, o.stay_date, 'manual', [{ ...o, official: false }]);
  return evaluateDate(hotel, cfg, o.stay_date);
}

/** Latest price per site and room for a date, seen within `hours`. */
export async function latestOffers(hotelId, from, to, hours = 26) {
  return many(
    `SELECT DISTINCT ON (stay_date, ota, COALESCE(room_name, ''), official) id, stay_date::text AS stay_date, ota, ota_name, room_name, rate_paise, pretax_paise,
            breakfast, refundable, official, link, provider, observed_at
       FROM rate_observations
      WHERE hotel_id = $1 AND stay_date >= $2 AND stay_date < $3 AND observed_at > now() - ($4 || ' hours')::interval
      ORDER BY stay_date, ota, COALESCE(room_name, ''), official, observed_at DESC`, [hotelId, from, to, String(hours)]);
}

// ---------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------
async function freeCode(db, hotelId) {
  for (let i = 0; i < 20; i++) {
    const code = newCode();
    if (!(await db.one(`SELECT 1 AS x FROM rate_suggestions WHERE hotel_id = $1 AND code = $2 AND status = 'pending'`, [hotelId, code]))) return code;
  }
  throw new Error('Could not find a free suggestion code');
}

/** Rate of the day before any auto-pilot change made today (so auto mode moves at most ±pct per day). */
async function dayAnchor(db, hotel, roomTypeId, date, current) {
  const first = await db.one(
    `SELECT old_rate_paise FROM rate_changes WHERE room_type_id = $1 AND date = $2 AND source = 'auto_pilot' AND undone_at IS NULL
        AND (created_at AT TIME ZONE $3)::date = $4::date ORDER BY id LIMIT 1`, [roomTypeId, date, hotel.timezone, hotelToday(hotel.timezone)]);
  return first ? Number(first.old_rate_paise) : Number(current);
}

/**
 * Make (or clear) suggestions for every mapped room type on one date. Returns the suggestions created
 * (pending or auto_applied).
 */
export async function evaluateDate(hotel, cfg, date) {
  if (date < hotelToday(hotel.timezone)) return [];
  const rooms = (await loadRooms(hotel.id)).filter((r) => r.mapping?.enabled);
  if (!rooms.length) return [];
  const offers = (await latestOffers(hotel.id, date, addDays(date, 1))).map((o) => ({ ...o, pretax: Number(o.pretax_paise) }));
  const days = await ratesOn({ many }, hotel.id, date);
  const created = [];
  for (const rm of rooms) {
    const day = days.get(Number(rm.id));
    const others = rooms.filter((x) => x.id !== rm.id).map((x) => x.mapping.match_keywords);
    const s = day && !day.stop_sell ? suggestRate({ currentPaise: day.rate_paise, offers: matchOffers(offers, rm.mapping, others), cfg, room: rm.mapping }) : null;
    const row = await tx(async (db) => {
      const pending = await db.one(`SELECT * FROM rate_suggestions WHERE room_type_id = $1 AND stay_date = $2 AND status = 'pending' FOR UPDATE`, [rm.id, date]);
      if (pending && s && Number(pending.suggested_rate_paise) === s.suggested_paise && Number(pending.current_rate_paise) === day.rate_paise) return null; // already asked
      if (pending) await db.query(`UPDATE rate_suggestions SET status = 'superseded', decided_at = now() WHERE id = $1`, [pending.id]);
      if (!s) return null;
      let status = 'pending';
      if (cfg.mode === 'auto' && withinAutoLimit(await dayAnchor(db, hotel, rm.id, date, day.rate_paise), s.suggested_paise, cfg.auto_max_change_pct)) status = 'auto_applied';
      const sug = await db.one(
        `INSERT INTO rate_suggestions (hotel_id, room_type_id, stay_date, code, current_rate_paise, suggested_rate_paise, ota, ota_name, ota_rate_paise, ota_pretax_paise,
                                       reason, status, decided_at, decided_via)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [hotel.id, rm.id, date, await freeCode(db, hotel.id), day.rate_paise, s.suggested_paise, s.ota, s.ota_name, s.ota_rate_paise, s.ota_pretax_paise,
          s.reason, status, status === 'auto_applied' ? new Date() : null, status === 'auto_applied' ? 'auto' : null]);
      if (status === 'auto_applied') {
        await setCalendar(db, { hotelId: hotel.id, roomTypeId: rm.id, dates: [date], patch: { rate_paise: s.suggested_paise }, source: 'auto_pilot', via: 'auto', suggestionId: sug.id });
        await db.query(`INSERT INTO audit_logs (hotel_id, actor_type, action, entity_type, entity_id, data) VALUES ($1,'system','rate_guard.auto_applied','rate_suggestion',$2,$3)`,
          [hotel.id, sug.id, JSON.stringify({ room_type_id: rm.id, date, from: day.rate_paise, to: s.suggested_paise, reason: s.reason })]);
      }
      return { ...sug, room_type: rm.name };
    });
    if (row) created.push(row);
  }
  return created;
}

const inr = (p) => `Rs. ${Math.round(Number(p) / 100).toLocaleString('en-IN')}`;

/** WhatsApp the owner about new pending suggestions: one message each, or one summary when there are many. */
export async function sendAlerts(hotel, cfg, suggestions) {
  const list = suggestions.filter((s) => s.status === 'pending' && (cfg.alert_on_increase || Number(s.suggested_rate_paise) < Number(s.current_rate_paise)));
  if (!list.length || !cfg.alert_phones?.length || !cfg.max_alerts_per_run) return 0;
  let queued = 0;
  if (list.length <= cfg.max_alerts_per_run) {
    for (const s of list) {
      queued += await queueToPhones(hotel.id, cfg.alert_phones, 'rate_alert', {
        hotel: hotel.name, ota: s.ota_name || 'An OTA', ota_rate: inr(s.ota_rate_paise), room_type: s.room_type, date: s.stay_date,
        suggested: inr(s.suggested_rate_paise), code: s.code,
      });
    }
  } else {
    const dates = list.map((s) => s.stay_date).sort();
    queued += await queueToPhones(hotel.id, cfg.alert_phones, 'rate_alert_summary', { hotel: hotel.name, count: list.length, from: dates[0], to: dates[dates.length - 1] });
  }
  await many(`UPDATE rate_suggestions SET alerted_at = now() WHERE id = ANY($1::bigint[]) RETURNING id`, [list.map((s) => s.id)]);
  return queued;
}

/**
 * Approve or reject one pending suggestion (by id or WhatsApp code). actor = { userId, via, phone }.
 * Returns { ok, suggestion } or { error: 'not_found' | 'expired' }.
 */
export async function decide(hotel, { id, code }, approve, actor) {
  return tx(async (db) => {
    const s = await db.one(
      `SELECT s.*, rt.name AS room_type FROM rate_suggestions s JOIN room_types rt ON rt.id = s.room_type_id
        WHERE s.hotel_id = $1 AND s.status = 'pending' AND ${id ? 's.id = $2' : 's.code = $2'} FOR UPDATE OF s`, [hotel.id, id || String(code).toUpperCase()]);
    if (!s) return { error: 'not_found' };
    if (s.stay_date < hotelToday(hotel.timezone)) {
      await db.query(`UPDATE rate_suggestions SET status = 'expired', decided_at = now() WHERE id = $1`, [s.id]);
      return { error: 'expired', suggestion: s };
    }
    if (approve) {
      await setCalendar(db, {
        hotelId: hotel.id, roomTypeId: s.room_type_id, dates: [s.stay_date], patch: { rate_paise: Number(s.suggested_rate_paise) },
        source: 'rate_guard', userId: actor.userId || null, via: actor.via, phone: actor.phone || null, suggestionId: s.id,
      });
    }
    const status = approve ? 'approved' : 'rejected';
    await db.query(`UPDATE rate_suggestions SET status = $2, decided_at = now(), decided_by = $3, decided_via = $4, decided_phone = $5 WHERE id = $1`,
      [s.id, status, actor.userId || null, actor.via, actor.phone || null]);
    await db.query(
      `INSERT INTO audit_logs (hotel_id, actor_type, actor_id, action, entity_type, entity_id, data) VALUES ($1,$2,$3,$4,'rate_suggestion',$5,$6)`,
      [hotel.id, actor.userId ? 'staff' : 'system', actor.userId || null, `rate_guard.${status}`, s.id,
        JSON.stringify({ room_type_id: s.room_type_id, date: s.stay_date, from: s.current_rate_paise, to: s.suggested_rate_paise, via: actor.via, phone: actor.phone || null })]);
    return { ok: true, suggestion: { ...s, status } };
  });
}

/** Approve / reject every pending suggestion of the hotel (WhatsApp "YES ALL", dashboard "Approve all"). */
export async function decideAll(hotel, approve, actor) {
  const ids = await many(`SELECT id FROM rate_suggestions WHERE hotel_id = $1 AND status = 'pending' ORDER BY stay_date, id`, [hotel.id]);
  let done = 0;
  for (const { id } of ids) if ((await decide(hotel, { id }, approve, actor)).ok) done++;
  return done;
}

/** Is this phone allowed to approve Rate Guard suggestions by WhatsApp? */
export function isApprover(cfg, phone) {
  const d = String(normalizePhone(phone) || phone || '').replace(/\D/g, '').slice(-10);
  return d.length === 10 && (cfg.alert_phones || []).some((p) => String(normalizePhone(p) || '').slice(-10) === d);
}

// ---------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------
/** Stay dates whose price check is due, nearest first. */
export async function dueDates(hotel, cfg, now = new Date()) {
  const today = hotelToday(hotel.timezone, now);
  const last = await many(
    `SELECT DISTINCT ON (stay_date) stay_date::text AS stay_date, status, started_at FROM rate_fetch_runs
      WHERE hotel_id = $1 AND stay_date >= $2 ORDER BY stay_date, started_at DESC`, [hotel.id, today]);
  const byDate = Object.fromEntries(last.map((r) => [r.stay_date, r]));
  const due = [];
  for (let i = 0; i < cfg.horizon_days; i++) {
    const d = addDays(today, i);
    const r = byDate[d];
    const every = (i < cfg.near_days ? cfg.near_every_hours : cfg.far_every_hours) * 3600_000;
    const age = r ? now - new Date(r.started_at) : Infinity;
    if (r?.status === 'running' && age < 10 * 60_000) continue;
    if (r?.status === 'failed' ? age >= Math.min(every, 30 * 60_000) : age >= every - 5 * 60_000) due.push(d);
  }
  return due;
}

/** One pass for every hotel with Rate Guard on. Run by jobs.js every few minutes. */
export async function schedulerTick({ fetchImpl, now = new Date(), maxPerHotel = 8 } = {}) {
  await many(
    `UPDATE rate_suggestions s SET status = 'expired', decided_at = now() FROM hotels h
      WHERE h.id = s.hotel_id AND s.status = 'pending' AND s.stay_date < (now() AT TIME ZONE h.timezone)::date RETURNING s.id`);
  const hotels = await many(
    `SELECT h.* FROM hotels h JOIN rate_guard_config c ON c.hotel_id = h.id
      WHERE c.enabled AND h.subscription_status IN ('trial','active','past_due')`);
  const summary = [];
  for (const hotel of hotels) {
    if (!rateGuardAddon(hotel)) continue;
    const cfg = await loadConfig(hotel.id);
    let provider;
    try { provider = getProvider(cfg.provider); } catch { continue; }
    if (provider.manual || !provider.ready() || !cfg.property_token) continue;
    const created = [];
    let checks = 0;
    for (const d of (await dueDates(hotel, cfg, now)).slice(0, maxPerHotel)) {
      const r = await runCheck(hotel, cfg, d, { fetchImpl });
      checks++;
      created.push(...r.suggestions);
      if (r.error && r.retry === false) break; // bad key / not linked: no point trying the other dates now
    }
    const alerts = await sendAlerts(hotel, cfg, created);
    summary.push({ hotel_id: hotel.id, checks, suggestions: created.length, alerts });
  }
  return summary;
}
