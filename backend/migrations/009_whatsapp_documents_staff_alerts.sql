-- Guest ID documents received on the front-desk WhatsApp number, and two-way WhatsApp for housekeeping / maintenance.

-- Inbound WhatsApp (Meta Cloud API webhook). The verify token is chosen by us, the app secret comes from the
-- hotel's Meta app and is used to check the x-hub-signature-256 header on every delivery.
ALTER TABLE hotel_integrations ADD COLUMN whatsapp_verify_token TEXT;
ALTER TABLE hotel_integrations ADD COLUMN whatsapp_app_secret TEXT;

-- Documents (ID proofs etc.). Files are kept in the database so a hotel needs no extra storage account.
-- guest_id is NULL while a document sits in the front-desk inbox waiting to be matched to a guest.
CREATE TABLE guest_documents (
  id            BIGSERIAL PRIMARY KEY,
  hotel_id      BIGINT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  guest_id      BIGINT REFERENCES guests(id) ON DELETE SET NULL,
  booking_id    BIGINT REFERENCES bookings(id) ON DELETE SET NULL,
  doc_type      TEXT NOT NULL DEFAULT 'id_proof' CHECK (doc_type IN ('id_proof','aadhaar','passport','driving_licence','voter_id','pan','visa','other')),
  source        TEXT NOT NULL DEFAULT 'upload' CHECK (source IN ('whatsapp','upload')),
  status        TEXT NOT NULL DEFAULT 'inbox' CHECK (status IN ('inbox','attached')),
  file_name     TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INT NOT NULL,
  data          BYTEA NOT NULL,
  from_phone    TEXT,
  from_name     TEXT,
  note          TEXT,
  wa_message_id TEXT,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  attached_by   BIGINT REFERENCES users(id),
  uploaded_by   BIGINT REFERENCES users(id)
);
CREATE UNIQUE INDEX guest_documents_wa_uq ON guest_documents (hotel_id, wa_message_id) WHERE wa_message_id IS NOT NULL;
CREATE INDEX guest_documents_guest_idx ON guest_documents (hotel_id, guest_id);
CREATE INDEX guest_documents_inbox_idx ON guest_documents (hotel_id, received_at DESC) WHERE status = 'inbox';
