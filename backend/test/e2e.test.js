// End-to-end flow test against a real Postgres (DATABASE_URL). Run after `npm run migrate && npm run seed`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { hotelToday, addDays } from '../src/lib/dates.js';

let server, base;
const today = hotelToday('Asia/Kolkata');
const tok = {};

async function call(method, path, body, token) {
  const res = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const login = async (email) => (await call('POST', '/api/auth/login', { email, password: 'Wayinn@123' })).data.token;

before(async () => {
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  for (const who of ['owner', 'frontdesk', 'kitchen']) tok[who] = await login(`${who}@demo-hotel.in`);
  tok.reception = tok.hk = tok.restaurant = tok.frontdesk; // one front-desk role covers all three jobs
  // Clean slate for repeatable runs: free rooms 101/102 for today
  await pool.query(`UPDATE stays SET status = 'cancelled' WHERE hotel_id = 1 AND status IN ('reserved','checked_in','tentative')`);
  await pool.query(`UPDATE orders SET status = 'cancelled' WHERE hotel_id = 1 AND status <> 'cancelled'`);
  await pool.query(`UPDATE rooms SET hk_status = 'ready' WHERE hotel_id = 1`);
});
after(async () => { server.close(); await pool.end(); });

test('full guest journey', async () => {
  const rooms = (await call('GET', '/api/rooms', null, tok.reception)).data;
  const r101 = rooms.find((r) => r.number === '101');
  const r102 = rooms.find((r) => r.number === '102');

  // Walk-in without ID → check-in blocked
  let res = await call('POST', '/api/bookings', {
    guest: { full_name: 'Rahul Sharma', phone: '+919812345678' }, source: 'walk_in',
    stays: [{ room_type_id: r101.room_type_id, room_id: r101.id, check_in_date: today, check_out_date: addDays(today, 2), adults: 2 }],
  }, tok.reception);
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const booking = res.data;
  const stay = booking.stays[0];

  // Double booking the same room is refused
  res = await call('POST', '/api/bookings', {
    guest: { full_name: 'Someone Else', phone: '9000000000' },
    stays: [{ room_type_id: r101.room_type_id, room_id: r101.id, check_in_date: addDays(today, 1), check_out_date: addDays(today, 3) }],
  }, tok.reception);
  assert.equal(res.status, 409);

  res = await call('POST', `/api/stays/${stay.id}/checkin`, {}, tok.reception);
  assert.equal(res.status, 400);
  assert.equal(res.data.details.needs_id, true);
  await call('PUT', `/api/guests/${booking.guest_id}`, { id_type: 'Aadhaar', id_number: '1234 5678 9012' }, tok.owner);
  res = await call('POST', `/api/stays/${stay.id}/checkin`, {}, tok.reception);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const pin = res.data.portal_pin;

  // Folio has first night (₹2500 @ 5% GST)
  let folio = (await call('GET', `/api/folios/${stay.folio_id}`, null, tok.reception)).data;
  assert.equal(folio.totals.subtotal_paise, 250000);
  assert.equal(folio.totals.tax_paise, 12500);

  // Staff room-service order → post to room
  const menu = (await call('GET', '/api/menu', null, tok.restaurant)).data;
  const naan = menu.items.find((i) => i.name === 'Butter Naan');
  const dal = menu.items.find((i) => i.name === 'Dal Makhani');
  res = await call('POST', '/api/orders', {
    order_type: 'room_service', room_id: r101.id,
    items: [{ menu_item_id: dal.id, variant: 'Full', quantity: 1 }, { menu_item_id: naan.id, quantity: 2 }],
  }, tok.restaurant);
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const order = res.data;
  assert.equal(order.subtotal_paise, 28000 + 12000);
  assert.equal(order.kots.length, 1);
  // Kitchen has one action: Delivered → order delivered. Kitchen cannot cancel.
  assert.equal((await call('POST', `/api/orders/${order.id}/cancel`, { reason: 'out of dal' }, tok.kitchen)).status, 403);
  res = await call('PATCH', `/api/kots/${order.kots[0].id}`, { status: 'delivered' }, tok.kitchen);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal((await call('GET', `/api/orders/${order.id}`, null, tok.restaurant)).data.status, 'delivered');
  assert.equal((await call('GET', '/api/kitchen/kots', null, tok.kitchen)).data.kots.some((k) => k.order_id === order.id), false);
  res = await call('POST', `/api/orders/${order.id}/settle`, { mode: 'room' }, tok.restaurant);
  assert.equal(res.status, 200, JSON.stringify(res.data));

  // Kitchen staff cannot refund or see folios
  res = await call('GET', `/api/folios/${stay.folio_id}`, null, tok.kitchen);
  assert.equal(res.status, 403);

  // Guest QR portal: public view shows no guest data; the bill needs the PIN
  res = await call('GET', `/api/portal/${r101.qr_token}`);
  assert.equal(res.data.occupied, true);
  assert.equal(res.data.guest_name, undefined);
  res = await call('POST', `/api/portal/${r101.qr_token}/verify`, { code: '0000' });
  assert.equal(res.status, 401);
  res = await call('POST', `/api/portal/${r101.qr_token}/verify`, { code: pin });
  assert.equal(res.status, 200);
  const guestTok = res.data.token;
  // Guest token can't be used on staff APIs
  assert.equal((await call('GET', '/api/bookings', null, guestTok)).status, 401);
  // Another room's QR shows no stay, and an empty room cannot order
  assert.equal((await call('POST', `/api/portal/${r102.qr_token}/verify`, { code: pin })).status, 409);
  const chai = menu.items.find((i) => i.name === 'Masala Chai');
  const paratha = menu.items.find((i) => i.name === 'Aloo Paratha with Curd');
  res = await call('POST', `/api/portal/${r102.qr_token}/orders`, { items: [{ menu_item_id: chai.id, quantity: 1 }] });
  assert.equal(res.status, 409);
  // Towel request creates an HK task
  res = await call('POST', `/api/portal/${r101.qr_token}/requests`, { type: 'towels', message: '2 extra towels' });
  assert.equal(res.status, 201);

  // QR order from the checked-in room, no PIN: straight to the kitchen and onto the room bill
  const before = (await call('GET', `/api/folios/${stay.folio_id}`, null, tok.reception)).data.totals.total_paise;
  res = await call('POST', `/api/portal/${r101.qr_token}/orders`, { items: [{ menu_item_id: chai.id, quantity: 2 }, { menu_item_id: paratha.id, quantity: 1 }] });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.status, 'accepted');
  const qrOrder = (await call('GET', `/api/orders/${res.data.id}`, null, tok.frontdesk)).data;
  assert.equal(qrOrder.settlement, 'room_posted');
  assert.equal(qrOrder.kots.length, 2); // Beverages + Kitchen stations
  assert.equal(qrOrder.total_paise, Math.round((12000 + 18000) * 1.05));
  folio = (await call('GET', `/api/folios/${stay.folio_id}`, null, tok.reception)).data;
  assert.equal(folio.totals.total_paise, before + qrOrder.total_paise);
  let kds = (await call('GET', '/api/kitchen/kots', null, tok.kitchen)).data;
  assert.equal(kds.kots.filter((k) => k.order_id === qrOrder.id).length, 2);
  assert.equal(kds.awaiting_acceptance.length, 0);
  // Front desk removes one item (kitchen can't make it): only that charge leaves the bill
  const parathaItem = qrOrder.items.find((i) => i.name === paratha.name);
  assert.equal((await call('POST', `/api/orders/${qrOrder.id}/items/${parathaItem.id}/cancel`, { reason: 'no curd' }, tok.kitchen)).status, 403);
  res = await call('POST', `/api/orders/${qrOrder.id}/items/${parathaItem.id}/cancel`, { reason: 'no curd' }, tok.frontdesk);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  folio = (await call('GET', `/api/folios/${stay.folio_id}`, null, tok.reception)).data;
  assert.equal(folio.totals.total_paise, before + Math.round(12000 * 1.05));
  // Each station marks its ticket delivered; the order is delivered when both are
  const [k1, k2] = qrOrder.kots;
  await call('PATCH', `/api/kots/${k1.id}`, { status: 'delivered' }, tok.kitchen);
  assert.equal((await call('GET', `/api/orders/${qrOrder.id}`, null, tok.frontdesk)).data.status, 'accepted');
  await call('PATCH', `/api/kots/${k2.id}`, { status: 'delivered' }, tok.kitchen);
  assert.equal((await call('GET', `/api/orders/${qrOrder.id}`, null, tok.frontdesk)).data.status, 'delivered');

  // A second QR order is cancelled by the front desk: charge comes off, kitchen is told to stop
  res = await call('POST', `/api/portal/${r101.qr_token}/orders`, { items: [{ menu_item_id: chai.id, quantity: 4 }] });
  assert.equal(res.status, 201);
  const qr2 = res.data;
  assert.equal((await call('POST', `/api/orders/${qr2.id}/cancel`, { reason: 'kitchen closed' }, tok.kitchen)).status, 403);
  res = await call('POST', `/api/orders/${qr2.id}/cancel`, { reason: 'kitchen closed' }, tok.frontdesk);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  folio = (await call('GET', `/api/folios/${stay.folio_id}`, null, tok.reception)).data;
  assert.equal(folio.totals.total_paise, before + Math.round(12000 * 1.05));
  kds = (await call('GET', '/api/kitchen/kots', null, tok.kitchen)).data;
  assert.equal(kds.kots.some((k) => k.order_id === qr2.id), false);
  assert.ok(kds.cancelled.some((k) => k.order_no === qr2.order_no));

  // Front desk and kitchen are kept out of owner-only areas
  assert.equal((await call('GET', '/api/staff', null, tok.frontdesk)).status, 403);
  assert.equal((await call('GET', '/api/reports/daily', null, tok.frontdesk)).status, 403);
  assert.equal((await call('GET', '/api/hotel/audit', null, tok.frontdesk)).status, 403);
  assert.equal((await call('GET', '/api/bookings', null, tok.kitchen)).status, 403);
  assert.equal((await call('POST', '/api/orders', { order_type: 'takeaway', items: [{ menu_item_id: chai.id, quantity: 1 }] }, tok.kitchen)).status, 403);
  assert.equal((await call('POST', '/api/staff', { name: 'Old Role', email: 'old@x.in', password: 'Password1', role: 'manager' }, tok.owner)).status, 400);

  // Discount + void are audited, front desk cannot void
  res = await call('POST', `/api/folios/${stay.folio_id}/discount`, { percent: 10, apply_to: 'room', reason: 'Repeat guest' }, tok.owner);
  assert.equal(res.status, 201, JSON.stringify(res.data));
  folio = (await call('GET', `/api/folios/${stay.folio_id}`, null, tok.owner)).data;
  const anyLine = folio.lines.find((l) => l.category === 'food' || l.category === 'room_service');
  assert.equal((await call('POST', `/api/folios/${stay.folio_id}/lines/${anyLine.id}/void`, { reason: 'test' }, tok.reception)).status, 403);

  // A QR order the kitchen never marks delivered: it is on the bill, and checkout must close it
  res = await call('POST', `/api/portal/${r101.qr_token}/orders`, { items: [{ menu_item_id: chai.id, quantity: 1 }] });
  assert.equal(res.status, 201);
  const qrOpen = res.data;

  // Checkout: early departure (stay was 2 nights; leaving today = 1 night). Balance must be paid.
  res = await call('POST', `/api/stays/${stay.id}/checkout`, {}, tok.reception);
  assert.equal(res.status, 409);
  const balance = res.data.details.balance_paise;
  assert.ok(balance > 0);
  res = await call('POST', `/api/folios/${stay.folio_id}/payments`, { method: 'upi', amount_paise: balance, reference: 'UPI-REF-1' }, tok.reception);
  assert.equal(res.status, 201);
  res = await call('POST', `/api/stays/${stay.id}/checkout`, {}, tok.reception);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.ok(res.data.invoice.invoice_no);
  assert.equal(res.data.folio.totals.balance_paise, 0);
  assert.deepEqual(res.data.closed_orders, [qrOpen.order_no]);
  assert.equal((await call('GET', `/api/orders/${qrOpen.id}`, null, tok.frontdesk)).data.status, 'delivered');
  const active = (await call('GET', '/api/orders?active=1', null, tok.frontdesk)).data;
  assert.equal(active.some((o) => o.id === qrOpen.id), false);
  kds = (await call('GET', '/api/kitchen/kots', null, tok.kitchen)).data;
  assert.equal(kds.kots.some((k) => k.order_id === qrOpen.id), false);

  // Closed folio: no more charges
  res = await call('POST', `/api/folios/${stay.folio_id}/charges`, { description: 'Laundry', unit_price_paise: 10000 }, tok.reception);
  assert.equal(res.status, 409);

  // Room is dirty with a checkout HK task; cleaning it makes it ready
  const board = (await call('GET', '/api/housekeeping/board', null, tok.hk)).data;
  const task = board.tasks.find((t) => t.room_id === r101.id && t.trigger === 'checkout' && t.status === 'pending');
  assert.ok(task);
  assert.equal(board.rooms.find((r) => r.id === r101.id).hk_status, 'dirty');
  await call('PATCH', `/api/housekeeping/tasks/${task.id}`, { action: 'start' }, tok.hk);
  await call('PATCH', `/api/housekeeping/tasks/${task.id}`, { action: 'complete' }, tok.hk);
  const after = (await call('GET', '/api/rooms/board', null, tok.reception)).data.find((r) => r.id === r101.id);
  assert.equal(after.hk_status, 'ready');

  // Invoice data has GST breakup
  const inv = (await call('GET', `/api/folios/${stay.folio_id}/invoice`, null, tok.owner)).data;
  assert.equal(inv.type, 'TAX INVOICE');
  assert.ok(inv.tax_breakup.length >= 1);

  // Owner dashboard & alerts & summary
  const dash = (await call('GET', '/api/reports/dashboard', null, tok.owner)).data;
  assert.ok(dash.revenue_today.room >= 0);
  assert.equal((await call('GET', '/api/alerts', null, tok.owner)).status, 200);
  const summary = (await call('GET', '/api/summary/daily', null, tok.owner)).data;
  assert.match(summary.text, /Occupancy/);
  const daily = await call('GET', `/api/reports/daily?from=${addDays(today, -2)}&to=${today}&format=csv`, null, tok.owner);
  assert.match(daily.data, /occupancy_pct/);

  // Audit trail recorded
  const auditRows = (await call('GET', `/api/hotel/audit?entity_type=folio&entity_id=${stay.folio_id}`, null, tok.owner)).data;
  assert.ok(auditRows.some((a) => a.action === 'folio.discount'));
});

