// Owner dashboard, reports, rule-based alerts, daily summary and night audit
import { Router } from 'express';
import { z } from 'zod';
import { one, many, tx } from '../db.js';
import { parse } from '../lib/validate.js';
import { requireStaff, requirePerm, can } from '../middleware/auth.js';
import { badRequest } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { hotelToday, addDays, DATE_RE, nightsBetween } from '../lib/dates.js';
import { postRoomNights } from '../lib/folio.js';

const r = Router();
r.use(['/reports', '/alerts', '/summary', '/night-audit'], requireStaff);

const tzSql = (req) => `'${req.hotel.timezone.replace(/'/g, '')}'`;

function range(req) {
  const today = hotelToday(req.hotel.timezone);
  const from = req.query.from ? parse(z.string().regex(DATE_RE), req.query.from) : addDays(today, -6);
  const to = req.query.to ? parse(z.string().regex(DATE_RE), req.query.to) : today;
  if (to < from) throw badRequest('Invalid date range');
  if (nightsBetween(from, to) > 366) throw badRequest('Range too large (max 1 year)');
  return { from, to, today };
}

function sendCsv(res, name, rows) {
  if (!rows.length) return res.type('text/csv').send('');
  const cols = Object.keys(rows[0]);
  const esc = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
  res.type('text/csv').send([cols.join(','), ...rows.map((x) => cols.map((c) => esc(x[c])).join(','))].join('\n'));
}
const out = (req, res, name, rows) => (req.query.format === 'csv' ? sendCsv(res, name, rows) : res.json(rows));

