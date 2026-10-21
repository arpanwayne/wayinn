import { Router } from 'express';
import { z } from 'zod';
import { one, many, tx } from '../db.js';
import { parse, idParam } from '../lib/validate.js';
import { requireStaff, requirePerm, assertPerm } from '../middleware/auth.js';
import { notFound, badRequest, conflict } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { removeRow } from '../lib/remove.js';
import { taxOn, taxSettings } from '../lib/money.js';
import { hotelToday } from '../lib/dates.js';
import { nextOrderNo, nextKotNo, nextInvoiceNo } from '../lib/sequences.js';

import { kotEscpos } from '../lib/escpos.js';

const r = Router();
r.use(['/menu', '/stations', '/orders', '/kitchen', '/kots'], requireStaff);

// ===============================================================
// Menu management
// ===============================================================
r.get('/menu', async (req, res) => {
  const [categories, items, stations] = await Promise.all([
    many(`SELECT * FROM menu_categories WHERE hotel_id = $1 ORDER BY sort_order, name`, [req.hotelId]),
    many(`SELECT * FROM menu_items WHERE hotel_id = $1 ORDER BY sort_order, name`, [req.hotelId]),
    many(`SELECT * FROM stations WHERE hotel_id = $1 ORDER BY name`, [req.hotelId]),
  ]);
  res.json({ categories, items, stations, default_tax_rate: taxSettings(req.hotel).food_rate });
});

r.post('/stations', requirePerm('menu.manage'), async (req, res) => {
  const b = parse(z.object({ name: z.string().min(1) }), req.body);
  res.status(201).json(await one(`INSERT INTO stations (hotel_id, name) VALUES ($1,$2) RETURNING *`, [req.hotelId, b.name]));
});
r.put('/stations/:id', requirePerm('menu.manage'), async (req, res) => {
  const b = parse(z.object({ name: z.string().min(1).optional(), active: z.boolean().optional() }), req.body);
  res.json(await one(`UPDATE stations SET name = COALESCE($1,name), active = COALESCE($2,active) WHERE id = $3 AND hotel_id = $4 RETURNING *`,
    [b.name ?? null, b.active ?? null, idParam(req.params.id), req.hotelId]));
});

r.post('/menu/categories', requirePerm('menu.manage'), async (req, res) => {
  const b = parse(z.object({ name: z.string().min(1), sort_order: z.number().int().default(0) }), req.body);
  res.status(201).json(await one(`INSERT INTO menu_categories (hotel_id, name, sort_order) VALUES ($1,$2,$3) RETURNING *`, [req.hotelId, b.name, b.sort_order]));
});
r.put('/menu/categories/:id', requirePerm('menu.manage'), async (req, res) => {
  const b = parse(z.object({ name: z.string().optional(), sort_order: z.number().int().optional(), active: z.boolean().optional() }), req.body);
  res.json(await one(
    `UPDATE menu_categories SET name = COALESCE($1,name), sort_order = COALESCE($2,sort_order), active = COALESCE($3,active)
      WHERE id = $4 AND hotel_id = $5 RETURNING *`, [b.name ?? null, b.sort_order ?? null, b.active ?? null, idParam(req.params.id), req.hotelId]));
});

const priced = z.object({ name: z.string().min(1), price_paise: z.number().int().min(0) });
const itemSchema = z.object({
  name: z.string().min(1), description: z.string().nullable().optional(), category_id: z.number().int().nullable().optional(),
  station_id: z.number().int().nullable().optional(), price_paise: z.number().int().min(0),
  tax_rate: z.number().min(0).max(40).nullable().optional(), is_veg: z.boolean().nullable().optional(),
  variants: z.array(priced).default([]), addons: z.array(priced).default([]),
  available: z.boolean().default(true), show_on_qr: z.boolean().default(true), sort_order: z.number().int().default(0),
});
const ITEM_COLS = Object.keys(itemSchema.shape);
const jsonCols = new Set(['variants', 'addons']);

r.post('/menu/items', requirePerm('menu.manage'), async (req, res) => {
  const b = parse(itemSchema, req.body);
  const vals = ITEM_COLS.map((k) => (jsonCols.has(k) ? JSON.stringify(b[k]) : b[k] ?? null));
  const row = await one(`INSERT INTO menu_items (hotel_id, ${ITEM_COLS.join(', ')}) VALUES ($1, ${ITEM_COLS.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING *`,
    [req.hotelId, ...vals]);
  await audit(req, 'menu.item_created', 'menu_item', row.id, { name: row.name, price_paise: row.price_paise });
  res.status(201).json(row);
});

r.put('/menu/items/:id', requirePerm('menu.manage'), async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(itemSchema.partial(), req.body);
  const keys = Object.keys(b);
  if (!keys.length) throw badRequest('Nothing to update');
  const before = await one('SELECT price_paise FROM menu_items WHERE id = $1 AND hotel_id = $2', [id, req.hotelId]);
  if (!before) throw notFound();
  const row = await one(
    `UPDATE menu_items SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1} AND hotel_id = $${keys.length + 2} RETURNING *`,
    [...keys.map((k) => (jsonCols.has(k) ? JSON.stringify(b[k]) : b[k])), id, req.hotelId]);
  await audit(req, 'menu.item_updated', 'menu_item', id, { changed: keys, ...(b.price_paise !== undefined ? { price_from: before.price_paise, price_to: b.price_paise } : {}) });
  res.json(row);
});

