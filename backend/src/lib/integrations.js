// Per-hotel keys for WhatsApp, SMS, email, Razorpay and the channel manager.
// Only the super admin can see or change them; hotel staff only ever get "connected / not connected".
import crypto from 'node:crypto';
import { one, query } from '../db.js';

export async function loadIntegrations(hotelId, db = { one }) {
  return (await db.one('SELECT * FROM hotel_integrations WHERE hotel_id = $1', [hotelId])) || { hotel_id: hotelId, sms_templates: {} };
}

export const whatsappReady = (i) => !!(i?.whatsapp_phone_number_id && i?.whatsapp_token);
export const smsReady = (i) => !!i?.sms_auth_key;
export const emailReady = (i) => !!(i?.smtp_host && i?.email_from);
export const razorpayReady = (i) => !!(i?.razorpay_key_id && i?.razorpay_key_secret);

/** What hotel staff may see. */
export function integrationStatus(i) {
  return {
    whatsapp: whatsappReady(i), sms: smsReady(i), email: emailReady(i), razorpay: razorpayReady(i),
    channel_key_hint: i?.channel_key_hint || null, ical_enabled: !!i?.ical_token,
  };
}

const mask = (v) => (v ? `••••${String(v).slice(-4)}` : null);
const SECRET = ['whatsapp_token', 'sms_auth_key', 'smtp_pass', 'razorpay_key_secret', 'razorpay_webhook_secret'];
export const INTEGRATION_FIELDS = ['whatsapp_phone_number_id', 'whatsapp_token', 'whatsapp_language', 'sms_auth_key', 'sms_templates',
  'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'email_from', 'razorpay_key_id', 'razorpay_key_secret', 'razorpay_webhook_secret'];

/** What the super admin sees: secrets masked to their last 4 characters. */
export function maskedIntegrations(i) {
  const out = {};
  for (const k of INTEGRATION_FIELDS) out[k] = SECRET.includes(k) ? mask(i?.[k]) : i?.[k] ?? null;
  out.sms_templates = i?.sms_templates || {};
  return { ...out, status: integrationStatus(i) };
}

/** Save only the fields that were sent. undefined = keep, null or '' = clear. */
export async function saveIntegrations(hotelId, patch) {
  // A masked value sent back unchanged ("••••1234") means "keep the saved secret".
  const keys = INTEGRATION_FIELDS.filter((k) => patch[k] !== undefined && !(typeof patch[k] === 'string' && patch[k].startsWith('••••')));
  await query('INSERT INTO hotel_integrations (hotel_id) VALUES ($1) ON CONFLICT (hotel_id) DO NOTHING', [hotelId]);
  if (!keys.length) return;
  const vals = keys.map((k) => {
    const v = patch[k];
    if (k === 'sms_templates') return JSON.stringify(v || {});
    if (k === 'whatsapp_language') return v || 'en';
    return v === '' ? null : v;
  });
  await query(`UPDATE hotel_integrations SET ${keys.map((k, n) => `${k} = $${n + 2}`).join(', ')}, updated_at = now() WHERE hotel_id = $1`,
    [hotelId, ...vals]);
}

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('hex');

/** Constant-time compare of two hex/ASCII strings. */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export const hmacHex = (secret, body) => crypto.createHmac('sha256', secret).update(body).digest('hex');
