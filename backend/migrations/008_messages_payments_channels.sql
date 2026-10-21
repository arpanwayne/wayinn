-- WhatsApp / SMS / email sending, Razorpay advance payments, OTA / channel-manager bookings.

-- Per-hotel keys for outside services. Filled in by the Wayne E Solutions super admin (same rule as Waynur:
-- every hotel uses its own WhatsApp number and its own Razorpay account). Kept out of the hotels table so
-- the hotel's own screens never receive these secrets.
CREATE TABLE hotel_integrations (
  hotel_id                  BIGINT PRIMARY KEY REFERENCES hotels(id) ON DELETE CASCADE,
  whatsapp_phone_number_id  TEXT,
  whatsapp_token            TEXT,
  whatsapp_language         TEXT NOT NULL DEFAULT 'en',
  sms_auth_key              TEXT,          -- MSG91
  sms_templates             JSONB NOT NULL DEFAULT '{}'::jsonb,  -- { template_name: "msg91 flow / DLT template id" }
  smtp_host                 TEXT,
  smtp_port                 INT,
  smtp_user                 TEXT,
  smtp_pass                 TEXT,
  email_from                TEXT,
  razorpay_key_id           TEXT,
  razorpay_key_secret       TEXT,
  razorpay_webhook_secret   TEXT,
  channel_key_hash          TEXT,          -- sha256 of the channel-manager API key (the key itself is shown once)
  channel_key_hint          TEXT,
  ical_token                TEXT UNIQUE,
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Outbox: retry timing and the provider's message id.
ALTER TABLE notifications_outbox ADD COLUMN next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE notifications_outbox ADD COLUMN provider_ref TEXT;
ALTER TABLE notifications_outbox ADD COLUMN audience TEXT NOT NULL DEFAULT 'guest' CHECK (audience IN ('guest','staff'));
CREATE INDEX outbox_due_idx ON notifications_outbox (next_attempt_at) WHERE status = 'queued';

-- Booking sources: the OTAs by name, plus a channel-manager reference so the same OTA booking is never
-- created twice.
ALTER TABLE bookings DROP CONSTRAINT bookings_source_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_source_check CHECK (source IN (
  'walk_in','phone','direct_online','staff','ota','corporate','other',
  'makemytrip','goibibo','oyo','booking_com','agoda','airbnb','expedia','channel_manager'));
ALTER TABLE bookings ADD COLUMN external_ref TEXT;
CREATE UNIQUE INDEX bookings_external_ref_uq ON bookings (hotel_id, source, external_ref) WHERE external_ref IS NOT NULL;

-- Razorpay advance payments taken on the public booking page.
CREATE TABLE online_payments (
  id                BIGSERIAL PRIMARY KEY,
  hotel_id          BIGINT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  booking_id        BIGINT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL DEFAULT 'razorpay',
  provider_order_id TEXT NOT NULL UNIQUE,
  provider_payment_id TEXT,
  amount_paise      BIGINT NOT NULL CHECK (amount_paise > 0),
  status            TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','paid','failed')),
  payment_id        BIGINT REFERENCES payments(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at           TIMESTAMPTZ
);
CREATE INDEX online_payments_booking_idx ON online_payments (booking_id);