// Delete a menu item. Past orders keep their own copy of the name and price, so history stays correct;
// only an item sitting in an order that is still being prepared blocks the delete.
r.delete('/menu/items/:id', requirePerm('menu.manage'), async (req, res) => {
  const id = idParam(req.params.id);
  const out = await tx(async (db) => {
    const item = await db.one('SELECT id, name FROM menu_items WHERE id = $1 AND hotel_id = $2 FOR UPDATE', [id, req.hotelId]);
    if (!item) throw notFound();
    const active = await db.one(
      `SELECT count(*)::int AS n FROM order_items i JOIN orders o ON o.id = i.order_id
        WHERE i.menu_item_id = $1 AND NOT i.cancelled AND o.status NOT IN ('delivered','cancelled')`, [id]);
    if (active.n) throw conflict('This item is in an order that is still open. Try again once that order is delivered or cancelled.');
    await db.query('UPDATE order_items SET menu_item_id = NULL WHERE menu_item_id = $1', [id]);
    await db.query('DELETE FROM menu_items WHERE id = $1', [id]);
    await audit(req, 'menu.item_deleted', 'menu_item', id, { name: item.name }, db);
    return { ok: true };
  });
  res.json(out);
});

r.delete('/menu/categories/:id', requirePerm('menu.manage'), async (req, res) => {
  const id = idParam(req.params.id);
  const { n } = await one('SELECT count(*)::int AS n FROM menu_items WHERE category_id = $1 AND hotel_id = $2', [id, req.hotelId]);
  if (n) throw conflict(`${n} menu item(s) are in this category. Move or delete them first.`);
  const row = await removeRow('DELETE FROM menu_categories WHERE id = $1 AND hotel_id = $2 RETURNING id, name', [id, req.hotelId], 'This category is still in use.');
  await audit(req, 'menu.category_deleted', 'menu_category', id, { name: row.name });
  res.json({ ok: true });
});

r.delete('/stations/:id', requirePerm('menu.manage'), async (req, res) => {
  const id = idParam(req.params.id);
  const out = await tx(async (db) => {
    const st = await db.one('SELECT id, name FROM stations WHERE id = $1 AND hotel_id = $2 FOR UPDATE', [id, req.hotelId]);
    if (!st) throw notFound();
    const items = await db.one('SELECT count(*)::int AS n FROM menu_items WHERE station_id = $1', [id]);
    if (items.n) throw conflict(`${items.n} menu item(s) are sent to this station. Move them to another station first.`);
    const open = await db.one(`SELECT count(*)::int AS n FROM kots WHERE station_id = $1 AND status IN ('pending','preparing','ready')`, [id]);
    if (open.n) throw conflict('This station has kitchen tickets that are not finished yet.');
    const left = await db.one('SELECT count(*)::int AS n FROM stations WHERE hotel_id = $1 AND id <> $2', [req.hotelId, id]);
    if (!left.n) throw badRequest('Keep at least one kitchen station');
    await db.query('UPDATE kots SET station_id = NULL WHERE station_id = $1', [id]);
    await db.query('UPDATE order_items SET station_id = NULL WHERE station_id = $1', [id]);
    await db.query('DELETE FROM stations WHERE id = $1', [id]);
    await audit(req, 'menu.station_deleted', 'station', id, { name: st.name }, db);
    return { ok: true };
  });
  res.json(out);
});

// Quick availability toggle for the kitchen / restaurant (86 an item)
r.patch('/menu/items/:id/availability', requirePerm('menu.manage', 'kitchen.view'), async (req, res) => {
  const b = parse(z.object({ available: z.boolean() }), req.body);
  res.json(await one(`UPDATE menu_items SET available = $1 WHERE id = $2 AND hotel_id = $3 RETURNING id, name, available`,
    [b.available, idParam(req.params.id), req.hotelId]));
});

// ===============================================================
// Order engine (shared by staff POS and guest QR portal)
// ===============================================================
export const orderItemInput = z.object({
  menu_item_id: z.number().int(),
  variant: z.string().optional().nullable(),
  addons: z.array(z.string()).default([]),
  quantity: z.number().int().min(1).max(50),
  notes: z.string().max(200).optional().nullable(),
});

/** Price items from the menu (never trust client prices). */
async function priceItems(db, hotel, items, { qr = false } = {}) {
  const ts = taxSettings(hotel);
  const out = [];
  for (const it of items) {
    const m = await db.one('SELECT * FROM menu_items WHERE id = $1 AND hotel_id = $2', [it.menu_item_id, hotel.id]);
    if (!m) throw badRequest('Unknown menu item');
    if (!m.available || (qr && !m.show_on_qr)) throw conflict(`${m.name} is not available right now`);
    let unit = m.price_paise;
    let variant = null;
    if (it.variant) {
      const v = m.variants.find((x) => x.name === it.variant);
      if (!v) throw badRequest(`Unknown option "${it.variant}" for ${m.name}`);
      unit = v.price_paise; variant = v.name;
    } else if (m.variants.length) {
      unit = m.variants[0].price_paise; variant = m.variants[0].name;
    }
    const addons = [];
    for (const a of it.addons || []) {
      const ad = m.addons.find((x) => x.name === a);
      if (!ad) throw badRequest(`Unknown add-on "${a}" for ${m.name}`);
      addons.push(ad); unit += ad.price_paise;
    }
    out.push({
      menu_item_id: m.id, station_id: m.station_id, name: m.name, variant, addons, quantity: it.quantity,
      unit_price_paise: unit, amount_paise: unit * it.quantity, tax_rate: m.tax_rate ?? ts.food_rate, notes: it.notes || null,
    });
  }
  return out;
}

