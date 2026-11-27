// Rate calendar, Rate Guard (OTA prices → suggestions → WhatsApp / dashboard approval → calendar) and Google Hotels.
// No outside service is called: SerpApi, Meta and Google are answered by a fake fetch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { hotelToday, addDays } from '../src/lib/dates.js';
import { roundRate, suggestRate, preTaxFromInclusive, matchOffers, parseReply, otaKey, withinAutoLimit } from '../src/lib/rateguard/rules.js';
import { parseProperty } from '../src/lib/rateguard/providers/serpapi.js';
import { dueDates, loadConfig, schedulerTick } from '../src/lib/rateguard/engine.js';
import { toRanges, rateAmountXml, availXml, parseResponse, hotelListXml } from '../src/lib/google/xml.js';
import { syncHotel, googleTick } from '../src/lib/google/sync.js';
import { stayEstimate } from '../src/lib/razorpay.js';

let server, base, platformTok, std, dlx, suite;
const tok = {};
const today = hotelToday('Asia/Kolkata');
const realFetch = globalThis.fetch;
const google = []; // messages Google would have received
const whatsapp = []; // free-form WhatsApp replies
const SECRET = 'rg-app-secret';
const PNID = '777000111';
const OWNER_WA = '919811122233';
let settingsBefore;
let googleReply = '<OTA_HotelRateAmountNotifRS><Success/></OTA_HotelRateAmountNotifRS>';

async function call(method, path, body, token, headers = {}) {
  const res = await realFetch(base + path, {
    method, redirect: 'manual',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined || body === null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}
const login = async (email) => (await call('POST', '/api/auth/login', { email, password: 'Wayinn@123' })).data.token;
const hotel = async () => (await pool.query('SELECT * FROM hotels WHERE id = 1')).rows[0];
let n = 0;
const waText = (from, body) => {
  const payload = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: PNID }, contacts: [{ wa_id: from, profile: { name: 'Owner' } }],
    messages: [{ from, id: `wamid.rg${++n}${Date.now()}`, type: 'text', text: { body } }] } }] }] });
  const sig = `sha256=${crypto.createHmac('sha256', SECRET).update(payload).digest('hex')}`;
  return call('POST', '/api/webhooks/whatsapp/1', payload, null, { 'x-hub-signature-256': sig });
};

async function resetRates() {
  for (const t of ['rate_suggestions', 'rate_observations', 'rate_fetch_runs', 'rate_changes', 'rate_calendar', 'rate_guard_rooms', 'rate_guard_config',
    'google_ari_state', 'google_ari_log', 'google_hotels']) await pool.query(`DELETE FROM ${t} WHERE hotel_id = 1`);
}

before(async () => {
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  for (const who of ['owner', 'frontdesk']) tok[who] = await login(`${who}@demo-hotel.in`);
  platformTok = (await call('POST', '/api/platform/auth/login', { email: 'admin@wayinn.app', password: 'Wayinn@123' })).data.token;
  settingsBefore = (await hotel()).settings;
  await pool.query(`UPDATE stays SET status = 'cancelled' WHERE hotel_id = 1 AND status IN ('reserved','checked_in','tentative')`);
  await pool.query(`UPDATE orders SET status = 'cancelled' WHERE hotel_id = 1 AND status <> 'cancelled'`);
  await pool.query(`UPDATE rooms SET hk_status = 'ready' WHERE hotel_id = 1`);
  await pool.query(`DELETE FROM notifications_outbox WHERE hotel_id = 1`);
  await pool.query(`DELETE FROM hotel_integrations WHERE hotel_id = 1`);
  await pool.query(`INSERT INTO hotel_integrations (hotel_id, whatsapp_phone_number_id, whatsapp_token, whatsapp_verify_token, whatsapp_app_secret) VALUES (1,$1,'tok','verify',$2)`, [PNID, SECRET]);
  await resetRates();
  const types = (await pool.query(`SELECT id, code FROM room_types WHERE hotel_id = 1`)).rows;
  std = types.find((t) => t.code === 'STD').id; dlx = types.find((t) => t.code === 'DLX').id; suite = types.find((t) => t.code === 'STE').id;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('https://www.google.com/travel/hotels/uploads/')) {
      google.push({ url: u, body: opts.body });
      return new Response(googleReply, { status: 200 });
    }
    if (u.startsWith('https://graph.facebook.com/')) {
      whatsapp.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.out' }] }), { status: 200 });
    }
    return realFetch(url, opts);
  };
});

after(async () => {
  globalThis.fetch = realFetch;
  delete process.env.GOOGLE_HOTEL_PARTNER_KEY;
  delete process.env.GOOGLE_FEED_TOKEN;
  await resetRates();
  await pool.query(`UPDATE stays SET status = 'cancelled' WHERE hotel_id = 1 AND status IN ('reserved','checked_in','tentative')`);
  await pool.query('UPDATE hotels SET settings = $1 WHERE id = 1', [JSON.stringify(settingsBefore)]);
  await pool.query(`DELETE FROM hotel_integrations WHERE hotel_id = 1`);
  await pool.query(`DELETE FROM notifications_outbox WHERE hotel_id = 1`);
  server.close(); await pool.end();
});

