// One-off clean-up of the demo hotel (slug "demo-hotel") after testing.
//
//   node scripts/cleanup-demo.js            -> dry run: only lists what would change
//   node scripts/cleanup-demo.js --apply    -> makes the changes (one transaction, audited)
//
// Everything below happens only inside the demo hotel. Take a DB backup before --apply.
//   1. Switch off the old demo logins that are not part of the three-login setup
//      (manager@, cashier@, restaurant@, hk@, maintenance@demo-hotel.in). Not deleted.
//   2. DELETE test bookings: guests named "TEST Guest…", "Claude…", or with "(Claude)" in the name,
//      together with their bills, payments and room-service orders. Test data is not history.
//      A test booking that is checked in right now is only listed, never touched.
//   3. DELETE those test guests once they have no booking left.
//   4. Void charges that were never delivered: lines put on the open bill of a booking BEFORE it was
//      cancelled or marked no-show, when the guest never checked in (laundry, food…). Cancellation /
//      no-show fees stay, and so does anything added by hand after the cancellation (a fee).
//   5. Cancel housekeeping tasks pending for more than 24 hours.
//   6. Mark rooms "ready" that are dirty with nobody in them and no open cleaning task
//      (e.g. a room whose stale test task was cancelled).
import { pool } from '../src/db.js';

const APPLY = process.argv.includes('--apply');
const SLUG = 'demo-hotel';
const OLD_DEMO_LOGINS = ['manager@demo-hotel.in', 'cashier@demo-hotel.in', 'restaurant@demo-hotel.in', 'hk@demo-hotel.in', 'maintenance@demo-hotel.in'];
const TEST_GUEST = `(g.full_name ILIKE 'TEST Guest%' OR g.full_name ILIKE 'Claude%' OR g.full_name ILIKE '%(Claude)%')`;
// Fee lines a cancellation / no-show may keep (new lines are tagged; older ones are recognised by their text)
const IS_FEE = `(COALESCE(l.source_type,'') IN ('cancellation_fee','no_show_fee')
                 OR (l.category = 'service' AND l.description IN ('Cancellation charge','No-show charge')))`;
// When the stay was cancelled / marked no-show (booking timestamp, else the audit log)
const CANCELLED_AT = `GREATEST(b.cancelled_at, (SELECT max(a.created_at) FROM audit_logs a WHERE a.hotel_id = b.hotel_id
                       AND ((a.entity_type = 'booking' AND a.entity_id = b.id AND a.action = 'booking.cancelled')
                         OR (a.entity_type = 'stay' AND a.entity_id = s.id AND a.action IN ('stay.cancelled','stay.no_show')))))`;
