import { query } from '../db.js';
import { normalizePhone } from './messages.js';

/**
 * Queue a guest message into the outbox. The outbox worker (lib/outbox.js) sends it with the hotel's own
 * WhatsApp / SMS / email keys. Nothing is queued for a channel the hotel owner has switched off in
 * Setup → Messages & payments, so usage costs stay under the hotel's control.
 */
export async function queueNotification(hotelId, guest, template, payload) {
  if (!guest) return;
  try {
    const channels = await hotelChannels(hotelId);
    const phone = normalizePhone(guest.phone);
    const jobs = [];
    if (channels.whatsapp && phone) jobs.push(['whatsapp', phone]);
    if (channels.sms && phone && !channels.whatsapp) jobs.push(['sms', phone]);
    if (channels.email && guest.email) jobs.push(['email', guest.email]);
    for (const [channel, recipient] of jobs) await insert(hotelId, channel, recipient, template, { ...payload, guest_name: guest.full_name }, 'guest');
  } catch (e) {
    console.error('queueNotification failed', e.message);
  }
}

/**
 * Message for staff who have no login (housekeeping, maintenance): sent to the phone numbers the owner
 * entered in Setup. Uses WhatsApp, or SMS if the owner chose SMS for staff alerts.
 */
export async function queueStaffAlert(hotelId, template, payload) {
  try {
    const { rows } = await query('SELECT settings FROM hotels WHERE id = $1', [hotelId]);
    const s = rows[0]?.settings || {};
    const phones = (s.staff_alert_phones || []).map(normalizePhone).filter(Boolean);
    const channel = s.staff_alert_channel === 'sms' ? 'sms' : 'whatsapp';
    for (const p of [...new Set(phones)]) await insert(hotelId, channel, p, template, payload, 'staff');
    return phones.length;
  } catch (e) {
    console.error('queueStaffAlert failed', e.message);
    return 0;
  }
}

/**
 * Task alert for one team (housekeeping / maintenance) on the numbers the owner listed for that team in Setup.
 * A hotel that has not listed team numbers falls back to the general staff alert numbers. Returns how many were queued.
 */
export async function queueTeamAlert(hotelId, team, template, payload) {
  try {
    const { rows } = await query('SELECT settings FROM hotels WHERE id = $1', [hotelId]);
    const s = rows[0]?.settings || {};
    if (s.team_alerts === false) return 0;
    const contacts = (s.staff_contacts || []).filter((c) => c.team === team);
    const phones = (contacts.length ? contacts.map((c) => c.phone) : s.staff_alert_phones || []).map(normalizePhone).filter(Boolean);
    const channel = s.staff_alert_channel === 'sms' ? 'sms' : 'whatsapp';
    for (const p of [...new Set(phones)]) await insert(hotelId, channel, p, template, payload, 'staff');
    return phones.length;
  } catch (e) {
    console.error('queueTeamAlert failed', e.message);
    return 0;
  }
}

async function hotelChannels(hotelId) {
  const { rows } = await query('SELECT settings FROM hotels WHERE id = $1', [hotelId]);
  return rows[0]?.settings?.notifications || {};
}

const insert = (hotelId, channel, recipient, template, payload, audience) => query(
  `INSERT INTO notifications_outbox (hotel_id, channel, recipient, template, payload, audience) VALUES ($1,$2,$3,$4,$5,$6)`,
  [hotelId, channel, recipient, template, JSON.stringify(payload), audience]);
