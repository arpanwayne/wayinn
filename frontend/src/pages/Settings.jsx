import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useApi } from '../lib/hooks.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { rupees0, toPaise, plural } from '../lib/format.js';
import { PageHeader, Loading, Modal, Field, Tabs, Badge, PromptDialog, DeleteDialog, useAction } from '../components/ui.jsx';

function HotelProfile() {
  const { data, reload } = useApi('/hotel');
  const [f, setF] = useState(null);
  const [run, busy] = useAction();
  useEffect(() => { if (data) setF({ ...data, tax: data.tax }); }, [data]);
  if (!f) return <Loading />;
  const set = (p) => setF({ ...f, ...p });
  const setTax = (p) => setF({ ...f, tax: { ...f.tax, ...p } });
  const setS = (p) => setF({ ...f, settings: { ...f.settings, ...p } });
  const save = () => run(async () => {
    await api.put('/hotel', {
      name: f.name, legal_name: f.legal_name, gstin: f.gstin || '', address: f.address, city: f.city, state: f.state, state_code: f.state_code,
      phone: f.phone, email: f.email, checkin_time: f.checkin_time.slice(0, 5), checkout_time: f.checkout_time.slice(0, 5), invoice_prefix: f.invoice_prefix,
      settings: {
        tax: { room_slabs: f.tax.room_slabs, food_rate: Number(f.tax.food_rate), service_rate: Number(f.tax.service_rate) },
        qr_orders_require_accept: f.settings.qr_orders_require_accept === true, qr_show_bill: f.settings.qr_show_bill !== false,
        discount_alert_pct: Number(f.settings.discount_alert_pct ?? 20), invoice_footer: f.settings.invoice_footer || '',
      },
    });
    reload();
  }, 'Settings saved');
  return (
    <div className="space-y-5">
      <div className="card grid grid-cols-1 gap-3 p-4 sm:grid-cols-3">
        <Field label="Hotel name"><input className="input" value={f.name} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label="Legal name"><input className="input" value={f.legal_name || ''} onChange={(e) => set({ legal_name: e.target.value })} /></Field>
        <Field label="GSTIN"><input className="input uppercase" maxLength={15} value={f.gstin || ''} onChange={(e) => {
          const gstin = e.target.value.toUpperCase();
          set(/^\d{2}/.test(gstin) ? { gstin, state_code: gstin.slice(0, 2) } : { gstin });
        }} /></Field>
        <Field label="Address" className="sm:col-span-2"><input className="input" value={f.address || ''} onChange={(e) => set({ address: e.target.value })} /></Field>
        <Field label="City"><input className="input" value={f.city || ''} onChange={(e) => set({ city: e.target.value })} /></Field>
        <Field label="State"><input className="input" value={f.state || ''} onChange={(e) => set({ state: e.target.value })} /></Field>
        <Field label="GST state code"><input className="input" maxLength={2} inputMode="numeric" value={f.state_code || ''} onChange={(e) => set({ state_code: e.target.value.replace(/\D/g, '') })} />
          <div className={`mt-1 text-xs ${f.gstin && f.state_code && f.gstin.slice(0, 2) !== f.state_code ? 'text-red-600' : 'text-ink-500'}`}>
            {f.gstin && f.state_code && f.gstin.slice(0, 2) !== f.state_code ? `Must be ${f.gstin.slice(0, 2)} to match the GSTIN`
              : GST_STATES[f.state_code] ? `${GST_STATES[f.state_code]} · decides CGST+SGST vs IGST` : 'First 2 digits of the GSTIN'}
          </div></Field>
        <Field label="Phone"><input className="input" value={f.phone || ''} onChange={(e) => set({ phone: e.target.value })} /></Field>
        <Field label="Email"><input className="input" value={f.email || ''} onChange={(e) => set({ email: e.target.value })} /></Field>
        <Field label="Check-in time"><input type="time" className="input" value={f.checkin_time.slice(0, 5)} onChange={(e) => set({ checkin_time: e.target.value })} /></Field>
        <Field label="Check-out time"><input type="time" className="input" value={f.checkout_time.slice(0, 5)} onChange={(e) => set({ checkout_time: e.target.value })} /></Field>
        <Field label="Invoice prefix"><input className="input" maxLength={6} value={f.invoice_prefix} onChange={(e) => set({ invoice_prefix: e.target.value })} /></Field>
        <Field label="Invoice footer" className="sm:col-span-2"><input className="input" value={f.settings.invoice_footer || ''} onChange={(e) => setS({ invoice_footer: e.target.value })} placeholder="Thank you for staying with us" /></Field>
      </div>
      <div className="card p-4">
        <h2>GST settings</h2>
        <p className="mb-3 text-xs text-ink-500">Defaults follow current Indian GST on hotel rooms (≤ ₹7,500/night → 5%, above → 18%). Confirm with your accountant.</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          {f.tax.room_slabs.map((s, i) => (
            <div key={i} className="contents">
              <Field label={i === f.tax.room_slabs.length - 1 ? 'Room tariff above' : 'Room tariff up to ₹'}>
                {s.upto_paise === null ? <div className="input bg-ink-50">{rupees0(f.tax.room_slabs[i - 1]?.upto_paise || 0)}</div>
                  : <input className="input" value={s.upto_paise / 100} onChange={(e) => setTax({ room_slabs: f.tax.room_slabs.map((x, j) => (j === i ? { ...x, upto_paise: toPaise(e.target.value) } : x)) })} />}
              </Field>
              <Field label="GST %"><input className="input" value={s.rate} onChange={(e) => setTax({ room_slabs: f.tax.room_slabs.map((x, j) => (j === i ? { ...x, rate: Number(e.target.value) } : x)) })} /></Field>
            </div>
          ))}
          <Field label="Food GST %"><input className="input" value={f.tax.food_rate} onChange={(e) => setTax({ food_rate: e.target.value })} /></Field>
          <Field label="Other services GST %"><input className="input" value={f.tax.service_rate} onChange={(e) => setTax({ service_rate: e.target.value })} /></Field>
        </div>
      </div>
      <div className="card space-y-2 p-4 text-sm">
        <h2 className="mb-1">Guest portal & controls</h2>
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.settings.qr_orders_require_accept === true} onChange={(e) => setS({ qr_orders_require_accept: e.target.checked })} /> Hold guest QR food orders until staff accept them (off = straight to the kitchen and onto the room bill)</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.settings.qr_show_bill !== false} onChange={(e) => setS({ qr_show_bill: e.target.checked })} /> Show the running bill to verified guests</label>
        <label className="flex items-center gap-2">Flag discounts above <input className="input w-20" value={f.settings.discount_alert_pct ?? 20} onChange={(e) => setS({ discount_alert_pct: e.target.value })} /> % to the owner</label>
      </div>
      <button className="btn-primary" disabled={busy} onClick={save}>Save settings</button>
    </div>
  );
}

