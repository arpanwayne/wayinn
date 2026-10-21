// WhatsApp/SMS/email outbox, checkout staff alert, Razorpay advance payment, channel-manager API, iCal, ESC/POS.
// Outside services are never called: Razorpay and WhatsApp HTTP calls are answered by a fake fetch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { hotelToday, addDays } from '../src/lib/dates.js';
import { processOutbox } from '../src/lib/outbox.js';
import { sendWhatsApp, ProviderError } from '../src/lib/providers.js';
import { normalizePhone, renderText } from '../src/lib/messages.js';
import { kotEscpos } from '../src/lib/escpos.js';

let server, base, platformTok;
const today = hotelToday('Asia/Kolkata');
const tok = {};
const realFetch = globalThis.fetch;
const outside = []; // calls that would have gone to Razorpay / Meta

async function call(method, path, body, token, headers = {}) {
  const res = await realFetch(base + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined || body === null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}
const login = async (email) => (await call('POST', '/api/auth/login', { email, password: 'Wayinn@123' })).data.token;
const settingsBefore = {};

before(async () => {
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  for (const who of ['owner', 'frontdesk', 'kitchen']) tok[who] = await login(`${who}@demo-hotel.in`);
  platformTok = (await call('POST', '/api/platform/auth/login', { email: 'admin@wayinn.app', password: 'Wayinn@123' })).data.token;
  settingsBefore.s = (await pool.query('SELECT settings FROM hotels WHERE id = 1')).rows[0].settings;
  await pool.query(`UPDATE stays SET status = 'cancelled' WHERE hotel_id = 1 AND status IN ('reserved','checked_in','tentative')`);
  await pool.query(`UPDATE orders SET status = 'cancelled' WHERE hotel_id = 1 AND status <> 'cancelled'`);
  await pool.query(`UPDATE rooms SET hk_status = 'ready' WHERE hotel_id = 1`);
  await pool.query(`DELETE FROM notifications_outbox WHERE hotel_id = 1`);
  await pool.query(`DELETE FROM hotel_integrations WHERE hotel_id = 1`);
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith('https://api.razorpay.com/')) {
      const body = JSON.parse(opts.body);
      outside.push({ url: u, body, auth: opts.headers.authorization });
      return new Response(JSON.stringify({ id: `order_${crypto.randomBytes(7).toString('hex')}`, amount: body.amount, currency: 'INR' }), { status: 200 });
    }
    if (u.startsWith('https://graph.facebook.com/')) {
      outside.push({ url: u, body: JSON.parse(opts.body) });
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.TEST' }] }), { status: 200 });
    }
    return realFetch(url, opts);
  };
});
after(async () => {
  globalThis.fetch = realFetch;
  await pool.query('UPDATE hotels SET settings = $1 WHERE id = 1', [JSON.stringify(settingsBefore.s)]);
  await pool.query(`DELETE FROM hotel_integrations WHERE hotel_id = 1`);
  server.close(); await pool.end();
});

test('phone numbers and message text', () => {
  assert.equal(normalizePhone('98765 43210'), '919876543210');
  assert.equal(normalizePhone('+91 98765-43210'), '919876543210');
  assert.equal(normalizePhone('09876543210'), '919876543210');
  assert.equal(normalizePhone('+1 204 555 0101'), '12045550101');
  assert.equal(normalizePhone('12345'), null);
  assert.match(renderText('room_checkout_alert', { room: '101', hotel: 'H', note: 'Clean it.' }), /Room 101 at H has just checked out\. Clean it\./);
});

