import { useState } from 'react';
import { useApi } from '../lib/hooks.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { fmtDateTime, label } from '../lib/format.js';
import { PageHeader, Badge, Loading, Modal, Field, useAction } from '../components/ui.jsx';

const ROLES = ['owner', 'manager', 'receptionist', 'cashier', 'restaurant', 'kitchen', 'housekeeping', 'maintenance'];

export default function Staff() {
  const { user } = useAuth();
  const { data, reload } = useApi('/staff');
  const cat = useApi('/hotel/permissions');
  const [form, setForm] = useState(null);
  const [run, busy] = useAction();
  if (!data || !cat.data) return <Loading />;
  const roleDefaults = (role) => cat.data.roles[role] || [];
  const effective = form ? new Set([...roleDefaults(form.role), ...form.extra_permissions].filter((p) => !form.revoked_permissions.includes(p))) : new Set();
  const toggle = (p) => {
    const def = roleDefaults(form.role).includes(p);
    const on = effective.has(p);
    if (def) setForm({ ...form, revoked_permissions: on ? [...form.revoked_permissions, p] : form.revoked_permissions.filter((x) => x !== p) });
    else setForm({ ...form, extra_permissions: on ? form.extra_permissions.filter((x) => x !== p) : [...form.extra_permissions, p] });
  };
  const save = () => run(async () => {
    const body = { name: form.name, phone: form.phone || null, role: form.role, extra_permissions: form.extra_permissions, revoked_permissions: form.revoked_permissions,
      ...(form.password ? { password: form.password } : {}) };
    if (form.id) await api.patch(`/staff/${form.id}`, { ...body, active: form.active });
    else await api.post('/staff', { ...body, email: form.email, password: form.password });
    setForm(null); reload();
  }, 'Staff saved');
  return (
    <div>
      <PageHeader title="Staff & permissions" actions={<button className="btn-primary" onClick={() => setForm({ name: '', email: '', phone: '', role: 'receptionist', password: '', extra_permissions: [], revoked_permissions: [], active: true })}>+ Add staff</button>} />
      <div className="card overflow-x-auto">
        <table className="table">
          <thead><tr><th>Name</th><th>Role</th><th>Last login</th><th>Status</th><th /></tr></thead>
          <tbody>{data.map((s) => (
            <tr key={s.id} className={s.active ? '' : 'opacity-50'}>
              <td className="font-semibold">{s.name}<div className="text-xs font-normal text-ink-500">{s.email} {s.phone && `· ${s.phone}`}</div></td>
              <td>{label(s.role)}{(s.extra_permissions.length > 0 || s.revoked_permissions.length > 0) && <span className="ml-1 text-xs text-amber-600">custom</span>}</td>
              <td className="text-ink-500">{fmtDateTime(s.last_login_at)}</td>
              <td><Badge status={s.active ? 'active' : 'cancelled'}>{s.active ? 'Active' : 'Inactive'}</Badge></td>
              <td className="text-right"><button className="btn-secondary btn-sm" onClick={() => setForm({ ...s, password: '' })}>Edit</button></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <Modal open={!!form} onClose={() => setForm(null)} title={form?.id ? `Edit ${form.name}` : 'Add staff'} wide
        footer={<><button className="btn-secondary" onClick={() => setForm(null)}>Cancel</button><button className="btn-primary" disabled={busy} onClick={save}>Save</button></>}>
        {form && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Name"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
              <Field label="Email (login)"><input className="input" type="email" disabled={!!form.id} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
              <Field label="Phone"><input className="input" value={form.phone || ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
              <Field label="Role"><select className="input" value={form.role} disabled={form.id === user.id} onChange={(e) => setForm({ ...form, role: e.target.value, extra_permissions: [], revoked_permissions: [] })}>
                {ROLES.filter((r) => r !== 'owner' || user.role === 'owner').map((r) => <option key={r} value={r}>{label(r)}</option>)}</select></Field>
              <Field label={form.id ? 'New password (leave blank to keep)' : 'Password (min 8)'}><input className="input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
              {form.id && form.id !== user.id && <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Account active</label>}
            </div>
            <div>
              <div className="label">Permissions (role defaults pre-selected; changes are per person)</div>
              <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                {Object.entries(cat.data.permissions).map(([p, desc]) => {
                  const def = roleDefaults(form.role).includes(p);
                  const on = effective.has(p);
                  return (
                    <label key={p} className={`flex items-start gap-2 rounded px-2 py-1 text-sm ${on !== def ? 'bg-amber-50' : ''}`}>
                      <input type="checkbox" className="mt-1" checked={on} disabled={form.role === 'owner'} onChange={() => toggle(p)} />
                      <span>{desc}<span className="block text-[10px] text-ink-400">{p}</span></span>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
