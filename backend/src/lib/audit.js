import { query } from '../db.js';

/**
 * Write an audit entry. `db` may be a transaction client; defaults to the pool.
 * Never throws into the caller's flow for non-transactional use.
 */
export async function audit(req, action, entityType, entityId, data = {}, db = null) {
  const actorType = req?.auth?.type === 'platform' ? 'platform' : req?.auth?.type === 'guest' ? 'guest' : req?.auth ? 'staff' : 'system';
  const params = [req?.hotelId ?? data.hotel_id ?? null, actorType, req?.auth?.sub ?? null, action, entityType, entityId ?? null,
    JSON.stringify(data), req?.ip ?? null];
  const sql = `INSERT INTO audit_logs (hotel_id, actor_type, actor_id, action, entity_type, entity_id, data, ip)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`;
  if (db) return db.query(sql, params);
  try { await query(sql, params); } catch (e) { console.error('audit failed', e.message); }
}
