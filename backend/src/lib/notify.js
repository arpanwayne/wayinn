import { query } from '../db.js';

/**
 * Queue guest notifications into the outbox. A worker (scripts/outbox-worker.js) delivers them through
 * whichever provider is configured for the hotel (WhatsApp Cloud API / SMS / email). Nothing is sent
 * unless the hotel has enabled that channel, so usage costs stay under the hotel's control.
 */
export async function queueNotification(hotelId, guest, template, payload) {
  if (!guest) return;
  try {
    const { rows } = await query('SELECT settings FROM hotels WHERE id = $1', [hotelId]);
    const channels = rows[0]?.settings?.notifications || {};
    const jobs = [];
    if (channels.whatsapp && guest.phone) jobs.push(['whatsapp', guest.phone]);
    if (channels.sms && guest.phone && !channels.whatsapp) jobs.push(['sms', guest.phone]);
    if (channels.email && guest.email) jobs.push(['email', guest.email]);
    for (const [channel, recipient] of jobs) {
      await query(
        `INSERT INTO notifications_outbox (hotel_id, channel, recipient, template, payload) VALUES ($1,$2,$3,$4,$5)`,
        [hotelId, channel, recipient, template, JSON.stringify({ ...payload, guest_name: guest.full_name })]);
    }
  } catch (e) {
    console.error('queueNotification failed', e.message);
  }
}
