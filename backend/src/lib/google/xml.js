// XML messages for Google Hotels (ARI = Availability, Rates, Inventory), the Transaction (Property Data)
// message and the hotel list feed. References:
//   https://developers.google.com/hotels/hotel-prices/xml-reference/ari-rate
//   https://developers.google.com/hotels/hotel-prices/xml-reference/ari-avail
//   https://developers.google.com/hotels/hotel-prices/xml-reference/ari-property
//   https://developers.google.com/hotels/hotel-prices/xml-reference/hotel-list-feed
// One rate plan per room type: "BAR" (best available rate, room only unless the hotel includes breakfast).
import { addDays } from '../dates.js';

export const RATE_PLAN = 'BAR';
const NS = 'http://www.opentravel.org/OTA/2003/05';

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const money = (paise) => (Number(paise) / 100).toFixed(2);
const pos = (partnerKey) => (partnerKey ? `<POS><Source><RequestorID ID="${esc(partnerKey)}"/></Source></POS>` : '');
const head = (root, echo, extra = '') => `<?xml version="1.0" encoding="UTF-8"?>\n<${root} xmlns="${NS}" EchoToken="${esc(echo)}" TimeStamp="${new Date().toISOString()}" Version="3.0"${extra}>`;

/**
 * Merge consecutive dates of one room type that carry the same values into ranges.
 * rows: [{ room_type_id, date, ...values }] → [{ room_type_id, start, end, ...values }] (end inclusive).
 */
export function toRanges(rows, keys) {
  const sorted = [...rows].sort((a, b) => Number(a.room_type_id) - Number(b.room_type_id) || (a.date < b.date ? -1 : 1));
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && last.room_type_id === r.room_type_id && addDays(last.end, 1) === r.date && keys.every((k) => last[k] === r[k])) last.end = r.date;
    else out.push({ room_type_id: r.room_type_id, start: r.date, end: r.date, ...Object.fromEntries(keys.map((k) => [k, r[k]])) });
  }
  return out;
}

/** OTA_HotelRateAmountNotifRQ. items: [{ room_type_id, start, end, rate_paise, after_tax_paise, guests, extra_adult_paise }] */
export function rateAmountXml({ partnerKey, hotelCode, echo, currency = 'INR', items }) {
  const msgs = items.map((i) => `
    <RateAmountMessage>
      <StatusApplicationControl Start="${i.start}" End="${i.end}" InvTypeCode="${esc(i.room_type_id)}" RatePlanCode="${RATE_PLAN}"/>
      <Rates>
        <Rate>
          <BaseByGuestAmts>
            <BaseByGuestAmt AmountBeforeTax="${money(i.rate_paise)}" AmountAfterTax="${money(i.after_tax_paise)}" CurrencyCode="${currency}" NumberOfGuests="${i.guests || 2}"/>
          </BaseByGuestAmts>${i.extra_adult_paise ? `
          <AdditionalGuestAmounts>
            <AdditionalGuestAmount Amount="${money(i.extra_adult_paise)}" AgeQualifyingCode="10"/>
          </AdditionalGuestAmounts>` : ''}
        </Rate>
      </Rates>
    </RateAmountMessage>`).join('');
  return `${head('OTA_HotelRateAmountNotifRQ', echo, ' NotifType="Delta" NotifScopeType="ProductRate"')}
  ${pos(partnerKey)}
  <RateAmountMessages HotelCode="${esc(hotelCode)}">${msgs}
  </RateAmountMessages>
</OTA_HotelRateAmountNotifRQ>
`;
}

/** OTA_HotelAvailNotifRQ: open / closed (stop-sell) and minimum stay on arrival. items: [{ room_type_id, start, end, closed, min_stay }] */
export function availXml({ partnerKey, hotelCode, echo, items }) {
  const msgs = items.map((i) => `
    <AvailStatusMessage>
      <StatusApplicationControl Start="${i.start}" End="${i.end}" InvTypeCode="${esc(i.room_type_id)}" RatePlanCode="${RATE_PLAN}"/>
      <LengthsOfStay>
        <LengthOfStay MinMaxMessageType="SetMinLOS" Time="${Math.max(1, Number(i.min_stay) || 1)}" TimeUnit="Day"/>
      </LengthsOfStay>
      <RestrictionStatus Restriction="Master" Status="${i.closed ? 'Close' : 'Open'}"/>
    </AvailStatusMessage>`).join('');
  return `${head('OTA_HotelAvailNotifRQ', echo)}
  ${pos(partnerKey)}
  <AvailStatusMessages HotelCode="${esc(hotelCode)}">${msgs}
  </AvailStatusMessages>
</OTA_HotelAvailNotifRQ>
`;
}

