// One-off clean-up of the demo hotel (slug "demo-hotel") after testing.
//
//   node scripts/cleanup-demo.js            -> dry run: only lists what would change
//   node scripts/cleanup-demo.js --apply    -> makes the changes (one transaction, audited)
//
// What it does, and only inside the demo hotel:
//   1. Switches off the old demo logins that are not part of the three-login setup
//      (manager@, cashier@, restaurant@, hk@, maintenance@demo-hotel.in). Nothing is deleted.
//   2. Cancels test bookings that have not checked in yet: guests named "TEST Guest…", "Claude…",
//      or with "(Claude)" in the name. Bookings that are checked in are only listed, not touched.
//   3. Cancels housekeeping tasks that have been pending for more than 24 hours.
//      A room left in "cleaning" by such a task goes back to "dirty".
import { pool } from '../src/db.js';

const APPLY = process.argv.includes('--apply');
const SLUG = 'demo-hotel';
const OLD_DEMO_LOGINS = ['manager@demo-hotel.in', 'cashier@demo-hotel.in', 'restaurant@demo-hotel.in', 'hk@demo-hotel.in', 'maintenance@demo-hotel.in'];
const TEST_GUEST = `(g.full_name ILIKE 'TEST Guest%' OR g.full_name ILIKE 'Claude%' OR g.full_name ILIKE '%(Claude)%')`;

async function main() {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const hotel = (await db.query('SELECT id, name FROM hotels WHERE slug = $1', [SLUG])).rows[0];
    if (!hotel) { console.log(`No hotel with slug "${SLUG}". Nothing to do.`); await db.query('ROLLBACK'); return; }
    const h = hotel.id;
    console.log(`${APPLY ? 'APPLYING' : 'DRY RUN (nothing is changed)'} — ${hotel.name} (#${h})\n`);

    // 1. Old demo logins
    const users = (await db.query(
      `SELECT id, name, email, role FROM users WHERE hotel_id = $1 AND active AND lower(email) = ANY($2) ORDER BY email`, [h, OLD_DEMO_LOGINS])).rows;
    console.log(`1) Demo logins to switch off: ${users.length}`);
    users.forEach((u) => console.log(`   - ${u.name} <${u.email}> (${u.role})`));

    // 2. Test bookings
    const bookings = (await db.query(
      `SELECT b.id, b.ref, b.status, g.full_name,
              count(s.id) FILTER (WHERE s.status IN ('tentative','reserved'))::int AS open_stays,
              count(s.id) FILTER (WHERE s.status = 'checked_in')::int AS in_house
         FROM bookings b JOIN guests g ON g.id = b.guest_id JOIN stays s ON s.booking_id = b.id
        WHERE b.hotel_id = $1 AND ${TEST_GUEST} AND b.status <> 'cancelled'
        GROUP BY b.id, g.full_name ORDER BY b.id`, [h])).rows;
    const toCancel = bookings.filter((b) => b.open_stays > 0 && b.in_house === 0);
    const inHouse = bookings.filter((b) => b.in_house > 0);
    console.log(`\n2) Test bookings to cancel: ${toCancel.length}`);
    toCancel.forEach((b) => console.log(`   - ${b.ref} · ${b.full_name}`));
    if (inHouse.length) {
      console.log(`   Checked in, NOT touched (check these out from the app if they are tests):`);
      inHouse.forEach((b) => console.log(`   - ${b.ref} · ${b.full_name}`));
    }

    // 3. Stale housekeeping tasks
    const tasks = (await db.query(
      `SELECT t.id, t.status, t.task_type, t.room_id, r.number, t.created_at FROM hk_tasks t JOIN rooms r ON r.id = t.room_id
        WHERE t.hotel_id = $1 AND t.status IN ('pending','in_progress') AND t.created_at < now() - interval '24 hours' ORDER BY t.created_at`, [h])).rows;
    console.log(`\n3) Housekeeping tasks pending over 24h to cancel: ${tasks.length}`);
    tasks.forEach((t) => console.log(`   - room ${t.number} · ${t.task_type} · ${t.status} since ${t.created_at.toISOString().slice(0, 16).replace('T', ' ')} UTC`));

    if (!APPLY) {
      await db.query('ROLLBACK');
      console.log('\nDry run only. Run again with --apply to make these changes.');
      return;
    }

    const audit = (action, type, id, data) => db.query(
      `INSERT INTO audit_logs (hotel_id, actor_type, action, entity_type, entity_id, data) VALUES ($1,'system',$2,$3,$4,$5)`,
      [h, action, type, id, JSON.stringify({ ...data, by: 'scripts/cleanup-demo.js' })]);

    for (const u of users) {
      await db.query('UPDATE users SET active = false WHERE id = $1', [u.id]);
      await audit('staff.updated', 'user', u.id, { changed: ['active'], active: false });
    }
    for (const b of toCancel) {
      await db.query(`UPDATE stays SET status = 'cancelled' WHERE booking_id = $1 AND status IN ('tentative','reserved')`, [b.id]);
      await db.query(`UPDATE bookings SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'Test booking (demo clean-up)' WHERE id = $1`, [b.id]);
      await audit('booking.cancelled', 'booking', b.id, { reason: 'Test booking (demo clean-up)' });
    }
    for (const t of tasks) {
      await db.query(`UPDATE hk_tasks SET status = 'cancelled' WHERE id = $1`, [t.id]);
      if (t.status === 'in_progress' && ['cleaning', 'deep_clean'].includes(t.task_type)) {
        await db.query(`UPDATE rooms SET hk_status = 'dirty' WHERE id = $1 AND hk_status = 'cleaning'`, [t.room_id]);
      }
      await audit('hk.task_cancel', 'hk_task', t.id, { room_id: t.room_id, reason: 'Stale demo task' });
    }
    await db.query('COMMIT');
    console.log(`\nDone: ${users.length} login(s) switched off, ${toCancel.length} booking(s) cancelled, ${tasks.length} task(s) cancelled.`);
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