test('walk-in restaurant bill with split payment', async () => {
  const menu = (await call('GET', '/api/menu', null, tok.restaurant)).data;
  const chai = menu.items.find((i) => i.name === 'Masala Chai');
  const o = (await call('POST', '/api/orders', { order_type: 'dine_in', table_label: 'T4', items: [{ menu_item_id: chai.id, quantity: 3 }] }, tok.restaurant)).data;
  assert.equal(o.total_paise, 18000 + 900);
  let res = await call('POST', `/api/orders/${o.id}/settle`, { mode: 'pay', payments: [{ method: 'cash', amount_paise: 10000 }] }, tok.restaurant);
  assert.equal(res.status, 400);
  res = await call('POST', `/api/orders/${o.id}/settle`, {
    mode: 'pay', payments: [{ method: 'cash', amount_paise: 10000 }, { method: 'upi', amount_paise: 8900 }],
  }, tok.restaurant);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.ok(res.data.invoice_no);
});

test('online booking request → confirm, and overbooking guard', async () => {
  const pub = (await call('GET', '/api/public/hotels/demo-hotel')).data;
  const suite = pub.room_types.find((t) => t.name === 'Suite');
  const from = addDays(today, 10); const to = addDays(today, 12);
  let res = await call('POST', '/api/public/hotels/demo-hotel/booking-requests', {
    full_name: 'Online Guest', phone: '9876500000', room_type_id: suite.id, rooms: 2, check_in_date: from, check_out_date: to,
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const list = (await call('GET', '/api/bookings?status=requested', null, tok.reception)).data;
  const bk = list.find((b) => b.ref === res.data.ref);
  res = await call('POST', `/api/bookings/${bk.id}/confirm`, {}, tok.reception);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  // Both suites now taken for those dates (unallocated) → a third suite booking must fail
  res = await call('POST', '/api/bookings', {
    guest: { full_name: 'Late Guest', phone: '9111111111' },
    stays: [{ room_type_id: suite.id, check_in_date: from, check_out_date: to }],
  }, tok.reception);
  assert.equal(res.status, 409);
  await call('POST', `/api/bookings/${bk.id}/cancel`, { reason: 'test cleanup' }, tok.owner);
});

test('platform onboarding and plan limits', async () => {
  const p = (await call('POST', '/api/platform/auth/login', { email: 'admin@wayinn.app', password: 'Wayinn@123' })).data;
  const plans = (await call('GET', '/api/platform/plans', null, p.token)).data;
  const slug = `test-${Date.now()}`;
  let res = await call('POST', '/api/platform/hotels', {
    name: 'Test Inn', slug, plan_id: plans.find((x) => x.code === 'starter').id,
    owner: { name: 'T Owner', email: `${slug}@x.in`, password: 'Password1' },
  }, p.token);
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const ownerTok = (await call('POST', '/api/auth/login', { email: `${slug}@x.in`, password: 'Password1' })).data.token;
  const rt = (await call('POST', '/api/room-types', { name: 'Std', base_rate_paise: 100000 }, ownerTok)).data;
  res = await call('POST', '/api/rooms/bulk', { room_type_id: rt.id, from: 1, to: 16 }, ownerTok);
  assert.equal(res.status, 400); // starter = 15 rooms
  // Tenant isolation: this owner cannot read demo hotel's booking
  const demoBooking = (await pool.query(`SELECT id FROM bookings WHERE hotel_id = 1 LIMIT 1`)).rows[0];
  assert.equal((await call('GET', `/api/bookings/${demoBooking.id}`, null, ownerTok)).status, 404);
  // Suspension blocks the hotel
  await call('PATCH', `/api/platform/hotels/${res.data?.hotel?.id ?? (await pool.query('SELECT id FROM hotels WHERE slug=$1', [slug])).rows[0].id}`, { subscription_status: 'suspended' }, p.token);
  assert.equal((await call('GET', '/api/auth/me', null, ownerTok)).status, 402);
});


test('GST state code follows the GSTIN', async () => {
  let res = await call('PUT', '/api/hotel', { gstin: '03ABCDE1234F1Z5', state_code: '' }, tok.owner);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.state_code, '03');
  res = await call('PUT', '/api/hotel', { state_code: '07' }, tok.owner);
  assert.equal(res.status, 400);
  res = await call('PUT', '/api/hotel', { state_code: '3' }, tok.owner);
  assert.equal(res.status, 200);
  assert.equal(res.data.state_code, '03');
});

test('dashboard revenue: breakdown adds up and ignores guests not yet checked in', async () => {
  const before = (await call('GET', '/api/reports/dashboard', null, tok.owner)).data.revenue_today;
  const t = before;
  assert.equal(t.total, t.room + t.food + t.other + t.discount);
  const rooms = (await call('GET', '/api/rooms', null, tok.owner)).data;
  const r = rooms.find((x) => x.number === '102');
  let res = await call('POST', '/api/bookings', {
    guest: { full_name: 'Future Guest', phone: '9222222222' },
    stays: [{ room_type_id: r.room_type_id, check_in_date: today, check_out_date: addDays(today, 1) }],
  }, tok.frontdesk);
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const stay = res.data.stays[0];
  res = await call('POST', `/api/folios/${stay.folio_id}/charges`, { description: 'Airport pickup', unit_price_paise: 50000 }, tok.frontdesk);
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const after = (await call('GET', '/api/reports/dashboard', null, tok.owner)).data.revenue_today;
  assert.equal(after.total, before.total, 'charge on a not-checked-in booking must not count as revenue yet');
  await call('POST', `/api/bookings/${res.data?.booking_id || stay.booking_id}/cancel`, { reason: 'test cleanup' }, tok.owner);
});

test('month revenue breakdown adds up, and a reservation is not in "balance pending"', async () => {
  const m = (await call('GET', '/api/reports/dashboard', null, tok.owner)).data.revenue_month;
  assert.equal(m.total, m.room + m.food + m.other + m.discount);
  const rooms = (await call('GET', '/api/rooms', null, tok.owner)).data;
  const r = rooms.find((x) => x.number === '102');
  let res = await call('POST', '/api/bookings', {
    guest: { full_name: 'Not Arrived', phone: '9333333333' },
    stays: [{ room_type_id: r.room_type_id, check_in_date: addDays(today, 3), check_out_date: addDays(today, 4) }],
  }, tok.frontdesk);
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const stay = res.data.stays[0];
  res = await call('POST', `/api/folios/${stay.folio_id}/charges`, { description: 'Cake order', unit_price_paise: 115700 }, tok.frontdesk);
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const pending = (await call('GET', '/api/folios?outstanding=1', null, tok.owner)).data;
  assert.ok(!pending.some((f) => f.id === stay.folio_id), 'bill of a guest not checked in must not be in balance pending');
  const open = (await call('GET', '/api/folios?status=open', null, tok.owner)).data;
  assert.ok(open.some((f) => f.id === stay.folio_id), 'it is still listed with open bills');
  await call('POST', `/api/bookings/${stay.booking_id}/cancel`, { reason: 'test cleanup' }, tok.owner);
});

test('edit and delete: staff, rooms, room types, menu, tasks, guests', async () => {
  // Staff: a fresh account can be deleted; one with work on record cannot; nobody deletes themselves
  let res = await call('POST', '/api/staff', { name: 'Temp Desk', email: `temp.${Date.now()}@demo-hotel.in`, password: 'Wayinn@123', role: 'front_desk' }, tok.owner);
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal((await call('DELETE', `/api/staff/${res.data.id}`, null, tok.owner)).status, 200);
  const fd = (await pool.query(`SELECT id FROM users WHERE email = 'frontdesk@demo-hotel.in'`)).rows[0];
  res = await call('DELETE', `/api/staff/${fd.id}`, null, tok.owner);
  assert.equal(res.status, 409, JSON.stringify(res.data));
  assert.match(res.data.error, /Account active/);
  const me = (await pool.query(`SELECT id FROM users WHERE email = 'owner@demo-hotel.in'`)).rows[0];
  assert.equal((await call('DELETE', `/api/staff/${me.id}`, null, tok.owner)).status, 400);
  assert.equal((await call('DELETE', `/api/staff/${me.id}`, null, tok.frontdesk)).status, 403);

  // Room type + room: edit number/type, delete unused, refuse used
  const rt = (await call('POST', '/api/room-types', { name: 'Temp Type', base_rate_paise: 100000 }, tok.owner)).data;
  const room = (await call('POST', '/api/rooms', { number: `T${Date.now() % 100000}`, room_type_id: rt.id }, tok.owner)).data;
  res = await call('PUT', `/api/rooms/${room.id}`, { number: `${room.number}A`, floor: '9' }, tok.owner);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.number, `${room.number}A`);
  assert.equal((await call('DELETE', `/api/room-types/${rt.id}`, null, tok.owner)).status, 409); // room still uses it
  assert.equal((await call('DELETE', `/api/rooms/${room.id}`, null, tok.owner)).status, 200);
  assert.equal((await call('DELETE', `/api/room-types/${rt.id}`, null, tok.owner)).status, 200);
  const r101 = (await call('GET', '/api/rooms', null, tok.owner)).data.find((x) => x.number === '101');
  res = await call('DELETE', `/api/rooms/${r101.id}`, null, tok.owner);
  assert.equal(res.status, 409, 'a room with bookings cannot be deleted');
  assert.equal((await call('DELETE', `/api/rooms/${r101.id}`, null, tok.frontdesk)).status, 403);

  // Menu: item that was ordered can be deleted (orders keep their copy); category/station only when empty
  const menu = (await call('GET', '/api/menu', null, tok.owner)).data;
  const cat = (await call('POST', '/api/menu/categories', { name: 'Temp Cat' }, tok.owner)).data;
  const st = (await call('POST', '/api/stations', { name: 'Temp Station' }, tok.owner)).data;
  const item = (await call('POST', '/api/menu/items', { name: 'Temp Lassi', price_paise: 5000, category_id: cat.id, station_id: st.id }, tok.owner)).data;
  res = await call('POST', '/api/orders', { order_type: 'takeaway', items: [{ menu_item_id: item.id, quantity: 1 }] }, tok.frontdesk);
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const order = res.data;
  assert.equal((await call('DELETE', `/api/menu/items/${item.id}`, null, tok.owner)).status, 409, 'item in an open order');
  assert.equal((await call('DELETE', `/api/menu/categories/${cat.id}`, null, tok.owner)).status, 409);
  assert.equal((await call('DELETE', `/api/stations/${st.id}`, null, tok.owner)).status, 409);
  await call('POST', `/api/orders/${order.id}/cancel`, { reason: 'test cleanup' }, tok.owner);
  assert.equal((await call('DELETE', `/api/menu/items/${item.id}`, null, tok.owner)).status, 200);
  const kept = (await call('GET', `/api/orders/${order.id}`, null, tok.owner)).data;
  assert.equal(kept.items[0].name, 'Temp Lassi');
  assert.equal((await call('DELETE', `/api/menu/categories/${cat.id}`, null, tok.owner)).status, 200);
  assert.equal((await call('DELETE', `/api/stations/${st.id}`, null, tok.owner)).status, 200);
  assert.ok(menu.items.length > 0);

  // Housekeeping task: edit, delete pending, cancel in-progress (room back to dirty), done is kept
  const r102 = (await call('GET', '/api/rooms', null, tok.owner)).data.find((x) => x.number === '102');
  let t = (await call('POST', '/api/housekeeping/tasks', { room_id: r102.id, task_type: 'cleaning' }, tok.frontdesk)).data;
  res = await call('PATCH', `/api/housekeeping/tasks/${t.id}`, { action: 'update', priority: 'urgent', task_type: 'deep_clean', notes: 'Carpet' }, tok.frontdesk);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.priority, 'urgent');
  assert.equal(res.data.task_type, 'deep_clean');
  assert.equal((await call('DELETE', `/api/housekeeping/tasks/${t.id}`, null, tok.frontdesk)).status, 200);
  await pool.query(`UPDATE rooms SET hk_status = 'dirty' WHERE id = $1`, [r102.id]);
  t = (await call('POST', '/api/housekeeping/tasks', { room_id: r102.id, task_type: 'cleaning' }, tok.frontdesk)).data;
  await call('PATCH', `/api/housekeeping/tasks/${t.id}`, { action: 'start' }, tok.frontdesk);
  assert.equal((await call('DELETE', `/api/housekeeping/tasks/${t.id}`, null, tok.frontdesk)).status, 409);
  assert.equal((await call('PATCH', `/api/housekeeping/tasks/${t.id}`, { action: 'cancel' }, tok.frontdesk)).status, 200);
  assert.equal((await pool.query('SELECT hk_status FROM rooms WHERE id = $1', [r102.id])).rows[0].hk_status, 'dirty');
  await pool.query(`UPDATE rooms SET hk_status = 'ready' WHERE id = $1`, [r102.id]);

  // Guests: delete a guest without bookings; merge a duplicate (bookings move, blanks filled)
  const lone = (await call('POST', '/api/guests', { full_name: 'Lone Guest', phone: '9444444444' }, tok.owner)).data;
  assert.equal((await call('DELETE', `/api/guests/${lone.id}`, null, tok.owner)).status, 200);
  res = await call('POST', '/api/bookings', {
    guest: { full_name: 'Dup Guest', phone: '9555555555', email: 'dup@x.in' },
    stays: [{ room_type_id: r102.room_type_id, check_in_date: addDays(today, 5), check_out_date: addDays(today, 6) }],
  }, tok.frontdesk);
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const dupBooking = res.data;
  assert.equal((await call('DELETE', `/api/guests/${dupBooking.guest_id}`, null, tok.owner)).status, 409);
  const keep = (await call('POST', '/api/guests', { full_name: 'Dup Guest', phone: '9555555555' }, tok.owner)).data;
  res = await call('POST', `/api/guests/${dupBooking.guest_id}/merge`, { into_guest_id: keep.id }, tok.owner);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.email, 'dup@x.in');
  assert.equal((await call('GET', `/api/bookings/${dupBooking.id}`, null, tok.owner)).data.guest_id, keep.id);
  assert.equal((await call('GET', `/api/guests/${dupBooking.guest_id}`, null, tok.owner)).status, 404);
  assert.equal((await call('POST', `/api/guests/${keep.id}/merge`, { into_guest_id: keep.id }, tok.owner)).status, 400);
  await call('POST', `/api/bookings/${dupBooking.id}/cancel`, { reason: 'test cleanup' }, tok.owner);
});

