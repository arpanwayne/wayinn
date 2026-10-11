import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { store } from '../lib/auth.jsx';
import { rupees, rupees0, label, fmtDate, ago } from '../lib/format.js';

const REQUESTS = [['towels', 'Fresh towels', '🧺'], ['housekeeping', 'Clean my room', '🧹'], ['amenity', 'Toiletries / amenities', '🧴'],
  ['maintenance', 'Something is broken', '🔧'], ['reception', 'Call me', '☎️'], ['checkout', 'Help with checkout', '🧳']];

export default function GuestPortal() {
  const { token } = useParams();
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState('menu');
  const [authed, setAuthed] = useState(!!store.get('wayinn.guest'));
  const [me, setMe] = useState(null);
  const [orders, setOrders] = useState([]);
  const [cart, setCart] = useState([]);
  const [cat, setCat] = useState('all');
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState('');
  const [placed, setPlaced] = useState([]); // orders sent from this device in this visit

  useEffect(() => { api.get(`/portal/${token}`, { scope: 'none' }).then(setInfo).catch((e) => setErr(e.message)); }, [token]);
  const loadMine = useCallback(async () => {
    if (!store.get('wayinn.guest')) return;
    try {
      const [m, o] = await Promise.all([api.get('/guest/me', { scope: 'guest' }), api.get('/guest/orders', { scope: 'guest' })]);
      setMe(m); setOrders(o); setAuthed(true);
    } catch { store.set('wayinn.guest', null); setAuthed(false); setMe(null); }
  }, []);
  useEffect(() => { loadMine(); const t = setInterval(loadMine, 20000); return () => clearInterval(t); }, [loadMine]);

  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(''), 4000); };
  const verify = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/portal/${token}/verify`, { code }, { scope: 'none' });
      store.set('wayinn.guest', r.token); setVerifyOpen(false); setCode(''); await loadMine(); flash(`Welcome, ${r.guest_name}!`);
    } catch (e) { flash(e.message); } finally { setBusy(false); }
  };
  const request = async (type) => {
    const message = type === 'maintenance' || type === 'amenity' ? prompt('Tell us a little more (optional)') : null;
    try { await api.post(`/portal/${token}/requests`, { type, message }, { scope: 'none' }); flash('Request sent — our team will be with you shortly.'); } catch (e) { flash(e.message); }
  };
  // Ordering needs only the room QR (the room must have a checked-in guest). The bill and order history stay behind the PIN.
  const placeOrder = async () => {
    setBusy(true);
    try {
      const body = { items: cart.map(({ menu_item_id, variant, quantity }) => ({ menu_item_id, variant, quantity })), notes: notes || null };
      const r = await api.post(`/portal/${token}/orders`, body, { scope: 'none' });
      setPlaced((p) => [{ ...r, items: cart.map((c) => `${c.quantity}× ${c.name}`).join(', '), at: new Date().toISOString() }, ...p]);
      setCart([]); setNotes(''); setTab('orders'); loadMine();
      flash(r.status === 'received' ? `Order ${r.order_no} sent — waiting for the hotel to confirm` : `Order ${r.order_no} sent to the kitchen`);
    } catch (e) { flash(e.message); } finally { setBusy(false); }
  };

  if (err) return <div className="flex min-h-screen items-center justify-center p-6 text-center text-ink-600">{err}</div>;
  if (!info) return <div className="flex min-h-screen items-center justify-center text-ink-400">Loading…</div>;
  const items = info.menu.items.filter((i) => cat === 'all' || i.category_id === Number(cat));
  const subtotal = cart.reduce((a, c) => a + c.unit * c.quantity, 0);
  const add = (i, variant) => {
    const v = variant || i.variants[0];
    const unit = v ? v.price_paise : i.price_paise;
    const key = `${i.id}:${v?.name || ''}`;
    setCart((c) => (c.some((x) => x.key === key) ? c.map((x) => (x.key === key ? { ...x, quantity: x.quantity + 1 } : x)) : [...c, { key, menu_item_id: i.id, name: i.name, variant: v?.name || null, unit, quantity: 1 }]));
  };

  return (
    <div className="mx-auto min-h-screen max-w-md bg-ink-50 pb-28">
      <header className="bg-brand-900 px-5 pb-6 pt-8 text-white">
        <div className="text-xs uppercase tracking-widest text-brand-200">{info.hotel.name}</div>
        <div className="mt-1 text-2xl font-extrabold">Room {info.room.number}</div>
        <div className="mt-1 text-sm text-brand-200">{me ? `Hi ${me.guest_name.split(' ')[0]} · checkout ${fmtDate(me.check_out)} by ${me.checkout_time?.slice(0, 5)}` : info.occupied ? 'Order food to your room, request service or view your bill' : 'This room has no active stay'}</div>
      </header>
      <nav className="sticky top-0 z-10 grid grid-cols-4 border-b border-ink-100 bg-white text-sm font-semibold">
        {[['menu', 'Menu'], ['requests', 'Requests'], ['orders', 'Orders'], ['bill', 'My stay']].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className={`py-3 ${tab === k ? 'border-b-2 border-brand-600 text-brand-700' : 'text-ink-500'}`}>{l}</button>
        ))}
      </nav>
      {msg && <div className="mx-4 mt-3 rounded-lg bg-ink-900 px-4 py-3 text-sm text-white">{msg}</div>}

      {tab === 'menu' && (
        <div className="p-4">
          <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
            <button onClick={() => setCat('all')} className={`badge shrink-0 px-3 py-1.5 ${cat === 'all' ? 'bg-ink-800 text-white' : 'bg-white ring-1 ring-ink-200'}`}>All</button>
            {info.menu.categories.map((c) => <button key={c.id} onClick={() => setCat(String(c.id))} className={`badge shrink-0 px-3 py-1.5 ${cat === String(c.id) ? 'bg-ink-800 text-white' : 'bg-white ring-1 ring-ink-200'}`}>{c.name}</button>)}
          </div>
          <div className="space-y-2">
            {items.map((i) => (
              <div key={i.id} className={`card p-3 ${i.available ? '' : 'opacity-50'}`}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-1.5 font-semibold">{i.is_veg !== null && <span className={`h-2.5 w-2.5 rounded-sm border-2 ${i.is_veg ? 'border-green-600' : 'border-red-600'}`} />}{i.name}</div>
                    {i.description && <div className="text-xs text-ink-500">{i.description}</div>}
                    {!i.variants.length && <div className="mt-1 text-sm">{rupees0(i.price_paise)}</div>}
                    {i.variants.length > 0 && !(i.available && info.occupied) && <div className="mt-1 text-sm">{i.variants.map((v) => `${v.name} ${rupees0(v.price_paise)}`).join(' · ')}</div>}
                  </div>
                  {i.available && info.occupied && !i.variants.length && <button className="btn-secondary btn-sm" onClick={() => add(i)}>Add</button>}
                  {!i.available && <span className="text-xs text-ink-400">Unavailable</span>}
                </div>
                {i.available && info.occupied && i.variants.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">{i.variants.map((v) => <button key={v.name} className="btn-secondary btn-sm" onClick={() => add(i, v)}>{v.name} · {rupees0(v.price_paise)}</button>)}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'requests' && (
        <div className="grid grid-cols-2 gap-3 p-4">
          {REQUESTS.map(([k, l, icon]) => (
            <button key={k} disabled={!info.occupied} onClick={() => request(k)} className="card flex flex-col items-center gap-2 p-5 text-sm font-semibold disabled:opacity-40">
              <span className="text-3xl">{icon}</span>{l}
            </button>
          ))}
          {info.hotel.phone && <a href={`tel:${info.hotel.phone}`} className="col-span-2 btn-secondary py-3">Call reception · {info.hotel.phone}</a>}
        </div>
      )}

      {tab === 'orders' && (
        <div className="space-y-2 p-4">
          {!authed ? <>
            {placed.map((o) => (
              <div key={o.id} className="card p-3">
                <div className="flex justify-between"><span className="font-semibold">{o.order_no}</span><span className="badge bg-brand-50 text-brand-700">{o.status === 'received' ? 'Waiting' : 'Sent to kitchen'}</span></div>
                <div className="text-sm text-ink-600">{o.items}</div>
                <div className="mt-1 flex justify-between text-xs text-ink-400"><span>{ago(o.at)}</span><span>{rupees(o.total_paise)} · on your room bill</span></div>
              </div>
            ))}
            <VerifyPrompt onClick={() => setVerifyOpen(true)} text="To see all your orders and their status, please confirm your stay." />
          </> : !orders.length ? <div className="py-10 text-center text-sm text-ink-400">No orders yet</div> : orders.map((o) => (
            <div key={o.id} className="card p-3">
              <div className="flex justify-between"><span className="font-semibold">{o.order_no}</span><span className="badge bg-brand-50 text-brand-700">{label(o.status)}</span></div>
              <div className="text-sm text-ink-600">{o.items?.map((i) => `${i.quantity}× ${i.name}`).join(', ')}</div>
              <div className="mt-1 flex justify-between text-xs text-ink-400"><span>{ago(o.created_at)}</span><span>{rupees(o.total_paise)}</span></div>
            </div>
          ))}
        </div>
      )}

      {tab === 'bill' && (
        <div className="p-4">
          {!authed ? <VerifyPrompt onClick={() => setVerifyOpen(true)} /> : me && (
            <div className="space-y-3">
              <div className="card p-4 text-sm">
                <div className="font-semibold">{me.guest_name}</div>
                <div className="text-ink-500">Booking {me.booking_ref} · {me.room_type}</div>
                <div className="text-ink-500">{fmtDate(me.check_in)} → {fmtDate(me.check_out)}</div>
              </div>
              {me.bill ? (
                <div className="card p-4 text-sm">
                  <div className="mb-2 font-semibold">Running bill</div>
                  {me.bill.lines.map((l, k) => <div key={k} className="flex justify-between gap-2 py-0.5"><span className="text-ink-600">{l.description}</span><span className="tabular-nums">{rupees(l.amount_paise + l.tax_paise)}</span></div>)}
                  <div className="mt-2 flex justify-between border-t border-ink-100 pt-2 font-semibold"><span>Total</span><span>{rupees(me.bill.totals.total_paise)}</span></div>
                  <div className="flex justify-between text-ink-500"><span>Paid</span><span>{rupees(me.bill.totals.paid_paise - me.bill.totals.refunded_paise)}</span></div>
                  <div className="flex justify-between font-bold"><span>Balance</span><span>{rupees(me.bill.totals.balance_paise)}</span></div>
                </div>
              ) : <div className="text-sm text-ink-500">Please ask reception for your bill.</div>}
              <button className="btn-secondary w-full" onClick={() => request('checkout')}>Request checkout</button>
              <button className="btn-ghost w-full text-xs" onClick={() => { store.set('wayinn.guest', null); setAuthed(false); setMe(null); }}>Sign out of this device</button>
            </div>
          )}
        </div>
      )}

      {cart.length > 0 && tab === 'menu' && (
        <div className="fixed inset-x-0 bottom-0 mx-auto max-w-md border-t border-ink-100 bg-white p-4 shadow-2xl">
          <div className="mb-2 max-h-32 space-y-1 overflow-y-auto text-sm">
            {cart.map((c) => (
              <div key={c.key} className="flex items-center justify-between">
                <span>{c.name}{c.variant && ` (${c.variant})`}</span>
                <span className="flex items-center gap-2">
                  <button className="h-6 w-6 rounded bg-ink-100" onClick={() => setCart(cart.map((x) => (x.key === c.key ? { ...x, quantity: x.quantity - 1 } : x)).filter((x) => x.quantity))}>−</button>
                  {c.quantity}
                  <button className="h-6 w-6 rounded bg-ink-100" onClick={() => setCart(cart.map((x) => (x.key === c.key ? { ...x, quantity: x.quantity + 1 } : x)))}>+</button>
                </span>
              </div>
            ))}
          </div>
          <input className="input mb-2" placeholder="Note for the kitchen (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <button className="btn-primary w-full py-3" disabled={busy} onClick={placeOrder}>Order · {rupees0(subtotal)} + {info.food_tax_rate}% GST · charged to room</button>
        </div>
      )}

      {verifyOpen && (
        <div className="fixed inset-0 z-20 flex items-end bg-ink-900/40" onClick={() => setVerifyOpen(false)}>
          <div className="mx-auto w-full max-w-md rounded-t-2xl bg-white p-5" onClick={(e) => e.stopPropagation()}>
            <div className="text-lg font-bold">Confirm it's you</div>
            <p className="mb-3 text-sm text-ink-500">Enter the 4-digit PIN from reception, or the last 4 digits of the phone number on your booking.</p>
            <input className="input text-center text-2xl tracking-[0.5em]" inputMode="numeric" maxLength={4} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus />
            <button className="btn-primary mt-3 w-full py-3" disabled={busy || code.length < 4} onClick={verify}>Continue</button>
          </div>
        </div>
      )}
    </div>
  );
}

function VerifyPrompt({ onClick, text = 'To protect your privacy, please confirm your stay first.' }) {
  return (
    <div className="card p-6 text-center">
      <div className="text-sm text-ink-600">{text}</div>
      <button className="btn-primary mt-3" onClick={onClick}>Verify my stay</button>
    </div>
  );
}
