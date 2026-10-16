import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { addDays, todayStr, nights, rupees, toPaise } from '../lib/format.js';
import { PageHeader, Field, useAction, useToast } from '../components/ui.jsx';

const emptyGuest = { full_name: '', phone: '', email: '', id_type: 'Aadhaar', id_number: '', address: '', city: '', company_name: '', company_gstin: '' };

export default function BookingNew() {
  const [params] = useSearchParams();
  const walkIn = params.get('walkin') === '1';
  const nav = useNavigate();
  const { can } = useAuth();
  const [run, busy] = useAction();
  const toast = useToast();
  const [company, setCompany] = useState({ company_name: '', company_gstin: '' }); // company details of a returning guest

  const [from, setFrom] = useState(params.get('from') || todayStr());
  const [to, setTo] = useState(params.get('to') || addDays(params.get('from') || todayStr(), 1));
  const [avail, setAvail] = useState([]);
  const [guestQuery, setGuestQuery] = useState('');
  const [guestResults, setGuestResults] = useState([]);
  const [existing, setExisting] = useState(null);
  const [guest, setGuest] = useState(emptyGuest);
  const [source, setSource] = useState(walkIn ? 'walk_in' : 'phone');
  const [special, setSpecial] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState([{ room_type_id: params.get('room_type_id') || '', room_id: params.get('room_id') || '', adults: 2, children: 0, rate: '' }]);
  const [deposit, setDeposit] = useState({ amount: '', method: 'upi', reference: '' });

  useEffect(() => {
    if (to <= from) return;
    api.get(`/availability?from=${from}&to=${to}`).then(setAvail).catch(() => setAvail([]));
  }, [from, to]);

  useEffect(() => {
    if (guestQuery.trim().length < 2) return setGuestResults([]);
    const t = setTimeout(() => api.get(`/guests?q=${encodeURIComponent(guestQuery)}`).then(setGuestResults).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [guestQuery]);

  const n = to > from ? nights(from, to) : 0;
  const typeById = useMemo(() => Object.fromEntries(avail.map((a) => [String(a.id), a])), [avail]);
  const lineTotal = (l) => {
    const t = typeById[String(l.room_type_id)];
    if (!t) return 0;
    const rate = l.rate !== '' ? toPaise(l.rate) : t.base_rate_paise;
    const extra = Math.max(0, l.adults - t.base_occupancy) * t.extra_person_rate_paise;
    return (rate + extra) * n;
  };
  const total = lines.reduce((a, l) => a + lineTotal(l), 0);
  // Keep adults + children within the room type's capacity as the user types, so the form can never hold a count the server will refuse.
  const setLine = (i, patch) => setLines((ls) => ls.map((l, j) => {
    if (j !== i) return l;
    const next = { ...l, ...patch };
    const max = typeById[String(next.room_type_id)]?.max_occupancy;
    if (max) {
      if ('adults' in patch && next.adults !== '') next.adults = Math.min(Math.max(1, Number(next.adults) || 1), max);
      if ('children' in patch && next.children !== '') next.children = Math.min(Math.max(0, Number(next.children) || 0), Math.max(0, max - (Number(next.adults) || 1)));
      if ('adults' in patch || 'room_type_id' in patch) next.children = Math.min(Number(next.children) || 0, Math.max(0, max - (Number(next.adults) || 1)));
    }
    return next;
  }));
  const pickGuest = (g) => { setExisting(g); setCompany({ company_name: g.company_name || '', company_gstin: g.company_gstin || '' }); };

  const submit = async (e) => {
    e.preventDefault();
    const body = {
      source, special_requests: special || null, notes: notes || null,
      ...(existing ? { guest_id: existing.id } : { guest: Object.fromEntries(Object.entries(guest).filter(([, v]) => v !== '')) }),
      stays: lines.map((l) => ({
        room_type_id: Number(l.room_type_id), room_id: l.room_id ? Number(l.room_id) : null, check_in_date: from, check_out_date: to,
        adults: Number(l.adults), children: Number(l.children), ...(l.rate !== '' ? { nightly_rate_paise: toPaise(l.rate) } : {}),
      })),
      ...(deposit.amount ? { deposit: { amount_paise: toPaise(deposit.amount), method: deposit.method, reference: deposit.reference || null } } : {}),
      check_in_now: walkIn && from === todayStr() && lines.every((l) => l.room_id),
    };
    const b = await run(async () => {
      // Company details typed for a returning guest are saved on the guest so the invoice can use them.
      if (existing && can('guests.manage') && (company.company_name !== (existing.company_name || '') || company.company_gstin !== (existing.company_gstin || ''))) {
        try { await api.put(`/guests/${existing.id}`, { company_name: company.company_name || null, company_gstin: company.company_gstin || null }); }
        catch (err) { toast(`Company details not saved: ${err.message}`, 'error'); }
      }
      return api.post('/bookings', body);
    }, `Booking created`);
    nav(`/bookings/${b.id}`, { state: { warnings: b.warnings } });
  };

  return (
    <form onSubmit={submit} className="space-y-5">
      <PageHeader title={walkIn ? 'Walk-in check-in' : 'New reservation'} subtitle={walkIn ? 'Creates the booking and checks the guest in (ID required)' : null} />
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <div className="card p-4">
            <h2 className="mb-3">Stay</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="Check-in"><input type="date" className="input" value={from} onChange={(e) => { setFrom(e.target.value); if (to <= e.target.value) setTo(addDays(e.target.value, 1)); }} /></Field>
              <Field label="Check-out"><input type="date" className="input" value={to} min={addDays(from, 1)} onChange={(e) => setTo(e.target.value)} /></Field>
              <Field label="Nights"><div className="input bg-ink-50">{n}</div></Field>
              <Field label="Source">
                <select className="input" value={source} onChange={(e) => setSource(e.target.value)}>
                  {[['walk_in', 'Walk-in'], ['phone', 'Phone'], ['direct_online', 'Website'], ['ota', 'OTA'], ['corporate', 'Corporate'], ['staff', 'Staff'], ['other', 'Other']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </Field>
            </div>
            <div className="mt-4 space-y-3">
              {lines.map((l, i) => {
                const t = typeById[String(l.room_type_id)];
                return (
                  <div key={i} className="grid grid-cols-2 gap-3 rounded-lg border border-ink-100 p-3 sm:grid-cols-6">
                    <Field label="Room type" className="col-span-2">
                      <select className="input" required value={l.room_type_id} onChange={(e) => setLine(i, { room_type_id: e.target.value, room_id: '', rate: '' })}>
                        <option value="">Select</option>
                        {avail.map((a) => <option key={a.id} value={a.id} disabled={!a.available}>{a.name} · {rupees(a.base_rate_paise, { decimals: 0 })} · {a.available} left</option>)}
                      </select>
                    </Field>
                    <Field label="Room">
                      <select className="input" value={l.room_id} onChange={(e) => setLine(i, { room_id: e.target.value })}>
                        <option value="">Assign later</option>
                        {(t?.free_rooms || []).filter((r) => !lines.some((o, j) => j !== i && String(o.room_id) === String(r.id))).map((r) => <option key={r.id} value={r.id}>{r.number}{r.hk_status !== 'ready' ? ` (${r.hk_status})` : ''}</option>)}
                      </select>
                    </Field>
                    <Field label="Adults" hint={t ? `Max ${t.max_occupancy} guests` : null}><input type="number" min={1} max={t?.max_occupancy || 6} className="input" value={l.adults} onChange={(e) => setLine(i, { adults: e.target.value })} /></Field>
                    <Field label="Children"><input type="number" min={0} max={t ? Math.max(0, t.max_occupancy - (Number(l.adults) || 1)) : undefined} className="input" value={l.children} onChange={(e) => setLine(i, { children: e.target.value })} /></Field>
                    <Field label="Rate/night ₹" hint={t && !can('rates.override') ? 'Fixed rate' : null}>
                      <input className="input" inputMode="decimal" disabled={!can('rates.override')} placeholder={t ? String(t.base_rate_paise / 100) : ''} value={l.rate} onChange={(e) => setLine(i, { rate: e.target.value })} />
                    </Field>
                    <div className="col-span-2 flex items-center justify-between text-sm sm:col-span-6">
                      <span className="text-ink-500">{t && l.adults > t.base_occupancy ? `Includes extra person ${rupees(t.extra_person_rate_paise, { decimals: 0 })}/night` : ''}</span>
                      <span className="flex items-center gap-3"><span className="font-semibold">{rupees(lineTotal(l))}</span>
                        {lines.length > 1 && <button type="button" className="btn-ghost btn-sm text-red-600" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</button>}</span>
                    </div>
                  </div>
                );
              })}
              <button type="button" className="btn-secondary btn-sm" onClick={() => setLines([...lines, { room_type_id: '', room_id: '', adults: 2, children: 0, rate: '' }])}>+ Add room</button>
            </div>
          </div>

          <div className="card p-4">
            <h2 className="mb-3">Guest</h2>
            {existing ? (
              <div className="flex items-center justify-between rounded-xl bg-night-50 px-3 py-2 ring-1 ring-inset ring-night-200">
                <div><div className="font-semibold">{existing.full_name}</div><div className="text-xs text-ink-500">{existing.phone} · {existing.stay_count} previous stays</div></div>
                <button type="button" className="btn-ghost btn-sm" onClick={() => setExisting(null)}>Change</button>
              </div>
            ) : null}
            {existing ? (
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Company (for GST invoice)"><input className="input" value={company.company_name} disabled={!can('guests.manage')} onChange={(e) => setCompany({ ...company, company_name: e.target.value })} /></Field>
                <Field label="Company GSTIN"><input className="input uppercase" maxLength={15} value={company.company_gstin} disabled={!can('guests.manage')} onChange={(e) => setCompany({ ...company, company_gstin: e.target.value.toUpperCase() })} /></Field>
              </div>
            ) : (
              <>
                <div className="relative mb-4">
                  <input className="input" placeholder="Search returning guest by name or phone…" value={guestQuery} onChange={(e) => setGuestQuery(e.target.value)} />
                  {guestResults.length > 0 && (
                    <div className="absolute z-10 mt-1 w-full rounded-lg border border-ink-100 bg-white shadow-lg">
                      {guestResults.slice(0, 6).map((g) => (
                        <button type="button" key={g.id} className="block w-full px-3 py-2 text-left text-sm hover:bg-ink-50" onClick={() => { pickGuest(g); setGuestQuery(''); setGuestResults([]); }}>
                          {g.full_name} <span className="text-ink-400">· {g.phone}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Full name *"><input className="input" required value={guest.full_name} onChange={(e) => setGuest({ ...guest, full_name: e.target.value })} /></Field>
                  <Field label="Phone"><input className="input" type="tel" value={guest.phone} onChange={(e) => setGuest({ ...guest, phone: e.target.value })} /></Field>
                  <Field label="Email"><input className="input" type="email" value={guest.email} onChange={(e) => setGuest({ ...guest, email: e.target.value })} /></Field>
                  <Field label="City"><input className="input" value={guest.city} onChange={(e) => setGuest({ ...guest, city: e.target.value })} /></Field>
                  <Field label="ID type">
                    <select className="input" value={guest.id_type} onChange={(e) => setGuest({ ...guest, id_type: e.target.value })}>
                      {['Aadhaar', 'Passport', 'Driving licence', 'Voter ID', 'PAN', 'Other'].map((x) => <option key={x}>{x}</option>)}
                    </select>
                  </Field>
                  <Field label={walkIn ? 'ID number *' : 'ID number'}><input className="input" required={walkIn} value={guest.id_number} onChange={(e) => setGuest({ ...guest, id_number: e.target.value })} /></Field>
                  <Field label="Company (for GST invoice)"><input className="input" value={guest.company_name} onChange={(e) => setGuest({ ...guest, company_name: e.target.value })} /></Field>
                  <Field label="Company GSTIN"><input className="input uppercase" maxLength={15} value={guest.company_gstin} onChange={(e) => setGuest({ ...guest, company_gstin: e.target.value.toUpperCase() })} /></Field>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="space-y-5">
          <div className="card p-4">
            <h2 className="mb-3">Requests & notes</h2>
            <Field label="Guest special requests"><textarea className="input" rows={2} value={special} onChange={(e) => setSpecial(e.target.value)} /></Field>
            <Field label="Internal notes" className="mt-3"><textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
          </div>
          {can('payments.record') && (
            <div className="card p-4">
              <h2 className="mb-3">Advance / deposit</h2>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Amount ₹"><input className="input" inputMode="decimal" value={deposit.amount} onChange={(e) => setDeposit({ ...deposit, amount: e.target.value })} /></Field>
                <Field label="Method">
                  <select className="input" value={deposit.method} onChange={(e) => setDeposit({ ...deposit, method: e.target.value })}>
                    {['cash', 'upi', 'card', 'online', 'bank_transfer'].map((m) => <option key={m} value={m}>{m.toUpperCase().replace('_', ' ')}</option>)}
                  </select>
                </Field>
                <Field label="Reference" className="col-span-2"><input className="input" value={deposit.reference} onChange={(e) => setDeposit({ ...deposit, reference: e.target.value })} /></Field>
              </div>
            </div>
          )}
          <div className="card sticky top-20 p-4">
            <div className="flex justify-between text-sm"><span className="text-ink-500">{lines.length} room(s) × {n} night(s)</span><span>{rupees(total)}</span></div>
            <div className="mt-1 text-xs text-ink-400">Before taxes. GST is applied per night on the bill.</div>
            <button className="btn-primary mt-4 w-full py-2.5" disabled={busy || n < 1}>{walkIn ? 'Create & check in' : 'Create booking'}</button>
          </div>
        </div>
      </div>
    </form>
  );
}
