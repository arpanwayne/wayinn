// Housekeeping, maintenance, guest service requests, lost & found
import { Router } from 'express';
import { z } from 'zod';
import { one, many, tx } from '../db.js';
import { parse, idParam } from '../lib/validate.js';
import { requireStaff, requirePerm, can } from '../middleware/auth.js';
import { notFound, badRequest, forbidden } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { roomBoard } from '../lib/rooms.js';
import { hotelToday } from '../lib/dates.js';

const r = Router();
r.use(['/housekeeping', '/maintenance', '/requests', '/lost-found'], requireStaff);

const PRIORITY = ['low', 'normal', 'high', 'urgent'];

// ---------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------
r.get('/housekeeping/board', requirePerm('hk.view'), async (req, res) => {
  const today = hotelToday(req.hotel.timezone);
  const rooms = await roomBoard(req.hotelId, today);
  const tasks = await many(
    `SELECT t.*, r.number AS room_number, u.name AS assigned_name FROM hk_tasks t JOIN rooms r ON r.id = t.room_id
       LEFT JOIN users u ON u.id = t.assigned_to
      WHERE t.hotel_id = $1 AND (t.status IN ('pending','in_progress') OR t.completed_at > now() - interval '12 hours')
        ${can(req, 'hk.manage') ? '' : 'AND (t.assigned_to = $2 OR t.assigned_to IS NULL)'}
      ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.created_at`,
    can(req, 'hk.manage') ? [req.hotelId] : [req.hotelId, req.user.id]);
  const staff = can(req, 'hk.manage')
    ? await many(`SELECT id, name, role FROM users WHERE hotel_id = $1 AND active AND role IN ('housekeeping','maintenance','manager') ORDER BY name`, [req.hotelId])
    : [];
  // Rooms not ready for an arrival today
  const notReady = rooms.filter((x) => x.arriving_stay_id && !['ready', 'inspected'].includes(x.hk_status));
  res.json({ rooms, tasks, staff, alerts: { not_ready_for_arrival: notReady.map((x) => ({ room: x.number, hk_status: x.hk_status, guest: x.arriving_guest })) } });
});

