import { many } from '../db.js';

/**
 * Live room board: each room with its housekeeping status, current/next stay and a single display status.
 * display_status ∈ out_of_order | occupied | dirty | cleaning | inspected | reserved | available
 */
export async function roomBoard(hotelId, today) {
  const rooms = await many(
    `SELECT r.id, r.number, r.floor, r.hk_status, r.out_of_order_reason, r.room_type_id, rt.name AS room_type,
            cur.id AS stay_id, cur.booking_id, cur.check_in_date, cur.check_out_date, cg.full_name AS guest_name,
            arr.id AS arriving_stay_id, ag.full_name AS arriving_guest, arr.booking_id AS arriving_booking_id
       FROM rooms r
       JOIN room_types rt ON rt.id = r.room_type_id
       LEFT JOIN stays cur ON cur.room_id = r.id AND cur.status = 'checked_in'
       LEFT JOIN guests cg ON cg.id = cur.guest_id
       LEFT JOIN LATERAL (
         SELECT s.* FROM stays s WHERE s.room_id = r.id AND s.status = 'reserved' AND s.check_in_date = $2 LIMIT 1
       ) arr ON TRUE
       LEFT JOIN guests ag ON ag.id = arr.guest_id
      WHERE r.hotel_id = $1 AND r.active
      ORDER BY r.floor NULLS FIRST, r.number`, [hotelId, today]);
  return rooms.map((r) => {
    let display = 'available';
    if (r.hk_status === 'out_of_order') display = 'out_of_order';
    else if (r.stay_id) display = 'occupied';
    else if (['dirty', 'cleaning', 'inspected'].includes(r.hk_status)) display = r.hk_status;
    else if (r.arriving_stay_id) display = 'reserved';
    return { ...r, display_status: display, due_out: r.stay_id && r.check_out_date <= today };
  });
}
