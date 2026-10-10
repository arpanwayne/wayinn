import { useApi } from '../lib/hooks.js';
import { fmtDateTime, label } from '../lib/format.js';
import { PageHeader, Loading } from '../components/ui.jsx';

const summarize = (d) => Object.entries(d || {}).filter(([, v]) => v !== null && typeof v !== 'object').slice(0, 5)
  .map(([k, v]) => `${k.replace(/_paise$/, '')}: ${k.endsWith('_paise') ? '₹' + (Number(v) / 100).toFixed(2) : v}`).join(' · ');

export default function Activity() {
  const { data } = useApi('/hotel/audit?limit=300');
  if (!data) return <Loading />;
  return (
    <div>
      <PageHeader title="Activity log" subtitle="Key booking, billing, order and room actions — cannot be edited" />
      <div className="card overflow-x-auto">
        <table className="table">
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead>
          <tbody>{data.map((a) => (
            <tr key={a.id}>
              <td className="whitespace-nowrap text-ink-500">{fmtDateTime(a.created_at)}</td>
              <td>{a.actor_name || label(a.actor_type)}</td>
              <td className="font-medium">{label(a.action.replace('.', ' · '))}{a.entity_id && <span className="text-ink-400"> #{a.entity_id}</span>}</td>
              <td className="text-xs text-ink-500">{summarize(a.data)}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}
