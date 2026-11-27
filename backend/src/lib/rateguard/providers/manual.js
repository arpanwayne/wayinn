// No data company: the owner or front desk types the OTA prices they see (Rates → Rate Guard → "Add OTA price").
// Suggestions and WhatsApp alerts work the same way; nothing is fetched on a schedule.
export default {
  name: 'manual',
  label: 'Typed in by hand',
  note: 'No automatic checks. Add OTA prices yourself; suggestions work the same.',
  ready: () => true,
  manual: true,
  async search(query) {
    return [{ token: 'manual', name: query, address: null, rating: null, link: null }];
  },
  async fetchOffers() {
    return { offers: [] };
  },
};
