// Fills the demo hotel with a realistic "today" for sales demos and UI testing.
// Usage: npm run demo-data   (run after `npm run seed`; safe to re-run — it resets the demo hotel's live stays first)
import { createApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { hotelToday, addDays } from '../src/lib/dates.js';

const server = createApp().listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
const today = hotelToday('Asia/Kolkata');

async function call(method, path, body, token) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${d?.error}`);
  return d;
}

const GUESTS = [
  ['Aarav Mehta', '+919810011001', 'Delhi'], ['Simran Kaur', '+919814022002', 'Amritsar'], ['Rohan Gupta', '+919815033003', 'Chandigarh'],
  ['Priya Nair', '+919846044004', 'Kochi'], ['Daniel Brooks', '+14165550123', 'Toronto'], ['Neha Verma', '+919899055005', 'Jaipur'],
  ['Harpreet Singh', '+919876066006', 'Ludhiana'], ['Ananya Iyer', '+919840077007', 'Chennai'], ['Vikram Rao', '+919845088008', 'Bengaluru'],
  ['Kabir Malhotra', '+919811099009', 'Gurugram'], ['Meera Joshi', '+919822010010', 'Pune'],
];

async function main() {
  const h = (await pool.query(`SELECT id FROM hotels WHERE slug = 'demo-hotel'`)).rows[0];
  if (!h) throw new Error('Run npm run seed first');
  await pool.query(`UPDATE stays SET status = 'cancelled' WHERE hotel_id = $1 AND status IN ('reserved','checked_in','tentative')`, [h.id]);
  await pool.query(`UPDATE orders SET status = 'cancelled' WHERE hotel_id = $1 AND status <> 'cancelled'`, [h.id]);
  await pool.query(`UPDATE hk_tasks SET status = 'cancelled' WHERE hotel_id = $1 AND status IN ('pending','in_progress')`, [h.id]);
  await pool.query(`UPDATE rooms SET hk_status = 'ready', out_of_order_reason = NULL WHERE hotel_id = $1`, [h.id]);
  await pool.query(`UPDATE service_requests SET status = 'done' WHERE hotel_id = $1 AND status IN ('open','acknowledged')`, [h.id]);
  await pool.query(`UPDATE maintenance_requests SET status = 'cancelled' WHERE hotel_id = $1 AND status IN ('open','in_progress')`, [h.id]);

  const tok = (await call('POST', '/auth/login', { email: 'owner@demo-hotel.in', password: process.env.SEED_PASSWORD || 'Wayinn@123' })).token;
  const rooms = await call('GET', '/rooms', null, tok);
  const byNo = Object.fromEntries(rooms.map((r) => [r.number, r]));
  const book = async (i, roomNo, from, to, extra = {}) => {
    const [full_name, phone, city] = GUESTS[i];
    const r = byNo[roomNo];
    return call('POST', '/bookings', {
      guest: { full_name, phone, city, id_type: 'Aadhaar', id_number: `XXXX-XXXX-${1000 + i}` }, source: extra.source || 'phone',
      stays: [{ room_type_id: r.room_type_id, room_id: r.id, check_in_date: from, check_out_date: to, adults: 2 }], ...extra.body,
    }, tok);
  };

  // In-house guests (checked in "yesterday" or today)
  const inHouse = [[0, '101', -1, 2], [1, '102', -2, 1], [2, '201', 0, 3], [3, '202', -1, 1], [4, '301', -3, 2], [5, '203', 0, 2]];
  const stays = [];
  for (const [i, no, a, b] of inHouse) {
    const bk = await book(i, no, addDays(today, Math.min(a, 0) === a && a < 0 ? 0 : a), addDays(today, b));
    // backdate arrival for realism
    if (a < 0) await pool.query(`UPDATE stays SET check_in_date = $1 WHERE id = $2`, [addDays(today, a), bk.stays[0].id]);
    await call('POST', `/stays/${bk.stays[0].id}/checkin`, {}, tok);
    stays.push(bk.stays[0]);
  }
  // Arrivals today (one without room, one with a deposit)
  await book(6, '103', today, addDays(today, 2), { body: { deposit: { amount_paise: 200000, method: 'upi', reference: 'UPI8812' } } });
  await book(7, '204', today, addDays(today, 1));
  const st = rooms.find((r) => r.number === '105');
  await call('POST', '/bookings', { guest: { full_name: GUESTS[8][0], phone: GUESTS[8][1] }, stays: [{ room_type_id: st.room_type_id, check_in_date: today, check_out_date: addDays(today, 2) }] }, tok);
  // Future + online request
  await book(9, '205', addDays(today, 2), addDays(today, 5));
  await call('POST', '/public/hotels/demo-hotel/booking-requests', { full_name: GUESTS[10][0], phone: GUESTS[10][1], room_type_id: byNo['302'].room_type_id, check_in_date: addDays(today, 4), check_out_date: addDays(today, 6) });

  // Restaurant activity
  const menu = await call('GET', '/menu', null, tok);
  const item = (n) => menu.items.find((x) => x.name === n).id;
  const o1 = await call('POST', '/orders', { order_type: 'room_service', room_id: byNo['101'].id, items: [{ menu_item_id: item('Aloo Paratha with Curd'), quantity: 2 }, { menu_item_id: item('Masala Chai'), quantity: 2 }] }, tok);
  await call('POST', `/orders/${o1.id}/settle`, { mode: 'room' }, tok);
  await call('PATCH', `/orders/${o1.id}/status`, { status: 'delivered' }, tok);
  const o2 = await call('POST', '/orders', { order_type: 'dine_in', table_label: 'T2', items: [{ menu_item_id: item('Butter Chicken'), variant: 'Full', quantity: 1 }, { menu_item_id: item('Butter Naan'), quantity: 3 }] }, tok);
  await call('PATCH', `/kots/${o2.kots[0].id}`, { status: 'preparing' }, tok);
  await call('POST', '/orders', { order_type: 'room_service', room_id: byNo['201'].id, items: [{ menu_item_id: item('Cold Coffee'), quantity: 2, addons: ['Ice cream'] }] }, tok);
  const o4 = await call('POST', '/orders', { order_type: 'takeaway', customer_name: 'Walk-in', items: [{ menu_item_id: item('Veg Biryani'), quantity: 2 }] }, tok);
  await call('POST', `/orders/${o4.id}/settle`, { mode: 'pay', payments: [{ method: 'upi', amount_paise: o4.total_paise }] }, tok);

  // Payments, housekeeping, maintenance
  await call('POST', `/folios/${stays[1].folio_id}/payments`, { method: 'card', amount_paise: 300000, reference: 'POS-4411' }, tok);
  await pool.query(`UPDATE rooms SET hk_status = 'dirty' WHERE hotel_id = $1 AND number IN ('104','106')`, [h.id]);
  await call('POST', '/housekeeping/tasks', { room_id: byNo['104'].id, task_type: 'cleaning', priority: 'high', notes: 'Checkout clean' }, tok);
  await call('POST', '/housekeeping/tasks', { room_id: byNo['106'].id, task_type: 'deep_clean', priority: 'normal' }, tok);
  await call('POST', '/maintenance', { room_id: byNo['208'].id, title: 'AC not cooling', description: 'Compressor noise reported', priority: 'high', mark_out_of_order: true }, tok);
  await call('POST', `/portal/${byNo['202'].qr_token}/requests`, { type: 'towels', message: '2 extra bath towels please' });
  await call('POST', '/hotel/handover', { note: 'Room 301 guest wants airport drop at 6am tomorrow — cab booked with Sharma Travels' }, tok);

  console.log('Demo data ready for', today);
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(async () => { server.close(); await pool.end(); });
