// Super admin: one hotel's own WhatsApp / SMS / email / Razorpay keys. Secrets are never shown again after saving:
// the box shows the last 4 characters, and leaving it empty keeps the saved value.
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Field, Badge, useAction } from './ui.jsx';

const P = { scope: 'platform' };
const SECRETS = ['whatsapp_token', 'sms_auth_key', 'smtp_pass', 'razorpay_key_secret', 'razorpay_webhook_secret'];
const PLAIN = ['whatsapp_phone_number_id', 'whatsapp_language', 'smtp_host', 'smtp_user', 'email_from', 'razorpay_key_id'];
const TEMPLATES = [['booking_confirmation', 'Booking confirmed'], ['checkin_welcome', 'Check-in welcome'], ['deposit_received', 'Advance received'], ['room_checkout_alert', 'Room checked out (staff)']];

export default function HotelKeys({ hotelId }) {
  const [saved, setSaved] = useState(null);
  const [f, setF] = useState(null);
  const [testTo, setTestTo] = useState('');
  const [run, busy] = useAction();
  const fill = (d) => {
    setSaved(d);
    setF({ ...Object.fromEntries(PLAIN.map((k) => [k, d[k] || ''])), ...Object.fromEntries(SECRETS.map((k) => [k, ''])),
      smtp_port: d.smtp_port || '', sms_templates: { ...(d.sms_templates || {}) } });
  };
  useEffect(() => { api.get(`/platform/hotels/${hotelId}/integrations`, P).then(fill); }, [hotelId]);
  if (!f) return <div className="text-ink-400">Loading keys…</div>;
  const set = (p) => setF({ ...f, ...p });
  const secret = (k, l) => (
    <Field label={l}><input className="input" type="password" autoComplete="new-password" placeholder={saved[k] || 'not set'} value={f[k]} onChange={(e) => set({ [k]: e.target.value })} /></Field>
  );
  const plain = (k, l, ph) => <Field label={l}><input className="input" placeholder={ph} value={f[k]} onChange={(e) => set({ [k]: e.target.value.trim() })} /></Field>;
  const save = () => run(async () => {
    const body = { ...Object.fromEntries(PLAIN.map((k) => [k, f[k] || null])), smtp_port: f.smtp_port ? Number(f.smtp_port) : null,
      sms_templates: Object.fromEntries(Object.entries(f.sms_templates).filter(([, v]) => v?.trim()).map(([k, v]) => [k, v.trim()])) };
    for (const k of SECRETS) if (f[k]) body[k] = f[k];
    body.whatsapp_language = f.whatsapp_language || 'en';
    fill(await api.put(`/platform/hotels/${hotelId}/integrations`, body, P));
  }, 'Keys saved');
  const st = saved.status;
  return (
    <div className="space-y-4 rounded-xl border border-ink-100 p-3">
      <div className="flex flex-wrap items-center gap-2"><span className="font-semibold">Hotel's own keys</span>
        {[['whatsapp', 'WhatsApp'], ['sms', 'SMS'], ['email', 'Email'], ['razorpay', 'Razorpay']].map(([k, l]) => <Badge key={k} status={st[k] ? 'active' : 'cancelled'}>{l}{st[k] ? ' ✓' : ''}</Badge>)}</div>

      <div className="grid gap-3 sm:grid-cols-3">
        {plain('whatsapp_phone_number_id', 'WhatsApp phone number ID', 'from WhatsApp Manager → API setup')}
        {secret('whatsapp_token', 'WhatsApp access token (permanent)')}
        {plain('whatsapp_language', 'Template language', 'en')}
        <div className="flex items-end gap-2 sm:col-span-3">
          <Field label="Send test (Meta hello_world)"><input className="input" placeholder="Mobile number" value={testTo} onChange={(e) => setTestTo(e.target.value)} /></Field>
          <button className="btn-secondary" disabled={busy || !st.whatsapp || !testTo} onClick={() => run(() => api.post(`/platform/hotels/${hotelId}/integrations/test-whatsapp`, { to: testTo }, P), 'Test message sent')}>Send test</button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {secret('sms_auth_key', 'MSG91 auth key')}
        {TEMPLATES.map(([k, l]) => (
          <Field key={k} label={`SMS template id — ${l}`}><input className="input" value={f.sms_templates[k] || ''} onChange={(e) => set({ sms_templates: { ...f.sms_templates, [k]: e.target.value } })} /></Field>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {plain('smtp_host', 'SMTP host', 'smtp.gmail.com')}
        <Field label="SMTP port"><input className="input" inputMode="numeric" placeholder="587" value={f.smtp_port} onChange={(e) => set({ smtp_port: e.target.value.replace(/\D/g, '') })} /></Field>
        {plain('email_from', 'From address', 'Hotel Name <bookings@hotel.in>')}
        {plain('smtp_user', 'SMTP user')}
        {secret('smtp_pass', 'SMTP password')}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {plain('razorpay_key_id', 'Razorpay key id', 'rzp_live_…')}
        {secret('razorpay_key_secret', 'Razorpay key secret')}
        {secret('razorpay_webhook_secret', 'Razorpay webhook secret')}
        <div className="text-xs text-ink-500 sm:col-span-3">Webhook URL for the hotel's Razorpay dashboard (events: payment.captured, order.paid): <code className="break-all">{saved.razorpay_webhook_url}</code></div>
      </div>
      <div className="flex justify-end"><button className="btn-primary" disabled={busy} onClick={save}>Save keys</button></div>
    </div>
  );
}
