// Rate Guard pricing rules. Pure functions: no database, no network.
//
//   suggested direct rate = cheapest matching OTA price (before GST) × (1 − undercut %)
//                           → rounded to a ₹…49 / ₹…99 price → kept between the room's floor and ceiling
//
// Wayinn rates are before GST (GST is added on the bill), so OTA prices are compared before GST too.
import { taxSettings } from '../money.js';

const OTA_KEYS = [
  [/make\s*my\s*trip|^mmt$/i, 'makemytrip'], [/goibibo/i, 'goibibo'], [/booking\.com/i, 'booking_com'], [/agoda/i, 'agoda'],
  [/expedia/i, 'expedia'], [/hotels\.com/i, 'hotels_com'], [/trip\.com/i, 'trip_com'], [/yatra/i, 'yatra'], [/cleartrip/i, 'cleartrip'],
  [/ease\s*my\s*trip/i, 'easemytrip'], [/\boyo\b/i, 'oyo'], [/airbnb/i, 'airbnb'], [/priceline/i, 'priceline'], [/trivago/i, 'trivago'],
];

/** A stable key for an OTA name as Google shows it ("Booking.com" → booking_com). */
export function otaKey(name, official = false) {
  if (official) return 'official';
  const hit = OTA_KEYS.find(([re]) => re.test(String(name || '')));
  return hit ? hit[1] : String(name || 'other').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'other';
}

/**
 * Price before GST from a price that includes it, using the hotel's room GST slabs
 * (≤ ₹7,500 → 5%, above → 18% by default). The slab is chosen by the pre-tax amount, as on a real bill.
 */
export function preTaxFromInclusive(hotel, paise) {
  const slabs = taxSettings(hotel).room_slabs;
  for (const s of slabs) {
    const pre = Math.round(Number(paise) / (1 + Number(s.rate) / 100));
    if (s.upto_paise === null || s.upto_paise === undefined || pre <= s.upto_paise) return pre;
  }
  return Number(paise);
}

/** Comparable (before GST) price of an offer. */
export function offerPretax(hotel, o) {
  if (o.pretax_paise) return Number(o.pretax_paise);
  return o.includes_tax === false ? Number(o.rate_paise) : preTaxFromInclusive(hotel, o.rate_paise);
}

const wordsOf = (s) => String(s || '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);

/**
 * Offers that compare with one room type, by its mapping (keywords, breakfast, refundable). Never the hotel's own site.
 * A room type without keywords takes the cheapest room on each OTA, except rooms that clearly belong to another
 * room type (`otherKeywords` = the keywords of the hotel's other room types).
 */
export function matchOffers(offers, room, otherKeywords = []) {
  const words = wordsOf(room?.match_keywords);
  const others = otherKeywords.flatMap(wordsOf).filter((w) => !words.includes(w));
  return offers.filter((o) => {
    if (o.official) return false;
    const name = (o.room_name || '').toLowerCase();
    if (words.length && !(name && words.some((w) => name.includes(w)))) return false;
    if (!words.length && name && others.some((w) => name.includes(w))) return false;
    if (room?.meal_plan === 'breakfast' && o.breakfast !== true) return false;
    if (room?.meal_plan === 'room_only' && o.breakfast === true) return false;
    if (room?.refundable === 'refundable' && o.refundable !== true) return false;
    if (room?.refundable === 'non_refundable' && o.refundable === true) return false;
    return true;
  });
}

/** Nearest "nice" price. 49_99: ₹2,945 → ₹2,949; 99: ₹2,945 → ₹2,899 / ₹2,999; none: whole rupees. */
export function roundRate(paise, mode = '49_99') {
  const rupees = Number(paise) / 100;
  if (mode === 'none') return Math.round(rupees) * 100;
  const h = Math.floor(rupees / 100);
  const ends = mode === '99' ? [99] : [49, 99];
  const candidates = [];
  for (const base of [h - 1, h, h + 1]) for (const e of ends) if (base * 100 + e > 0) candidates.push(base * 100 + e);
  candidates.sort((a, b) => Math.abs(a - rupees) - Math.abs(b - rupees) || a - b);
  return candidates[0] * 100;
}

/** The next nice price below `paise` (to stay under the OTA after rounding up). */
export function stepDown(paise, mode = '49_99') {
  if (mode === 'none') return Number(paise) - 100;
  return Number(paise) - (mode === '99' ? 10000 : 5000);
}

const inr = (p) => `₹${Math.round(Number(p) / 100).toLocaleString('en-IN')}`;

/**
 * The suggestion for one room type on one date, or null when no change is worth making.
 * cfg: { undercut_pct, rounding, min_change_paise }; room: { floor_paise, ceiling_paise }.
 * offers must already be matched to the room (matchOffers) and carry pretax (offerPretax).
 */
export function suggestRate({ currentPaise, offers, cfg, room }) {
  const priced = offers.filter((o) => Number(o.pretax) > 0);
  if (!priced.length) return null;
  const cheapest = priced.reduce((a, b) => (b.pretax < a.pretax ? b : a));
  const target = cheapest.pretax * (1 - Number(cfg.undercut_pct) / 100);
  let s = roundRate(target, cfg.rounding);
  // Rounding must never take us to or above the OTA's own price.
  while (s >= cheapest.pretax && s > 0) s = stepDown(s, cfg.rounding);
  let limit = null;
  if (s < Number(room.floor_paise)) { s = Number(room.floor_paise); limit = 'floor'; }
  if (s > Number(room.ceiling_paise)) { s = Number(room.ceiling_paise); limit = 'ceiling'; }
  if (Math.abs(s - Number(currentPaise)) < Number(cfg.min_change_paise || 0) || s === Number(currentPaise)) return null;
  const pct = Number(cfg.undercut_pct);
  const reason = `${cheapest.ota_name} ${inr(cheapest.rate_paise)}${cheapest.pretax !== cheapest.rate_paise ? ` (${inr(cheapest.pretax)} before GST)` : ''}`
    + ` → ${pct}% below = ${inr(s)}`
    + (limit === 'floor' ? ' (held at your floor price)' : limit === 'ceiling' ? ' (held at your ceiling price)' : '');
  return {
    suggested_paise: s, direction: s < currentPaise ? 'down' : 'up', limit,
    ota: cheapest.ota, ota_name: cheapest.ota_name, ota_rate_paise: cheapest.rate_paise, ota_pretax_paise: cheapest.pretax, reason,
  };
}

/** Change a suggestion is allowed to make on its own in auto mode: within ±pct of the day's starting rate. */
export function withinAutoLimit(anchorPaise, suggestedPaise, pct) {
  const a = Number(anchorPaise);
  if (!a) return false;
  return Math.abs(Number(suggestedPaise) - a) <= (a * Number(pct)) / 100 + 0.5;
}

/** Short codes for WhatsApp replies: no 0/O, 1/I/L. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newCode(rand = Math.random) {
  let s = '';
  for (let i = 0; i < 4; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return s;
}

/** "YES K7P2", "haan all", "no k7p2" → { approve, target } or null. */
export function parseReply(text) {
  const m = /^\s*(yes|y|approve|approved|ok|haan|ha|han|no|n|skip|reject|nahi|nahin|na)\s+(all|[a-z0-9]{4})\s*[.!]?\s*$/i.exec(String(text || ''));
  if (!m) return null;
  return { approve: /^(yes|y|approve|approved|ok|haan|ha|han)$/i.test(m[1]), target: m[2].toUpperCase() };
}