// ---------------------------------------------------------------
// Rules (no database)
// ---------------------------------------------------------------
test('pricing rules: ₹…49 / ₹…99 rounding, GST back-out, plan example', () => {
  assert.equal(roundRate(294500), 294900);
  assert.equal(roundRate(280480), 279900);
  assert.equal(roundRate(294500, '99'), 289900);
  assert.equal(roundRate(294560, 'none'), 294600);
  // ≤ ₹7,500 → 5% GST: ₹3,150 with GST is ₹3,000 before.
  assert.equal(preTaxFromInclusive({ settings: {} }, 315000), 300000);
  // Above the slab: 18%.
  assert.equal(preTaxFromInclusive({ settings: {} }, 1180000), 1000000);
  // Plan: "MakeMyTrip ne 14 Dec ka rate ₹3,100 kiya. Suggested direct rate ₹2,949" (comparing before-GST prices).
  const s = suggestRate({
    currentPaise: 380000, cfg: { undercut_pct: 5, rounding: '49_99', min_change_paise: 5000 }, room: { floor_paise: 200000, ceiling_paise: 600000 },
    offers: [{ ota: 'makemytrip', ota_name: 'MakeMyTrip', rate_paise: 325500, pretax: 310000 }, { ota: 'agoda', ota_name: 'Agoda', rate_paise: 340000, pretax: 330000 }],
  });
  assert.equal(s.suggested_paise, 294900);
  assert.equal(s.ota_name, 'MakeMyTrip');
  assert.equal(s.direction, 'down');
  assert.match(s.reason, /MakeMyTrip/);
  // Floor holds, and tiny changes are ignored.
  assert.equal(suggestRate({ currentPaise: 380000, cfg: { undercut_pct: 5, rounding: '49_99', min_change_paise: 5000 }, room: { floor_paise: 300000, ceiling_paise: 600000 },
    offers: [{ ota_name: 'X', rate_paise: 200000, pretax: 200000 }] }).suggested_paise, 300000);
  assert.equal(suggestRate({ currentPaise: 294900, cfg: { undercut_pct: 5, rounding: '49_99', min_change_paise: 5000 }, room: { floor_paise: 0, ceiling_paise: 900000 },
    offers: [{ ota_name: 'X', rate_paise: 310000, pretax: 310000 }] }), null);
  // Never at or above the OTA after rounding.
  const tight = suggestRate({ currentPaise: 500000, cfg: { undercut_pct: 0, rounding: '49_99', min_change_paise: 0 }, room: { floor_paise: 0, ceiling_paise: 900000 },
    offers: [{ ota_name: 'X', rate_paise: 300000, pretax: 300000 }] });
  assert.ok(tight.suggested_paise < 300000);
  assert.ok(withinAutoLimit(300000, 340000, 15));
  assert.ok(!withinAutoLimit(300000, 350000, 15));
});

test('offer matching, OTA names, WhatsApp replies', () => {
  const offers = [
    { ota_name: 'MakeMyTrip', room_name: 'Deluxe Room', breakfast: null, official: false },
    { ota_name: 'Agoda', room_name: 'Deluxe Room with Breakfast', breakfast: true, refundable: true, official: false },
    { ota_name: 'Hotel site', room_name: 'Deluxe', official: true },
    { ota_name: 'Goibibo', room_name: null, official: false },
  ];
  assert.equal(matchOffers(offers, { match_keywords: 'deluxe', meal_plan: 'any' }).length, 2);
  assert.equal(matchOffers(offers, { match_keywords: 'deluxe', meal_plan: 'breakfast' })[0].ota_name, 'Agoda');
  assert.equal(matchOffers(offers, { match_keywords: 'deluxe', meal_plan: 'room_only' })[0].ota_name, 'MakeMyTrip');
  assert.equal(matchOffers(offers, { match_keywords: '' }).length, 3); // official never
  // Without keywords, rooms that belong to another room type are left out.
  assert.deepEqual(matchOffers(offers, { match_keywords: '' }, ['deluxe', 'suite']).map((o) => o.ota_name), ['Goibibo']);
  assert.equal(otaKey('Booking.com'), 'booking_com');
  assert.equal(otaKey('MakeMyTrip.com'), 'makemytrip');
  assert.equal(otaKey('Anything', true), 'official');
  assert.deepEqual(parseReply('YES k7p2'), { approve: true, target: 'K7P2' });
  assert.deepEqual(parseReply(' haan all '), { approve: true, target: 'ALL' });
  assert.deepEqual(parseReply('no ABCD.'), { approve: false, target: 'ABCD' });
  assert.equal(parseReply('DONE 101'), null);
  assert.equal(parseReply('yes please'), null);
});

test('SerpApi property details are turned into offers', () => {
  const offers = parseProperty({
    featured_prices: [{ source: 'MakeMyTrip', link: 'https://mmt', rate_per_night: { extracted_lowest: 3255, extracted_before_taxes_fees: 3100 },
      rooms: [{ name: 'Deluxe Double Room', rate_per_night: { extracted_lowest: 3255, extracted_before_taxes_fees: 3100 } }] }],
    prices: [{ source: 'Agoda', rate_per_night: { extracted_lowest: 3400 } }, { source: 'Hotel website', official: true, rate_per_night: { extracted_lowest: 3000 } },
      { source: 'MakeMyTrip', link: 'https://mmt', rate_per_night: { extracted_lowest: 3255, extracted_before_taxes_fees: 3100 } }, { source: 'Broken', rate_per_night: {} }],
  });
  assert.equal(offers.length, 4); // room offer + MMT property-level (deduped) + Agoda + official
  const room = offers.find((o) => o.room_name);
  assert.equal(room.rate_paise, 325500);
  assert.equal(room.pretax_paise, 310000);
  assert.ok(offers.find((o) => o.official));
  assert.equal(offers.find((o) => o.ota_name === 'Agoda').pretax_paise, null);
});