function RoomSetup() {
  const types = useApi('/room-types');
  const rooms = useApi('/rooms');
  const [rt, setRt] = useState(null);
  const [bulk, setBulk] = useState(null);
  const [room, setRoom] = useState(null);
  const [del, setDel] = useState(null); // { kind: 'room' | 'type', id, name }
  const [run, busy] = useAction();
  if (!types.data || !rooms.data) return <Loading />;
  const reloadAll = () => { rooms.reload(); types.reload(); };
  return (
    <div className="space-y-5">
      <div className="card overflow-x-auto">
        <div className="flex items-center justify-between p-3"><h2>Room types & rates</h2>
          <button className="btn-primary btn-sm" onClick={() => setRt({ name: '', base_occupancy: 2, max_occupancy: 3, rate: '', extra: '', amenities: '' })}>+ Room type</button></div>
        <table className="table"><tbody>{types.data.map((t) => (
          <tr key={t.id}><td className="font-semibold">{t.name}<div className="text-xs font-normal text-ink-500">{t.amenities.join(', ')}</div></td>
            <td>{plural(t.room_count, 'room')}</td><td>{t.base_occupancy}–{t.max_occupancy} guests</td><td className="tabular-nums">{rupees0(t.base_rate_paise)}<span className="text-xs text-ink-500"> +{rupees0(t.extra_person_rate_paise)}/extra</span></td>
            <td className="text-right"><button className="btn-secondary btn-sm" onClick={() => setRt({ ...t, rate: t.base_rate_paise / 100, extra: t.extra_person_rate_paise / 100, amenities: t.amenities.join(', ') })}>Edit</button>
              <button className="btn-ghost btn-sm" onClick={() => setBulk({ room_type_id: t.id, from: '', to: '', floor: '' })}>+ Rooms</button></td></tr>
        ))}</tbody></table>
      </div>
      <div className="card p-4">
        <h2 className="mb-3">Rooms ({rooms.data.length})</h2>
        <div className="flex flex-wrap gap-2">{rooms.data.map((r) => (
          <button key={r.id} type="button" title="Edit room" onClick={() => setRoom({ ...r, floor: r.floor || '', notes: r.notes || '' })}
            className={`rounded-lg border px-3 py-1.5 text-left text-sm transition hover:border-night-900 ${r.active ? 'border-ink-200' : 'border-dashed text-ink-400'}`}>
            <b>{r.number}</b> <span className="text-xs text-ink-500">{r.room_type}{!r.active && ' · disabled'}</span>
          </button>
        ))}</div>
        <p className="mt-2 text-xs text-ink-500">Tap a room to change its number, type or floor, disable it, or delete it.</p>
      </div>
      <Modal open={!!rt} onClose={() => setRt(null)} title={rt?.id ? `Edit ${rt.name}` : 'New room type'}
        footer={<>{rt?.id && <button className="btn-ghost mr-auto text-red-700" onClick={() => setDel({ kind: 'type', id: rt.id, name: rt.name })}>Delete</button>}
          <button className="btn-secondary" onClick={() => setRt(null)}>Cancel</button><button className="btn-primary" disabled={busy || !rt?.name || rt?.rate === ''} onClick={() => run(async () => {
          const body = { name: rt.name, base_occupancy: Number(rt.base_occupancy), max_occupancy: Number(rt.max_occupancy), base_rate_paise: toPaise(rt.rate),
            extra_person_rate_paise: toPaise(rt.extra || 0), amenities: rt.amenities.split(',').map((x) => x.trim()).filter(Boolean), description: rt.description || null };
          if (rt.id) await api.put(`/room-types/${rt.id}`, body); else await api.post('/room-types', body);
          setRt(null); types.reload();
        }, 'Saved')}>Save</button></>}>
        {rt && <div className="grid grid-cols-2 gap-3">
          <Field label="Name"><input className="input" value={rt.name} onChange={(e) => setRt({ ...rt, name: e.target.value })} /></Field>
          <Field label="Rate per night ₹"><input className="input" value={rt.rate} onChange={(e) => setRt({ ...rt, rate: e.target.value })} /></Field>
          <Field label="Base occupancy"><input type="number" className="input" value={rt.base_occupancy} onChange={(e) => setRt({ ...rt, base_occupancy: e.target.value })} /></Field>
          <Field label="Max occupancy"><input type="number" className="input" value={rt.max_occupancy} onChange={(e) => setRt({ ...rt, max_occupancy: e.target.value })} /></Field>
          <Field label="Extra person ₹/night"><input className="input" value={rt.extra} onChange={(e) => setRt({ ...rt, extra: e.target.value })} /></Field>
          <Field label="Amenities (comma separated)"><input className="input" value={rt.amenities} onChange={(e) => setRt({ ...rt, amenities: e.target.value })} /></Field>
          <Field label="Description (shown on booking page)" className="col-span-2"><textarea className="input" rows={2} value={rt.description || ''} onChange={(e) => setRt({ ...rt, description: e.target.value })} /></Field>
        </div>}
      </Modal>
      <Modal open={!!bulk} onClose={() => setBulk(null)} title="Add rooms"
        footer={<><button className="btn-secondary" onClick={() => setBulk(null)}>Cancel</button><button className="btn-primary" disabled={busy || !bulk?.from} onClick={() => run(async () => {
          await api.post('/rooms/bulk', { room_type_id: bulk.room_type_id, from: Number(bulk.from), to: Number(bulk.to || bulk.from), floor: bulk.floor || null });
          setBulk(null); reloadAll();
        }, 'Rooms added')}>Add</button></>}>
        {bulk && <div className="grid grid-cols-3 gap-3">
          <Field label="From no."><input className="input" value={bulk.from} onChange={(e) => setBulk({ ...bulk, from: e.target.value })} /></Field>
          <Field label="To no."><input className="input" value={bulk.to} onChange={(e) => setBulk({ ...bulk, to: e.target.value })} /></Field>
          <Field label="Floor"><input className="input" value={bulk.floor} onChange={(e) => setBulk({ ...bulk, floor: e.target.value })} /></Field>
        </div>}
      </Modal>
      <Modal open={!!room} onClose={() => setRoom(null)} title={`Room ${room?.number || ''}`}
        footer={<>
          <button className="btn-ghost mr-auto text-red-700" onClick={() => setDel({ kind: 'room', id: room.id, name: `room ${room.number}` })}>Delete</button>
          <button className="btn-secondary" onClick={() => setRoom(null)}>Cancel</button>
          <button className="btn-primary" disabled={busy || !room?.number} onClick={() => run(async () => {
            await api.put(`/rooms/${room.id}`, { number: room.number.trim(), room_type_id: Number(room.room_type_id), floor: room.floor || null, notes: room.notes || null, active: room.active });
            setRoom(null); reloadAll();
          }, 'Room saved')}>Save</button></>}>
        {room && <div className="grid grid-cols-2 gap-3">
          <Field label="Room number"><input className="input" value={room.number} onChange={(e) => setRoom({ ...room, number: e.target.value })} /></Field>
          <Field label="Room type"><select className="input" value={room.room_type_id} onChange={(e) => setRoom({ ...room, room_type_id: e.target.value })}>
            {types.data.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
          <Field label="Floor"><input className="input" value={room.floor} onChange={(e) => setRoom({ ...room, floor: e.target.value })} /></Field>
          <Field label="Notes"><input className="input" value={room.notes} onChange={(e) => setRoom({ ...room, notes: e.target.value })} /></Field>
          <label className="col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={room.active} onChange={(e) => setRoom({ ...room, active: e.target.checked })} /> Room in use (untick to disable it; it stops showing for new bookings)</label>
        </div>}
      </Modal>
      <DeleteDialog open={!!del} title={`Delete ${del?.name}?`}
        message={del?.kind === 'room'
          ? 'This removes the room for good. It only works for a room that was never used. A room with bookings, orders or tasks can only be disabled.'
          : 'This removes the room type for good. It only works when no room and no booking uses it.'}
        onClose={() => setDel(null)}
        onConfirm={() => run(async () => {
          await api.del(del.kind === 'room' ? `/rooms/${del.id}` : `/room-types/${del.id}`);
          setDel(null); setRoom(null); setRt(null); reloadAll();
        }, 'Deleted').catch(() => setDel(null))} />
    </div>
  );
}

function MenuSetup() {
  const { data, reload } = useApi('/menu');
  const [item, setItem] = useState(null);
  const [adding, setAdding] = useState(null); // 'category' | 'station'
  const [renaming, setRenaming] = useState(null); // { kind, id, name }
  const [del, setDel] = useState(null); // { kind: 'item' | 'category' | 'station', id, name }
  const [run, busy] = useAction();
  if (!data) return <Loading />;
  const parsePriced = (s) => s.split(',').map((x) => x.trim()).filter(Boolean).map((x) => { const [n, p] = x.split(':'); return { name: n.trim(), price_paise: toPaise(p || 0) }; });
  const fmtPriced = (arr) => arr.map((x) => `${x.name}:${x.price_paise / 100}`).join(', ');
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        <button className="btn-primary" onClick={() => setItem({ name: '', price: '', category_id: data.categories[0]?.id || '', station_id: data.stations[0]?.id || '', is_veg: true, variants: '', addons: '', available: true, show_on_qr: true, description: '' })}>+ Menu item</button>
        <button className="btn-secondary" onClick={() => setAdding('category')}>+ Category</button>
        <button className="btn-secondary" onClick={() => setAdding('station')}>+ Station</button>
      </div>
      <PromptDialog open={!!adding} title={adding === 'category' ? 'New menu category' : 'New kitchen station'} label={adding === 'category' ? 'Category name' : 'Station name (e.g. Tandoor, Bar)'}
        confirmLabel="Add" onClose={() => setAdding(null)}
        onSubmit={(name) => run(async () => { await api.post(adding === 'category' ? '/menu/categories' : '/stations', { name }); setAdding(null); reload(); }, 'Added')} />
      <PromptDialog open={!!renaming} title={`Rename ${renaming?.name}`} label="New name" confirmLabel="Save" onClose={() => setRenaming(null)}
        onSubmit={(name) => run(async () => { await api.put(renaming.kind === 'category' ? `/menu/categories/${renaming.id}` : `/stations/${renaming.id}`, { name }); setRenaming(null); reload(); }, 'Renamed')} />
      <div className="card p-4">
        <h2 className="mb-2">Categories & kitchen stations</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {[['category', 'Categories', data.categories], ['station', 'Kitchen stations', data.stations]].map(([kind, title, list]) => (
            <div key={kind}>
              <div className="label">{title}</div>
              <ul className="divide-y divide-ink-100 rounded-xl border border-ink-200">{list.map((x) => (
                <li key={x.id} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
                  <span>{x.name} <span className="text-xs text-ink-400">{plural(data.items.filter((i) => (kind === 'category' ? i.category_id : i.station_id) === x.id).length, 'item')}</span></span>
                  <span className="whitespace-nowrap">
                    <button className="btn-ghost btn-sm" onClick={() => setRenaming({ kind, id: x.id, name: x.name })}>Rename</button>
                    <button className="btn-ghost btn-sm text-red-700" onClick={() => setDel({ kind, id: x.id, name: x.name })}>Delete</button>
                  </span>
                </li>
              ))}</ul>
            </div>
          ))}
        </div>
      </div>
      {[...data.categories, ...(data.items.some((i) => !data.categories.some((c) => c.id === i.category_id)) ? [{ id: null, name: 'No category' }] : [])].map((c) => (
        <div key={c.id ?? 'none'} className="card overflow-x-auto">
          <h2 className="p-3">{c.name}</h2>
          <table className="table"><tbody>{data.items.filter((i) => (c.id === null ? !data.categories.some((x) => x.id === i.category_id) : i.category_id === c.id)).map((i) => (
            <tr key={i.id} className={i.available ? '' : 'opacity-50'}>
              <td className="font-semibold">{i.name}<div className="text-xs font-normal text-ink-500">{[fmtPriced(i.variants), i.addons.length ? `Add-ons: ${fmtPriced(i.addons)}` : ''].filter(Boolean).join(' · ')}</div></td>
              <td className="tabular-nums">{rupees0(i.price_paise)}</td>
              <td className="text-ink-500">{data.stations.find((s) => s.id === i.station_id)?.name}</td>
              <td>{!i.show_on_qr && <Badge status="closed">Staff only</Badge>}</td>
              <td className="whitespace-nowrap text-right">
                <button className="btn-ghost btn-sm" onClick={() => run(async () => { await api.patch(`/menu/items/${i.id}/availability`, { available: !i.available }); reload(); })}>{i.available ? 'Mark unavailable' : 'Mark available'}</button>
                <button className="btn-secondary btn-sm" onClick={() => setItem({ ...i, price: i.price_paise / 100, variants: fmtPriced(i.variants), addons: fmtPriced(i.addons) })}>Edit</button>
              </td>
            </tr>
          ))}</tbody></table>
        </div>
      ))}
      <Modal open={!!item} onClose={() => setItem(null)} title={item?.id ? `Edit ${item.name}` : 'New menu item'}
        footer={<>{item?.id && <button className="btn-ghost mr-auto text-red-700" onClick={() => setDel({ kind: 'item', id: item.id, name: item.name })}>Delete</button>}
          <button className="btn-secondary" onClick={() => setItem(null)}>Cancel</button><button className="btn-primary" disabled={busy || !item?.name || item?.price === ''} onClick={() => run(async () => {
          const body = { name: item.name, description: item.description || null, category_id: item.category_id ? Number(item.category_id) : null, station_id: item.station_id ? Number(item.station_id) : null,
            price_paise: toPaise(item.price), is_veg: item.is_veg, variants: parsePriced(item.variants), addons: parsePriced(item.addons), available: item.available, show_on_qr: item.show_on_qr };
          if (item.id) await api.put(`/menu/items/${item.id}`, body); else await api.post('/menu/items', body);
          setItem(null); reload();
        }, 'Saved')}>Save</button></>}>
        {item && <div className="grid grid-cols-2 gap-3">
          <Field label="Name"><input className="input" value={item.name} onChange={(e) => setItem({ ...item, name: e.target.value })} /></Field>
          <Field label="Price ₹"><input className="input" value={item.price} onChange={(e) => setItem({ ...item, price: e.target.value })} /></Field>
          <Field label="Category"><select className="input" value={item.category_id || ''} onChange={(e) => setItem({ ...item, category_id: e.target.value })}>{data.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <Field label="Kitchen station"><select className="input" value={item.station_id || ''} onChange={(e) => setItem({ ...item, station_id: e.target.value })}>{data.stations.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          <Field label="Options (Half:180, Full:280)" className="col-span-2"><input className="input" value={item.variants} onChange={(e) => setItem({ ...item, variants: e.target.value })} /></Field>
          <Field label="Add-ons (Extra cheese:40)" className="col-span-2"><input className="input" value={item.addons} onChange={(e) => setItem({ ...item, addons: e.target.value })} /></Field>
          <Field label="Description" className="col-span-2"><input className="input" value={item.description || ''} onChange={(e) => setItem({ ...item, description: e.target.value })} /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!item.is_veg} onChange={(e) => setItem({ ...item, is_veg: e.target.checked })} /> Vegetarian</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={item.show_on_qr} onChange={(e) => setItem({ ...item, show_on_qr: e.target.checked })} /> Show on guest QR menu</label>
        </div>}
      </Modal>
      <DeleteDialog open={!!del} title={`Delete ${del?.name}?`}
        message={del?.kind === 'item' ? 'The item is removed from the menu for good. Past orders and bills keep their own copy of it.'
          : del?.kind === 'category' ? 'The category must be empty. Move or delete its items first.'
          : 'No menu item may still be sent to this station. Move those items to another station first.'}
        onClose={() => setDel(null)}
        onConfirm={() => run(async () => {
          await api.del(del.kind === 'item' ? `/menu/items/${del.id}` : del.kind === 'category' ? `/menu/categories/${del.id}` : `/stations/${del.id}`);
          setDel(null); setItem(null); reload();
        }, 'Deleted').catch(() => setDel(null))} />
    </div>
  );
}

function QrSheet() {
  const { data } = useApi('/rooms/qr-sheet');
  const { hotel } = useAuth();
  const [imgs, setImgs] = useState({});
  useEffect(() => {
    if (!data) return;
    Promise.all(data.map(async (r) => [r.id, await QRCode.toDataURL(r.portal_url, { margin: 1, width: 240 })])).then((x) => setImgs(Object.fromEntries(x)));
  }, [data]);
  if (!data) return <Loading />;
  const bookUrl = `${location.origin}/book/${hotel.slug}`;
  return (
    <div>
      <div className="no-print mb-4 flex flex-wrap items-center gap-3">
        <button className="btn-primary" onClick={() => window.print()}>Print QR cards</button>
        <span className="text-sm text-ink-500">Online booking page: <a className="link underline" href={bookUrl} target="_blank" rel="noreferrer">{bookUrl}</a></span>
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {data.map((r) => (
          <div key={r.id} className="card break-inside-avoid p-4 text-center">
            <div className="text-xs font-semibold uppercase text-ink-400">{hotel.name}</div>
            <div className="num text-2xl">Room {r.number}</div>
            {imgs[r.id] && <img src={imgs[r.id]} alt={`QR for room ${r.number}`} className="mx-auto my-2 w-36" />}
            <div className="text-xs text-ink-600">Scan for room service, requests & your bill</div>
          </div>
        ))}
      </div>
    </div>
  );
}


// GST state codes (first two digits of a GSTIN)
const GST_STATES = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana',
  '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland',
  '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand',
  '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra & Nagar Haveli and Daman & Diu',
  '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman & Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
};

export default function Settings() {
  const { can } = useAuth();
  const tabs = [
    ...(can('hotel.settings') ? [['hotel', 'Hotel & tax']] : []),
    ...(can('rooms.manage') ? [['rooms', 'Rooms & rates'], ['qr', 'QR codes & booking link']] : []),
    ...(can('menu.manage') ? [['menu', 'Menu']] : []),
  ];
  const [tab, setTab] = useState(tabs[0]?.[0]);
  return (
    <div>
      <PageHeader title="Setup" />
      <div className="no-print"><Tabs tabs={tabs} value={tab} onChange={setTab} /></div>
      {tab === 'hotel' && <HotelProfile />}
      {tab === 'rooms' && <RoomSetup />}
      {tab === 'menu' && <MenuSetup />}
      {tab === 'qr' && <QrSheet />}
    </div>
  );
}
