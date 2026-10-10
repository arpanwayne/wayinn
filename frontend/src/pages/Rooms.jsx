import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../lib/hooks.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { fmtDate, label } from '../lib/format.js';
import { PageHeader, Badge, Loading, Modal, Field, useAction } from '../components/ui.jsx';

const TILE = {
  available: 'border-brand-200 bg-brand-50', occupied: 'border-ink-700 bg-ink-800 text-white', reserved: 'border-violet-200 bg-violet-50',
  dirty: 'border-amber-200 bg-amber-50', cleaning: 'border-yellow-200 bg-yellow-50', inspected: 'border-sky-200 bg-sky-50', out_of_order: 'border-red-200 bg-red-50',
};

export default function Rooms() {
  const { can } = useAuth();
  const { data, reload } = useApi('/rooms/board', { interval: 30000 });
  const [sel, setSel] = useState(null);
  const [status, setStatus] = useState('');
  const [reason, setReason] = useState('');
  const [filter, setFilter] = useState('');
  const [run, busy] = useAction();
  if (!data) return <Loading />;
  const counts = data.reduce((a, r) => ({ ...a, [r.display_status]: (a[r.display_status] || 0) + 1 }), {});
  const shown = filter ? data.filter((r) => r.display_status === filter) : data;
  const floors = [...new Set(shown.map((r) => r.floor || '—'))];
  return (
    <div>
      <PageHeader title="Room status" subtitle="Live view. Tap a room to update housekeeping status." />
      <div className="mb-4 flex flex-wrap gap-2">
        <button className={`badge px-3 py-1 ${!filter ? 'bg-ink-800 text-white' : 'bg-white ring-1 ring-ink-200'}`} onClick={() => setFilter('')}>All {data.length}</button>
        {Object.entries(counts).map(([k, n]) => (
          <button key={k} onClick={() => setFilter(k === filter ? '' : k)} className={`badge px-3 py-1 ${filter === k ? 'bg-ink-800 text-white' : 'bg-white ring-1 ring-ink-200'}`}>{label(k)} {n}</button>
        ))}
      </div>
      {floors.map((fl) => (
        <div key={fl} className="mb-5">
          <div className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-400">Floor {fl}</div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            {shown.filter((r) => (r.floor || '—') === fl).map((r) => (
              <button key={r.id} onClick={() => { setSel(r); setStatus(r.hk_status); setReason(r.out_of_order_reason || ''); }}
                className={`rounded-xl border p-3 text-left transition hover:shadow-md ${TILE[r.display_status]}`}>
                <div className="flex items-start justify-between"><span className="text-lg font-bold">{r.number}</span>{r.due_out && <span className="badge bg-amber-400 text-ink-900">Due out</span>}</div>
                <div className={`text-xs ${r.display_status === 'occupied' ? 'text-ink-200' : 'text-ink-500'}`}>{r.room_type}</div>
                <div className="mt-2 text-xs font-semibold">{label(r.display_status)}</div>
                {r.guest_name && <div className="truncate text-xs">{r.guest_name}</div>}
                {!r.guest_name && r.arriving_guest && <div className="truncate text-xs text-violet-700">→ {r.arriving_guest}</div>}
                {r.stay_id && r.hk_status !== 'ready' && <div className="mt-1"><Badge status={r.hk_status} /></div>}
              </button>
            ))}
          </div>
        </div>
      ))}
      <Modal open={!!sel} onClose={() => setSel(null)} title={`Room ${sel?.number}`}
        footer={can('rooms.status') && <><button className="btn-secondary" onClick={() => setSel(null)}>Close</button>
          <button className="btn-primary" disabled={busy || (status === 'out_of_order' && !reason)} onClick={() => run(async () => {
            await api.patch(`/rooms/${sel.id}/status`, { hk_status: status, reason: status === 'out_of_order' ? reason : undefined }); setSel(null); reload();
          }, 'Room updated')}>Update</button></>}>
        {sel && (
          <div className="space-y-3">
            <div className="text-sm text-ink-600">{sel.room_type} · {label(sel.display_status)}</div>
            {sel.guest_name && <div className="rounded-lg bg-ink-50 px-3 py-2 text-sm">In house: <b>{sel.guest_name}</b> until {fmtDate(sel.check_out_date)} · <Link className="text-brand-700 underline" to={`/bookings/${sel.booking_id}`}>booking</Link></div>}
            {sel.arriving_guest && <div className="rounded-lg bg-violet-50 px-3 py-2 text-sm">Arriving today: <b>{sel.arriving_guest}</b></div>}
            {can('rooms.status') && <>
              <Field label="Housekeeping status">
                <div className="grid grid-cols-3 gap-2">
                  {['dirty', 'cleaning', 'inspected', 'ready', 'out_of_order'].map((s) => (
                    <button key={s} type="button" onClick={() => setStatus(s)} className={`rounded-lg border px-2 py-2 text-xs font-semibold ${status === s ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-ink-200'}`}>{label(s)}</button>
                  ))}
                </div>
              </Field>
              {status === 'out_of_order' && <Field label="Reason"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
            </>}
          </div>
        )}
      </Modal>
    </div>
  );
}
