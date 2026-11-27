// Background jobs (run inside the API process; safe to run on one instance only — set RUN_JOBS=false on others)
import { many, tx } from '../db.js';
import { postRoomNights } from './folio.js';
import { hotelToday } from './dates.js';
import { processOutbox } from './outbox.js';
import { schedulerTick } from './rateguard/engine.js';
import { googleTick } from './google/sync.js';

async function autoNightAudit() {
  const hotels = await many(`SELECT * FROM hotels WHERE subscription_status IN ('trial','active','past_due')`);
  for (const h of hotels) {
    const today = hotelToday(h.timezone);
    try {
      await tx(async (db) => {
        const stays = await db.many(
          `SELECT s.*, r.number AS room_number, f.id AS folio_id FROM stays s JOIN rooms r ON r.id = s.room_id JOIN folios f ON f.stay_id = s.id
            WHERE s.hotel_id = $1 AND s.status = 'checked_in' AND f.status = 'open'`, [h.id]);
        let posted = 0;
        for (const s of stays) posted += await postRoomNights(db, h, s, s.folio_id, today, null);
        if (posted) {
          await db.query(`INSERT INTO audit_logs (hotel_id, actor_type, action, entity_type, entity_id, data) VALUES ($1,'system','night_audit.auto','hotel',$1,$2)`,
            [h.id, JSON.stringify({ business_date: today, nights_posted: posted })]);
        }
      });
    } catch (e) {
      console.error(`auto night audit failed for hotel ${h.id}:`, e.message);
    }
  }
}

/** Run fn every `ms`, never two at once. */
function every(ms, fn, name) {
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await fn(); } catch (e) { console.error(`${name} failed:`, e.message); } finally { busy = false; }
  }, ms);
}

export function startJobs() {
  if (process.env.RUN_JOBS === 'false') return;
  // Rate Guard: OTA price checks (each hotel's own schedule), suggestions and WhatsApp alerts.
  if (process.env.RATE_GUARD_JOBS !== 'false') every(Number(process.env.RATE_GUARD_TICK_MIN || 10) * 60_000, () => schedulerTick(), 'rate guard');
  // Google Hotels: hotels whose rates just changed every minute, everything (bookings, inventory) every 10 minutes.
  every(60_000, () => googleTick(), 'google sync (changes)');
  every(Number(process.env.GOOGLE_SYNC_MIN || 10) * 60_000, () => googleTick({ all: true }), 'google sync (all)');
  const every = Number(process.env.NIGHT_AUDIT_INTERVAL_MIN || 30) * 60 * 1000;
  setTimeout(() => autoNightAudit().catch(console.error), 10_000);
  setInterval(() => autoNightAudit().catch(console.error), every);
  // WhatsApp / SMS / email delivery. Set OUTBOX_IN_API=false if a separate `npm run outbox -- --watch` runs instead.
  if (process.env.OUTBOX_IN_API !== 'false') {
    let busy = false;
    setInterval(async () => {
      if (busy) return;
      busy = true;
      try { await processOutbox(); } catch (e) { console.error('outbox failed:', e.message); } finally { busy = false; }
    }, Number(process.env.OUTBOX_INTERVAL_SEC || 30) * 1000);
  }
}
