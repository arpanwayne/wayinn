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
  for (const who of ['owner', 'reception', 'kitchen', 'hk', 'restaurant']) tok[who] = await login(`${who}@demo-hotel.in`);
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
  // Kitchen moves KOT to ready → order ready
  await call('PATCH', `/api/kots/${order.kots[0].id}`, { status: 'preparing' }, tok.kitchen);
  await call('PATCH', `/api/kots/${order.kots[0].id}`, { status: 'ready' }, tok.kitchen);
  assert.equal((await call('GET', `/api/orders/${order.id}`, null, tok.restaurant)).data.status, 'ready');
  res = await call('POST', `/api/orders/${order.id}/settle`, { mode: 'room' }, tok.restaurant);
  assert.equal(res.status, 200, JSON.stringify(res.data));

  // Kitchen staff cannot refund or see folios
  res = await call('GET', `/api/folios/${stay.folio_id}`, null, tok.kitchen);
  assert.equal(res.status, 403);

  // Guest QR portal: public view shows no guest data; verify with PIN; order needs acceptance
  res = await call('GET', `/api/portal/${r101.qr_token}`);
  assert.equal(res.data.occupied, true);
  assert.equal(res.data.guest_name, undefined);
  res = await call('POST', `/api/portal/${r101.qr_token}/verify`, { code: '0000' });
  assert.equal(res.status, 401);
  res = await call('POST', `/api/portal/${r101.qr_token}/verify`, { code: pin });
  assert.equal(res.status, 200);
  const guestTok = res.data.token;
  const chai = menu.items.find((i) => i.name === 'Masala Chai');
  res = await call('POST', '/api/guest/orders', { items: [{ menu_item_id: chai.id, quantity: 2 }] }, guestTok);
  assert.equal(res.status, 201);
  assert.equal(res.data.status, 'received');
  const qrOrder = res.data;
  // Guest token can't be used on staff APIs
  assert.equal((await call('GET', '/api/bookings', null, guestTok)).status, 401);
  // Another room's QR shows no stay
  assert.equal((await call('POST', `/api/portal/${r102.qr_token}/verify`, { code: pin })).status, 409);
  // Towel request creates an HK task
  res = await call('POST', `/api/portal/${r101.qr_token}/requests`, { type: 'towels', message: '2 extra towels' });
  assert.equal(res.status, 201);

  // Checkout blocked: unsettled QR order
  await call('PATCH', `/api/orders/${qrOrder.id}/status`, { status: 'accepted' }, tok.restaurant);
  res = await call('POST', `/api/stays/${stay.id}/checkout`, {}, tok.reception);
  assert.equal(res.status, 409);
  await call('POST', `/api/orders/${qrOrder.id}/settle`, { mode: 'room' }, tok.restaurant);

  // Discount + void are audited, receptionist cannot void
  res = await call('POST', `/api/folios/${stay.folio_id}/discount`, { percent: 10, apply_to: 'room', reason: 'Repeat guest' }, tok.owner);
  assert.equal(res.status, 201, JSON.stringify(res.data));
  folio = (await call('GET', `/api/folios/${stay.folio_id}`, null, tok.owner)).data;
  const anyLine = folio.lines.find((l) => l.category === 'food' || l.category === 'room_service');
  assert.equal((await call('POST', `/api/folios/${stay.folio_id}/lines/${anyLine.id}/void`, { reason: 'test' }, tok.reception)).status, 403);

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
