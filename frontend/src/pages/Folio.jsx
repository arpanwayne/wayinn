import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApi } from '../lib/hooks.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { rupees, fmtDate, fmtDateTime, label, toPaise } from '../lib/format.js';
import { PageHeader, Badge, Loading, Modal, Field, ReasonDialog, useAction, ErrorBox } from '../components/ui.jsx';

const METHODS = [['cash', 'Cash'], ['upi', 'UPI'], ['card', 'Card'], ['online', 'Online gateway'], ['bank_transfer', 'Bank transfer'], ['other', 'Other']];

export default function Folio() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data: f, reload, error } = useApi(`/folios/${id}`);
  const [run, busy] = useAction();
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({});
  const [voidLine, setVoidLine] = useState(null);
  const [voidPay, setVoidPay] = useState(null);
  if (error) return <ErrorBox error={error} />;
  if (!f) return <Loading />;
  const t = f.totals;
  const open = f.status === 'open';
  const set = (p) => setForm({ ...form, ...p });
  const openModal = (m, init = {}) => { setForm(init); setModal(m); };
  const done = (msg) => async (fn) => { await run(fn, msg); setModal(null); reload(); };

  return (
    <div className="space-y-5">
      <PageHeader
        title={f.kind === 'restaurant' ? `Restaurant bill #${f.id}` : `Guest bill — ${f.guest_name}`}
        subtitle={f.stay_id ? `Room ${f.room_number || '—'} · ${fmtDate(f.check_in_date)} → ${fmtDate(f.check_out_date)} · ${f.booking_ref}` : f.bill_to_name}
        actions={<>
          <Badge status={f.status} />{f.invoice_no && <span className="badge bg-ink-800 text-white">{f.invoice_no}</span>}
          {f.booking_id && <Link to={`/bookings/${f.booking_id}`} className="btn-secondary">Booking</Link>}
          <Link to={`/print/invoice/${f.id}`} target="_blank" className="btn-secondary">{f.status === 'closed' ? 'Print / download invoice' : 'Print / download bill'}</Link>
          {open && can('invoice.issue') && t.balance_paise <= 0 && t.total_paise > 0 && f.stay_status !== 'checked_in' &&
            <button className="btn-primary" disabled={busy} onClick={() => done('Invoice issued')(() => api.post(`/folios/${id}/invoice`))}>Issue final invoice</button>}
        </>} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="card px-4 py-3"><div className="label">Charges (incl. tax)</div><div className="text-xl font-bold tabular-nums">{rupees(t.total_paise)}</div></div>
        <div className="card px-4 py-3"><div className="label">Paid</div><div className="text-xl font-bold tabular-nums text-brand-700">{rupees(t.paid_paise)}</div></div>
        <div className="card px-4 py-3"><div className="label">Refunded</div><div className="text-xl font-bold tabular-nums">{rupees(t.refunded_paise)}</div></div>
        <div className="card px-4 py-3"><div className="label">{t.balance_paise >= 0 ? 'Balance due' : 'Credit to guest'}</div>
          <div className={`text-xl font-bold tabular-nums ${t.balance_paise > 0 ? 'text-red-600' : ''}`}>{rupees(Math.abs(t.balance_paise))}</div></div>
      </div>

      <div className="flex flex-wrap gap-2">
        {can('payments.record') && (open || t.balance_paise > 0) && t.balance_paise > 0 &&
          <button className="btn-primary" onClick={() => openModal('payment', { method: 'upi', amount: (t.balance_paise / 100).toFixed(2), kind: 'payment' })}>Collect payment</button>}
        {can('payments.record') && open && <button className="btn-secondary" onClick={() => openModal('payment', { method: 'cash', amount: '', kind: 'deposit' })}>Record advance</button>}
        {open && can('folio.charge') && <button className="btn-secondary" onClick={() => openModal('charge', { category: 'extra', quantity: 1 })}>Add charge</button>}
        {open && can('folio.discount') && <button className="btn-secondary" onClick={() => openModal('discount', { apply_to: 'all', mode: 'percent' })}>Discount</button>}
        {can('payments.refund') && t.paid_paise - t.refunded_paise > 0 && <button className="btn-secondary" onClick={() => openModal('payment', { method: 'cash', amount: t.balance_paise < 0 ? (-t.balance_paise / 100).toFixed(2) : '', kind: 'refund' })}>Refund</button>}
      </div>

      <div className="card overflow-x-auto">
        <table className="table">
          <thead><tr><th>Date</th><th>Description</th><th className="text-right">Qty</th><th className="text-right">Amount</th><th className="text-right">GST</th><th className="text-right">Total</th><th /></tr></thead>
          <tbody>
            {f.lines.map((l) => (
              <tr key={l.id} className={l.voided_at ? 'text-ink-300 line-through' : ''}>
                <td className="whitespace-nowrap">{fmtDate(l.business_date)}</td>
                <td>{l.description}<div className="text-xs text-ink-400 no-underline">{label(l.category)}{l.voided_at && ` · voided by ${l.voided_by_name}: ${l.void_reason}`}</div></td>
                <td className="text-right tabular-nums">{Number(l.quantity)}</td>
                <td className="text-right tabular-nums">{rupees(l.amount_paise)}</td>
                <td className="text-right tabular-nums text-ink-500">{rupees(l.tax_paise)} <span className="text-xs">({Number(l.tax_rate)}%)</span></td>
                <td className="text-right tabular-nums font-semibold">{rupees(l.amount_paise + l.tax_paise)}</td>
                <td className="text-right">{open && !l.voided_at && can('folio.void') && <button className="btn-ghost btn-sm" onClick={() => setVoidLine(l)}>Void</button>}</td>
              </tr>
            ))}
            {!f.lines.length && <tr><td colSpan={7} className="py-6 text-center text-ink-400">No charges yet</td></tr>}
          </tbody>
          <tfoot>
            <tr><td colSpan={3} /><td className="text-right font-semibold tabular-nums">{rupees(t.subtotal_paise)}</td><td className="text-right tabular-nums">{rupees(t.tax_paise)}</td><td className="text-right font-bold tabular-nums">{rupees(t.total_paise)}</td><td /></tr>
          </tfoot>
        </table>
      </div>

      <div className="card overflow-x-auto">
        <div className="border-b border-ink-100 px-4 py-3"><h2>Payments</h2></div>
        <table className="table">
          <tbody>
            {f.payments.map((p) => (
              <tr key={p.id} className={p.voided_at ? 'text-ink-300 line-through' : ''}>
                <td className="whitespace-nowrap">{fmtDateTime(p.created_at)}</td>
                <td><Badge status={p.kind === 'refund' ? 'cancelled' : 'paid'}>{label(p.kind)}</Badge> {label(p.method)}</td>
                <td className="text-ink-500">{p.reference}{p.notes && ` · ${p.notes}`}<div className="text-xs">{p.received_by_name}{p.voided_at && ` · voided: ${p.void_reason}`}</div></td>
                <td className="text-right font-semibold tabular-nums">{p.kind === 'refund' ? '−' : ''}{rupees(p.amount_paise)}</td>
                <td className="text-right">{open && !p.voided_at && can('payments.void') && <button className="btn-ghost btn-sm" onClick={() => setVoidPay(p)}>Void</button>}</td>
              </tr>
            ))}
            {!f.payments.length && <tr><td className="py-6 text-center text-ink-400">No payments yet</td></tr>}
          </tbody>
        </table>
      </div>

      <Modal open={modal === 'payment'} onClose={() => setModal(null)} title={form.kind === 'refund' ? 'Issue refund' : form.kind === 'deposit' ? 'Record advance' : 'Collect payment'}
        footer={<><button className="btn-secondary" onClick={() => setModal(null)}>Cancel</button>
          <button className="btn-primary" disabled={busy || !form.amount} onClick={() => done(form.kind === 'refund' ? 'Refund recorded' : 'Payment recorded')(() =>
            api.post(`/folios/${id}/payments`, { kind: form.kind, method: form.method, amount_paise: toPaise(form.amount), reference: form.reference || null, notes: form.notes || null }))}>Save</button></>}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount ₹"><input className="input text-lg font-semibold" inputMode="decimal" autoFocus value={form.amount || ''} onChange={(e) => set({ amount: e.target.value })} /></Field>
          <Field label="Method"><select className="input" value={form.method} onChange={(e) => set({ method: e.target.value })}>{METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
          <Field label="Reference / UTR" className="col-span-2"><input className="input" value={form.reference || ''} onChange={(e) => set({ reference: e.target.value })} /></Field>
          {form.kind === 'refund' && <Field label="Refund reason *" className="col-span-2"><input className="input" value={form.notes || ''} onChange={(e) => set({ notes: e.target.value })} /></Field>}
        </div>
      </Modal>

      <Modal open={modal === 'charge'} onClose={() => setModal(null)} title="Add charge"
        footer={<><button className="btn-secondary" onClick={() => setModal(null)}>Cancel</button>
          <button className="btn-primary" disabled={busy || !form.description || !form.price} onClick={() => done('Charge added')(() =>
            api.post(`/folios/${id}/charges`, { category: form.category, description: form.description, quantity: Number(form.quantity || 1), unit_price_paise: toPaise(form.price),
              ...(form.tax !== undefined && form.tax !== '' ? { tax_rate: Number(form.tax) } : {}) }))}>Add</button></>}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type"><select className="input" value={form.category} onChange={(e) => set({ category: e.target.value })}>
            <option value="extra">Extra (bed, minibar…)</option><option value="service">Service (laundry, transport…)</option><option value="food">Food</option><option value="extra_person">Extra person</option></select></Field>
          <Field label="Description"><input className="input" value={form.description || ''} onChange={(e) => set({ description: e.target.value })} placeholder="Laundry – 3 shirts" /></Field>
          <Field label="Quantity"><input className="input" type="number" min={1} value={form.quantity} onChange={(e) => set({ quantity: e.target.value })} /></Field>
          <Field label="Unit price ₹"><input className="input" inputMode="decimal" value={form.price || ''} onChange={(e) => set({ price: e.target.value })} /></Field>
          <Field label="GST % (blank = default)" className="col-span-2"><input className="input" inputMode="decimal" value={form.tax ?? ''} onChange={(e) => set({ tax: e.target.value })} /></Field>
        </div>
      </Modal>

      <Modal open={modal === 'discount'} onClose={() => setModal(null)} title="Apply discount"
        footer={<><button className="btn-secondary" onClick={() => setModal(null)}>Cancel</button>
          <button className="btn-primary" disabled={busy || !form.value || !form.reason} onClick={() => done('Discount applied')(() =>
            api.post(`/folios/${id}/discount`, { reason: form.reason, apply_to: form.apply_to, ...(form.mode === 'percent' ? { percent: Number(form.value) } : { amount_paise: toPaise(form.value) }) }))}>Apply</button></>}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type"><select className="input" value={form.mode} onChange={(e) => set({ mode: e.target.value })}><option value="percent">Percent %</option><option value="amount">Amount ₹</option></select></Field>
          <Field label="Value"><input className="input" inputMode="decimal" value={form.value || ''} onChange={(e) => set({ value: e.target.value })} /></Field>
          <Field label="Apply on"><select className="input" value={form.apply_to} onChange={(e) => set({ apply_to: e.target.value })}><option value="all">All charges</option><option value="room">Room charges only</option></select></Field>
          <Field label="Reason *"><input className="input" value={form.reason || ''} onChange={(e) => set({ reason: e.target.value })} /></Field>
        </div>
        <p className="mt-3 text-xs text-ink-500">Discounts are added as a separate line and logged. Large discounts are flagged to the owner.</p>
      </Modal>

      <ReasonDialog open={!!voidLine} title={`Void “${voidLine?.description}”`} confirmLabel="Void line" onClose={() => setVoidLine(null)}
        onSubmit={(reason) => done('Line voided')(async () => { await api.post(`/folios/${id}/lines/${voidLine.id}/void`, { reason }); setVoidLine(null); })} />
      <ReasonDialog open={!!voidPay} title={`Void payment ${voidPay ? rupees(voidPay.amount_paise) : ''}`} confirmLabel="Void payment" onClose={() => setVoidPay(null)}
        onSubmit={(reason) => done('Payment voided')(async () => { await api.post(`/folios/${id}/payments/${voidPay.id}/void`, { reason }); setVoidPay(null); })} />
    </div>
  );
}
