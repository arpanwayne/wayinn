// Guest documents (ID proofs): received on the hotel's WhatsApp number or uploaded at the desk.
import { Router } from 'express';
import express from 'express';
import { z } from 'zod';
import { one, many } from '../db.js';
import { parse, idParam } from '../lib/validate.js';
import { requireStaff, requirePerm } from '../middleware/auth.js';
import { notFound, badRequest, conflict } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { loadIntegrations, whatsappInboundReady, safeEqual, hmacHex } from '../lib/integrations.js';
import { processWhatsAppWebhook, DOC_MIME } from '../lib/inbound.js';
import { MAX_DOC_BYTES } from '../lib/providers.js';
import { queueNotification } from '../lib/notify.js';

const r = Router();

const DOC_TYPES = ['id_proof', 'aadhaar', 'passport', 'driving_licence', 'voter_id', 'pan', 'visa', 'other'];
const COLS = `d.id, d.guest_id, d.booking_id, d.doc_type, d.source, d.status, d.file_name, d.mime_type, d.size_bytes, d.from_phone, d.from_name, d.note,
              d.received_at, g.full_name AS guest_name, b.ref AS booking_ref`;
const FROM = 'FROM guest_documents d LEFT JOIN guests g ON g.id = d.guest_id LEFT JOIN bookings b ON b.id = d.booking_id';

// ---------------------------------------------------------------
// WhatsApp webhook (Meta). No login: the hotel is in the URL and every delivery is checked against its app secret.
// ---------------------------------------------------------------
r.get('/webhooks/whatsapp/:hotelId', async (req, res) => {
  const integ = await loadIntegrations(idParam(req.params.hotelId));
  if (req.query['hub.mode'] === 'subscribe' && integ.whatsapp_verify_token && safeEqual(req.query['hub.verify_token'], integ.whatsapp_verify_token)) {
    return res.type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
  }
  res.status(403).json({ error: 'Verification failed' });
});

r.post('/webhooks/whatsapp/:hotelId', async (req, res) => {
  const hotelId = idParam(req.params.hotelId);
  const integ = await loadIntegrations(hotelId);
  if (!whatsappInboundReady(integ)) return res.status(404).json({ error: 'Not set up' });
  const sig = String(req.get('x-hub-signature-256') || '').replace(/^sha256=/, '');
  if (!safeEqual(sig, hmacHex(integ.whatsapp_app_secret, req.rawBody || ''))) return res.status(401).json({ error: 'Bad signature' });
  const hotel = await one('SELECT * FROM hotels WHERE id = $1', [hotelId]);
  if (!hotel || ['suspended', 'cancelled'].includes(hotel.subscription_status)) return res.json({ ok: true, ignored: true });
  try {
    res.json({ ok: true, result: await processWhatsAppWebhook(hotel, integ, req.body, req.app.locals.whatsappDeps) });
  } catch (e) {
    console.error('whatsapp webhook failed:', e.message);
    res.status(500).json({ error: 'Try again' }); // Meta redelivers; duplicates are ignored by message id
  }
});

// ---------------------------------------------------------------
// Staff side
// ---------------------------------------------------------------
r.use(['/guest-documents', '/guests/:id/documents', '/guests/:id/request-documents'], requireStaff);

r.get('/guest-documents', requirePerm('guests.manage'), async (req, res) => {
  const where = ['d.hotel_id = $1'];
  const vals = [req.hotelId];
  if (req.query.status === 'inbox') where.push(`d.status = 'inbox'`);
  if (req.query.guest_id) { vals.push(idParam(req.query.guest_id)); where.push(`d.guest_id = $${vals.length}`); }
  if (req.query.booking_id) { vals.push(idParam(req.query.booking_id)); where.push(`d.booking_id = $${vals.length}`); }
  res.json(await many(`SELECT ${COLS} ${FROM} WHERE ${where.join(' AND ')} ORDER BY d.received_at DESC LIMIT 200`, vals));
});

r.get('/guests/:id/documents', requirePerm('guests.manage'), async (req, res) => {
  res.json(await many(`SELECT ${COLS} ${FROM} WHERE d.hotel_id = $1 AND d.guest_id = $2 ORDER BY d.received_at DESC`, [req.hotelId, idParam(req.params.id)]));
});

// The file itself. Staff only, never cached, and every view is written to the activity log.
r.get('/guest-documents/:id/file', requirePerm('guests.manage'), async (req, res) => {
  const id = idParam(req.params.id);
  const d = await one('SELECT file_name, mime_type, data FROM guest_documents WHERE id = $1 AND hotel_id = $2', [id, req.hotelId]);
  if (!d) throw notFound();
  await audit(req, 'guest_document.viewed', 'guest_document', id);
  res.set({ 'content-type': d.mime_type, 'cache-control': 'private, no-store', 'content-disposition': `inline; filename="${d.file_name.replace(/[^\w.\- ]/g, '_')}"` });
  res.send(d.data);
});

