import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { rupees } from '../lib/format.js';
import { Modal, Field, useAction, useToast } from './ui.jsx';

const READY = ['ready', 'inspected'];
const hkLabel = (s) => (s ? s.replace(/_/g, ' ') : 'status unknown');

/** Check-in flow: assign room, capture ID if required, override dirty room with confirmation. */
export function CheckInDialog({ stay, open, onClose, onDone }) {
  const [run, busy] = useAction();
  const toast = useToast();
  const [rooms, setRooms] = useState([]);
  const [roomId, setRoomId] = useState('');
  const [needId, setNeedId] = useState(false);
  const [needForce, setNeedForce] = useState('');
  const [idType, setIdType] = useState('Aadhaar');
  const [idNumber, setIdNumber] = useState('');
  const [pin, setPin] = useState(null);

  useEffect(() => {
    if (!open || !stay) return;
    setRoomId(stay.room_id || ''); setNeedId(false); setNeedForce(''); setPin(null); setIdNumber('');
    api.get(`/availability?from=${stay.check_in_date}&to=${stay.check_out_date}`).then((a) => {
      const t = a.find((x) => x.id === stay.room_type_id);
      setRooms(t ? t.free_rooms : []);
    }).catch(() => {});
  }, [open, stay]);

  if (!stay) return null;
  // Assigned room is never in free_rooms (the stay itself occupies it), so add it with its own housekeeping status.
  const options = [...rooms];
  if (stay.room_id && !rooms.some((r) => r.id === stay.room_id)) {
    options.unshift({ id: stay.room_id, number: stay.room_number, hk_status: stay.hk_status, assigned: true });
  }
  options.sort((a, b) => Number(!READY.includes(a.hk_status)) - Number(!READY.includes(b.hk_status)));
  const selected = options.find((r) => String(r.id) === String(roomId));
  const notReady = selected && selected.hk_status && !READY.includes(selected.hk_status);
  const readyAlternatives = options.filter((r) => READY.includes(r.hk_status) && r.id !== selected?.id).length;
  const submit = async (force = false) => {
    try {
      if (needId && idNumber) await api.put(`/guests/${stay.guest_id}`, { id_type: idType, id_number: idNumber });
      const r = await api.post(`/stays/${stay.id}/checkin`, { room_id: roomId ? Number(roomId) : undefined, force });
      setPin(r.portal_pin);
      toast(`Checked in to room ${r.room_number}`);
      onDone?.();
    } catch (e) {
      if (e.data?.details?.needs_id) setNeedId(true);
      else if (e.data?.details?.needs_force) setNeedForce(e.message);
      else toast(e.message, 'error');
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={`Check in — ${stay.guest_name}`}
      footer={pin ? <button className="btn-primary" onClick={onClose}>Done</button> : <>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        {needForce || notReady
          ? <button className="btn-danger" disabled={busy} onClick={() => run(() => submit(true))}>Check in anyway</button>
          : <button className="btn-primary" disabled={busy || (needId && !idNumber)} onClick={() => run(() => submit(false))}>Check in</button>}
      </>}>
      {pin ? (
        <div className="space-y-2 text-center">
          <div className="text-sm text-ink-500">Give this PIN to the guest for the in-room QR portal</div>
          <div className="num text-5xl tracking-[0.3em] text-night-900">{pin}</div>
          <div className="text-xs text-ink-400">They can also use the last 4 digits of their phone number.</div>
        </div>
      ) : (
        <div className="space-y-4">
          <Field label="Room">
            <select className="input" value={roomId} onChange={(e) => { setRoomId(e.target.value); setNeedForce(''); }}>
              <option value="">Select room</option>
              {options.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.number}{r.assigned ? ' (assigned)' : ''} · {hkLabel(r.hk_status)}{READY.includes(r.hk_status) ? '' : ' ⚠'}
                </option>
              ))}
            </select>
          </Field>
          {notReady && !needForce && (
            <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">
              Room {selected.number} is <b>{hkLabel(selected.hk_status)}</b> — housekeeping has not marked it ready.
              {readyAlternatives > 0 ? ` ${readyAlternatives} ready room${readyAlternatives > 1 ? 's are' : ' is'} available in the list.` : ' No ready room of this type is free right now.'}
            </div>
          )}
          {needId && (
            <div className="grid grid-cols-2 gap-3 rounded-lg bg-amber-50 p-3">
              <div className="col-span-2 text-xs font-semibold text-amber-600">Guest ID is required at check-in</div>
              <Field label="ID type">
                <select className="input" value={idType} onChange={(e) => setIdType(e.target.value)}>
                  {['Aadhaar', 'Passport', 'Driving licence', 'Voter ID', 'PAN', 'Other'].map((x) => <option key={x}>{x}</option>)}
                </select>
              </Field>
              <Field label="ID number"><input className="input" value={idNumber} onChange={(e) => setIdNumber(e.target.value)} /></Field>
            </div>
          )}
          {needForce && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{needForce}</div>}
        </div>
      )}
    </Modal>
  );
}

/** Check-out flow: shows balance and pending orders; links to bill to collect payment. */
export function CheckOutDialog({ stay, open, onClose, onDone }) {
  const nav = useNavigate();
  const toast = useToast();
  const [run, busy] = useAction();
  const [problem, setProblem] = useState(null);
  useEffect(() => { if (open) setProblem(null); }, [open]);
  if (!stay) return null;
  const submit = async (allow_balance = false) => {
    try {
      const r = await api.post(`/stays/${stay.id}/checkout`, { allow_balance });
      const closed = r.closed_orders?.length ? ` · Closed food order${r.closed_orders.length > 1 ? 's' : ''} ${r.closed_orders.join(', ')}` : '';
      toast((r.invoice?.invoice_no ? `Checked out · Invoice ${r.invoice.invoice_no}` : 'Checked out') + closed);
      onDone?.(r);
      onClose();
    } catch (e) {
      setProblem({ message: e.message, ...(e.data?.details || {}) });
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={`Check out — room ${stay.room_number}`}
      footer={<>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        {stay.folio_id && <button className="btn-secondary" onClick={() => nav(`/folios/${stay.folio_id}`)}>Open bill</button>}
        {problem?.balance_paise > 0 && <button className="btn-danger" disabled={busy} onClick={() => run(() => submit(true))}>Check out with balance</button>}
        <button className="btn-primary" disabled={busy} onClick={() => run(() => submit(false))}>Check out</button>
      </>}>
      <p className="text-sm text-ink-600">{stay.guest_name} · {stay.check_in_date} → {stay.check_out_date}</p>
      <p className="mt-2 text-sm text-ink-500">Remaining room nights will be posted, the room will be marked dirty and a cleaning task created. If the bill is fully paid, the GST invoice is issued automatically.</p>
      {problem && (
        <div className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-600">
          {problem.message}
          {problem.balance_paise > 0 && <div className="mt-1 font-semibold">Balance due: {rupees(problem.balance_paise)}</div>}
          {problem.balance_paise > 0 && <div className="mt-1 text-xs">“Check out with balance” requires manager permission and leaves the bill as outstanding.</div>}
        </div>
      )}
    </Modal>
  );
}
