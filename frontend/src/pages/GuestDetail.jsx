import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApi } from '../lib/hooks.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { fmtDate } from '../lib/format.js';
import { PageHeader, Loading, Field, Badge, useAction } from '../components/ui.jsx';

const FIELDS = [['full_name', 'Full name'], ['phone', 'Phone'], ['email', 'Email'], ['address', 'Address'], ['city', 'City'], ['country', 'Country'],
  ['nationality', 'Nationality'], ['id_type', 'ID type'], ['id_number', 'ID number'], ['company_name', 'Company'], ['company_gstin', 'Company GSTIN']];

export default function GuestDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data: g, reload } = useApi(`/guests/${id}`);
  const [form, setForm] = useState(null);
  const [run, busy] = useAction();
  useEffect(() => { if (g) setForm(g); }, [g]);
  if (!g || !form) return <Loading />;
  const editable = can('guests.manage');
  const save = () => run(async () => {
    const body = Object.fromEntries([...FIELDS.map(([k]) => k), 'preferences', 'notes'].map((k) => [k, form[k] || null]));
    body.full_name = form.full_name;
    await api.put(`/guests/${id}`, body); reload();
  }, 'Guest saved');
  return (
    <div className="space-y-5">
      <PageHeader title={g.full_name} subtitle={`${g.stays.length} stay(s)`} actions={editable && <button className="btn-primary" disabled={busy} onClick={save}>Save</button>} />
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
          <h2 className="mb-3">Stay history</h2>
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