// Upload from the desk: raw file bytes in the body, details in the query string.
r.post('/guest-documents', requirePerm('guests.manage'), express.raw({ type: Object.keys(DOC_MIME), limit: MAX_DOC_BYTES }), async (req, res) => {
  const mime = String(req.get('content-type') || '').split(';')[0];
  if (!DOC_MIME[mime]) throw badRequest('Upload a JPG, PNG, WebP or PDF file');
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw badRequest('The file is empty');
  const q = parse(z.object({
    guest_id: z.coerce.number().int().optional(), booking_id: z.coerce.number().int().optional(),
    doc_type: z.enum(DOC_TYPES).default('id_proof'), filename: z.string().max(200).optional(),
  }), req.query);
  if (q.guest_id && !(await one('SELECT id FROM guests WHERE id = $1 AND hotel_id = $2', [q.guest_id, req.hotelId]))) throw badRequest('Unknown guest');
  if (q.booking_id && !(await one('SELECT id FROM bookings WHERE id = $1 AND hotel_id = $2', [q.booking_id, req.hotelId]))) throw badRequest('Unknown booking');
  const d = await one(
    `INSERT INTO guest_documents (hotel_id, guest_id, booking_id, doc_type, source, status, file_name, mime_type, size_bytes, data, uploaded_by, attached_by)
     VALUES ($1,$2,$3,$4,'upload',$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [req.hotelId, q.guest_id ?? null, q.booking_id ?? null, q.doc_type, q.guest_id ? 'attached' : 'inbox',
      q.filename || `${q.doc_type}.${DOC_MIME[mime]}`, mime, req.body.length, req.body, req.user.id, q.guest_id ? req.user.id : null]);
  await audit(req, 'guest_document.uploaded', 'guest_document', d.id, { guest_id: q.guest_id, type: q.doc_type });
  res.status(201).json(await one(`SELECT ${COLS} ${FROM} WHERE d.id = $1`, [d.id]));
});

// Match an inbox document to a guest (and booking), or fix its type.
r.patch('/guest-documents/:id', requirePerm('guests.manage'), async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(z.object({ guest_id: z.number().int().nullable().optional(), booking_id: z.number().int().nullable().optional(),
    doc_type: z.enum(DOC_TYPES).optional(), note: z.string().max(300).nullable().optional() }), req.body);
  const cur = await one('SELECT id, guest_id FROM guest_documents WHERE id = $1 AND hotel_id = $2', [id, req.hotelId]);
  if (!cur) throw notFound();
  if (b.guest_id && !(await one('SELECT id FROM guests WHERE id = $1 AND hotel_id = $2', [b.guest_id, req.hotelId]))) throw badRequest('Unknown guest');
  if (b.booking_id && !(await one('SELECT id FROM bookings WHERE id = $1 AND hotel_id = $2', [b.booking_id, req.hotelId]))) throw badRequest('Unknown booking');
  const guestId = b.guest_id === undefined ? cur.guest_id : b.guest_id;
  await one(
    `UPDATE guest_documents SET guest_id = $2, booking_id = CASE WHEN $3::boolean THEN $4 WHEN $2 IS DISTINCT FROM guest_id THEN NULL ELSE booking_id END,
            doc_type = COALESCE($5, doc_type), note = CASE WHEN $6::boolean THEN $7 ELSE note END,
            status = CASE WHEN $2 IS NULL THEN 'inbox' ELSE 'attached' END, attached_by = $8 WHERE id = $1 RETURNING id`,
    [id, guestId, b.booking_id !== undefined, b.booking_id ?? null, b.doc_type ?? null, b.note !== undefined, b.note ?? null, req.user.id]);
  await audit(req, 'guest_document.updated', 'guest_document', id, { guest_id: guestId, booking_id: b.booking_id, type: b.doc_type });
  res.json(await one(`SELECT ${COLS} ${FROM} WHERE d.id = $1`, [id]));
});

r.delete('/guest-documents/:id', requirePerm('guests.manage'), async (req, res) => {
  const id = idParam(req.params.id);
  const d = await one('DELETE FROM guest_documents WHERE id = $1 AND hotel_id = $2 RETURNING id, guest_id, doc_type, file_name', [id, req.hotelId]);
  if (!d) throw notFound();
  await audit(req, 'guest_document.deleted', 'guest_document', id, { guest_id: d.guest_id, type: d.doc_type, file: d.file_name });
  res.json({ ok: true });
});

// Ask the guest to send their ID on the hotel's WhatsApp number (needs the "checkin_documents_request" template).
r.post('/guests/:id/request-documents', requirePerm('guests.manage'), async (req, res) => {
  const g = await one('SELECT id, full_name, phone FROM guests WHERE id = $1 AND hotel_id = $2', [idParam(req.params.id), req.hotelId]);
  if (!g) throw notFound();
  if (!g.phone) throw conflict('This guest has no phone number');
  if (!req.hotel.settings?.notifications?.whatsapp) throw conflict('WhatsApp messages are off. Switch them on in Setup → Messages & payments.');
  await queueNotification(req.hotelId, { phone: g.phone, full_name: g.full_name }, 'checkin_documents_request', { hotel: req.hotel.name });
  await audit(req, 'guest_document.requested', 'guest', g.id);
  res.json({ ok: true });
});

export default r;