// ---------------------------------------------------------------
// Owner dashboard
// ---------------------------------------------------------------
async function dashboardData(req) {
  const today = hotelToday(req.hotel.timezone);
  const monthStart = today.slice(0, 8) + '01';
  const h = req.hotelId;
  const [rooms, occ, arrivals, departures, revToday, revMonth, collToday, outstanding, inHouseBal, food, hk, maint, refunds] = await Promise.all([
    one(`SELECT count(*) FILTER (WHERE active)::int AS total, count(*) FILTER (WHERE active AND hk_status = 'out_of_order')::int AS ooo,
                count(*) FILTER (WHERE active AND hk_status = 'dirty')::int AS dirty FROM rooms WHERE hotel_id = $1`, [h]),
    one(`SELECT count(*)::int AS n FROM stays WHERE hotel_id = $1 AND status = 'checked_in'`, [h]),
    // Arrivals: checked in today (by the actual check-in time) of those expected (checked in today + still waiting, incl. overdue).
    one(`SELECT count(*) FILTER (WHERE status = 'reserved' AND check_in_date <= $2)::int AS pending,
                count(*) FILTER (WHERE status IN ('checked_in','checked_out') AND (checked_in_at AT TIME ZONE ${tzSql(req)})::date = $2)::int AS done
           FROM stays WHERE hotel_id = $1`, [h, today]),
    one(`SELECT count(*) FILTER (WHERE status = 'checked_in' AND check_out_date <= $2)::int AS pending,
                count(*) FILTER (WHERE status = 'checked_out' AND (checked_out_at AT TIME ZONE ${tzSql(req)})::date = $2)::int AS done
           FROM stays WHERE hotel_id = $1`, [h, today]),
    one(`SELECT COALESCE(SUM(amount_paise) FILTER (WHERE category IN ('room','extra_person')),0) AS room,
                COALESCE(SUM(amount_paise) FILTER (WHERE category IN ('food','room_service')),0) AS food,
                COALESCE(SUM(amount_paise) FILTER (WHERE category IN ('service','extra')),0) AS other,
                COALESCE(SUM(amount_paise) FILTER (WHERE category = 'discount'),0) AS discount
           FROM folio_lines WHERE hotel_id = $1 AND business_date = $2 AND voided_at IS NULL`, [h, today]),
    one(`SELECT COALESCE(SUM(amount_paise) FILTER (WHERE category IN ('room','extra_person')),0) AS room,
                COALESCE(SUM(amount_paise) FILTER (WHERE category IN ('food','room_service')),0) AS food,
                COALESCE(SUM(amount_paise),0) AS total
           FROM folio_lines WHERE hotel_id = $1 AND business_date BETWEEN $2 AND $3 AND voided_at IS NULL`, [h, monthStart, today]),
    many(`SELECT method, SUM(CASE WHEN kind = 'refund' THEN -amount_paise ELSE amount_paise END) AS amount_paise
            FROM payments WHERE hotel_id = $1 AND voided_at IS NULL AND (created_at AT TIME ZONE ${tzSql(req)})::date = $2 GROUP BY method`, [h, today]),
    one(`SELECT COALESCE(SUM(bal),0) AS amount_paise, count(*) FILTER (WHERE bal > 0)::int AS folios FROM (
           SELECT COALESCE((SELECT SUM(amount_paise + tax_paise) FROM folio_lines l WHERE l.folio_id = f.id AND l.voided_at IS NULL),0)
                - COALESCE((SELECT SUM(CASE WHEN kind = 'refund' THEN -amount_paise ELSE amount_paise END) FROM payments p WHERE p.folio_id = f.id AND p.voided_at IS NULL),0) AS bal
             FROM folios f LEFT JOIN stays s ON s.id = f.stay_id
            WHERE f.hotel_id = $1 AND (s.status IN ('checked_out','no_show','cancelled') OR f.kind = 'restaurant')) x WHERE bal > 0`, [h]),
    one(`SELECT COALESCE(SUM(bal),0) AS amount_paise FROM (
           SELECT COALESCE((SELECT SUM(amount_paise + tax_paise) FROM folio_lines l WHERE l.folio_id = f.id AND l.voided_at IS NULL),0)
                - COALESCE((SELECT SUM(CASE WHEN kind = 'refund' THEN -amount_paise ELSE amount_paise END) FROM payments p WHERE p.folio_id = f.id AND p.voided_at IS NULL),0) AS bal
             FROM folios f JOIN stays s ON s.id = f.stay_id WHERE f.hotel_id = $1 AND s.status = 'checked_in') x`, [h]),
    one(`SELECT count(*) FILTER (WHERE status <> 'cancelled')::int AS orders, count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
                count(*) FILTER (WHERE status NOT IN ('delivered','cancelled'))::int AS active
           FROM orders WHERE hotel_id = $1 AND (created_at AT TIME ZONE ${tzSql(req)})::date = $2`, [h, today]),
    one(`SELECT count(*) FILTER (WHERE status IN ('pending','in_progress'))::int AS pending,
                count(*) FILTER (WHERE status = 'done' AND completed_at > now() - interval '24 hours')::int AS done_24h FROM hk_tasks WHERE hotel_id = $1`, [h]),
    one(`SELECT count(*) FILTER (WHERE status IN ('open','in_progress'))::int AS open,
                count(*) FILTER (WHERE status IN ('open','in_progress') AND priority IN ('high','urgent'))::int AS urgent FROM maintenance_requests WHERE hotel_id = $1`, [h]),
    one(`SELECT COALESCE(SUM(amount_paise),0) AS amount_paise, count(*)::int AS n FROM payments
          WHERE hotel_id = $1 AND kind = 'refund' AND voided_at IS NULL AND (created_at AT TIME ZONE ${tzSql(req)})::date = $2`, [h, today]),
  ]);
  const sellable = rooms.total - rooms.ooo;
  const financial = can(req, 'reports.financial');
  return {
    today,
    rooms: { total: rooms.total, out_of_order: rooms.ooo, dirty: rooms.dirty, occupied: occ.n, available: Math.max(0, sellable - occ.n),
      occupancy_pct: sellable ? Math.round((occ.n / sellable) * 1000) / 10 : 0 },
    arrivals, departures,
    revenue_today: financial ? revToday : undefined,
    revenue_month: financial ? revMonth : undefined,
    collections_today: financial ? collToday : undefined,
    outstanding: financial ? outstanding : undefined,
    in_house_balance: financial ? inHouseBal : undefined,
    refunds_today: financial ? refunds : undefined,
    restaurant_today: food, housekeeping: hk, maintenance: maint,
  };
}

