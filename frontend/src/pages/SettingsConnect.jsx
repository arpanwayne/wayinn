// Setup → "Messages & payments" and "Online channels" (owner only).
import { useEffect, useState } from 'react';
import { useApi } from '../lib/hooks.js';
import { api } from '../lib/api.js';
import { fmtDateTime, label } from '../lib/format.js';
import { Loading, Field, Badge, Modal, Empty, useAction } from '../components/ui.jsx';

const TEMPLATE_NAMES = {
  booking_confirmation: 'Booking confirmed', checkin_welcome: 'Check-in welcome', deposit_received: 'Advance received', room_checkout_alert: 'Room checked out (staff)',
};

const CHANNEL_NAMES = { whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email' };

function Connected({ on, children }) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-ink-100 px-3 py-2.5">
      <span className="text-sm font-semibold">{children}</span>
      <Badge status={on ? 'active' : 'cancelled'}>{on ? 'Connected' : 'Not connected'}</Badge>
    </div>
  );
}

export function MessagesPayments() {
  const hotel = useApi('/hotel');
  const integ = useApi('/hotel/integrations');
  const log = useApi('/hotel/messages', { interval: 30000 });
  const [f, setF] = useState(null);
  const [run, busy] = useAction();
  useEffect(() => {
    if (!hotel.data) return;
    const s = hotel.data.settings || {};
    setF({
      notifications: { whatsapp: false, sms: false, email: false, ...(s.notifications || {}) },
      phones: (s.staff_alert_phones || []).join('\n'),
      staff_alert_channel: s.staff_alert_channel || 'whatsapp',
      checkout_alert: s.checkout_alert !== false,
      deposit_mode: s.online_deposit?.mode || 'off',
      deposit_percent: s.online_deposit?.percent || 25,
    });
  }, [hotel.data]);
  if (!f || !integ.data) return <Loading />;
  const st = integ.data;
  const setN = (k, v) => setF({ ...f, notifications: { ...f.notifications, [k]: v } });
  const save = () => run(async () => {
    const phones = f.phones.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
    await api.put('/hotel', {
      settings: {
        notifications: f.notifications, staff_alert_phones: phones, staff_alert_channel: f.staff_alert_channel, checkout_alert: f.checkout_alert,
        online_deposit: { mode: f.deposit_mode, percent: Number(f.deposit_percent) || 25 },
      },
    });
    hotel.reload();
  }, 'Saved');
  return (
    <div className="space-y-5">
      <div className="card p-4">
        <h2>Connections</h2>
        <p className="mb-3 text-xs text-ink-500">Every hotel uses its own WhatsApp number and its own Razorpay account, so messages come from your name and payments reach your bank. Wayne E Solutions adds the keys for you — send them to your account manager.</p>
        <div className="grid gap-2 sm:grid-cols-4">
          <Connected on={st.whatsapp}>WhatsApp</Connected><Connected on={st.sms}>SMS</Connected>
          <Connected on={st.email}>Email</Connected><Connected on={st.razorpay}>Razorpay</Connected>
        </div>
      </div>

      <div className="card p-4">
        <h2>Messages to guests</h2>
        <p className="mb-3 text-xs text-ink-500">Booking confirmation, check-in welcome (with the room QR PIN) and advance-payment receipt. WhatsApp is used when it is on; SMS only when WhatsApp is off.</p>
        <div className="flex flex-wrap gap-5 text-sm">
          {[['whatsapp', 'WhatsApp'], ['sms', 'SMS'], ['email', 'Email']].map(([k, l]) => (
            <label key={k} className="flex items-center gap-2"><input type="checkbox" checked={!!f.notifications[k]} onChange={(e) => setN(k, e.target.checked)} />
              {l}{!st[k] && <span className="text-xs text-amber-600">(not connected yet)</span>}</label>
          ))}
        </div>
      </div>

      <div className="card p-4">
        <h2>Housekeeping & maintenance alerts</h2>
        <p className="mb-3 text-xs text-ink-500">These staff have no login. When a guest checks out, each number below gets a message: which room is free, whether a guest arrives in it today, and any open maintenance issue on that room. A cleaning task is also added in Housekeeping, as before.</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Mobile numbers (one per line, max 10)" className="sm:col-span-2">
            <textarea className="input" rows={3} placeholder={'98765 43210\n91234 56789'} value={f.phones} onChange={(e) => setF({ ...f, phones: e.target.value })} />
          </Field>
          <div className="space-y-3">
            <Field label="Send by"><select className="input" value={f.staff_alert_channel} onChange={(e) => setF({ ...f, staff_alert_channel: e.target.value })}>
              <option value="whatsapp">WhatsApp</option><option value="sms">SMS</option></select></Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.checkout_alert} onChange={(e) => setF({ ...f, checkout_alert: e.target.checked })} /> Alert on every checkout</label>
          </div>
        </div>
      </div>

      <div className="card p-4">
        <h2>Advance payment on the booking page</h2>
        <p className="mb-3 text-xs text-ink-500">Guests booking on your website pay with Razorpay (UPI, cards, net banking). When the payment succeeds and rooms are free, the booking is confirmed on its own and the advance shows on the guest's bill.</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Ask for"><select className="input" value={f.deposit_mode} onChange={(e) => setF({ ...f, deposit_mode: e.target.value })} disabled={!st.razorpay}>
            <option value="off">No online payment (request only)</option><option value="first_night">First night</option>
            <option value="percent">A percentage of the stay</option><option value="full">Full stay</option></select></Field>
          {f.deposit_mode === 'percent' && <Field label="Percent"><input type="number" min={1} max={100} className="input" value={f.deposit_percent} onChange={(e) => setF({ ...f, deposit_percent: e.target.value })} /></Field>}
          {!st.razorpay && <p className="self-end text-xs text-amber-600 sm:col-span-2">Razorpay is not connected yet.</p>}
        </div>
      </div>

      <div className="flex justify-end"><button className="btn-primary" disabled={busy} onClick={save}>Save</button></div>

      <div className="card overflow-x-auto">
        <h2 className="px-4 pt-4">Recent messages</h2>
        {!log.data?.length ? <Empty>No messages yet</Empty> : (
          <table className="table"><thead><tr><th>When</th><th>Message</th><th>To</th><th>By</th><th>Status</th></tr></thead>
            <tbody>{log.data.map((m) => (
              <tr key={m.id}>
                <td className="whitespace-nowrap text-ink-500">{fmtDateTime(m.created_at)}</td>
                <td>{TEMPLATE_NAMES[m.template] || label(m.template)}{m.guest_name && <div className="text-xs text-ink-500">{m.guest_name}</div>}</td>
                <td className="tabular-nums">{m.recipient}</td><td>{CHANNEL_NAMES[m.channel] || m.channel}</td>
                <td><Badge status={m.status} />{m.error && m.status !== 'sent' && <div className="mt-1 max-w-xs text-xs text-ink-500">{m.error}</div>}</td>
              </tr>
            ))}</tbody></table>
        )}
      </div>
    </div>
  );
}

