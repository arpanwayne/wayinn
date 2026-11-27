# Handover: Rate Guard deployment

Wayinn + Rate Guard (rate calendar, OTA rate monitor with WhatsApp approvals, Google Hotels).
Merged to `main` from PR #14 (`feature/rate-guard`). Prepared 27 Nov 2026.

---

## 1. What this release adds

| Part | Who can use it | Needs outside setup? |
|---|---|---|
| **Rate calendar**: date-wise rate, minimum stay, stop-sell per room type (Rates → Rate calendar) | Every hotel, no add-on | No |
| **Rate Guard**: OTA price checks, suggested direct rate, WhatsApp YES/NO approval, auto mode, monthly report | Hotels where the super admin has switched on the add-on | SerpApi key, 2 WhatsApp templates |
| **Google Hotels**: hotel list feed, landing page, rates / availability / inventory push | Same add-on | Google Hotel Center partner account |

Things that change for **every** hotel after deploy:
- Room rates now come from the rate calendar. A date with no calendar entry uses the base rate, so nothing changes until someone sets a date rate.
- The bill charges each night at that night's rate, with that night's GST slab.
- Bookings made before this release keep their price.
- The channel-manager API (`/availability`) now also returns `rate_paise`, `min_stay` and `stop_sell` per night, and there is a new `GET /channel/v1/rates`. This is backward compatible: only fields were added.
- Front desk staff can see the rate calendar. Only the owner can change it (new permission `rates.manage`).

---

## 2. Before you deploy

1. **Back up the production database.** The migration is additive, but take a backup anyway.
   ```bash
   pg_dump "$DATABASE_URL" -Fc -f wayinn-before-rate-guard-$(date +%F).dump
   ```
2. Check that the server runs Node 20 or newer: `node -v`.
3. Make sure only **one** API process runs background jobs. The PM2 config already uses `instances: 1`. Any extra instance must have `RUN_JOBS=false`, otherwise price checks and Google pushes run twice.

---

## 3. Deploy steps (EC2, same as before)

```bash
cd /path/to/wayinn && git pull origin main

# API
cd backend && npm ci && npm run migrate        # applies 010_rate_calendar_rate_guard.sql
pm2 restart wayinn-api                         # or: pm2 start ../deploy/ecosystem.config.cjs

# Frontend
cd ../frontend && npm ci && npm run build && sudo cp -r dist/. /var/www/wayinn/
```

`npm run migrate` should print `applied 010_rate_calendar_rate_guard.sql`. No nginx changes are needed: all new endpoints are under `/api/`.

### What the migration does
- New tables: `rate_calendar`, `rate_changes`, `rate_guard_config`, `rate_guard_rooms`, `rate_fetch_runs`, `rate_observations`, `rate_suggestions`, `google_hotels`, `google_ari_state`, `google_ari_log`.
- New column `stays.nightly_rates` (JSONB, nullable).
- `bookings.source` now also allows `google`.
- It does not touch or delete any existing data.

---

## 4. Environment variables (`backend/.env`)

All of these are optional. Without them the app works and the related feature simply stays off.

| Variable | Needed for | Notes |
|---|---|---|
| `SERPAPI_KEY` | Automatic OTA price checks | Wayne E Solutions' SerpApi account. Without it, hotels can still use the "Typed in by hand" price source. |
| `RATE_GUARD_TICK_MIN` | | Default 10. How often the scheduler looks for checks that are due. |
| `RATE_GUARD_JOBS` | | Set to `false` to stop all automatic price checks (emergency off switch). |
| `GOOGLE_HOTEL_PARTNER_KEY` | Google Hotels | From Hotel Center → Account settings. **Without it nothing is sent to Google (dry run).** |
| `GOOGLE_FEED_TOKEN` | Google hotel list feed | Any long random string, e.g. `openssl rand -hex 24`. It goes into the feed URL. |
| `GOOGLE_SYNC_MIN` | | Default 10. How often the full Google sync runs. |
| `RATE_GUARD_ALLOW_MOCK` | | Only for a demo server. Shows "Demo prices" as a provider in production. Never use it for a real hotel. |

