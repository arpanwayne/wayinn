import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../lib/hooks.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { rupees, fmtDate, fmtDateLong, ago } from '../lib/format.js';
import { PageHeader, Stat, Badge, Empty, Loading, useAction } from '../components/ui.jsx';
import { CheckInDialog, CheckOutDialog } from '../components/stay.jsx';

function Section({ title, count, children, action }) {
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-ink-100 px-4 py-3">
        <h2>{title} {count !== undefined && <span className="ml-1 text-ink-400">{count}</span>}</h2>
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
  const [checkIn, setCheckIn] = useState(null);
  const [checkOut, setCheckOut] = useState(null);
  const [note, setNote] = useState('');
  const [run] = useAction();

  if (!data) return <Loading />;
  const c = data.counts;
  const openReq = (requests.data || []).filter((r) => r.status !== 'done' && r.status !== 'cancelled');
  return (
    <div className="space-y-5">
      <PageHeader title="Front desk" subtitle={fmtDateLong(data.today)}
        actions={can('bookings.create') && <>
          <Link to="/bookings/new?walkin=1" className="btn-primary">+ Walk-in</Link>
          <Link to="/bookings/new" className="btn-secondary">+ Reservation</Link>
        </>} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Occupied" value={`${c.occupied}/${c.total_rooms - c.out_of_order}`} />
        <Stat label="Vacant" value={c.vacant} tone="good" />
        <Stat label="Arrivals left" value={c.arrivals_pending} sub={c.unallocated_arrivals ? `${c.unallocated_arrivals} without room` : null} tone={c.unallocated_arrivals ? 'warn' : 'default'} />
        <Stat label="Departures left" value={c.departures_pending} />
        <Stat label="Dirty rooms" value={c.dirty} tone={c.dirty ? 'warn' : 'default'} />
        <Stat label="Out of order" value={c.out_of_order} tone={c.out_of_order ? 'bad' : 'default'} />
      </div>

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
      <CheckOutDialog stay={checkOut} open={!!checkOut} onClose={() => setCheckOut(null)} onDone={reload} />
    </div>
  );
}
