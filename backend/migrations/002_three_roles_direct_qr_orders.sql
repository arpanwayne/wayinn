-- Three staff roles (owner / front_desk / kitchen) and direct-to-kitchen guest QR orders.

-- 1. Roles: everyone who was not owner or kitchen becomes front desk.
--    Per-person extra/revoked permissions are kept as they were.
ALTER TABLE users DROP CONSTRAINT users_role_check;
UPDATE users SET role = 'front_desk'
 WHERE role IN ('manager','receptionist','cashier','restaurant','housekeeping','maintenance');
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('owner','front_desk','kitchen'));

-- 2. Kitchen tickets get a final "delivered" state (the kitchen's only action).
ALTER TABLE kots DROP CONSTRAINT kots_status_check;
ALTER TABLE kots ADD CONSTRAINT kots_status_check CHECK (status IN ('pending','preparing','ready','delivered','cancelled'));
-- Tickets of orders that are already finished must not reappear on the kitchen screen.
UPDATE kots k SET status = 'delivered' FROM orders o
 WHERE o.id = k.order_id AND o.status = 'delivered' AND k.status IN ('pending','preparing','ready');

-- 3. Guest QR orders go straight to the kitchen and onto the room bill; staff acceptance is now opt-in.
UPDATE hotels SET settings = settings || '{"qr_orders_require_accept": false}'::jsonb;
