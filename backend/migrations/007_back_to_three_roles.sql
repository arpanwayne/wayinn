-- 007: back to three staff roles (owner / front_desk / kitchen), as decided.
-- Migration 005 re-opened manager / cashier / restaurant / housekeeping / maintenance; this folds them
-- into front_desk again. Per-person extra/revoked permissions are kept, so the owner can still limit
-- what an individual front desk person (e.g. someone who only does housekeeping) is allowed to do.
-- 005 stays in place (it may already have run on a database); this migration undoes its role change.
ALTER TABLE users DROP CONSTRAINT users_role_check;
UPDATE users SET role = 'front_desk'
 WHERE role IN ('manager','receptionist','cashier','restaurant','housekeeping','maintenance');
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('owner','front_desk','kitchen'));
