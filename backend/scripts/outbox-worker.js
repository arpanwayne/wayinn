// Send queued WhatsApp / SMS / email messages.
//   npm run outbox              one pass, prints what happened
//   npm run outbox -- --watch   keep running (use with OUTBOX_IN_API=false on the API)
import { processOutbox } from '../src/lib/outbox.js';
import { pool } from '../src/db.js';

const watch = process.argv.includes('--watch');
async function pass() {
  const r = await processOutbox({ limit: 50 });
  if (!watch || r.sent || r.failed || r.skipped || r.retry) console.log(new Date().toISOString(), r);
}
if (watch) {
  for (;;) { try { await pass(); } catch (e) { console.error(e.message); } await new Promise((ok) => setTimeout(ok, 15000)); }
} else {
  await pass();
  await pool.end();
}
