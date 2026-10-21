// Razorpay advance payments on the public booking page. Each hotel uses its own Razorpay account.
import { roomTaxRate, taxOn } from './money.js';
import { nightsBetween } from './dates.js';
import { hmacHex, safeEqual } from './integrations.js';
import { availability } from '../routes/bookings.js';
import { badRequest } from './errors.js';

/** Total for a booking request: room nights + GST, for all rooms. */
export function stayEstimate(hotel, { nightly_rate_paise, extra_person_paise = 0, check_in_date, check_out_date, rooms = 1 }) {
  const tariff = Number(nightly_rate_paise) + Number(extra_person_paise);
  const nights = nightsBetween(check_in_date, check_out_date);
  const perNight = tariff + taxOn(tariff, roomTaxRate(hotel, tariff));
  return { nights, first_night_paise: perNight * rooms, total_paise: perNight * nights * rooms };
}

/** How much to collect now, from the owner's setting. 0 = no online payment. */
export function depositAmount(setting, est) {
  if (!setting || setting.mode === 'off' || !setting.mode) return 0;
  if (setting.mode === 'full') return est.total_paise;
  if (setting.mode === 'first_night') return est.first_night_paise;
  if (setting.mode === 'percent') return Math.max(100, Math.round((est.total_paise * Number(setting.percent || 25)) / 100));
  return 0;
}

export async function createRazorpayOrder(integ, { amount_paise, receipt, notes }, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${integ.razorpay_key_id}:${integ.razorpay_key_secret}`).toString('base64')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ amount: amount_paise, currency: 'INR', receipt, notes }),
    });
  } catch (e) { throw badRequest(`Online payment is not available right now (${e.message})`); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) throw badRequest(`Online payment is not available right now: ${data?.error?.description || `HTTP ${res.status}`}`);
  return data;
}

/** Signature Razorpay Checkout returns to the browser: HMAC_SHA256(order_id|payment_id, key_secret). */
export const checkoutSignatureOk = (integ, orderId, paymentId, signature) =>
  safeEqual(hmacHex(integ.razorpay_key_secret, `${orderId}|${paymentId}`), signature);

/** Webhook signature: HMAC_SHA256(raw body, webhook secret). */
export const webhookSignatureOk = (integ, rawBody, signature) =>
  !!integ.razorpay_webhook_secret && safeEqual(hmacHex(integ.razorpay_webhook_secret, rawBody), signature);

/**
 * Record a paid Razorpay order once (browser callback and webhook can both arrive): adds the deposit to the
 * booking's first bill and, if rooms are still free, confirms the booking request. Returns what happened.
 */
export async function markOnlinePaymentPaid(db, orderId, paymentId) {
  const op = await db.one(`SELECT * FROM online_payments WHERE provider_order_id = $1 FOR UPDATE`, [orderId]);
  if (!op) return { found: false };
  if (op.status === 'paid') return { found: true, already: true, op };
  const bk = await db.one(`SELECT * FROM bookings WHERE id = $1 FOR UPDATE`, [op.booking_id]);
  const folio = await db.one(`SELECT f.id FROM folios f JOIN stays s ON s.id = f.stay_id WHERE s.booking_id = $1 ORDER BY f.id LIMIT 1`, [bk.id]);
  const pay = await db.one(
    `INSERT INTO payments (hotel_id, folio_id, kind, method, amount_paise, reference, notes)
     VALUES ($1,$2,'deposit','online',$3,$4,'Paid online with Razorpay on the booking page') RETURNING id`,
    [op.hotel_id, folio.id, op.amount_paise, paymentId]);
  await db.query(`UPDATE online_payments SET status = 'paid', provider_payment_id = $2, payment_id = $3, paid_at = now() WHERE id = $1`,
    [op.id, paymentId, pay.id]);

  let confirmed = bk.status === 'confirmed';
  if (bk.status === 'requested') {
    // Paid requests are confirmed straight away when the rooms are still free; otherwise the front desk
    // sees a paid request and calls the guest.
    const stays = await db.many(`SELECT * FROM stays WHERE booking_id = $1 AND status = 'tentative'`, [bk.id]);
    const need = {};
    for (const s of stays) need[`${s.room_type_id}|${s.check_in_date}|${s.check_out_date}`] = (need[`${s.room_type_id}|${s.check_in_date}|${s.check_out_date}`] || 0) + 1;
    let ok = stays.length > 0;
    for (const [k, n] of Object.entries(need)) {
      const [typeId, from, to] = k.split('|');
      const a = (await availability(db, op.hotel_id, from, to)).find((t) => String(t.id) === typeId);
      if (!a || a.available < n) ok = false;
    }
    if (ok) {
      await db.query(`UPDATE stays SET status = 'reserved' WHERE booking_id = $1 AND status = 'tentative'`, [bk.id]);
      await db.query(`UPDATE bookings SET status = 'confirmed' WHERE id = $1`, [bk.id]);
      confirmed = true;
    } else {
      await db.query(`UPDATE bookings SET notes = trim(COALESCE(notes,'') || ' PAID ONLINE but rooms were no longer free — call the guest.') WHERE id = $1`, [bk.id]);
    }
  }
  await db.query(
    `INSERT INTO audit_logs (hotel_id, actor_type, action, entity_type, entity_id, data) VALUES ($1,'guest','payment.online_received','booking',$2,$3)`,
    [op.hotel_id, bk.id, JSON.stringify({ ref: bk.ref, amount_paise: op.amount_paise, razorpay_payment_id: paymentId, confirmed })]);
  return { found: true, op: { ...op, status: 'paid' }, booking: bk, confirmed };
}
