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
