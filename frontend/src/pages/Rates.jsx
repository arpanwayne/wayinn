// Rates: date-wise rate calendar, Rate Guard (OTA prices → suggested direct rate), Google Hotels, history.
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../lib/hooks.js';
import { api, request } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { rupees0, toPaise, addDays, fmtDate, fmtDateLong, fmtDateTime, ago, label } from '../lib/format.js';
import { PageHeader, Loading, Modal, Field, Tabs, Badge, Empty, Stat, ErrorBox, useAction, useToast } from '../components/ui.jsx';

const WEEKDAYS = [['Sun', 0], ['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5], ['Sat', 6]];
const inr = (p) => (p === null || p === undefined ? '—' : `₹${Math.round(Number(p) / 100).toLocaleString('en-IN')}`);
const dayName = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short' });
const weekend = (d) => [0, 6].includes(new Date(`${d}T00:00:00`).getDay());
const SOURCE_NAMES = { manual: 'Set by hand', rate_guard: 'Rate Guard (approved)', auto_pilot: 'Rate Guard (auto)', undo: 'Undo' };

export default function Rates() {
  const { can } = useAuth();
  const manage = can('rates.manage');
  const [params, setParams] = useSearchParams();
  const tabs = [['calendar', 'Rate calendar'], ...(manage ? [['guard', 'Rate Guard'], ['google', 'Google Hotels'], ['history', 'History & report']] : [])];
  const tab = tabs.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'calendar';
  return (
    <div>
      <PageHeader title="Rates" subtitle="Date-wise room rates. The booking page, front desk, channel manager and Google all use these." />
      <Tabs tabs={tabs} value={tab} onChange={(k) => setParams({ tab: k })} />
      {tab === 'calendar' && <RateCalendar manage={manage} />}
      {tab === 'guard' && <RateGuard />}
      {tab === 'google' && <GoogleHotels />}
      {tab === 'history' && <History />}
    </div>
  );
}

// ---------------------------------------------------------------
// Rate calendar
// ---------------------------------------------------------------
function RateCalendar({ manage }) {
  // null = start from the hotel's today (the server knows its time zone).
  const [from, setFrom] = useState(null);
  const [span, setSpan] = useState(14);
  const { data: d, error, reload: refresh } = useApi(from ? `/rates/calendar?from=${from}&to=${addDays(from, span)}` : '/rates/calendar');
  const [edit, setEdit] = useState(null);
  useEffect(() => { if (d && !from) setFrom(d.from); }, [d, from]);
  if (error) return <ErrorBox error={error} />;
  if (!d) return <Loading />;
  const days = d.room_types[0]?.nights.map((n) => n.date) || [];
  const CELL = span > 14 ? 64 : 80;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-secondary" onClick={() => setFrom(addDays(from, -7))} disabled={from <= d.today}>‹ Week</button>
        <button className="btn-secondary" onClick={() => setFrom(d.today)}>Today</button>
        <button className="btn-secondary" onClick={() => setFrom(addDays(from, 7))}>Week ›</button>
        <select className="input w-auto" value={span} onChange={(e) => setSpan(Number(e.target.value))}>
          <option value={14}>14 days</option><option value={30}>30 days</option><option value={60}>60 days</option>
        </select>
        <div className="flex-1" />
        {manage && <button className="btn-primary" onClick={() => setEdit({ room_type_ids: d.room_types.map((t) => t.id), from: from || d.today, to: addDays(from || d.today, 6) })}>Change rates</button>}
      </div>
      <div className="card overflow-x-auto">
        <div style={{ minWidth: 170 + CELL * days.length }}>
          <div className="flex border-b border-ink-100 bg-white text-xs">
            <div className="w-[170px] shrink-0 px-3 py-2 font-semibold text-ink-400">Room type</div>
            {days.map((x) => (
              <div key={x} style={{ width: CELL }} className={`shrink-0 border-l border-ink-50 py-2 text-center ${x === d.today ? 'bg-night-900 font-bold text-white' : weekend(x) ? 'bg-ink-50 text-ink-500' : 'text-ink-500'}`}>
                <div>{dayName(x)}</div><div className="font-semibold">{new Date(`${x}T00:00:00`).getDate()} {new Date(`${x}T00:00:00`).toLocaleDateString('en-IN', { month: 'short' })}</div>
              </div>
            ))}
          </div>
          {d.room_types.map((t) => (
            <div key={t.id} className="flex border-b border-ink-50">
              <div className="w-[170px] shrink-0 px-3 py-2">
                <div className="text-sm font-semibold">{t.name}</div>
                <div className="text-xs text-ink-500">Base {inr(t.base_rate_paise)}</div>
              </div>
              {t.nights.map((n) => (
                <button key={n.date} style={{ width: CELL }} disabled={!manage}
                  title={`${t.name} · ${fmtDateLong(n.date)}\n${inr(n.rate_paise)}${n.overridden ? ` (base ${inr(n.base_rate_paise)})` : ' (base rate)'}${n.min_stay ? ` · min ${n.min_stay} nights` : ''}${n.stop_sell ? ' · closed for sale' : ''}${n.source ? ` · ${SOURCE_NAMES[n.source] || n.source}` : ''}\n${n.available} rooms free`}
                  onClick={() => setEdit({ room_type_ids: [t.id], from: n.date, to: n.date })}
                  className={`shrink-0 border-l border-ink-50 px-1 py-2 text-center transition ${n.stop_sell ? 'bg-ink-900 text-white' : n.overridden ? 'bg-night-50' : ''} ${manage ? 'hover:ring-2 hover:ring-inset hover:ring-night-300' : 'cursor-default'}`}>
                  <div className={`text-[13px] font-semibold tabular-nums ${n.stop_sell ? '' : n.overridden ? 'text-night-900' : 'text-ink-700'}`}>
                    {Math.round(n.rate_paise / 100).toLocaleString('en-IN')}
                    {['rate_guard', 'auto_pilot'].includes(n.source) && <span className="ml-0.5 text-[9px] align-top" title="Set by Rate Guard">●</span>}
                  </div>
                  <div className={`text-[10px] ${n.stop_sell ? 'text-ink-300' : n.available ? 'text-ink-400' : 'font-semibold text-red-600'}`}>
                    {n.stop_sell ? 'Closed' : n.available ? `${n.available} left` : 'Sold out'}
                  </div>
                  {n.min_stay > 1 && <div className="text-[10px] font-semibold text-amber-600">min {n.min_stay}N</div>}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-4 text-xs text-ink-500">
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm border border-ink-200 bg-white" />Base rate</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm bg-night-50 ring-1 ring-night-200" />Date rate</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm bg-ink-900" />Closed for sale (stop-sell)</span>
        <span>● set by Rate Guard</span>
        <span>Rates are per night, before GST.</span>
      </div>
      {edit && <EditRates initial={edit} types={d.room_types} today={d.today} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); refresh(); }} />}
    </div>
  );
}

function EditRates({ initial, types, today, onClose, onSaved }) {
  const [f, setF] = useState({ ...initial, weekdays: [], rateMode: 'set', rate: '', stayMode: 'keep', minStay: 2, sellMode: 'keep' });
  const [run, busy] = useAction();
  const one = f.room_type_ids.length === 1 && f.from === f.to ? types.find((t) => t.id === f.room_type_ids[0])?.nights.find((n) => n.date === f.from) : null;
  useEffect(() => {
    if (one) setF((x) => ({ ...x, rate: String(one.rate_paise / 100), stayMode: one.min_stay ? 'set' : 'keep', minStay: one.min_stay || 2, sellMode: one.stop_sell ? 'close' : 'keep' }));
  }, []); // eslint-disable-line
  const set = (p) => setF({ ...f, ...p });
  const toggle = (k, v) => set({ [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v] });
  const body = { room_type_ids: f.room_type_ids, from: f.from, to: f.to, weekdays: f.weekdays };
  if (f.rateMode === 'set' && f.rate !== '') body.rate_paise = toPaise(f.rate);
  if (f.rateMode === 'base') body.rate_paise = null;
  if (f.stayMode === 'set') body.min_stay = Number(f.minStay) || 1;
  if (f.stayMode === 'none') body.min_stay = null;
  if (f.sellMode !== 'keep') body.stop_sell = f.sellMode === 'close';
  const nothing = !('rate_paise' in body) && !('min_stay' in body) && !('stop_sell' in body);
  const save = () => run(async () => {
    const r = await api.put('/rates/calendar', body);
    onSaved(r);
    return r;
  }, 'Rates saved');
  return (
    <Modal open onClose={onClose} title="Change rates" wide
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={busy || nothing || !f.room_type_ids.length || f.to < f.from} onClick={save}>Save</button></>}>
      <div className="space-y-4">
        <div>
          <span className="label">Room types</span>
          <div className="flex flex-wrap gap-2">
            {types.map((t) => (
              <label key={t.id} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm ${f.room_type_ids.includes(t.id) ? 'border-night-900 bg-night-50' : 'border-ink-200'}`}>
                <input type="checkbox" checked={f.room_type_ids.includes(t.id)} onChange={() => toggle('room_type_ids', t.id)} /> {t.name}
              </label>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="From"><input type="date" className="input" min={today} value={f.from} onChange={(e) => set({ from: e.target.value, to: f.to < e.target.value ? e.target.value : f.to })} /></Field>
          <Field label="To (including)"><input type="date" className="input" min={f.from} value={f.to} onChange={(e) => set({ to: e.target.value })} /></Field>
        </div>
        {f.from !== f.to && (
          <div>
            <span className="label">Only on (leave empty for every day)</span>
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAYS.map(([l, v]) => (
                <button key={v} type="button" onClick={() => toggle('weekdays', v)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${f.weekdays.includes(v) ? 'bg-night-900 text-white' : 'bg-ink-100 text-ink-600'}`}>{l}</button>
              ))}
            </div>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Rate per night (before GST)">
            <select className="input mb-2" value={f.rateMode} onChange={(e) => set({ rateMode: e.target.value })}>
              <option value="set">Set rate</option><option value="keep">Keep as is</option><option value="base">Back to base rate</option>
            </select>
            {f.rateMode === 'set' && <input className="input" inputMode="decimal" placeholder="₹" value={f.rate} onChange={(e) => set({ rate: e.target.value })} />}
          </Field>
          <Field label="Minimum stay" hint="Counted from the arrival date">
            <select className="input mb-2" value={f.stayMode} onChange={(e) => set({ stayMode: e.target.value })}>
              <option value="keep">Keep as is</option><option value="set">Set minimum</option><option value="none">No minimum</option>
            </select>
            {f.stayMode === 'set' && <input type="number" min={1} max={30} className="input" value={f.minStay} onChange={(e) => set({ minStay: e.target.value })} />}
          </Field>
          <Field label="Online sale" hint="Closed = not sold on the booking page, Google or OTAs">
            <select className="input" value={f.sellMode} onChange={(e) => set({ sellMode: e.target.value })}>
              <option value="keep">Keep as is</option><option value="open">Open</option><option value="close">Close (stop-sell)</option>
            </select>
          </Field>
        </div>
        <p className="text-xs text-ink-500">Bookings already made keep the price they were made at. Every change is saved in History and can be undone.</p>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------
// Rate Guard
// ---------------------------------------------------------------
function RateGuard() {
  const { data, error, reload } = useApi('/rate-guard');
  const [showSetup, setShowSetup] = useState(false);
  const [manual, setManual] = useState(false);
  const [run, busy] = useAction();
  const toast = useToast();
  const [tick, setTick] = useState(0);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  if (!data.addon) {
    return (
      <div className="card max-w-2xl space-y-2 p-6">
        <h2>Rate Guard is an add-on</h2>
        <p className="text-sm text-ink-600">Rate Guard watches what MakeMyTrip, Goibibo, Booking.com, Agoda and others charge for your hotel on Google, and suggests a direct rate a little below the cheapest one. You approve on WhatsApp with one reply. It also puts your direct rate on Google Hotels so guests can book with you without OTA commission.</p>
        <p className="text-sm text-ink-600">Ask Wayne E Solutions to switch it on for your hotel. The rate calendar works without it.</p>
      </div>
    );
  }
  const cfg = data.config;
  const mapped = data.rooms.filter((r) => r.mapping?.enabled).length;
  const steps = [
    [cfg.provider === 'manual' || !!cfg.property_token, 'Link your hotel on Google Hotels'],
    [mapped > 0, 'Set floor and ceiling prices for your room types'],
    [cfg.alert_phones.length > 0, 'Add the WhatsApp number for alerts'],
    [cfg.enabled, 'Switch Rate Guard on'],
  ];
  const ready = steps.every(([ok]) => ok);
  const refresh = () => { reload(); setTick((t) => t + 1); };
  const check = () => run(async () => {
    const r = await api.post('/rate-guard/check', {});
    refresh();
    toast(r.errors.length ? `Checked ${r.checked} dates with problems: ${r.errors[0]}` : `Checked ${r.checked} dates · ${r.offers} OTA prices · ${r.suggestions} new suggestions`,
      r.errors.length ? 'error' : 'success');
  }).catch(() => {});
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Status" value={cfg.enabled ? 'On' : 'Off'} sub={cfg.mode === 'auto' ? `Auto-pilot, up to ±${cfg.auto_max_change_pct}% a day` : 'You approve each change'} />
        <Stat label="Waiting for you" value={data.pending} tone={data.pending ? 'warn' : 'default'} sub="Rate suggestions" />
        <Stat label="Rates changed" value={data.applied_30d} sub="Last 30 days" />
        <Stat label="Last price check" value={data.runs[0] ? ago(data.runs[0].started_at) : '—'} sub={data.runs[0]?.status === 'failed' ? `Failed: ${data.runs[0].error}` : cfg.property_name || 'Not linked yet'} tone={data.runs[0]?.status === 'failed' ? 'bad' : 'default'} />
      </div>
      {!ready && (
        <div className="card p-4">
          <h2 className="mb-2">Set up Rate Guard</h2>
          <ol className="space-y-1 text-sm">
            {steps.map(([ok, l], i) => <li key={i} className={ok ? 'text-brand-700' : 'text-ink-600'}>{ok ? '✓' : `${i + 1}.`} {l}</li>)}
          </ol>
          <button className="btn-primary mt-3" onClick={() => setShowSetup(true)}>Open setup</button>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button className="btn-secondary" disabled={busy || (cfg.provider !== 'manual' && !cfg.property_token)} onClick={check}>{busy ? 'Checking…' : 'Check OTA prices now'}</button>
        <button className="btn-secondary" onClick={() => setManual(true)}>Add an OTA price</button>
        <div className="flex-1" />
        <button className="btn-secondary" onClick={() => setShowSetup(!showSetup)}>{showSetup ? 'Hide setup' : 'Setup'}</button>
      </div>
      {showSetup && <GuardSetup data={data} onSaved={refresh} />}
      <Suggestions key={`s${tick}`} onChange={refresh} />
      <PriceTable key={`t${tick}`} today={data.today} />
      {manual && <ManualPrice rooms={data.rooms} today={data.today} onClose={() => setManual(false)} onSaved={() => { setManual(false); refresh(); }} />}
      {data.runs.length > 0 && (
        <details className="card p-4">
          <summary className="cursor-pointer text-sm font-semibold">Recent price checks</summary>
          <table className="table mt-2">
            <thead><tr><th>When</th><th>Stay date</th><th>Source</th><th>Offers</th><th>Result</th></tr></thead>
            <tbody>{data.runs.map((r) => (
              <tr key={r.id}><td>{fmtDateTime(r.started_at)}</td><td>{fmtDate(r.stay_date)}</td><td>{r.provider}{r.trigger === 'manual' ? ' (by hand)' : ''}</td><td>{r.offers}</td>
                <td>{r.status === 'failed' ? <span className="text-red-600">{r.error}</span> : <Badge status={r.status === 'ok' ? 'done' : r.status}>{r.status === 'ok' ? 'OK' : label(r.status)}</Badge>}</td></tr>
            ))}</tbody>
          </table>
        </details>
      )}
    </div>
  );
}

function Suggestions({ onChange }) {
  const { data, reload } = useApi('/rate-guard/suggestions', { interval: 60000 });
  const [run, busy] = useAction();
  if (!data) return null;
  if (!data.length) return <div className="card p-4 text-sm text-ink-500">No rate suggestions waiting. You will get a WhatsApp message when an OTA changes its price.</div>;
  const act = (path, msg) => run(async () => { await api.post(path); reload(); onChange(); }, msg);
  return (
    <div className="card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-100 px-4 py-3">
        <h2>Waiting for your approval ({data.length})</h2>
        <div className="flex gap-2">
          <button className="btn-secondary btn-sm" disabled={busy} onClick={() => act('/rate-guard/suggestions/reject-all', 'Skipped')}>Skip all</button>
          <button className="btn-primary btn-sm" disabled={busy} onClick={() => act('/rate-guard/suggestions/approve-all', 'All approved')}>Approve all</button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="table">
          <thead><tr><th>Date</th><th>Room type</th><th>OTA price</th><th className="text-right">Now</th><th className="text-right">Suggested</th><th>Why</th><th /></tr></thead>
          <tbody>
            {data.map((s) => {
              const down = Number(s.suggested_rate_paise) < Number(s.current_rate_paise);
              return (
                <tr key={s.id}>
                  <td className="whitespace-nowrap font-semibold">{fmtDate(s.stay_date)} <span className="text-xs font-normal text-ink-500">{dayName(s.stay_date)}</span></td>
                  <td>{s.room_type}</td>
                  <td className="whitespace-nowrap">{s.ota_name} {inr(s.ota_rate_paise)}</td>
                  <td className="text-right tabular-nums text-ink-500">{inr(s.current_rate_paise)}</td>
                  <td className={`text-right font-semibold tabular-nums ${down ? 'text-night-900' : 'text-brand-700'}`}>{down ? '↓' : '↑'} {inr(s.suggested_rate_paise)}</td>
                  <td className="max-w-xs text-xs text-ink-500">{s.reason}<div className="text-ink-400">WhatsApp code {s.code}</div></td>
                  <td className="whitespace-nowrap text-right">
                    <button className="btn-ghost btn-sm" disabled={busy} onClick={() => act(`/rate-guard/suggestions/${s.id}/reject`, 'Skipped')}>Skip</button>
                    <button className="btn-primary btn-sm" disabled={busy} onClick={() => act(`/rate-guard/suggestions/${s.id}/approve`, `${s.room_type} on ${fmtDate(s.stay_date)} is now ${inr(s.suggested_rate_paise)}`)}>Approve</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PriceTable({ today }) {
  const [days, setDays] = useState(14);
  const [roomId, setRoomId] = useState(null);
  const { data } = useApi(`/rate-guard/dashboard?from=${today}&days=${days}`, { interval: 120000 });
  useEffect(() => { if (data && !roomId) setRoomId(data.room_types.find((r) => r.mapping?.enabled)?.id || data.room_types[0]?.id); }, [data, roomId]);
  if (!data) return <Loading />;
  const rt = data.room_types.find((r) => r.id === roomId) || data.room_types[0];
  if (!rt) return null;
  const otas = data.otas.filter((o) => rt.days.some((d) => d.otas[o.key]));
  return (
    <div className="card">
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-100 px-4 py-3">
        <h2 className="mr-2">Your rate vs OTAs</h2>
        {data.room_types.map((r) => (
          <button key={r.id} onClick={() => setRoomId(r.id)} className={`rounded-lg px-3 py-1 text-sm font-semibold ${r.id === rt.id ? 'bg-night-900 text-white' : 'bg-ink-100 text-ink-600'}`}>{r.name}</button>
        ))}
        <div className="flex-1" />
        <select className="input w-auto py-1" value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={14}>14 days</option><option value={30}>30 days</option></select>
      </div>
      {!rt.mapping && <div className="px-4 py-3 text-sm text-amber-600">{rt.name} is not set up in Rate Guard yet (Setup → Room types).</div>}
      <div className="overflow-x-auto">
        <table className="table">
          <thead>
            <tr><th>Date</th><th className="text-right">Your rate</th>{otas.map((o) => <th key={o.key} className="text-right">{o.name}</th>)}<th className="text-right">Cheapest OTA</th><th className="text-right">Suggested</th></tr>
          </thead>
          <tbody>
            {rt.days.map((d) => {
              const under = d.cheapest && d.our_rate_paise < d.cheapest.pretax;
              return (
                <tr key={d.date} className={weekend(d.date) ? 'bg-ink-50/60' : ''}>
                  <td className="whitespace-nowrap"><span className="font-semibold">{fmtDate(d.date)}</span> <span className="text-xs text-ink-500">{dayName(d.date)}</span></td>
                  <td className={`text-right font-semibold tabular-nums ${d.stop_sell ? 'text-ink-400 line-through' : ''}`}>{inr(d.our_rate_paise)}
                    {d.cheapest && !d.stop_sell && <div className={`text-[11px] font-normal ${under ? 'text-brand-700' : 'text-red-600'}`}>{under ? 'Below OTAs' : 'Above OTAs'}</div>}</td>
                  {otas.map((o) => {
                    const x = d.otas[o.key];
                    return <td key={o.key} className="text-right tabular-nums" title={x ? `${x.room_name || 'Lowest room'} · shown ${inr(x.rate_paise)} with taxes · seen ${ago(x.seen)}` : ''}>
                      {x ? <>{inr(x.pretax)}<div className="text-[11px] text-ink-400">{inr(x.rate_paise)} incl.</div></> : <span className="text-ink-300">—</span>}</td>;
                  })}
                  <td className="text-right tabular-nums">{d.cheapest ? <><span className="font-semibold">{inr(d.cheapest.pretax)}</span><div className="text-[11px] text-ink-500">{d.cheapest.name}</div></> : <span className="text-ink-300">No data</span>}</td>
                  <td className="text-right tabular-nums">{d.suggestion ? <span className="font-semibold text-night-900">{inr(d.suggestion.suggested_rate_paise)}</span> : <span className="text-ink-300">—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="px-4 py-2 text-xs text-ink-500">OTA prices are shown before GST so they compare with your rates (which have GST added on the bill). Hover a price for the room and when it was seen.</p>
    </div>
  );
}

function GuardSetup({ data, onSaved }) {
  const cfg = data.config;
  const [f, setF] = useState(() => ({ ...cfg, undercut_pct: String(cfg.undercut_pct), min_change: String(cfg.min_change_paise / 100), phones: cfg.alert_phones.map((p) => `+${p}`).join('\n') }));
  const [rooms, setRooms] = useState(() => data.rooms.map((r, i) => ({
    room_type_id: r.id, name: r.name, base: r.base_rate_paise,
    enabled: r.mapping ? r.mapping.enabled : true,
    floor: String(Math.round((r.mapping?.floor_paise ?? r.base_rate_paise * 0.7) / 100)),
    ceiling: String(Math.round((r.mapping?.ceiling_paise ?? r.base_rate_paise * 1.5) / 100)),
    match_keywords: r.mapping ? r.mapping.match_keywords || '' : (i === 0 ? '' : r.name.toLowerCase()),
    meal_plan: r.mapping?.meal_plan || 'any', refundable: r.mapping?.refundable || 'any', saved: !!r.mapping,
  })));
  const [q, setQ] = useState(cfg.property_name || '');
  const [found, setFound] = useState(null);
  const [run, busy] = useAction();
  const set = (p) => setF({ ...f, ...p });
  const setR = (i, p) => setRooms(rooms.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const provider = data.providers.find((p) => p.name === f.provider);
  const saveConfig = () => run(async () => {
    await api.put('/rate-guard/config', {
      enabled: !!f.enabled, provider: f.provider, undercut_pct: Number(f.undercut_pct), rounding: f.rounding, min_change_paise: toPaise(f.min_change),
      mode: f.mode, auto_max_change_pct: Number(f.auto_max_change_pct), alert_on_increase: !!f.alert_on_increase, max_alerts_per_run: Number(f.max_alerts_per_run),
      alert_phones: f.phones.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean), horizon_days: Number(f.horizon_days), near_days: Number(f.near_days),
      near_every_hours: Number(f.near_every_hours), far_every_hours: Number(f.far_every_hours),
    });
    onSaved();
  }, 'Rate Guard settings saved');
  const saveRooms = () => run(async () => {
    await api.put('/rate-guard/rooms', rooms.map((r) => ({
      room_type_id: r.room_type_id, enabled: r.enabled, floor_paise: toPaise(r.floor), ceiling_paise: toPaise(r.ceiling),
      match_keywords: r.match_keywords.trim() || null, meal_plan: r.meal_plan, refundable: r.refundable,
    })));
    onSaved();
  }, 'Room types saved');
  const search = () => run(async () => setFound(await api.get(`/rate-guard/property-search?q=${encodeURIComponent(q)}`)));
  const link = (p) => run(async () => { await api.put('/rate-guard/property', { token: p.token, name: p.name, address: p.address }); setFound(null); onSaved(); }, `Linked to ${p.name}`);
  return (
    <div className="space-y-4">
      <div className="card space-y-3 p-4">
        <h2>1. Your hotel on Google Hotels</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Price data from" hint={provider?.note}>
            <select className="input" value={f.provider} onChange={(e) => set({ provider: e.target.value })}>
              {data.providers.map((p) => <option key={p.name} value={p.name}>{p.label}{p.ready ? '' : ' (not set up on server)'}</option>)}
            </select>
          </Field>
          {f.provider !== 'manual' && (
            <Field label="Search your hotel" className="sm:col-span-2" hint={cfg.property_name ? `Linked: ${cfg.property_name}${cfg.property_address ? `, ${cfg.property_address}` : ''}` : 'Type the name as it appears on Google, with the city'}>
              <div className="flex gap-2">
                <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Hotel name, Ludhiana" />
                <button className="btn-secondary" disabled={busy || q.trim().length < 3 || f.provider !== cfg.provider} onClick={search}>Search</button>
              </div>
              {f.provider !== cfg.provider && <span className="mt-1 block text-xs text-amber-600">Save the settings below first, then search.</span>}
            </Field>
          )}
        </div>
        {found && (found.length ? (
          <div className="divide-y divide-ink-100 rounded-lg border border-ink-100">
            {found.map((p) => (
              <div key={p.token} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <div><div className="font-semibold">{p.name}</div><div className="text-xs text-ink-500">{[p.address, p.rating && `★ ${p.rating}`].filter(Boolean).join(' · ')}</div></div>
                <button className="btn-primary btn-sm" disabled={busy} onClick={() => link(p)}>This is my hotel</button>
              </div>
            ))}
          </div>
        ) : <Empty>No hotel found. Try the exact Google name with the city.</Empty>)}
      </div>

      <div className="card space-y-3 p-4">
        <h2>2. Rules</h2>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Stay below the cheapest OTA by %"><input className="input" inputMode="decimal" value={f.undercut_pct} onChange={(e) => set({ undercut_pct: e.target.value })} /></Field>
          <Field label="Round to">
            <select className="input" value={f.rounding} onChange={(e) => set({ rounding: e.target.value })}>
              <option value="49_99">₹…49 / ₹…99</option><option value="99">₹…99</option><option value="none">Whole rupees</option>
            </select>
          </Field>
          <Field label="Ignore changes smaller than ₹"><input className="input" inputMode="decimal" value={f.min_change} onChange={(e) => set({ min_change: e.target.value })} /></Field>
          <Field label="Mode">
            <select className="input" value={f.mode} onChange={(e) => set({ mode: e.target.value })}>
              <option value="approve">I approve every change</option><option value="auto">Auto-pilot within limits</option>
            </select>
          </Field>
          {f.mode === 'auto' && (
            <Field label="Auto-pilot: at most ±% a day" hint="Bigger changes still wait for you"><input className="input" inputMode="decimal" value={f.auto_max_change_pct} onChange={(e) => set({ auto_max_change_pct: e.target.value })} /></Field>
          )}
        </div>
        <h3 className="pt-2 text-sm font-semibold">WhatsApp alerts</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Numbers (one per line, max 5)" hint="Only these numbers can approve by replying YES"><textarea className="input" rows={2} value={f.phones} onChange={(e) => set({ phones: e.target.value })} placeholder="+91 98765 43210" /></Field>
          <Field label="Separate messages up to" hint="More suggestions at once → one summary message"><input type="number" min={0} max={20} className="input" value={f.max_alerts_per_run} onChange={(e) => set({ max_alerts_per_run: e.target.value })} /></Field>
          <label className="flex items-center gap-2 self-center text-sm"><input type="checkbox" checked={!!f.alert_on_increase} onChange={(e) => set({ alert_on_increase: e.target.checked })} /> Also alert when I can raise my rate</label>
        </div>
        {!data.whatsapp_ready && <p className="text-xs text-amber-600">Your hotel's WhatsApp number is not connected yet, so alerts cannot go out. Wayne E Solutions adds it. You can still approve here.</p>}
        <h3 className="pt-2 text-sm font-semibold">How often</h3>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Watch the next … days"><input type="number" min={1} max={90} className="input" value={f.horizon_days} onChange={(e) => set({ horizon_days: e.target.value })} /></Field>
          <Field label="Of which the first … days"><input type="number" min={0} max={30} className="input" value={f.near_days} onChange={(e) => set({ near_days: e.target.value })} /></Field>
          <Field label="… every … hours"><input type="number" min={1} max={24} className="input" value={f.near_every_hours} onChange={(e) => set({ near_every_hours: e.target.value })} /></Field>
          <Field label="Other days every … hours"><input type="number" min={1} max={168} className="input" value={f.far_every_hours} onChange={(e) => set({ far_every_hours: e.target.value })} /></Field>
        </div>
        <div className="flex flex-wrap items-center gap-4 border-t border-ink-100 pt-3">
          <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={!!f.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Rate Guard on</label>
          <button className="btn-primary" disabled={busy} onClick={saveConfig}>Save settings</button>
        </div>
      </div>

      <div className="card space-y-3 p-4">
        <h2>3. Room types</h2>
        <p className="text-xs text-ink-500">Rate Guard never goes below the floor or above the ceiling. "Matches OTA rooms named" decides which OTA room is compared with yours (comma separated words). Leave it empty only for your cheapest room type: it is compared with the cheapest room on each OTA.</p>
        <div className="overflow-x-auto">
          <table className="table">
            <thead><tr><th>On</th><th>Room type</th><th>Floor ₹</th><th>Ceiling ₹</th><th>Matches OTA rooms named</th><th>Meal plan</th><th>Cancellation</th></tr></thead>
            <tbody>
              {rooms.map((r, i) => (
                <tr key={r.room_type_id}>
                  <td><input type="checkbox" checked={r.enabled} onChange={(e) => setR(i, { enabled: e.target.checked })} /></td>
                  <td><div className="font-semibold">{r.name}</div><div className="text-xs text-ink-500">Base {inr(r.base)}{!r.saved && ' · not saved yet'}</div></td>
                  <td><input className="input w-24" inputMode="numeric" value={r.floor} onChange={(e) => setR(i, { floor: e.target.value })} /></td>
                  <td><input className="input w-24" inputMode="numeric" value={r.ceiling} onChange={(e) => setR(i, { ceiling: e.target.value })} /></td>
                  <td><input className="input min-w-40" value={r.match_keywords} placeholder="cheapest room" onChange={(e) => setR(i, { match_keywords: e.target.value })} /></td>
                  <td><select className="input" value={r.meal_plan} onChange={(e) => setR(i, { meal_plan: e.target.value })}><option value="any">Any</option><option value="room_only">Room only</option><option value="breakfast">With breakfast</option></select></td>
                  <td><select className="input" value={r.refundable} onChange={(e) => setR(i, { refundable: e.target.value })}><option value="any">Any</option><option value="refundable">Free cancellation</option><option value="non_refundable">Non-refundable</option></select></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button className="btn-primary" disabled={busy} onClick={saveRooms}>Save room types</button>
      </div>
    </div>
  );
}

function ManualPrice({ rooms, today, onClose, onSaved }) {
  const [f, setF] = useState({ stay_date: today, ota_name: 'MakeMyTrip', room_name: rooms[0]?.name || '', rate: '', includes_tax: true, breakfast: false });
  const [run, busy] = useAction();
  const set = (p) => setF({ ...f, ...p });
  const save = () => run(async () => {
    const r = await api.post('/rate-guard/observations', { stay_date: f.stay_date, ota_name: f.ota_name, room_name: f.room_name || null, rate_paise: toPaise(f.rate),
      includes_tax: f.includes_tax, breakfast: f.breakfast || null });
    onSaved();
    return r;
  }, 'Price added');
  return (
    <Modal open onClose={onClose} title="Add an OTA price"
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={busy || !f.rate} onClick={save}>Add</button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Stay date"><input type="date" className="input" min={today} value={f.stay_date} onChange={(e) => set({ stay_date: e.target.value })} /></Field>
        <Field label="OTA"><input className="input" list="ota-names" value={f.ota_name} onChange={(e) => set({ ota_name: e.target.value })} />
          <datalist id="ota-names">{['MakeMyTrip', 'Goibibo', 'Booking.com', 'Agoda', 'Expedia', 'OYO', 'Cleartrip', 'Yatra', 'EaseMyTrip'].map((x) => <option key={x} value={x} />)}</datalist></Field>
        <Field label="Room name on the OTA" className="col-span-2" hint="Used to match your room types"><input className="input" value={f.room_name} onChange={(e) => set({ room_name: e.target.value })} /></Field>
        <Field label="Price per night ₹"><input className="input" inputMode="decimal" value={f.rate} onChange={(e) => set({ rate: e.target.value })} /></Field>
        <div className="space-y-2 self-end pb-2 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={f.includes_tax} onChange={(e) => set({ includes_tax: e.target.checked })} /> Price includes GST</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={f.breakfast} onChange={(e) => set({ breakfast: e.target.checked })} /> Breakfast included</label>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------
// Google Hotels
// ---------------------------------------------------------------
function GoogleHotels() {
  const { data, error, reload } = useApi('/google');
  const [f, setF] = useState(null);
  const [preview, setPreview] = useState(null);
  const [run, busy] = useAction();
  useEffect(() => {
    if (!data) return;
    const c = data.config;
    setF({ enabled: c.enabled, latitude: c.latitude ?? '', longitude: c.longitude ?? '', postal_code: c.postal_code || '', category: c.category,
      refundable: c.refundable_days === null ? 'no' : 'yes', refundable_days: c.refundable_days ?? 1, breakfast_included: c.breakfast_included, photos: (c.photo_urls || []).join('\n') });
  }, [data]);
  if (error) return <ErrorBox error={error} />;
  if (!data || !f) return <Loading />;
  const c = data.config;
  const set = (p) => setF({ ...f, ...p });
  const save = () => run(async () => {
    await api.put('/google', {
      enabled: f.enabled, latitude: f.latitude === '' ? null : Number(f.latitude), longitude: f.longitude === '' ? null : Number(f.longitude),
      postal_code: f.postal_code || null, category: f.category, refundable_days: f.refundable === 'yes' ? Number(f.refundable_days) : null,
      breakfast_included: f.breakfast_included, photo_urls: f.photos.split(/\s+/).map((x) => x.trim()).filter(Boolean),
    });
    reload();
  }, 'Saved');
  const sync = () => run(async () => {
    const r = await api.post('/google/sync', {});
    reload();
    return r;
  }, 'Sent to Google');
  const show = (kind) => run(async () => {
    const res = await request('GET', `/google/preview?kind=${kind}`, null, { raw: true });
    setPreview({ kind, xml: await res.text() });
  });
  const STATUS = { draft: 'Not sent to Google yet', testing: 'Google is checking prices', live: 'Live on Google', paused: 'Paused' };
  return (
    <div className="space-y-5">
      {!data.addon && <div className="card p-4 text-sm text-ink-600">Google Hotels comes with the Rate Guard add-on. Ask Wayne E Solutions to switch it on.</div>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Google status" value={label(c.status)} sub={STATUS[c.status]} tone={c.status === 'live' ? 'good' : 'default'} />
        <Stat label="Sending" value={data.pushing ? 'Yes' : 'No'} sub={data.pushing ? 'Rates go to Google within a minute of a change' : !data.partner_configured ? 'Waiting for Wayne E Solutions partner account' : !c.enabled ? 'Switch on below' : 'After Wayne E Solutions starts testing'} />
        <Stat label="Last sent" value={c.last_sync_at ? ago(c.last_sync_at) : '—'} sub={c.last_error ? `Error: ${c.last_error}` : `${data.sent.nights} room-nights on Google`} tone={c.last_error ? 'bad' : 'default'} />
        <Stat label="Hotel ID on Google" value={c.property_id} sub="Never changes" />
      </div>
      {data.missing.length > 0 && <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-600">Google needs your {data.missing.join(', ')}. Add the address and phone in Setup → Hotel profile, and the map location below.</div>}
      <div className="card space-y-3 p-4">
        <h2>Your listing</h2>
        <p className="text-xs text-ink-500">Guests see your "Official site" price on Google Hotels and book on your Wayinn booking page — no OTA commission. The price on Google is always the one in your rate calendar (including Rate Guard changes).</p>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Latitude" hint="Google Maps → right-click your hotel → copy the numbers"><input className="input" inputMode="decimal" value={f.latitude} onChange={(e) => set({ latitude: e.target.value })} placeholder="30.9010" /></Field>
          <Field label="Longitude"><input className="input" inputMode="decimal" value={f.longitude} onChange={(e) => set({ longitude: e.target.value })} placeholder="75.8573" /></Field>
          <Field label="PIN code"><input className="input" value={f.postal_code} onChange={(e) => set({ postal_code: e.target.value })} /></Field>
          <Field label="Type of property">
            <select className="input" value={f.category} onChange={(e) => set({ category: e.target.value })}>
              {['hotel', 'guest_house', 'homestay', 'resort', 'hostel', 'lodge', 'motel'].map((x) => <option key={x} value={x}>{label(x)}</option>)}
            </select>
          </Field>
          <Field label="Free cancellation">
            <select className="input" value={f.refundable} onChange={(e) => set({ refundable: e.target.value })}><option value="yes">Yes</option><option value="no">No (non-refundable)</option></select>
          </Field>
          {f.refundable === 'yes' && <Field label="Until … days before check-in"><input type="number" min={0} max={30} className="input" value={f.refundable_days} onChange={(e) => set({ refundable_days: e.target.value })} /></Field>}
          <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" checked={f.breakfast_included} onChange={(e) => set({ breakfast_included: e.target.checked })} /> Breakfast included in the rate</label>
          <Field label="Photo links (one per line)" className="sm:col-span-4"><textarea className="input" rows={2} value={f.photos} onChange={(e) => set({ photos: e.target.value })} placeholder="https://…/room.jpg" /></Field>
        </div>
        <div className="flex flex-wrap items-center gap-4 border-t border-ink-100 pt-3">
          <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={f.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Show my hotel on Google</label>
          <button className="btn-primary" disabled={busy} onClick={save}>Save</button>
          <button className="btn-secondary" disabled={busy || !c.enabled} onClick={sync}>Send changes now</button>
        </div>
      </div>
      <div className="card space-y-2 p-4 text-sm">
        <h2>Links</h2>
        <div><span className="text-ink-500">Your booking page:</span> <a className="font-semibold text-night-900 underline" href={data.booking_page} target="_blank" rel="noreferrer">{data.booking_page}</a></div>
        <div className="text-ink-500">Landing page for Hotel Center (set by Wayne E Solutions): <code className="break-all text-xs">{data.landing_template}</code></div>
        <div className="flex flex-wrap gap-2 pt-1">
          <span className="text-ink-500">What Google gets:</span>
          {[['rate', 'Rates'], ['avail', 'Open / closed'], ['inv_count', 'Rooms left'], ['property_data', 'Rooms & package']].map(([k, l]) => (
            <button key={k} className="btn-secondary btn-sm" onClick={() => show(k)}>{l}</button>
          ))}
        </div>
      </div>
      {data.logs.length > 0 && (
        <div className="card">
          <h2 className="border-b border-ink-100 px-4 py-3">Messages to Google</h2>
          <table className="table">
            <thead><tr><th>When</th><th>What</th><th>Items</th><th>Result</th></tr></thead>
            <tbody>{data.logs.map((l) => (
              <tr key={l.id}><td>{fmtDateTime(l.created_at)}</td><td>{{ rate: 'Rates', avail: 'Open / closed, min stay', inv_count: 'Rooms left', property_data: 'Rooms & package' }[l.message] || l.message}</td>
                <td>{l.items}</td><td>{l.status === 'failed' ? <span className="text-red-600">{l.error}</span> : <Badge status={l.status === 'sent' ? 'sent' : 'skipped'}>{label(l.status)}</Badge>}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {preview && (
        <Modal open wide title="What Google gets (next 60 days)" onClose={() => setPreview(null)}>
          <pre className="max-h-[60vh] overflow-auto rounded-lg bg-ink-50 p-3 text-[11px] leading-relaxed">{preview.xml}</pre>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------
// History and monthly report
// ---------------------------------------------------------------
function History() {
  const { data, reload } = useApi('/rates/changes?limit=300');
  const [month, setMonth] = useState(() => new Date().toLocaleDateString('en-CA').slice(0, 7));
  const report = useApi(`/rate-guard/report?month=${month}`);
  const [run, busy] = useAction();
  const undo = (c) => run(async () => { await api.post(`/rates/changes/${c.id}/undo`); reload(); }, 'Change undone');
  const r = report.data;
  return (
    <div className="space-y-5">
      <div className="card p-4">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2>Monthly report</h2>
          <input type="month" className="input w-auto" value={month} onChange={(e) => setMonth(e.target.value)} />
        </div>
        {!r ? <Loading /> : (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Direct bookings" value={r.direct.bookings} sub={`${rupees0(r.direct.room_revenue_paise)} rooms · ${r.direct.from_google} from Google`} />
            <Stat label="OTA bookings" value={r.ota.bookings} sub={`${rupees0(r.ota.room_revenue_paise)} rooms`} />
            <Stat label="OTA commission saved" value={rupees0(r.commission_saved_paise)} sub={`At ${r.commission_pct}% on direct bookings`} tone="good" />
            <Stat label="Rate Guard changes" value={r.rate_changes.approved + r.rate_changes.auto} sub={`${r.rate_changes.approved} approved · ${r.rate_changes.auto} auto`} />
          </div>
        )}
      </div>
      <div className="card">
        <h2 className="border-b border-ink-100 px-4 py-3">Rate changes</h2>
        {!data ? <Loading /> : !data.length ? <Empty>No rate changes yet.</Empty> : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>When</th><th>Room type</th><th>Stay date</th><th>Change</th><th>By</th><th /></tr></thead>
              <tbody>{data.map((c) => {
                const parts = [];
                if (c.old_rate_paise !== c.new_rate_paise) parts.push(`${inr(c.old_rate_paise)} → ${inr(c.new_rate_paise)}`);
                if (c.old_min_stay !== c.new_min_stay) parts.push(`min stay ${c.old_min_stay || 1} → ${c.new_min_stay || 1}`);
                if (c.old_stop_sell !== c.new_stop_sell) parts.push(c.new_stop_sell ? 'closed for sale' : 'opened for sale');
                return (
                  <tr key={c.id} className={c.undone_at ? 'text-ink-400' : ''}>
                    <td className="whitespace-nowrap">{fmtDateTime(c.created_at)}</td>
                    <td>{c.room_type}</td>
                    <td className="whitespace-nowrap">{fmtDate(c.date)} <span className="text-xs text-ink-500">{dayName(c.date)}</span></td>
                    <td className={c.undone_at ? 'line-through' : 'font-semibold tabular-nums'}>{parts.join(', ')}</td>
                    <td className="text-sm">{SOURCE_NAMES[c.source] || c.source}{c.user_name ? ` · ${c.user_name}` : ''}{c.via === 'whatsapp' ? ` · WhatsApp +${c.actor_phone}` : ''}{c.suggestion_code ? ` · ${c.suggestion_code}` : ''}
                      {c.undone_at && <div className="text-xs">Undone {fmtDateTime(c.undone_at)}</div>}</td>
                    <td className="text-right">{c.can_undo && <button className="btn-ghost btn-sm" disabled={busy} onClick={() => undo(c)}>Undo</button>}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