export function OnlineChannels() {
  const { data, reload } = useApi('/hotel/integrations');
  const [run, busy] = useAction();
  const [newKey, setNewKey] = useState(null);
  if (!data) return <Loading />;
  const copy = (t) => navigator.clipboard?.writeText(t);
  return (
    <div className="space-y-5">
      <div className="card p-4 text-sm">
        <h2>MakeMyTrip, Goibibo, OYO, Booking.com, Agoda</h2>
        <p className="mt-1 text-ink-600">These sites only connect through an approved <b>channel manager</b> (for example STAAH, eZee, AxisRooms or RateGain). Sign up with one of them; they connect your OTA accounts. Then give them the two things below. After that, OTA bookings appear in Wayinn on their own (source shows as MakeMyTrip, OYO…), cancellations and date changes come through too, and the OTAs see how many rooms you have left.</p>
      </div>
      <div className="card p-4">
        <h2>Channel-manager connection</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div><span className="label">API address</span><div className="flex gap-2"><input className="input" readOnly value={data.channel_api_base} /><button className="btn-secondary btn-sm" onClick={() => copy(data.channel_api_base)}>Copy</button></div></div>
          <div><span className="label">API key</span>
            <div className="flex items-center gap-2">
              <div className="input bg-ink-50">{data.channel_key_hint ? `wyn_••••${data.channel_key_hint}` : 'No key yet'}</div>
              <button className="btn-primary btn-sm whitespace-nowrap" disabled={busy} onClick={() => (!data.channel_key_hint || window.confirm('Make a new key? The channel manager stops working until you give it the new key.')) && run(async () => { setNewKey((await api.post('/hotel/channel-key')).key); reload(); })}>
                {data.channel_key_hint ? 'New key' : 'Create key'}</button>
              {data.channel_key_hint && <button className="btn-ghost btn-sm text-red-700" onClick={() => window.confirm('Remove the key? OTA bookings stop coming in.') && run(async () => { await api.del('/hotel/channel-key'); reload(); }, 'Key removed — the channel manager is disconnected')}>Remove</button>}
            </div>
          </div>
        </div>
        <p className="mt-2 text-xs text-ink-500">Making a new key stops the old one straight away. The technical guide for the channel manager is in the Wayinn README ("Channel-manager API").</p>
      </div>
      <div className="card p-4">
        <h2>Calendar links (iCal)</h2>
        <p className="mb-3 text-xs text-ink-500">For sites that accept a calendar link, such as Airbnb and Booking.com: paste the link for each room type in the site's calendar settings. Nights when that room type is full are closed there automatically (the site checks the link every few hours).</p>
        {!data.ical_enabled ? <button className="btn-primary" disabled={busy} onClick={() => run(async () => { await api.post('/hotel/ical-token'); reload(); })}>Create calendar links</button> : (
          <div className="space-y-2">
            {data.ical_links.map((l) => (
              <div key={l.url} className="flex items-center gap-2 text-sm"><span className="w-28 shrink-0 font-semibold">{l.room_type}</span>
                <input className="input" readOnly value={l.url} /><button className="btn-secondary btn-sm" onClick={() => copy(l.url)}>Copy</button></div>
            ))}
            <button className="btn-ghost btn-sm text-red-700" onClick={() => run(async () => { await api.del('/hotel/ical-token'); reload(); }, 'Calendar links switched off')}>Switch off links</button>
          </div>
        )}
      </div>
      <Modal open={!!newKey} onClose={() => setNewKey(null)} title="Your new API key"
        footer={<><button className="btn-secondary" onClick={() => copy(newKey)}>Copy</button><button className="btn-primary" onClick={() => setNewKey(null)}>Done</button></>}>
        <p className="mb-2 text-sm text-ink-600">Copy it now and give it to your channel manager. It is shown only once.</p>
        <div className="break-all rounded-xl bg-ink-50 p-3 font-mono text-sm">{newKey}</div>
      </Modal>
    </div>
  );
}
