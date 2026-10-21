// Messages that arrive on the hotel's own WhatsApp number (Meta Cloud API webhook):
//  - a guest sends a photo / PDF of an ID  → saved as a guest document, matched to the guest by phone number
//  - housekeeping / maintenance reply "DONE 101" / "FIXED 12" → the task is closed
// Anything else is ignored. `deps` lets tests swap the network calls.
import { one, tx } from '../db.js';
import { downloadWhatsAppMedia, sendWhatsAppText, ProviderError } from './providers.js';
import { normalizePhone } from './messages.js';

export const DOC_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

const DOC_WORDS = [
  ['aadhaar', /aadh?aa?r|adhar|uidai/i], ['passport', /passport/i], ['driving_licence', /driving|licen[cs]e|\bdl\b/i],
  ['voter_id', /voter/i], ['pan', /\bpan\b/i], ['visa', /visa/i],
];
export const guessDocType = (caption) => DOC_WORDS.find(([, re]) => re.test(caption || ''))?.[0] || 'id_proof';

/** Find the guest a phone number belongs to, preferring someone staying now or arriving soon. */
export async function guestByPhone(hotelId, rawPhone, db = { one }) {
  const d = String(normalizePhone(rawPhone) || rawPhone || '').replace(/\D/g, '');
  if (d.length < 8) return null;
  const last = d.slice(-10);
  return db.one(
    `SELECT g.id, g.full_name,
            (SELECT s.booking_id FROM stays s WHERE s.guest_id = g.id AND s.status IN ('checked_in','reserved')
              ORDER BY (s.status = 'checked_in') DESC, s.check_in_date LIMIT 1) AS booking_id
       FROM guests g
      WHERE g.hotel_id = $1 AND length(regexp_replace(COALESCE(g.phone,''), '\\D', '', 'g')) >= 8
        AND regexp_replace(g.phone, '\\D', '', 'g') LIKE '%' || $2
      ORDER BY EXISTS (SELECT 1 FROM stays s WHERE s.guest_id = g.id AND s.status = 'checked_in') DESC,
               EXISTS (SELECT 1 FROM stays s WHERE s.guest_id = g.id AND s.status = 'reserved') DESC, g.created_at DESC LIMIT 1`,
    [hotelId, last]);
}

const staffTeam = (hotel, phone) => {
  const s = hotel.settings || {};
  const d = String(phone).slice(-10);
  const c = (s.staff_contacts || []).find((x) => String(normalizePhone(x.phone) || '').slice(-10) === d);
  if (c) return { team: c.team, name: c.name };
  if ((s.staff_alert_phones || []).some((p) => String(normalizePhone(p) || '').slice(-10) === d)) return { team: 'any', name: 'Staff' };
  return null;
};

async function reply(integ, to, text, deps) {
  try { await (deps.sendText || sendWhatsAppText)(integ, to, text); } catch (e) { console.error('WhatsApp reply failed:', e.message); }
}

async function saveDocument(hotel, integ, msg, profileName, deps) {
  const media = msg[msg.type];
  const caption = media?.caption || '';
  const dup = await one('SELECT id FROM guest_documents WHERE hotel_id = $1 AND wa_message_id = $2', [hotel.id, msg.id]);
  if (dup) return 'duplicate';
  let file;
  try { file = await (deps.download || downloadWhatsAppMedia)(integ, media.id); } catch (e) {
    await reply(integ, msg.from, 'Sorry, we could not receive that file. Please try sending it again.', deps);
    if (e instanceof ProviderError && e.retry) throw e; // let Meta redeliver the webhook
    return 'failed';
  }
  const ext = DOC_MIME[file.mime || media.mime_type];
  if (!ext) {
    await reply(integ, msg.from, 'Please send your ID as a photo (JPG / PNG) or a PDF.', deps);
    return 'unsupported';
  }
  const guest = await guestByPhone(hotel.id, msg.from);
  const name = media.filename || `${guessDocType(caption)}-${msg.from}-${Date.now()}.${ext}`;
  await one(
    `INSERT INTO guest_documents (hotel_id, guest_id, booking_id, doc_type, source, status, file_name, mime_type, size_bytes, data, from_phone, from_name, note, wa_message_id)
     VALUES ($1,$2,$3,$4,'whatsapp',$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING RETURNING id`,
    [hotel.id, guest?.id ?? null, guest?.booking_id ?? null, guessDocType(caption), guest ? 'attached' : 'inbox', name.slice(0, 200),
      file.mime || media.mime_type, file.data.length, file.data, msg.from, profileName || null, caption.slice(0, 300) || null, msg.id]);
  // One thank-you per burst, not one per page of a multi-page document.
  const recent = await one(`SELECT count(*)::int AS n FROM guest_documents WHERE hotel_id = $1 AND from_phone = $2 AND received_at > now() - interval '10 minutes'`, [hotel.id, msg.from]);
  if (recent.n <= 1) {
    await reply(integ, msg.from, `Thank you${guest ? `, ${guest.full_name.split(' ')[0]}` : ''}. We have received your document at ${hotel.name}.`, deps);
  }
  return guest ? 'attached' : 'inbox';
}

