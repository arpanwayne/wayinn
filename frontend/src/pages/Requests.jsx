import { useApi } from '../lib/hooks.js';
import { api } from '../lib/api.js';
import { ago, label } from '../lib/format.js';
import { PageHeader, Badge, Loading, Empty, useAction } from '../components/ui.jsx';

export default function Requests() {
  const { data, reload } = useApi('/requests', { interval: 15000 });
  const [run] = useAction();
  if (!data) return <Loading />;
  const set = (id, status) => run(async () => { await api.patch(`/requests/${id}`, { status }); reload(); });
  return (
    <div>
      <PageHeader title="Guest requests" subtitle="From the in-room QR portal" />
      <div className="card overflow-x-auto">
        {!data.length ? <Empty>No requests in the last 24 hours</Empty> : (
          <table className="table"><tbody>{data.map((r) => (
            <tr key={r.id}>
              <td className="num w-16 text-lg">{r.room_number}</td>
              <td><div className="font-semibold">{label(r.type)}</div>{r.message && <div className="text-sm text-ink-600">{r.message}</div>}<div className="text-xs text-ink-400">{r.guest_name} · {ago(r.created_at)}</div></td>
              <td><Badge status={r.status} /></td>
              <td className="whitespace-nowrap text-right">
                {r.status === 'open' && <button className="btn-secondary btn-sm" onClick={() => set(r.id, 'acknowledged')}>Acknowledge</button>}
                {['open', 'acknowledged'].includes(r.status) && <button className="btn-primary btn-sm ml-1" onClick={() => set(r.id, 'done')}>Done</button>}
              </td>
            </tr>
          ))}</tbody></table>
        )}
      </div>
    </div>
  );
}
