// ID documents of a guest: what arrived on the hotel's WhatsApp, what the desk uploaded, and a button to ask for them.
import { useEffect, useRef, useState } from 'react';
import { api, blobUrl, uploadFile } from '../lib/api.js';
import { useApi } from '../lib/hooks.js';
import { ago, label } from '../lib/format.js';
import { Empty, Field, Modal, useAction, DeleteDialog } from './ui.jsx';

export const DOC_TYPES = ['id_proof', 'aadhaar', 'passport', 'driving_licence', 'voter_id', 'pan', 'visa', 'other'];

/** Opens one document in a modal (image or PDF). */
export function DocViewer({ doc, onClose }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!doc) return undefined;
    let made;
    blobUrl(`/guest-documents/${doc.id}/file`).then((u) => { made = u; setUrl(u); }).catch(() => setUrl(null));
    return () => { setUrl(null); if (made) URL.revokeObjectURL(made); };
  }, [doc]);
  return (
    <Modal open={!!doc} onClose={onClose} wide title={doc ? `${label(doc.doc_type)} · ${doc.guest_name || doc.from_phone || 'Unmatched'}` : ''}>
      {!url ? <div className="py-10 text-center text-ink-400">Loading…</div>
        : doc.mime_type === 'application/pdf' ? <iframe title={doc.file_name} src={url} className="h-[70vh] w-full rounded-lg" />
          : <img src={url} alt={doc.file_name} className="mx-auto max-h-[70vh] rounded-lg" />}
    </Modal>
  );
}

export default function GuestDocuments({ guestId, bookingId, canRequest = true }) {
  const { data, reload } = useApi(`/guests/${guestId}/documents`, { interval: 20000 });
  const [view, setView] = useState(null);
  const [up, setUp] = useState(null); // { file, doc_type }
  const [del, setDel] = useState(null);
  const [run, busy] = useAction();
  const input = useRef(null);
  const docs = (data || []).filter((d) => !bookingId || !d.booking_id || String(d.booking_id) === String(bookingId));
  return (
    <div className="card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2>ID documents</h2>
        <div className="flex gap-2">
          {canRequest && <button className="btn-secondary btn-sm" disabled={busy}
            onClick={() => run(() => api.post(`/guests/${guestId}/request-documents`), 'Asked the guest to send their ID on WhatsApp')}>Ask on WhatsApp</button>}
          <button className="btn-secondary btn-sm" onClick={() => input.current?.click()}>Upload / scan</button>
          <input ref={input} type="file" hidden accept="image/*,application/pdf" capture="environment"
            onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) setUp({ file, doc_type: 'id_proof' }); }} />
        </div>
      </div>
      {!docs.length ? <Empty>No ID on file yet. Ask the guest to send it on WhatsApp, or scan it here.</Empty> : (
        <ul className="divide-y divide-ink-100">
          {docs.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <button className="text-left" onClick={() => setView(d)}>
                <span className="font-semibold hover:underline">{label(d.doc_type)}</span>
                <span className="block text-xs text-ink-500">{d.source === 'whatsapp' ? 'Received on WhatsApp' : 'Uploaded at desk'} · {ago(d.received_at)}{d.booking_ref ? ` · ${d.booking_ref}` : ''}</span>
              </button>
              <button className="btn-ghost btn-sm text-red-600" onClick={() => setDel(d)}>Delete</button>
            </li>
          ))}
        </ul>
      )}
      <DocViewer doc={view} onClose={() => setView(null)} />
      <DeleteDialog open={!!del} title="Delete this document?" message="The file is removed for good. This is written to the activity log."
        onClose={() => setDel(null)} onConfirm={() => run(async () => { await api.del(`/guest-documents/${del.id}`); setDel(null); reload(); }, 'Document deleted')} />
      <Modal open={!!up} onClose={() => setUp(null)} title="Save document"
        footer={<><button className="btn-secondary" onClick={() => setUp(null)}>Cancel</button>
          <button className="btn-primary" disabled={busy} onClick={() => run(async () => {
            const q = new URLSearchParams({ guest_id: guestId, doc_type: up.doc_type, filename: up.file.name });
            if (bookingId) q.set('booking_id', bookingId);
            await uploadFile(`/guest-documents?${q}`, up.file); setUp(null); reload();
          }, 'Document saved')}>Save</button></>}>
        {up && <div className="space-y-3 text-sm"><p className="text-ink-600">{up.file.name} · {(up.file.size / 1024).toFixed(0)} KB</p>
          <Field label="Document type"><select className="input" value={up.doc_type} onChange={(e) => setUp({ ...up, doc_type: e.target.value })}>
            {DOC_TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></Field></div>}
      </Modal>
    </div>
  );
}
