import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { label } from '../lib/format.js';

// ---------- Toasts ----------
const ToastCtx = createContext(() => {});
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((msg, type = 'success') => {
    const id = Math.random();
    setToasts((t) => [...t, { id, msg, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 no-print">
        {toasts.map((t) => (
          <div key={t.id} className={`max-w-sm rounded-lg px-4 py-3 text-sm font-medium shadow-lg ${t.type === 'error' ? 'bg-red-600 text-white' : 'bg-ink-900 text-white'}`}>
            {t.msg}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/** Wrap an async action: shows errors as toasts, success message optional. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn, success) => {
    setBusy(true);
    try {
      const r = await fn();
      if (success) toast(success);
      return r;
    } catch (e) {
      toast(e.message || 'Something went wrong', 'error');
      throw e;
    } finally {
      setBusy(false);
    }
  }, [toast]);
  return [run, busy];
}

// ---------- Modal ----------
export function Modal({ open, onClose, title, children, wide = false, footer }) {
  useEffect(() => {
    if (!open) return;
    const h = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-ink-900/40 p-0 sm:p-4" onMouseDown={onClose}>
      <div className={`card w-full ${wide ? 'sm:max-w-3xl' : 'sm:max-w-lg'} max-h-[92vh] flex flex-col rounded-b-none sm:rounded-xl`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-ink-100 px-5 py-3">
          <h2>{title}</h2>
          <button className="btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-ink-100 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label: l, children, hint, className = '' }) {
  return (
    <label className={`block ${className}`}>
      {l && <span className="label">{l}</span>}
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-400">{hint}</span>}
    </label>
  );
}

export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-ink-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Stat({ label: l, value, sub, tone = 'default' }) {
  const tones = { default: 'text-ink-900', good: 'text-brand-700', warn: 'text-amber-600', bad: 'text-red-600' };
  return (
    <div className="card px-4 py-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">{l}</div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${tones[tone]}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-ink-500">{sub}</div>}
    </div>
  );
}

const STATUS_COLORS = {
  available: 'bg-brand-50 text-brand-700 ring-1 ring-brand-200', ready: 'bg-brand-50 text-brand-700 ring-1 ring-brand-200',
  inspected: 'bg-sky-50 text-sky-700 ring-1 ring-sky-200', occupied: 'bg-ink-800 text-white', reserved: 'bg-violet-50 text-violet-700 ring-1 ring-violet-200',
  dirty: 'bg-amber-50 text-amber-600 ring-1 ring-amber-100', cleaning: 'bg-yellow-50 text-yellow-700 ring-1 ring-yellow-200',
  out_of_order: 'bg-red-50 text-red-700 ring-1 ring-red-200',
  tentative: 'bg-amber-50 text-amber-600', requested: 'bg-amber-50 text-amber-600', confirmed: 'bg-brand-50 text-brand-700',
  checked_in: 'bg-ink-800 text-white', checked_out: 'bg-ink-100 text-ink-500', cancelled: 'bg-red-50 text-red-600', no_show: 'bg-red-50 text-red-600',
  open: 'bg-amber-50 text-amber-600', closed: 'bg-ink-100 text-ink-600', pending: 'bg-amber-50 text-amber-600', in_progress: 'bg-sky-50 text-sky-700',
  done: 'bg-brand-50 text-brand-700', resolved: 'bg-brand-50 text-brand-700', acknowledged: 'bg-sky-50 text-sky-700',
  received: 'bg-amber-50 text-amber-600', accepted: 'bg-sky-50 text-sky-700', preparing: 'bg-yellow-50 text-yellow-700',
  out_for_delivery: 'bg-violet-50 text-violet-700', delivered: 'bg-brand-50 text-brand-700',
  unsettled: 'bg-amber-50 text-amber-600', room_posted: 'bg-violet-50 text-violet-700', paid: 'bg-brand-50 text-brand-700', complimentary: 'bg-pink-50 text-pink-700',
  urgent: 'bg-red-600 text-white', high: 'bg-red-50 text-red-700', normal: 'bg-ink-100 text-ink-600', low: 'bg-ink-50 text-ink-400',
  trial: 'bg-amber-50 text-amber-600', active: 'bg-brand-50 text-brand-700', past_due: 'bg-red-50 text-red-600', suspended: 'bg-red-600 text-white',
};
export function Badge({ status, children }) {
  return <span className={`badge ${STATUS_COLORS[status] || 'bg-ink-100 text-ink-600'}`}>{children || label(status)}</span>;
}

export function Empty({ children }) {
  return <div className="px-4 py-10 text-center text-sm text-ink-400">{children}</div>;
}

export function Loading() {
  return <div className="px-4 py-10 text-center text-sm text-ink-400">Loading…</div>;
}

export function ErrorBox({ error }) {
  if (!error) return null;
  return <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error.message}</div>;
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="mb-4 flex gap-1 overflow-x-auto border-b border-ink-100">
      {tabs.map(([k, l]) => (
        <button key={k} onClick={() => onChange(k)}
          className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm font-semibold ${value === k ? 'border-brand-600 text-brand-700' : 'border-transparent text-ink-500 hover:text-ink-800'}`}>
          {l}
        </button>
      ))}
    </div>
  );
}

/** Small confirm-with-reason dialog */
export function ReasonDialog({ open, title, onClose, onSubmit, confirmLabel = 'Confirm', danger = true, extra }) {
  const [reason, setReason] = useState('');
  useEffect(() => { if (open) setReason(''); }, [open]);
  return (
    <Modal open={open} onClose={onClose} title={title}
      footer={<>
        <button className="btn-secondary" onClick={onClose}>Back</button>
        <button className={danger ? 'btn-danger' : 'btn-primary'} disabled={reason.trim().length < 3} onClick={() => onSubmit(reason.trim())}>{confirmLabel}</button>
      </>}>
      {extra}
      <Field label="Reason (recorded in audit log)">
        <textarea className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}
