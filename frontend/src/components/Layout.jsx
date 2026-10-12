import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { useAuth } from '../lib/auth.jsx';

const NAV = [
  ['/', 'Front desk', ['bookings.view'], '◧'],
  ['/calendar', 'Calendar', ['bookings.view'], '▦'],
  ['/bookings', 'Bookings', ['bookings.view'], '☰'],
  ['/rooms', 'Rooms', ['bookings.view', 'rooms.status'], '▢'],
  ['/guests', 'Guests', ['guests.view'], '☺'],
  ['/billing', 'Billing', ['folio.view'], '₹'],
  ['/pos', 'Restaurant POS', ['pos.order'], '◉'],
  ['/kitchen', 'Kitchen', ['kitchen.view'], '♨'],
  ['/housekeeping', 'Housekeeping', ['hk.view'], '✦'],
  ['/maintenance', 'Maintenance', ['maintenance.view'], '⚒'],
  ['/requests', 'Guest requests', ['requests.view'], '☎'],
  ['/reports', 'Owner reports', ['reports.view'], '◔'],
  ['/staff', 'Staff', ['staff.manage'], '♟'],
  ['/settings', 'Setup', ['rooms.manage', 'menu.manage', 'hotel.settings'], '⚙'],
  ['/activity', 'Activity log', ['audit.view'], '⌁'],
];

export function Logo({ light = false }) {
  return (
    <div className="flex items-center gap-2">
      <img src="/favicon.svg" alt="" className="h-8 w-8" />
      <span className={`font-display text-xl font-bold tracking-tight ${light ? 'text-white' : 'text-ink-900'}`}>Wayinn</span>
    </div>
  );
}

export default function Layout() {
  const { user, hotel, can, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const items = NAV.filter(([, , perms]) => can(...perms));
  const sidebar = (
    <nav className="flex h-full flex-col border-r border-ink-200 bg-white text-ink-600">
      <div className="px-5 py-5"><Logo /></div>
      <div className="mx-3 mb-4 rounded-2xl bg-night-900 px-3.5 py-3 text-white shadow-lift">
        <div className="truncate font-display text-[15px] font-semibold">{hotel?.name}</div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-night-100">
          <span className="truncate">{user?.name}</span>
          <span className="rounded-full bg-white px-2 py-0.5 font-semibold capitalize text-night-900">{(user?.role || '').replace('_', ' ')}</span>
        </div>
      </div>
      <div className="flex-1 space-y-0.5 overflow-y-auto px-3">
        {items.map(([to, l, , icon]) => (
          <NavLink key={to} to={to} end={to === '/'} onClick={() => setOpen(false)}
            className={({ isActive }) => `group relative flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition ${isActive ? 'bg-night-50 font-semibold text-night-900' : 'hover:bg-ink-50 hover:text-ink-900'}`}>
            {({ isActive }) => (<>
              {isActive && <span className="absolute inset-y-2 left-0 w-1 rounded-full bg-night-900" />}
              <span className={`w-4 text-center ${isActive ? 'text-night-900' : 'text-ink-400 group-hover:text-night-900'}`}>{icon}</span>{l}
            </>)}
          </NavLink>
        ))}
      </div>
      <div className="border-t border-ink-200 p-3">
        <button className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-ink-50" onClick={() => { logout(); nav('/login'); }}>Sign out</button>
      </div>
    </nav>
  );
  return (
    <div className="flex min-h-screen">
      <aside className="no-print fixed inset-y-0 left-0 hidden w-60 lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-ink-900/40" />
          <aside className="absolute inset-y-0 left-0 w-64" onClick={(e) => e.stopPropagation()}>{sidebar}</aside>
        </div>
      )}
      <div className="flex-1 lg:pl-60">
        <header className="no-print sticky top-0 z-30 flex items-center gap-3 border-b border-ink-100 bg-white/90 px-4 py-2.5 backdrop-blur lg:hidden">
          <button className="btn-ghost btn-sm text-lg" onClick={() => setOpen(true)} aria-label="Menu">☰</button>
          <Logo />
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6"><Outlet /></main>
      </div>
    </div>
  );
}
