// Central permission catalogue. Roles get a default set; owners can grant or
// revoke individual permissions per staff member (users.extra_permissions / revoked_permissions).

export const PERMISSIONS = {
  'hotel.settings': 'Edit hotel profile, tax and operational settings',
  'staff.manage': 'Create, deactivate and change staff accounts',
  'rooms.manage': 'Set up room types, rooms and rates',
  'rooms.status': 'Update room housekeeping status',
  'rates.override': 'Change the nightly rate on a booking',
  'bookings.view': 'View reservations and calendar',
  'bookings.create': 'Create reservations',
  'bookings.modify': 'Modify dates, rooms and details of reservations',
  'bookings.cancel': 'Cancel reservations / mark no-show',
  'bookings.checkin': 'Check guests in',
  'bookings.checkout': 'Check guests out',
  'guests.view': 'View guest profiles',
  'guests.manage': 'Edit guest profiles',
  'folio.view': 'View guest bills',
  'folio.charge': 'Post charges to bills',
  'folio.discount': 'Apply discounts on bills',
  'folio.void': 'Void bill lines',
  'payments.record': 'Record payments and deposits',
  'payments.refund': 'Issue refunds',
  'payments.void': 'Void payments',
  'invoice.issue': 'Issue final invoices / close folios',
  'pos.order': 'Create and update restaurant orders',
  'pos.discount': 'Apply discounts on restaurant orders',
  'pos.cancel': 'Cancel orders and items',
  'pos.complimentary': 'Mark orders/items complimentary',
  'pos.settle': 'Settle restaurant bills / post to room',
  'kitchen.view': 'Kitchen display and KOT status',
  'menu.manage': 'Manage menu, categories and stations',
  'hk.view': 'View housekeeping board',
  'hk.manage': 'Create and assign housekeeping tasks',
  'hk.work': 'Work on assigned housekeeping tasks',
  'maintenance.view': 'View maintenance requests',
  'maintenance.manage': 'Create and assign maintenance requests',
  'maintenance.work': 'Work on and resolve maintenance requests',
  'requests.view': 'View and handle guest service requests',
  'reports.view': 'Operational reports',
  'reports.financial': 'Financial reports and revenue figures',
  'audit.view': 'View activity / audit history',
};

const ALL = Object.keys(PERMISSIONS);
const pick = (...prefixes) => ALL.filter((p) => prefixes.some((x) => p === x || p.startsWith(x + '.')));

// Each role gets only what that job needs, so e.g. housekeeping cannot cancel bookings or take money.
// Money-sensitive actions (discounts, voids, refunds, rate overrides) stay with owner/manager unless
// the owner grants them to a specific person.
export const ROLE_PERMISSIONS = {
  owner: ALL,
  manager: ALL.filter((p) => p !== 'hotel.settings'),
  front_desk: [
    ...pick('bookings', 'guests', 'requests', 'hk', 'maintenance'),
    'rooms.status', 'folio.view', 'folio.charge', 'payments.record', 'invoice.issue',
    'pos.order', 'pos.settle', 'pos.cancel',
  ],
  cashier: ['bookings.view', 'guests.view', 'folio.view', 'folio.charge', 'payments.record', 'invoice.issue',
    'pos.order', 'pos.settle', 'reports.view'],
  restaurant: ['pos.order', 'pos.settle', 'kitchen.view', 'requests.view'],
  // Kitchen sees incoming tickets and marks them delivered. Cancelling is front desk only.
  kitchen: ['kitchen.view'],
  housekeeping: ['hk.view', 'hk.work', 'rooms.status', 'requests.view', 'maintenance.view', 'maintenance.manage'],
  maintenance: ['maintenance.view', 'maintenance.work', 'hk.view'],
};

// Roles that can be assigned housekeeping / maintenance jobs.
export const TASK_ROLES = ['owner', 'manager', 'front_desk', 'housekeeping', 'maintenance'];

export const ROLES = Object.keys(ROLE_PERMISSIONS);

export function effectivePermissions(user) {
  const base = new Set(ROLE_PERMISSIONS[user.role] || []);
  for (const p of user.extra_permissions || []) base.add(p);
  for (const p of user.revoked_permissions || []) base.delete(p);
  if (user.role === 'owner') ALL.forEach((p) => base.add(p)); // owners can't be locked out
  return [...base];
}
