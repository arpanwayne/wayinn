// Front desk: ID photos that arrived on WhatsApp from a number we could not match to a guest.
import { useState } from 'react';
import { api } from '../lib/api.js';
import { useApi } from '../lib/hooks.js';
import { ago, label, plural } from '../lib/format.js';
import { Empty, Modal, useAction } from './ui.jsx';
import { DocViewer, DOC_TYPES } from './GuestDocuments.jsx';

export default function DocumentInbox() {
  const { data, reload } = useApi('/guest-documents?status=inbox', { interval: 20000 });
  const [view, setView] = useState(null);
  const [match, setMatch] = useState(null); // { doc, q, results, pick, doc_type }
  const [run, busy] = useAction();
  if (!data?.length) return null;
  const search = (q) => run(async () => {
    const results = await api.get(`/guests?q=${encodeURIComponent(q)}`);
    setMatch((m) => ({ ...m, results }));
  });
  return (
    <div className="card">
      <div className="flex items-center justify-between border-b border-ink-100 px-4 py-3">
        <h2>WhatsApp documents to match</h2>
        <span className="text-xs text-ink-500">{plural(data.length, 'document')}</span>
      </div>
      <ul className="divide-y divide-ink-50">
        {data.map((d) => (
          <li key={d.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
            <button className="text-left" onClick={() => setView(d)}>
              <span className="font-semibold hover:underline">{label(d.doc_type)}</span>
              <span className="block text-xs text-ink-500">{d.from_name ? `${d.from_name} · ` : ''}+{d.from_phone} · {ago(d.received_at)}{d.note ? ` · “${d.note}”` : ''}</span>
            </button>
            <button className="btn-secondary btn-sm" onClick={() => setMatch({ doc: d, q: d.from_name || '', results: null, pick: null, doc_type: d.doc_type })}>Match to guest</button>
          </li>
        ))}
      </ul>
      <DocViewer doc={view} onClose={() => setView(null)} />
      <Modal open={!!match} onClose={() => setMatch(null)} title="Match document to a guest"
        footer={<><button className="btn-secondary" onClick={() => setMatch(null)}>Cancel</button>
          <button className="btn-primary" disabled={busy || !match?.pick} onClick={() => run(async () => {
            await api.patch(`/guest-documents/${match.doc.id}`, { guest_id: match.pick.id, doc_type: match.doc_type }); setMatch(null); reload();
          }, 'Document saved on the guest')}>Save on guest</button></>}>
        {match && <div className="space-y-3 text-sm">
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (match.q.trim()) search(match.q.trim()); }}>
            <input className="input" placeholder="Guest name, phone, booking ref or room" value={match.q} onChange={(e) => setMatch({ ...match, q: e.target.value })} autoFocus />
            <button className="btn-secondary">Search</button>
          </form>
          {match.results && (!match.results.length ? <Empty>No guest found</Empty> : (
            <ul className="divide-y divide-ink-100 rounded-xl border border-ink-200">{match.results.map((x) => (
              <li key={x.id}><label className="flex cursor-pointer items-center gap-3 px-3 py-2">
                <input type="radio" name="doc-guest" checked={match.pick?.id === x.id} onChange={() => setMatch({ ...match, pick: x })} />
                <span><b>{x.full_name}</b><span className="block text-xs text-ink-500">{[x.phone, x.email].filter(Boolean).join(' · ')}</span></span>
              </label></li>
            ))}</ul>
          ))}
          <label className="block"><span className="label">Document type</span>
            <select className="input" value={match.doc_type} onChange={(e) => setMatch({ ...match, doc_type: e.target.value })}>
              {DOC_TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></label>
        </div>}
      </Modal>
    </div>
  );
}