async function staffCommand(hotel, integ, msg, deps) {
  const m = /^\s*(done|fixed)\s+#?([\w-]{1,20})\b/i.exec(msg.text?.body || '');
  if (!m) return 'ignored';
  const who = staffTeam(hotel, msg.from);
  if (!who) return 'ignored'; // numbers we do not know cannot close tasks
  const cmd = m[1].toLowerCase();
  const arg = m[2];
  const out = await tx(async (db) => {
    if (cmd === 'done') {
      if (!['housekeeping', 'any'].includes(who.team)) return `${who.name}, DONE is for housekeeping. Maintenance should reply FIXED <number>.`;
      const t = await db.one(
        `SELECT t.*, r.number FROM hk_tasks t JOIN rooms r ON r.id = t.room_id
          WHERE t.hotel_id = $1 AND lower(r.number) = lower($2) AND t.status IN ('pending','in_progress')
          ORDER BY t.created_at LIMIT 1 FOR UPDATE OF t`, [hotel.id, arg]);
      if (!t) return `No open housekeeping task for room ${arg}.`;
      await db.query(`UPDATE hk_tasks SET status = 'done', completed_at = now(), started_at = COALESCE(started_at, now()), notes = COALESCE(notes || E'\\n', '') || $2 WHERE id = $1`,
        [t.id, `Marked done on WhatsApp by ${who.name}`]);
      if (['cleaning', 'deep_clean'].includes(t.task_type)) {
        const needsInspection = hotel.settings?.require_inspection === true;
        await db.query(`UPDATE rooms SET hk_status = $1 WHERE id = $2 AND hk_status <> 'out_of_order'`, [needsInspection ? 'cleaning' : 'ready', t.room_id]);
        if (needsInspection) {
          await db.query(`INSERT INTO hk_tasks (hotel_id, room_id, task_type, priority, trigger, notes) VALUES ($1,$2,'inspection',$3,'system','Inspect after cleaning')`, [hotel.id, t.room_id, t.priority]);
        }
      }
      if (t.task_type === 'inspection') await db.query(`UPDATE rooms SET hk_status = 'inspected' WHERE id = $1 AND hk_status <> 'out_of_order'`, [t.room_id]);
      if (t.service_request_id) await db.query(`UPDATE service_requests SET status = 'done', resolved_at = now() WHERE id = $1`, [t.service_request_id]);
      await db.query(`INSERT INTO audit_logs (hotel_id, actor_type, action, entity_type, entity_id, data) VALUES ($1,'system','hk.task_complete','hk_task',$2,$3)`,
        [hotel.id, t.id, JSON.stringify({ room_id: t.room_id, via: 'whatsapp', by: who.name, phone: msg.from })]);
      return `Thanks ${who.name}, room ${t.number} is marked done.`;
    }
    if (!['maintenance', 'any'].includes(who.team)) return `${who.name}, FIXED is for maintenance. Housekeeping should reply DONE <room>.`;
    if (!/^\d+$/.test(arg)) return 'Reply like this: FIXED 12 (the number from the alert).';
    const cur = await db.one(`SELECT * FROM maintenance_requests WHERE id = $1 AND hotel_id = $2 AND status IN ('open','in_progress') FOR UPDATE`, [Number(arg), hotel.id]);
    if (!cur) return `No open maintenance request ${arg}.`;
    await db.query(`UPDATE maintenance_requests SET status = 'resolved', resolved_at = now(), resolution_notes = $2 WHERE id = $1`, [cur.id, `Marked fixed on WhatsApp by ${who.name}`]);
    if (cur.room_id) await db.query(`UPDATE rooms SET hk_status = 'dirty', out_of_order_reason = NULL WHERE id = $1 AND hk_status = 'out_of_order'`, [cur.room_id]);
    if (cur.service_request_id) await db.query(`UPDATE service_requests SET status = 'done', resolved_at = now() WHERE id = $1`, [cur.service_request_id]);
    await db.query(`INSERT INTO audit_logs (hotel_id, actor_type, action, entity_type, entity_id, data) VALUES ($1,'system','maintenance.updated','maintenance',$2,$3)`,
      [hotel.id, cur.id, JSON.stringify({ status: 'resolved', via: 'whatsapp', by: who.name, phone: msg.from })]);
    return `Thanks ${who.name}, request ${cur.id} (${cur.title}) is marked fixed.`;
  });
  await reply(integ, msg.from, out, deps);
  return 'staff_command';
}

/** Process one webhook delivery. Returns a count per outcome (used by tests and logs). */
export async function processWhatsAppWebhook(hotel, integ, body, deps = {}) {
  const result = {};
  const bump = (k) => { result[k] = (result[k] || 0) + 1; };
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      if (v.metadata?.phone_number_id && String(v.metadata.phone_number_id) !== String(integ.whatsapp_phone_number_id)) continue; // not this hotel's number
      const names = Object.fromEntries((v.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
      for (const msg of v.messages || []) {
        if (['image', 'document'].includes(msg.type)) bump(await saveDocument(hotel, integ, msg, names[msg.from], deps));
        else if (msg.type === 'text') bump(await staffCommand(hotel, integ, msg, deps));
        else bump('ignored');
      }
    }
  }
  return result;
}