test('super admin: edit hotel, delete plan and hotel safely', async () => {
  const p = (await call('POST', '/api/platform/auth/login', { email: 'admin@wayinn.app', password: 'Wayinn@123' })).data;
  const plan = (await call('POST', '/api/platform/plans', { code: `tmp${Date.now() % 100000}`, name: 'Temp plan', max_rooms: 5, price_monthly_paise: 0 }, p.token)).data;
  const slug = `del-${Date.now()}`;
  let res = await call('POST', '/api/platform/hotels', { name: 'Delete Me Inn', slug, plan_id: plan.id, owner: { name: 'D Owner', email: `${slug}@x.in`, password: 'Password1' } }, p.token);
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const hid = res.data.hotel.id;
  res = await call('PATCH', `/api/platform/hotels/${hid}`, { name: 'Delete Me Hotel', city: 'Ludhiana', phone: '9000011111' }, p.token);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.city, 'Ludhiana');
  // Give the hotel some data so the cascade is exercised
  const ownerTok = (await call('POST', '/api/auth/login', { email: `${slug}@x.in`, password: 'Password1' })).data.token;
  const rt = (await call('POST', '/api/room-types', { name: 'Std', base_rate_paise: 100000 }, ownerTok)).data;
  const room = (await call('POST', '/api/rooms', { number: '1', room_type_id: rt.id }, ownerTok)).data;
  res = await call('POST', '/api/bookings', { guest: { full_name: 'G', phone: '9666666666' }, stays: [{ room_type_id: rt.id, room_id: room.id, check_in_date: today, check_out_date: addDays(today, 1) }] }, ownerTok);
  assert.equal(res.status, 201, JSON.stringify(res.data));

  assert.equal((await call('DELETE', `/api/platform/plans/${plan.id}`, null, p.token)).status, 409, 'plan in use');
  assert.equal((await call('DELETE', `/api/platform/hotels/${hid}`, { confirm: slug }, p.token)).status, 409, 'must be cancelled first');
  await call('PATCH', `/api/platform/hotels/${hid}`, { subscription_status: 'cancelled' }, p.token);
  assert.equal((await call('DELETE', `/api/platform/hotels/${hid}`, { confirm: 'wrong' }, p.token)).status, 400);
  res = await call('DELETE', `/api/platform/hotels/${hid}`, { confirm: slug }, p.token);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM hotels WHERE id = $1', [hid])).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM bookings WHERE hotel_id = $1', [hid])).rows[0].n, 0);
  assert.equal((await call('DELETE', `/api/platform/plans/${plan.id}`, null, p.token)).status, 200);
  // Hotel staff cannot use super-admin deletes
  assert.equal((await call('DELETE', `/api/platform/plans/${plan.id}`, null, tok.owner)).status, 401);
});

