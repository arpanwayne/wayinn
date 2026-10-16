import { useMemo, useState } from 'react';
import { useApi } from '../lib/hooks.js';
import { api, request } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { rupees, rupees0, label, ago, toPaise } from '../lib/format.js';
import { PageHeader, Badge, Loading, Modal, Field, ReasonDialog, Tabs, Empty, useAction } from '../components/ui.jsx';

const NEXT = { received: 'accepted', accepted: 'preparing', preparing: 'ready', ready: 'delivered', out_for_delivery: 'delivered' };

function ItemPicker({ item, onAdd, onClose }) {
  const [variant, setVariant] = useState(item?.variants?.[0]?.name || '');
  const [addons, setAddons] = useState([]);
  const [qty, setQty] = useState(1);
  const [notes, setNotes] = useState('');
  if (!item) return null;
  const base = item.variants.length ? item.variants.find((v) => v.name === variant)?.price_paise || 0 : item.price_paise;
  const unit = base + item.addons.filter((a) => addons.includes(a.name)).reduce((s, a) => s + a.price_paise, 0);
  return (
    <Modal open onClose={onClose} title={item.name}
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={() => onAdd({ menu_item_id: item.id, name: item.name, variant: variant || null, addons, quantity: qty, notes: notes || null, unit })}>Add · {rupees0(unit * qty)}</button></>}>
      <div className="space-y-4">
        {item.variants.length > 0 && <Field label="Option"><div className="flex flex-wrap gap-2">{item.variants.map((v) => (
          <button key={v.name} type="button" onClick={() => setVariant(v.name)} className={`rounded-lg border px-3 py-2 text-sm ${variant === v.name ? 'border-night-900 bg-night-50 text-night-900 font-semibold' : 'border-ink-200'}`}>{v.name} · {rupees0(v.price_paise)}</button>
        ))}</div></Field>}
        {item.addons.length > 0 && <Field label="Add-ons"><div className="flex flex-wrap gap-2">{item.addons.map((a) => (
          <button key={a.name} type="button" onClick={() => setAddons(addons.includes(a.name) ? addons.filter((x) => x !== a.name) : [...addons, a.name])}
            className={`rounded-lg border px-3 py-2 text-sm ${addons.includes(a.name) ? 'border-night-900 bg-night-50 text-night-900 font-semibold' : 'border-ink-200'}`}>+ {a.name} · {rupees0(a.price_paise)}</button>
        ))}</div></Field>}
        <div className="flex items-end gap-3">
          <Field label="Quantity"><div className="flex items-center gap-2">
            <button type="button" className="btn-secondary" onClick={() => setQty(Math.max(1, qty - 1))}>−</button><span className="w-8 text-center font-bold">{qty}</span>
            <button type="button" className="btn-secondary" onClick={() => setQty(qty + 1)}>+</button></div></Field>
          <Field label="Kitchen note" className="flex-1"><input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Less spicy…" /></Field>
        </div>
      </div>
    </Modal>
  );
}

