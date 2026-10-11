import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../lib/hooks.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { rupees, fmtDate, fmtDateLong, ago } from '../lib/format.js';
import { PageHeader, Badge, Empty, Loading, ReasonDialog, useAction, useToast } from '../components/ui.jsx';
import { CheckInDialog, CheckOutDialog } from '../components/stay.jsx';

// The hero: every room as a key on the rack, so the whole house reads at a glance.
const KEY = {
  occupied: 'bg-amber-400 text-night-950', reserved: 'bg-violet-400/90 text-night-950', available: 'text-white ring-1 ring-inset ring-white/25',
  dirty: 'bg-white/15 text-amber-200 ring-1 ring-inset ring-amber-300/60', cleaning: 'bg-white/15 text-amber-200 ring-1 ring-inset ring-amber-300/60',
  inspected: 'text-white ring-1 ring-inset ring-brand-300/70', out_of_order: 'bg-red-500/85 text-white',
};
const KEY_LEGEND = [['occupied', 'Occupied'], ['available', 'Vacant'], ['reserved', 'Arriving today'], ['dirty', 'Needs cleaning'], ['out_of_order', 'Out of order']];

function KeyRack({ counts: c, rooms }) {
  const sellable = c.total_rooms - c.out_of_order;
  const pct = sellable ? Math.round((c.occupied / sellable) * 100) : 0;
  const floors = [...new Set(rooms.map((r) => r.floor || ''))];
  const facts = [
    [c.arrivals_pending, 'arrivals left', c.unallocated_arrivals ? `${c.unallocated_arrivals} without a room` : null],
    [c.departures_pending, 'departures left', null],
    [c.dirty, 'rooms to clean', null],
  ];
  return (
    <div className="hero">
      <div className="relative z-10 grid gap-8 p-6 sm:p-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="flex flex-col justify-between gap-6">
          <div>
            <div className="num text-6xl leading-none sm:text-7xl">{c.occupied}<span className="text-night-400">/{sellable}</span></div>
            <div className="mt-2 text-night-200">rooms occupied tonight · {pct}% full · {c.vacant} vacant</div>
          </div>
          <div className="flex flex-wrap gap-x-8 gap-y-3">
            {facts.map(([n, l, warn]) => (
              <div key={l}>
                <div className={`num text-2xl ${n ? 'text-white' : 'text-night-400'}`}>{n}</div>
                <div className="text-sm text-night-300">{l}</div>
                {warn && <div className="text-xs font-semibold text-amber-300">{warn}</div>}
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="space-y-2">
            {floors.map((fl) => (
              <div key={fl} className="flex items-start gap-3">
                <div className="w-14 shrink-0 pt-2 text-xs text-night-300">{fl ? `Floor ${fl}` : 'Rooms'}</div>
                <div className="flex flex-wrap gap-1.5">
                  {rooms.filter((r) => (r.floor || '') === fl).map((r) => (
                    <Link key={r.id} to={r.booking_id ? `/bookings/${r.booking_id}` : '/rooms'} title={`${r.number} · ${r.room_type} · ${r.guest_name || r.arriving_guest || r.display_status.replace(/_/g, ' ')}`}
                      className={`num relative flex h-10 w-12 items-center justify-center rounded-lg text-sm transition hover:-translate-y-0.5 ${KEY[r.display_status] || KEY.available}`}>
                      {r.number}
                      {r.due_out && <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-night-900" />}
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 pl-[4.25rem] text-xs text-night-300">
            {KEY_LEGEND.map(([k, l]) => <span key={k} className="flex items-center gap-1.5"><span className={`h-3 w-3 rounded ${KEY[k]}`} />{l}</span>)}
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-red-500" />Due out today</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ title, count, children, action }) {
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-ink-100 px-4 py-3.5">
        <h2 className="flex items-center gap-2">{title}{count !== undefined && <span className={`num rounded-full px-2 py-0.5 text-xs ${count ? 'bg-amber-100 text-amber-600' : 'bg-ink-100 text-ink-400'}`}>{count}</span>}</h2>
        {action}
      </div>
      {children}
    </div>
  );
}

export default function FrontDesk() {
  const { can } = useAuth();
  const { data, reload } = useApi('/frontdesk', { interval: 30000 });
  const alerts = useApi('/alerts', { interval: 60000 });
  const requests = useApi(can('requests.view') ? '/requests' : null, { interval: 30000, skip: !can('requests.view') });
  const handover = useApi('/hotel/handover');
  const board = useApi('/rooms/board', { interval: 30000 });
  // Room orders are for information: they are already with the kitchen and on the room bill.
  const orders = useApi(can('pos.order') ? '/orders?active=1' : null, { interval: 15000, skip: !can('pos.order') });
  const toast = useToast();
  const seenOrders = useRef(null);
  const [cancelOrder, setCancelOrder] = useState(null);
  useEffect(() => {
    if (!orders.data) return;
    const ids = new Set(orders.data.map((o) => o.id));
    if (seenOrders.current) {
      orders.data.filter((o) => o.source === 'guest_qr' && !seenOrders.current.has(o.id))
        .forEach((o) => toast(`Room ${o.room_number} ordered food (${o.order_no}) — sent to kitchen, added to room bill`));
    }
    seenOrders.current = ids;
  }, [orders.data, toast]);
  const [checkIn, setCheckIn] = useState(null);
  const [checkOut, setCheckOut] = useState(null);
  const [note, setNote] = useState('');
  const [run] = useAction();

  if (!data) return <Loading />;
  const c = data.counts;
  const openReq = (requests.data || []).filter((r) => r.status !== 'done' && r.status !== 'cancelled');
  const roomOrders = (orders.data || []).filter((o) => o.order_type === 'room_service' && !['delivered', 'cancelled'].includes(o.status));
  return (
    <div className="space-y-5">
      <PageHeader title="Front desk" subtitle={fmtDateLong(data.today)}
        actions={can('bookings.create') && <>
          <Link to="/bookings/new?walkin=1" className="btn-primary">+ Walk-in</Link>
          <Link to="/bookings/new" className="btn-secondary">+ Reservation</Link>
        </>} />
      <KeyRack counts={c} rooms={board.data || []} />

      {alerts.data?.length > 0 && (
        <div className="card divide-y divide-ink-50">
          {alerts.data.slice(0, 6).map((a, i) => (
            <div key={i} className="flex items-start gap-3 px-4 py-2.5 text-sm">
              <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${a.severity === 'high' ? 'bg-red-500' : 'bg-amber-400'}`} />
              <span>{a.message}</span>
            </div>
          ))}
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-2">
        <Section title="Arrivals" count={data.arrivals.length}>
          {!data.arrivals.length ? <Empty>No pending arrivals</Empty> : (
            <table className="table"><tbody>
              {data.arrivals.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Link to={`/bookings/${s.booking_id}`} className="font-semibold hover:underline">{s.guest_name}</Link>
                    <div className="text-xs text-ink-500">{s.ref} · {s.room_type} · {s.adults + s.children} pax {s.check_in_date < data.today && <span className="text-red-600">· due {fmtDate(s.check_in_date)}</span>}</div>
                    {s.special_requests && <div className="mt-0.5 text-xs text-amber-600">★ {s.special_requests}</div>}
                  </td>
                  <td className="whitespace-nowrap">{s.room_number ? <span className="font-semibold">{s.room_number}</span> : <Badge status="pending">No room</Badge>}
                    {s.room_number && !['ready', 'inspected'].includes(s.hk_status) && <div><Badge status={s.hk_status} /></div>}</td>
                  <td className="text-right">{can('bookings.checkin') && <button className="btn-primary btn-sm" onClick={() => setCheckIn(s)}>Check in</button>}</td>
                </tr>
              ))}
            </tbody></table>
          )}
        </Section>

        <Section title="Departures" count={data.departures.length}>
          {!data.departures.length ? <Empty>No pending departures</Empty> : (
            <table className="table"><tbody>
              {data.departures.map((s) => (
                <tr key={s.id}>
                  <td><span className="font-semibold">{s.room_number}</span></td>
                  <td><Link to={`/bookings/${s.booking_id}`} className="font-semibold hover:underline">{s.guest_name}</Link>
                    <div className="text-xs text-ink-500">{s.ref}{s.check_out_date < data.today && <span className="text-red-600"> · overstay since {fmtDate(s.check_out_date)}</span>}</div></td>
                  <td className={`whitespace-nowrap text-right tabular-nums ${s.balance_paise > 0 ? 'font-semibold text-red-600' : 'text-ink-500'}`}>{s.balance_paise > 0 ? `${rupees(s.balance_paise)} due` : 'Paid'}</td>
                  <td className="text-right">{can('bookings.checkout') && <button className="btn-secondary btn-sm" onClick={() => setCheckOut(s)}>Check out</button>}</td>
                </tr>
              ))}
            </tbody></table>
          )}
        </Section>

        <Section title="In house" count={data.in_house.length}>
          {!data.in_house.length ? <Empty>No guests in house</Empty> : (
            <div className="max-h-96 overflow-y-auto"><table className="table"><tbody>
              {data.in_house.map((s) => (
                <tr key={s.id}>
                  <td className="w-16 font-semibold">{s.room_number}</td>
                  <td><Link to={`/bookings/${s.booking_id}`} className="hover:underline">{s.guest_name}</Link><div className="text-xs text-ink-500">until {fmtDate(s.check_out_date)}</div></td>
                  <td className="text-right">{s.folio_id && can('folio.view') && <Link to={`/folios/${s.folio_id}`} className="btn-ghost btn-sm">Bill</Link>}</td>
                </tr>
              ))}
            </tbody></table></div>
          )}
        </Section>

        <div className="space-y-5">
          {data.requested.length > 0 && (
            <Section title="Online booking requests" count={data.requested.length}>
              <table className="table"><tbody>
                {data.requested.map((b) => (
                  <tr key={b.id}>
                    <td><Link to={`/bookings/${b.id}`} className="font-semibold hover:underline">{b.guest_name}</Link><div className="text-xs text-ink-500">{b.guest_phone} · {b.ref}</div></td>
                    <td className="text-sm">{fmtDate(b.check_in_date)} → {fmtDate(b.check_out_date)}<div className="text-xs text-ink-500">{b.room_count} room(s)</div></td>
                    <td className="text-right"><Link to={`/bookings/${b.id}`} className="btn-secondary btn-sm">Review</Link></td>
                  </tr>
                ))}
              </tbody></table>
            </Section>
          )}
          {can('pos.order') && (
            <Section title="Room food orders" count={roomOrders.length} action={<Link to="/pos" className="text-xs font-semibold text-brand-700">All orders</Link>}>
              {!roomOrders.length ? <Empty>No room orders in progress</Empty> : (
                <table className="table"><tbody>
                  {roomOrders.map((o) => (
                    <tr key={o.id}>
                      <td className="w-16 font-semibold">{o.room_number}</td>
                      <td>{o.items?.filter((i) => !i.cancelled).map((i) => `${i.quantity}× ${i.name}`).join(', ')}
                        <div className="text-xs text-ink-500">{o.order_no} · {ago(o.created_at)} · {rupees(o.total_paise)} · {o.status === 'received' ? 'waiting for acceptance' : o.settlement === 'room_posted' ? 'in kitchen, on room bill' : 'in kitchen, not billed yet'}</div></td>
                      <td className="text-right">{can('pos.cancel') && <button className="btn-ghost btn-sm text-red-600" onClick={() => setCancelOrder(o)}>Cancel</button>}</td>
                    </tr>
                  ))}
                </tbody></table>
              )}
            </Section>
          )}
          {can('requests.view') && (
            <Section title="Guest requests" count={openReq.length} action={<Link to="/requests" className="text-xs font-semibold text-brand-700">All</Link>}>
              {!openReq.length ? <Empty>No open requests</Empty> : (
                <table className="table"><tbody>
                  {openReq.slice(0, 6).map((r) => (
                    <tr key={r.id}><td className="w-16 font-semibold">{r.room_number}</td><td>{r.type}{r.message && <div className="text-xs text-ink-500">{r.message}</div>}</td>
                      <td className="text-right text-xs text-ink-400">{ago(r.created_at)}</td></tr>
                  ))}
                </tbody></table>
              )}
            </Section>
          )}
          <Section title="Shift handover">
            <div className="space-y-2 p-4">
              {(handover.data || []).filter((h) => !h.resolved).map((h) => (
                <div key={h.id} className="flex items-start justify-between gap-3 rounded-lg bg-ink-50 px-3 py-2 text-sm">
                  <div>{h.note}<div className="text-xs text-ink-400">{h.user_name} · {ago(h.created_at)}</div></div>
                  <button className="btn-ghost btn-sm" onClick={() => run(async () => { await api.patch(`/hotel/handover/${h.id}`, { resolved: true }); handover.reload(); })}>Done</button>
                </div>
              ))}
              <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (!note.trim()) return; run(async () => { await api.post('/hotel/handover', { note }); setNote(''); handover.reload(); }); }}>
                <input className="input" placeholder="Note for next shift…" value={note} onChange={(e) => setNote(e.target.value)} />
                <button className="btn-secondary">Add</button>
              </form>
            </div>
          </Section>
        </div>
      </div>
      <CheckInDialog stay={checkIn} open={!!checkIn} onClose={() => { setCheckIn(null); reload(); }} onDone={reload} />
      <ReasonDialog open={!!cancelOrder} title={`Cancel ${cancelOrder?.order_no} · Room ${cancelOrder?.room_number}`} confirmLabel="Cancel order" onClose={() => setCancelOrder(null)}
        extra={<p className="mb-3 text-sm text-ink-500">The kitchen is told to stop and the charge is taken off the room bill.</p>}
        onSubmit={(reason) => run(async () => { await api.post(`/orders/${cancelOrder.id}/cancel`, { reason }); setCancelOrder(null); orders.reload(); }, 'Order cancelled and removed from the room bill')} />
      <CheckOutDialog stay={checkOut} open={!!checkOut} onClose={() => setCheckOut(null)} onDone={reload} />
    </div>
  );
}
