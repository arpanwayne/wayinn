// All money is integer paise.
export const toPaise = (rupees) => Math.round(Number(rupees) * 100);
export const fromPaise = (p) => Number(p) / 100;

/** Tax on an amount, rounded half-up to the paisa. */
export const taxOn = (amountPaise, ratePct) => Math.round((amountPaise * Number(ratePct)) / 100);

export const DEFAULT_TAX_SETTINGS = {
  // Indian GST on accommodation (verify with accountant; configurable per hotel):
  // tariff per unit per night up to ₹7,500 → 5%, above → 18%.
  room_slabs: [
    { upto_paise: 750000, rate: 5 },
    { upto_paise: null, rate: 18 },
  ],
  food_rate: 5,
  service_rate: 18,
  room_sac: '996311',
  food_sac: '996332',
  prices_include_tax: false,
};

export function taxSettings(hotel) {
  return { ...DEFAULT_TAX_SETTINGS, ...(hotel?.settings?.tax || {}) };
}

export function roomTaxRate(hotel, nightlyTariffPaise) {
  const slabs = taxSettings(hotel).room_slabs;
  for (const s of slabs) {
    if (s.upto_paise === null || s.upto_paise === undefined || nightlyTariffPaise <= s.upto_paise) return Number(s.rate);
  }
  return 0;
}