async function insertItems(db, hotelId, orderId, priced) {
  const rows = [];
  for (const p of priced) {
    rows.push(await db.one(
      `INSERT INTO order_items (hotel_id, order_id, menu_item_id, station_id, name, variant, addons, quantity, unit_price_paise, amount_paise, tax_rate, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [hotelId, orderId, p.menu_item_id, p.station_id, p.name, p.variant, JSON.stringify(p.addons), p.quantity, p.unit_price_paise,
        p.amount_paise, p.tax_rate, p.notes]));
  }
  return rows;
}

/** Recompute order totals. Discount is spread proportionally so tax is charged on the discounted value. */
export async function recalcOrder(db, orderId) {
  const o = await db.one('SELECT * FROM orders WHERE id = $1', [orderId]);
  const items = await db.many(`SELECT * FROM order_items WHERE order_id = $1 AND NOT cancelled AND NOT complimentary`, [orderId]);
  const subtotal = items.reduce((a, i) => a + i.amount_paise, 0);
  const discount = Math.min(o.discount_paise, subtotal);
  const factor = subtotal ? (subtotal - discount) / subtotal : 0;
  const tax = items.reduce((a, i) => a + taxOn(Math.round(i.amount_paise * factor), i.tax_rate), 0);
  return db.one(`UPDATE orders SET subtotal_paise = $1, discount_paise = $2, tax_paise = $3, total_paise = $4 WHERE id = $5 RETURNING *`,
    [subtotal, discount, tax, subtotal - discount + tax, orderId]);
}

/** Create KOTs (one per kitchen station) for items not yet on a ticket. */
export async function generateKots(db, hotelId, orderId) {
  const pending = await db.many(`SELECT * FROM order_items WHERE order_id = $1 AND kot_id IS NULL AND NOT cancelled`, [orderId]);
  const byStation = new Map();
  for (const i of pending) {
    const k = i.station_id ?? 0;
    if (!byStation.has(k)) byStation.set(k, []);
    byStation.get(k).push(i);
  }
  const kots = [];
  for (const [stationId, items] of byStation) {
    const kot = await db.one(`INSERT INTO kots (hotel_id, order_id, station_id, kot_no) VALUES ($1,$2,$3,$4) RETURNING *`,
      [hotelId, orderId, stationId || null, await nextKotNo(db, hotelId)]);
    await db.query(`UPDATE order_items SET kot_id = $1 WHERE id = ANY($2)`, [kot.id, items.map((i) => i.id)]);
    kots.push(kot);
  }
  return kots;
}

/** Find the active (checked-in) stay for a room, with its folio. */
export async function activeStayForRoom(db, hotelId, roomId) {
  return db.one(
    `SELECT s.*, f.id AS folio_id, r.number AS room_number FROM stays s JOIN folios f ON f.stay_id = s.id JOIN rooms r ON r.id = s.room_id
      WHERE s.hotel_id = $1 AND s.room_id = $2 AND s.status = 'checked_in' LIMIT 1`, [hotelId, roomId]);
}

export async function createOrder(db, { hotel, userId = null, source = 'staff', input }) {
  if (input.order_type === 'room_service' && !input.room_id) throw badRequest('Room is required for room service');
  let stay = null;
  if (input.room_id) {
    stay = await activeStayForRoom(db, hotel.id, input.room_id);
    if (!stay && input.order_type === 'room_service') throw conflict('No guest is checked in to this room');
  }
  const priced = await priceItems(db, hotel, input.items, { qr: source === 'guest_qr' });
  // Guest QR orders go straight to the kitchen unless the hotel has opted in to staff acceptance.
  const autoAccept = source === 'staff' || hotel.settings?.qr_orders_require_accept !== true;
  if (source === 'guest_qr') {
    const folio = await db.one('SELECT status FROM folios WHERE id = $1', [stay.folio_id]);
    if (folio?.status !== 'open') throw conflict('Your room bill is closed. Please contact reception to order.');
  }
  const order = await db.one(
    `INSERT INTO orders (hotel_id, order_no, order_type, source, table_label, room_id, stay_id, customer_name, customer_phone, notes, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [hotel.id, await nextOrderNo(db, hotel.id), input.order_type, source, input.table_label || null, input.room_id || null, stay?.id || null,
      input.customer_name || null, input.customer_phone || null, input.notes || null, autoAccept ? 'accepted' : 'received', userId]);
  await insertItems(db, hotel.id, order.id, priced);
  if (autoAccept) await generateKots(db, hotel.id, order.id);
  const out = await recalcOrder(db, order.id);
  // A guest's own order is charged to the room at once: nobody at the front desk has to do anything,
  // and it is on the bill at checkout. Cancelling the order (front desk only) takes the charge off again.
  if (autoAccept && source === 'guest_qr') return postToRoom(db, { hotel, userId }, out, stay);
  return out;
}

/** Charge an order to the room bill of a checked-in stay. */
async function postToRoom(db, ctx, order, stay) {
  await postOrderLines(db, ctx, order, stay.folio_id);
  return db.one(`UPDATE orders SET settlement = 'room_posted', folio_id = $1, stay_id = $2, room_id = $3 WHERE id = $4 RETURNING *`,
    [stay.folio_id, stay.id, stay.room_id, order.id]);
}

async function loadOrder(db, hotelId, id) {
  const o = await db.one(
    `SELECT o.*, r.number AS room_number, g.full_name AS guest_name, u.name AS created_by_name
       FROM orders o LEFT JOIN rooms r ON r.id = o.room_id LEFT JOIN stays s ON s.id = o.stay_id
       LEFT JOIN guests g ON g.id = s.guest_id LEFT JOIN users u ON u.id = o.created_by
      WHERE o.id = $1 AND o.hotel_id = $2`, [id, hotelId]);
  if (!o) return null;
  o.items = await db.many(`SELECT * FROM order_items WHERE order_id = $1 ORDER BY id`, [id]);
  o.kots = await db.many(`SELECT k.*, st.name AS station_name FROM kots k LEFT JOIN stations st ON st.id = k.station_id WHERE order_id = $1 ORDER BY id`, [id]);
  return o;
}

// ===============================================================
// Orders API
// ===============================================================
const orderInput = z.object({
  order_type: z.enum(['dine_in', 'takeaway', 'room_service']),
  table_label: z.string().optional().nullable(),
  room_id: z.number().int().optional().nullable(),
  customer_name: z.string().optional().nullable(),
  customer_phone: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  items: z.array(orderItemInput).min(1),
});

r.get('/orders', requirePerm('pos.order', 'kitchen.view', 'reports.view'), async (req, res) => {
  const { status, active, date } = req.query;
  const vals = [req.hotelId];
  const conds = ['o.hotel_id = $1'];
  if (status) { vals.push(status); conds.push(`o.status = $${vals.length}`); }
  if (active) conds.push(`(o.status NOT IN ('delivered','cancelled') OR o.settlement = 'unsettled') AND o.status <> 'cancelled'`);
  if (date) { vals.push(date); conds.push(`(o.created_at AT TIME ZONE '${req.hotel.timezone.replace(/'/g, '')}')::date = $${vals.length}`); }
  const rows = await many(
    `SELECT o.*, r.number AS room_number,
            (SELECT json_agg(json_build_object('name', i.name, 'variant', i.variant, 'quantity', i.quantity, 'cancelled', i.cancelled) ORDER BY i.id)
               FROM order_items i WHERE i.order_id = o.id) AS items
       FROM orders o LEFT JOIN rooms r ON r.id = o.room_id WHERE ${conds.join(' AND ')} ORDER BY o.id DESC LIMIT 200`, vals);
  res.json(rows);
});

r.get('/orders/:id', requirePerm('pos.order', 'kitchen.view'), async (req, res) => {
  const o = await loadOrder({ one, many }, req.hotelId, idParam(req.params.id));
  if (!o) throw notFound();
  res.json(o);
});

r.post('/orders', requirePerm('pos.order'), async (req, res) => {
  const b = parse(orderInput, req.body);
  const o = await tx(async (db) => {
    const order = await createOrder(db, { hotel: req.hotel, userId: req.user.id, input: b });
    await audit(req, 'order.created', 'order', order.id, { order_no: order.order_no, total_paise: order.total_paise }, db);
    return order;
  });
  res.status(201).json(await loadOrder({ one, many }, req.hotelId, o.id));
});

r.post('/orders/:id/items', requirePerm('pos.order'), async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(z.object({ items: z.array(orderItemInput).min(1) }), req.body);
  await tx(async (db) => {
    const o = await db.one('SELECT * FROM orders WHERE id = $1 AND hotel_id = $2 FOR UPDATE', [id, req.hotelId]);
    if (!o) throw notFound();
    if (o.status === 'cancelled' || o.settlement !== 'unsettled') throw conflict('Order is closed; start a new order');
    await insertItems(db, req.hotelId, id, await priceItems(db, req.hotel, b.items));
    if (o.status !== 'received') {
      await generateKots(db, req.hotelId, id);
      if (['ready', 'delivered', 'out_for_delivery'].includes(o.status)) await db.query(`UPDATE orders SET status = 'preparing', status_changed_at = now() WHERE id = $1`, [id]);
    }
    await recalcOrder(db, id);
    await audit(req, 'order.items_added', 'order', id, { count: b.items.length }, db);
  });
  res.json(await loadOrder({ one, many }, req.hotelId, id));
});

const FLOW = ['received', 'accepted', 'preparing', 'ready', 'out_for_delivery', 'delivered'];
r.patch('/orders/:id/status', requirePerm('pos.order', 'kitchen.view'), async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(z.object({ status: z.enum(['accepted', 'preparing', 'ready', 'out_for_delivery', 'delivered']) }), req.body);
  await tx(async (db) => {
    const o = await db.one('SELECT * FROM orders WHERE id = $1 AND hotel_id = $2 FOR UPDATE', [id, req.hotelId]);
    if (!o) throw notFound();
    if (o.status === 'cancelled') throw conflict('Order is cancelled');
    if (b.status === 'out_for_delivery' && o.order_type !== 'room_service') throw badRequest('Only room-service orders go out for delivery');
    if (FLOW.indexOf(b.status) < FLOW.indexOf(o.status)) throw badRequest(`Order is already ${o.status}`);
    await db.query(`UPDATE orders SET status = $1, status_changed_at = now() WHERE id = $2`, [b.status, id]);
    if (o.status === 'received') {
      await generateKots(db, req.hotelId, id);
      if (o.source === 'guest_qr' && o.settlement === 'unsettled' && o.room_id) {
        const stay = await activeStayForRoom(db, req.hotelId, o.room_id);
        if (stay) await postToRoom(db, { hotel: req.hotel, userId: req.user.id }, await recalcOrder(db, id), stay);
      }
    }
    if (b.status === 'delivered') await db.query(`UPDATE kots SET status = 'delivered' WHERE order_id = $1 AND status <> 'cancelled'`, [id]);
    else if (['ready', 'out_for_delivery'].includes(b.status)) await db.query(`UPDATE kots SET status = 'ready' WHERE order_id = $1 AND status IN ('pending','preparing')`, [id]);
    await audit(req, 'order.status', 'order', id, { from: o.status, to: b.status }, db);
  });
  res.json(await loadOrder({ one, many }, req.hotelId, id));
});

r.post('/orders/:id/cancel', requirePerm('pos.cancel'), async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(z.object({ reason: z.string().min(3) }), req.body);
  await tx(async (db) => {
    const o = await db.one('SELECT * FROM orders WHERE id = $1 AND hotel_id = $2 FOR UPDATE', [id, req.hotelId]);
    if (!o) throw notFound();
    if (o.status === 'cancelled') throw badRequest('Already cancelled');
    if (o.settlement === 'paid') throw conflict('Order is already paid; issue a refund from its bill instead');
    if (o.settlement === 'room_posted') {
      const f = await db.one('SELECT status FROM folios WHERE id = $1', [o.folio_id]);
      if (f?.status === 'closed') throw conflict('The room bill is already invoiced');
      await db.query(`UPDATE folio_lines SET voided_at = now(), voided_by = $1, void_reason = $2
                       WHERE source_type = 'order' AND source_id = $3 AND voided_at IS NULL`, [req.user.id, `Order cancelled: ${b.reason}`, id]);
    }
    await db.query(`UPDATE orders SET status = 'cancelled', cancel_reason = $1, settlement = 'unsettled', status_changed_at = now() WHERE id = $2`, [b.reason, id]);
    await db.query(`UPDATE kots SET status = 'cancelled' WHERE order_id = $1`, [id]);
    await audit(req, 'order.cancelled', 'order', id, { order_no: o.order_no, total_paise: o.total_paise, reason: b.reason, status_was: o.status }, db);
  });
  res.json(await loadOrder({ one, many }, req.hotelId, id));
});

