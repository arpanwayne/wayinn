import { createPortal } from 'react-dom';
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
          <div key={t.id} className={`max-w-sm rounded-xl px-4 py-3 text-sm font-medium shadow-lift ${t.type === 'error' ? 'bg-red-600 text-white' : 'border-l-4 border-night-900 bg-ink-900 text-white'}`}>
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
  // Rendered into <body> so the page's own layout (e.g. space-y margins on siblings) can never shift the overlay.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-ink-900/40 p-0 sm:p-4" onMouseDown={onClose}>
      <div className={`card w-full ${wide ? 'sm:max-w-3xl' : 'sm:max-w-lg'} max-h-[92vh] flex flex-col rounded-b-none sm:rounded-xl`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-ink-100 px-5 py-3">
          <h2>{title}</h2>
          <button className="btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-ink-100 px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
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
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-ink-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Stat({ label: l, value, sub, tone = 'default' }) {
  const tones = { default: 'text-ink-900', good: 'text-ink-900', warn: 'text-amber-600', bad: 'text-red-600' };
  return (
    <div className="card px-4 py-3.5">
      <div className="text-[13px] font-medium text-ink-500">{l}</div>
      <div className={`num mt-1 text-[1.75rem] leading-none ${tones[tone]}`}>{value}</div>
      {sub && <div className="mt-1.5 text-xs text-ink-400">{sub}</div>}
    </div>
  );
}

// One palette for every status in the product:
// wine = live / in progress, green = good, amber = needs attention, black or grey = stopped / closed.
const WINE = 'bg-night-50 text-night-900 ring-1 ring-inset ring-night-200';
const WINE_SOLID = 'bg-night-900 text-white';
const GOOD = 'bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-200';
const WARN = 'bg-amber-50 text-amber-600 ring-1 ring-inset ring-amber-200';
const MUTED = 'bg-ink-100 text-ink-600';
const OFF = 'bg-white text-ink-500 ring-1 ring-inset ring-ink-300';
const STOP = 'bg-ink-900 text-white';
const STATUS_COLORS = {
  available: GOOD, ready: GOOD, inspected: GOOD, confirmed: GOOD, done: GOOD, resolved: GOOD, delivered: GOOD, paid: GOOD, active: GOOD,
  occupied: WINE_SOLID, checked_in: WINE_SOLID,
  reserved: WINE, in_progress: WINE, acknowledged: WINE, accepted: WINE, preparing: WINE, out_for_delivery: WINE, room_posted: WINE, complimentary: WINE,
  dirty: WARN, cleaning: WARN, tentative: WARN, requested: WARN, open: WARN, pending: WARN, received: WARN, unsettled: WARN, trial: WARN,
  high: 'bg-amber-400 text-ink-900', past_due: 'bg-red-50 text-red-700 ring-1 ring-inset ring-red-200',
  checked_out: MUTED, closed: MUTED, normal: MUTED, low: 'bg-ink-50 text-ink-400',
  cancelled: OFF, no_show: OFF, skipped: OFF,
  sent: GOOD, queued: WARN, failed: 'bg-red-50 text-red-700 ring-1 ring-inset ring-red-200',
  out_of_order: STOP, urgent: STOP, suspended: STOP,
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
          className={`whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-semibold ${value === k ? 'border-night-900 text-night-900' : 'border-transparent text-ink-500 hover:text-ink-800'}`}>
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

/** In-app replacement for window.prompt: one text field, optional or required. Safe on phones and kiosks (never blocks the page). */
export function PromptDialog({ open, title, label: l, placeholder, confirmLabel = 'Save', required = true, minLength = 1, danger = false, extra, onClose, onSubmit }) {
  const [value, setValue] = useState('');
  useEffect(() => { if (open) setValue(''); }, [open]);
  const ok = !required || value.trim().length >= minLength;
  return (
    <Modal open={open} onClose={onClose} title={title}
      footer={<>
        <button className="btn-secondary" onClick={onClose}>Back</button>
        <button className={danger ? 'btn-danger' : 'btn-primary'} disabled={!ok} onClick={() => onSubmit(value.trim())}>{confirmLabel}</button>
      </>}>
      {extra}
      <form onSubmit={(e) => { e.preventDefault(); if (ok) onSubmit(value.trim()); }}>
        <Field label={l}>
          <input className="input" value={value} placeholder={placeholder} onChange={(e) => setValue(e.target.value)} autoFocus />
        </Field>
      </form>
    </Modal>
  );
}

/** In-app replacement for window.confirm with a yes/no choice. */
export function ConfirmDialog({ open, title, message, yesLabel = 'Yes', noLabel = 'No', onYes, onNo, onClose }) {
  return (
    <Modal open={open} onClose={onClose} title={title}
      footer={<>
        <button className="btn-secondary" onClick={onClose}>Back</button>
        <button className="btn-secondary" onClick={onNo}>{noLabel}</button>
        <button className="btn-primary" onClick={onYes}>{yesLabel}</button>
      </>}>
      <p className="text-sm text-ink-600">{message}</p>
    </Modal>
  );
}

/** Confirm a permanent delete. With `typeToConfirm`, the user must type that word first (for big deletes). */
export function DeleteDialog({ open, title, message, typeToConfirm, confirmLabel = 'Delete', onClose, onConfirm }) {
  const [typed, setTyped] = useState('');
  useEffect(() => { if (open) setTyped(''); }, [open]);
  const ok = !typeToConfirm || typed.trim() === typeToConfirm;
  return (
    <Modal open={open} onClose={onClose} title={title}
      footer={<>
        <button className="btn-secondary" onClick={onClose}>Back</button>
        <button className="btn-danger" disabled={!ok} onClick={() => onConfirm(typed.trim())}>{confirmLabel}</button>
      </>}>
      <p className="text-sm text-ink-600">{message}</p>
      {typeToConfirm && (
        <Field label={`Type "${typeToConfirm}" to confirm`} className="mt-3">
          <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
        </Field>
      )}
    </Modal>
  );
}
