import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useApi } from '../lib/hooks.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { fmtDate, fmtDateTime, rupees, label, toPaise, addDays, todayStr } from '../lib/format.js';
import { PageHeader, Badge, Loading, Modal, Field, ReasonDialog, useAction, ErrorBox } from '../components/ui.jsx';
import { CheckInDialog, CheckOutDialog } from '../components/stay.jsx';

function ModifyStay({ stay, open, onClose, onDone }) {
  const { can } = useAuth();
  const [run, busy] = useAction();
  const [f, setF] = useState(null);
  const [avail, setAvail] = useState([]);
  useEffect(() => {
    if (open && stay) {
      setF({ check_in_date: stay.check_in_date, check_out_date: stay.check_out_date, room_type_id: stay.room_type_id, room_id: stay.room_id || '',
        adults: stay.adults, children: stay.children, rate: String(stay.nightly_rate_paise / 100), reason: '' });
    }
  }, [open, stay]);
  useEffect(() => {
    if (!f || f.check_out_date <= f.check_in_date) return;
    api.get(`/availability?from=${f.check_in_date}&to=${f.check_out_date}`).then(setAvail).catch(() => {});
  }, [f?.check_in_date, f?.check_out_date]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => { setF(null); setAvail([]); onClose(); };
  if (!stay || !f) return null;
  const t = avail.find((a) => a.id === Number(f.room_type_id));
  const free = t ? [...t.free_rooms] : [];
  if (stay.room_id && Number(f.room_type_id) === stay.room_type_id && !free.some((r) => r.id === stay.room_id)) free.unshift({ id: stay.room_id, number: stay.room_number, hk_status: 'current' });
  const set = (p) => setF({ ...f, ...p });
  const inHouse = stay.status === 'checked_in';
  const save = () => run(async () => {
    await api.patch(`/stays/${stay.id}`, {
      ...(inHouse ? {} : { check_in_date: f.check_in_date }), check_out_date: f.check_out_date, room_type_id: Number(f.room_type_id),
      room_id: f.room_id ? Number(f.room_id) : null, adults: Number(f.adults), children: Number(f.children),
      ...(can('rates.override') ? { nightly_rate_paise: toPaise(f.rate) } : {}), reason: f.reason || undefined,
    });
    onDone(); close();
  }, 'Stay updated');
  return (
    <Modal open={open} onClose={close} title={inHouse ? 'Extend / move room' : 'Modify stay'}
      footer={<><button className="btn-secondary" onClick={close}>Cancel</button><button className="btn-primary" disabled={busy} onClick={save}>Save changes</button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Check-in"><input type="date" className="input" disabled={inHouse} value={f.check_in_date} onChange={(e) => set({ check_in_date: e.target.value })} /></Field>
        <Field label="Check-out"><input type="date" className="input" min={inHouse ? todayStr() : addDays(f.check_in_date, 1)} value={f.check_out_date} onChange={(e) => set({ check_out_date: e.target.value })} /></Field>
        <Field label="Room type">
          <select className="input" value={f.room_type_id} onChange={(e) => set({ room_type_id: e.target.value, room_id: '' })}>
            {avail.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
        <Field label="Room">
          <select className="input" value={f.room_id} onChange={(e) => set({ room_id: e.target.value })}>
            {!inHouse && <option value="">Unassigned</option>}
            {free.map((r) => <option key={r.id} value={r.id}>{r.number} {r.hk_status === 'current' ? '(current)' : r.hk_status !== 'ready' ? `(${r.hk_status})` : ''}</option>)}
          </select>
        </Field>
        <Field label="Adults"><input type="number" className="input" min={1} value={f.adults} onChange={(e) => set({ adults: e.target.value })} /></Field>
        <Field label="Children"><input type="number" className="input" min={0} value={f.children} onChange={(e) => set({ children: e.target.value })} /></Field>
        <Field label="Rate/night ₹"><input className="input" disabled={!can('rates.override')} value={f.rate} onChange={(e) => set({ rate: e.target.value })} /></Field>
        <Field label="Reason"><input className="input" value={f.reason} onChange={(e) => set({ reason: e.target.value })} /></Field>
      </div>
      {inHouse && <p className="mt-3 text-xs text-ink-500">Moving rooms marks the old room dirty and creates a cleaning task.</p>}
    </Modal>
  );
}

export default function BookingDetail() {
  const { id } = useParams();
  const loc = useLocation();
  const nav = useNavigate();
  const { can } = useAuth();
  const { data: b, reload, error } = useApi(`/bookings/${id}`);
  const history = useApi(can('audit.view') ? `/hotel/audit?entity_type=booking&entity_id=${id}` : null, { skip: !can('audit.view') });
  const [run] = useAction();
  const [checkIn, setCheckIn] = useState(null);
  const [checkOut, setCheckOut] = useState(null);
  const [modify, setModify] = useState(null);
  const [cancelStay, setCancelStay] = useState(null);
  const [cancelBooking, setCancelBooking] = useState(false);
  const [fee, setFee] = useState('');

  if (error) return <ErrorBox error={error} />;
  if (!b) return <Loading />;
  const today = todayStr();
  return (
    <div className="space-y-5">
      <PageHeader title={`Booking ${b.ref}`} subtitle={`${b.guest_name} · ${b.guest_phone || 'no phone'} · ${label(b.source)} · created ${fmtDateTime(b.created_at)}${b.created_by_name ? ` by ${b.created_by_name}` : ''}`}
        actions={<>
          <Badge status={b.status} />
          {b.status === 'requested' && can('bookings.create') && <button className="btn-primary" onClick={() => run(async () => { await api.post(`/bookings/${id}/confirm`); reload(); }, 'Booking confirmed')}>Confirm booking</button>}
          {b.status !== 'cancelled' && can('bookings.cancel') && !b.stays.some((s) => ['checked_in', 'checked_out'].includes(s.status)) &&
            <button className="btn-secondary" onClick={() => setCancelBooking(true)}>Cancel booking</button>}
          <Link to={`/guests/${b.guest_id}`} className="btn-secondary">Guest profile</Link>
        </>} />
      {loc.state?.warnings?.map((w) => <div key={w} className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-600">{w}</div>)}
      {(b.special_requests || b.notes) && (
        <div className="grid gap-3 sm:grid-cols-2">
          {b.special_requests && <div className="card p-4 text-sm"><div className="label">Guest requests</div>{b.special_requests}</div>}
          {b.notes && <div className="card p-4 text-sm"><div className="label">Internal notes</div>{b.notes}</div>}
        </div>
      )}
      <div className="card overflow-x-auto">
        <table className="table">
          <thead><tr><th>Room</th><th>Guest</th><th>Dates</th><th>Pax</th><th>Rate</th><th>Bill</th><th>Status</th><th /></tr></thead>
          <tbody>
            {b.stays.map((s) => (
              <tr key={s.id}>
                <td><div className="font-semibold">{s.room_number || '—'}</div><div className="text-xs text-ink-500">{s.room_type}</div></td>
                <td>{s.guest_name}</td>
                <td className="whitespace-nowrap">{fmtDate(s.check_in_date)} → {fmtDate(s.check_out_date)}</td>
                <td>{s.adults}{s.children ? `+${s.children}` : ''}</td>
                <td className="tabular-nums">{rupees(s.nightly_rate_paise, { decimals: 0 })}{s.extra_person_paise > 0 && <div className="text-xs text-ink-500">+{rupees(s.extra_person_paise, { decimals: 0 })} extra</div>}</td>
                <td className="whitespace-nowrap tabular-nums">
                  {s.folio_totals && <>{rupees(s.folio_totals.total_paise)}<div className={`text-xs ${s.folio_totals.balance_paise > 0 ? 'text-red-600' : 'text-ink-500'}`}>
                    {s.folio_totals.balance_paise > 0 ? `${rupees(s.folio_totals.balance_paise)} due` : s.folio_totals.balance_paise < 0 ? `${rupees(-s.folio_totals.balance_paise)} credit` : 'settled'}</div></>}
                </td>
                <td><Badge status={s.status} /></td>
                <td className="whitespace-nowrap text-right">
                  <div className="flex justify-end gap-1">
                    {s.status === 'reserved' && can('bookings.checkin') && s.check_in_date <= today && <button className="btn-primary btn-sm" onClick={() => setCheckIn(s)}>Check in</button>}
                    {s.status === 'checked_in' && can('bookings.checkout') && <button className="btn-primary btn-sm" onClick={() => setCheckOut(s)}>Check out</button>}
                    {['reserved', 'checked_in', 'tentative'].includes(s.status) && can('bookings.modify') && <button className="btn-secondary btn-sm" onClick={() => setModify(s)}>{s.status === 'checked_in' ? 'Extend/move' : 'Modify'}</button>}
                    {s.folio_id && can('folio.view') && <Link className="btn-secondary btn-sm" to={`/folios/${s.folio_id}`}>Bill</Link>}
                    {['reserved', 'tentative'].includes(s.status) && can('bookings.cancel') && b.stays.length > 1 && <button className="btn-ghost btn-sm text-red-600" onClick={() => setCancelStay(s)}>Cancel</button>}
                    {s.status === 'reserved' && s.check_in_date <= today && can('bookings.cancel') &&
                      <button className="btn-ghost btn-sm" onClick={() => run(async () => { await api.post(`/stays/${s.id}/no-show`, { charge_first_night: confirm('Charge first night as no-show fee?') }); reload(); }, 'Marked no-show')}>No-show</button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {history.data?.length > 0 && (
        <div className="card p-4">
          <h2 className="mb-2">History</h2>
          <ul className="space-y-1 text-sm">
            {history.data.map((h) => <li key={h.id} className="text-ink-600"><span className="text-ink-400">{fmtDateTime(h.created_at)}</span> · {label(h.action.split('.')[1])} {h.actor_name && `by ${h.actor_name}`} {h.data?.reason && `— ${h.data.reason}`}</li>)}
          </ul>
        </div>
      )}
      <CheckInDialog stay={checkIn} open={!!checkIn} onClose={() => { setCheckIn(null); reload(); }} onDone={reload} />
      <CheckOutDialog stay={checkOut} open={!!checkOut} onClose={() => setCheckOut(null)} onDone={reload} />
      <ModifyStay stay={modify} open={!!modify} onClose={() => setModify(null)} onDone={reload} />
      <ReasonDialog open={!!cancelStay} title={`Cancel room ${cancelStay?.room_number || ''}`} onClose={() => setCancelStay(null)}
        onSubmit={(reason) => run(async () => { await api.post(`/stays/${cancelStay.id}/cancel`, { reason }); setCancelStay(null); reload(); }, 'Room cancelled')} />
      <ReasonDialog open={cancelBooking} title="Cancel booking" confirmLabel="Cancel booking" onClose={() => setCancelBooking(false)}
        extra={can('folio.charge') && <Field label="Cancellation charge ₹ (optional)" className="mb-3"><input className="input" value={fee} onChange={(e) => setFee(e.target.value)} /></Field>}
        onSubmit={(reason) => run(async () => { await api.post(`/bookings/${id}/cancel`, { reason, cancellation_fee_paise: fee ? toPaise(fee) : 0 }); setCancelBooking(false); reload(); }, 'Booking cancelled')} />
      {b.status === 'cancelled' && b.stays.some((s) => s.folio_totals?.paid_paise > 0) && (
        <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-600">This booking had a deposit. Open the bill to record a refund if needed.
          <button className="ml-2 underline" onClick={() => nav(`/folios/${b.stays.find((s) => s.folio_totals?.paid_paise > 0).folio_id}`)}>Open bill</button></div>
      )}
    </div>
  );
}