r.post('/orders/:id/items/:itemId/cancel', requirePerm('pos.cancel'), async (req, res) => {
  const id = idParam(req.params.id); const itemId = idParam(req.params.itemId);
  const b = parse(z.object({ reason: z.string().min(3) }), req.body);
  await tx(async (db) => {
    const o = await db.one('SELECT * FROM orders WHERE id = $1 AND hotel_id = $2 FOR UPDATE', [id, req.hotelId]);
    if (!o || !['unsettled', 'room_posted'].includes(o.settlement) || o.status === 'cancelled') throw conflict('Only open orders can be changed');
    if (o.settlement === 'room_posted') {
      const f = await db.one('SELECT status FROM folios WHERE id = $1', [o.folio_id]);
      if (f?.status !== 'open') throw conflict('The room bill is already invoiced');
    }
    const it = await db.one(`UPDATE order_items SET cancelled = TRUE WHERE id = $1 AND order_id = $2 AND NOT cancelled RETURNING *`, [itemId, id]);
    if (!it) throw notFound();
    const updated = await recalcOrder(db, id);
    if (o.settlement === 'room_posted') {
      // Already on the room bill: take the old lines off and charge only what is left.
      await db.query(`UPDATE folio_lines SET voided_at = now(), voided_by = $1, void_reason = $2
                       WHERE source_type = 'order' AND source_id = $3 AND voided_at IS NULL`, [req.user.id, `Item removed (${it.name}): ${b.reason}`, id]);
      await postOrderLines(db, { hotel: req.hotel, userId: req.user.id }, updated, o.folio_id);
    }
    await audit(req, 'order.item_cancelled', 'order', id, { item: it.name, qty: it.quantity, amount_paise: it.amount_paise, reason: b.reason }, db);
  });
  res.json(await loadOrder({ one, many }, req.hotelId, id));
});

