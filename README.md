# Wayinn — Hotel Operating System

Cloud hotel software by **Wayne E Solutions** for independent and budget hotels (up to 50 rooms):
reservations, front desk, guest folios & GST invoices, restaurant POS + KOT, in-room QR guest portal,
housekeeping, maintenance, staff permissions, owner reports, rule-based alerts, and a multi-tenant
super-admin console.

```
backend/   Node 20 + Express 5 + PostgreSQL (plain SQL migrations, no ORM)
frontend/  React 18 + Vite + Tailwind — staff app, guest QR portal (/g/:token), booking page (/book/:slug), super admin (/platform)
deploy/    PM2 + nginx samples
```

## Quick start (local)

```bash
# 1. Database
createdb wayinn                       # or use a Neon database URL

# 2. API
cd backend
cp .env.example .env                  # set DATABASE_URL, JWT_SECRET
npm install
npm run migrate
npm run seed                          # plans, super admin, demo hotel, staff, rooms, menu
npm run demo-data                     # optional: a realistic "today" (guests in house, orders, tasks)
npm run dev                           # http://localhost:4000

# 3. Frontend
cd ../frontend
npm install
npm run dev                           # http://localhost:5173 (proxies /api → :4000)
```

Demo logins (password `Wayinn@123`):

| Who | Email |
|---|---|
| Super admin (`/platform`) | admin@wayinn.app |
| Owner | owner@demo-hotel.in |
| Front desk (reception, billing, POS, housekeeping, maintenance) | frontdesk@demo-hotel.in (fresh seed). On the live demo server this login is `reception@demo-hotel.in` |
| Kitchen | kitchen@demo-hotel.in |

Before a client demo, remove leftover test data (test guests/bookings created by e2e runs) from the demo hotel. Take a database backup first, then:

```bash
cd backend
npm run cleanup-demo            # dry run: lists what would be removed
npm run cleanup-demo -- --apply # actually removes it
```

Tests (end-to-end against a real database, after migrate + seed): `cd backend && npm test`

> ⚠️ Run tests and `demo-data` only against a local/dev database — they create test hotels and reset the demo hotel's live stays. Never point them at production.

## How the important parts work

- **Multi-tenant**: every table carries `hotel_id`; the hotel is derived from the logged-in user on every request, never from the client. Suspended/cancelled subscriptions get HTTP 402.
- **No double booking**: a Postgres exclusion constraint (`stays_no_overlap`) makes it impossible to store two live stays in the same room on overlapping nights, even under concurrent requests. Unassigned bookings still consume room-type inventory, so a type cannot be oversold.
- **Money** is stored as integer paise. Financial records are append-only: discounts are negative lines, voids/refunds are flagged with who/why — nothing is silently overwritten. Every sensitive action writes to `audit_logs`.
- **Room charges** post per night (on check-in, by the automatic night audit every 30 min, and at checkout), guarded by a unique index so a night can never be charged twice. Early departure voids unused nights.
- **GST**: room slabs (default ≤ ₹7,500 → 5%, above → 18%), food 5%, services 18% — all configurable per hotel in Setup. Invoices show SAC codes and CGST/SGST or IGST split. Have the hotel's accountant confirm settings.
- **Guest QR portal**: each room has a secret QR token. Anyone with the QR sees only the menu and can raise service requests while the room is occupied. Food can be ordered with just the QR, but only while a guest is checked in to that room — an empty room's QR cannot order. The order goes straight to the kitchen (ticket prints on its own) and onto the room bill; the front desk only sees a notice. Seeing the bill and order history requires the check-in PIN or last 4 digits of the booking phone; that session dies at checkout. Hotels that want staff to accept QR orders first can switch that on in Setup.
- **Roles**: three — **Owner** (everything), **Front desk** (reservations, check-in/out, billing, POS, housekeeping, maintenance, guest requests) and **Kitchen** (one screen: incoming tickets and a *Delivered* button). The owner can grant or revoke any of ~38 permissions per person (refunds, voids, rate overrides, discounts are owner-only by default). Give each person their own login so the activity log shows who did what.
- **Kitchen**: new tickets print automatically. Two ways: **direct** to a USB / serial / Bluetooth thermal printer (Kitchen screen → Printer → Connect; Chrome or Edge, ESC/POS, 58 or 80 mm, no dialog), or **browser print** (start Chrome with `--kiosk-printing` and the thermal printer as default to skip the dialog). On Windows the printer's own driver holds the USB port, so use the serial/Bluetooth option or browser print there. The kitchen cannot cancel: if an order can't be made they tell the front desk, who cancels the order or removes the item, which also takes the charge off the room bill and shows a *cancelled — stop* notice in the kitchen.
- **Alerts** (advisory, humans decide): overdue housekeeping, rooms not ready for arrivals, stuck/unbilled orders, missing room charges, overstays, unpaid checkouts, unusual discounts, repeated voids/refunds/cancellations.
- **Messages (WhatsApp / SMS / email)**: see "Messages, payments and OTAs" below.

## Deploy (EC2, same pattern as our other products)

```bash
cd backend && npm ci && npm run migrate && pm2 start ../deploy/ecosystem.config.cjs
cd ../frontend && npm ci && npm run build && sudo cp -r dist/. /var/www/wayinn/
# nginx: see deploy/nginx.conf, then certbot for HTTPS
```
Set `PUBLIC_APP_URL` to the public frontend URL (used inside room QR codes) and `DATABASE_SSL=true` for Neon.

## Messages, payments and OTAs

