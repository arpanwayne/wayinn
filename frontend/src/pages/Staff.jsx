import { useState } from 'react';
import { useApi } from '../lib/hooks.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { fmtDateTime, label } from '../lib/format.js';
import { PageHeader, Badge, Loading, Modal, Field, DeleteDialog, useAction } from '../components/ui.jsx';

const ROLES = ['owner', 'front_desk', 'kitchen'];

export default function Staff() {
  const { user } = useAuth();
  const { data, reload } = useApi('/staff');
  const cat = useApi('/hotel/permissions');
  const [form, setForm] = useState(null);
  const [del, setDel] = useState(null);
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
    if (form.phone && /[@a-z]/i.test(form.phone)) throw new Error('Phone number looks wrong (browser autofill?). Please check it.');
    if (form.id && form.resetPassword && (form.password || '').length < 8) throw new Error('New password must be at least 8 characters');
    const body = { name: form.name, phone: form.phone || null, role: form.role, extra_permissions: form.extra_permissions, revoked_permissions: form.revoked_permissions,
      ...(form.password && (!form.id || form.resetPassword) ? { password: form.password } : {}) };
    if (form.id) await api.patch(`/staff/${form.id}`, { ...body, active: form.active });
    else await api.post('/staff', { ...body, email: form.email, password: form.password });
    setForm(null); reload();
  }, 'Staff saved');
  return (
    <div>
      <PageHeader title="Staff & permissions" actions={<button className="btn-primary" onClick={() => setForm({ name: '', email: '', phone: '', role: 'front_desk', password: '', extra_permissions: [], revoked_permissions: [], active: true })}>+ Add staff</button>} />
      <div className="card overflow-x-auto">
        <table className="table">
          <thead><tr><th>Name</th><th>Role</th><th>Last login</th><th>Status</th><th /></tr></thead>
          <tbody>{data.map((s) => (
            <tr key={s.id} className={s.active ? '' : 'opacity-50'}>
              <td className="font-semibold">{s.name}<div className="text-xs font-normal text-ink-500">{s.email} {s.phone && `· ${s.phone}`}</div></td>
              <td>{label(s.role)}{(s.extra_permissions.length > 0 || s.revoked_permissions.length > 0) && <span className="ml-1 text-xs text-amber-600">custom</span>}</td>
              <td className="text-ink-500">{fmtDateTime(s.last_login_at)}</td>
              <td><Badge status={s.active ? 'active' : 'cancelled'}>{s.active ? 'Active' : 'Inactive'}</Badge></td>
              <td className="text-right"><button className="btn-secondary btn-sm" onClick={() => setForm({ ...s, password: '', resetPassword: false })}>Edit</button></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <Modal open={!!form} onClose={() => setForm(null)} title={form?.id ? `Edit ${form.name}` : 'Add staff'} wide
        footer={<>
          {form?.id && form.id !== user.id && <button className="btn-ghost mr-auto text-red-700" onClick={() => setDel(form)}>Delete</button>}
          <button className="btn-secondary" onClick={() => setForm(null)}>Cancel</button><button className="btn-primary" disabled={busy} onClick={save}>Save</button></>}>
        {form && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Name"><input className="input" name="staff-name" autoComplete="off" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
              <Field label="Email (login)"><input className="input" type="email" name="staff-login-email" autoComplete="off" disabled={!!form.id} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
              <Field label="Phone"><input className="input" type="tel" name="staff-phone" autoComplete="off" inputMode="tel" value={form.phone || ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
              <Field label="Role"><select className="input" value={form.role} disabled={form.id === user.id} onChange={(e) => setForm({ ...form, role: e.target.value, extra_permissions: [], revoked_permissions: [] })}>
                {ROLES.filter((r) => r !== 'owner' || user.role === 'owner').map((r) => <option key={r} value={r}>{label(r)}</option>)}</select></Field>
              {form.id && !form.resetPassword
                ? <Field label="Password"><button type="button" className="btn-secondary w-full" onClick={() => setForm({ ...form, resetPassword: true, password: '' })}>Reset password…</button></Field>
                : <Field label={form.id ? 'New password (min 8)' : 'Password (min 8)'}>
                    <input className="input" type="password" name="staff-new-password" autoComplete="new-password" value={form.password}
                      onChange={(e) => setForm({ ...form, password: e.target.value })} />
                    {form.id && <button type="button" className="mt-1 text-xs text-ink-500 underline" onClick={() => setForm({ ...form, resetPassword: false, password: '' })}>Keep current password</button>}
                  </Field>}
              {form.id && form.id !== user.id && <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Account active</label>}
            </div>
            {!form.id && <div className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Only the people who run the software get a login: <b>owner</b>, <b>front desk</b> and <b>kitchen</b>. Housekeeping, maintenance and
              service staff do not need one; front desk assigns their work. A front desk login can take bookings, cancel and record payments.
            </div>}
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
      <DeleteDialog open={!!del} title={`Delete ${del?.name}?`}
        message="This removes the login for good. It only works for an account that has no work on record; anyone who has made bookings, bills or tasks can only be switched off (untick Account active)."
        onClose={() => setDel(null)}
        onConfirm={() => run(async () => { await api.del(`/staff/${del.id}`); setDel(null); setForm(null); reload(); }, 'Staff deleted').catch(() => setDel(null))} />
    </div>
  );
}
