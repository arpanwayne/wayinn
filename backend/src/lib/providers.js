// Senders for WhatsApp (Meta Cloud API), SMS (MSG91 flow) and email (SMTP).
// Each returns { ref } on success and throws ProviderError on failure. `retry` says if trying again later can help.
import nodemailer from 'nodemailer';
import { TEMPLATES, renderText } from './messages.js';

export class ProviderError extends Error {
  constructor(message, retry = true) { super(message); this.retry = retry; }
}

const GRAPH = () => `https://graph.facebook.com/${process.env.WHATSAPP_GRAPH_VERSION || 'v22.0'}`;

async function readJson(res) {
  const t = await res.text();
  try { return JSON.parse(t); } catch { return { raw: t.slice(0, 300) }; }
}

export async function sendWhatsApp(integ, to, template, payload, fetchImpl = fetch) {
  const t = TEMPLATES[template];
  if (!t) throw new ProviderError(`Unknown template ${template}`, false);
  const body = {
    messaging_product: 'whatsapp', to, type: 'template',
    template: {
      name: template, language: { code: integ.whatsapp_language || 'en' },
      components: [{ type: 'body', parameters: t.params(payload).map((v) => ({ type: 'text', text: String(v ?? '-') || '-' })) }],
    },
  };
  return postWhatsApp(integ, body, fetchImpl);
}

/** Meta's ready-made "hello_world" template: used by the super admin's "Send test message". */
export async function sendWhatsAppHello(integ, to, fetchImpl = fetch) {
  return postWhatsApp(integ, { messaging_product: 'whatsapp', to, type: 'template', template: { name: 'hello_world', language: { code: 'en_US' } } }, fetchImpl);
}

/** Free-form reply. WhatsApp only allows this within 24 hours of the person's last message to the hotel. */
export async function sendWhatsAppText(integ, to, text, fetchImpl = fetch) {
  return postWhatsApp(integ, { messaging_product: 'whatsapp', to, type: 'text', text: { body: String(text).slice(0, 1000) } }, fetchImpl);
}

export const MAX_DOC_BYTES = 10 * 1024 * 1024;

/** Download a photo / PDF a guest sent. Two calls: media id → temporary URL, then the file itself (both need the token). */
export async function downloadWhatsAppMedia(integ, mediaId, fetchImpl = fetch) {
  const auth = { authorization: `Bearer ${integ.whatsapp_token}` };
  let meta;
  try {
    const res = await fetchImpl(`${GRAPH()}/${encodeURIComponent(mediaId)}`, { headers: auth });
    meta = await readJson(res);
    if (!res.ok || !meta?.url) throw new ProviderError(`WhatsApp media: ${meta?.error?.message || `HTTP ${res.status}`}`, res.status === 429 || res.status >= 500);
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError(`WhatsApp not reachable: ${e.message}`);
  }
  if (Number(meta.file_size) > MAX_DOC_BYTES) throw new ProviderError('File is larger than 10 MB', false);
  let file;
  try {
    file = await fetchImpl(meta.url, { headers: auth });
  } catch (e) { throw new ProviderError(`WhatsApp not reachable: ${e.message}`); }
  if (!file.ok) throw new ProviderError(`WhatsApp media download: HTTP ${file.status}`, file.status === 429 || file.status >= 500);
  const data = Buffer.from(await file.arrayBuffer());
  if (data.length > MAX_DOC_BYTES) throw new ProviderError('File is larger than 10 MB', false);
  return { data, mime: String(meta.mime_type || file.headers.get('content-type') || '').split(';')[0] };
}

async function postWhatsApp(integ, body, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(`${GRAPH()}/${integ.whatsapp_phone_number_id}/messages`, {
      method: 'POST', headers: { authorization: `Bearer ${integ.whatsapp_token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
  } catch (e) { throw new ProviderError(`WhatsApp not reachable: ${e.message}`); }
  const data = await readJson(res);
  if (!res.ok) {
    const msg = data?.error?.message || data?.raw || `HTTP ${res.status}`;
    // 4xx = bad number, template not approved, expired token… trying again will not help. 429/5xx might.
    throw new ProviderError(`WhatsApp: ${msg}`, res.status === 429 || res.status >= 500);
  }
  return { ref: data?.messages?.[0]?.id || null };
}

export async function sendSms(integ, to, template, payload, fetchImpl = fetch) {
  const flowId = integ.sms_templates?.[template];
  if (!flowId) throw new ProviderError(`No SMS (DLT) template id set for "${template}"`, false);
  const vars = Object.fromEntries(TEMPLATES[template].params(payload).map((v, n) => [`var${n + 1}`, String(v ?? '')]));
  let res;
  try {
    res = await fetchImpl('https://control.msg91.com/api/v5/flow', {
      method: 'POST', headers: { authkey: integ.sms_auth_key, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ template_id: flowId, short_url: '0', recipients: [{ mobiles: to, ...vars }] }),
    });
  } catch (e) { throw new ProviderError(`SMS not reachable: ${e.message}`); }
  const data = await readJson(res);
  if (!res.ok || data?.type === 'error') throw new ProviderError(`SMS: ${data?.message || data?.raw || `HTTP ${res.status}`}`, res.status >= 500);
  return { ref: data?.request_id || data?.message || null };
}

export async function sendEmail(integ, to, template, payload, transportFactory = nodemailer.createTransport) {
  const t = TEMPLATES[template];
  const transport = transportFactory({
    host: integ.smtp_host, port: integ.smtp_port || 587, secure: Number(integ.smtp_port) === 465,
    auth: integ.smtp_user ? { user: integ.smtp_user, pass: integ.smtp_pass } : undefined,
  });
  try {
    const info = await transport.sendMail({ from: integ.email_from, to, subject: t.subject(payload), text: renderText(template, payload) });
    return { ref: info?.messageId || null };
  } catch (e) {
    // 5xx SMTP replies (bad address, rejected) are final; network problems and 4xx are temporary.
    throw new ProviderError(`Email: ${e.message}`, !(e.responseCode >= 500));
  }
}
