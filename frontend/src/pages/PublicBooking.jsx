import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { rupees0, todayStr, addDays, nights } from '../lib/format.js';
import { Logo } from '../components/Layout.jsx';

export default function PublicBooking() {
  const { slug } = useParams();
  const [hotel, setHotel] = useState(null);
  const [err, setErr] = useState('');
  const [from, setFrom] = useState(todayStr());
  const [to, setTo] = useState(addDays(todayStr(), 1));
  const [avail, setAvail] = useState(null);
  const [sel, setSel] = useState(null);
  const [form, setForm] = useState({ full_name: '', phone: '', email: '', adults: 2, children: 0, rooms: 1, special_requests: '' });
  const [done, setDone] = useState(null);
  const [busy, setBusy] = useState(false);
  const opt = { scope: 'none' };

  useEffect(() => { api.get(`/public/hotels/${slug}`, opt).then((h) => { setHotel(h); setFrom(h.today); setTo(addDays(h.today, 1)); }).catch((e) => setErr(e.message)); }, [slug]); // eslint-disable-line
  useEffect(() => {
    if (!hotel || to <= from) return;
    setAvail(null);
    api.get(`/public/hotels/${slug}/availability?from=${from}&to=${to}`, opt).then(setAvail).catch((e) => setErr(e.message));
  }, [hotel, from, to]); // eslint-disable-line

  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const r = await api.post(`/public/hotels/${slug}/booking-requests`, { ...form, adults: Number(form.adults), children: Number(form.children), rooms: Number(form.rooms),
        room_type_id: sel.id, check_in_date: from, check_out_date: to, email: form.email || null }, opt);
      setDone(r);
    } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };

  if (!hotel) return <div className="flex min-h-screen items-center justify-center text-ink-500">{err || 'Loading…'}</div>;
  const n = nights(from, to);
  const types = Object.fromEntries(hotel.room_types.map((t) => [t.id, t]));
  return (
    <div className="min-h-screen">
      <header className="bg-night-900 px-4 py-10 text-white">
        <div className="mx-auto max-w-4xl">
          <h1 className="text-3xl font-extrabold">{hotel.name}</h1>
          <p className="mt-1 text-night-100">{[hotel.address, hotel.city].filter(Boolean).join(', ')}</p>
          <p className="text-sm text-night-100">Check-in {hotel.checkin_time.slice(0, 5)} · Check-out {hotel.checkout_time.slice(0, 5)} {hotel.phone && `· ${hotel.phone}`}</p>
        </div>
      </header>
      <main className="mx-auto max-w-4xl space-y-5 px-4 py-6">
        {done ? (
          <div className="card p-8 text-center">
            <div className="text-4xl">✓</div>
            <h2 className="mt-2 text-xl">Request received</h2>
            <p className="mt-1 text-ink-600">Reference <b>{done.ref}</b>. {done.message}</p>
            {hotel.phone && <p className="mt-3 text-sm text-ink-500">Questions? Call {hotel.phone}</p>}
          </div>
        ) : (
          <>
            <div className="card grid grid-cols-2 gap-3 p-4 sm:grid-cols-3">
              <label><span className="label">Check-in</span><input type="date" className="input" min={hotel.today} value={from} onChange={(e) => { setFrom(e.target.value); if (to <= e.target.value) setTo(addDays(e.target.value, 1)); }} /></label>
              <label><span className="label">Check-out</span><input type="date" className="input" min={addDays(from, 1)} value={to} onChange={(e) => setTo(e.target.value)} /></label>
              <div className="col-span-2 self-end text-sm text-ink-500 sm:col-span-1">{n} night{n > 1 ? 's' : ''}</div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {!avail ? <div className="text-ink-400">Checking availability…</div> : avail.map((a) => {
                const t = types[a.id];
                return (
                  <button key={a.id} disabled={!a.available} onClick={() => setSel(a)} className={`card p-4 text-left transition ${sel?.id === a.id ? 'ring-2 ring-brand-600' : ''} disabled:opacity-50`}>
                    <div className="flex items-start justify-between"><div className="text-lg font-bold">{a.name}</div><div className="text-right"><div className="font-bold">{rupees0(a.base_rate_paise)}</div><div className="text-xs text-ink-500">per night + GST</div></div></div>
                    {t?.description && <p className="mt-1 text-sm text-ink-600">{t.description}</p>}
                    <div className="mt-2 text-xs text-ink-500">Up to {a.max_occupancy} guests · {t?.amenities.join(' · ')}</div>
                    <div className={`mt-2 text-xs font-semibold ${a.available ? 'text-brand-700' : 'text-red-600'}`}>{a.available ? (a.available < 3 ? `Only ${a.available} left` : 'Available') : 'Sold out'}</div>
                  </button>
                );
              })}
            </div>
            {sel && (
              <form onSubmit={submit} className="card grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
                <h2 className="sm:col-span-2">Your details — {sel.name}, {n} night(s), est. {rupees0(sel.base_rate_paise * n * form.rooms)} + GST</h2>
                <label><span className="label">Full name</span><input className="input" required value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} /></label>
                <label><span className="label">Mobile number</span><input className="input" required type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label>
                <label><span className="label">Email (optional)</span><input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
                <div className="grid grid-cols-3 gap-2">
                  <label><span className="label">Rooms</span><input type="number" min={1} max={Math.min(5, sel.available)} className="input" value={form.rooms} onChange={(e) => setForm({ ...form, rooms: e.target.value })} /></label>
                  <label><span className="label">Adults</span><input type="number" min={1} className="input" value={form.adults} onChange={(e) => setForm({ ...form, adults: e.target.value })} /></label>
                  <label><span className="label">Children</span><input type="number" min={0} className="input" value={form.children} onChange={(e) => setForm({ ...form, children: e.target.value })} /></label>
                </div>
                <label className="sm:col-span-2"><span className="label">Special requests</span><textarea className="input" rows={2} value={form.special_requests} onChange={(e) => setForm({ ...form, special_requests: e.target.value })} /></label>
                {err && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 sm:col-span-2">{err}</div>}
                <button className="btn-primary py-3 sm:col-span-2" disabled={busy}>Request booking</button>
                <p className="text-xs text-ink-500 sm:col-span-2">This is a booking request. The hotel will confirm availability and contact you. No payment is taken now.</p>
              </form>
            )}
          </>
        )}
        <div className="flex justify-center pt-6 opacity-60"><Logo /></div>
      </main>
    </div>
  );
}
