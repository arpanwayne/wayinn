// Google Hotels prices through SerpApi (https://serpapi.com/google-hotels-api).
// One call per stay date: the hotel's Google Hotels page lists every OTA's price for that night.
// Key: SERPAPI_KEY in the API's environment (Wayne E Solutions' account; data cost is ours, billed as the add-on).
import { RateDataError } from './errors.js';

const BASE = 'https://serpapi.com/search.json';
const paise = (v) => (v === undefined || v === null || Number.isNaN(Number(v)) ? null : Math.round(Number(v) * 100));

async function call(params, fetchImpl = fetch) {
  const key = process.env.SERPAPI_KEY;
  if (!key) throw new RateDataError('SERPAPI_KEY is not set on the server', false);
  const qs = new URLSearchParams({ engine: 'google_hotels', gl: 'in', hl: 'en', currency: 'INR', ...params, api_key: key });
  let res;
  try {
    res = await fetchImpl(`${BASE}?${qs}`, { headers: { accept: 'application/json' } });
  } catch (e) { throw new RateDataError(`SerpApi not reachable: ${e.message}`); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const msg = data.error || `HTTP ${res.status}`;
    // "hasn't returned any results" is a normal empty answer, not a failure.
    if (/hasn't returned any results|no results/i.test(msg)) return { empty: true };
    throw new RateDataError(`SerpApi: ${msg}`, res.status === 429 || res.status >= 500);
  }
  return data;
}

/** Turn one SerpApi price entry (property level or room level) into an Offer. */
export function toOffer(entry, room = null) {
  const per = (room || entry).rate_per_night || {};
  const shown = paise(per.extracted_lowest);
  if (!shown) return null;
  const before = paise(per.extracted_before_taxes_fees);
  const roomName = room?.name || null;
  const text = `${roomName || ''} ${entry.source || ''}`;
  return {
    ota_name: String(entry.source || 'Unknown').trim(),
    room_name: roomName,
    rate_paise: shown,
    pretax_paise: before && before <= shown ? before : null,
    includes_tax: true, // Google India shows prices with taxes; the before-tax price comes separately when Google has it
    breakfast: /breakfast/i.test(text) ? true : null,
    refundable: entry.free_cancellation === true || room?.free_cancellation === true ? true : null,
    official: entry.official === true,
    link: room?.link || entry.link || null,
  };
}

/** All offers in a property-details response: room-level prices where Google has them, plus each site's lowest. */
export function parseProperty(data) {
  const offers = [];
  for (const f of data.featured_prices || []) {
    if (Array.isArray(f.rooms) && f.rooms.length) for (const room of f.rooms) { const o = toOffer(f, room); if (o) offers.push(o); }
    const o = toOffer(f); if (o) offers.push(o);
  }
  for (const p of data.prices || []) { const o = toOffer(p); if (o) offers.push(o); }
  // Same site + room + price can appear in both lists.
  const seen = new Set();
  return offers.filter((o) => {
    const k = `${o.ota_name.toLowerCase()}|${(o.room_name || '').toLowerCase()}|${o.rate_paise}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export default {
  name: 'serpapi',
  label: 'Google Hotels (SerpApi)',
  note: 'Needs SERPAPI_KEY on the server. About one search per stay date per check.',
  ready: () => !!process.env.SERPAPI_KEY,

  async search(query, { checkIn, checkOut }, fetchImpl) {
    const data = await call({ q: query, check_in_date: checkIn, check_out_date: checkOut, adults: '2' }, fetchImpl);
    if (data.empty) return [];
    // An exact match opens the property itself instead of a list.
    if (data.property_token && data.name) {
      return [{ token: data.property_token, name: data.name, address: data.address || null, rating: data.overall_rating ?? null, link: data.link || null }];
    }
    return (data.properties || []).filter((p) => p.property_token).slice(0, 10).map((p) => ({
      token: p.property_token, name: p.name, address: p.description || null, rating: p.overall_rating ?? null, link: p.link || null,
    }));
  },

  async fetchOffers({ token, name, checkIn, checkOut, adults = 2 }, fetchImpl) {
    if (!token) throw new RateDataError('The hotel is not linked to Google Hotels yet', false);
    const data = await call({ q: name || 'hotel', property_token: token, check_in_date: checkIn, check_out_date: checkOut, adults: String(adults) }, fetchImpl);
    if (data.empty) return { offers: [] };
    return { offers: parseProperty(data) };
  },
};
