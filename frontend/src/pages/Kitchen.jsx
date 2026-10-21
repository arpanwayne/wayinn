import { useEffect, useRef, useState } from 'react';
import { useApi } from '../lib/hooks.js';
import { api } from '../lib/api.js';
import { useAuth, store } from '../lib/auth.jsx';
import { ago } from '../lib/format.js';
import { PageHeader, Loading, Empty, useAction } from '../components/ui.jsx';
import { printKot } from '../components/printKot.js';
import * as thermal from '../lib/thermalPrinter.js';

/** Printer choice for this kitchen screen, remembered on this device. */
function usePrinter() {
  const [mode, setModeState] = useState(store.get('wayinn.kitchen.printer') || 'browser');
  const [width, setWidthState] = useState(Number(store.get('wayinn.kitchen.paper')) || 32);
  const [name, setName] = useState(null);
  useEffect(() => {
    setName(null);
    if (mode !== 'browser') thermal.reconnect(mode).then((ok) => ok && setName(thermal.describe(mode)));
  }, [mode]);
  const setMode = (m) => { setModeState(m); store.set('wayinn.kitchen.printer', m); };
  const setWidth = (w) => { setWidthState(w); store.set('wayinn.kitchen.paper', String(w)); };
  const connect = async () => setName(await thermal.connect(mode));
  // Direct to the thermal printer when connected; otherwise the browser print (works everywhere).
  const print = async (kotId) => {
    if (mode !== 'browser' && name) {
      try { return await thermal.printKotDirect(mode, kotId, { width }); } catch { setName(null); }
    }
    return printKot(kotId);
  };
  return { mode, setMode, width, setWidth, name, connect, print };
}

const where = (k) => (k.order_type === 'room_service' ? `ROOM ${k.room_number}` : k.order_type === 'dine_in' ? `TABLE ${k.table_label || '—'}` : 'TAKEAWAY');

function KotCard({ k, onDelivered, busy, print }) {
  const mins = Math.round((Date.now() - new Date(k.created_at)) / 60000);
  const late = mins > 20;
  return (
    <div className={`card overflow-hidden ${late ? 'ring-2 ring-red-400' : ''}`}>
      <div className={`flex items-center justify-between px-4 py-2.5 text-base font-bold ${k.order_type === 'room_service' ? 'bg-night-100 text-night-900' : k.order_type === 'takeaway' ? 'bg-amber-100' : 'bg-ink-100'}`}>
        <span>{where(k)}</span>
        <span className={late ? 'text-red-600' : 'text-ink-500'}>{mins}m</span>
      </div>
      <div className="px-4 py-3">
        <div className="mb-1.5 text-xs text-ink-500">{k.kot_no} · {k.order_no}{k.station_name && ` · ${k.station_name}`}</div>
        <ul className="space-y-1.5 text-base">
          {k.items?.map((i) => (
            <li key={i.id} className={i.cancelled ? 'text-ink-300 line-through' : ''}>
              <span className="font-bold">{i.quantity}×</span> {i.name}{i.variant && ` (${i.variant})`}
              {i.addons?.length > 0 && <div className="pl-6 text-sm text-ink-500">+ {i.addons.map((a) => a.name).join(', ')}</div>}
              {i.notes && <div className="pl-6 text-sm font-semibold text-red-600">* {i.notes}</div>}
            </li>
          ))}
        </ul>
        {k.order_notes && <div className="mt-2 rounded-sm bg-amber-50 px-2 py-1 text-sm">{k.order_notes}</div>}
      </div>
      <div className="flex items-center gap-2 border-t border-ink-100 p-3">
        <button className="btn-ghost btn-sm" onClick={() => print(k.id)}>Print again</button>
        <div className="flex-1" />
        <button className="btn-primary px-6 py-2.5 text-base" disabled={busy} onClick={() => onDelivered(k)}>Delivered</button>
      </div>
    </div>
  );
}