test('guest stay count and last stay ignore cancelled and future bookings', async () => {
  const rooms = (await call('GET', '/api/rooms', null, tok.owner)).data;
  const r = rooms.find((x) => x.number === '102');
  const phone = `98${Date.now() % 100000000}`;
  let res = await call('POST', '/api/bookings', {
    guest: { full_name: 'Count Check', phone },
    stays: [{ room_type_id: r.room_type_id, check_in_date: addDays(today, 10), check_out_date: addDays(today, 11) }],
  }, tok.frontdesk);
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const gid = res.data.guest_id;
  await call('POST', `/api/bookings/${res.data.id}/cancel`, { reason: 'test' }, tok.owner);
  res = await call('POST', '/api/bookings', {
    guest_id: gid, stays: [{ room_type_id: r.room_type_id, check_in_date: addDays(today, 20), check_out_date: addDays(today, 21) }],
  }, tok.frontdesk);
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const listed = (await call('GET', `/api/guests?q=${phone}`, null, tok.owner)).data.find((g) => g.id === gid);
  assert.equal(listed.stay_count, 0);
  assert.equal(listed.last_stay, null);
  const profile = (await call('GET', `/api/guests/${gid}`, null, tok.owner)).data;
  assert.equal(profile.stay_count, 0, 'profile and list must agree');
  assert.equal(profile.stays.length, 2, 'both bookings are still listed in the history');
  await call('POST', `/api/bookings/${res.data.id}/cancel`, { reason: 'test cleanup' }, tok.owner);
});

