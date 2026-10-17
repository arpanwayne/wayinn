import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../lib/hooks.js';
import { api, downloadCsv } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { rupees0, rupees, fmtDate, fmtDateTime, label, todayStr, addDays } from '../lib/format.js';
import { PageHeader, Stat, Loading, Tabs, Empty, Badge, useAction } from '../components/ui.jsx';

function Ring({ pct, label: l }) {
  const r = 54; const circ = 2 * Math.PI * r;
  return (
    <div className="relative mx-auto h-40 w-40 shrink-0">
      <svg viewBox="0 0 128 128" className="h-full w-full -rotate-90">
        <circle cx="64" cy="64" r={r} fill="none" strokeWidth="11" className="stroke-white/25" />
        <circle cx="64" cy="64" r={r} fill="none" strokeWidth="11" strokeLinecap="round" className="stroke-white"
          strokeDasharray={circ} strokeDashoffset={circ * (1 - Math.min(100, Number(pct) || 0) / 100)} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <div className="num text-4xl leading-none">{Math.round(Number(pct) || 0)}%</div>
        <div className="mt-1 text-xs text-white">occupied</div>
        <div className="text-[11px] text-night-100">{l}</div>
      </div>
    </div>
  );
}

function SplitBar({ parts, discount = 0 }) {
  const total = parts.reduce((a, [, v]) => a + Math.max(0, Number(v) || 0), 0);
  return (
    <div className="mt-4 max-w-xl">
      <div className="flex h-2.5 overflow-hidden rounded-full bg-white/25">
        {total > 0 && parts.map(([l, v, c]) => <div key={l} className={c} style={{ width: `${(Math.max(0, v) / total) * 100}%` }} />)}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-night-100">
        {parts.map(([l, v, c]) => <span key={l} className="flex items-center gap-1.5"><span className={`h-2.5 w-2.5 rounded-full ${c}`} />{l} <span className="num text-white">{rupees0(v)}</span></span>)}
        {Number(discount) !== 0 && <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full border border-white/60" />Discounts <span className="num text-white">−{rupees0(Math.abs(discount))}</span></span>}
      </div>
    </div>
  );
}

function HeroFact({ label: l, value, sub, bad }) {
  return (
    <div>
      <div className="text-sm text-night-100">{l}</div>
      <div className={`num mt-0.5 text-2xl ${bad ? 'text-amber-200' : 'text-white'}`}>{value}</div>
      {sub && <div className="text-xs text-night-100">{sub}</div>}
    </div>
  );
}

function Bars({ rows, value, fmt, color = 'bg-night-900' }) {
  const max = Math.max(1, ...rows.map((r) => Number(r[value]) || 0));
  return (
    <div className="flex h-40 items-end gap-1">
      {rows.map((r) => (
        <div key={r.day} className="group relative flex flex-1 flex-col items-center justify-end">
          <div className={`w-full rounded-t-md ${color}`} style={{ height: `${(Number(r[value]) / max) * 100}%`, minHeight: Number(r[value]) ? 2 : 0 }} />
          <div className="mt-1 text-[10px] text-ink-400">{new Date(r.day).getDate()}</div>
          <div className="pointer-events-none absolute -top-7 z-10 hidden whitespace-nowrap rounded-md bg-ink-900 px-2 py-0.5 text-[11px] text-white group-hover:block">{fmtDate(r.day)}: {fmt(r[value])}</div>
        </div>
      ))}
    </div>
  );
}

export default function Reports() {
  const { can } = useAuth();
  const fin = can('reports.financial');
  const [from, setFrom] = useState(addDays(todayStr(), -13));
  const [to, setTo] = useState(todayStr());
  const [tab, setTab] = useState('overview');
  const q = `from=${from}&to=${to}`;
  const dash = useApi('/reports/dashboard', { interval: 60000 });
  const summary = useApi('/summary/daily');
  const daily = useApi(fin ? `/reports/daily?${q}` : null, { skip: !fin });
  const dept = useApi(fin && tab === 'revenue' ? `/reports/revenue-by-department?${q}` : null, { skip: !fin || tab !== 'revenue' });
  const byRoom = useApi(fin && tab === 'revenue' ? `/reports/revenue-by-room?${q}` : null, { skip: !fin || tab !== 'revenue' });
  const food = useApi(tab === 'food' ? `/reports/food-sales?${q}` : null, { skip: tab !== 'food' });
  const coll = useApi(fin && tab === 'collections' ? `/reports/collections?${q}` : null, { skip: !fin || tab !== 'collections' });
  const outst = useApi(fin && tab === 'outstanding' ? '/reports/outstanding' : null, { skip: !fin || tab !== 'outstanding' });
  const hk = useApi(tab === 'ops' ? `/reports/housekeeping?${q}` : null, { skip: tab !== 'ops' });
  const [run, busy] = useAction();

  const d = dash.data;
  if (!d) return <Loading />;
  const collToday = (d.collections_today || []).reduce((a, x) => a + Number(x.amount_paise), 0);
  const revToday = d.revenue_today ? d.revenue_today.total : 0;
  return (
    <div className="space-y-5">
      <PageHeader title="Owner dashboard" subtitle={`Today · ${fmtDate(d.today)}`}
        actions={can('folio.charge') && <button className="btn-secondary" disabled={busy} onClick={() => run(async () => {
          const r = await api.post('/night-audit'); return r;
        }, 'Night audit complete — room charges posted')}>Run night audit</button>} />
      <div className="hero">
        <div className="relative z-10 grid gap-8 p-6 sm:p-8 lg:grid-cols-[auto_minmax(0,1fr)] lg:items-center">
          <Ring pct={d.rooms.occupancy_pct} label={`${d.rooms.occupied} of ${d.rooms.total - d.rooms.out_of_order} rooms`} />
          {fin ? (
            <div>
              <div className="text-night-100">Revenue today</div>
              <div className="num mt-1 text-5xl leading-none sm:text-6xl">{rupees0(revToday)}</div>
              <SplitBar parts={[['Rooms', d.revenue_today.room, 'bg-white'], ['Food', d.revenue_today.food, 'bg-amber-300'], ['Other', d.revenue_today.other, 'bg-ink-900']]} discount={d.revenue_today.discount} />
              <div className="mt-6 grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-4">
                <HeroFact label="Collected today" value={rupees0(collToday)} sub={(d.collections_today || []).map((c) => `${label(c.method)} ${rupees0(c.amount_paise)}`).join(', ')} />
                <HeroFact label="Month to date" value={rupees0(d.revenue_month.total)}
                  sub={[`Rooms ${rupees0(d.revenue_month.room)}`, `Food ${rupees0(d.revenue_month.food)}`, `Other ${rupees0(d.revenue_month.other)}`,
                    ...(Number(d.revenue_month.discount) ? [`Discounts −${rupees0(Math.abs(d.revenue_month.discount))}`] : [])].join(' · ')} />
                <HeroFact label="Unpaid bills" value={rupees0(d.outstanding.amount_paise)} sub={`${d.outstanding.folios} bill(s) · after checkout, no-show or cancellation`} bad={d.outstanding.amount_paise > 0} />
                <HeroFact label="In-house running bills" value={rupees0(d.in_house_balance.amount_paise)} sub={d.refunds_today.n ? `${d.refunds_today.n} refund(s) today, ${rupees0(d.refunds_today.amount_paise)}` : 'No refunds today'} />
              </div>
            </div>
          ) : <div className="text-night-100">{d.rooms.available} rooms available, {d.rooms.out_of_order} out of order</div>}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Available rooms" value={d.rooms.available} sub={`${d.rooms.out_of_order} out of order`} tone="good" />
        <Stat label="Arrivals" value={`${d.arrivals.done}/${d.arrivals.done + d.arrivals.pending}`} sub="checked in of expected" />
        <Stat label="Departures" value={`${d.departures.done}/${d.departures.done + d.departures.pending}`} sub="checked out of due" />
        <Stat label="Food orders" value={d.restaurant_today.orders} sub={`${d.restaurant_today.active} in progress, ${d.restaurant_today.cancelled} cancelled`} />
        <Stat label="Housekeeping pending" value={d.housekeeping.pending} sub={`${d.housekeeping.done_24h} done in 24h`} tone={d.housekeeping.pending > 5 ? 'warn' : 'default'} />
        <Stat label="Maintenance open" value={d.maintenance.open} sub={`${d.maintenance.urgent} urgent`} tone={d.maintenance.urgent ? 'bad' : 'default'} />
      </div>

      {summary.data && (
        <div className="card p-4">
          <div className="mb-2 flex items-center justify-between"><h2>Daily summary</h2>
            <button className="btn-ghost btn-sm" onClick={() => navigator.clipboard?.writeText(summary.data.text)}>Copy for WhatsApp</button></div>
          <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-ink-700">{summary.data.text}</pre>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <label><span className="label">From</span><input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label><span className="label">To</span><input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button className="btn-ghost btn-sm" onClick={() => { setFrom(todayStr()); setTo(todayStr()); }}>Today</button>
        <button className="btn-ghost btn-sm" onClick={() => { setFrom(addDays(todayStr(), -6)); setTo(todayStr()); }}>7 days</button>
        <button className="btn-ghost btn-sm" onClick={() => { setFrom(todayStr().slice(0, 8) + '01'); setTo(todayStr()); }}>This month</button>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[['overview', 'Performance'], ...(fin ? [['revenue', 'Revenue split'], ['collections', 'Collections'], ['outstanding', 'Outstanding']] : []), ['food', 'Food sales'], ['ops', 'Housekeeping & maintenance']]} />

      {tab === 'overview' && fin && daily.data && (
        <div className="space-y-5">
          <div className="grid gap-5 lg:grid-cols-2">
            <div className="card p-4"><h2 className="mb-3">Occupancy %</h2><Bars rows={daily.data} value="occupancy_pct" fmt={(v) => `${v}%`} /></div>
            <div className="card p-4"><h2 className="mb-3">Room revenue</h2><Bars rows={daily.data} value="room_revenue_paise" fmt={rupees0} color="bg-ink-800" /></div>
          </div>
          <div className="card overflow-x-auto">
            <div className="flex justify-end p-2"><button className="btn-ghost btn-sm" onClick={() => downloadCsv(`/reports/daily?${q}&format=csv`, `daily-${from}-${to}.csv`)}>Export CSV</button></div>
            <table className="table">
              <thead><tr><th>Date</th><th className="text-right">Occ.</th><th className="text-right">Rooms</th><th className="text-right">Food</th><th className="text-right">Other</th><th className="text-right">Disc.</th><th className="text-right">ADR</th><th className="text-right">RevPAR</th><th className="text-right">Collected</th></tr></thead>
              <tbody>{daily.data.map((r) => (
                <tr key={r.day}><td>{fmtDate(r.day)}</td><td className="text-right">{r.occupancy_pct ?? 0}%</td><td className="text-right tabular-nums">{rupees0(r.room_revenue_paise)}</td>
                  <td className="text-right tabular-nums">{rupees0(r.food_revenue_paise)}</td><td className="text-right tabular-nums">{rupees0(r.other_revenue_paise)}</td>
                  <td className="text-right tabular-nums">{rupees0(r.discount_paise)}</td><td className="text-right tabular-nums">{rupees0(r.adr_paise)}</td>
                  <td className="text-right tabular-nums">{rupees0(r.revpar_paise)}</td><td className="text-right tabular-nums font-semibold">{rupees0(r.collected_paise)}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}
      {tab === 'revenue' && (
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="card overflow-x-auto"><div className="flex items-center justify-between p-3"><h2>By department</h2><button className="btn-ghost btn-sm" onClick={() => downloadCsv(`/reports/revenue-by-department?${q}&format=csv`, 'departments.csv')}>CSV</button></div>
            <table className="table"><tbody>{dept.data?.map((r) => <tr key={r.category}><td>{label(r.category)}</td><td className="text-right tabular-nums">{rupees(r.amount_paise)}</td><td className="text-right text-ink-500 tabular-nums">GST {rupees(r.tax_paise)}</td></tr>)}</tbody></table></div>
          <div className="card overflow-x-auto"><div className="flex items-center justify-between p-3"><h2>By room</h2><button className="btn-ghost btn-sm" onClick={() => downloadCsv(`/reports/revenue-by-room?${q}&format=csv`, 'rooms.csv')}>CSV</button></div>
            <table className="table"><tbody>{byRoom.data?.map((r) => <tr key={r.room}><td className="font-semibold">{r.room}</td><td className="text-ink-500">{r.room_type}</td><td className="text-right">{r.nights_sold} nights</td><td className="text-right tabular-nums">{rupees0(r.room_revenue_paise)}</td></tr>)}</tbody></table></div>
        </div>
      )}
      {tab === 'collections' && (
        <div className="card overflow-x-auto">
          <div className="flex justify-end p-2"><button className="btn-ghost btn-sm" onClick={() => downloadCsv(`/reports/collections?${q}&format=csv`, 'collections.csv')}>Export CSV</button></div>
          {!coll.data?.length ? <Empty>No payments in range</Empty> : <table className="table"><tbody>{coll.data.map((p) => (
            <tr key={p.id} className={p.voided_at ? 'text-ink-400' : ''}><td className="whitespace-nowrap">{fmtDateTime(p.received_at)}</td>
              <td>{label(p.kind)} · {label(p.method)}{p.voided_at && <span className="badge ml-2 bg-ink-900 text-white" title={p.void_reason || ''}>Voided</span>}</td>
              <td>{p.guest || 'Walk-in'}<div className="text-xs text-ink-500">{p.booking_ref || p.invoice_no}{p.voided_at && p.void_reason ? ` · ${p.void_reason}` : ''}</div></td>
              <td className="text-ink-500">{p.received_by}</td>
              <td className={`text-right font-semibold tabular-nums ${p.voided_at ? 'line-through' : ''}`}>{p.kind === 'refund' ? '−' : ''}{rupees(p.amount_paise)}</td></tr>
          ))}</tbody></table>}
        </div>
      )}
      {tab === 'outstanding' && (
        <div className="card overflow-x-auto">
          {!outst.data?.length ? <Empty>No outstanding balances</Empty> : <table className="table"><tbody>{outst.data.map((o) => (
            <tr key={o.folio_id}><td><Link to={`/folios/${o.folio_id}`} className="link">{o.guest || `Bill #${o.folio_id}`}</Link><div className="text-xs text-ink-500">{o.phone} {o.booking_ref}</div></td>
              <td>{o.room ? `Room ${o.room}` : label(o.kind)}</td><td>{o.stay_status && <Badge status={o.stay_status} />}</td>
              <td className={`text-right font-semibold tabular-nums ${o.balance_paise > 0 ? 'text-red-600' : 'text-brand-700'}`}>{o.balance_paise > 0 ? rupees(o.balance_paise) : `${rupees(-o.balance_paise)} credit`}</td></tr>
          ))}</tbody></table>}
        </div>
      )}
      {tab === 'food' && food.data && (
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="card overflow-x-auto"><div className="flex items-center justify-between p-3"><h2>Popular items</h2><button className="btn-ghost btn-sm" onClick={() => downloadCsv(`/reports/food-sales?${q}&format=csv`, 'food-items.csv')}>CSV</button></div>
            <table className="table"><tbody>{food.data.popular_items.map((i) => <tr key={i.name}><td>{i.name}</td><td className="text-right">{i.qty}</td><td className="text-right tabular-nums">{rupees0(i.amount_paise)}</td></tr>)}</tbody></table></div>
          <div className="space-y-5">
            <div className="card overflow-x-auto"><h2 className="p-3">Orders by type</h2><table className="table"><tbody>{food.data.by_type.map((t, k) => <tr key={k}><td>{label(t.order_type)}</td><td><Badge status={t.settlement} /></td><td className="text-right">{t.orders}</td><td className="text-right tabular-nums">{rupees0(t.total_paise)}</td></tr>)}</tbody></table></div>
            <div className="card overflow-x-auto"><h2 className="p-3">Cancelled orders ({food.data.cancelled.length})</h2><table className="table"><tbody>{food.data.cancelled.map((c) => <tr key={c.order_no}><td>{c.order_no}</td><td className="text-ink-500">{c.cancel_reason}</td><td className="text-right tabular-nums">{rupees0(c.total_paise)}</td></tr>)}</tbody></table></div>
          </div>
        </div>
      )}
      {tab === 'ops' && hk.data && (
        <div className="grid gap-5 lg:grid-cols-3">
          <div className="card overflow-x-auto"><h2 className="p-3">Tasks completed by staff</h2><table className="table"><tbody>{hk.data.by_staff.map((s, k) => <tr key={k}><td>{s.name || 'System'}</td><td className="text-right">{s.completed}</td><td className="text-right text-ink-500">{s.avg_minutes ?? '—'} min avg</td></tr>)}</tbody></table></div>
          <div className="card overflow-x-auto"><h2 className="p-3">Pending tasks ({hk.data.pending.length})</h2><table className="table"><tbody>{hk.data.pending.map((t) => <tr key={t.id}><td>{t.room}</td><td>{label(t.task_type)}</td><td><Badge status={t.priority} /></td><td className="text-ink-500">{t.assigned || '—'}</td></tr>)}</tbody></table></div>
          <div className="card overflow-x-auto"><h2 className="p-3">Maintenance backlog ({hk.data.maintenance_backlog.length})</h2><table className="table"><tbody>{hk.data.maintenance_backlog.map((m) => <tr key={m.id}><td>{m.room || '—'}</td><td>{m.title}</td><td><Badge status={m.priority} /></td></tr>)}</tbody></table></div>
        </div>
      )}
    </div>
  );
}
