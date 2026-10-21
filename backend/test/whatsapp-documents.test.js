// Guest ID documents arriving on WhatsApp, front-desk uploads, and housekeeping / maintenance alerts + replies.
// Meta's servers are never called: graph.facebook.com is answered by a fake fetch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool } from '../src/db.js';

let server, base, frontdesk;
const realFetch = globalThis.fetch;
const sentText = []; // free-form replies the hotel would have sent
const SECRET = 'app-secret-for-tests';
const PNID = '555000111';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]);
let settingsBefore;
let n = 0;

async function call(method, path, body, token, headers = {}) {
  const res = await realFetch(base + path, {
    method, headers: { ...(body && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined || body === null ? undefined : (Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let data; try { data = JSON.parse(buf.toString()); } catch { data = buf; }
  return { status: res.status, data, headers: res.headers };
}

const webhook = (messages, { sign = true, phoneId = PNID } = {}) => {
  const body = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: phoneId }, contacts: messages.map((m) => ({ wa_id: m.from, profile: { name: 'Test Sender' } })), messages } }] }] });
  const sig = `sha256=${crypto.createHmac('sha256', SECRET).update(body).digest('hex')}`;
  return call('POST', '/api/webhooks/whatsapp/1', body, null, { 'content-type': 'application/json', ...(sign ? { 'x-hub-signature-256': sig } : {}) });
};
const imageMsg = (from, extra = {}) => ({ from, id: `wamid.test${++n}${Date.now()}`, type: 'image', image: { id: `media${n}`, mime_type: 'image/jpeg', caption: 'my aadhaar card' }, ...extra });
const textMsg = (from, body) => ({ from, id: `wamid.text${++n}${Date.now()}`, type: 'text', text: { body } });

before(async () => {
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  frontdesk = (await call('POST', '/api/auth/login', { email: 'frontdesk@demo-hotel.in', password: 'Wayinn@123' })).data.token;
  settingsBefore = (await pool.query('SELECT settings FROM hotels WHERE id = 1')).rows[0].settings;
  await pool.query(`DELETE FROM hotel_integrations WHERE hotel_id = 1`);
  await pool.query(`INSERT INTO hotel_integrations (hotel_id, whatsapp_phone_number_id, whatsapp_token, whatsapp_verify_token, whatsapp_app_secret) VALUES (1,$1,'tok','verify-me',$2)`, [PNID, SECRET]);
  await pool.query(`UPDATE hotels SET settings = settings || $1::jsonb WHERE id = 1`, [JSON.stringify({
    notifications: { whatsapp: true },
    staff_contacts: [{ name: 'Ramesh', phone: '90000 11111', team: 'housekeeping' }, { name: 'Sunil', phone: '90000 22222', team: 'maintenance' }],
  })]);
  await pool.query(`DELETE FROM guest_documents WHERE hotel_id = 1`);
  await pool.query(`DELETE FROM notifications_outbox WHERE hotel_id = 1`);
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('https://graph.facebook.com/') && u.endsWith('/messages')) {
      sentText.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.out' }] }), { status: 200 });
    }
    if (u.startsWith('https://graph.facebook.com/')) {
      const id = u.split('/').pop();
      return new Response(JSON.stringify({ url: `https://lookaside.fbsbx.com/${id}`, mime_type: id === 'mediaGif' ? 'image/gif' : 'image/jpeg', file_size: JPEG.length }), { status: 200 });
    }
    if (u.startsWith('https://lookaside.fbsbx.com/')) return new Response(JPEG, { status: 200, headers: { 'content-type': u.endsWith('mediaGif') ? 'image/gif' : 'image/jpeg' } });
    return realFetch(url, opts);
  };
});

after(async () => {
  globalThis.fetch = realFetch;
  await pool.query(`DELETE FROM guest_documents WHERE hotel_id = 1`);
  await pool.query(`DELETE FROM hotel_integrations WHERE hotel_id = 1`);
  await pool.query(`UPDATE hotels SET settings = $1 WHERE id = 1`, [settingsBefore]);
  server.close();
  await pool.end();
});

test('webhook verification and signature check', async () => {
  const ok = await call('GET', '/api/webhooks/whatsapp/1?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345');
  assert.equal(ok.status, 200);
  assert.equal(ok.data.toString(), '12345');
  assert.equal((await call('GET', '/api/webhooks/whatsapp/1?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1')).status, 403);
  assert.equal((await webhook([imageMsg('919999900001')], { sign: false })).status, 401);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM guest_documents WHERE hotel_id = 1`)).rows[0].n, 0);
});

test('an ID photo from a known guest is saved on that guest; from a stranger it waits in the inbox', async () => {
  const g = (await call('POST', '/api/guests', { full_name: 'Asha Verma', phone: '+91 98765-43210' }, frontdesk)).data;
  const known = await webhook([imageMsg('919876543210')]);
  assert.equal(known.status, 200);
  assert.equal(known.data.result.attached, 1);
  const docs = (await call('GET', `/api/guests/${g.id}/documents`, null, frontdesk)).data;
  assert.equal(docs.length, 1);
  assert.equal(docs[0].doc_type, 'aadhaar'); // guessed from the caption
  assert.equal(docs[0].source, 'whatsapp');
  const file = await call('GET', `/api/guest-documents/${docs[0].id}/file`, null, frontdesk);
  assert.equal(file.headers.get('content-type'), 'image/jpeg');
  assert.equal(file.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(file.data, JPEG);
  assert.ok(sentText.some((m) => m.to === '919876543210' && /received your document/.test(m.text.body)), 'guest is thanked');

  const stranger = await webhook([imageMsg('919111122223')]);
  assert.equal(stranger.data.result.inbox, 1);
  const inbox = (await call('GET', '/api/guest-documents?status=inbox', null, frontdesk)).data;
  assert.equal(inbox.length, 1);
  const moved = await call('PATCH', `/api/guest-documents/${inbox[0].id}`, { guest_id: g.id, doc_type: 'passport' }, frontdesk);
  assert.equal(moved.data.guest_name, 'Asha Verma');
  assert.equal(moved.data.status, 'attached');
  assert.equal((await call('GET', '/api/guest-documents?status=inbox', null, frontdesk)).data.length, 0);
});

test('the same WhatsApp message delivered twice is saved once; GIFs are refused', async () => {
  const m = imageMsg('919876543210');
  await webhook([m]);
  const again = await webhook([m]);
  assert.equal(again.data.result.duplicate, 1);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM guest_documents WHERE wa_message_id = $1`, [m.id])).rows[0].n, 1);
  const gif = await webhook([{ from: '919876543210', id: `wamid.gif${Date.now()}`, type: 'image', image: { id: 'mediaGif', mime_type: 'image/gif' } }]);
  assert.equal(gif.data.result.unsupported, 1);
});