test('super admin keys are masked; hotel staff only see connected / not connected', async () => {
  let res = await call('PUT', '/api/platform/hotels/1/integrations', {
    whatsapp_phone_number_id: '123456789012', whatsapp_token: 'EAAG-secret-token-9876',
    razorpay_key_id: 'rzp_test_ABC123', razorpay_key_secret: 'rzp-secret-4321', razorpay_webhook_secret: 'hook-secret-5555',
  }, platformTok);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.whatsapp_token, '••••9876');
  assert.equal(res.data.razorpay_key_secret, '••••4321');
  assert.equal(res.data.status.whatsapp, true);
  // Saving the masked value back keeps the real secret
  await call('PUT', '/api/platform/hotels/1/integrations', { whatsapp_token: '••••9876' }, platformTok);
  const row = (await pool.query('SELECT whatsapp_token FROM hotel_integrations WHERE hotel_id = 1')).rows[0];
  assert.equal(row.whatsapp_token, 'EAAG-secret-token-9876');
  // Bad key id format is refused
  res = await call('PUT', '/api/platform/hotels/1/integrations', { razorpay_key_id: 'abc' }, platformTok);
  assert.equal(res.status, 400);
  // Owner view: no secrets anywhere
  res = await call('GET', '/api/hotel/integrations', null, tok.owner);
  assert.equal(res.data.whatsapp, true);
  assert.equal(res.data.razorpay, true);
  assert.ok(!JSON.stringify(res.data).includes('secret'));
  const hotel = await call('GET', '/api/hotel', null, tok.owner);
  assert.ok(!JSON.stringify(hotel.data).includes('EAAG'));
  // Front desk cannot see integrations
  res = await call('GET', '/api/hotel/integrations', null, tok.frontdesk);
  assert.equal(res.status, 403);
  // Test message through Meta's hello_world template
  res = await call('POST', '/api/platform/hotels/1/integrations/test-whatsapp', { to: '9876543210' }, platformTok);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(outside.at(-1).body.template.name, 'hello_world');
  assert.equal(outside.at(-1).body.to, '919876543210');
});

test('WhatsApp request body matches the approved template', async () => {
  let seen;
  const fake = async (url, o) => { seen = { url, body: JSON.parse(o.body), auth: o.headers.authorization }; return new Response('{"messages":[{"id":"wamid.1"}]}'); };
  const out = await sendWhatsApp({ whatsapp_phone_number_id: '555', whatsapp_token: 'TKN', whatsapp_language: 'en' }, '919876543210',
    'booking_confirmation', { guest_name: 'Asha', hotel: 'Demo', ref: 'WB1', check_in: '2026-10-21', check_out: '2026-10-23' }, fake);
  assert.equal(out.ref, 'wamid.1');
  assert.match(seen.url, /\/555\/messages$/);
  assert.equal(seen.auth, 'Bearer TKN');
  assert.equal(seen.body.template.name, 'booking_confirmation');
  assert.deepEqual(seen.body.template.components[0].parameters.map((p) => p.text), ['Asha', 'Demo', 'WB1', '21 Oct 2026', '23 Oct 2026']);
  // A 400 from Meta (e.g. template not approved) is final, a 500 is retried
  const bad = (status) => async () => new Response(JSON.stringify({ error: { message: 'Template not found' } }), { status });
  await assert.rejects(sendWhatsApp({ whatsapp_phone_number_id: '1', whatsapp_token: 't' }, '91', 'booking_confirmation', {}, bad(400)), (e) => e instanceof ProviderError && !e.retry);
  await assert.rejects(sendWhatsApp({ whatsapp_phone_number_id: '1', whatsapp_token: 't' }, '91', 'booking_confirmation', {}, bad(503)), (e) => e.retry);
});

