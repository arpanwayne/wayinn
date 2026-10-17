// Permanent delete that never breaks history: if anything still points at the row (a booking, a bill,
// an order…), Postgres refuses with a foreign-key error and we turn that into a clear message instead.
import { one } from '../db.js';
import { conflict, notFound } from './errors.js';

export async function removeRow(sql, params, inUseMessage, db = { one }) {
  try {
    const row = await db.one(sql, params);
    if (!row) throw notFound();
    return row;
  } catch (e) {
    if (e.code === '23503') throw conflict(inUseMessage);
    throw e;
  }
}
