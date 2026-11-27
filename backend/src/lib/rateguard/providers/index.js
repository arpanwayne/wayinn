// Where OTA prices come from. Every provider has the same shape, so changing the data company (or adding our
// own scraper later) is one new file here plus one line in PROVIDERS.
//
// provider = {
//   name, label,
//   ready()                                   → true when keys are configured
//   search(query, { checkIn, checkOut })      → [{ token, name, address, rating, link }]   (find the hotel on Google Hotels)
//   fetchOffers({ token, name, checkIn, checkOut, adults, ctx }) → { offers: [Offer] }   (one stay date)
// }
// Offer = { ota_name, room_name, rate_paise, pretax_paise|null, includes_tax, breakfast|null, refundable|null, official, link }
// rate_paise is per night as shown; pretax_paise is the same price before taxes when the source says so.
import serpapi from './serpapi.js';
import mock from './mock.js';
import manual from './manual.js';
import { RateDataError } from './errors.js';

export { RateDataError };
export const PROVIDERS = { serpapi, mock, manual };

export function getProvider(name) {
  const p = PROVIDERS[name];
  if (!p) throw new RateDataError(`Unknown rate data provider "${name}"`, false);
  return p;
}

/** For the setup screen: which providers exist and whether their keys are set. */
export const providerList = () => Object.values(PROVIDERS)
  .filter((p) => p.name !== 'mock' || process.env.NODE_ENV !== 'production' || process.env.RATE_GUARD_ALLOW_MOCK === 'true')
  .map((p) => ({ name: p.name, label: p.label, ready: p.ready(), note: p.note || null }));