test('plans list says how many hotels use each plan', async () => {
  const p = (await call('POST', '/api/platform/auth/login', { email: 'admin@wayinn.app', password: 'Wayinn@123' })).data;
  const plans = (await call('GET', '/api/platform/plans', null, p.token)).data;
  const used = (await pool.query('SELECT plan_id, count(*)::int AS n FROM hotels WHERE plan_id IS NOT NULL GROUP BY plan_id')).rows;
  for (const pl of plans) assert.equal(pl.hotel_count, used.find((u) => Number(u.plan_id) === Number(pl.id))?.n || 0);
});

test('cancel / no-show before check-in: undelivered charges are voided, only the fee counts', async () => {
  const rooms = (await call('GET', '/api/rooms', null, tok.owner)).data;
  const r = rooms.find((x) => x.number === '102');
  const dash = async () => (await call('GET', '/api/reports/dashboard', null, tok.owner)).data;
  const book = async (name, from) => {
    const res = await call('POST', '/api/bookings', {
      guest: { full_name: name, phone: `97${Date.now() % 100000000}` },
      stays: [{ room_type_id: r.room_type_id, check_in_date: from, check_out_date: addDays(from, 1) }],
    }, tok.frontdesk);
    assert.equal(res.status, 201, JSON.stringify(res.data));
    const st = res.data.stays[0];
    for (const [d, p] of [['Laundry', 20000], ['Food', 100000]]) {
      const c = await call('POST', `/api/folios/${st.folio_id}/charges`, { description: d, unit_price_paise: p }, tok.frontdesk);
      assert.equal(c.status, 201, JSON.stringify(c.data));
    }
    return res.data;
  };
  const liveLines = async (folioId) => (await call('GET', `/api/folios/${folioId}`, null, tok.owner)).data.lines.filter((l) => !l.voided_at);

  // 1) Whole booking cancelled, with a cancellation fee
  let before = await dash();
  const b1 = await book('Cancel Charges', addDays(today, 2));
  let res = await call('POST', `/api/bookings/${b1.id}/cancel`, { reason: 'guest called', cancellation_fee_paise: 50000 }, tok.owner);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  let lines = await liveLines(b1.stays[0].folio_id);
  assert.deepEqual(lines.map((l) => l.description), ['Cancellation charge'], 'laundry and food are voided, the fee stays');
  let after = await dash();
  assert.equal(after.revenue_month.other - before.revenue_month.other, 50000, 'only the fee is revenue');
  assert.equal(after.revenue_month.food, before.revenue_month.food);
  assert.equal(after.outstanding.folios - before.outstanding.folios, 1);
  assert.equal(after.outstanding.amount_paise - before.outstanding.amount_paise, 50000 + Math.round(50000 * 0.18));

  // 2) Single room cancelled, no fee: nothing left owed or earned
  before = after;
  const b2 = await book('Cancel Room', addDays(today, 3));
  res = await call('POST', `/api/stays/${b2.stays[0].id}/cancel`, { reason: 'changed plans' }, tok.owner);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal((await liveLines(b2.stays[0].folio_id)).length, 0);
  after = await dash();
  assert.equal(after.revenue_month.total, before.revenue_month.total);
  assert.equal(after.outstanding.amount_paise, before.outstanding.amount_paise);

  // 3) No-show with first night charged: only the no-show charge remains
  before = after;
  const b3 = await book('No Show Charges', today);
  res = await call('POST', `/api/stays/${b3.stays[0].id}/no-show`, { charge_first_night: true }, tok.owner);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  lines = await liveLines(b3.stays[0].folio_id);
  assert.deepEqual(lines.map((l) => l.description), ['No-show charge']);
  after = await dash();
  assert.equal(after.revenue_month.food, before.revenue_month.food, 'food that was never served is not revenue');
  const audit = (await pool.query(`SELECT data FROM audit_logs WHERE action = 'stay.no_show' AND entity_id = $1`, [b3.stays[0].id])).rows[0].data;
  assert.equal(audit.voided_charges.lines, 2);
});