test('stay estimate follows each night\'s rate and GST slab', () => {
  const est = stayEstimate({ settings: {} }, { nightly_rate_paise: 500000, nightly_rates: { '2030-01-01': 700000, '2030-01-02': 800000 }, check_in_date: '2030-01-01', check_out_date: '2030-01-03' });
  assert.equal(est.first_night_paise, 735000); // 7,000 + 5%
  assert.equal(est.total_paise, 735000 + 944000); // 8,000 + 18%
});

// ---------------------------------------------------------------
// Rate calendar
// ---------------------------------------------------------------
test('rate calendar: bulk set, weekdays, base rate, permissions, undo', async () => {
  // Front desk can look but not change.
  assert.equal((await call('GET', `/api/rates/calendar?from=${today}&to=${addDays(today, 7)}`, null, tok.frontdesk)).status, 200);
  assert.equal((await call('PUT', '/api/rates/calendar', { room_type_ids: [std], from: today, to: today, rate_paise: 1 }, tok.frontdesk)).status, 403);

  let res = await call('PUT', '/api/rates/calendar', { room_type_ids: [std], from: addDays(today, 1), to: addDays(today, 2), rate_paise: 300000 }, tok.owner);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.changed, 2);
  // Same again: nothing changes, nothing logged.
  assert.equal((await call('PUT', '/api/rates/calendar', { room_type_ids: [std], from: addDays(today, 1), to: addDays(today, 2), rate_paise: 300000 }, tok.owner)).data.changed, 0);
  res = await call('GET', `/api/rates/calendar?from=${today}&to=${addDays(today, 4)}`, null, tok.owner);
  const nights = res.data.room_types.find((t) => t.id === std).nights;
  assert.deepEqual(nights.map((x) => x.rate_paise), [250000, 300000, 300000, 250000]);
  assert.equal(nights[1].overridden, true);
  assert.ok(nights[0].available >= 1);

  // Setting the base rate again removes the override.
  await call('PUT', '/api/rates/calendar', { room_type_ids: [std], from: addDays(today, 2), to: addDays(today, 2), rate_paise: 250000 }, tok.owner);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM rate_calendar WHERE room_type_id = $1', [std])).rows[0].n, 1);

  // Undo the last change of a day; an older change of the same day can only be undone after the newer one.
  const changes = (await call('GET', `/api/rates/changes?room_type_id=${std}`, null, tok.owner)).data;
  const day2 = changes.filter((c) => c.date === addDays(today, 2));
  assert.equal(day2.length, 2);
  const [newer, older] = day2;
  assert.equal(newer.can_undo, true);
  assert.equal(older.can_undo, false);
  assert.equal((await call('POST', `/api/rates/changes/${older.id}/undo`, {}, tok.owner)).status, 409);
  assert.equal((await call('POST', `/api/rates/changes/${newer.id}/undo`, {}, tok.owner)).status, 200);
  const back = (await pool.query('SELECT rate_paise FROM rate_calendar WHERE room_type_id = $1 AND date = $2', [std, addDays(today, 2)])).rows[0];
  assert.equal(back.rate_paise, 300000);

  // Weekday filter + stop-sell + min stay; base rate stays for others.
  res = await call('PUT', '/api/rates/calendar', { room_type_ids: [dlx], from: today, to: addDays(today, 13), weekdays: [6], stop_sell: true }, tok.owner);
  assert.equal(res.data.changed, 2);
  await resetRates();
});

test('bookings are priced night by night from the calendar and billed per night', async () => {
  await call('PUT', '/api/rates/calendar', { room_type_ids: [std], from: today, to: today, rate_paise: 320000 }, tok.owner);
  await call('PUT', '/api/rates/calendar', { room_type_ids: [std], from: addDays(today, 1), to: addDays(today, 1), rate_paise: 280000 }, tok.owner);
  let res = await call('GET', `/api/availability?from=${today}&to=${addDays(today, 3)}`, null, tok.frontdesk);
  const a = res.data.find((t) => t.id === std);
  assert.equal(a.stay_total_paise, 320000 + 280000 + 250000);
  assert.equal(a.rate_paise, Math.round(850000 / 3));
  assert.equal(a.rates_vary, true);

  const room = (await pool.query(`SELECT id FROM rooms WHERE room_type_id = $1 ORDER BY number LIMIT 1`, [std])).rows[0];
  res = await call('POST', '/api/bookings', {
    guest: { full_name: 'Calendar Guest', phone: '9811100001', id_type: 'aadhaar', id_number: '1234' },
    stays: [{ room_type_id: std, room_id: room.id, check_in_date: today, check_out_date: addDays(today, 3), adults: 2 }], check_in_now: true,
  }, tok.frontdesk);
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const stay = res.data.stays[0];
  assert.deepEqual(stay.nightly_rates, { [today]: 320000, [addDays(today, 1)]: 280000, [addDays(today, 2)]: 250000 });
  const lines = (await pool.query(`SELECT business_date::text AS d, amount_paise FROM folio_lines WHERE source_type = 'stay_night' AND source_id = $1 AND voided_at IS NULL`, [stay.id])).rows;
  assert.deepEqual(lines, [{ d: today, amount_paise: 320000 }]);

  // Front desk typing a different rate still needs rates.override.
  res = await call('POST', '/api/bookings', { guest: { full_name: 'Typed Rate' }, stays: [{ room_type_id: std, check_in_date: addDays(today, 5), check_out_date: addDays(today, 6), nightly_rate_paise: 100000 }] }, tok.frontdesk);
  assert.equal(res.status, 403);

  // Extending the stay keeps agreed nights and prices only the new night from the calendar.
  await call('PUT', '/api/rates/calendar', { room_type_ids: [std], from: today, to: addDays(today, 3), rate_paise: 400000 }, tok.owner);
  res = await call('PATCH', `/api/stays/${stay.id}`, { check_out_date: addDays(today, 4) }, tok.frontdesk);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const after = (await pool.query('SELECT nightly_rates, nightly_rate_paise FROM stays WHERE id = $1', [stay.id])).rows[0];
  assert.equal(after.nightly_rates[today], 320000);
  assert.equal(after.nightly_rates[addDays(today, 3)], 400000);
  assert.equal(after.nightly_rate_paise, Math.round((320000 + 280000 + 250000 + 400000) / 4));
  await pool.query(`UPDATE stays SET status = 'cancelled' WHERE hotel_id = 1 AND status IN ('reserved','checked_in','tentative')`);
  await resetRates();
});

