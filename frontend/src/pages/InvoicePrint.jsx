import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useApi } from '../lib/hooks.js';
import { rupees, fmtDate, fmtDateLong } from '../lib/format.js';
import { Loading } from '../components/ui.jsx';

export default function InvoicePrint() {
  const { id } = useParams();
  const { data: inv } = useApi(`/folios/${id}/invoice`);
  useEffect(() => { if (inv) setTimeout(() => window.print(), 400); }, [inv]);
  if (!inv) return <Loading />;
  const h = inv.hotel;
  return (
    <div className="mx-auto max-w-3xl bg-white p-8 text-sm text-ink-900">
      <div className="no-print mb-4 flex justify-end gap-2"><span className="self-center text-xs text-ink-500">To download, choose “Save as PDF” as the printer.</span><button className="btn-primary" onClick={() => window.print()}>Print / Save as PDF</button></div>
      <div className="flex justify-between border-b-2 border-night-900 pb-4">
        <div>
          <div className="font-display text-2xl font-bold">{h.name}</div>
          {h.legal_name && <div>{h.legal_name}</div>}
          <div className="text-ink-600">{[h.address, h.city, h.state].filter(Boolean).join(', ')}</div>
          <div className="text-ink-600">{[h.phone, h.email].filter(Boolean).join(' · ')}</div>
          {h.gstin && <div className="font-semibold">GSTIN: {h.gstin}{h.state_code && ` · State code ${h.state_code}`}</div>}
        </div>
        <div className="text-right">
          <div className="font-display text-lg font-bold text-night-900">{inv.type}</div>
          {inv.invoice_no && <div>No. <b>{inv.invoice_no}</b></div>}
          <div>Date: {fmtDateLong(inv.invoiced_at || new Date().toISOString())}</div>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4">
        <div><div className="text-xs font-semibold uppercase text-ink-500">Bill to</div><div className="font-semibold">{inv.bill_to.name}</div>
          {inv.bill_to.guest_name && <div className="text-ink-600">Guest: {inv.bill_to.guest_name}</div>}
          {inv.bill_to.gstin && <div>GSTIN: {inv.bill_to.gstin}</div>}{inv.bill_to.phone && <div>{inv.bill_to.phone}</div>}</div>
        {inv.stay && <div className="text-right"><div className="text-xs font-semibold uppercase text-ink-500">Stay</div>
          <div>Room {inv.stay.room} · {inv.stay.booking_ref}</div><div>{fmtDate(inv.stay.check_in)} → {fmtDate(inv.stay.check_out)}</div></div>}
      </div>
      <table className="mt-5 w-full">
        <thead><tr className="border-b border-ink-300 text-left text-xs uppercase text-ink-500"><th className="py-1">Date</th><th>Description</th><th>SAC</th><th className="text-right">Qty</th><th className="text-right">Taxable</th><th className="text-right">GST</th><th className="text-right">Total</th></tr></thead>
        <tbody>
          {inv.lines.map((l) => (
            <tr key={l.id} className="border-b border-ink-100">
              <td className="py-1">{fmtDate(l.business_date)}</td><td>{l.description}</td><td>{l.hsn_sac || ''}</td><td className="text-right">{Number(l.quantity)}</td>
              <td className="text-right">{rupees(l.amount_paise)}</td><td className="text-right">{Number(l.tax_rate)}%</td><td className="text-right">{rupees(l.amount_paise + l.tax_paise)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-4 flex justify-between gap-6">
        <table className="text-xs">
          <thead><tr className="text-left text-ink-500"><th className="pr-3">GST rate</th><th className="pr-3 text-right">Taxable</th>{inv.inter_state ? <th className="text-right">IGST</th> : <><th className="pr-3 text-right">CGST</th><th className="text-right">SGST</th></>}</tr></thead>
          <tbody>{inv.tax_breakup.map((t) => (
            <tr key={t.rate}><td className="pr-3">{t.rate}%</td><td className="pr-3 text-right">{rupees(t.taxable_paise)}</td>
              {inv.inter_state ? <td className="text-right">{rupees(t.igst_paise)}</td> : <><td className="pr-3 text-right">{rupees(t.cgst_paise)}</td><td className="text-right">{rupees(t.sgst_paise)}</td></>}</tr>
          ))}</tbody>
        </table>
        <table className="w-64">
          <tbody>
            <tr><td>Taxable value</td><td className="text-right">{rupees(inv.totals.subtotal_paise)}</td></tr>
            <tr><td>GST</td><td className="text-right">{rupees(inv.totals.tax_paise)}</td></tr>
            <tr className="border-t border-ink-900 font-bold"><td>Grand total</td><td className="text-right">{rupees(inv.totals.total_paise)}</td></tr>
            <tr><td>Paid</td><td className="text-right">{rupees(inv.totals.paid_paise - inv.totals.refunded_paise)}</td></tr>
            <tr className="font-semibold"><td>Balance</td><td className="text-right">{rupees(inv.totals.balance_paise)}</td></tr>
          </tbody>
        </table>
      </div>
      {inv.payments.length > 0 && <div className="mt-4 text-xs text-ink-600">Payments: {inv.payments.map((p) => `${p.kind === 'refund' ? 'Refund ' : ''}${p.method.toUpperCase()} ${rupees(p.amount_paise)}`).join(' · ')}</div>}
      {h.footer && <div className="mt-6 text-center text-xs text-ink-500">{h.footer}</div>}
      <div className="mt-8 text-center text-[10px] text-ink-400">Generated by Wayinn · Wayne E Solutions</div>
    </div>
  );
}
