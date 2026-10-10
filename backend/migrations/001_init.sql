-- Wayinn — Hotel Operating System
-- 001: core multi-tenant schema
-- Money is stored as integer paise (1 INR = 100 paise). Never floats.

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------
-- Platform (Wayne E Solutions super-admin)
-- ---------------------------------------------------------------
CREATE TABLE platform_admins (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE plans (
  id                  BIGSERIAL PRIMARY KEY,
  code                TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  max_rooms           INT  NOT NULL,
  max_staff           INT,
  price_monthly_paise BIGINT NOT NULL DEFAULT 0,
  features            JSONB NOT NULL DEFAULT '{}'::jsonb,
  active              BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE hotels (
  id                  BIGSERIAL PRIMARY KEY,
  name                TEXT NOT NULL,
  slug                TEXT NOT NULL UNIQUE,
  legal_name          TEXT,
  gstin               TEXT,
  address             TEXT,
  city                TEXT,
  state               TEXT,
  state_code          TEXT,          -- GST state code, e.g. 03 = Punjab
  country             TEXT NOT NULL DEFAULT 'India',
  phone               TEXT,
  email               TEXT,
  currency            TEXT NOT NULL DEFAULT 'INR',
  timezone            TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  checkin_time        TIME NOT NULL DEFAULT '12:00',
  checkout_time       TIME NOT NULL DEFAULT '11:00',
  invoice_prefix      TEXT NOT NULL DEFAULT 'INV',
  invoice_seq         BIGINT NOT NULL DEFAULT 0,
  booking_seq         BIGINT NOT NULL DEFAULT 0,
  order_seq           BIGINT NOT NULL DEFAULT 0,
  kot_seq             BIGINT NOT NULL DEFAULT 0,
  settings            JSONB NOT NULL DEFAULT '{}'::jsonb,
  plan_id             BIGINT REFERENCES plans(id),
  subscription_status TEXT NOT NULL DEFAULT 'trial'
                      CHECK (subscription_status IN ('trial','active','past_due','suspended','cancelled')),
  trial_ends_at       TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------
-- Staff, roles, audit
-- ---------------------------------------------------------------
CREATE TABLE users (
  id                  BIGSERIAL PRIMARY KEY,
  hotel_id            BIGINT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  email               TEXT NOT NULL,
  phone               TEXT,
  password_hash       TEXT NOT NULL,
  role                TEXT NOT NULL CHECK (role IN
                      ('owner','manager','receptionist','cashier','restaurant','kitchen','housekeeping','maintenance')),
  extra_permissions   TEXT[] NOT NULL DEFAULT '{}',
  revoked_permissions TEXT[] NOT NULL DEFAULT '{}',
  active              BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at       TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));
CREATE INDEX users_hotel_idx ON users (hotel_id);

CREATE TABLE audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  hotel_id    BIGINT REFERENCES hotels(id) ON DELETE CASCADE,
  actor_type  TEXT NOT NULL DEFAULT 'staff' CHECK (actor_type IN ('staff','platform','guest','system')),
  actor_id    BIGINT,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   BIGINT,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_hotel_time_idx ON audit_logs (hotel_id, created_at DESC);
CREATE INDEX audit_entity_idx ON audit_logs (hotel_id, entity_type, entity_id);

CREATE TABLE handover_notes (
  id         BIGSERIAL PRIMARY KEY,
  hotel_id   BIGINT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  user_id    BIGINT REFERENCES users(id),
  department TEXT NOT NULL DEFAULT 'front_desk',
  note       TEXT NOT NULL,
  resolved   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------
-- Rooms
-- ---------------------------------------------------------------
CREATE TABLE room_types (
  id                       BIGSERIAL PRIMARY KEY,
  hotel_id                 BIGINT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  name                     TEXT NOT NULL,
  code                     TEXT,
  description              TEXT,
  base_occupancy           INT NOT NULL DEFAULT 2,
  max_occupancy            INT NOT NULL DEFAULT 3,
  base_rate_paise          BIGINT NOT NULL DEFAULT 0,
  extra_person_rate_paise  BIGINT NOT NULL DEFAULT 0,
  amenities                TEXT[] NOT NULL DEFAULT '{}',
  active                   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (hotel_id, name)
);

-- hk_status is the housekeeping state; occupancy (reserved/occupied) is derived from stays.
CREATE TABLE rooms (
  id            BIGSERIAL PRIMARY KEY,
  hotel_id      BIGINT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  room_type_id  BIGINT NOT NULL REFERENCES room_types(id),
  number        TEXT NOT NULL,
  floor         TEXT,
  hk_status     TEXT NOT NULL DEFAULT 'ready'
                CHECK (hk_status IN ('ready','dirty','cleaning','inspected','out_of_order')),
  out_of_order_reason TEXT,
  qr_token      TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16),'hex'),
  notes         TEXT,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (hotel_id, number)
);

-- ---------------------------------------------------------------
-- Guests
-- ---------------------------------------------------------------
CREATE TABLE guests (
  id            BIGSERIAL PRIMARY KEY,
  hotel_id      BIGINT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  full_name     TEXT NOT NULL,
  phone         TEXT,
  email         TEXT,
  address       TEXT,
  city          TEXT,
  country       TEXT,
  nationality   TEXT,
  id_type       TEXT,
  id_number     TEXT,
  company_name  TEXT,
  company_gstin TEXT,
  preferences   TEXT,
  notes         TEXT,           -- internal staff notes
  custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX guests_hotel_name_idx ON guests (hotel_id, lower(full_name));
CREATE INDEX guests_hotel_phone_idx ON guests (hotel_id, phone);

-- ---------------------------------------------------------------
-- Bookings & stays
-- A booking groups one or more stays (one per room). Each stay has its own folio.
-- ---------------------------------------------------------------
CREATE TABLE bookings (
  id               BIGSERIAL PRIMARY KEY,
  hotel_id         BIGINT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  ref              TEXT NOT NULL,
  guest_id         BIGINT NOT NULL REFERENCES guests(id),
  source           TEXT NOT NULL DEFAULT 'walk_in'
                   CHECK (source IN ('walk_in','phone','direct_online','staff','ota','corporate','other')),
  status           TEXT NOT NULL DEFAULT 'confirmed'
                   CHECK (status IN ('requested','confirmed','cancelled')),
  special_requests TEXT,
  notes            TEXT,
  group_name       TEXT,
  created_by       BIGINT REFERENCES users(id),
  cancelled_at     TIMESTAMPTZ,
  cancel_reason    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (hotel_id, ref)
);

CREATE TABLE stays (
  id                 BIGSERIAL PRIMARY KEY,
  hotel_id           BIGINT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  booking_id         BIGINT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  guest_id           BIGINT NOT NULL REFERENCES guests(id),
  room_type_id       BIGINT NOT NULL REFERENCES room_types(id),
  room_id            BIGINT REFERENCES rooms(id),
  check_in_date      DATE NOT NULL,
  check_out_date     DATE NOT NULL,
  adults             INT NOT NULL DEFAULT 1,
  children           INT NOT NULL DEFAULT 0,
  nightly_rate_paise BIGINT NOT NULL,
  extra_person_paise BIGINT NOT NULL DEFAULT 0,  -- per night, total for extra persons
  status             TEXT NOT NULL DEFAULT 'reserved'
                     CHECK (status IN ('tentative','reserved','checked_in','checked_out','cancelled','no_show')),
  early_check_in     BOOLEAN NOT NULL DEFAULT FALSE,
  late_check_out     BOOLEAN NOT NULL DEFAULT FALSE,
  checked_in_at      TIMESTAMPTZ,
  checked_out_at     TIMESTAMPTZ,
  checked_in_by      BIGINT REFERENCES users(id),
  checked_out_by     BIGINT REFERENCES users(id),
  portal_pin         TEXT,    -- optional pin given to the guest at check-in for the QR portal
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (check_out_date > check_in_date),
  -- Hard safeguard: the same room can never hold two live stays on overlapping nights.
  CONSTRAINT stays_no_overlap EXCLUDE USING gist (
    room_id WITH =,
    daterange(check_in_date, check_out_date, '[)') WITH &&
  ) WHERE (room_id IS NOT NULL AND status IN ('reserved','checked_in'))
);
CREATE INDEX stays_hotel_dates_idx ON stays (hotel_id, check_in_date, check_out_date);
CREATE INDEX stays_booking_idx ON stays (booking_id);

-- ---------------------------------------------------------------
-- Folios, lines, payments  (append-only financial records)
-- ---------------------------------------------------------------
CREATE TABLE folios (
  id             BIGSERIAL PRIMARY KEY,
  hotel_id       BIGINT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL DEFAULT 'stay' CHECK (kind IN ('stay','restaurant')),
  stay_id        BIGINT UNIQUE REFERENCES stays(id),
  booking_id     BIGINT REFERENCES bookings(id),
  guest_id       BIGINT REFERENCES guests(id),
  bill_to_name   TEXT,
  bill_to_gstin  TEXT,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  invoice_no     TEXT,
  invoiced_at    TIMESTAMPTZ,
  closed_by      BIGINT REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (hotel_id, invoice_no)
);

CREATE TABLE folio_lines (
  id               BIGSERIAL PRIMARY KEY,
  hotel_id         BIGINT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  folio_id         BIGINT NOT NULL REFERENCES folios(id) ON DELETE CASCADE,
  category         TEXT NOT NULL CHECK (category IN ('room','extra_person','food','room_service','service','extra','discount')),
  description      TEXT NOT NULL,
  hsn_sac          TEXT,
  quantity         NUMERIC(10,2) NOT NULL DEFAULT 1,
  unit_price_paise BIGINT NOT NULL,
  amount_paise     BIGINT NOT NULL,           -- pre-tax; negative for discounts
  tax_rate         NUMERIC(5,2) NOT NULL DEFAULT 0,
  tax_paise        BIGINT NOT NULL DEFAULT 0,
  business_date    DATE NOT NULL,
  source_type      TEXT,                      -- 'stay_night' | 'order' | 'manual'
  source_id        BIGINT,
  voided_at        TIMESTAMPTZ,
  voided_by        BIGINT REFERENCES users(id),
  void_reason      TEXT,
  created_by       BIGINT REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX folio_lines_folio_idx ON folio_lines (folio_id);
CREATE INDEX folio_lines_hotel_date_idx ON folio_lines (hotel_id, business_date);
-- One live room-night charge per stay per date (prevents double posting).
CREATE UNIQUE INDEX folio_lines_room_night_uq ON folio_lines (source_id, business_date)
  WHERE source_type = 'stay_night' AND voided_at IS NULL;

CREATE TABLE payments (
  id           BIGSERIAL PRIMARY KEY,
  hotel_id     BIGINT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  folio_id     BIGINT NOT NULL REFERENCES folios(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'payment' CHECK (kind IN ('payment','deposit','refund')),
  method       TEXT NOT NULL CHECK (method IN ('cash','card','upi','online','bank_transfer','other')),
  amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),  -- refunds are positive amounts of kind 'refund'
  reference    TEXT,
  notes        TEXT,
  voided_at    TIMESTAMPTZ,
  voided_by    BIGINT REFERENCES users(id),
  void_reason  TEXT,
  received_by  BIGINT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payments_folio_idx ON payments (folio_id);
CREATE INDEX payments_hotel_time_idx ON payments (hotel_id, created_at);

-- ---------------------------------------------------------------
-- Restaurant / POS / KOT
-- ---------------------------------------------------------------
CREATE TABLE stations (
  id         BIGSERIAL PRIMARY KEY,
  hotel_id   BIGINT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (hotel_id, name)
);

CREATE TABLE menu_categories (
  id         BIGSERIAL PRIMARY KEY,
  hotel_id   BIGINT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (hotel_id, name)
);

CREATE TABLE menu_items (
  id           BIGSERIAL PRIMARY KEY,
  hotel_id     BIGINT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  category_id  BIGINT REFERENCES menu_categories(id),
  station_id   BIGINT REFERENCES stations(id),
  name         TEXT NOT NULL,
  description  TEXT,
  price_paise  BIGINT NOT NULL,
  tax_rate     NUMERIC(5,2),             -- null = hotel default food tax
  is_veg       BOOLEAN,
  variants     JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{name, price_paise}]
  addons       JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{name, price_paise}]
  available    BOOLEAN NOT NULL DEFAULT TRUE,
  show_on_qr   BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order   INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX menu_items_hotel_idx ON menu_items (hotel_id);

CREATE TABLE orders (
  id               BIGSERIAL PRIMARY KEY,
  hotel_id         BIGINT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  order_no         TEXT NOT NULL,
  order_type       TEXT NOT NULL CHECK (order_type IN ('dine_in','takeaway','room_service')),
  source           TEXT NOT NULL DEFAULT 'staff' CHECK (source IN ('staff','guest_qr')),
  table_label      TEXT,
  room_id          BIGINT REFERENCES rooms(id),
  stay_id          BIGINT REFERENCES stays(id),
  folio_id         BIGINT REFERENCES folios(id),     -- room folio or restaurant folio
  customer_name    TEXT,
  customer_phone   TEXT,
  status           TEXT NOT NULL DEFAULT 'received'
                   CHECK (status IN ('received','accepted','preparing','ready','out_for_delivery','delivered','cancelled')),
  settlement       TEXT NOT NULL DEFAULT 'unsettled'
                   CHECK (settlement IN ('unsettled','room_posted','paid','complimentary')),
  notes            TEXT,
  subtotal_paise   BIGINT NOT NULL DEFAULT 0,
  discount_paise   BIGINT NOT NULL DEFAULT 0,
  tax_paise        BIGINT NOT NULL DEFAULT 0,
  total_paise      BIGINT NOT NULL DEFAULT 0,
  cancel_reason    TEXT,
  created_by       BIGINT REFERENCES users(id),
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (hotel_id, order_no)
);
CREATE INDEX orders_hotel_status_idx ON orders (hotel_id, status);
CREATE INDEX orders_hotel_time_idx ON orders (hotel_id, created_at);

CREATE TABLE kots (
  id          BIGSERIAL PRIMARY KEY,
  hotel_id    BIGINT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  order_id    BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  station_id  BIGINT REFERENCES stations(id),
  kot_no      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','preparing','ready','cancelled')),
  printed_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  id               BIGSERIAL PRIMARY KEY,
  hotel_id         BIGINT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  order_id         BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id     BIGINT REFERENCES menu_items(id),
  kot_id           BIGINT REFERENCES kots(id),
  station_id       BIGINT REFERENCES stations(id),
  name             TEXT NOT NULL,
  variant          TEXT,
  addons           JSONB NOT NULL DEFAULT '[]'::jsonb,
  quantity         INT NOT NULL CHECK (quantity > 0),
  unit_price_paise BIGINT NOT NULL,
  amount_paise     BIGINT NOT NULL,
  tax_rate         NUMERIC(5,2) NOT NULL DEFAULT 0,
  notes            TEXT,
  complimentary    BOOLEAN NOT NULL DEFAULT FALSE,
  cancelled        BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX order_items_order_idx ON order_items (order_id);

-- ---------------------------------------------------------------
-- Guest service requests, housekeeping, maintenance
-- ---------------------------------------------------------------
CREATE TABLE service_requests (
  id           BIGSERIAL PRIMARY KEY,
  hotel_id     BIGINT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  room_id      BIGINT REFERENCES rooms(id),
  stay_id      BIGINT REFERENCES stays(id),
  type         TEXT NOT NULL CHECK (type IN ('towels','housekeeping','maintenance','amenity','checkout','reception','other')),
  message      TEXT,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','done','cancelled')),
  assigned_to  BIGINT REFERENCES users(id),
  resolved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE hk_tasks (
  id            BIGSERIAL PRIMARY KEY,
  hotel_id      BIGINT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  room_id       BIGINT NOT NULL REFERENCES rooms(id),
  task_type     TEXT NOT NULL DEFAULT 'cleaning' CHECK (task_type IN ('cleaning','inspection','turndown','deep_clean','request')),
  priority      TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','done','cancelled')),
  trigger       TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual','checkout','guest_request','system')),
  assigned_to   BIGINT REFERENCES users(id),
  service_request_id BIGINT REFERENCES service_requests(id),
  due_at        TIMESTAMPTZ,
  notes         TEXT,
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  completed_by  BIGINT REFERENCES users(id),
  created_by    BIGINT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX hk_tasks_hotel_status_idx ON hk_tasks (hotel_id, status);

CREATE TABLE maintenance_requests (
  id               BIGSERIAL PRIMARY KEY,
  hotel_id         BIGINT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  room_id          BIGINT REFERENCES rooms(id),
  title            TEXT NOT NULL,
  description      TEXT,
  priority         TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','cancelled')),
  assigned_to      BIGINT REFERENCES users(id),
  service_request_id BIGINT REFERENCES service_requests(id),
  resolution_notes TEXT,
  resolved_at      TIMESTAMPTZ,
  resolved_by      BIGINT REFERENCES users(id),
  created_by       BIGINT REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE lost_found (
  id          BIGSERIAL PRIMARY KEY,
  hotel_id    BIGINT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  room_id     BIGINT REFERENCES rooms(id),
  item        TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'stored' CHECK (status IN ('stored','returned','disposed')),
  found_by    BIGINT REFERENCES users(id),
  returned_to TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------
-- Outbound notifications (WhatsApp / SMS / email) — provider-agnostic outbox
-- ---------------------------------------------------------------
CREATE TABLE notifications_outbox (
  id          BIGSERIAL PRIMARY KEY,
  hotel_id    BIGINT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL CHECK (channel IN ('whatsapp','sms','email')),
  recipient   TEXT NOT NULL,
  template    TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  status      TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','skipped')),
  error       TEXT,
  attempts    INT NOT NULL DEFAULT 0,
  sent_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX outbox_status_idx ON notifications_outbox (status, created_at);
