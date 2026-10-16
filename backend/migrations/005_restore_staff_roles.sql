-- 005: separate staff roles again. Migration 002 folded manager / cashier / restaurant / housekeeping /
-- maintenance into front_desk, which gave e.g. housekeeping the power to cancel bookings and take payments.
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('owner','manager','front_desk','cashier','restaurant','kitchen','housekeeping','maintenance'));

-- Put people back in the role they were created with. The audit log kept it when the account was made.
-- Only touches accounts that are still front_desk (i.e. were folded by 002 and not changed since).
UPDATE users u
   SET role = a.role
  FROM (
    SELECT DISTINCT ON (entity_id) entity_id, data->>'role' AS role
      FROM audit_logs
     WHERE action = 'staff.created' AND entity_type = 'user'
     ORDER BY entity_id, id DESC
  ) a
 WHERE a.entity_id = u.id
   AND u.role = 'front_desk'
   AND a.role IN ('manager','cashier','restaurant','housekeeping','maintenance');

-- Demo hotel accounts were seeded without an audit entry; restore them by their known login.
UPDATE users u
   SET role = m.role
  FROM (VALUES ('manager@demo-hotel.in','manager'), ('cashier@demo-hotel.in','cashier'),
               ('restaurant@demo-hotel.in','restaurant'), ('hk@demo-hotel.in','housekeeping'),
               ('maintenance@demo-hotel.in','maintenance')) AS m(email, role)
 WHERE u.email = m.email AND u.role = 'front_desk';
