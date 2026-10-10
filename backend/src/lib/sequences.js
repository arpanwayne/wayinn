// Per-hotel human-readable numbers (booking refs, order numbers, KOT, invoice).
// Uses UPDATE ... RETURNING on the hotel row, so it is safe under concurrency inside a transaction.
const COLS = { booking: 'booking_seq', order: 'order_seq', kot: 'kot_seq', invoice: 'invoice_seq' };

export async function nextSeq(db, hotelId, kind) {
  const col = COLS[kind];
  const r = await db.one(`UPDATE hotels SET ${col} = ${col} + 1 WHERE id = $1 RETURNING ${col} AS n, invoice_prefix`, [hotelId]);
  return r;
}

export async function nextBookingRef(db, hotelId) {
  const { n } = await nextSeq(db, hotelId, 'booking');
  return `WB${String(n).padStart(5, '0')}`;
}
export async function nextOrderNo(db, hotelId) {
  const { n } = await nextSeq(db, hotelId, 'order');
  return `OR${String(n).padStart(5, '0')}`;
}
export async function nextKotNo(db, hotelId) {
  const { n } = await nextSeq(db, hotelId, 'kot');
  return `K${String(n).padStart(5, '0')}`;
}
export async function nextInvoiceNo(db, hotelId) {
  // GST rule: invoice number ≤16 chars, unique per financial year. Prefix + FY + running number.
  const { n, invoice_prefix } = await nextSeq(db, hotelId, 'invoice');
  const now = new Date();
  const fyStart = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const fy = `${String(fyStart).slice(2)}${String(fyStart + 1).slice(2)}`;
  return `${invoice_prefix}/${fy}/${String(n).padStart(5, '0')}`.slice(0, 16);
}
