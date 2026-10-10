import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../lib/hooks.js';
import { rupees, fmtDate, label } from '../lib/format.js';
import { PageHeader, Badge, Loading, Empty, Tabs } from '../components/ui.jsx';

export default function Billing() {
  const [tab, setTab] = useState('outstanding');
  const path = tab === 'outstanding' ? '/folios?outstanding=1' : tab === 'open' ? '/folios?status=open' : '/folios?status=closed';
  const { data, loading } = useApi(path);
  return (
    <div>
      <PageHeader title="Billing" subtitle="Guest folios, restaurant bills and receivables" />
      <Tabs tabs={[['outstanding', 'Balance pending'], ['open', 'Open bills'], ['closed', 'Invoiced']]} value={tab} onChange={setTab} />
      <div className="card overflow-x-auto">
        {loading ? <Loading /> : !data?.length ? <Empty>Nothing here</Empty> : (
          <table className="table">
            <thead><tr><th>Bill</th><th>Guest / customer</th><th>Room</th><th>Status</th><th className="text-right">Balance</th></tr></thead>
            <tbody>
              {data.map((f) => (
                <tr key={f.id} className="hover:bg-ink-50">
                  <td><Link to={`/folios/${f.id}`} className="font-semibold text-brand-700 hover:underline">{f.invoice_no || `#${f.id}`}</Link><div className="text-xs text-ink-500">{label(f.kind)} · {fmtDate(f.created_at)}</div></td>
                  <td>{f.guest_name || '—'}<div className="text-xs text-ink-500">{f.booking_ref}</div></td>
                  <td>{f.room_number || '—'}</td>
                  <td><Badge status={f.status} /> {f.stay_status && <Badge status={f.stay_status} />}</td>
                  <td className={`text-right font-semibold tabular-nums ${f.balance_paise > 0 ? 'text-red-600' : f.balance_paise < 0 ? 'text-brand-700' : ''}`}>{f.balance_paise < 0 ? `${rupees(-f.balance_paise)} credit` : rupees(f.balance_paise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