r.post('/housekeeping/tasks', requirePerm('hk.manage'), async (req, res) => {
  const b = parse(z.object({
    room_id: z.number().int(), task_type: z.enum(['cleaning', 'inspection', 'turndown', 'deep_clean', 'request']).default('cleaning'),
    priority: z.enum(PRIORITY).default('normal'), assigned_to: z.number().int().nullable().optional(),
    due_at: z.string().datetime({ offset: true }).nullable().optional(), notes: z.string().nullable().optional(),
  }), req.body);
  const room = await one('SELECT id FROM rooms WHERE id = $1 AND hotel_id = $2', [b.room_id, req.hotelId]);
  if (!room) throw badRequest('Unknown room');
  const t = await one(
    `INSERT INTO hk_tasks (hotel_id, room_id, task_type, priority, assigned_to, due_at, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [req.hotelId, b.room_id, b.task_type, b.priority, b.assigned_to ?? null, b.due_at ?? null, b.notes ?? null, req.user.id]);
  await audit(req, 'hk.task_created', 'hk_task', t.id, { room_id: b.room_id, type: b.task_type });
  res.status(201).json(t);
});

r.patch('/housekeeping/tasks/:id', requirePerm('hk.manage', 'hk.work'), async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(z.object({
    action: z.enum(['assign', 'start', 'complete', 'cancel', 'update']),
    assigned_to: z.number().int().nullable().optional(), priority: z.enum(PRIORITY).optional(), notes: z.string().optional(),
    room_status_after: z.enum(['ready', 'inspected']).optional(), // what to set the room to on completion
  }), req.body);
  const out = await tx(async (db) => {
    const t = await db.one('SELECT * FROM hk_tasks WHERE id = $1 AND hotel_id = $2 FOR UPDATE', [id, req.hotelId]);
    if (!t) throw notFound();
    const manager = can(req, 'hk.manage');
    if (!manager && t.assigned_to && t.assigned_to !== req.user.id) throw forbidden('This task is assigned to someone else');
    if (['assign', 'cancel', 'update'].includes(b.action) && !manager) throw forbidden();
    switch (b.action) {
      case 'assign':
        await db.query('UPDATE hk_tasks SET assigned_to = $1 WHERE id = $2', [b.assigned_to ?? null, id]); break;
      case 'update':
        await db.query('UPDATE hk_tasks SET priority = COALESCE($1, priority), notes = COALESCE($2, notes) WHERE id = $3', [b.priority ?? null, b.notes ?? null, id]); break;
      case 'start':
        if (t.status !== 'pending') throw badRequest(`Task is ${t.status}`);
        await db.query(`UPDATE hk_tasks SET status = 'in_progress', started_at = now(), assigned_to = COALESCE(assigned_to, $1) WHERE id = $2`, [req.user.id, id]);
        if (['cleaning', 'deep_clean'].includes(t.task_type)) await db.query(`UPDATE rooms SET hk_status = 'cleaning' WHERE id = $1 AND hk_status = 'dirty'`, [t.room_id]);
        break;
      case 'complete': {
        if (!['pending', 'in_progress'].includes(t.status)) throw badRequest(`Task is ${t.status}`);
        await db.query(`UPDATE hk_tasks SET status = 'done', completed_at = now(), completed_by = $1, notes = COALESCE($2, notes),
                        started_at = COALESCE(started_at, now()) WHERE id = $3`, [req.user.id, b.notes ?? null, id]);
        if (['cleaning', 'deep_clean'].includes(t.task_type)) {
          // Cleaners mark rooms cleaned → 'inspected' only by managers; otherwise room is ready unless hotel requires inspection
          const requireInspection = req.hotel.settings?.require_inspection === true;
          const next = b.room_status_after && manager ? b.room_status_after : (requireInspection ? 'cleaning' : 'ready');
          await db.query(`UPDATE rooms SET hk_status = $1 WHERE id = $2 AND hk_status <> 'out_of_order'`, [next, t.room_id]);
          if (requireInspection && next === 'cleaning') {
            await db.query(`INSERT INTO hk_tasks (hotel_id, room_id, task_type, priority, trigger, notes) VALUES ($1,$2,'inspection',$3,'system','Inspect after cleaning')`,
              [req.hotelId, t.room_id, t.priority]);
          }
        }
        if (t.task_type === 'inspection') await db.query(`UPDATE rooms SET hk_status = 'inspected' WHERE id = $1 AND hk_status <> 'out_of_order'`, [t.room_id]);
        if (t.service_request_id) await db.query(`UPDATE service_requests SET status = 'done', resolved_at = now() WHERE id = $1`, [t.service_request_id]);
        break;
      }
      case 'cancel':
        await db.query(`UPDATE hk_tasks SET status = 'cancelled' WHERE id = $1`, [id]); break;
    }
    await audit(req, `hk.task_${b.action}`, 'hk_task', id, { room_id: t.room_id, assigned_to: b.assigned_to }, db);
    return db.one('SELECT * FROM hk_tasks WHERE id = $1', [id]);
  });
  res.json(out);
});

// ---------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------
r.get('/maintenance', requirePerm('maintenance.view'), async (req, res) => {
  const open = req.query.all ? '' : `AND m.status IN ('open','in_progress')`;
  res.json(await many(
    `SELECT m.*, r.number AS room_number, u.name AS assigned_name, c.name AS created_by_name
       FROM maintenance_requests m LEFT JOIN rooms r ON r.id = m.room_id LEFT JOIN users u ON u.id = m.assigned_to
       LEFT JOIN users c ON c.id = m.created_by
      WHERE m.hotel_id = $1 ${open} ORDER BY CASE m.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, m.created_at DESC LIMIT 300`,
    [req.hotelId]));
});

r.post('/maintenance', requirePerm('maintenance.manage'), async (req, res) => {
  const b = parse(z.object({
    room_id: z.number().int().nullable().optional(), title: z.string().min(2), description: z.string().nullable().optional(),
    priority: z.enum(PRIORITY).default('normal'), assigned_to: z.number().int().nullable().optional(),
    mark_out_of_order: z.boolean().default(false),
  }), req.body);
  const m = await tx(async (db) => {
    const row = await db.one(
      `INSERT INTO maintenance_requests (hotel_id, room_id, title, description, priority, assigned_to, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.hotelId, b.room_id ?? null, b.title, b.description ?? null, b.priority, b.assigned_to ?? null, req.user.id]);
    if (b.mark_out_of_order && b.room_id) {
      const occ = await db.one(`SELECT id FROM stays WHERE room_id = $1 AND status = 'checked_in'`, [b.room_id]);
      if (occ) throw badRequest('Room is occupied; cannot mark it out of order');
      await db.query(`UPDATE rooms SET hk_status = 'out_of_order', out_of_order_reason = $1 WHERE id = $2 AND hotel_id = $3`, [b.title, b.room_id, req.hotelId]);
    }
    await audit(req, 'maintenance.created', 'maintenance', row.id, { room_id: b.room_id, title: b.title, ooo: b.mark_out_of_order }, db);
    return row;
  });
  res.status(201).json(m);
});

