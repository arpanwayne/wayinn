import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useApi } from '../lib/hooks.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { fmtDate } from '../lib/format.js';
import { PageHeader, Loading, Field, Badge, Modal, Empty, DeleteDialog, useAction } from '../components/ui.jsx';

const FIELDS = [['full_name', 'Full name'], ['phone', 'Phone'], ['email', 'Email'], ['address', 'Address'], ['city', 'City'], ['country', 'Country'],
  ['nationality', 'Nationality'], ['id_type', 'ID type'], ['id_number', 'ID number'], ['company_name', 'Company'], ['company_gstin', 'Company GSTIN']];

export default function GuestDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data: g, reload } = useApi(`/guests/${id}`);
  const [form, setForm] = useState(null);
  const [merge, setMerge] = useState(null); // { q, results, pick }
  const [del, setDel] = useState(false);
  const nav = useNavigate();
  const [run, busy] = useAction();
  useEffect(() => { if (g) setForm(g); }, [g]);
  const searchMerge = (q) => run(async () => {
    const rows = await api.get(`/guests?q=${encodeURIComponent(q)}`);
    setMerge((m) => ({ ...m, results: rows.filter((x) => String(x.id) !== String(id)) }));
  });
  if (!g || !form) return <Loading />;
  const editable = can('guests.manage');
  const save = () => run(async () => {
    const body = Object.fromEntries([...FIELDS.map(([k]) => k), 'preferences', 'notes'].map((k) => [k, form[k] || null]));
    body.full_name = form.full_name;
    await api.put(`/guests/${id}`, body); reload();
  }, 'Guest saved');
  return (
    <div className="space-y-5">
      <PageHeader title={g.full_name} subtitle={`${g.stay_count} stay(s)${g.stays.length > g.stay_count ? ` · ${g.stays.length} booking(s) in total` : ''}`} actions={editable && <>
        <button className="btn-ghost" onClick={() => setMerge({ q: '', results: null, pick: null })}>Merge duplicate…</button>
        {g.stays.length === 0 && <button className="btn-ghost text-red-700" onClick={() => setDel(true)}>Delete</button>}
        <button className="btn-primary" disabled={busy} onClick={save}>Save</button>
      </>} />
      <DeleteDialog open={del} title={`Delete ${g.full_name}?`} message="This guest has no bookings, so the profile can be removed for good."
        onClose={() => setDel(false)}
        onConfirm={() => run(async () => { await api.del(`/guests/${id}`); nav('/guests'); }, 'Guest deleted').catch(() => setDel(false))} />
      <Modal open={!!merge} onClose={() => setMerge(null)} title={`Merge ${g.full_name} into…`}
        footer={<><button className="btn-secondary" onClick={() => setMerge(null)}>Cancel</button>
          <button className="btn-danger" disabled={busy || !merge?.pick} onClick={() => run(async () => {
            const target = merge.pick; await api.post(`/guests/${id}/merge`, { into_guest_id: target.id }); setMerge(null); nav(`/guests/${target.id}`);
          }, 'Guests merged')}>Merge</button></>}>
        {merge && <div className="space-y-3">
          <p className="text-sm text-ink-600">Pick the profile to keep. All bookings, stays and bills of <b>{g.full_name}</b> move to it, its empty details are filled in from this one, and this profile is removed.</p>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (merge.q.trim()) searchMerge(merge.q.trim()); }}>
            <input className="input" placeholder="Name, phone or booking ref" value={merge.q} onChange={(e) => setMerge({ ...merge, q: e.target.value })} autoFocus />
            <button className="btn-secondary">Search</button>
          </form>
          {merge.results && (!merge.results.length ? <Empty>No other guest found</Empty> : (
            <ul className="divide-y divide-ink-100 rounded-xl border border-ink-200">{merge.results.map((x) => (
              <li key={x.id}><label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                <input type="radio" name="merge-into" checked={merge.pick?.id === x.id} onChange={() => setMerge({ ...merge, pick: x })} />
                <span><b>{x.full_name}</b><span className="block text-xs text-ink-500">{[x.phone, x.email, x.city].filter(Boolean).join(' · ')} · {x.stay_count} stay(s)</span></span>
              </label></li>
            ))}</ul>
          ))}
        </div>}
      </Modal>
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="card p-4 lg:col-span-2">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {FIELDS.map(([k, l]) => (
              <Field key={k} label={l}><input className="input" disabled={!editable} value={form[k] || ''} onChange={(e) => setForm({ ...form, [k]: e.target.value })} /></Field>
            ))}
            <Field label="Preferences (visible to staff)" className="sm:col-span-2"><textarea className="input" rows={2} disabled={!editable} value={form.preferences || ''} onChange={(e) => setForm({ ...form, preferences: e.target.value })} /></Field>
            {editable && <Field label="Internal notes (managers & front desk only)" className="sm:col-span-2"><textarea className="input" rows={2} value={form.notes || ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>}
          </div>
        </div>
        <div className="card p-4">
          <h2 className="mb-3">Bookings & stays</h2>
          <ul className="space-y-2">
            {g.stays.map((s) => (
              <li key={s.id} className="flex items-center justify-between rounded-lg bg-ink-50 px-3 py-2 text-sm">
                <div><Link to={`/bookings/${s.booking_id}`} className="font-semibold hover:underline">{s.ref}</Link>
                  <div className="text-xs text-ink-500">{fmtDate(s.check_in_date)} → {fmtDate(s.check_out_date)} · {s.room_number || s.room_type}</div></div>
                <Badge status={s.status} />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
