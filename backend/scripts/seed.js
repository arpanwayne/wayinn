// Seeds plans, a platform admin and a demo hotel with staff, rooms and menu.
// Usage: npm run seed            (idempotent: skips if the demo hotel exists)
import bcrypt from 'bcryptjs';
import { pool, tx } from '../src/db.js';

const PASSWORD = process.env.SEED_PASSWORD || 'Wayinn@123';

async function main() {
  const hash = await bcrypt.hash(PASSWORD, 10);
  await tx(async (db) => {
    await db.query(
      `INSERT INTO plans (code, name, max_rooms, max_staff, price_monthly_paise, features) VALUES
         ('starter','Starter',15,8,149900,'{"pos":true,"qr":true}'),
         ('growth','Growth',30,20,249900,'{"pos":true,"qr":true,"online_booking":true}'),
         ('pro','Pro',50,40,399900,'{"pos":true,"qr":true,"online_booking":true,"ai":true}')
       ON CONFLICT (code) DO NOTHING`);
    await db.query(
      `INSERT INTO platform_admins (name, email, password_hash) VALUES ('Wayne E Solutions Admin','admin@wayinn.app',$1)
       ON CONFLICT (email) DO NOTHING`, [hash]);

    if (await db.one(`SELECT id FROM hotels WHERE slug = 'demo-hotel'`)) {
      console.log('Demo hotel exists — skipping hotel seed');
      return;
    }
    const plan = await db.one(`SELECT id FROM plans WHERE code = 'pro'`);
    const h = await db.one(
      `INSERT INTO hotels (name, slug, legal_name, gstin, address, city, state, state_code, phone, email, plan_id, subscription_status, settings)
       VALUES ('Wayinn Demo Hotel','demo-hotel','Demo Hospitality Pvt Ltd','03ABCDE1234F1Z5','Ferozepur Road','Ludhiana','Punjab','03',
               '+91 98765 43210','frontdesk@demo-hotel.in',$1,'active',$2) RETURNING *`,
      [plan.id, JSON.stringify({ qr_orders_require_accept: true, qr_show_bill: true, require_id_at_checkin: true, discount_alert_pct: 20 })]);

    const staff = [
      ['Owner Demo', 'owner@demo-hotel.in', 'owner'], ['Manager Demo', 'manager@demo-hotel.in', 'manager'],
      ['Reception Demo', 'reception@demo-hotel.in', 'receptionist'], ['Cashier Demo', 'cashier@demo-hotel.in', 'cashier'],
      ['Restaurant Demo', 'restaurant@demo-hotel.in', 'restaurant'], ['Kitchen Demo', 'kitchen@demo-hotel.in', 'kitchen'],
      ['Housekeeping Demo', 'hk@demo-hotel.in', 'housekeeping'], ['Maintenance Demo', 'maintenance@demo-hotel.in', 'maintenance'],
    ];
    for (const [name, email, role] of staff) {
      await db.query(`INSERT INTO users (hotel_id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,$5)`, [h.id, name, email, hash, role]);
    }

    const types = [
      ['Standard', 'STD', 2, 3, 250000, 50000, ['AC', 'TV', 'Wi-Fi']],
      ['Deluxe', 'DLX', 2, 3, 380000, 70000, ['AC', 'TV', 'Wi-Fi', 'Mini fridge']],
      ['Suite', 'STE', 2, 4, 850000, 100000, ['AC', 'TV', 'Wi-Fi', 'Mini fridge', 'Living area', 'Bathtub']],
    ];
    const typeIds = {};
    for (const [name, code, base, max, rate, extra, amen] of types) {
      typeIds[code] = (await db.one(
        `INSERT INTO room_types (hotel_id, name, code, base_occupancy, max_occupancy, base_rate_paise, extra_person_rate_paise, amenities)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [h.id, name, code, base, max, rate, extra, amen])).id;
    }
    for (let n = 101; n <= 108; n++) await db.query(`INSERT INTO rooms (hotel_id, room_type_id, number, floor) VALUES ($1,$2,$3,'1')`, [h.id, typeIds.STD, String(n)]);
    for (let n = 201; n <= 208; n++) await db.query(`INSERT INTO rooms (hotel_id, room_type_id, number, floor) VALUES ($1,$2,$3,'2')`, [h.id, typeIds.DLX, String(n)]);
    for (let n = 301; n <= 302; n++) await db.query(`INSERT INTO rooms (hotel_id, room_type_id, number, floor) VALUES ($1,$2,$3,'3')`, [h.id, typeIds.STE, String(n)]);

    const kitchen = (await db.one(`INSERT INTO stations (hotel_id, name) VALUES ($1,'Kitchen') RETURNING id`, [h.id])).id;
    const bar = (await db.one(`INSERT INTO stations (hotel_id, name) VALUES ($1,'Beverages') RETURNING id`, [h.id])).id;
    const cats = {};
    for (const [i, c] of ['Breakfast', 'Main Course', 'Breads', 'Beverages'].entries()) {
      cats[c] = (await db.one(`INSERT INTO menu_categories (hotel_id, name, sort_order) VALUES ($1,$2,$3) RETURNING id`, [h.id, c, i])).id;
    }
    const items = [
      ['Breakfast', kitchen, 'Aloo Paratha with Curd', 18000, true, [], [{ name: 'Extra butter', price_paise: 3000 }]],
      ['Breakfast', kitchen, 'Masala Omelette', 15000, false, [], []],
      ['Breakfast', kitchen, 'Poha', 12000, true, [], []],
      ['Main Course', kitchen, 'Dal Makhani', 28000, true, [{ name: 'Half', price_paise: 18000 }, { name: 'Full', price_paise: 28000 }], []],
      ['Main Course', kitchen, 'Paneer Butter Masala', 32000, true, [{ name: 'Half', price_paise: 20000 }, { name: 'Full', price_paise: 32000 }], []],
      ['Main Course', kitchen, 'Butter Chicken', 42000, false, [{ name: 'Half', price_paise: 26000 }, { name: 'Full', price_paise: 42000 }], []],
      ['Main Course', kitchen, 'Veg Biryani', 26000, true, [], [{ name: 'Raita', price_paise: 6000 }]],
      ['Breads', kitchen, 'Butter Naan', 6000, true, [], []],
      ['Breads', kitchen, 'Tandoori Roti', 3000, true, [], []],
      ['Beverages', bar, 'Masala Chai', 6000, true, [], []],
      ['Beverages', bar, 'Cold Coffee', 14000, true, [], [{ name: 'Ice cream', price_paise: 4000 }]],
      ['Beverages', bar, 'Fresh Lime Soda', 9000, true, [{ name: 'Sweet', price_paise: 9000 }, { name: 'Salted', price_paise: 9000 }], []],
      ['Beverages', bar, 'Mineral Water 1L', 4000, true, [], []],
    ];
    for (const [i, [cat, st, name, price, veg, variants, addons]] of items.entries()) {
      await db.query(
        `INSERT INTO menu_items (hotel_id, category_id, station_id, name, price_paise, is_veg, variants, addons, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [h.id, cats[cat], st, name, price, veg, JSON.stringify(variants), JSON.stringify(addons), i]);
    }
    console.log(`Seeded demo hotel id=${h.id}`);
  });
  console.log(`\nLogins (password: ${PASSWORD})\n  Platform: admin@wayinn.app\n  Hotel:    owner@ / manager@ / reception@ / cashier@ / restaurant@ / kitchen@ / hk@ / maintenance@demo-hotel.in`);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