/** OTA_HotelInvCountNotifRQ: rooms left to sell per room type. items: [{ room_type_id, start, end, available }] */
export function invCountXml({ partnerKey, hotelCode, echo, items }) {
  const inv = items.map((i) => `
    <Inventory>
      <StatusApplicationControl Start="${i.start}" End="${i.end}" InvTypeCode="${esc(i.room_type_id)}"/>
      <InvCounts>
        <InvCount Count="${Math.max(0, Number(i.available) || 0)}" CountType="2"/>
      </InvCounts>
    </Inventory>`).join('');
  return `${head('OTA_HotelInvCountNotifRQ', echo)}
  ${pos(partnerKey)}
  <Inventories HotelCode="${esc(hotelCode)}">${inv}
  </Inventories>
</OTA_HotelInvCountNotifRQ>
`;
}

/** Transaction (Property Data): room types and the BAR package. */
export function propertyDataXml({ partnerKey, hotelCode, id, rooms, pkg }) {
  const roomXml = rooms.map((r) => `
    <RoomData>
      <RoomID>${esc(r.id)}</RoomID>
      <Name><Text text="${esc(r.name)}" language="en"/></Name>${r.description ? `
      <Description><Text text="${esc(r.description)}" language="en"/></Description>` : ''}
      <Capacity>${Number(r.capacity) || 2}</Capacity>${(r.photos || []).map((u) => `
      <PhotoURL><URL>${esc(u)}</URL></PhotoURL>`).join('')}
    </RoomData>`).join('');
  const refundable = pkg.refundable_days === null || pkg.refundable_days === undefined
    ? '<Refundable available="false"/>'
    : `<Refundable available="true" refundable_until_days="${Number(pkg.refundable_days)}" refundable_until_time="${esc(pkg.refundable_until_time || '12:00:00')}"/>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Transaction timestamp="${new Date().toISOString()}" id="${esc(id)}"${partnerKey ? ` partner="${esc(partnerKey)}"` : ''}>
  <PropertyDataSet action="overlay">
    <Property>${esc(hotelCode)}</Property>${roomXml}
    <PackageData>
      <PackageID>${RATE_PLAN}</PackageID>
      <Name><Text text="${esc(pkg.name || 'Best available rate')}" language="en"/></Name>
      <Description><Text text="${esc(pkg.description || 'Book direct with the hotel')}" language="en"/></Description>
      ${refundable}
      <BreakfastIncluded>${pkg.breakfast ? 1 : 0}</BreakfastIncluded>
      <InternetIncluded>${pkg.internet ? 1 : 0}</InternetIncluded>
    </PackageData>
  </PropertyDataSet>
</Transaction>
`;
}

/** Hotel list feed (Google fetches it from us). listings: [{ id, name, address, city, state, postal_code, country, lat, lng, phone, category }] */
export function hotelListXml(listings) {
  const items = listings.map((l) => `
  <listing>
    <id>${esc(l.id)}</id>
    <name>${esc(l.name)}</name>
    <address format="simple">
      <component name="addr1">${esc(l.address || '')}</component>
      <component name="city">${esc(l.city || '')}</component>
      <component name="province">${esc(l.state || '')}</component>
      <component name="postal_code">${esc(l.postal_code || '')}</component>
    </address>
    <country>${esc(l.country || 'IN')}</country>${l.lat !== null && l.lat !== undefined ? `
    <latitude>${Number(l.lat).toFixed(6)}</latitude>
    <longitude>${Number(l.lng).toFixed(6)}</longitude>` : ''}${l.phone ? `
    <phone type="main">${esc(l.phone)}</phone>` : ''}
    <category>${esc(l.category || 'hotel')}</category>
  </listing>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<listings xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.gstatic.com/localfeed/local_feed.xsd">
  <language>en</language>${items}
</listings>
`;
}

/** Google's reply: <Success/> or <Errors><Error ...>text</Error></Errors>. */
export function parseResponse(text) {
  const t = String(text || '');
  if (/<Success\s*\/?>/i.test(t)) return { ok: true };
  const errs = [...t.matchAll(/<Error\b([^>]*)>([\s\S]*?)<\/Error>/gi)].map((m) => {
    const short = /ShortText="([^"]*)"/.exec(m[1])?.[1];
    return `${short ? `${short}: ` : ''}${m[2].trim()}`.slice(0, 300);
  });
  // Transaction (Property Data) replies with <TransactionResponse> and <Issues> instead.
  if (/<TransactionResponse/i.test(t) && !/<Issue\b[^>]*status="failure"/i.test(t)) return { ok: true };
  return { ok: false, error: errs.join('; ') || t.slice(0, 300) || 'Empty reply' };
}
