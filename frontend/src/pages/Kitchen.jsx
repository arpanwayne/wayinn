import { useState } from 'react';
import { useApi } from '../lib/hooks.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { ago, label } from '../lib/format.js';
import { PageHeader, Loading, useAction } from '../components/ui.jsx';
import { printKot } from '../components/printKot.js';

function KotCard({ k, onAction }) {
  const mins = Math.round((Date.now() - new Date(k.created_at)) / 60000);
  const late = mins > 20 && k.status !== 'ready';
  return (
    <div className={`card overflow-hidden ${late ? 'ring-2 ring-red-400' : ''}`}>
      <div className={`flex items-center justify-between px-3 py-2 text-sm font-bold ${k.order_type === 'room_service' ? 'bg-violet-100' : k.order_type === 'takeaway' ? 'bg-amber-100' : 'bg-ink-100'}`}>
        <span>{k.order_type === 'room_service' ? `ROOM ${k.room_number}` : k.order_type === 'dine_in' ? `TABLE ${k.table_label || '—'}` : 'TAKEAWAY'}</span>
        <span className={late ? 'text-red-600' : 'text-ink-500'}>{mins}m</span>
      </div>
      <div className="px-3 py-2">
        <div className="mb-1 text-xs text-ink-500">{k.kot_no} · {k.order_no}{k.station_name && ` · ${k.station_name}`}</div>
        <ul className="space-y-1">
          {k.items?.map((i) => (
            <li key={i.id} className={i.cancelled ? 'text-ink-300 line-through' : ''}>
              <span className="font-bold">{i.quantity}×</span> {i.name}{i.variant && ` (${i.variant})`}
              {i.addons?.length > 0 && <div className="pl-5 text-xs text-ink-500">+ {i.addons.map((a) => a.name).join(', ')}</div>}
              {i.notes && <div className="pl-5 text-xs font-semibold text-red-600">* {i.notes}</div>}
            </li>
          ))}
        </ul>
        {k.order_notes && <div className="mt-2 rounded bg-amber-50 px-2 py-1 text-xs">{k.order_notes}</div>}
      </div>
      <div className="flex gap-1 border-t border-ink-100 p-2">
        <button className="btn-ghost btn-sm" onClick={() => printKot(k.id)}>Print</button>
        <div className="flex-1" />
        {k.status === 'pending' && <button className="btn-secondary btn-sm" onClick={() => onAction(k.id, 'preparing')}>Start</button>}
        {k.status !== 'ready' && <button className="btn-primary btn-sm" onClick={() => onAction(k.id, 'ready')}>Ready</button>}
      </div>
    </div>
  );
}

export default function Kitchen() {
  const { can } = useAuth();
  const [station, setStation] = useState('');
  const menu = useApi('/menu');
  const { data, reload } = useApi(`/kitchen/kots${station ? `?station_id=${station}` : ''}`, { interval: 8000 });
  const [run] = useAction();
  if (!data) return <Loading />;
  const act = (id, status) => run(async () => { await api.patch(`/kots/${id}`, { status }); reload(); });
  const cols = [['pending', 'New'], ['preparing', 'Preparing'], ['ready', 'Ready']];
  return (
    <div>
      <PageHeader title="Kitchen display" subtitle="Auto-refreshes every few seconds"
        actions={<select className="input w-auto" value={station} onChange={(e) => setStation(e.target.value)}>
          <option value="">All stations</option>{menu.data?.stations.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>} />
      {data.awaiting_acceptance.length > 0 && (
        <div className="mb-5 rounded-xl border-2 border-amber-400 bg-amber-50 p-4">
          <h2 className="mb-2">Guest QR orders waiting for acceptance</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.awaiting_acceptance.map((o) => (
              <div key={o.id} className="card p-3">
                <div className="flex justify-between font-bold"><span>Room {o.room_number}</span><span className="text-xs text-ink-500">{ago(o.created_at)}</span></div>
                <ul className="my-2 text-sm">{o.items?.map((i, k) => <li key={k}>{i.quantity}× {i.name}{i.variant && ` (${i.variant})`}{i.notes && <span className="text-red-600"> * {i.notes}</span>}</li>)}</ul>
                {can('pos.order', 'kitchen.view') && <button className="btn-primary btn-sm w-full" onClick={() => run(async () => { await api.patch(`/orders/${o.id}/status`, { status: 'accepted' }); reload(); }, 'Accepted — KOT created')}>Accept</button>}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="grid gap-5 lg:grid-cols-3">
        {cols.map(([st, l]) => {
          const list = data.kots.filter((k) => k.status === st);
          return (
            <div key={st}>
              <div className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-400">{l} · {list.length}</div>
              <div className="space-y-3">{list.map((k) => <KotCard key={k.id} k={k} onAction={act} />)}</div>
            </div>
          );
        })}
      </div>
      <p className="mt-6 text-xs text-ink-400">{label('tip')}: “Print” sends the ticket to any printer set up on this device (58/80 mm thermal printers work through the browser print dialog).</p>
    </div>
  );
}