Every hotel uses **its own** WhatsApp number, MSG91 account, SMTP mailbox and Razorpay account. The super admin adds the keys in `/platform` → hotel → *Hotel's own keys* (secrets are stored in `hotel_integrations`, shown back only as `••••last4`, never sent to hotel staff). The owner switches things on in **Setup → Messages & payments** and **Setup → Online channels**. A hotel without keys sends nothing (no shared Wayinn number).

**WhatsApp / SMS / email.** Messages are queued in `notifications_outbox` and sent by the outbox worker, which runs inside the API every 30 s (`OUTBOX_IN_API=false` to turn that off and run `npm run outbox -- --watch` as its own PM2 process; `npm run outbox` does one pass). Temporary errors are retried 5 times (1, 5, 30, 120, 360 min); errors that cannot get better (template not approved, bad number) fail at once. The owner sees every message and its status in Setup → Messages & payments.

Create these **Utility** templates in the hotel's WhatsApp Manager, language `en` (names and the order of `{{n}}` must match):

| Template | Text |
|---|---|
| `booking_confirmation` | Dear {{1}}, your booking at {{2}} is confirmed. Booking ID: {{3}}. Check-in: {{4}}. Check-out: {{5}}. We look forward to hosting you. |
| `checkin_welcome` | Welcome to {{2}}, {{1}}! You are in room {{3}}. Scan the QR code in your room to order food, ask for help or see your bill. Your PIN is {{4}}. |
| `deposit_received` | Dear {{1}}, we have received your advance payment of {{2}} for booking {{3}} at {{4}}. Thank you. |
| `room_checkout_alert` | Room {{1}} at {{2}} has just checked out. {{3}} |

For SMS (MSG91 Flow), register the same texts as DLT templates with variables `##var1##`, `##var2##`… and paste each flow/template id in the super-admin form.

**Checkout alert.** Housekeeping and maintenance have no login. The owner enters their mobile numbers (Setup → Messages & payments); on every checkout each number gets `room_checkout_alert` with the room, whether a guest arrives in it today, and how many maintenance issues are open on it. The cleaning task in Housekeeping is created as before.

**Razorpay advance.** Setup → Messages & payments → *Advance payment*: off, first night, a percentage, or the full stay (room + GST). The booking page then opens Razorpay Checkout; the payment is verified by signature, the advance is added to the bill (method *online*, reference = Razorpay payment id) and the booking is **confirmed automatically** if rooms are still free (otherwise it stays a request with a note to call the guest). Add the webhook shown in the super-admin form to the hotel's Razorpay dashboard (events `payment.captured`, `order.paid`) so a guest who closes the page after paying is still recorded. Refunds are still done in Razorpay's dashboard and recorded on the bill by the front desk.

**OTAs (MakeMyTrip, Goibibo, OYO, Booking.com, Agoda, Airbnb, Expedia).** These sites only connect through approved channel managers (STAAH, eZee, AxisRooms, RateGain…). The hotel signs up with one; the channel manager calls the API below with the key from Setup → Online channels. For sites that accept a calendar link (Airbnb, Booking.com), Setup → Online channels also gives one iCal link per room type with the sold-out nights.

### Channel-manager API

Base: `https://<your domain>/api/channel/v1`, header `x-api-key: wyn_…`. Money is in paise, dates `YYYY-MM-DD`. Limit 120 calls/minute.

| Call | What it does |
|---|---|
| `GET /room-types` | Room types with id, occupancy, base rate, number of rooms |
| `GET /availability?from=&to=` | Rooms free per room type for each night (max 90 nights) |
| `POST /bookings` | New booking: `{ channel, external_ref, guest: {full_name, phone, email}, rooms: [{room_type_id, adults, children, nightly_rate_paise}], check_in_date, check_out_date, paid_to_ota_paise, special_requests }`. `channel` is one of `makemytrip, goibibo, oyo, booking_com, agoda, airbnb, expedia, channel_manager`. Sending the same `channel` + `external_ref` again returns the existing booking (`duplicate: true`). 409 if the rooms are no longer free. |
| `PATCH /bookings/:channel/:external_ref` | Change dates `{ check_in_date, check_out_date }` (before check-in only) |
| `POST /bookings/:channel/:external_ref/cancel` | Cancel `{ reason }` (before check-in only; repeat calls are fine) |
| `GET /bookings/:channel/:external_ref` | Read one booking |

OTA bookings show in Wayinn with the OTA's name as the source and the OTA reference on the booking. A prepaid amount is recorded as an online payment so the desk does not collect it again.

## What's in / what's next

**In:** PMS (rooms, rates, calendar, walk-ins, reservations, groups, check-in/out, early/late, room moves, cancellations, no-shows, deposits, refunds), guest profiles, folios & GST invoices, split/partial payments, restaurant POS (dine-in/takeaway/room service, variants, add-ons, stations, KOT print, complimentary, discounts), kitchen display with direct ESC/POS printing, QR guest portal, housekeeping & maintenance & lost-and-found, checkout alerts to staff phones, staff & permissions, shift handover, owner dashboard & CSV reports, alerts & daily summary, WhatsApp / SMS / email messages, direct-booking page with Razorpay advance, channel-manager API and iCal links for OTAs, super-admin (onboarding, plans, limits, per-hotel keys, support login, data export).

**Not built yet:** AI replies to guest enquiries, CSV import tools, offline mode, network (LAN / Wi-Fi) printers from the kitchen screen, iCal *import* (reading other sites' calendars), automatic refunds through Razorpay. Rates and room counts are not pushed to OTAs: the channel manager reads them from the API.