r.patch('/maintenance/:id', requirePerm('maintenance.manage', 'maintenance.work'), async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(z.object({
    status: z.enum(['open', 'in_progress', 'resolved', 'cancelled']).optional(), assigned_to: z.number().int().nullable().optional(),
    priority: z.enum(PRIORITY).optional(), resolution_notes: z.string().optional(), return_room_to_service: z.boolean().default(true),
  }), req.body);
  if ((b.assigned_to !== undefined || b.priority || b.status === 'cancelled') && !can(req, 'maintenance.manage')) throw forbidden();
  const m = await tx(async (db) => {
    const cur = await db.one('SELECT * FROM maintenance_requests WHERE id = $1 AND hotel_id = $2 FOR UPDATE', [id, req.hotelId]);
    if (!cur) throw notFound();
    if (b.status === 'resolved' && !b.resolution_notes) throw badRequest('Add resolution notes');
    const row = await db.one(
      `UPDATE maintenance_requests SET status = COALESCE($1, status), assigned_to = CASE WHEN $2::boolean THEN $3 ELSE assigned_to END,
              priority = COALESCE($4, priority), resolution_notes = COALESCE($5, resolution_notes),
              resolved_at = CASE WHEN $1 = 'resolved' THEN now() ELSE resolved_at END,
              resolved_by = CASE WHEN $1 = 'resolved' THEN $6 ELSE resolved_by END
        WHERE id = $7 RETURNING *`,
      [b.status ?? null, b.assigned_to !== undefined, b.assigned_to ?? null, b.priority ?? null, b.resolution_notes ?? null, req.user.id, id]);
    if (b.status === 'resolved' && cur.room_id && b.return_room_to_service) {
      await db.query(`UPDATE rooms SET hk_status = 'dirty', out_of_order_reason = NULL WHERE id = $1 AND hk_status = 'out_of_order'`, [cur.room_id]);
    }
    if (b.status === 'resolved' && cur.service_request_id) await db.query(`UPDATE service_requests SET status = 'done', resolved_at = now() WHERE id = $1`, [cur.service_request_id]);
    await audit(req, 'maintenance.updated', 'maintenance', id, b, db);
    return row;
  });
  res.json(m);
});

// ---------------------------------------------------------------
// Guest service requests (from QR portal)
// ---------------------------------------------------------------
r.get('/requests', requirePerm('requests.view', 'hk.view'), async (req, res) => {
  res.json(await many(
    `SELECT sr.*, r.number AS room_number, g.full_name AS guest_name FROM service_requests sr
       LEFT JOIN rooms r ON r.id = sr.room_id LEFT JOIN stays s ON s.id = sr.stay_id LEFT JOIN guests g ON g.id = s.guest_id
      WHERE sr.hotel_id = $1 AND (sr.status IN ('open','acknowledged') OR sr.created_at > now() - interval '24 hours')
      ORDER BY sr.status = 'done', sr.created_at DESC`, [req.hotelId]));
});

r.patch('/requests/:id', requirePerm('requests.view', 'hk.work'), async (req, res) => {
  const b = parse(z.object({ status: z.enum(['acknowledged', 'done', 'cancelled']) }), req.body);
  const row = await one(
    `UPDATE service_requests SET status = $1, assigned_to = COALESCE(assigned_to, $2), resolved_at = CASE WHEN $1 IN ('done','cancelled') THEN now() ELSE NULL END
      WHERE id = $3 AND hotel_id = $4 RETURNING *`, [b.status, req.user.id, idParam(req.params.id), req.hotelId]);
  if (!row) throw notFound();
  await audit(req, 'request.updated', 'service_request', row.id, b);
  res.json(row);
});

// ---------------------------------------------------------------
// Lost & found
// ---------------------------------------------------------------
r.get('/lost-found', requirePerm('hk.view', 'requests.view'), async (req, res) => {
  res.json(await many(
    `SELECT l.*, r.number AS room_number, u.name AS found_by_name FROM lost_found l LEFT JOIN rooms r ON r.id = l.room_id
       LEFT JOIN users u ON u.id = l.found_by WHERE l.hotel_id = $1 ORDER BY l.status = 'stored' DESC, l.created_at DESC LIMIT 300`, [req.hotelId]));
});
r.post('/lost-found', requirePerm('hk.view', 'requests.view'), async (req, res) => {
  const b = parse(z.object({ room_id: z.number().int().nullable().optional(), item: z.string().min(2), description: z.string().nullable().optional() }), req.body);
  const row = await one(`INSERT INTO lost_found (hotel_id, room_id, item, description, found_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.hotelId, b.room_id ?? null, b.item, b.description ?? null, req.user.id]);
  await audit(req, 'lost_found.logged', 'lost_found', row.id, { item: b.item });
  res.status(201).json(row);
});
r.patch('/lost-found/:id', requirePerm('requests.view', 'hk.manage'), async (req, res) => {
  const b = parse(z.object({ status: z.enum(['stored', 'returned', 'disposed']), returned_to: z.string().optional() }), req.body);
  const row = await one(`UPDATE lost_found SET status = $1, returned_to = COALESCE($2, returned_to), updated_at = now() WHERE id = $3 AND hotel_id = $4 RETURNING *`,
    [b.status, b.returned_to ?? null, idParam(req.params.id), req.hotelId]);
  if (!row) throw notFound();
  await audit(req, 'lost_found.updated', 'lost_found', row.id, b);
  res.json(row);
});

export default r;