Restart after changing: `pm2 restart wayinn-api --update-env`.

---

## 5. Smoke test after deploy (about 5 minutes)

1. `curl https://<domain>/api/health` returns `ok: true`.
2. Log in as an owner and open **Rates**. The calendar shows the base rates.
3. Set a rate for one future date, then open `/book/<slug>` for that date. The booking page shows the new price. Go back to Rates → History & report and **Undo** the change.
4. As front desk, create a test booking. The total uses the calendar price. Cancel it afterwards.
5. Super admin → **Rate Guard & Google** tab loads, and the key badges show *Set* or *Not set* as expected.
6. `pm2 logs wayinn-api` shows no repeating `rate guard failed` or `google sync failed` errors.

---

## 6. Switching Rate Guard on for a pilot hotel

**Super admin**
1. Super admin → *Rate Guard & Google* → tick **Rate Guard add-on** for the hotel.
2. Make sure the hotel's WhatsApp keys are filled in (*Hotel's own keys*). Without them, alerts cannot be sent, but approvals still work on the dashboard.

**In the hotel's WhatsApp Manager**, create these two **Utility** templates, language `en`, with the text exactly as written:

| Name | Text |
|---|---|
| `rate_alert` | Rate Guard, {{1}}: {{2}} now shows {{3}} for {{4}} on {{5}}. Suggested direct rate {{6}} + GST. Reply YES {{7}} to approve or NO {{7}} to skip. |
| `rate_alert_summary` | Rate Guard, {{1}}: {{2}} new rate suggestions for {{3}} to {{4}}. Open Wayinn, Rates, Rate Guard to review them, or reply YES ALL to approve all. |

**Owner** (Rates → Rate Guard → Setup, or do it during support login):
1. Choose the price source: **Google Hotels (SerpApi)**, then search for the hotel and click **This is my hotel**.
2. Rules: the defaults are 5% below the cheapest OTA, ₹…49/…99 rounding and "I approve every change".
3. WhatsApp numbers: the owner's number. Only these numbers can approve by replying YES.
4. Room types: set a floor and a ceiling price for each type. "Matches OTA rooms named" should be empty for the cheapest type and the room name (e.g. `deluxe`) for the others.
5. Tick **Rate Guard on** and save. Then click **Check OTA prices now** once and check that the OTA prices in the table look right.

> **First real check:** the SerpApi response parser was written from SerpApi's documented fields and has not yet been run against a live response. On the first pilot hotel, compare the dashboard prices with what Google Hotels shows in a browser for 2–3 dates. If prices are missing or wrong, the fix is in `backend/src/lib/rateguard/providers/serpapi.js` (`parseProperty`).

---

## 7. Google Hotels onboarding (one time for Wayne E Solutions, then per hotel)

**One time, in Hotel Center** (after the Connectivity Partner form and the Content Licensing Agreement):
1. Put the partner key into `GOOGLE_HOTEL_PARTNER_KEY`.
2. **Hotel list:** use the pull method with the feed URL shown in Super admin → Rate Guard & Google, i.e. `https://<domain>/api/google/hotel-list.xml?token=<GOOGLE_FEED_TOKEN>`.
3. **Landing page template** (also shown on that tab):
   `https://<domain>/api/google/landing?hotel=(PARTNER-HOTEL-ID)&checkin=(CHECKINYEAR)-(CHECKINMONTH)-(CHECKINDAY)&nights=(LENGTH)&room=(PARTNER-ROOM-ID)`
4. **Allowlist the API server's public IP** for ARI pushes. Google accepts pushes only from listed IPs.
5. In Pricing → Settings, the default availability can stay "closed". Wayinn sends an explicit Open/Close for every night.

