// Made-up but steady OTA prices, for demos and tests. Never used for a real hotel in production
// (hidden there unless RATE_GUARD_ALLOW_MOCK=true).
import crypto from 'node:crypto';

const OTAS = ['MakeMyTrip', 'Goibibo', 'Booking.com', 'Agoda'];

/** Same hotel + date + OTA → same number, between -12% and +8% of the room's base rate. */
const wobble = (seed) => (crypto.createHash('sha256').update(seed).digest().readUInt16BE(0) / 65535) * 0.2 - 0.12;
const r99 = (paise) => Math.max(9900, Math.round(paise / 10000) * 10000 - 100);

export default {
  name: 'mock',
  label: 'Demo prices (not real)',
  note: 'For demos and testing only.',
  ready: () => true,
  async search(query) {
    return [{ token: `mock-${String(query).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`, name: query, address: 'Demo listing', rating: 4.2, link: null }];
  },
  async fetchOffers({ token, checkIn, ctx }) {
    const offers = [];
    for (const rt of ctx?.roomTypes || []) {
      for (const ota of OTAS) {
        const base = Number(rt.base_rate_paise);
        const pre = r99(base * (1 + wobble(`${token}|${checkIn}|${ota}|${rt.id}`)));
        const shown = Math.round(pre * 1.05); // GST shown on the OTA
        offers.push({ ota_name: ota, room_name: rt.name, rate_paise: shown, pretax_paise: pre, includes_tax: true, breakfast: null, refundable: null, official: false, link: null });
        offers.push({ ota_name: ota, room_name: `${rt.name} with Breakfast`, rate_paise: Math.round((pre + 40000) * 1.05), pretax_paise: pre + 40000,
          includes_tax: true, breakfast: true, refundable: true, official: false, link: null });
      }
    }
    return { offers };
  },
};