test('guest messages are queued, sent, retried and skipped', async () => {
  // Owner switches on WhatsApp for guests
  let res = await call('PUT', '/api/hotel', { settings: { notifications: { whatsapp: true, sms: false, email: false } } }, tok.owner);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const rooms = (await call('GET', '/api/rooms', null, tok.frontdesk)).data;
  const r = rooms.find((x) => x.number === '201');
  res = await call('POST', '/api/bookings', {
    guest: { full_name: 'Message Guest', phone: '98140 11111' }, source: 'phone',
    stays: [{ room_type_id: r.room_type_id, check_in_date: addDays(today, 3), check_out_date: addDays(today, 4) }],
  }, tok.frontdesk);
  assert.equal(res.status, 201, JSON.stringify(res.data));
  let q = (await pool.query(`SELECT * FROM notifications_outbox WHERE hotel_id = 1 ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.equal(q.template, 'booking_confirmation');
  assert.equal(q.recipient, '919814011111');
  assert.equal(q.status, 'queued');

  // First attempt fails with a temporary error → stays queued with a later retry time
  let out = await processOutbox({ deps: { whatsapp: async () => { throw new ProviderError('timeout', true); } } });
  assert.equal(out.retry, 1);
  q = (await pool.query('SELECT * FROM notifications_outbox WHERE id = $1', [q.id])).rows[0];
  assert.equal(q.status, 'queued');
  assert.equal(q.attempts, 1);
  assert.ok(new Date(q.next_attempt_at) > new Date());
  // Not due yet → nothing picked up
  out = await processOutbox({ deps: { whatsapp: async () => ({ ref: 'x' }) } });
  assert.equal(out.sent, 0);
  // Due again → sent with the real sender (fake Meta)
  await pool.query('UPDATE notifications_outbox SET next_attempt_at = now() WHERE id = $1', [q.id]);
  out = await processOutbox();
  assert.equal(out.sent, 1);
  q = (await pool.query('SELECT * FROM notifications_outbox WHERE id = $1', [q.id])).rows[0];
  assert.equal(q.status, 'sent');
  assert.equal(q.provider_ref, 'wamid.TEST');

  // A permanent error → failed, not retried
  await pool.query(`INSERT INTO notifications_outbox (hotel_id, channel, recipient, template, payload) VALUES (1,'whatsapp','919800000000','checkin_welcome','{}')`);
  out = await processOutbox({ deps: { whatsapp: async () => { throw new ProviderError('Template not approved', false); } } });
  assert.equal(out.failed, 1);

  // A channel without keys → skipped (strict: no shared number)
  await pool.query(`INSERT INTO notifications_outbox (hotel_id, channel, recipient, template, payload) VALUES (1,'sms','919800000000','checkin_welcome','{}')`);
  out = await processOutbox();
  assert.equal(out.skipped, 1);

  // Owner sees the log
  res = await call('GET', '/api/hotel/messages', null, tok.owner);
  assert.deepEqual(new Set(res.data.slice(0, 3).map((m) => m.status)), new Set(['sent', 'failed', 'skipped']));
  await call('POST', `/api/bookings/${(await pool.query(`SELECT booking_id FROM stays s JOIN guests g ON g.id = s.guest_id WHERE g.full_name = 'Message Guest'`)).rows[0].booking_id}/cancel`, { reason: 'test cleanup' }, tok.owner);
});

test('checkout sends a WhatsApp alert to housekeeping / maintenance numbers', async () => {
  let res = await call('PUT', '/api/hotel', { settings: { staff_alert_phones: ['98765 00001', '+91 98765 00002'], staff_alert_channel: 'whatsapp', checkout_alert: true } }, tok.owner);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  res = await call('PUT', '/api/hotel', { settings: { staff_alert_phones: ['not a phone'] } }, tok.owner);
  assert.equal(res.status, 400);
  const rooms = (await call('GET', '/api/rooms', null, tok.frontdesk)).data;
  const r = rooms.find((x) => x.number === '202');
  res = await call('POST', '/api/bookings', {
    guest: { full_name: 'Alert Guest', phone: '9000011111', id_type: 'Aadhaar', id_number: '1111 2222 3333' }, source: 'walk_in', check_in_now: true,
    stays: [{ room_type_id: r.room_type_id, room_id: r.id, check_in_date: today, check_out_date: addDays(today, 1) }],
  }, tok.frontdesk);
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const stay = res.data.stays[0];
  await call('POST', '/api/maintenance', { room_id: r.id, title: 'AC remote missing', priority: 'normal' }, tok.frontdesk);
  await pool.query(`DELETE FROM notifications_outbox WHERE hotel_id = 1`);
  res = await call('POST', `/api/stays/${stay.id}/checkout`, { allow_balance: true }, tok.owner);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.staff_alerted, 2);
  const msgs = (await pool.query(`SELECT * FROM notifications_outbox WHERE hotel_id = 1 AND template = 'room_checkout_alert' ORDER BY recipient`)).rows;
  assert.deepEqual(msgs.map((m) => m.recipient), ['919876500001', '919876500002']);
  assert.equal(msgs[0].audience, 'staff');
  assert.equal(msgs[0].payload.room, '202');
  assert.match(msgs[0].payload.note, /1 open maintenance issue/);
  // Cleaning task is still created as before
  const task = (await pool.query(`SELECT * FROM hk_tasks WHERE room_id = $1 AND trigger = 'checkout' ORDER BY id DESC LIMIT 1`, [r.id])).rows[0];
  assert.equal(task.task_type, 'cleaning');
  await pool.query(`UPDATE maintenance_requests SET status = 'resolved' WHERE room_id = $1`, [r.id]);
});

test('Razorpay advance payment on the booking page', async () => {
  await call('PUT', '/api/platform/hotels/1/integrations', { razorpay_key_id: 'rzp_test_ABC123', razorpay_key_secret: 'rzp-secret-4321', razorpay_webhook_secret: 'hook-secret-5555' }, platformTok);
  await call('PUT', '/api/hotel', { settings: { online_deposit: { mode: 'first_night' }, notifications: { whatsapp: false, sms: false, email: false } } }, tok.owner);
  let pub = (await call('GET', '/api/public/hotels/demo-hotel')).data;
  assert.deepEqual(pub.online_payment, { mode: 'first_night', percent: null });
  const deluxe = pub.room_types.find((t) => t.name === 'Deluxe');
  const from = addDays(today, 20); const to = addDays(today, 22);
  let res = await call('POST', '/api/public/hotels/demo-hotel/booking-requests', {
    full_name: 'Paying Guest', phone: '9811122233', room_type_id: deluxe.id, rooms: 1, adults: 2, check_in_date: from, check_out_date: to,
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const pay = res.data.payment;
  // First night of Deluxe ₹3,800 + 5% GST = ₹3,990
  assert.equal(pay.amount_paise, 399000);
  assert.equal(pay.total_paise, 798000);
  assert.equal(pay.key_id, 'rzp_test_ABC123');
  assert.equal(outside.at(-1).body.amount, 399000);
  assert.equal(outside.at(-1).auth, `Basic ${Buffer.from('rzp_test_ABC123:rzp-secret-4321').toString('base64')}`);
  const ref = res.data.ref;

  // Forged signature is refused
  res = await call('POST', '/api/public/hotels/demo-hotel/payments/verify',
    { razorpay_order_id: pay.order_id, razorpay_payment_id: 'pay_FAKE12345', razorpay_signature: 'deadbeefdeadbeef' });
  assert.equal(res.status, 400);
  // Real signature → paid, deposit on the bill, booking confirmed
  const sig = crypto.createHmac('sha256', 'rzp-secret-4321').update(`${pay.order_id}|pay_OK12345`).digest('hex');
  res = await call('POST', '/api/public/hotels/demo-hotel/payments/verify', { razorpay_order_id: pay.order_id, razorpay_payment_id: 'pay_OK12345', razorpay_signature: sig });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.confirmed, true);
  const bk = (await call('GET', `/api/bookings?q=${ref}`, null, tok.frontdesk)).data[0];
  assert.equal(bk.status, 'confirmed');
  const full = (await call('GET', `/api/bookings/${bk.id}`, null, tok.frontdesk)).data;
  assert.equal(full.stays[0].status, 'reserved');
  assert.equal(full.stays[0].folio_totals.paid_paise, 399000);

  // Webhook for the same payment (e.g. guest closed the page) does not add it twice
  const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_OK12345', order_id: pay.order_id, amount: 399000 } } } });
  const hook = crypto.createHmac('sha256', 'hook-secret-5555').update(body).digest('hex');
  res = await call('POST', '/api/webhooks/razorpay/1', body, null, { 'x-razorpay-signature': hook });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  res = await call('POST', '/api/webhooks/razorpay/1', body, null, { 'x-razorpay-signature': 'bad' });
  assert.equal(res.status, 400);
  const again = (await call('GET', `/api/bookings/${bk.id}`, null, tok.frontdesk)).data;
  assert.equal(again.stays[0].folio_totals.paid_paise, 399000);

  // Webhook alone (no browser callback) also works
  res = await call('POST', '/api/public/hotels/demo-hotel/booking-requests', {
    full_name: 'Webhook Guest', phone: '9811122244', room_type_id: deluxe.id, rooms: 1, adults: 2, check_in_date: from, check_out_date: to,
  });
  const pay2 = res.data.payment;
  const body2 = JSON.stringify({ event: 'order.paid', payload: { payment: { entity: { id: 'pay_WH999', order_id: pay2.order_id, amount: pay2.amount_paise } } } });
  res = await call('POST', '/api/webhooks/razorpay/1', body2, null, { 'x-razorpay-signature': crypto.createHmac('sha256', 'hook-secret-5555').update(body2).digest('hex') });
  assert.equal(res.status, 200);
  const bk2 = (await call('GET', `/api/bookings?q=Webhook Guest`, null, tok.frontdesk)).data[0];
  assert.equal(bk2.status, 'confirmed');

  // Owner switches it off → no payment step
  await call('PUT', '/api/hotel', { settings: { online_deposit: { mode: 'off' } } }, tok.owner);
  pub = (await call('GET', '/api/public/hotels/demo-hotel')).data;
  assert.equal(pub.online_payment, null);
  for (const id of [bk.id, bk2.id]) await call('POST', `/api/bookings/${id}/cancel`, { reason: 'test cleanup' }, tok.owner);
});

test('channel manager API: OTA bookings, changes, cancellations, iCal', async () => {
  // No key → refused
  let res = await call('GET', '/api/channel/v1/room-types');
  assert.equal(res.status, 401);
  res = await call('POST', '/api/hotel/channel-key', {}, tok.frontdesk);
  assert.equal(res.status, 403);
  res = await call('POST', '/api/hotel/channel-key', {}, tok.owner);
  assert.equal(res.status, 201);
  const key = res.data.key;
  const H = { 'x-api-key': key };
  res = await call('GET', '/api/channel/v1/room-types', null, null, H);
  assert.equal(res.status, 200);
  const suite = res.data.find((t) => t.name === 'Suite');
  assert.equal(suite.rooms, 2);

  const from = addDays(today, 40); const to = addDays(today, 42);
  res = await call('GET', `/api/channel/v1/availability?from=${from}&to=${to}`, null, null, H);
  assert.equal(res.data.find((t) => t.room_type_id === suite.id).nights.length, 2);
  assert.equal(res.data.find((t) => t.room_type_id === suite.id).nights[0].available, 2);

  const ext = `MMT-${Date.now()}`; const oyoExt = `OYO-${Date.now()}`;
  const otaBooking = {
    channel: 'makemytrip', external_ref: ext, guest: { full_name: 'OTA Guest', phone: '9822200000' },
    rooms: [{ room_type_id: suite.id, adults: 2, nightly_rate_paise: 900000 }], check_in_date: from, check_out_date: to, paid_to_ota_paise: 500000,
  };
  res = await call('POST', '/api/channel/v1/bookings', otaBooking, null, H);
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.channel, 'makemytrip');
  assert.equal(res.data.status, 'confirmed');
  const id = res.data.id;
  // Same booking pushed twice → not duplicated
  res = await call('POST', '/api/channel/v1/bookings', otaBooking, null, H);
  assert.equal(res.status, 200);
  assert.equal(res.data.id, id);
  assert.equal(res.data.duplicate, true);
  // Shows in the hotel's bookings with source MakeMyTrip, OTA prepaid amount recorded
  const b = (await call('GET', `/api/bookings/${id}`, null, tok.frontdesk)).data;
  assert.equal(b.source, 'makemytrip');
  assert.equal(b.stays[0].nightly_rate_paise, 900000);
  assert.equal(b.stays[0].folio_totals.paid_paise, 500000);
  // Availability went down; overselling the last suite is refused
  res = await call('POST', '/api/channel/v1/bookings', { ...otaBooking, external_ref: `${ext}-2`, rooms: [{ room_type_id: suite.id }, { room_type_id: suite.id }] }, null, H);
  assert.equal(res.status, 409);
  res = await call('POST', '/api/channel/v1/bookings', { ...otaBooking, channel: 'oyo', external_ref: oyoExt }, null, H);
  assert.equal(res.status, 201);
  const oyoId = res.data.id;

  // iCal: both suites taken on those nights → one sold-out block
  await call('POST', '/api/hotel/ical-token', {}, tok.owner);
  const integ = (await call('GET', '/api/hotel/integrations', null, tok.owner)).data;
  const link = integ.ical_links.find((l) => l.room_type === 'Suite').url;
  const path = link.slice(link.indexOf('/api/'));
  res = await call('GET', path);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/calendar/);
  assert.ok(res.data.includes(`DTSTART;VALUE=DATE:${from.replace(/-/g, '')}`), res.data);
  assert.ok(res.data.includes(`DTEND;VALUE=DATE:${to.replace(/-/g, '')}`));
  assert.equal((await call('GET', path.replace(/[a-f0-9]{32}/, '0'.repeat(32)))).status, 404);

  // Date change: one night later
  res = await call('PATCH', `/api/channel/v1/bookings/makemytrip/${ext}`, { check_in_date: addDays(from, 1), check_out_date: addDays(to, 1) }, null, H);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.rooms[0].check_in_date, addDays(from, 1));
  // Cancellation, twice is fine
  res = await call('POST', `/api/channel/v1/bookings/makemytrip/${ext}/cancel`, { reason: 'Guest cancelled on MMT' }, null, H);
  assert.equal(res.data.status, 'cancelled');
  res = await call('POST', `/api/channel/v1/bookings/makemytrip/${ext}/cancel`, {}, null, H);
  assert.equal(res.status, 200);
  await call('POST', `/api/channel/v1/bookings/oyo/${oyoExt}/cancel`, {}, null, H);
  assert.equal((await call('GET', `/api/bookings/${oyoId}`, null, tok.frontdesk)).data.status, 'cancelled');

  // New key stops the old one
  await call('POST', '/api/hotel/channel-key', {}, tok.owner);
  assert.equal((await call('GET', '/api/channel/v1/room-types', null, null, H)).status, 401);
});

test('ESC/POS kitchen ticket for direct USB printing', async () => {
  const bytes = kotEscpos({ kot_no: 'K00001', order_no: 'OR00001', where: 'ROOM 101', time: '10:05', items: [{ quantity: 2, name: 'Dal Makhani', variant: 'Full', notes: 'less spicy' }] });
  assert.deepEqual([...bytes.subarray(0, 2)], [0x1b, 0x40]);
  assert.deepEqual([...bytes.subarray(-4)], [0x1d, 0x56, 0x42, 0x00]);
  assert.ok(bytes.toString('latin1').includes(' 2 x Dal Makhani (Full)'));

  const menu = (await call('GET', '/api/menu', null, tok.frontdesk)).data;
  const chai = menu.items.find((i) => i.name === 'Masala Chai');
  const o = (await call('POST', '/api/orders', { order_type: 'dine_in', table_label: 'T9', items: [{ menu_item_id: chai.id, quantity: 1, notes: 'no sugar' }] }, tok.frontdesk)).data;
  const kot = o.kots[0];
  const res = await realFetch(`${base}/api/kots/${kot.id}/print?format=escpos&width=48`, { headers: { authorization: `Bearer ${tok.kitchen}` } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.ok(buf.toString('latin1').includes('TABLE T9'));
  assert.ok(buf.toString('latin1').includes('* no sugar'));
  await call('POST', `/api/orders/${o.id}/cancel`, { reason: 'test cleanup' }, tok.frontdesk);
});