test('booking page: calendar prices, stop-sell and minimum stay; Google source', async () => {
  const d1 = addDays(today, 10);
  await call('PUT', '/api/rates/calendar', { room_type_ids: [std], from: d1, to: d1, rate_paise: 199900 }, tok.owner);
  await call('PUT', '/api/rates/calendar', { room_type_ids: [dlx], from: d1, to: d1, stop_sell: true }, tok.owner);
  await call('PUT', '/api/rates/calendar', { room_type_ids: [suite], from: d1, to: d1, min_stay: 2 }, tok.owner);
  const res = await call('GET', `/api/public/hotels/demo-hotel/availability?from=${d1}&to=${addDays(d1, 1)}`, null, null);
  const by = Object.fromEntries(res.data.map((t) => [t.id, t]));
  assert.equal(by[std].rate_paise, 199900);
  assert.equal(by[dlx].available, 0);
  assert.match(by[dlx].closed_reason, /Not available/);
  assert.match(by[suite].closed_reason, /Minimum stay is 2 nights/);
  const two = await call('GET', `/api/public/hotels/demo-hotel/availability?from=${d1}&to=${addDays(d1, 2)}`, null, null);
  assert.equal(two.data.find((t) => t.id === suite).closed_reason, null);

  let bk = await call('POST', '/api/public/hotels/demo-hotel/booking-requests', { full_name: 'Stop Sell', phone: '9811100002', room_type_id: dlx, check_in_date: d1, check_out_date: addDays(d1, 1) }, null);
  assert.equal(bk.status, 409);
  bk = await call('POST', '/api/public/hotels/demo-hotel/booking-requests', { full_name: 'From Google', phone: '9811100003', room_type_id: std, check_in_date: d1, check_out_date: addDays(d1, 1), src: 'google' }, null);
  assert.equal(bk.status, 201, JSON.stringify(bk.data));
  const row = (await pool.query(`SELECT b.source, s.nightly_rate_paise FROM bookings b JOIN stays s ON s.booking_id = b.id WHERE b.ref = $1 AND b.hotel_id = 1`, [bk.data.ref])).rows[0];
  assert.deepEqual(row, { source: 'google', nightly_rate_paise: 199900 });
  await pool.query(`UPDATE stays SET status = 'cancelled' WHERE hotel_id = 1 AND status IN ('reserved','checked_in','tentative')`);
  await resetRates();
});

test('channel manager API gives date-wise rates and restrictions', async () => {
  const key = (await call('POST', '/api/hotel/channel-key', {}, tok.owner)).data.key;
  await call('PUT', '/api/rates/calendar', { room_type_ids: [std], from: addDays(today, 1), to: addDays(today, 1), rate_paise: 275000, min_stay: 2 }, tok.owner);
  const res = await call('GET', `/api/channel/v1/rates?from=${today}&to=${addDays(today, 3)}`, null, null, { 'x-api-key': key });
  assert.equal(res.status, 200);
  const nights = res.data.find((t) => t.room_type_id === std).nights;
  assert.equal(nights[0].rate_paise, 250000);
  assert.equal(nights[1].rate_paise, 275000);
  assert.equal(nights[1].min_stay, 2);
  assert.equal(nights[1].stop_sell, false);
  // An OTA booking without a price is charged the calendar rates.
  const bk = await call('POST', '/api/channel/v1/bookings', { channel: 'makemytrip', external_ref: `MMT-RG-${Date.now()}`, guest: { full_name: 'OTA Guest' },
    rooms: [{ room_type_id: std, adults: 2 }], check_in_date: today, check_out_date: addDays(today, 2) }, null, { 'x-api-key': key });
  assert.equal(bk.status, 201, JSON.stringify(bk.data));
  assert.equal(bk.data.rooms[0].nightly_rate_paise, Math.round((250000 + 275000) / 2));
  await pool.query(`UPDATE stays SET status = 'cancelled' WHERE hotel_id = 1 AND status IN ('reserved','checked_in','tentative')`);
  await resetRates();
});

// ---------------------------------------------------------------
// Rate Guard
// ---------------------------------------------------------------
test('Rate Guard needs the add-on, which only the super admin can switch on', async () => {
  assert.equal((await call('PUT', '/api/rate-guard/config', { enabled: true }, tok.owner)).status, 402);
  assert.equal((await call('GET', '/api/rate-guard', null, tok.frontdesk)).status, 403);
  // The hotel cannot sneak the add-on in through its own settings.
  await call('PUT', '/api/hotel', { settings: { addons: { rate_guard: true } } }, tok.owner);
  assert.notEqual((await hotel()).settings?.addons?.rate_guard, true);
  const res = await call('PATCH', '/api/platform/hotels/1/addons', { rate_guard: true }, platformTok);
  assert.equal(res.status, 200);
  assert.equal(res.data.addons.rate_guard, true);
  assert.equal((await call('GET', '/api/rate-guard', null, tok.owner)).data.addon, true);
});