r.post('/orders/:id/items/:itemId/complimentary', requirePerm('pos.complimentary'), async (req, res) => {
  const id = idParam(req.params.id); const itemId = idParam(req.params.itemId);
  const b = parse(z.object({ reason: z.string().min(3) }), req.body);
  await tx(async (db) => {
    const o = await db.one('SELECT * FROM orders WHERE id = $1 AND hotel_id = $2 FOR UPDATE', [id, req.hotelId]);
    if (!o || o.settlement !== 'unsettled') throw conflict('Only unsettled orders can be changed');
    const it = await db.one(`UPDATE order_items SET complimentary = TRUE WHERE id = $1 AND order_id = $2 RETURNING *`, [itemId, id]);
    if (!it) throw notFound();
    await recalcOrder(db, id);
    await audit(req, 'order.item_complimentary', 'order', id, { item: it.name, amount_paise: it.amount_paise, reason: b.reason }, db);
  });
  res.json(await loadOrder({ one, many }, req.hotelId, id));
});

r.post('/orders/:id/discount', requirePerm('pos.discount'), async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(z.object({
    amount_paise: z.number().int().min(0).optional(), percent: z.number().min(0).max(100).optional(), reason: z.string().min(2),
  }).refine((x) => x.amount_paise !== undefined || x.percent !== undefined, 'Give an amount or percent'), req.body);
  await tx(async (db) => {
    const o = await db.one('SELECT * FROM orders WHERE id = $1 AND hotel_id = $2 FOR UPDATE', [id, req.hotelId]);
    if (!o || o.settlement !== 'unsettled') throw conflict('Only unsettled orders can be discounted');
    const disc = b.amount_paise ?? Math.round((o.subtotal_paise * b.percent) / 100);
    if (disc > o.subtotal_paise) throw badRequest('Discount exceeds the order value');
    await db.query('UPDATE orders SET discount_paise = $1 WHERE id = $2', [disc, id]);
    await recalcOrder(db, id);
    await audit(req, 'order.discount', 'order', id, {
      amount_paise: disc, percent: o.subtotal_paise ? Math.round((disc / o.subtotal_paise) * 10000) / 100 : 0, reason: b.reason,
    }, db);
  });
  res.json(await loadOrder({ one, many }, req.hotelId, id));
});