export default function Kitchen() {
  const { can } = useAuth();
  const [station, setStation] = useState('');
  const [autoPrint, setAutoPrint] = useState(store.get('wayinn.kitchen.autoprint') !== 'off');
  const menu = useApi('/menu');
  const { data, reload } = useApi(`/kitchen/kots${station ? `?station_id=${station}` : ''}`, { interval: 6000 });
  const [run, busy] = useAction();
  const printer = usePrinter();
  const attempted = useRef(new Set());
  const printing = useRef(false);

  // New tickets print on their own, once. The server remembers what has been printed, so a second
  // kitchen screen (or a page refresh) does not print the same ticket again.
  useEffect(() => {
    if (!autoPrint || !data || printing.current) return;
    const fresh = data.kots.filter((k) => !k.printed_at && !attempted.current.has(k.id));
    if (!fresh.length) return;
    printing.current = true;
    (async () => {
      for (const k of fresh) {
        attempted.current.add(k.id);
        try {
          await api.patch(`/kots/${k.id}`, { printed: true });
          await printer.print(k.id);
        } catch { /* stays on screen; "Print again" is available */ }
      }
      printing.current = false;
    })();
  }, [data, autoPrint]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <Loading />;
  const delivered = (k) => run(async () => { await api.patch(`/kots/${k.id}`, { status: 'delivered' }); reload(); }, `${where(k)} — delivered`);
  const toggleAuto = (on) => { setAutoPrint(on); store.set('wayinn.kitchen.autoprint', on ? 'on' : 'off'); };
  return (
    <div>
      <PageHeader title="Kitchen" subtitle={`${data.kots.length} order ticket(s) to make · updates on its own`}
        actions={<>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={autoPrint} onChange={(e) => toggleAuto(e.target.checked)} /> Print new orders automatically</label>
          {menu.data?.stations.length > 1 && (
            <select className="input w-auto" value={station} onChange={(e) => setStation(e.target.value)}>
              <option value="">All stations</option>{menu.data.stations.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
        </>} />

      {data.cancelled?.length > 0 && (
        <div className="mb-5 space-y-2">
          {data.cancelled.map((k) => (
            <div key={k.id} className="rounded-xl border-2 border-red-400 bg-red-50 px-4 py-3 text-sm">
              <span className="font-bold text-red-700">CANCELLED by front desk — stop:</span> {where(k)} · {k.kot_no} · {k.items?.map((i) => `${i.quantity}× ${i.name}`).join(', ')}
              {k.cancel_reason && <span className="text-ink-500"> ({k.cancel_reason})</span>}
            </div>
          ))}
        </div>
      )}

      {data.awaiting_acceptance.length > 0 && (
        <div className="mb-5 rounded-xl border-2 border-amber-400 bg-amber-50 p-4">
          <h2 className="mb-2">Guest QR orders waiting for acceptance</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.awaiting_acceptance.map((o) => (
              <div key={o.id} className="card p-3">
                <div className="flex justify-between font-bold"><span>Room {o.room_number}</span><span className="text-xs text-ink-500">{ago(o.created_at)}</span></div>
                <ul className="my-2 text-sm">{o.items?.map((i, n) => <li key={n}>{i.quantity}× {i.name}{i.variant && ` (${i.variant})`}{i.notes && <span className="text-red-600"> * {i.notes}</span>}</li>)}</ul>
                {can('pos.order', 'kitchen.view') && <button className="btn-primary btn-sm w-full" onClick={() => run(async () => { await api.patch(`/orders/${o.id}/status`, { status: 'accepted' }); reload(); }, 'Accepted')}>Accept</button>}
              </div>
            ))}
          </div>
        </div>
      )}

      {!data.kots.length ? <div className="card"><Empty>No orders right now</Empty></div> : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {data.kots.map((k) => <KotCard key={k.id} k={k} onDelivered={delivered} busy={busy} print={printer.print} />)}
        </div>
      )}
      <div className="mt-6 flex flex-wrap items-center gap-2 rounded-xl border border-ink-100 bg-white p-3 text-sm">
        <span className="font-semibold">Printer</span>
        <select className="input w-auto py-1.5" value={printer.mode} onChange={(e) => printer.setMode(e.target.value)}>
          <option value="browser">Browser print</option>
          {thermal.supported.usb && <option value="usb">USB thermal printer (direct)</option>}
          {thermal.supported.serial && <option value="serial">Serial / Bluetooth printer (direct)</option>}
        </select>
        {printer.mode !== 'browser' && <>
          <select className="input w-auto py-1.5" value={printer.width} onChange={(e) => printer.setWidth(Number(e.target.value))}>
            <option value={32}>58 mm paper</option><option value={48}>80 mm paper</option>
          </select>
          {printer.name
            ? <><span className="badge bg-brand-50 text-brand-700">Connected: {printer.name}</span>
              <button className="btn-ghost btn-sm" onClick={() => run(() => thermal.printTest(printer.mode, printer.width), 'Test slip sent')}>Test print</button></>
            : <button className="btn-primary btn-sm" onClick={() => run(printer.connect, 'Printer connected')}>Connect printer</button>}
        </>}
      </div>
      <p className="mt-3 text-xs text-ink-400">Can't make an order? Tell the front desk — only they can cancel it. Direct printing sends the ticket straight to the thermal printer with no dialog (Chrome or Edge; on Windows use the serial/Bluetooth option or browser print). With browser print, Chrome started with <code>--kiosk-printing</code> and the thermal printer as default also skips the dialog.</p>
    </div>
  );
}