r.get('/reports/dashboard', requirePerm('reports.view'), async (req, res) => res.json(await dashboardData(req)));

// Daily performance: occupancy, ADR, RevPAR, revenue split, collections
r.get('/reports/daily', requirePerm('reports.financial'), async (req, res) => {
  const { from, to } = range(req);
  const rows = await many(
    `WITH days AS (SELECT d::date AS day FROM generate_series($2::date, $3::date, '1 day') d),
          rooms AS (SELECT count(*)::int AS n FROM rooms WHERE hotel_id = $1 AND active AND hk_status <> 'out_of_order'),
          occ AS (SELECT d.day, count(s.id)::int AS occupied FROM days d LEFT JOIN stays s ON s.hotel_id = $1
                    AND s.status IN ('checked_in','checked_out') AND s.check_in_date <= d.day AND s.check_out_date > d.day GROUP BY d.day),
          rev AS (SELECT business_date AS day,
                         SUM(amount_paise) FILTER (WHERE category IN ('room','extra_person')) AS room,
                         SUM(amount_paise) FILTER (WHERE category IN ('food','room_service')) AS food,
                         SUM(amount_paise) FILTER (WHERE category IN ('service','extra')) AS other,
                         SUM(amount_paise) FILTER (WHERE category = 'discount') AS discount,
                         SUM(tax_paise) AS tax
                    FROM folio_lines WHERE hotel_id = $1 AND voided_at IS NULL AND business_date BETWEEN $2 AND $3 GROUP BY business_date),
          col AS (SELECT (created_at AT TIME ZONE ${tzSql(req)})::date AS day, SUM(CASE WHEN kind = 'refund' THEN -amount_paise ELSE amount_paise END) AS collected
                    FROM payments WHERE hotel_id = $1 AND voided_at IS NULL GROUP BY 1)
     SELECT d.day, (SELECT n FROM rooms) AS rooms, o.occupied,
            ROUND(o.occupied * 100.0 / NULLIF((SELECT n FROM rooms),0), 1) AS occupancy_pct,
            COALESCE(rev.room,0) AS room_revenue_paise, COALESCE(rev.food,0) AS food_revenue_paise, COALESCE(rev.other,0) AS other_revenue_paise,
            COALESCE(rev.discount,0) AS discount_paise, COALESCE(rev.tax,0) AS tax_paise,
            CASE WHEN o.occupied > 0 THEN ROUND(COALESCE(rev.room,0)::numeric / o.occupied) ELSE 0 END AS adr_paise,
            ROUND(COALESCE(rev.room,0)::numeric / NULLIF((SELECT n FROM rooms),0)) AS revpar_paise,
            COALESCE(col.collected,0) AS collected_paise
       FROM days d JOIN occ o ON o.day = d.day LEFT JOIN rev ON rev.day = d.day LEFT JOIN col ON col.day = d.day ORDER BY d.day`,
    [req.hotelId, from, to]);
  out(req, res, `daily-${from}-${to}`, rows);
});

r.get('/reports/revenue-by-room', requirePerm('reports.financial'), async (req, res) => {
  const { from, to } = range(req);
  out(req, res, `room-revenue-${from}-${to}`, await many(
    `SELECT r.number AS room, rt.name AS room_type, count(DISTINCT l.business_date)::int AS nights_sold,
            COALESCE(SUM(l.amount_paise),0) AS room_revenue_paise
       FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id
       LEFT JOIN stays s ON s.room_id = r.id
       LEFT JOIN folio_lines l ON l.source_type = 'stay_night' AND l.source_id = s.id AND l.voided_at IS NULL AND l.business_date BETWEEN $2 AND $3
      WHERE r.hotel_id = $1 AND r.active GROUP BY r.id, rt.name ORDER BY room_revenue_paise DESC`, [req.hotelId, from, to]));
});