/** Post the order's items as folio lines (per item, plus a discount line). */
async function postOrderLines(db, { hotel, userId = null }, order, folioId) {
  const ts = taxSettings(hotel);
  const items = await db.many(`SELECT * FROM order_items WHERE order_id = $1 AND NOT cancelled AND NOT complimentary`, [order.id]);
  const today = hotelToday(hotel.timezone);
  const category = order.order_type === 'room_service' ? 'room_service' : 'food';
  for (const i of items) {
    await db.query(
      `INSERT INTO folio_lines (hotel_id, folio_id, category, description, hsn_sac, quantity, unit_price_paise, amount_paise, tax_rate, tax_paise,
                                business_date, source_type, source_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'order',$12,$13)`,
      [hotel.id, folioId, category, `${i.name}${i.variant ? ` (${i.variant})` : ''} — ${order.order_no}`, ts.food_sac, i.quantity,
        i.unit_price_paise, i.amount_paise, i.tax_rate, taxOn(i.amount_paise, i.tax_rate), today, order.id, userId]);
  }
  if (order.discount_paise > 0 && order.subtotal_paise > 0) {
    // One discount line per GST rate (never a blended rate), each carrying exactly the tax the order saved on those items.
    const factor = (order.subtotal_paise - order.discount_paise) / order.subtotal_paise;
    const groups = new Map();
    for (const i of items) {
      const k = Number(i.tax_rate);
      const g = groups.get(k) || { rate: k, amount: 0, taxDiff: 0 };
      g.amount += i.amount_paise;
      g.taxDiff += taxOn(Math.round(i.amount_paise * factor), i.tax_rate) - taxOn(i.amount_paise, i.tax_rate);
      groups.set(k, g);
    }
    const list = [...groups.values()];
    const base = list.reduce((a, g) => a + g.amount, 0);
    for (const g of list) g.share = Math.floor((order.discount_paise * g.amount) / base);
    let left = order.discount_paise - list.reduce((a, g) => a + g.share, 0);
    for (const g of [...list].sort((a, c) => c.amount - a.amount)) { if (left <= 0) break; g.share += 1; left -= 1; }
    for (const g of list.filter((x) => x.share > 0)) {
      await db.query(
        `INSERT INTO folio_lines (hotel_id, folio_id, category, description, quantity, unit_price_paise, amount_paise, tax_rate, tax_paise,
                                  business_date, source_type, source_id, created_by)
         VALUES ($1,$2,'discount',$3,1,$4,$4,$5,$6,$7,'order',$8,$9)`,
        [hotel.id, folioId, `Discount — ${order.order_no}${list.length > 1 ? ` (${g.rate}% items)` : ''}`, -g.share, g.rate, g.taxDiff, today, order.id, userId]);
    }
  }
}

