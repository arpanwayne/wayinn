import { useState } from 'react';
import { useApi } from '../lib/hooks.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { ago, label, fmtDateTime } from '../lib/format.js';
import { PageHeader, Badge, Loading, Modal, Field, Empty, useAction } from '../components/ui.jsx';

export default function Maintenance() {
  const { can } = useAuth();
  const [all, setAll] = useState(false);
  const { data, reload } = useApi(`/maintenance${all ? '?all=1' : ''}`, { interval: 30000 });
  const rooms = useApi('/rooms');
  const staff = useApi(can('staff.manage') ? '/staff' : null, { skip: !can('staff.manage') });
  const [form, setForm] = useState(null);
  const [resolve, setResolve] = useState(null);
  const [run, busy] = useAction();
  if (!data) return <Loading />;
  return (
    <div>
      <PageHeader title="Maintenance" actions={<>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show resolved</label>
        {can('maintenance.manage') && <button className="btn-primary" onClick={() => setForm({ room_id: '', title: '', description: '', priority: 'normal', assigned_to: '', mark_out_of_order: false })}>+ Report issue</button>}
      </>} />
      <div className="card overflow-x-auto">
        {!data.length ? <Empty>No open issues</Empty> : (
          <table className="table">
            <thead><tr><th>Issue</th><th>Room</th><th>Priority</th><th>Status</th><th>Assigned</th><th /></tr></thead>
            <tbody>{data.map((m) => (
              <tr key={m.id}>
                <td><div className="font-semibold">{m.title}</div><div className="text-xs text-ink-500">{m.description}</div>
                  <div className="text-xs text-ink-400">{m.created_by_name || 'Guest'} · {ago(m.created_at)}</div>
                  {m.resolution_notes && <div className="mt-1 text-xs text-brand-700">✓ {m.resolution_notes} · {fmtDateTime(m.resolved_at)}</div>}</td>
                <td>{m.room_number || '—'}</td><td><Badge status={m.priority} /></td><td><Badge status={m.status} /></td><td>{m.assigned_name || '—'}</td>
                <td className="whitespace-nowrap text-right">
                  {m.status === 'open' && <button className="btn-secondary btn-sm" onClick={() => run(async () => { await api.patch(`/maintenance/${m.id}`, { status: 'in_progress' }); reload(); })}>Start</button>}
                  {['open', 'in_progress'].includes(m.status) && <button className="btn-primary btn-sm ml-1" onClick={() => setResolve({ id: m.id, notes: '' })}>Resolve</button>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <Modal open={!!form} onClose={() => setForm(null)} title="Report maintenance issue"
        footer={<><button className="btn-secondary" onClick={() => setForm(null)}>Cancel</button><button className="btn-primary" disabled={!form?.title || busy} onClick={() => run(async () => {
          await api.post('/maintenance', { ...form, room_id: form.room_id ? Number(form.room_id) : null, assigned_to: form.assigned_to ? Number(form.assigned_to) : null }); setForm(null); reload();
        }, 'Issue reported')}>Save</button></>}>
        {form && <div className="grid grid-cols-2 gap-3">
          <Field label="Title" className="col-span-2"><input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="AC not cooling" /></Field>
          <Field label="Room"><select className="input" value={form.room_id} onChange={(e) => setForm({ ...form, room_id: e.target.value })}><option value="">Common area</option>{rooms.data?.map((r) => <option key={r.id} value={r.id}>{r.number}</option>)}</select></Field>
          <Field label="Priority"><select className="input" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>{['low', 'normal', 'high', 'urgent'].map((x) => <option key={x}>{x}</option>)}</select></Field>
          {staff.data && <Field label="Assign to"><select className="input" value={form.assigned_to} onChange={(e) => setForm({ ...form, assigned_to: e.target.value })}><option value="">Unassigned</option>{staff.data.filter((s) => s.active && ['maintenance', 'manager', 'housekeeping'].includes(s.role)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>}
          <Field label="Details" className="col-span-2"><textarea className="input" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          {form.room_id && <label className="col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={form.mark_out_of_order} onChange={(e) => setForm({ ...form, mark_out_of_order: e.target.checked })} /> Mark room out of order until fixed</label>}
        </div>}
      </Modal>
      <Modal open={!!resolve} onClose={() => setResolve(null)} title="Resolve issue"
        footer={<><button className="btn-secondary" onClick={() => setResolve(null)}>Cancel</button><button className="btn-primary" disabled={!resolve?.notes} onClick={() => run(async () => {
          await api.patch(`/maintenance/${resolve.id}`, { status: 'resolved', resolution_notes: resolve.notes }); setResolve(null); reload();
        }, 'Resolved')}>Mark resolved</button></>}>
        <Field label="What was done?"><textarea className="input" rows={3} value={resolve?.notes || ''} onChange={(e) => setResolve({ ...resolve, notes: e.target.value })} /></Field>
        <p className="mt-2 text-xs text-ink-500">If the room was out of order, it returns to service as “dirty” for a cleaning check.</p>
      </Modal>
    </div>
  );
}