test('front desk uploads a file; kitchen cannot read documents', async () => {
  const g = (await call('POST', '/api/guests', { full_name: 'Upload Guest', phone: '90909 09090' }, frontdesk)).data;
  const up = await call('POST', `/api/guest-documents?guest_id=${g.id}&doc_type=passport&filename=pass.jpg`, JPEG, frontdesk, { 'content-type': 'image/jpeg' });
  assert.equal(up.status, 201);
  assert.equal(up.data.source, 'upload');
  assert.equal((await call('POST', `/api/guest-documents?guest_id=${g.id}`, Buffer.from('MZ'), frontdesk, { 'content-type': 'application/octet-stream' })).status, 400);
  const kitchen = (await call('POST', '/api/auth/login', { email: 'kitchen@demo-hotel.in', password: 'Wayinn@123' })).data.token;
  assert.equal((await call('GET', `/api/guest-documents/${up.data.id}/file`, null, kitchen)).status, 403);
  assert.equal((await call('DELETE', `/api/guest-documents/${up.data.id}`, null, frontdesk)).status, 200);
});

test('new housekeeping task alerts the housekeeping team; DONE reply closes it', async () => {
  const room = (await pool.query(`SELECT id, number FROM rooms WHERE hotel_id = 1 ORDER BY number LIMIT 1`)).rows[0];
  await pool.query(`UPDATE hk_tasks SET status = 'cancelled' WHERE hotel_id = 1 AND room_id = $1 AND status IN ('pending','in_progress')`, [room.id]);
  await pool.query(`UPDATE rooms SET hk_status = 'dirty' WHERE id = $1`, [room.id]);
  const t = await call('POST', '/api/housekeeping/tasks', { room_id: room.id, task_type: 'cleaning', priority: 'high' }, frontdesk);
  assert.equal(t.status, 201);
  const out = (await pool.query(`SELECT recipient, template FROM notifications_outbox WHERE hotel_id = 1 AND template = 'hk_task_alert'`)).rows;
  assert.deepEqual(out.map((o) => o.recipient), ['919000011111']); // housekeeping only, not maintenance

  // maintenance staff cannot close a housekeeping task, a stranger cannot either
  await webhook([textMsg('919000022222', `DONE ${room.number}`)]);
  await webhook([textMsg('919555500000', `DONE ${room.number}`)]);
  assert.equal((await pool.query(`SELECT status FROM hk_tasks WHERE id = $1`, [t.data.id])).rows[0].status, 'pending');

  const r = await webhook([textMsg('919000011111', `done ${room.number}`)]);
  assert.equal(r.data.result.staff_command, 1);
  assert.equal((await pool.query(`SELECT status FROM hk_tasks WHERE id = $1`, [t.data.id])).rows[0].status, 'done');
  assert.equal((await pool.query(`SELECT hk_status FROM rooms WHERE id = $1`, [room.id])).rows[0].hk_status, 'ready');
});

test('new maintenance request alerts maintenance; FIXED reply resolves it', async () => {
  const room = (await pool.query(`SELECT id FROM rooms WHERE hotel_id = 1 ORDER BY number LIMIT 1`)).rows[0];
  const m = await call('POST', '/api/maintenance', { room_id: room.id, title: 'AC not cooling', priority: 'urgent' }, frontdesk);
  assert.equal(m.status, 201);
  const out = (await pool.query(`SELECT recipient FROM notifications_outbox WHERE hotel_id = 1 AND template = 'maintenance_alert'`)).rows;
  assert.deepEqual(out.map((o) => o.recipient), ['919000022222']);
  await webhook([textMsg('919000022222', `FIXED ${m.data.id}`)]);
  const row = (await pool.query(`SELECT status, resolution_notes FROM maintenance_requests WHERE id = $1`, [m.data.id])).rows[0];
  assert.equal(row.status, 'resolved');
  assert.match(row.resolution_notes, /Sunil/);
});

test('request ID on WhatsApp queues the template for the guest', async () => {
  const g = (await call('POST', '/api/guests', { full_name: 'Ask Guest', phone: '98111 22233' }, frontdesk)).data;
  assert.equal((await call('POST', `/api/guests/${g.id}/request-documents`, {}, frontdesk)).status, 200);
  const q = (await pool.query(`SELECT recipient, channel FROM notifications_outbox WHERE hotel_id = 1 AND template = 'checkin_documents_request'`)).rows;
  assert.deepEqual(q, [{ recipient: '919811122233', channel: 'whatsapp' }]);
});