r.post('/orders/:id/settle', requirePerm('pos.settle'), async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(z.object({
    mode: z.enum(['room', 'pay', 'complimentary']),
    room_id: z.number().int().optional(),          // for dine-in by an in-house guest
    payments: z.array(z.object({
      method: z.enum(['cash', 'card', 'upi', 'online', 'bank_transfer', 'other']), amount_paise: z.number().int().positive(), reference: z.string().optional().nullable(),
    })).default([]),
    reason: z.string().optional(),
    bill_to_gstin: z.string().optional().nullable(),
  }), req.body);
  const result = await tx(async (db) => {
    let o = await db.one('SELECT * FROM orders WHERE id = $1 AND hotel_id = $2 FOR UPDATE', [id, req.hotelId]);
    if (!o) throw notFound();
    if (o.status === 'cancelled') throw conflict('Order is cancelled');
    if (o.settlement !== 'unsettled') throw conflict(`Order is already ${o.settlement.replace('_', ' ')}`);
    o = await recalcOrder(db, id);
    if (b.mode === 'complimentary') {
      assertPerm(req, 'pos.complimentary');
      if (!b.reason) throw badRequest('Reason is required for a complimentary order');
      await db.query(`UPDATE orders SET settlement = 'complimentary' WHERE id = $1`, [id]);
      await audit(req, 'order.complimentary', 'order', id, { total_paise: o.total_paise, reason: b.reason }, db);
      return { settlement: 'complimentary' };
    }
    if (b.mode === 'room') {
      const roomId = b.room_id || o.room_id;
      if (!roomId) throw badRequest('Choose the room to charge');
      const stay = await activeStayForRoom(db, req.hotelId, roomId);
      if (!stay) throw conflict('No guest is checked in to that room — cannot post to room');
      const folio = await db.one('SELECT status FROM folios WHERE id = $1', [stay.folio_id]);
      if (folio.status !== 'open') throw conflict('Room bill is closed');
      await postOrderLines(db, { hotel: req.hotel, userId: req.user.id }, o, stay.folio_id);
      await db.query(`UPDATE orders SET settlement = 'room_posted', folio_id = $1, stay_id = $2, room_id = $3 WHERE id = $4`, [stay.folio_id, stay.id, roomId, id]);
      await audit(req, 'order.posted_to_room', 'order', id, { room: stay.room_number, folio_id: stay.folio_id, total_paise: o.total_paise }, db);
      return { settlement: 'room_posted', folio_id: stay.folio_id };
    }
    // Pay now: walk-in restaurant bill, supports split payment
    const paid = b.payments.reduce((a, p) => a + p.amount_paise, 0);
    if (paid !== o.total_paise) throw badRequest(`Payments (₹${(paid / 100).toFixed(2)}) must equal the bill total (₹${(o.total_paise / 100).toFixed(2)})`);
    const folio = await db.one(
      `INSERT INTO folios (hotel_id, kind, bill_to_name, bill_to_gstin) VALUES ($1,'restaurant',$2,$3) RETURNING id`,
      [req.hotelId, o.customer_name, b.bill_to_gstin || null]);
    await postOrderLines(db, { hotel: req.hotel, userId: req.user.id }, o, folio.id);
    for (const p of b.payments) {
      await db.query(`INSERT INTO payments (hotel_id, folio_id, kind, method, amount_paise, reference, received_by) VALUES ($1,$2,'payment',$3,$4,$5,$6)`,
        [req.hotelId, folio.id, p.method, p.amount_paise, p.reference || null, req.user.id]);
    }
    const invoiceNo = o.total_paise > 0 ? await nextInvoiceNo(db, req.hotelId) : null;
    await db.query(`UPDATE folios SET status = 'closed', invoice_no = $1, invoiced_at = now(), closed_by = $2 WHERE id = $3`, [invoiceNo, req.user.id, folio.id]);
    await db.query(`UPDATE orders SET settlement = 'paid', folio_id = $1 WHERE id = $2`, [folio.id, id]);
    await audit(req, 'order.paid', 'order', id, { folio_id: folio.id, invoice_no: invoiceNo, payments: b.payments }, db);
    return { settlement: 'paid', folio_id: folio.id, invoice_no: invoiceNo };
  });
  res.json({ ...result, order: await loadOrder({ one, many }, req.hotelId, id) });
});

// ===============================================================
// Kitchen display / KOT
// ===============================================================
r.get('/kitchen/kots', requirePerm('kitchen.view'), async (req, res) => {
  const vals = [req.hotelId];
  let stationCond = '';
  if (req.query.station_id) { vals.push(req.query.station_id); stationCond = `AND k.station_id = $${vals.length}`; }
  const kots = await many(
    `SELECT k.*, st.name AS station_name, o.order_no, o.order_type, o.table_label, o.notes AS order_notes, o.status AS order_status,
            r.number AS room_number,
            (SELECT json_agg(json_build_object('id', i.id, 'name', i.name, 'variant', i.variant, 'addons', i.addons, 'quantity', i.quantity,
                                               'notes', i.notes, 'cancelled', i.cancelled) ORDER BY i.id)
               FROM order_items i WHERE i.kot_id = k.id) AS items
       FROM kots k JOIN orders o ON o.id = k.order_id LEFT JOIN stations st ON st.id = k.station_id LEFT JOIN rooms r ON r.id = o.room_id
      WHERE k.hotel_id = $1 AND k.status IN ('pending','preparing','ready') AND o.status <> 'cancelled' ${stationCond}
      ORDER BY k.created_at`, vals);
  // Guest QR orders waiting for staff acceptance
  const awaiting = await many(
    `SELECT o.id, o.order_no, o.order_type, o.created_at, r.number AS room_number, o.total_paise,
            (SELECT json_agg(json_build_object('name', i.name, 'variant', i.variant, 'quantity', i.quantity, 'notes', i.notes)) FROM order_items i WHERE i.order_id = o.id) AS items
       FROM orders o LEFT JOIN rooms r ON r.id = o.room_id WHERE o.hotel_id = $1 AND o.status = 'received' ORDER BY o.created_at`, [req.hotelId]);
  // Tickets the front desk cancelled in the last 15 minutes, so the kitchen knows to stop.
  const cancelled = await many(
    `SELECT k.id, k.kot_no, o.order_no, o.order_type, o.table_label, o.cancel_reason, r.number AS room_number,
            (SELECT json_agg(json_build_object('name', i.name, 'quantity', i.quantity) ORDER BY i.id) FROM order_items i WHERE i.kot_id = k.id) AS items
       FROM kots k JOIN orders o ON o.id = k.order_id LEFT JOIN rooms r ON r.id = o.room_id
      WHERE k.hotel_id = $1 AND k.status = 'cancelled' AND o.status = 'cancelled' AND o.status_changed_at > now() - interval '15 minutes'
      ORDER BY o.status_changed_at DESC`, [req.hotelId]);
  res.json({ kots, awaiting_acceptance: awaiting, cancelled });
});

