// Rate calendar: what each room type costs on each date, and whether it can be sold that day.
//
// A date without a rate_calendar row uses the room type's base rate, has no minimum stay and is open.
// Every change goes through setCalendar(), which also writes rate_changes (history + undo) and tells the
// Google sync that something changed.
import { addDays, stayNights, nightsBetween } from './dates.js';
import { bus } from './events.js';

export const DEFAULT_DAY = { rate_paise: null, min_stay: null, stop_sell: false };

/** Calendar rows for [from, to) keyed "roomTypeId|date". */
export async function calendarRows(db, hotelId, from, to) {
  const rows = await db.many(
    `SELECT room_type_id, date::text AS date, rate_paise, min_stay, stop_sell, source, updated_at
       FROM rate_calendar WHERE hotel_id = $1 AND date >= $2 AND date < $3`, [hotelId, from, to]);
  return new Map(rows.map((r) => [`${r.room_type_id}|${r.date}`, r]));
}

/** One night of one room type, from the room type and its calendar row (if any). */
export function dayOf(rt, row) {
  return {
    rate_paise: row?.rate_paise ?? Number(rt.base_rate_paise),
    base_rate_paise: Number(rt.base_rate_paise),
    overridden: row?.rate_paise !== null && row?.rate_paise !== undefined,
    min_stay: row?.min_stay ?? null,
    stop_sell: !!row?.stop_sell,
    source: row?.source || null,
  };
}

/**
 * Night-by-night rates for room types over [from, to).
 * `types` = rows with id and base_rate_paise; when omitted all active room types of the hotel are used.
 * Returns Map(roomTypeId → [{ date, rate_paise, base_rate_paise, overridden, min_stay, stop_sell, source }]).
 */
export async function nightlyRates(db, hotelId, from, to, types = null) {
  const list = types || await db.many('SELECT id, base_rate_paise FROM room_types WHERE hotel_id = $1 AND active', [hotelId]);
  const rows = await calendarRows(db, hotelId, from, to);
  const out = new Map();
  for (const rt of list) out.set(Number(rt.id), stayNights(from, to).map((date) => ({ date, ...dayOf(rt, rows.get(`${rt.id}|${date}`)) })));
  return out;
}

const fmt = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'UTC' });

/**
 * Price of a stay from its nights: { nightly_rates: {date: paise}, total_paise, avg_paise, closed_reason }.
 * closed_reason says why the stay cannot be sold online (stop-sell on a night, or minimum stay on arrival).
 */
export function quoteNights(nights) {
  const nightly = Object.fromEntries(nights.map((n) => [n.date, n.rate_paise]));
  const total = nights.reduce((a, n) => a + n.rate_paise, 0);
  let closed = null;
  const stopped = nights.find((n) => n.stop_sell);
  if (stopped) closed = `Not available on ${fmt(stopped.date)}`;
  else if (nights[0]?.min_stay && nights.length < nights[0].min_stay) closed = `Minimum stay is ${nights[0].min_stay} nights from ${fmt(nights[0].date)}`;
  return { nightly_rates: nightly, total_paise: total, avg_paise: nights.length ? Math.round(total / nights.length) : 0, closed_reason: closed };
}

/** Quote one room type for [from, to). `rt` needs id and base_rate_paise. */
export async function quoteStay(db, hotelId, rt, from, to) {
  const nights = (await nightlyRates(db, hotelId, from, to, [rt])).get(Number(rt.id));
  return { ...quoteNights(nights), nights };
}

/** Pre-tax room rate of one night of a stay. */
export const stayNightRate = (stay, night) => {
  const r = stay?.nightly_rates?.[night];
  return r === undefined || r === null ? Number(stay.nightly_rate_paise) : Number(r);
};

/** True if every night has the same rate (then nightly_rates can be dropped). */
export const flatRates = (nightly) => new Set(Object.values(nightly || {})).size <= 1;

// ---------------------------------------------------------------
// Changes
// ---------------------------------------------------------------
const same = (a, b) => (a ?? null) === (b ?? null);

/**
 * Change one or more dates of one room type. `patch` may hold rate_paise (null = back to base rate),
 * min_stay (null = none) and stop_sell. Fields not in `patch` keep their value.
 * Writes one rate_changes row per date that really changed. Returns the rate_changes rows.
 */