r.get('/reports/revenue-by-department', requirePerm('reports.financial'), async (req, res) => {
  const { from, to } = range(req);
  out(req, res, `department-revenue-${from}-${to}`, await many(
    `SELECT category, SUM(amount_paise) AS amount_paise, SUM(tax_paise) AS tax_paise, count(*)::int AS lines
       FROM folio_lines WHERE hotel_id = $1 AND voided_at IS NULL AND business_date BETWEEN $2 AND $3 GROUP BY category ORDER BY amount_paise DESC`,
    [req.hotelId, from, to]));
});

r.get('/reports/collections', requirePerm('reports.financial'), async (req, res) => {
  const { from, to } = range(req);
  out(req, res, `collections-${from}-${to}`, await many(
    `SELECT p.id, p.created_at AS received_at, p.kind, p.method, p.amount_paise, p.reference,
            f.kind AS bill_type, f.invoice_no, g.full_name AS guest, b.ref AS booking_ref, u.name AS received_by, p.voided_at, p.void_reason
       FROM payments p JOIN folios f ON f.id = p.folio_id LEFT JOIN guests g ON g.id = f.guest_id LEFT JOIN bookings b ON b.id = f.booking_id
       LEFT JOIN users u ON u.id = p.received_by
      WHERE p.hotel_id = $1 AND (p.created_at AT TIME ZONE ${tzSql(req)})::date BETWEEN $2 AND $3 ORDER BY p.created_at`, [req.hotelId, from, to]));
});

r.get('/reports/outstanding', requirePerm('reports.financial'), async (req, res) => {
  out(req, res, 'outstanding', await many(
    `SELECT * FROM (
       SELECT f.id AS folio_id, f.kind, g.full_name AS guest, g.phone, b.ref AS booking_ref, r.number AS room, s.status AS stay_status, s.check_out_date,
              COALESCE((SELECT SUM(amount_paise + tax_paise) FROM folio_lines l WHERE l.folio_id = f.id AND l.voided_at IS NULL),0)
            - COALESCE((SELECT SUM(CASE WHEN kind = 'refund' THEN -amount_paise ELSE amount_paise END) FROM payments p WHERE p.folio_id = f.id AND p.voided_at IS NULL),0) AS balance_paise
         FROM folios f LEFT JOIN guests g ON g.id = f.guest_id LEFT JOIN bookings b ON b.id = f.booking_id
         LEFT JOIN stays s ON s.id = f.stay_id LEFT JOIN rooms r ON r.id = s.room_id
        WHERE f.hotel_id = $1 AND (s.status IN ('checked_in','checked_out','no_show','cancelled') OR f.kind = 'restaurant')) x
      WHERE balance_paise <> 0 ORDER BY balance_paise DESC`, [req.hotelId]));
});

r.get('/reports/food-sales', requirePerm('reports.view'), async (req, res) => {
  const { from, to } = range(req);
  const tz = tzSql(req);
  const [items, byType, cancelled] = await Promise.all([
    many(`SELECT i.name, SUM(i.quantity)::int AS qty, SUM(i.amount_paise) AS amount_paise
            FROM order_items i JOIN orders o ON o.id = i.order_id
           WHERE o.hotel_id = $1 AND o.status <> 'cancelled' AND NOT i.cancelled AND (o.created_at AT TIME ZONE ${tz})::date BETWEEN $2 AND $3
           GROUP BY i.name ORDER BY qty DESC LIMIT 50`, [req.hotelId, from, to]),
    many(`SELECT order_type, settlement, count(*)::int AS orders, SUM(total_paise) AS total_paise
            FROM orders WHERE hotel_id = $1 AND status <> 'cancelled' AND (created_at AT TIME ZONE ${tz})::date BETWEEN $2 AND $3
           GROUP BY order_type, settlement ORDER BY order_type`, [req.hotelId, from, to]),
    many(`SELECT o.order_no, o.total_paise, o.cancel_reason, o.status_changed_at AS cancelled_at
            FROM orders o WHERE o.hotel_id = $1 AND o.status = 'cancelled' AND (o.created_at AT TIME ZONE ${tz})::date BETWEEN $2 AND $3
           ORDER BY o.id DESC`, [req.hotelId, from, to]),
  ]);
  if (req.query.format === 'csv') return sendCsv(res, `food-items-${from}-${to}`, items);
  res.json({ from, to, popular_items: items, by_type: byType, cancelled });
});