**Per hotel:**
1. Owner fills in Rates → **Google Hotels**: map location, PIN code, cancellation terms. Address and phone come from Setup → Hotel profile. Then tick *Show my hotel on Google*.
2. Super admin sets the Google status: `draft` → `testing`. Wayinn then sends the room data and rates automatically.
3. Wait for Google's pre-launch price checks. If Google reports price mismatches, look at the **Messages to Google** log on the hotel's Google tab.
4. When Google approves, set the status to `live`. Use `paused` to stop sending.

The hotel ID on Google is `WAYINN<hotel id>`. It is permanent: do not change it and do not reuse it.

---

## 8. Data cost: decide before selling

With the default schedule, each hotel uses about **79 SerpApi searches a day (~2,400 a month)**: the next 7 days are checked every 3 hours (56) and days 8–30 once a day (23).

The plan assumed about ₹520 per hotel per month in data cost. At SerpApi's prices, 2,400 searches will likely cost more than that. Before selling, either:
- compare data providers (adding a provider is one file in `backend/src/lib/rateguard/providers/`), or
- reduce the schedule per hotel in Setup → "How often", e.g. the next 7 days every 6 hours and the rest every 48 hours.

A manual "Check OTA prices now" uses one search per day checked (7 by default), and is limited to 10 checks an hour per hotel.

---

## 9. Where to look when something is wrong

| Symptom | Look at |
|---|---|
| No price checks | Rates → Rate Guard → *Recent price checks* (error text), `pm2 logs wayinn-api`, `SERPAPI_KEY` set?, add-on on?, hotel linked? |
| Owner gets no WhatsApp alert | Setup → Messages & payments → message log (`rate_alert` status), hotel's WhatsApp keys, templates approved by Meta |
| YES reply does nothing | The replying number must be in Rate Guard → WhatsApp numbers; the code must still be open (newer prices replace old suggestions) |
| Google not updating | Rates → Google Hotels → *Messages to Google*; status must be testing/live; `GOOGLE_HOTEL_PARTNER_KEY` set; server IP allowlisted |
| Wrong price on a booking | Rates → History & report shows who changed which date and when |

Useful SQL:
```sql
SELECT * FROM rate_fetch_runs   WHERE hotel_id = <id> ORDER BY id DESC LIMIT 20;
SELECT * FROM rate_suggestions  WHERE hotel_id = <id> AND status = 'pending';
SELECT * FROM google_ari_log    WHERE hotel_id = <id> ORDER BY id DESC LIMIT 20;
```

**Emergency stops:**
- `RATE_GUARD_JOBS=false` stops all price checks.
- Untick the hotel's add-on to stop Rate Guard and Google for that hotel.
- Set the Google status to `paused` to stop pushing to Google.

---

## 10. Rollback

Redeploy the previous commit (`6d94b67`) for the API and the frontend. **No database rollback is needed**: the old code ignores the new tables and the new column.

One side effect: bookings made after this release with prices that vary by night would, under the old code, be billed every night at their **average** rate.

Restore the backup only if something went wrong with the data itself.

---

## 11. Open decisions (from the plan, not code)

- Which 2 hotels will be the pilots.
- The Rate Guard add-on price and the Wayinn monthly plan price.
- The final price data provider (see section 8).
- The company name and email for the Google partner form.

## 12. Code map

| Area | Files |
|---|---|
| Migration | `backend/migrations/010_rate_calendar_rate_guard.sql` |
| Rate calendar | `backend/src/lib/rates.js`, `backend/src/routes/rates.js` |
| Rate Guard | `backend/src/lib/rateguard/` (engine, rules, providers), `backend/src/routes/rateguard.js`, YES/NO replies in `backend/src/lib/inbound.js` |
| Google | `backend/src/lib/google/` (xml, sync), `backend/src/routes/google.js` |
| Background jobs | `backend/src/lib/jobs.js` |
| UI | `frontend/src/pages/Rates.jsx`, Super admin tab in `frontend/src/pages/Platform.jsx` |
| Tests | `backend/test/rates.test.js` (17 tests; full suite 44/44) |