export async function setCalendar(db, { hotelId, roomTypeId, dates, patch, source = 'manual', userId = null, via = 'dashboard', phone = null, suggestionId = null }) {
  const rt = await db.one('SELECT id, base_rate_paise FROM room_types WHERE id = $1 AND hotel_id = $2', [roomTypeId, hotelId]);
  if (!rt) throw new Error('Unknown room type');
  const changes = [];
  for (const date of [...new Set(dates)].sort()) {
    const cur = await db.one(
      `SELECT rate_paise, min_stay, stop_sell, source FROM rate_calendar WHERE room_type_id = $1 AND date = $2 FOR UPDATE`, [roomTypeId, date]);
    const before = cur ? { rate_paise: cur.rate_paise, min_stay: cur.min_stay, stop_sell: cur.stop_sell } : DEFAULT_DAY;
    const next = {
      rate_paise: 'rate_paise' in patch ? patch.rate_paise : before.rate_paise,
      min_stay: 'min_stay' in patch ? (patch.min_stay && patch.min_stay > 1 ? patch.min_stay : null) : before.min_stay,
      stop_sell: 'stop_sell' in patch ? !!patch.stop_sell : before.stop_sell,
    };
    // A rate equal to the base rate is stored as "base", so a later base-rate change still applies to that day.
    if (next.rate_paise !== null && Number(next.rate_paise) === Number(rt.base_rate_paise)) next.rate_paise = null;
    if (same(before.rate_paise, next.rate_paise) && same(before.min_stay, next.min_stay) && before.stop_sell === next.stop_sell) continue;
    if (next.rate_paise === null && next.min_stay === null && !next.stop_sell) {
      await db.query('DELETE FROM rate_calendar WHERE room_type_id = $1 AND date = $2', [roomTypeId, date]);
    } else {
      await db.query(
        `INSERT INTO rate_calendar (hotel_id, room_type_id, date, rate_paise, min_stay, stop_sell, source, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
         ON CONFLICT (room_type_id, date) DO UPDATE SET rate_paise = $4, min_stay = $5, stop_sell = $6, source = $7, updated_by = $8, updated_at = now()`,
        [hotelId, roomTypeId, date, next.rate_paise, next.min_stay, next.stop_sell, source, userId]);
    }
    changes.push(await db.one(
      `INSERT INTO rate_changes (hotel_id, room_type_id, date, old_rate_paise, new_rate_paise, old_min_stay, new_min_stay, old_stop_sell, new_stop_sell,
                                 old_row, source, suggestion_id, user_id, via, actor_phone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [hotelId, roomTypeId, date, before.rate_paise ?? rt.base_rate_paise, next.rate_paise ?? rt.base_rate_paise, before.min_stay, next.min_stay,
        before.stop_sell, next.stop_sell, cur ? JSON.stringify({ ...before, source: cur.source }) : null, source, suggestionId, userId, via, phone]));
  }
  if (changes.length) bus.emit('rates.changed', { hotelId, roomTypeId, dates: changes.map((c) => c.date) });
  return changes;
}

/** Dates in [from, to] (inclusive) on the given weekdays (0 = Sunday … 6 = Saturday; empty = every day). */
export function datesInRange(from, to, weekdays = []) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (!weekdays.length || weekdays.includes(new Date(`${d}T00:00:00Z`).getUTCDay())) out.push(d);
  }
  return out;
}

/**
 * Put a date back the way it was before change `id`. Only the latest change of that day can be undone,
 * so a newer change is never silently thrown away.
 */
export async function undoChange(db, hotelId, id, userId) {
  const c = await db.one('SELECT * FROM rate_changes WHERE id = $1 AND hotel_id = $2 FOR UPDATE', [id, hotelId]);
  if (!c) return { error: 'not_found' };
  if (c.undone_at) return { error: 'already_undone' };
  const latest = await db.one(
    `SELECT id FROM rate_changes WHERE room_type_id = $1 AND date = $2 AND undone_at IS NULL ORDER BY id DESC LIMIT 1`, [c.room_type_id, c.date]);
  if (latest.id !== c.id) return { error: 'newer_change' };
  const old = c.old_row || DEFAULT_DAY;
  const out = await setCalendar(db, {
    hotelId, roomTypeId: c.room_type_id, dates: [c.date], patch: { rate_paise: old.rate_paise ?? null, min_stay: old.min_stay ?? null, stop_sell: !!old.stop_sell },
    source: 'undo', userId, via: 'dashboard',
  });
  await db.query('UPDATE rate_changes SET undone_at = now(), undone_by = $2 WHERE id = $1', [c.id, userId]);
  // The undo itself is history, but undoing it again would just redo the change: mark it as already undone-able only via a new edit.
  for (const u of out) await db.query('UPDATE rate_changes SET undone_at = now(), undone_by = $2 WHERE id = $1', [u.id, userId]);
  return { ok: true, restored: old, changes: out.length };
}

/** Effective rate of each room type for one date (used by Rate Guard). Map(roomTypeId → day). */
export async function ratesOn(db, hotelId, date) {
  const m = await nightlyRates(db, hotelId, date, addDays(date, 1));
  return new Map([...m].map(([k, v]) => [k, v[0]]));
}

export { nightsBetween };