function SettleDialog({ order, rooms, onClose, onDone }) {
  const { can } = useAuth();
  const [run, busy] = useAction();
  const [mode, setMode] = useState(order.room_id ? 'room' : 'pay');
  const [roomId, setRoomId] = useState(order.room_id || '');
  const [pays, setPays] = useState([{ method: 'cash', amount: (order.total_paise / 100).toFixed(2) }]);
  const [reason, setReason] = useState('');
  const [gstin, setGstin] = useState('');
  const paid = pays.reduce((a, p) => a + toPaise(p.amount), 0);
  const submit = () => run(async () => {
    const body = mode === 'room' ? { mode, room_id: Number(roomId) } : mode === 'pay'
      ? { mode, payments: pays.filter((p) => toPaise(p.amount) > 0).map((p) => ({ method: p.method, amount_paise: toPaise(p.amount) })), bill_to_gstin: gstin || null }
      : { mode, reason };
    const r = await api.post(`/orders/${order.id}/settle`, body);
    onDone(r);
  }, 'Order settled');
  return (
    <Modal open onClose={onClose} title={`Settle ${order.order_no} · ${rupees(order.total_paise)}`}
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={busy || (mode === 'pay' && paid !== order.total_paise) || (mode === 'room' && !roomId) || (mode === 'complimentary' && reason.length < 3)} onClick={submit}>Settle</button></>}>
      <Tabs tabs={[['pay', 'Pay now'], ['room', 'Charge to room'], ...(can('pos.complimentary') ? [['complimentary', 'Complimentary']] : [])]} value={mode} onChange={setMode} />
      {mode === 'room' && (
        <Field label="In-house room">
          <select className="input" value={roomId} onChange={(e) => setRoomId(e.target.value)}>
            <option value="">Select room</option>
            {rooms.map((r) => <option key={r.id} value={r.id}>{r.number} · {r.guest_name}</option>)}
          </select>
        </Field>
      )}
      {mode === 'pay' && (
        <div className="space-y-2">
          {pays.map((p, i) => (
            <div key={i} className="flex gap-2">
              <select className="input w-36" value={p.method} onChange={(e) => setPays(pays.map((x, j) => (j === i ? { ...x, method: e.target.value } : x)))}>
                {['cash', 'upi', 'card', 'online'].map((m) => <option key={m} value={m}>{m.toUpperCase()}</option>)}
              </select>
              <input className="input" inputMode="decimal" value={p.amount} onChange={(e) => setPays(pays.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
              {pays.length > 1 && <button className="btn-ghost" onClick={() => setPays(pays.filter((_, j) => j !== i))}>✕</button>}
            </div>
          ))}
          <button className="btn-ghost btn-sm" onClick={() => setPays([...pays, { method: 'upi', amount: ((order.total_paise - paid) / 100).toFixed(2) }])}>+ Split payment</button>
          <div className={`text-sm ${paid === order.total_paise ? 'text-brand-700' : 'text-red-600'}`}>Entered {rupees(paid)} of {rupees(order.total_paise)}</div>
          <Field label="Customer GSTIN (optional)"><input className="input uppercase" maxLength={15} value={gstin} onChange={(e) => setGstin(e.target.value.toUpperCase())} /></Field>
        </div>
      )}
      {mode === 'complimentary' && <Field label="Reason (logged and flagged to owner)"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
    </Modal>
  );
}

export default function Pos() {
  const { can } = useAuth();
  const menu = useApi('/menu');
  const board = useApi('/rooms/board', { interval: 60000 });
  const orders = useApi('/orders?active=1', { interval: 15000 });
  const [tab, setTab] = useState('new');
  const [cat, setCat] = useState('all');
  const [search, setSearch] = useState('');
  const [picking, setPicking] = useState(null);
  const [cart, setCart] = useState([]);
  const [type, setType] = useState('dine_in');
  const [table, setTable] = useState('');
  const [roomId, setRoomId] = useState('');
  const [customer, setCustomer] = useState('');
  const [notes, setNotes] = useState('');
  const [addTo, setAddTo] = useState(null);
  const [detail, setDetail] = useState(null);
  const [settle, setSettle] = useState(null);
  const [cancel, setCancel] = useState(null);
  const [discount, setDiscount] = useState(null);
  const [itemAction, setItemAction] = useState(null); // { kind: 'comp' | 'remove', item }
  const [run, busy] = useAction();

  const inHouse = useMemo(() => (board.data || []).filter((r) => r.stay_id), [board.data]);
  if (!menu.data) return <Loading />;
  const items = menu.data.items.filter((i) => (cat === 'all' || i.category_id === Number(cat)) && i.name.toLowerCase().includes(search.toLowerCase()));
  const subtotal = cart.reduce((a, c) => a + c.unit * c.quantity, 0);

  const openDetail = async (id) => setDetail(await api.get(`/orders/${id}`));
  const refreshDetail = async () => { if (detail) setDetail(await api.get(`/orders/${detail.id}`)); orders.reload(); };

  const place = () => run(async () => {
    const payload = cart.map(({ menu_item_id, variant, addons, quantity, notes: n }) => ({ menu_item_id, variant, addons, quantity, notes: n }));
    if (addTo) {
      await api.post(`/orders/${addTo.id}/items`, { items: payload });
    } else {
      await api.post('/orders', { order_type: type, table_label: type === 'dine_in' ? table : null, room_id: type === 'room_service' ? Number(roomId) : null,
        customer_name: customer || null, notes: notes || null, items: payload });
    }
    setCart([]); setNotes(''); setTable(''); setCustomer(''); setAddTo(null); orders.reload(); setTab('active');
  }, addTo ? 'Items added — KOT sent' : 'Order placed — KOT sent');

  return (
    <div>
      <PageHeader title="Restaurant POS" />
      <Tabs tabs={[['new', addTo ? `Add to ${addTo.order_no}` : 'New order'], ['active', `Active orders (${orders.data?.length || 0})`]]} value={tab} onChange={setTab} />
      {tab === 'new' ? (
        <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
          <div>
            <div className="mb-3 flex flex-wrap gap-2">
              <input className="input max-w-[200px]" placeholder="Search menu" value={search} onChange={(e) => setSearch(e.target.value)} />
              <button className={`chip ${cat === 'all' ? 'chip-on' : ''}`} onClick={() => setCat('all')}>All</button>
              {menu.data.categories.filter((c) => c.active).map((c) => (
                <button key={c.id} className={`chip ${cat === String(c.id) ? 'chip-on' : ''}`} onClick={() => setCat(String(c.id))}>{c.name}</button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
              {items.map((i) => (
                <button key={i.id} disabled={!i.available} onClick={() => (i.variants.length || i.addons.length ? setPicking(i) : setCart([...cart, { menu_item_id: i.id, name: i.name, variant: null, addons: [], quantity: 1, unit: i.price_paise }]))}
                  className="card flex h-24 flex-col justify-between p-3 text-left transition hover:border-night-300 hover:shadow-lift disabled:opacity-40">
                  <span className="flex items-start gap-1.5 text-sm font-semibold leading-tight">
                    {i.is_veg !== null && <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-sm border-2 ${i.is_veg ? 'border-green-600' : 'border-red-600'}`} />}{i.name}</span>
                  <span className="num text-sm text-ink-700">{!i.available ? 'Unavailable' : i.variants.length ? i.variants.map((v) => rupees0(v.price_paise)).filter((x, n, a) => a.indexOf(x) === n).join(' / ') : rupees0(i.price_paise)}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="card flex h-fit flex-col p-4 lg:sticky lg:top-4">
            {addTo ? (
              <div className="mb-3 flex items-center justify-between rounded-lg bg-amber-50 px-3 py-2 text-sm">Adding to <b>{addTo.order_no}</b><button className="btn-ghost btn-sm" onClick={() => setAddTo(null)}>✕</button></div>
            ) : (
              <>
                <div className="mb-3 grid grid-cols-3 gap-1 rounded-lg bg-ink-100 p-1">
                  {[['dine_in', 'Dine-in'], ['takeaway', 'Takeaway'], ['room_service', 'Room']].map(([v, l]) => (
                    <button key={v} onClick={() => setType(v)} className={`rounded-md py-1.5 text-sm font-semibold ${type === v ? 'bg-white shadow' : 'text-ink-500'}`}>{l}</button>
                  ))}
                </div>
                {type === 'dine_in' && <input className="input mb-2" placeholder="Table no." value={table} onChange={(e) => setTable(e.target.value)} />}
                {type === 'room_service' && (
                  <select className="input mb-2" value={roomId} onChange={(e) => setRoomId(e.target.value)}>
                    <option value="">Select in-house room</option>{inHouse.map((r) => <option key={r.id} value={r.id}>{r.number} · {r.guest_name}</option>)}
                  </select>
                )}
                {type !== 'room_service' && <input className="input mb-2" placeholder="Customer name (optional)" value={customer} onChange={(e) => setCustomer(e.target.value)} />}
              </>
            )}
            <div className="max-h-72 flex-1 divide-y divide-ink-50 overflow-y-auto">
              {!cart.length && <Empty>Tap items to add</Empty>}
              {cart.map((c, i) => (
                <div key={i} className="flex items-center gap-2 py-2 text-sm">
                  <div className="flex-1"><div className="font-medium">{c.name}{c.variant && ` (${c.variant})`}</div>
                    {(c.addons.length > 0 || c.notes) && <div className="text-xs text-ink-500">{[...c.addons.map((a) => `+${a}`), c.notes].filter(Boolean).join(' · ')}</div>}</div>
                  <div className="flex items-center gap-1">
                    <button className="btn-ghost btn-sm" onClick={() => setCart(cart.map((x, j) => (j === i ? { ...x, quantity: x.quantity - 1 } : x)).filter((x) => x.quantity > 0))}>−</button>
                    <span className="w-5 text-center">{c.quantity}</span>
                    <button className="btn-ghost btn-sm" onClick={() => setCart(cart.map((x, j) => (j === i ? { ...x, quantity: x.quantity + 1 } : x)))}>+</button>
                  </div>
                  <div className="w-16 text-right tabular-nums">{rupees0(c.unit * c.quantity)}</div>
                </div>
              ))}
            </div>
            {!addTo && <input className="input mt-2" placeholder="Order note" value={notes} onChange={(e) => setNotes(e.target.value)} />}
            <div className="mt-3 flex justify-between text-sm"><span>Subtotal</span><span className="font-semibold">{rupees(subtotal)}</span></div>
            <div className="text-xs text-ink-400">+ GST {menu.data.default_tax_rate}% on settlement</div>
            <button className="btn-primary mt-3 py-2.5" disabled={busy || !cart.length || (!addTo && type === 'room_service' && !roomId)} onClick={place}>{addTo ? 'Add items & send KOT' : 'Place order & send KOT'}</button>
          </div>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {!orders.data?.length && <div className="card col-span-full"><Empty>No active orders</Empty></div>}
          {orders.data?.map((o) => (
            <div key={o.id} className="card p-4">
              <div className="flex items-start justify-between">
                <div><button className="font-bold hover:underline" onClick={() => openDetail(o.id)}>{o.order_no}</button>
                  <div className="text-xs text-ink-500">{o.order_type === 'room_service' ? `Room ${o.room_number}` : o.order_type === 'dine_in' ? `Table ${o.table_label || '—'}` : 'Takeaway'} · {ago(o.created_at)} {o.source === 'guest_qr' && '· QR'}</div></div>
                <div className="text-right"><Badge status={o.status} /><div className="mt-1"><Badge status={o.settlement} /></div></div>
              </div>
              <ul className="my-3 space-y-0.5 text-sm">{o.items?.filter((i) => !i.cancelled).map((i, k) => <li key={k}>{i.quantity} × {i.name}{i.variant && ` (${i.variant})`}</li>)}</ul>
              <div className="flex items-center justify-between">
                <span className="font-semibold tabular-nums">{rupees(o.total_paise)}</span>
                <div className="flex flex-wrap justify-end gap-1">
                  {o.settlement === 'unsettled' && o.status !== 'cancelled' && <button className="btn-ghost btn-sm" onClick={() => { setAddTo(o); setTab('new'); }}>Add items</button>}
                  {o.settlement === 'unsettled' && o.status !== 'cancelled' && can('pos.discount') && <button className="btn-ghost btn-sm" onClick={() => setDiscount({ order: o, mode: 'percent', value: '', reason: '' })}>Discount</button>}
                  {['unsettled', 'room_posted'].includes(o.settlement) && o.status !== 'cancelled' && can('pos.cancel') && <button className="btn-ghost btn-sm text-red-600" onClick={() => setCancel(o)}>Cancel</button>}
                  {NEXT[o.status] && <button className="btn-secondary btn-sm" onClick={() => run(async () => { await api.patch(`/orders/${o.id}/status`, { status: o.order_type === 'room_service' && o.status === 'ready' ? 'out_for_delivery' : NEXT[o.status] }); orders.reload(); })}>
                    → {label(o.order_type === 'room_service' && o.status === 'ready' ? 'out_for_delivery' : NEXT[o.status])}</button>}
                  {o.settlement === 'unsettled' && can('pos.settle') && <button className="btn-primary btn-sm" onClick={() => setSettle(o)}>Settle</button>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {picking && <ItemPicker item={picking} onClose={() => setPicking(null)} onAdd={(c) => { setCart([...cart, c]); setPicking(null); }} />}
      {settle && <SettleDialog order={settle} rooms={inHouse} onClose={() => setSettle(null)} onDone={() => { setSettle(null); setDetail(null); orders.reload(); }} />}
      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail ? `${detail.order_no} · ${label(detail.order_type)}` : ''} wide
        footer={detail && <>
          {['unsettled', 'room_posted'].includes(detail.settlement) && detail.status !== 'cancelled' && can('pos.cancel') && <button className="btn-ghost text-red-600" onClick={() => setCancel(detail)}>Cancel order</button>}
          {detail.settlement === 'unsettled' && detail.status !== 'cancelled' && can('pos.discount') && <button className="btn-secondary" onClick={() => setDiscount({ order: detail, mode: 'percent', value: '', reason: '' })}>Discount</button>}
          {detail.settlement === 'unsettled' && detail.status !== 'cancelled' && <button className="btn-secondary" onClick={() => { setAddTo(detail); setDetail(null); setTab('new'); }}>Add items</button>}
          {detail.kots.map((k) => <a key={k.id} className="btn-secondary" href="#" onClick={async (e) => {
            e.preventDefault(); const txt = await (await request('GET', `/kots/${k.id}/print`, null, { raw: true })).text();
            const w = window.open('', '_blank', 'width=320,height=600'); w.document.write(`<pre style="font:13px monospace">${txt.replace(/</g, '&lt;')}</pre>`); w.print();
          }}>Print {k.kot_no}</a>)}
          {detail.settlement === 'unsettled' && detail.status !== 'cancelled' && can('pos.settle') && <button className="btn-primary" onClick={() => setSettle(detail)}>Settle</button>}
        </>}>
        {detail && (
          <table className="table">
            <tbody>
              {detail.items.map((i) => (
                <tr key={i.id} className={i.cancelled ? 'text-ink-300 line-through' : ''}>
                  <td>{i.quantity} × {i.name}{i.variant && ` (${i.variant})`}{i.complimentary && <Badge status="complimentary" />}<div className="text-xs text-ink-500">{i.addons.map((a) => `+${a.name}`).join(', ')} {i.notes}</div></td>
                  <td className="text-right tabular-nums">{rupees(i.amount_paise)}</td>
                  <td className="whitespace-nowrap text-right">{!i.cancelled && ['unsettled', 'room_posted'].includes(detail.settlement) && detail.status !== 'cancelled' && <>
                    {can('pos.complimentary') && !i.complimentary && detail.settlement === 'unsettled' && <button className="btn-ghost btn-sm" onClick={() => setItemAction({ kind: 'comp', item: i })}>Comp</button>}
                    {can('pos.cancel') && <button className="btn-ghost btn-sm text-red-600" onClick={() => setItemAction({ kind: 'remove', item: i })}>Remove</button>}
                  </>}</td>
                </tr>
              ))}
              <tr><td>Subtotal</td><td className="text-right tabular-nums">{rupees(detail.subtotal_paise)}</td><td /></tr>
              {detail.discount_paise > 0 && <tr><td>Discount</td><td className="text-right tabular-nums">−{rupees(detail.discount_paise)}</td><td /></tr>}
              <tr><td>GST</td><td className="text-right tabular-nums">{rupees(detail.tax_paise)}</td><td /></tr>
              <tr className="font-bold"><td>Total</td><td className="text-right tabular-nums">{rupees(detail.total_paise)}</td><td /></tr>
            </tbody>
          </table>
        )}
      </Modal>
      <ReasonDialog open={!!itemAction} danger={itemAction?.kind === 'remove'} confirmLabel={itemAction?.kind === 'comp' ? 'Make complimentary' : 'Remove item'}
        title={itemAction ? `${itemAction.kind === 'comp' ? 'Complimentary' : 'Remove'} · ${itemAction.item.name}` : ''} onClose={() => setItemAction(null)}
        onSubmit={(reason) => run(async () => {
          await api.post(`/orders/${detail.id}/items/${itemAction.item.id}/${itemAction.kind === 'comp' ? 'complimentary' : 'cancel'}`, { reason });
          setItemAction(null); refreshDetail();
        }, itemAction?.kind === 'comp' ? 'Item marked complimentary' : 'Item removed')} />
      <ReasonDialog open={!!cancel} title={`Cancel ${cancel?.order_no}`} confirmLabel="Cancel order" onClose={() => setCancel(null)}
        onSubmit={(reason) => run(async () => { await api.post(`/orders/${cancel.id}/cancel`, { reason }); setCancel(null); setDetail(null); orders.reload(); }, 'Order cancelled')} />
      <Modal open={!!discount} onClose={() => setDiscount(null)} title={`Discount · ${discount?.order?.order_no || ''}`}
        footer={<><button className="btn-secondary" onClick={() => setDiscount(null)}>Cancel</button><button className="btn-primary" disabled={!discount?.value || !discount?.reason} onClick={() => run(async () => {
          await api.post(`/orders/${discount.order.id}/discount`, { reason: discount.reason, ...(discount.mode === 'percent' ? { percent: Number(discount.value) } : { amount_paise: toPaise(discount.value) }) });
          setDiscount(null); if (detail) refreshDetail(); else orders.reload();
        }, 'Discount applied')}>Apply</button></>}>
        {discount && <div className="grid grid-cols-2 gap-3">
          <Field label="Type"><select className="input" value={discount.mode} onChange={(e) => setDiscount({ ...discount, mode: e.target.value })}><option value="percent">%</option><option value="amount">₹</option></select></Field>
          <Field label="Value"><input className="input" value={discount.value} onChange={(e) => setDiscount({ ...discount, value: e.target.value })} /></Field>
          <Field label="Reason" className="col-span-2"><input className="input" value={discount.reason} onChange={(e) => setDiscount({ ...discount, reason: e.target.value })} /></Field>
        </div>}
      </Modal>
    </div>
  );
}
