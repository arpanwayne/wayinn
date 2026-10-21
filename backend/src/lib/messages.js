// Message templates. WhatsApp business messages must use templates approved by Meta, so each template here
// has the same name and the same {{1}}, {{2}}… order as the one to create in the hotel's WhatsApp Manager.
// `text` is the wording to submit to Meta (and the body used for SMS fallback and email).

const fmt = (d) => {
  if (!d) return '';
  const x = new Date(String(d).length === 10 ? `${d}T00:00:00Z` : d);
  return x.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
};
const rs = (p) => `Rs. ${(Number(p || 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export const TEMPLATES = {
  booking_confirmation: {
    audience: 'guest', subject: (p) => `Booking ${p.ref} confirmed — ${p.hotel}`,
    params: (p) => [p.guest_name, p.hotel, p.ref, fmt(p.check_in), fmt(p.check_out)],
    text: 'Dear {{1}}, your booking at {{2}} is confirmed. Booking ID: {{3}}. Check-in: {{4}}. Check-out: {{5}}. We look forward to hosting you.',
  },
  checkin_welcome: {
    audience: 'guest', subject: (p) => `Welcome to ${p.hotel}`,
    params: (p) => [p.guest_name, p.hotel, p.room, p.pin],
    text: 'Welcome to {{2}}, {{1}}! You are in room {{3}}. Scan the QR code in your room to order food, ask for help or see your bill. Your PIN is {{4}}.',
  },
  deposit_received: {
    audience: 'guest', subject: (p) => `Payment received — ${p.ref}`,
    params: (p) => [p.guest_name, rs(p.amount_paise), p.ref, p.hotel],
    text: 'Dear {{1}}, we have received your advance payment of {{2}} for booking {{3}} at {{4}}. Thank you.',
  },
  checkin_documents_request: {
    audience: 'guest', subject: (p) => `Your ID for check-in — ${p.hotel}`,
    params: (p) => [p.guest_name, p.hotel],
    text: 'Dear {{1}}, welcome to {{2}}. To complete your check-in, please send a clear photo of your ID (Aadhaar, passport, driving licence or voter ID) as a reply on this WhatsApp chat. Thank you.',
  },
  hk_task_alert: {
    audience: 'staff', subject: (p) => `Housekeeping: room ${p.room}`,
    params: (p) => [p.task, p.room, p.hotel, p.priority, p.note || '-'],
    text: 'Housekeeping: {{1}} for room {{2}} at {{3}}. Priority: {{4}}. Note: {{5}}. Reply DONE {{2}} when finished.',
  },
  maintenance_alert: {
    audience: 'staff', subject: (p) => `Maintenance: ${p.title}`,
    params: (p) => [p.title, p.room, p.hotel, p.priority, p.id],
    text: 'Maintenance: {{1}} in {{2}} at {{3}}. Priority: {{4}}. Reply FIXED {{5}} when resolved.',
  },
  room_checkout_alert: {
    audience: 'staff', subject: (p) => `Room ${p.room} checked out`,
    params: (p) => [p.room, p.hotel, p.note],
    text: 'Room {{1}} at {{2}} has just checked out. {{3}}',
  },
};

export function renderText(template, payload) {
  const t = TEMPLATES[template];
  if (!t) return null;
  const vals = t.params(payload);
  return t.text.replace(/\{\{(\d+)\}\}/g, (_m, n) => String(vals[Number(n) - 1] ?? ''));
}

/** Indian mobile numbers to the 91XXXXXXXXXX form WhatsApp and MSG91 expect. Other countries need a + prefix. */
export function normalizePhone(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let d = s.replace(/\D/g, '');
  if (s.startsWith('+')) return d.length >= 8 ? d : null;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10 && /^[6-9]/.test(d)) return `91${d}`;
  if (d.length === 12 && d.startsWith('91')) return d;
  return null;
}