test('Rate Guard: OTA price → suggestion → WhatsApp alert → YES reply → calendar', async () => {
  const d = addDays(today, 3);
  let res = await call('PUT', '/api/rate-guard/config', { enabled: true, provider: 'manual', undercut_pct: 5, alert_phones: ['98111 22233'], max_alerts_per_run: 3 }, tok.owner);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.deepEqual(res.data.alert_phones, [OWNER_WA]);
  res = await call('PUT', '/api/rate-guard/rooms', [
    { room_type_id: std, floor_paise: 180000, ceiling_paise: 400000, match_keywords: '' },
    { room_type_id: dlx, floor_paise: 250000, ceiling_paise: 600000, match_keywords: 'deluxe' },
  ], tok.owner);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal((await call('PUT', '/api/rate-guard/rooms', [{ room_type_id: std, floor_paise: 5, ceiling_paise: 1 }], tok.owner)).status, 400);

  // Deluxe on MakeMyTrip: ₹3,255 with GST = ₹3,100 before → 5% below → ₹2,949 (current ₹3,800).
  res = await call('POST', '/api/rate-guard/observations', { stay_date: d, ota_name: 'MakeMyTrip', room_name: 'Deluxe Room', rate_paise: 325500 }, tok.owner);
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.suggestions, 1);
  const sug = (await call('GET', '/api/rate-guard/suggestions', null, tok.owner)).data.find((s) => s.room_type_id === dlx);
  assert.equal(sug.suggested_rate_paise, 294900);
  assert.equal(sug.current_rate_paise, 380000);
  assert.match(sug.code, /^[A-Z2-9]{4}$/);
  const alert = (await pool.query(`SELECT * FROM notifications_outbox WHERE hotel_id = 1 AND template = 'rate_alert'`)).rows;
  assert.equal(alert.length, 1);
  assert.equal(alert[0].recipient, OWNER_WA);
  assert.equal(alert[0].payload.code, sug.code);
  assert.equal(alert[0].payload.suggested, 'Rs. 2,949');

  // The same price again does not ask again.
  await call('POST', '/api/rate-guard/observations', { stay_date: d, ota_name: 'MakeMyTrip', room_name: 'Deluxe Room', rate_paise: 325500 }, tok.owner);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM rate_suggestions WHERE hotel_id = 1 AND room_type_id = $1`, [dlx])).rows[0].n, 1);

  // Someone else's number cannot approve; the owner's can.
  res = await waText('919800000000', `YES ${sug.code}`);
  assert.equal(res.status, 200);
  assert.equal((await pool.query('SELECT status FROM rate_suggestions WHERE id = $1', [sug.id])).rows[0].status, 'pending');
  res = await waText(OWNER_WA, `yes ${sug.code.toLowerCase()}`);
  assert.deepEqual(res.data.result, { rate_guard_reply: 1 });
  const done = (await pool.query('SELECT status, decided_via, decided_phone FROM rate_suggestions WHERE id = $1', [sug.id])).rows[0];
  assert.deepEqual(done, { status: 'approved', decided_via: 'whatsapp', decided_phone: OWNER_WA });
  assert.equal((await pool.query('SELECT rate_paise, source FROM rate_calendar WHERE room_type_id = $1 AND date = $2', [dlx, d])).rows[0].rate_paise, 294900);
  assert.match(whatsapp.at(-1).text.body, /Deluxe .* now Rs\. 2,949/);
  const change = (await call('GET', `/api/rates/changes?room_type_id=${dlx}`, null, tok.owner)).data[0];
  assert.equal(change.source, 'rate_guard');
  assert.equal(change.via, 'whatsapp');
  assert.equal(change.suggestion_code, sug.code);

  // Replying again: already decided.
  await waText(OWNER_WA, `YES ${sug.code}`);
  assert.match(whatsapp.at(-1).text.body, /No open rate suggestion/);
});

test('Rate Guard: dashboard, reject, approve all, many alerts become one summary', async () => {
  const d = addDays(today, 4);
  for (let i = 0; i < 4; i++) {
    await call('POST', '/api/rate-guard/observations', { stay_date: addDays(d, i), ota_name: 'Agoda', room_name: 'Standard Room', rate_paise: 210000 }, tok.owner);
  }
  let res = await call('GET', `/api/rate-guard/dashboard?from=${d}&days=4`, null, tok.owner);
  assert.equal(res.status, 200);
  const stdRow = res.data.room_types.find((t) => t.id === std);
  assert.equal(stdRow.days[0].cheapest.name, 'Agoda');
  assert.ok(stdRow.days[0].suggestion);
  assert.ok(res.data.otas.some((o) => o.key === 'agoda'));
  const pending = (await call('GET', '/api/rate-guard/suggestions', null, tok.owner)).data.filter((s) => s.room_type_id === std);
  assert.equal(pending.length, 4);
  // ₹2,100 with GST → ₹2,000 before → 5% below → ₹1,899 (above the ₹1,800 floor).
  assert.equal(pending[0].suggested_rate_paise, 189900);

  res = await call('POST', `/api/rate-guard/suggestions/${pending[0].id}/reject`, {}, tok.owner);
  assert.equal(res.data.status, 'rejected');
  assert.equal((await call('POST', `/api/rate-guard/suggestions/${pending[0].id}/approve`, {}, tok.owner)).status, 404);
  // WhatsApp "NO ALL" skips the rest.
  await waText(OWNER_WA, 'no all');
  assert.match(whatsapp.at(-1).text.body, /Skipped 3 rate suggestions/);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM rate_calendar WHERE room_type_id = $1`, [std])).rows[0].n, 0);

  // More new suggestions in one go than max_alerts_per_run → one summary message.
  await pool.query(`DELETE FROM notifications_outbox WHERE hotel_id = 1`);
  await pool.query(`DELETE FROM rate_observations WHERE hotel_id = 1`);
  await pool.query(`UPDATE rate_guard_config SET provider = 'mock', property_token = 'mock-demo' WHERE hotel_id = 1`);
  res = await call('POST', '/api/rate-guard/check', { days: 3 }, tok.owner);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.checked, 3);
  assert.ok(res.data.offers > 0);
  const cfg = await loadConfig(1);
  const { sendAlerts } = await import('../src/lib/rateguard/engine.js');
  const fresh = (await pool.query(`SELECT s.*, s.stay_date::text AS stay_date, rt.name AS room_type FROM rate_suggestions s JOIN room_types rt ON rt.id = s.room_type_id
                                    WHERE s.hotel_id = 1 AND s.status = 'pending'`)).rows;
  assert.ok(fresh.length > cfg.max_alerts_per_run, `only ${fresh.length} suggestions`);
  await sendAlerts(await hotel(), cfg, fresh);
  const out = (await pool.query(`SELECT template FROM notifications_outbox WHERE hotel_id = 1`)).rows;
  assert.deepEqual(out.map((x) => x.template), ['rate_alert_summary']);
  res = await call('POST', '/api/rate-guard/suggestions/approve-all', {}, tok.owner);
  assert.equal(res.data.approved, fresh.length);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM rate_changes WHERE hotel_id = 1 AND source = 'rate_guard'`)).rows[0].n >= fresh.length, true);
});

test('Rate Guard auto mode applies small moves and leaves big ones for approval', async () => {
  await pool.query(`DELETE FROM rate_calendar WHERE hotel_id = 1`);
  await pool.query(`DELETE FROM rate_suggestions WHERE hotel_id = 1`);
  await pool.query(`DELETE FROM rate_observations WHERE hotel_id = 1`);
  await call('PUT', '/api/rate-guard/config', { provider: 'manual', mode: 'auto', auto_max_change_pct: 15 }, tok.owner);
  const d = addDays(today, 9);
  // Standard ₹2,500 → OTA ₹2,520 incl. GST (₹2,400 before) → ₹2,299: −8% → applied by itself.
  await call('POST', '/api/rate-guard/observations', { stay_date: d, ota_name: 'Goibibo', room_name: 'Standard', rate_paise: 252000 }, tok.owner);
  let s = (await pool.query(`SELECT status, suggested_rate_paise FROM rate_suggestions WHERE room_type_id = $1 AND stay_date = $2 ORDER BY id DESC LIMIT 1`, [std, d])).rows[0];
  assert.deepEqual(s, { status: 'auto_applied', suggested_rate_paise: 229900 });
  assert.equal((await pool.query('SELECT rate_paise, source FROM rate_calendar WHERE room_type_id = $1 AND date = $2', [std, d])).rows[0].source, 'auto_pilot');
  // Deluxe ₹3,800 → OTA ₹2,940 incl. (₹2,800) → ₹2,649: −30% → waits for the owner.
  await call('POST', '/api/rate-guard/observations', { stay_date: d, ota_name: 'Goibibo', room_name: 'Deluxe', rate_paise: 294000 }, tok.owner);
  s = (await pool.query(`SELECT status FROM rate_suggestions WHERE room_type_id = $1 AND stay_date = $2 ORDER BY id DESC LIMIT 1`, [dlx, d])).rows[0];
  assert.equal(s.status, 'pending');
  // One-click undo of the auto change.
  const ch = (await call('GET', `/api/rates/changes?room_type_id=${std}`, null, tok.owner)).data.find((c) => c.source === 'auto_pilot');
  assert.equal((await call('POST', `/api/rates/changes/${ch.id}/undo`, {}, tok.owner)).status, 200);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM rate_calendar WHERE room_type_id = $1 AND date = $2', [std, d])).rows[0].n, 0);
  await call('PUT', '/api/rate-guard/config', { mode: 'approve' }, tok.owner);
});

test('Rate Guard schedule: near dates every few hours, far dates daily; SerpApi provider', async () => {
  const h = await hotel();
  const cfg = { ...(await loadConfig(1)), horizon_days: 10, near_days: 3, near_every_hours: 3, far_every_hours: 24 };
  await pool.query(`DELETE FROM rate_fetch_runs WHERE hotel_id = 1`);
  assert.equal((await dueDates(h, cfg)).length, 10);
  for (let i = 0; i < 10; i++) {
    await pool.query(`INSERT INTO rate_fetch_runs (hotel_id, stay_date, provider, status, started_at) VALUES (1,$1,'serpapi','ok', now() - interval '4 hours')`, [addDays(today, i)]);
  }
  assert.deepEqual(await dueDates(h, cfg), [today, addDays(today, 1), addDays(today, 2)]);

  // Scheduler with SerpApi (fake): one call per due date, offers saved, suggestions made.
  process.env.SERPAPI_KEY = 'test-key';
  await pool.query(`UPDATE rate_guard_config SET provider = 'serpapi', property_token = 'ChoTEST', property_name = 'Wayinn Demo Hotel', horizon_days = 2, near_days = 2 WHERE hotel_id = 1`);
  await pool.query(`DELETE FROM rate_fetch_runs WHERE hotel_id = 1`);
  const asked = [];
  const fakeSerp = async (url) => {
    const u = new URL(String(url));
    asked.push(Object.fromEntries(u.searchParams));
    return new Response(JSON.stringify({ prices: [{ source: 'MakeMyTrip', rate_per_night: { extracted_lowest: 3255, extracted_before_taxes_fees: 3100 } }] }), { status: 200 });
  };
  const sum = await schedulerTick({ fetchImpl: fakeSerp });
  assert.equal(sum.find((x) => x.hotel_id === 1).checks, 2);
  assert.equal(asked.length, 2);
  assert.equal(asked[0].property_token, 'ChoTEST');
  assert.equal(asked[0].currency, 'INR');
  assert.equal(asked[0].api_key, 'test-key');
  const runs = (await pool.query(`SELECT status, offers FROM rate_fetch_runs WHERE hotel_id = 1`)).rows;
  assert.ok(runs.every((r) => r.status === 'ok' && r.offers === 1));
  // Errors are recorded, not thrown.
  await pool.query(`DELETE FROM rate_fetch_runs WHERE hotel_id = 1`);
  await schedulerTick({ fetchImpl: async () => new Response(JSON.stringify({ error: 'Invalid API key.' }), { status: 401 }) });
  const failed = (await pool.query(`SELECT status, error FROM rate_fetch_runs WHERE hotel_id = 1`)).rows;
  assert.equal(failed.length, 1); // a key problem stops the other dates
  assert.match(failed[0].error, /Invalid API key/);
  delete process.env.SERPAPI_KEY;
  await pool.query(`UPDATE rate_guard_config SET enabled = false WHERE hotel_id = 1`);
});

// ---------------------------------------------------------------
// Google Hotels
// ---------------------------------------------------------------
test('Google XML: ranges, rate / availability messages, replies', () => {
  const ranges = toRanges([
    { room_type_id: '1', date: '2030-01-01', rate_paise: 100 }, { room_type_id: '1', date: '2030-01-02', rate_paise: 100 },
    { room_type_id: '1', date: '2030-01-03', rate_paise: 200 }, { room_type_id: '2', date: '2030-01-01', rate_paise: 100 },
  ], ['rate_paise']);
  assert.deepEqual(ranges.map((r) => [r.room_type_id, r.start, r.end, r.rate_paise]), [['1', '2030-01-01', '2030-01-02', 100], ['1', '2030-01-03', '2030-01-03', 200], ['2', '2030-01-01', '2030-01-01', 100]]);
  const xml = rateAmountXml({ partnerKey: 'wayne', hotelCode: 'WAYINN1', echo: 'e1', items: [{ room_type_id: '5', start: '2030-01-01', end: '2030-01-02', rate_paise: 294900, after_tax_paise: 309645, guests: 2, extra_adult_paise: 50000 }] });
  assert.match(xml, /<RequestorID ID="wayne"\/>/);
  assert.match(xml, /HotelCode="WAYINN1"/);
  assert.match(xml, /InvTypeCode="5" RatePlanCode="BAR"/);
  assert.match(xml, /AmountBeforeTax="2949.00" AmountAfterTax="3096.45" CurrencyCode="INR" NumberOfGuests="2"/);
  assert.match(xml, /AdditionalGuestAmount Amount="500.00" AgeQualifyingCode="10"/);
  const av = availXml({ hotelCode: 'H&1', echo: 'e', items: [{ room_type_id: '5', start: '2030-01-01', end: '2030-01-01', closed: true, min_stay: 2 }] });
  assert.match(av, /HotelCode="H&amp;1"/);
  assert.match(av, /Restriction="Master" Status="Close"/);
  assert.match(av, /SetMinLOS" Time="2"/);
  assert.deepEqual(parseResponse('<OTA_HotelRateAmountNotifRS><Success/></OTA_HotelRateAmountNotifRS>'), { ok: true });
  assert.equal(parseResponse('<X><Errors><Error Type="12" Code="450" Status="NotProcessed" ShortText="bad_hotel">Unknown hotel</Error></Errors></X>').error, 'bad_hotel: Unknown hotel');
  assert.match(hotelListXml([{ id: 'WAYINN1', name: 'A & B', lat: 30.9, lng: 75.85, country: 'IN' }]), /<name>A &amp; B<\/name>[\s\S]*<latitude>30.900000<\/latitude>/);
});

test('Google sync: dry run without partner key, then only changes are pushed', async () => {
  await resetRates();
  await pool.query(`UPDATE rooms SET hk_status = 'ready' WHERE hotel_id = 1`);
  let res = await call('GET', '/api/google', null, tok.owner);
  assert.equal(res.status, 200);
  assert.equal(res.data.config.property_id, 'WAYINN1');
  assert.equal(res.data.pushing, false);
  res = await call('PUT', '/api/google', { enabled: true, latitude: 30.901, longitude: 75.857, postal_code: '141001', refundable_days: 2 }, tok.owner);
  assert.equal(res.status, 200, JSON.stringify(res.data));

  // No partner key yet: nothing leaves the server.
  res = await call('POST', '/api/google/sync', {}, tok.owner);
  assert.equal(res.data.dry_run, true);
  assert.equal(google.length, 0);
  assert.ok(res.data.rate.items > 0);

  process.env.GOOGLE_HOTEL_PARTNER_KEY = 'wayne_partner';
  await call('PATCH', '/api/platform/hotels/1/google', { status: 'testing' }, platformTok);
  res = await call('POST', '/api/google/sync', {}, tok.owner);
  assert.equal(res.data.dry_run, false, JSON.stringify(res.data));
  const kinds = google.map((g) => g.url.split('/').pop());
  assert.deepEqual(kinds, ['property_data', 'hotel_rate_amount_notif', 'hotel_avail_notif', 'hotel_inv_count_notif']);
  assert.match(google[0].body, /<Property>WAYINN1<\/Property>[\s\S]*refundable_until_days="2"/);
  assert.match(google[1].body, /<RequestorID ID="wayne_partner"\/>/);
  // 3 room types, one flat range each for the whole year.
  assert.equal((google[1].body.match(/<RateAmountMessage>/g) || []).length, 3);

  // Nothing changed → nothing sent.
  google.length = 0;
  res = await call('POST', '/api/google/sync', {}, tok.owner);
  assert.equal(google.length, 0);
  assert.equal(res.data.rate.items, 0);

  // A rate change goes out within the next minute's pass, only the rate message, only for that room and night.
  const d = addDays(today, 6);
  await call('PUT', '/api/rates/calendar', { room_type_ids: [dlx], from: d, to: d, rate_paise: 333300 }, tok.owner);
  await googleTick();
  assert.deepEqual(google.map((g) => g.url.split('/').pop()), ['hotel_rate_amount_notif']);
  assert.match(google[0].body, new RegExp(`Start="${d}" End="${d}" InvTypeCode="${dlx}"`));
  assert.match(google[0].body, /AmountBeforeTax="3333.00" AmountAfterTax="3499.65"/);

  // A booking changes inventory: picked up by the full pass.
  google.length = 0;
  await call('POST', '/api/bookings', { guest: { full_name: 'Inv Guest' }, stays: [{ room_type_id: suite, check_in_date: d, check_out_date: addDays(d, 1) }] }, tok.frontdesk);
  await googleTick({ all: true });
  assert.deepEqual(google.map((g) => g.url.split('/').pop()), ['hotel_inv_count_notif']);
  assert.match(google[0].body, /InvCount Count="1" CountType="2"/);

  // Google refuses: the error is shown and the nights are sent again next time.
  google.length = 0;
  googleReply = '<OTA_HotelRateAmountNotifRS><Errors><Error Type="12" Code="450" Status="NotProcessed" ShortText="x">Hotel not matched</Error></Errors></OTA_HotelRateAmountNotifRS>';
  await call('PUT', '/api/rates/calendar', { room_type_ids: [dlx], from: d, to: d, rate_paise: 344400 }, tok.owner);
  let out = await syncHotel(await hotel());
  assert.match(out.rate.error, /Hotel not matched/);
  googleReply = '<OTA_HotelRateAmountNotifRS><Success/></OTA_HotelRateAmountNotifRS>';
  out = await syncHotel(await hotel());
  assert.equal(out.rate.items, 1);
  assert.equal(out.rate.error, null);
  res = await call('GET', '/api/google', null, tok.owner);
  assert.equal(res.data.config.last_error, null);
  assert.ok(res.data.logs.some((l) => l.status === 'failed'));
  await pool.query(`UPDATE stays SET status = 'cancelled' WHERE hotel_id = 1 AND status IN ('reserved','checked_in','tentative')`);
});

test('Google landing page, hotel list feed, preview, platform view', async () => {
  const d = addDays(today, 12);
  let res = await call('GET', `/api/google/landing?hotel=WAYINN1&checkin=${d}&nights=2&room=${dlx}`, null, null);
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get('location'));
  assert.equal(loc.pathname, '/book/demo-hotel');
  assert.equal(loc.searchParams.get('checkout'), addDays(d, 2));
  assert.equal(loc.searchParams.get('room'), String(dlx));
  assert.equal(loc.searchParams.get('src'), 'google');
  res = await call('GET', '/api/google/landing?hotel=NOPE', null, null);
  assert.equal(res.status, 302);

  assert.equal((await call('GET', '/api/google/hotel-list.xml?token=x', null, null)).status, 404);
  process.env.GOOGLE_FEED_TOKEN = 'feedtoken123';
  res = await call('GET', '/api/google/hotel-list.xml?token=feedtoken123', null, null);
  assert.equal(res.status, 200);
  assert.match(res.data, /<id>WAYINN1<\/id>[\s\S]*<name>Wayinn Demo Hotel<\/name>[\s\S]*<postal_code|postal_code">141001/);

  res = await call('GET', '/api/google/preview?kind=avail', null, tok.owner);
  assert.match(res.data, /OTA_HotelAvailNotifRQ/);
  res = await call('GET', '/api/platform/google', null, platformTok);
  assert.equal(res.data.partner_key_set, true);
  assert.match(res.data.hotel_list_feed, /hotel-list\.xml\?token=feedtoken123/);
  assert.equal(res.data.hotels.find((h) => h.id === 1).status, 'testing');

  // Switching the add-on off stops pushing.
  await call('PATCH', '/api/platform/hotels/1/addons', { rate_guard: false }, platformTok);
  google.length = 0;
  await googleTick({ all: true });
  assert.equal(google.length, 0);
  assert.equal((await loadConfig(1)).enabled, false);
});

test('monthly report counts direct vs OTA bookings', async () => {
  await call('PATCH', '/api/platform/hotels/1/addons', { rate_guard: true }, platformTok);
  const res = await call('GET', `/api/rate-guard/report?month=${today.slice(0, 7)}&commission_pct=20`, null, tok.owner);
  assert.equal(res.status, 200);
  assert.equal(res.data.commission_pct, 20);
  assert.ok(res.data.direct.from_google >= 0);
  assert.equal(res.data.commission_saved_paise, Math.round(res.data.direct.room_revenue_paise * 0.2));
});