r.get('/reports/housekeeping', requirePerm('reports.view'), async (req, res) => {
  const { from, to } = range(req);
  const tz = tzSql(req);
  res.json({
    by_staff: await many(
      `SELECT u.name, count(*)::int AS completed,
              ROUND(AVG(EXTRACT(EPOCH FROM (t.completed_at - COALESCE(t.started_at, t.created_at))) / 60)) AS avg_minutes
         FROM hk_tasks t LEFT JOIN users u ON u.id = t.completed_by
        WHERE t.hotel_id = $1 AND t.status = 'done' AND (t.completed_at AT TIME ZONE ${tz})::date BETWEEN $2 AND $3
        GROUP BY u.name ORDER BY completed DESC`, [req.hotelId, from, to]),
    pending: await many(
      `SELECT t.id, r.number AS room, t.task_type, t.priority, t.created_at, u.name AS assigned
         FROM hk_tasks t JOIN rooms r ON r.id = t.room_id LEFT JOIN users u ON u.id = t.assigned_to
        WHERE t.hotel_id = $1 AND t.status IN ('pending','in_progress') ORDER BY t.created_at`, [req.hotelId]),
    maintenance_backlog: await many(
      `SELECT m.id, r.number AS room, m.title, m.priority, m.status, m.created_at FROM maintenance_requests m LEFT JOIN rooms r ON r.id = m.room_id
        WHERE m.hotel_id = $1 AND m.status IN ('open','in_progress') ORDER BY m.created_at`, [req.hotelId]),
  });
});

