import { useState } from 'react';
import { useApi } from '../lib/hooks.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { ago, label } from '../lib/format.js';
import { PageHeader, Badge, Loading, Modal, Field, Tabs, Empty, PromptDialog, useAction } from '../components/ui.jsx';

export default function Housekeeping() {
  const { can, user } = useAuth();
  const { data, reload } = useApi('/housekeeping/board', { interval: 20000 });
  const lf = useApi('/lost-found');
  const [tab, setTab] = useState('tasks');
  const [newTask, setNewTask] = useState(null);
  const [lost, setLost] = useState(null);
  const [returning, setReturning] = useState(null);
  const [run, busy] = useAction();
  if (!data) return <Loading />;
  const manager = can('hk.manage');
  const act = (t, action, extra = {}) => run(async () => { await api.patch(`/housekeeping/tasks/${t.id}`, { action, ...extra }); reload(); });
  const open = data.tasks.filter((t) => ['pending', 'in_progress'].includes(t.status));
  const mine = open.filter((t) => t.assigned_to === user.id);
  const done = data.tasks.filter((t) => t.status === 'done');
  return (
    <div>
      <PageHeader title="Housekeeping" subtitle={`${open.length} open task(s)`}
        actions={<>
          {manager && <button className="btn-primary" onClick={() => setNewTask({ room_id: '', task_type: 'cleaning', priority: 'normal', assigned_to: '', notes: '' })}>+ Task</button>}
          <button className="btn-secondary" onClick={() => setLost({ room_id: '', item: '', description: '' })}>Log lost item</button>
        </>} />
      {data.alerts.not_ready_for_arrival.length > 0 && (
        <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          <b>Not ready for today's arrivals:</b> {data.alerts.not_ready_for_arrival.map((a) => `${a.room} (${label(a.hk_status)})`).join(', ')}
        </div>
      )}
      <Tabs tabs={[['tasks', 'Open tasks'], ...(mine.length ? [['mine', `My tasks (${mine.length})`]] : []), ['rooms', 'Rooms'], ['done', 'Completed'], ['lost', 'Lost & found']]} value={tab} onChange={setTab} />
      {(tab === 'tasks' || tab === 'mine' || tab === 'done') && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {(tab === 'tasks' ? open : tab === 'mine' ? mine : done).map((t) => (
            <div key={t.id} className="card p-4">
              <div className="flex items-start justify-between">
                <div><div className="num text-xl">{t.room_number}</div><div className="text-sm">{label(t.task_type)} <span className="text-ink-400">· {label(t.trigger)}</span></div></div>
                <div className="flex flex-col items-end gap-1"><Badge status={t.priority} /><Badge status={t.status} /></div>
              </div>
              {t.notes && <div className="mt-2 rounded bg-ink-50 px-2 py-1 text-sm">{t.notes}</div>}
              <div className="mt-2 text-xs text-ink-500">{t.assigned_name ? `Assigned: ${t.assigned_name}` : 'Unassigned'} · {ago(t.created_at)}</div>
              {t.status !== 'done' && t.status !== 'cancelled' && (
                <div className="mt-3 flex flex-wrap gap-1">
                  {manager && (
                    <select className="input w-auto py-1 text-xs" value={t.assigned_to || ''} onChange={(e) => act(t, 'assign', { assigned_to: e.target.value ? Number(e.target.value) : null })}>
                      <option value="">Assign…</option>{data.staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  )}
                  <div className="flex-1" />
                  {t.status === 'pending' && <button className="btn-secondary btn-sm" disabled={busy} onClick={() => act(t, 'start')}>Start</button>}
                  <button className="btn-primary btn-sm" disabled={busy} onClick={() => act(t, 'complete')}>Done</button>
                  {manager && t.task_type === 'cleaning' && <button className="btn-secondary btn-sm" disabled={busy} onClick={() => act(t, 'complete', { room_status_after: 'inspected' })}>Done + inspected</button>}
                </div>
              )}
            </div>
          ))}
          {!(tab === 'tasks' ? open : tab === 'mine' ? mine : done).length && <div className="card col-span-full"><Empty>Nothing here</Empty></div>}
        </div>
      )}
      {tab === 'rooms' && (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6 lg:grid-cols-8">
          {data.rooms.map((r) => (
            <div key={r.id} className="card p-2 text-center">
              <div className="font-bold">{r.number}</div>
              <Badge status={r.hk_status} />
              {r.stay_id && <div className="mt-1 text-[10px] text-ink-500">Occupied{r.due_out ? ' · due out' : ''}</div>}
              {r.arriving_stay_id && <div className="mt-1 text-[10px] text-night-900">Arrival today</div>}
            </div>
          ))}
        </div>
      )}
      {tab === 'lost' && (
        <div className="card overflow-x-auto">
          {!lf.data?.length ? <Empty>No items logged</Empty> : (
            <table className="table"><tbody>{lf.data.map((l) => (
              <tr key={l.id}><td className="font-semibold">{l.item}<div className="text-xs font-normal text-ink-500">{l.description}</div></td><td>{l.room_number ? `Room ${l.room_number}` : ''}</td>
                <td className="text-xs text-ink-500">{l.found_by_name} · {ago(l.created_at)}</td><td><Badge status={l.status === 'stored' ? 'pending' : 'done'}>{label(l.status)}</Badge></td>
                <td className="text-right">{l.status === 'stored' && <button className="btn-ghost btn-sm" onClick={() => setReturning(l)}>Returned</button>}</td></tr>
            ))}</tbody></table>
          )}
        </div>
      )}
      <Modal open={!!newTask} onClose={() => setNewTask(null)} title="New housekeeping task"
        footer={<><button className="btn-secondary" onClick={() => setNewTask(null)}>Cancel</button><button className="btn-primary" disabled={!newTask?.room_id || busy} onClick={() => run(async () => {
          await api.post('/housekeeping/tasks', { ...newTask, room_id: Number(newTask.room_id), assigned_to: newTask.assigned_to ? Number(newTask.assigned_to) : null }); setNewTask(null); reload();
        }, 'Task created')}>Create</button></>}>
        {newTask && <div className="grid grid-cols-2 gap-3">
          <Field label="Room"><select className="input" value={newTask.room_id} onChange={(e) => setNewTask({ ...newTask, room_id: e.target.value })}><option value="">Select</option>{data.rooms.map((r) => <option key={r.id} value={r.id}>{r.number}</option>)}</select></Field>
          <Field label="Type"><select className="input" value={newTask.task_type} onChange={(e) => setNewTask({ ...newTask, task_type: e.target.value })}>{['cleaning', 'inspection', 'turndown', 'deep_clean'].map((x) => <option key={x} value={x}>{label(x)}</option>)}</select></Field>
          <Field label="Priority"><select className="input" value={newTask.priority} onChange={(e) => setNewTask({ ...newTask, priority: e.target.value })}>{['low', 'normal', 'high', 'urgent'].map((x) => <option key={x}>{x}</option>)}</select></Field>
          <Field label="Assign to"><select className="input" value={newTask.assigned_to} onChange={(e) => setNewTask({ ...newTask, assigned_to: e.target.value })}><option value="">Unassigned</option>{data.staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          <Field label="Notes" className="col-span-2"><input className="input" value={newTask.notes} onChange={(e) => setNewTask({ ...newTask, notes: e.target.value })} /></Field>
        </div>}
      </Modal>
      <PromptDialog open={!!returning} title={`Returned · ${returning?.item || ''}`} label="Returned to (name)" confirmLabel="Mark returned" minLength={2} onClose={() => setReturning(null)}
        onSubmit={(to) => run(async () => { await api.patch(`/lost-found/${returning.id}`, { status: 'returned', returned_to: to }); setReturning(null); lf.reload(); }, 'Marked as returned')} />
      <Modal open={!!lost} onClose={() => setLost(null)} title="Log lost & found item"
        footer={<><button className="btn-secondary" onClick={() => setLost(null)}>Cancel</button><button className="btn-primary" disabled={!lost?.item} onClick={() => run(async () => {
          await api.post('/lost-found', { ...lost, room_id: lost.room_id ? Number(lost.room_id) : null }); setLost(null); lf.reload();
        }, 'Item logged')}>Save</button></>}>
        {lost && <div className="grid grid-cols-2 gap-3">
          <Field label="Item"><input className="input" value={lost.item} onChange={(e) => setLost({ ...lost, item: e.target.value })} /></Field>
          <Field label="Room"><select className="input" value={lost.room_id} onChange={(e) => setLost({ ...lost, room_id: e.target.value })}><option value="">—</option>{data.rooms.map((r) => <option key={r.id} value={r.id}>{r.number}</option>)}</select></Field>
          <Field label="Description" className="col-span-2"><input className="input" value={lost.description} onChange={(e) => setLost({ ...lost, description: e.target.value })} /></Field>
        </div>}
      </Modal>
    </div>
  );
}
