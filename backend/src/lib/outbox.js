// Delivers queued messages from notifications_outbox. Runs inside the API process every 30 seconds
// (see jobs.js), and can also be run by hand: `npm run outbox` (one pass) or `npm run outbox -- --watch`.
import { pool } from '../db.js';
import { loadIntegrations, whatsappReady, smsReady, emailReady } from './integrations.js';
import { sendWhatsApp, sendSms, sendEmail, ProviderError } from './providers.js';

export const MAX_ATTEMPTS = 5;
const backoffMinutes = (attempt) => [1, 5, 30, 120, 360][Math.min(attempt, 5) - 1];

/**
 * Claim up to `limit` due messages and send them. Safe with several workers: rows are claimed with
 * FOR UPDATE SKIP LOCKED and pushed into the future before sending, so nobody sends the same one twice.
 * `deps` lets tests swap the senders.
 */
export async function processOutbox({ limit = 25, deps = {} } = {}) {
  const send = { whatsapp: deps.whatsapp || sendWhatsApp, sms: deps.sms || sendSms, email: deps.email || sendEmail };
  const { rows } = await pool.query(
    `UPDATE notifications_outbox o SET attempts = o.attempts + 1, next_attempt_at = now() + interval '10 minutes'
      WHERE o.id IN (SELECT id FROM notifications_outbox WHERE status = 'queued' AND next_attempt_at <= now()
                      ORDER BY next_attempt_at, id LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING o.*`, [limit]);
  const integCache = new Map();
  const result = { sent: 0, failed: 0, skipped: 0, retry: 0 };
  for (const m of rows) {
    if (!integCache.has(m.hotel_id)) integCache.set(m.hotel_id, await loadIntegrations(m.hotel_id));
    const integ = integCache.get(m.hotel_id);
    const ready = { whatsapp: whatsappReady, sms: smsReady, email: emailReady }[m.channel](integ);
    if (!ready) {
      // Strict: a hotel without its own keys sends nothing (no shared Wayinn number).
      await pool.query(`UPDATE notifications_outbox SET status = 'skipped', error = $2 WHERE id = $1`,
        [m.id, `${m.channel} is not connected for this hotel`]);
      result.skipped++;
      continue;
    }
    try {
      const { ref } = await send[m.channel](integ, m.recipient, m.template, m.payload);
      await pool.query(`UPDATE notifications_outbox SET status = 'sent', sent_at = now(), provider_ref = $2, error = NULL WHERE id = $1`, [m.id, ref]);
      result.sent++;
    } catch (e) {
      const retry = !(e instanceof ProviderError) || e.retry;
      if (retry && m.attempts < MAX_ATTEMPTS) {
        await pool.query(`UPDATE notifications_outbox SET error = $2, next_attempt_at = now() + ($3 || ' minutes')::interval WHERE id = $1`,
          [m.id, String(e.message).slice(0, 500), backoffMinutes(m.attempts)]);
        result.retry++;
      } else {
        await pool.query(`UPDATE notifications_outbox SET status = 'failed', error = $2 WHERE id = $1`, [m.id, String(e.message).slice(0, 500)]);
        result.failed++;
      }
    }
  }
  return result;
}