// ---------------------------------------------------------------
// Rule-based alerts (advisory; humans decide)
// ---------------------------------------------------------------
export async function computeAlerts(req) {
  const today = hotelToday(req.hotel.timezone);
  const h = req.hotelId;
  const s = req.hotel.settings || {};
  const hkOverdueMin = s.hk_overdue_minutes ?? 90;
  const orderOverdueMin = s.order_overdue_minutes ?? 30;
  const discountPct = s.discount_alert_pct ?? 20;
  const alerts = [];
  const push = (severity, type, message, ref = {}) => alerts.push({ severity, type, message, ...ref });

  const hk = await many(
    `SELECT t.id, r.number, t.priority, t.created_at FROM hk_tasks t JOIN rooms r ON r.id = t.room_id
      WHERE t.hotel_id = $1 AND t.status IN ('pending','in_progress') AND t.created_at < now() - ($2 || ' minutes')::interval`, [h, hkOverdueMin]);
  hk.forEach((t) => push(t.priority === 'urgent' ? 'high' : 'medium', 'hk_overdue', `Housekeeping task for room ${t.number} pending over ${hkOverdueMin} min`, { hk_task_id: t.id }));

  const notReady = await many(
    `SELECT r.number, r.hk_status, g.full_name FROM stays st JOIN rooms r ON r.id = st.room_id JOIN guests g ON g.id = st.guest_id
      WHERE st.hotel_id = $1 AND st.status = 'reserved' AND st.check_in_date = $2 AND r.hk_status NOT IN ('ready','inspected')`, [h, today]);
  notReady.forEach((x) => push('high', 'room_not_ready', `Room ${x.number} is ${x.hk_status.replace('_', ' ')} — ${x.full_name} arrives today`));

  const unalloc = await one(`SELECT count(*)::int AS n FROM stays WHERE hotel_id = $1 AND status = 'reserved' AND check_in_date = $2 AND room_id IS NULL`, [h, today]);
  if (unalloc.n) push('medium', 'unallocated_arrivals', `${unalloc.n} arrival(s) today have no room assigned`);

  const orders = await many(
    `SELECT id, order_no, status, status_changed_at FROM orders WHERE hotel_id = $1 AND status IN ('received','accepted','preparing','ready','out_for_delivery')
        AND status_changed_at < now() - ($2 || ' minutes')::interval`, [h, orderOverdueMin]);
  orders.forEach((o) => push(o.status === 'received' ? 'high' : 'medium', 'order_delayed', `Order ${o.order_no} stuck in "${o.status.replace(/_/g, ' ')}" over ${orderOverdueMin} min`, { order_id: o.id }));

  const unsettled = await many(
    `SELECT id, order_no, total_paise FROM orders WHERE hotel_id = $1 AND status = 'delivered' AND settlement = 'unsettled' AND created_at < now() - interval '2 hours'`, [h]);
  unsettled.forEach((o) => push('high', 'order_unsettled', `Delivered order ${o.order_no} is not billed (₹${(o.total_paise / 100).toFixed(0)})`, { order_id: o.id }));

  // Missing room charges: in-house stays with past nights not posted
  const missing = await many(
    `SELECT st.id, r.number FROM stays st JOIN rooms r ON r.id = st.room_id
      WHERE st.hotel_id = $1 AND st.status = 'checked_in' AND EXISTS (
        SELECT 1 FROM generate_series(st.check_in_date, LEAST($2::date, st.check_out_date - 1), '1 day') d
         WHERE NOT EXISTS (SELECT 1 FROM folio_lines l WHERE l.source_type = 'stay_night' AND l.source_id = st.id AND l.business_date = d::date AND l.voided_at IS NULL))`,
    [h, today]);
  missing.forEach((m) => push('high', 'missing_room_charge', `Room ${m.number}: room-night charges missing — run night audit`, { stay_id: m.id }));

  const due = await many(
    `SELECT st.id, r.number, g.full_name FROM stays st JOIN rooms r ON r.id = st.room_id JOIN guests g ON g.id = st.guest_id
      WHERE st.hotel_id = $1 AND st.status = 'checked_in' AND st.check_out_date < $2`, [h, today]);
  due.forEach((d) => push('high', 'overstay', `Room ${d.number} (${d.full_name}) is past check-out date`, { stay_id: d.id }));

  const unpaid = await many(
    `SELECT * FROM (SELECT f.id, g.full_name, r.number,
            COALESCE((SELECT SUM(amount_paise + tax_paise) FROM folio_lines l WHERE l.folio_id = f.id AND l.voided_at IS NULL),0)
          - COALESCE((SELECT SUM(CASE WHEN kind = 'refund' THEN -amount_paise ELSE amount_paise END) FROM payments p WHERE p.folio_id = f.id AND p.voided_at IS NULL),0) AS bal
       FROM folios f JOIN stays st ON st.id = f.stay_id LEFT JOIN guests g ON g.id = f.guest_id LEFT JOIN rooms r ON r.id = st.room_id
      WHERE f.hotel_id = $1 AND st.status = 'checked_out') x WHERE bal > 0`, [h]);
  unpaid.forEach((u) => push('high', 'unpaid_checkout', `${u.full_name} (room ${u.number}) checked out with ₹${(u.bal / 100).toFixed(0)} unpaid`, { folio_id: u.id }));

  // Financial anomalies for human review (last 24h)
  const anomalies = await many(
    `SELECT a.actor_id, u.name, a.action, count(*)::int AS n, SUM(COALESCE((a.data->>'amount_paise')::bigint,0)) AS amount,
            MAX(COALESCE((a.data->>'percent')::numeric,0)) AS max_pct
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.hotel_id = $1 AND a.created_at > now() - interval '24 hours'
        AND a.action IN ('folio.discount','order.discount','folio.line_voided','payment.voided','payment.refund','order.cancelled','order.complimentary','order.item_complimentary')
      GROUP BY a.actor_id, u.name, a.action`, [h]);
  for (const a of anomalies) {
    const who = a.name || 'Unknown';
    if (a.action.endsWith('discount') && a.max_pct >= discountPct) push('medium', 'high_discount', `${who} gave a ${a.max_pct}% discount (threshold ${discountPct}%)`);
    if (['folio.line_voided', 'payment.voided'].includes(a.action) && a.n >= 3) push('high', 'repeated_voids', `${who} made ${a.n} voids in 24h — review`);
    if (a.action === 'payment.refund' && a.n >= 2) push('medium', 'refunds', `${who} issued ${a.n} refunds (₹${(a.amount / 100).toFixed(0)}) in 24h`);
    if (a.action === 'order.cancelled' && a.n >= 3) push('medium', 'order_cancellations', `${who} cancelled ${a.n} orders in 24h`);
    if (a.action.includes('complimentary') && a.n >= 3) push('medium', 'complimentary', `${who} marked ${a.n} complimentary items/orders in 24h`);
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return alerts.sort((x, y) => rank[x.severity] - rank[y.severity]);
}

r.get('/alerts', requirePerm('reports.view', 'bookings.view'), async (req, res) => {
  let alerts = await computeAlerts(req);
  if (!can(req, 'reports.financial')) alerts = alerts.filter((a) => !['high_discount', 'repeated_voids', 'refunds', 'order_cancellations', 'complimentary'].includes(a.type));
  res.json(alerts);
});

// Daily operational summary (rule-based text; an AI layer can rewrite this later, advisory only)
r.get('/summary/daily', requirePerm('reports.view'), async (req, res) => {
  const d = await dashboardData(req);
  const alerts = await computeAlerts(req);
  const rs = (p) => `₹${Math.round((p || 0) / 100).toLocaleString('en-IN')}`;
  const lines = [
    `${req.hotel.name} — ${d.today}`,
    `Occupancy ${d.rooms.occupancy_pct}% (${d.rooms.occupied}/${d.rooms.total - d.rooms.out_of_order} rooms), ${d.rooms.out_of_order} out of order.`,
    `Arrivals: ${d.arrivals.done} checked in, ${d.arrivals.pending} pending. Departures: ${d.departures.done} done, ${d.departures.pending} pending.`,
  ];
  if (d.revenue_today) {
    const coll = (d.collections_today || []).reduce((a, x) => a + Number(x.amount_paise), 0);
    lines.push(`Revenue today: rooms ${rs(d.revenue_today.room)}, food ${rs(d.revenue_today.food)}, other ${rs(d.revenue_today.other)}. Collected ${rs(coll)}.`);
    lines.push(`Month to date: ${rs(d.revenue_month.total)}. In-house running bills: ${rs(d.in_house_balance.amount_paise)}. Unpaid after checkout: ${rs(d.outstanding.amount_paise)} (${d.outstanding.folios} bill(s)).`);
  }
  lines.push(`Restaurant: ${d.restaurant_today.orders} orders, ${d.restaurant_today.cancelled} cancelled, ${d.restaurant_today.active} in progress.`);
  lines.push(`Housekeeping: ${d.housekeeping.pending} pending tasks. Maintenance: ${d.maintenance.open} open (${d.maintenance.urgent} urgent).`);
  if (alerts.length) lines.push('', `Needs attention (${alerts.length}):`, ...alerts.slice(0, 10).map((a) => `• ${a.message}`));
  res.json({ text: lines.join('\n'), data: d, alerts });
});

// ---------------------------------------------------------------
// Night audit: post room-night charges for all in-house guests up to today
// ---------------------------------------------------------------
r.post('/night-audit', requirePerm('folio.charge'), async (req, res) => {
  const today = hotelToday(req.hotel.timezone);
  const result = await tx(async (db) => {
    const stays = await db.many(
      `SELECT s.*, r.number AS room_number, f.id AS folio_id FROM stays s JOIN rooms r ON r.id = s.room_id JOIN folios f ON f.stay_id = s.id
        WHERE s.hotel_id = $1 AND s.status = 'checked_in' AND f.status = 'open'`, [req.hotelId]);
    let posted = 0;
    for (const s of stays) posted += await postRoomNights(db, req.hotel, s, s.folio_id, today, req.user.id);
    await audit(req, 'night_audit.run', 'hotel', req.hotelId, { business_date: today, stays: stays.length, nights_posted: posted }, db);
    return { business_date: today, stays: stays.length, nights_posted: posted };
  });
  res.json(result);
});

export default r;
