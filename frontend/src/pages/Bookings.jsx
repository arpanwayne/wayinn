import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { fmtDate, label } from '../lib/format.js';
import { PageHeader, Badge, Empty, Loading } from '../components/ui.jsx';

export default function Bookings() {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const { data, loading } = useApi(`/bookings?${new URLSearchParams({ ...(query ? { q: query } : {}), ...(status ? { status } : {}) })}`);
  return (
    <div>
      <PageHeader title="Bookings" actions={can('bookings.create') && <Link to="/bookings/new" className="btn-primary">+ New booking</Link>} />
      <form className="mb-4 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); setQuery(q); }}>
        <input className="input max-w-xs" placeholder="Search name, phone or booking ref" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option><option value="requested">Requested</option><option value="confirmed">Confirmed</option><option value="cancelled">Cancelled</option>
        </select>
        <button className="btn-secondary">Search</button>
      </form>
      <div className="card overflow-x-auto">
        {loading ? <Loading /> : !data?.length ? <Empty>No bookings found</Empty> : (
          <table className="table">
            <thead><tr><th>Ref</th><th>Guest</th><th>Dates</th><th>Rooms</th><th>Source</th><th>Status</th></tr></thead>
            <tbody>
              {data.map((b) => (
                <tr key={b.id} className="hover:bg-ink-50">
                  <td><Link to={`/bookings/${b.id}`} className="link">{b.ref}</Link></td>
                  <td>{b.guest_name}<div className="text-xs text-ink-500">{b.guest_phone}</div></td>
                  <td className="whitespace-nowrap">{fmtDate(b.check_in_date)} → {fmtDate(b.check_out_date)}</td>
                  <td>{b.rooms || <span className="text-ink-400">{b.room_count} unassigned</span>}</td>
                  <td className="text-ink-500">{label(b.source)}</td>
                  <td><Badge status={b.status} /> {b.stay_statuses?.includes('checked_in') && <Badge status="checked_in">In house</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
