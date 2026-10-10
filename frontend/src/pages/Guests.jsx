import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../lib/hooks.js';
import { fmtDate } from '../lib/format.js';
import { PageHeader, Loading, Empty } from '../components/ui.jsx';

export default function Guests() {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const { data, loading } = useApi(`/guests${query ? `?q=${encodeURIComponent(query)}` : ''}`);
  return (
    <div>
      <PageHeader title="Guests" subtitle="Search by name, phone, email, booking ref or in-house room number" />
      <form className="mb-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); setQuery(q); }}>
        <input className="input max-w-sm" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn-secondary">Search</button>
      </form>
      <div className="card overflow-x-auto">
        {loading ? <Loading /> : !data?.length ? <Empty>No guests found</Empty> : (
          <table className="table">
            <thead><tr><th>Name</th><th>Phone</th><th>City</th><th>Stays</th><th>Last stay</th></tr></thead>
            <tbody>{data.map((g) => (
              <tr key={g.id} className="hover:bg-ink-50">
                <td><Link to={`/guests/${g.id}`} className="font-semibold text-brand-700 hover:underline">{g.full_name}</Link>{g.company_name && <div className="text-xs text-ink-500">{g.company_name}</div>}</td>
                <td>{g.phone}</td><td>{g.city}</td><td>{g.stay_count}</td><td>{fmtDate(g.last_stay)}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}