r.patch('/kots/:id', requirePerm('kitchen.view'), async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(z.object({ status: z.enum(['preparing', 'ready', 'delivered']).optional(), printed: z.boolean().optional() }), req.body);
  const kot = await tx(async (db) => {
    const k = await db.one(`SELECT * FROM kots WHERE id = $1 AND hotel_id = $2 FOR UPDATE`, [id, req.hotelId]);
    if (!k) throw notFound();
    if (b.printed) await db.query(`UPDATE kots SET printed_at = now() WHERE id = $1`, [id]);
    if (b.status) {
      if (k.status === 'cancelled') throw conflict('This order was cancelled by the front desk');
      await db.query(`UPDATE kots SET status = $1 WHERE id = $2`, [b.status, id]);
      const o = await db.one('SELECT status FROM orders WHERE id = $1', [k.order_id]);
      if (b.status === 'delivered') {
        // The order is delivered once every station's ticket is.
        const open = await db.one(`SELECT count(*)::int AS n FROM kots WHERE order_id = $1 AND status IN ('pending','preparing','ready')`, [k.order_id]);
        if (!open.n && !['delivered', 'cancelled'].includes(o.status)) {
          await db.query(`UPDATE orders SET status = 'delivered', status_changed_at = now() WHERE id = $1`, [k.order_id]);
          await audit(req, 'order.status', 'order', k.order_id, { from: o.status, to: 'delivered', by: 'kitchen' }, db);
        }
      }
      if (b.status === 'preparing' && o.status === 'accepted') {
        await db.query(`UPDATE orders SET status = 'preparing', status_changed_at = now() WHERE id = $1`, [k.order_id]);
      }
      if (b.status === 'ready') {
        const open = await db.one(`SELECT count(*)::int AS n FROM kots WHERE order_id = $1 AND status IN ('pending','preparing')`, [k.order_id]);
        if (!open.n && ['accepted', 'preparing'].includes(o.status)) {
          await db.query(`UPDATE orders SET status = 'ready', status_changed_at = now() WHERE id = $1`, [k.order_id]);
        }
      }
    }
    return db.one('SELECT * FROM kots WHERE id = $1', [id]);
  });
  res.json(kot);
});

// Plain-text KOT for 58/80mm thermal printers (browser print or ESC/POS bridge)
r.get('/kots/:id/print', requirePerm('kitchen.view', 'pos.order'), async (req, res) => {
  const id = idParam(req.params.id);
  const k = await one(
    `SELECT k.*, st.name AS station_name, o.order_no, o.order_type, o.table_label, o.notes, r.number AS room_number
       FROM kots k JOIN orders o ON o.id = k.order_id LEFT JOIN stations st ON st.id = k.station_id LEFT JOIN rooms r ON r.id = o.room_id
      WHERE k.id = $1 AND k.hotel_id = $2`, [id, req.hotelId]);
  if (!k) throw notFound();
  const items = await many(`SELECT * FROM order_items WHERE kot_id = $1 AND NOT cancelled ORDER BY id`, [id]);
  const where = k.order_type === 'room_service' ? `ROOM ${k.room_number}` : k.order_type === 'dine_in' ? `TABLE ${k.table_label || '-'}` : 'TAKEAWAY';
  const time = new Date(k.created_at).toLocaleTimeString('en-IN', { timeZone: req.hotel.timezone, hour: '2-digit', minute: '2-digit' });
  if (req.query.format === 'escpos') {
    // Raw printer bytes for a USB thermal printer connected to the kitchen screen.
    const width = Number(req.query.width) === 48 ? 48 : 32;
    const bytes = kotEscpos({ kot_no: k.kot_no, order_no: k.order_no, where, time, station: k.station_name, items, notes: k.notes },
      { width, beep: req.query.beep === '1' });
    return res.type('application/octet-stream').send(bytes);
  }
  const lines = [
    `KOT ${k.kot_no}  ${k.station_name ? `[${k.station_name}]` : ''}`.trim(), `${where}   ${k.order_no}   ${time}`, '-'.repeat(32),
    ...items.flatMap((i) => [
      `${String(i.quantity).padStart(2)} x ${i.name}${i.variant ? ` (${i.variant})` : ''}`,
      ...(i.addons?.length ? [`     + ${i.addons.map((a) => a.name).join(', ')}`] : []),
      ...(i.notes ? [`     * ${i.notes}`] : []),
    ]),
    '-'.repeat(32), ...(k.notes ? [`NOTE: ${k.notes}`] : []),
  ];
  res.type('text/plain').send(lines.join('\n'));
});

export default r;
