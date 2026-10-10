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
| Manager / Reception / Cashier | manager@ / reception@ / cashier@demo-hotel.in |
| Restaurant / Kitchen | restaurant@ / kitchen@demo-hotel.in |
| Housekeeping / Maintenance | hk@ / maintenance@demo-hotel.in |

Tests (end-to-end against a real database, after migrate + seed): `cd backend && npm test`

> ⚠️ Run tests and `demo-data` only against a local/dev database — they create test hotels and reset the demo hotel's live stays. Never point them at production.

## How the important parts work

- **Multi-tenant**: every table carries `hotel_id`; the hotel is derived from the logged-in user on every request, never from the client. Suspended/cancelled subscriptions get HTTP 402.
- **No double booking**: a Postgres exclusion constraint (`stays_no_overlap`) makes it impossible to store two live stays in the same room on overlapping nights, even under concurrent requests. Unassigned bookings still consume room-type inventory, so a type cannot be oversold.
- **Money** is stored as integer paise. Financial records are append-only: discounts are negative lines, voids/refunds are flagged with who/why — nothing is silently overwritten. Every sensitive action writes to `audit_logs`.
- **Room charges** post per night (on check-in, by the automatic night audit every 30 min, and at checkout), guarded by a unique index so a night can never be charged twice. Early departure voids unused nights.
- **GST**: room slabs (default ≤ ₹7,500 → 5%, above → 18%), food 5%, services 18% — all configurable per hotel in Setup. Invoices show SAC codes and CGST/SGST or IGST split. Have the hotel's accountant confirm settings.
- **Guest QR portal**: each room has a secret QR token. Anyone with the QR sees only the menu and can raise service requests while the room is occupied. Ordering to the room and seeing the bill requires the check-in PIN or last 4 digits of the booking phone; the guest session dies at checkout. QR orders wait for staff acceptance by default.
- **Permissions**: 8 roles with sensible defaults, plus per-person grant/revoke of ~38 permissions (refunds, voids, rate overrides, discounts…).
- **Alerts** (advisory, humans decide): overdue housekeeping, rooms not ready for arrivals, stuck/unbilled orders, missing room charges, overstays, unpaid checkouts, unusual discounts, repeated voids/refunds/cancellations.
- **Notifications**: booking confirmation / check-in welcome are queued in `notifications_outbox`; nothing is sent until a provider (WhatsApp Cloud API / SMS / email) is wired and enabled per hotel.

## Deploy (EC2, same pattern as our other products)

```bash
cd backend && npm ci && npm run migrate && pm2 start ../deploy/ecosystem.config.cjs
cd ../frontend && npm ci && npm run build && sudo cp -r dist/. /var/www/wayinn/
# nginx: see deploy/nginx.conf, then certbot for HTTPS
```
Set `PUBLIC_APP_URL` to the public frontend URL (used inside room QR codes) and `DATABASE_SSL=true` for Neon.

## Release 1 — what's in / what's next

**In:** PMS (rooms, rates, calendar, walk-ins, reservations, groups, check-in/out, early/late, room moves, cancellations, no-shows, deposits, refunds), guest profiles, folios & GST invoices, split/partial payments, restaurant POS (dine-in/takeaway/room service, variants, add-ons, stations, KOT print, complimentary, discounts), kitchen display, QR guest portal, housekeeping & maintenance & lost-and-found, staff & permissions, shift handover, owner dashboard & CSV reports, alerts & daily summary, direct-booking request page, super-admin (onboarding, plans, limits, support login, data export).

**Next (needs third-party decisions):** WhatsApp/SMS/email provider worker, Razorpay deposits on the booking page, OTA/channel manager, AI enquiry replies, CSV import tools, ESC/POS direct printing, offline mode.
