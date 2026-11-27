-- 010: Rate calendar (date-wise rates, minimum stay, stop-sell), Rate Guard (OTA rate monitor, suggestions,
-- WhatsApp approvals, change log) and Google Hotels (free booking links / "Official site" price via ARI).

-- ---------------------------------------------------------------
-- Rate calendar
-- One row only for dates that differ from the room type's base rate. A missing row means:
-- base rate, no minimum stay, open for sale.
-- ---------------------------------------------------------------
CREATE TABLE rate_calendar (
  hotel_id      BIGINT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  room_type_id  BIGINT NOT NULL REFERENCES room_types(id) ON DELETE CASCADE,
  date          DATE   NOT NULL,
  rate_paise    BIGINT CHECK (rate_paise IS NULL OR rate_paise >= 0),   -- NULL = base rate
  min_stay      INT    CHECK (min_stay IS NULL OR min_stay BETWEEN 1 AND 30), -- nights, on arrival date
  stop_sell     BOOLEAN NOT NULL DEFAULT FALSE,
  source        TEXT   NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','rate_guard','auto_pilot','undo')),
  updated_by    BIGINT REFERENCES users(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_type_id, date)
);
CREATE INDEX rate_calendar_hotel_date_idx ON rate_calendar (hotel_id, date);

-- Every change to a date's rate / min stay / stop-sell, who made it and why. Used for history and one-click undo.
CREATE TABLE rate_changes (
  id             BIGSERIAL PRIMARY KEY,
  hotel_id       BIGINT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  room_type_id   BIGINT NOT NULL REFERENCES room_types(id) ON DELETE CASCADE,
  date           DATE   NOT NULL,
  old_rate_paise BIGINT,           -- effective rate before (base rate if no calendar row)
  new_rate_paise BIGINT,
  old_min_stay   INT,
  new_min_stay   INT,
  old_stop_sell  BOOLEAN NOT NULL DEFAULT FALSE,
  new_stop_sell  BOOLEAN NOT NULL DEFAULT FALSE,
  old_row        JSONB,            -- the calendar row before (null = no row), restored by undo
  source         TEXT NOT NULL,    -- manual | rate_guard | auto_pilot | undo
  suggestion_id  BIGINT,
  user_id        BIGINT REFERENCES users(id),
  via            TEXT NOT NULL DEFAULT 'dashboard' CHECK (via IN ('dashboard','whatsapp','auto','system')),
  actor_phone    TEXT,
  undone_at      TIMESTAMPTZ,
  undone_by      BIGINT REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX rate_changes_hotel_time_idx ON rate_changes (hotel_id, created_at DESC);
CREATE INDEX rate_changes_day_idx ON rate_changes (room_type_id, date, id DESC);

-- A stay priced from the calendar keeps its own night-by-night rates: { "2026-12-14": 294900, ... }.
-- NULL = every night at nightly_rate_paise (a rate typed by staff, or a booking made before the calendar).
-- nightly_rate_paise then holds the average, for lists and reports.
ALTER TABLE stays ADD COLUMN nightly_rates JSONB;

-- Bookings that came from Google Hotels (free booking links / Hotel Ads landing on the hotel's booking page).
ALTER TABLE bookings DROP CONSTRAINT bookings_source_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_source_check CHECK (source IN (
  'walk_in','phone','direct_online','google','staff','ota','corporate','other',
  'makemytrip','goibibo','oyo','booking_com','agoda','airbnb','expedia','channel_manager'));

-- ---------------------------------------------------------------
-- Rate Guard: watches OTA prices for the hotel on Google Hotels and suggests a direct rate.
-- ---------------------------------------------------------------
CREATE TABLE rate_guard_config (
  hotel_id             BIGINT PRIMARY KEY REFERENCES hotels(id) ON DELETE CASCADE,
  enabled              BOOLEAN NOT NULL DEFAULT FALSE,
  provider             TEXT NOT NULL DEFAULT 'serpapi',     -- serpapi | mock | manual (lib/rateguard/providers)
  property_token       TEXT,                                -- the hotel on Google Hotels (provider's id)
  property_name        TEXT,
  property_address     TEXT,
  undercut_pct         NUMERIC(5,2) NOT NULL DEFAULT 5 CHECK (undercut_pct >= 0 AND undercut_pct <= 50),
  rounding             TEXT NOT NULL DEFAULT '49_99' CHECK (rounding IN ('49_99','99','none')),
  min_change_paise     BIGINT NOT NULL DEFAULT 5000,        -- ignore suggestions smaller than this (₹50)
  mode                 TEXT NOT NULL DEFAULT 'approve' CHECK (mode IN ('approve','auto')),
  auto_max_change_pct  NUMERIC(5,2) NOT NULL DEFAULT 15 CHECK (auto_max_change_pct > 0 AND auto_max_change_pct <= 50),
  alert_phones         TEXT[] NOT NULL DEFAULT '{}',        -- owner / manager numbers that get alerts and may reply YES / NO
  alert_on_increase    BOOLEAN NOT NULL DEFAULT TRUE,
  max_alerts_per_run   INT NOT NULL DEFAULT 3 CHECK (max_alerts_per_run BETWEEN 0 AND 20),
  horizon_days         INT NOT NULL DEFAULT 30 CHECK (horizon_days BETWEEN 1 AND 90),
  near_days            INT NOT NULL DEFAULT 7 CHECK (near_days BETWEEN 0 AND 30),
  near_every_hours     INT NOT NULL DEFAULT 3 CHECK (near_every_hours BETWEEN 1 AND 24),
  far_every_hours      INT NOT NULL DEFAULT 24 CHECK (far_every_hours BETWEEN 1 AND 168),
  adults               INT NOT NULL DEFAULT 2 CHECK (adults BETWEEN 1 AND 6),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- How each room type compares with OTA offers, and its price limits.
CREATE TABLE rate_guard_rooms (
  room_type_id   BIGINT PRIMARY KEY REFERENCES room_types(id) ON DELETE CASCADE,
  hotel_id       BIGINT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  floor_paise    BIGINT NOT NULL CHECK (floor_paise >= 0),
  ceiling_paise  BIGINT NOT NULL CHECK (ceiling_paise >= floor_paise),
  match_keywords TEXT,                       -- words in the OTA room name, comma separated; empty = cheapest room on the OTA
  meal_plan      TEXT NOT NULL DEFAULT 'any' CHECK (meal_plan IN ('any','room_only','breakfast')),
  refundable     TEXT NOT NULL DEFAULT 'any' CHECK (refundable IN ('any','refundable','non_refundable')),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX rate_guard_rooms_hotel_idx ON rate_guard_rooms (hotel_id);

-- One price check: one stay date (1 night) at the data provider.
CREATE TABLE rate_fetch_runs (
  id           BIGSERIAL PRIMARY KEY,
  hotel_id     BIGINT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  stay_date    DATE NOT NULL,
  provider     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','failed')),
  offers       INT NOT NULL DEFAULT 0,
  error        TEXT,
  trigger      TEXT NOT NULL DEFAULT 'schedule' CHECK (trigger IN ('schedule','manual')),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ
);
CREATE INDEX rate_fetch_runs_due_idx ON rate_fetch_runs (hotel_id, stay_date, started_at DESC);

-- OTA offers seen in a price check. Amounts are per night, in paise.
CREATE TABLE rate_observations (
  id                BIGSERIAL PRIMARY KEY,
  hotel_id          BIGINT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  run_id            BIGINT REFERENCES rate_fetch_runs(id) ON DELETE CASCADE,
  stay_date         DATE NOT NULL,
  ota               TEXT NOT NULL,           -- normalised key: makemytrip, goibibo, booking_com, agoda, official…
  ota_name          TEXT NOT NULL,           -- as shown on Google
  room_name         TEXT,
  rate_paise        BIGINT NOT NULL,         -- price shown (usually with taxes)
  pretax_paise      BIGINT NOT NULL,         -- comparable with Wayinn rates (which are before GST)
  breakfast         BOOLEAN,
  refundable        BOOLEAN,
  official          BOOLEAN NOT NULL DEFAULT FALSE,  -- the hotel's own site / Wayinn booking page
  link              TEXT,
  provider          TEXT NOT NULL,
  observed_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX rate_observations_day_idx ON rate_observations (hotel_id, stay_date, observed_at DESC);

CREATE TABLE rate_suggestions (
  id                    BIGSERIAL PRIMARY KEY,
  hotel_id              BIGINT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  room_type_id          BIGINT NOT NULL REFERENCES room_types(id) ON DELETE CASCADE,
  stay_date             DATE NOT NULL,
  code                  TEXT NOT NULL,          -- short code to reply on WhatsApp: YES K7P2
  current_rate_paise    BIGINT NOT NULL,
  suggested_rate_paise  BIGINT NOT NULL,
  ota                   TEXT,
  ota_name              TEXT,
  ota_rate_paise        BIGINT,                 -- as shown (with taxes)
  ota_pretax_paise      BIGINT,
  reason                TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','approved','rejected','superseded','expired','auto_applied')),
  alerted_at            TIMESTAMPTZ,
  decided_at            TIMESTAMPTZ,
  decided_by            BIGINT REFERENCES users(id),
  decided_via           TEXT CHECK (decided_via IN ('dashboard','whatsapp','auto')),
  decided_phone         TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX rate_suggestions_pending_uq ON rate_suggestions (room_type_id, stay_date) WHERE status = 'pending';
CREATE UNIQUE INDEX rate_suggestions_code_uq ON rate_suggestions (hotel_id, code) WHERE status = 'pending';
CREATE INDEX rate_suggestions_hotel_idx ON rate_suggestions (hotel_id, status, stay_date);

-- ---------------------------------------------------------------
-- Google Hotels (Wayne E Solutions is the connectivity partner; one Hotel Center account for all hotels)
-- ---------------------------------------------------------------
CREATE TABLE google_hotels (
  hotel_id      BIGINT PRIMARY KEY REFERENCES hotels(id) ON DELETE CASCADE,
  enabled       BOOLEAN NOT NULL DEFAULT FALSE,     -- listed in the hotel list feed and receiving ARI
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','testing','live','paused')),
  property_id   TEXT NOT NULL UNIQUE,               -- Hotel ID in the feed. Never reused, never changed.
  latitude      NUMERIC(9,6),
  longitude     NUMERIC(9,6),
  postal_code   TEXT,
  category      TEXT NOT NULL DEFAULT 'hotel',
  refundable_days INT CHECK (refundable_days IS NULL OR refundable_days BETWEEN 0 AND 30), -- free cancellation until N days before; NULL = non-refundable
  breakfast_included BOOLEAN NOT NULL DEFAULT FALSE,
  photo_urls    TEXT[] NOT NULL DEFAULT '{}',
  sync_days     INT NOT NULL DEFAULT 365 CHECK (sync_days BETWEEN 30 AND 500),
  last_sync_at  TIMESTAMPTZ,
  last_error    TEXT,
  property_data_sent_at TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- What Google was last told for each room type and night, so only changes are sent.
CREATE TABLE google_ari_state (
  hotel_id         BIGINT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  room_type_id     BIGINT NOT NULL REFERENCES room_types(id) ON DELETE CASCADE,
  date             DATE NOT NULL,
  rate_paise       BIGINT,
  after_tax_paise  BIGINT,
  available        INT,
  min_stay         INT,
  closed           BOOLEAN,
  sent_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_type_id, date)
);
CREATE INDEX google_ari_state_hotel_idx ON google_ari_state (hotel_id, date);

CREATE TABLE google_ari_log (
  id          BIGSERIAL PRIMARY KEY,
  hotel_id    BIGINT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  message     TEXT NOT NULL,    -- rate | avail | inv_count | property_data
  status      TEXT NOT NULL CHECK (status IN ('sent','failed','dry_run')),
  items       INT NOT NULL DEFAULT 0,
  echo_token  TEXT,
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX google_ari_log_hotel_idx ON google_ari_log (hotel_id, created_at DESC);
