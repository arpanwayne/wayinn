export const rupees = (paise, { decimals = 2 } = {}) =>
  '₹' + (Number(paise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
export const rupees0 = (p) => rupees(p, { decimals: 0 });
export const toPaise = (rupeeStr) => Math.round(parseFloat(rupeeStr || '0') * 100);

export const fmtDate = (d) => (d ? new Date(d.length === 10 ? d + 'T00:00:00' : d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '—');
export const fmtDateLong = (d) => (d ? new Date(d.length === 10 ? d + 'T00:00:00' : d).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const fmtTime = (d) => (d ? new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '');
export const fmtDateTime = (d) => (d ? `${fmtDate(d)} ${fmtTime(d)}` : '—');
export const ago = (d) => {
  const m = Math.round((Date.now() - new Date(d)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
};

export const todayStr = () => new Date().toLocaleDateString('en-CA');
export const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
export const nights = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
export const label = (s) => (s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
/** "1 room", "2 rooms": count + the right word. */
export const plural = (n, one, many = `${one}s`) => `${n} ${Number(n) === 1 ? one : many}`;

// Booking sources, including the OTAs (bookings pushed by a channel manager carry the OTA's name).
export const SOURCES = [['walk_in', 'Walk-in'], ['phone', 'Phone'], ['direct_online', 'Website'], ['makemytrip', 'MakeMyTrip'], ['goibibo', 'Goibibo'],
  ['oyo', 'OYO'], ['booking_com', 'Booking.com'], ['agoda', 'Agoda'], ['airbnb', 'Airbnb'], ['expedia', 'Expedia'], ['ota', 'Other OTA'],
  ['channel_manager', 'Channel manager'], ['corporate', 'Corporate'], ['staff', 'Staff'], ['other', 'Other']];
const SOURCE_NAMES = Object.fromEntries(SOURCES);
export const sourceLabel = (s) => SOURCE_NAMES[s] || label(s);