const rs = (p) => `₹${(Number(p) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

async function main() {
  const db = await pool.connect();
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  try {
    await db.query('BEGIN');
    const hotel = (await q('SELECT id, name FROM hotels WHERE slug = $1', [SLUG]))[0];
    if (!hotel) { console.log(`No hotel with slug "${SLUG}". Nothing to do.`); await db.query('ROLLBACK'); return; }
    const h = hotel.id;
    console.log(`${APPLY ? 'APPLYING' : 'DRY RUN (nothing is changed)'} — ${hotel.name} (#${h})\n`);

    // 1. Old demo logins
    const users = await q(`SELECT id, name, email, role FROM users WHERE hotel_id = $1 AND active AND lower(email) = ANY($2) ORDER BY email`, [h, OLD_DEMO_LOGINS]);
    console.log(`1) Demo logins to switch off: ${users.length}`);
    users.forEach((u) => console.log(`   - ${u.name} <${u.email}>`));

    // 2. Test bookings (with money on them, so the effect on reports is visible)
    const bookings = await q(
      `SELECT b.id, b.ref, b.status, g.full_name,
              bool_or(s.status = 'checked_in') AS in_house,
              COALESCE((SELECT SUM(l.amount_paise + l.tax_paise) FROM folio_lines l JOIN folios f ON f.id = l.folio_id
                         WHERE f.booking_id = b.id AND l.voided_at IS NULL), 0) AS charges,
              COALESCE((SELECT SUM(CASE WHEN p.kind = 'refund' THEN -p.amount_paise ELSE p.amount_paise END) FROM payments p JOIN folios f ON f.id = p.folio_id
                         WHERE f.booking_id = b.id AND p.voided_at IS NULL), 0) AS paid
         FROM bookings b JOIN guests g ON g.id = b.guest_id JOIN stays s ON s.booking_id = b.id
        WHERE b.hotel_id = $1 AND ${TEST_GUEST}
        GROUP BY b.id, g.full_name ORDER BY b.id`, [h]);
    const toDelete = bookings.filter((b) => !b.in_house);
    const inHouse = bookings.filter((b) => b.in_house);
    console.log(`\n2) Test bookings to DELETE (with their bills and orders): ${toDelete.length}`);
    toDelete.forEach((b) => console.log(`   - ${b.ref} · ${b.full_name} · ${b.status} · charges ${rs(b.charges)}, paid ${rs(b.paid)}`));
    if (inHouse.length) {
      console.log('   Checked in right now, NOT touched (check them out from the app first):');
      inHouse.forEach((b) => console.log(`   - ${b.ref} · ${b.full_name}`));
    }

    // 3. Test guests left without bookings
    const keepGuestIds = inHouse.length ? (await q(`SELECT DISTINCT guest_id FROM bookings WHERE id = ANY($1)`, [inHouse.map((b) => b.id)])).map((x) => x.guest_id) : [];
    const guests = await q(
      `SELECT g.id, g.full_name FROM guests g WHERE g.hotel_id = $1 AND ${TEST_GUEST} AND NOT (g.id = ANY($2))
          AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.guest_id = g.id AND NOT (b.id = ANY($3))) ORDER BY g.id`,
      [h, keepGuestIds, toDelete.map((b) => b.id)]);
    console.log(`\n3) Test guests to DELETE: ${guests.length}`);
    guests.forEach((g) => console.log(`   - ${g.full_name}`));

    // 4. Undelivered charges on other cancelled / no-show bookings
    const lines = await q(
      `SELECT l.id, l.description, l.amount_paise, l.tax_paise, b.ref, s.status, g.full_name
         FROM folio_lines l JOIN folios f ON f.id = l.folio_id JOIN stays s ON s.id = f.stay_id
         JOIN bookings b ON b.id = s.booking_id JOIN guests g ON g.id = s.guest_id
        WHERE l.hotel_id = $1 AND f.status = 'open' AND s.status IN ('cancelled','no_show') AND s.checked_in_at IS NULL
          AND l.voided_at IS NULL AND NOT ${IS_FEE} AND NOT (b.id = ANY($2))
          -- A charge added after the cancellation / no-show was put there on purpose (a fee typed by hand): keep it.
          AND l.created_at <= COALESCE(${CANCELLED_AT}, 'infinity')
        ORDER BY b.id, l.id`, [h, toDelete.map((b) => b.id)]);
    console.log(`\n4) Never-delivered charges on cancelled / no-show bookings to VOID: ${lines.length}`);
    lines.forEach((l) => console.log(`   - ${l.ref} · ${l.full_name} (${l.status}) · ${l.description} ${rs(Number(l.amount_paise) + Number(l.tax_paise))}`));
    const fees = await q(
      `SELECT b.ref, l.description, l.amount_paise + l.tax_paise AS total FROM folio_lines l JOIN folios f ON f.id = l.folio_id
         JOIN stays s ON s.id = f.stay_id JOIN bookings b ON b.id = s.booking_id
        WHERE l.hotel_id = $1 AND s.status IN ('cancelled','no_show') AND l.voided_at IS NULL AND NOT (b.id = ANY($2))
          AND (${IS_FEE} OR (s.checked_in_at IS NULL AND l.created_at > COALESCE(${CANCELLED_AT}, 'infinity')))
        ORDER BY b.id`, [h, toDelete.map((b) => b.id)]);
    if (fees.length) {
      console.log('   Kept (cancellation / no-show fees, and charges added after the cancellation):');
      fees.forEach((f) => console.log(`   = ${f.ref} · ${f.description} ${rs(f.total)}`));
    }

    // 5. Stale housekeeping tasks
    const tasks = await q(
      `SELECT t.id, t.status, t.task_type, t.room_id, r.number, t.created_at FROM hk_tasks t JOIN rooms r ON r.id = t.room_id
        WHERE t.hotel_id = $1 AND t.status IN ('pending','in_progress') AND t.created_at < now() - interval '24 hours' ORDER BY t.created_at`, [h]);
    console.log(`\n5) Housekeeping tasks pending over 24h to cancel: ${tasks.length}`);
    tasks.forEach((t) => console.log(`   - room ${t.number} · ${t.task_type} · ${t.status} since ${t.created_at.toISOString().slice(0, 16).replace('T', ' ')} UTC`));

    // Cancelled inside the transaction now (a dry run rolls back), so step 6 sees the rooms as they will be.
    for (const t of tasks) await db.query(`UPDATE hk_tasks SET status = 'cancelled' WHERE id = $1`, [t.id]);

    // 6. Dirty rooms with nobody in them and no open cleaning task
    const rooms = await q(
      `SELECT r.id, r.number, r.hk_status FROM rooms r
        WHERE r.hotel_id = $1 AND r.active AND r.hk_status IN ('dirty','cleaning')
          AND NOT EXISTS (SELECT 1 FROM stays s WHERE s.room_id = r.id AND s.status = 'checked_in')
          AND NOT EXISTS (SELECT 1 FROM hk_tasks t WHERE t.room_id = r.id AND t.status IN ('pending','in_progress'))
        ORDER BY r.number`, [h]);
    console.log(`\n6) Empty dirty rooms with no cleaning task, to mark ready: ${rooms.length}`);
    rooms.forEach((r) => console.log(`   - room ${r.number} (${r.hk_status})`));

    if (!APPLY) {
      await db.query('ROLLBACK');
      console.log('\nDry run only. Run again with --apply to make these changes (take a DB backup first).');
      return;
    }

    const audit = (action, type, id, data) => db.query(
      `INSERT INTO audit_logs (hotel_id, actor_type, action, entity_type, entity_id, data) VALUES ($1,'system',$2,$3,$4,$5)`,
      [h, action, type, id, JSON.stringify({ ...data, by: 'scripts/cleanup-demo.js' })]);

    for (const u of users) {
      await db.query('UPDATE users SET active = false WHERE id = $1', [u.id]);
      await audit('staff.updated', 'user', u.id, { changed: ['active'], active: false });
    }

    const ids = toDelete.map((b) => b.id);
    if (ids.length) {
      const stayIds = (await q('SELECT id FROM stays WHERE booking_id = ANY($1)', [ids])).map((x) => x.id);
      const folioIds = (await q('SELECT id FROM folios WHERE booking_id = ANY($1) OR stay_id = ANY($2)', [ids, stayIds])).map((x) => x.id);
      await db.query('UPDATE service_requests SET stay_id = NULL WHERE stay_id = ANY($1)', [stayIds]);
      await db.query('DELETE FROM orders WHERE stay_id = ANY($1) OR folio_id = ANY($2)', [stayIds, folioIds]); // kots, items cascade
      await db.query('DELETE FROM folios WHERE id = ANY($1)', [folioIds]); // lines, payments cascade
      await db.query('DELETE FROM bookings WHERE id = ANY($1)', [ids]); // stays cascade
      for (const b of toDelete) await audit('booking.deleted', 'booking', b.id, { ref: b.ref, guest: b.full_name, reason: 'Test data (demo clean-up)' });
    }
    for (const g of guests) {
      await db.query('DELETE FROM guests WHERE id = $1', [g.id]);
      await audit('guest.deleted', 'guest', g.id, { name: g.full_name, reason: 'Test data (demo clean-up)' });
    }
    if (lines.length) {
      await db.query(`UPDATE folio_lines SET voided_at = now(), void_reason = 'Never delivered: booking cancelled or no-show before check-in' WHERE id = ANY($1)`,
        [lines.map((l) => l.id)]);
      await audit('folio.undelivered_charges_voided', 'hotel', h, { lines: lines.length, line_ids: lines.map((l) => l.id) });
    }
    for (const t of tasks) await audit('hk.task_cancel', 'hk_task', t.id, { room_id: t.room_id, reason: 'Stale demo task' });
    for (const r of rooms) {
      await db.query(`UPDATE rooms SET hk_status = 'ready' WHERE id = $1`, [r.id]);
      await audit('room.status_changed', 'room', r.id, { from: r.hk_status, to: 'ready', reason: 'Demo clean-up: empty room, no cleaning task' });
    }
    await db.query('COMMIT');
    console.log(`\nDone: ${users.length} login(s) off, ${toDelete.length} test booking(s) and ${guests.length} test guest(s) deleted, `
      + `${lines.length} charge(s) voided, ${tasks.length} task(s) cancelled, ${rooms.length} room(s) marked ready.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('Failed, nothing was changed:', e.message);
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
}

main();
