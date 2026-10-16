// Wayne E Solutions super-admin console
import { useEffect, useState } from 'react';
import { api, request } from '../lib/api.js';
import { store, useAuth } from '../lib/auth.jsx';
import { rupees0, fmtDate, fmtDateTime } from '../lib/format.js';
import { Logo } from '../components/Layout.jsx';
import { Badge, Modal, Field, Stat, Tabs, useAction, Loading } from '../components/ui.jsx';

const P = { scope: 'platform' };

function PlatformLogin({ onDone }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  return (
    <div className="flex min-h-screen items-center justify-center bg-night-900 p-6">
      <form className="card w-full max-w-sm space-y-4 p-6" onSubmit={async (e) => {
        e.preventDefault(); setErr('');
        try { const r = await api.post('/platform/auth/login', { email, password }, { scope: 'none' }); store.set('wayinn.platform', r.token); onDone(); } catch (ex) { setErr(ex.message); }
      }}>
        <Logo /><div><h1>Super admin</h1><p className="text-sm text-ink-500">Wayne E Solutions staff only</p></div>
        <input className="input" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="input" type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {err && <div className="text-sm text-red-600">{err}</div>}
        <button className="btn-primary w-full">Sign in</button>
      </form>
    </div>
  );
}

export default function Platform() {
  const { loginWithToken } = useAuth();
  const [authed, setAuthed] = useState(!!store.get('wayinn.platform'));
  const [tab, setTab] = useState('hotels');
  const [stats, setStats] = useState(null);
  const [hotels, setHotels] = useState(null);
  const [plans, setPlans] = useState([]);
  const [form, setForm] = useState(null);
  const [planForm, setPlanForm] = useState(null);
  const [detail, setDetail] = useState(null);
  const [run, busy] = useAction();

  const load = async () => {
    try {
      const [s, h, p] = await Promise.all([api.get('/platform/stats', P), api.get('/platform/hotels', P), api.get('/platform/plans', P)]);
      setStats(s); setHotels(h); setPlans(p);
    } catch (e) { if (e.status === 401) { store.set('wayinn.platform', null); setAuthed(false); } }
  };
  useEffect(() => { if (authed) load(); }, [authed]); // eslint-disable-line

  if (!authed) return <PlatformLogin onDone={() => setAuthed(true)} />;
  if (!hotels) return <Loading />;
  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between bg-night-900 px-6 py-4 text-white">
        <div className="flex items-center gap-3"><Logo light /><span className="badge bg-white text-night-900">Super admin</span></div>
        <button className="text-sm text-night-100 hover:text-white" onClick={() => { store.set('wayinn.platform', null); setAuthed(false); }}>Sign out</button>
      </header>
      <main className="mx-auto max-w-7xl space-y-5 px-6 py-6">
        {stats && <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
          <Stat label="Hotels" value={stats.hotels} /><Stat label="Active" value={stats.active} tone="good" /><Stat label="Trial" value={stats.trial} />
          <Stat label="At risk" value={stats.at_risk} tone={stats.at_risk ? 'bad' : 'default'} /><Stat label="Rooms" value={stats.rooms} />
          <Stat label="Guests in house" value={stats.guests_in_house} /><Stat label="MRR" value={rupees0(stats.mrr_paise)} tone="good" />
        </div>}
        <Tabs tabs={[['hotels', 'Hotels'], ['plans', 'Plans']]} value={tab} onChange={setTab} />
        {tab === 'hotels' && (
          <div className="card overflow-x-auto">
            <div className="flex justify-end p-3"><button className="btn-primary" onClick={() => setForm({ name: '', slug: '', city: '', phone: '', email: '', gstin: '', plan_id: plans[0]?.id || '', trial_days: 14, owner: { name: '', email: '', phone: '', password: '' } })}>+ Onboard hotel</button></div>
            <table className="table">
              <thead><tr><th>Hotel</th><th>Plan</th><th>Rooms</th><th>Staff</th><th>Status</th><th>Last activity</th><th /></tr></thead>
              <tbody>{hotels.map((h) => (
                <tr key={h.id}>
                  <td><button className="link" onClick={async () => setDetail(await api.get(`/platform/hotels/${h.id}`, P))}>{h.name}</button><div className="text-xs text-ink-500">{h.slug} · {h.city}</div></td>
                  <td>{h.plan || '—'}</td><td>{h.rooms}{h.max_rooms ? ` / ${h.max_rooms}` : ''}</td><td>{h.staff}</td>
                  <td><Badge status={h.subscription_status} />{h.subscription_status === 'trial' && h.trial_ends_at && <div className="text-xs text-ink-500">ends {fmtDate(h.trial_ends_at)}</div>}</td>
                  <td className="text-ink-500">{fmtDateTime(h.last_activity)}</td>
                  <td className="whitespace-nowrap text-right">
                    <select className="input w-auto py-1 text-xs" value={h.subscription_status} onChange={(e) => run(async () => { await api.patch(`/platform/hotels/${h.id}`, { subscription_status: e.target.value }, P); load(); }, 'Updated')}>
                      {['trial', 'active', 'past_due', 'suspended', 'cancelled'].map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {tab === 'plans' && (
          <div className="card overflow-x-auto">
            <div className="flex justify-end p-3"><button className="btn-primary" onClick={() => setPlanForm({ code: '', name: '', max_rooms: 20, max_staff: 10, price: '' })}>+ Plan</button></div>
            <table className="table"><tbody>{plans.map((p) => (
              <tr key={p.id}><td className="font-semibold">{p.name}<div className="text-xs text-ink-500">{p.code}</div></td><td>Up to {p.max_rooms} rooms</td><td>{p.max_staff ? `${p.max_staff} staff` : 'Unlimited staff'}</td>
                <td className="tabular-nums">{rupees0(p.price_monthly_paise)}/month</td>
                <td className="text-right"><button className="btn-secondary btn-sm" onClick={() => setPlanForm({ ...p, price: p.price_monthly_paise / 100 })}>Edit</button></td></tr>
            ))}</tbody></table>
          </div>
        )}
      </main>

      <Modal open={!!form} onClose={() => setForm(null)} title="Onboard a hotel" wide
        footer={<><button className="btn-secondary" onClick={() => setForm(null)}>Cancel</button><button className="btn-primary" disabled={busy} onClick={() => run(async () => {
          await api.post('/platform/hotels', { ...form, plan_id: form.plan_id ? Number(form.plan_id) : undefined, trial_days: Number(form.trial_days),
            ...Object.fromEntries(['city', 'phone', 'email', 'gstin'].map((k) => [k, form[k] || undefined])) }, P);
          setForm(null); load();
        }, 'Hotel onboarded')}>Create hotel</button></>}>
        {form && <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Hotel name"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value, slug: form.slug || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') })} /></Field>
          <Field label="URL slug" hint="Used for the booking page"><input className="input" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} /></Field>
          <Field label="City"><input className="input" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} /></Field>
          <Field label="Phone"><input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <Field label="Email"><input className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="GSTIN"><input className="input" value={form.gstin} onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })} /></Field>
          <Field label="Plan"><select className="input" value={form.plan_id} onChange={(e) => setForm({ ...form, plan_id: e.target.value })}>{plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
          <Field label="Trial days"><input type="number" className="input" value={form.trial_days} onChange={(e) => setForm({ ...form, trial_days: e.target.value })} /></Field>
          <div className="sm:col-span-3"><div className="label mt-2">Owner account</div></div>
          <Field label="Owner name"><input className="input" value={form.owner.name} onChange={(e) => setForm({ ...form, owner: { ...form.owner, name: e.target.value } })} /></Field>
          <Field label="Owner email (login)"><input className="input" value={form.owner.email} onChange={(e) => setForm({ ...form, owner: { ...form.owner, email: e.target.value } })} /></Field>
          <Field label="Temporary password"><input className="input" value={form.owner.password} onChange={(e) => setForm({ ...form, owner: { ...form.owner, password: e.target.value } })} /></Field>
        </div>}
      </Modal>
      <Modal open={!!planForm} onClose={() => setPlanForm(null)} title={planForm?.id ? 'Edit plan' : 'New plan'}
        footer={<><button className="btn-secondary" onClick={() => setPlanForm(null)}>Cancel</button><button className="btn-primary" onClick={() => run(async () => {
          const missing = [];
          if (!planForm.code?.trim() || planForm.code.trim().length < 2) missing.push('Code (at least 2 characters)');
          if (!planForm.name?.trim() || planForm.name.trim().length < 2) missing.push('Name (at least 2 characters)');
          if (!(Number(planForm.max_rooms) > 0)) missing.push('Max rooms (a number above 0)');
          if (planForm.max_staff && !(Number(planForm.max_staff) > 0)) missing.push('Max staff (a number above 0, or leave empty for unlimited)');
          if (planForm.price === '' || planForm.price === null || Number.isNaN(Number(planForm.price)) || Number(planForm.price) < 0) missing.push('Price ₹/month (0 or more)');
          if (missing.length) throw new Error(`Please fill in: ${missing.join(', ')}`);
          const body = { code: planForm.code.trim(), name: planForm.name.trim(), max_rooms: Number(planForm.max_rooms), max_staff: planForm.max_staff ? Number(planForm.max_staff) : null, price_monthly_paise: Math.round(Number(planForm.price) * 100) };
          if (planForm.id) await api.put(`/platform/plans/${planForm.id}`, body, P); else await api.post('/platform/plans', body, P);
          setPlanForm(null); load();
        }, 'Plan saved')}>Save</button></>}>
        {planForm && <div className="grid grid-cols-2 gap-3">
          <Field label="Code"><input className="input" value={planForm.code} onChange={(e) => setPlanForm({ ...planForm, code: e.target.value })} /></Field>
          <Field label="Name"><input className="input" value={planForm.name} onChange={(e) => setPlanForm({ ...planForm, name: e.target.value })} /></Field>
          <Field label="Max rooms"><input type="number" className="input" value={planForm.max_rooms} onChange={(e) => setPlanForm({ ...planForm, max_rooms: e.target.value })} /></Field>
          <Field label="Max staff"><input type="number" className="input" value={planForm.max_staff || ''} onChange={(e) => setPlanForm({ ...planForm, max_staff: e.target.value })} /></Field>
          <Field label="Price ₹/month"><input className="input" value={planForm.price} onChange={(e) => setPlanForm({ ...planForm, price: e.target.value })} /></Field>
        </div>}
      </Modal>
      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail?.name} wide
        footer={detail && <>
          <a className="btn-secondary" href="#" onClick={async (e) => {
            e.preventDefault();
            const res = await request('GET', `/platform/hotels/${detail.id}/export`, null, { scope: 'platform', raw: true });
            const a = document.createElement('a'); a.href = URL.createObjectURL(await res.blob()); a.download = `${detail.slug}-export.json`; a.click();
          }}>Export data</a>
          <button className="btn-primary" onClick={() => run(async () => {
            const r = await api.post(`/platform/hotels/${detail.id}/support-login`, {}, P); await loginWithToken(r.token); window.location.href = '/';
          })}>Support login (1 hour)</button>
        </>}>
        {detail && <div className="space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-2">
            <div><span className="label">GSTIN</span>{detail.gstin || '—'}</div><div><span className="label">Contact</span>{detail.phone} {detail.email}</div>
            <div><span className="label">Created</span>{fmtDate(detail.created_at)}</div><div><span className="label">Status</span><Badge status={detail.subscription_status} /></div>
          </div>
          <table className="table"><tbody>{detail.users.map((u) => <tr key={u.id}><td>{u.name}<div className="text-xs text-ink-500">{u.email}</div></td><td>{u.role}</td><td>{u.active ? 'Active' : 'Inactive'}</td><td className="text-ink-500">{fmtDateTime(u.last_login_at)}</td></tr>)}</tbody></table>
        </div>}
      </Modal>
    </div>
  );
}
