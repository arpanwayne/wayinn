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
      <span className={`text-lg font-extrabold tracking-tight ${light ? 'text-white' : 'text-ink-900'}`}>Wayinn</span>
    </div>
  );
}

export default function Layout() {
  const { user, hotel, can, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const items = NAV.filter(([, , perms]) => can(...perms));
  const sidebar = (
    <nav className="flex h-full flex-col bg-brand-900 text-brand-100">
      <div className="px-5 py-5"><Logo light /></div>
      <div className="mx-3 mb-3 rounded-lg bg-brand-800/60 px-3 py-2">
        <div className="truncate text-sm font-semibold text-white">{hotel?.name}</div>
        <div className="text-xs text-brand-200">{user?.name} · {user?.role}</div>
      </div>
      <div className="flex-1 space-y-0.5 overflow-y-auto px-3">
        {items.map(([to, l, , icon]) => (
          <NavLink key={to} to={to} end={to === '/'} onClick={() => setOpen(false)}
            className={({ isActive }) => `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium ${isActive ? 'bg-white/10 text-white' : 'hover:bg-white/5'}`}>
            <span className="w-4 text-center text-amber-400">{icon}</span>{l}
          </NavLink>
        ))}
      </div>
      <div className="border-t border-white/10 p-3">
        <button className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-white/5" onClick={() => { logout(); nav('/login'); }}>Sign out</button>
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
        <header className="no-print sticky top-0 z-30 flex items-center gap-3 border-b border-ink-100 bg-white/90 px-4 py-3 backdrop-blur lg:hidden">
          <button className="btn-ghost btn-sm text-lg" onClick={() => setOpen(true)} aria-label="Menu">☰</button>
          <Logo />
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6"><Outlet /></main>
      </div>
    </div>
  );
}
