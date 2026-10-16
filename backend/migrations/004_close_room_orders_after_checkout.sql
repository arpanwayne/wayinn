-- 004: food orders charged to a room bill stayed "in progress" on the front desk after the guest checked out,
-- because the kitchen never marked them delivered. The charge is already on the bill, so close them.
-- Checkout now does this automatically; this cleans up the ones left behind before the fix.
UPDATE kots k
   SET status = 'delivered'
  FROM orders o
  JOIN stays s ON s.id = o.stay_id
 WHERE k.order_id = o.id
   AND o.settlement = 'room_posted'
   AND s.status = 'checked_out'
   AND o.status NOT IN ('delivered','cancelled')
   AND k.status NOT IN ('delivered','cancelled');

UPDATE orders o
   SET status = 'delivered', status_changed_at = now()
  FROM stays s
 WHERE s.id = o.stay_id
   AND o.settlement = 'room_posted'
   AND s.status = 'checked_out'
   AND o.status NOT IN ('delivered','cancelled');
