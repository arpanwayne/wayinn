import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './lib/auth.jsx';
import Layout from './components/Layout.jsx';
import { Loading } from './components/ui.jsx';
import Login from './pages/Login.jsx';
import FrontDesk from './pages/FrontDesk.jsx';
import Calendar from './pages/Calendar.jsx';
import Bookings from './pages/Bookings.jsx';
import BookingNew from './pages/BookingNew.jsx';
import BookingDetail from './pages/BookingDetail.jsx';
import Folio from './pages/Folio.jsx';
import Billing from './pages/Billing.jsx';
import Guests from './pages/Guests.jsx';
import GuestDetail from './pages/GuestDetail.jsx';
import Rooms from './pages/Rooms.jsx';
import Pos from './pages/Pos.jsx';
import Kitchen from './pages/Kitchen.jsx';
import Housekeeping from './pages/Housekeeping.jsx';
import Maintenance from './pages/Maintenance.jsx';
import Requests from './pages/Requests.jsx';
import Reports from './pages/Reports.jsx';
import Staff from './pages/Staff.jsx';
import Settings from './pages/Settings.jsx';
import Activity from './pages/Activity.jsx';
import InvoicePrint from './pages/InvoicePrint.jsx';
import GuestPortal from './pages/GuestPortal.jsx';
import PublicBooking from './pages/PublicBooking.jsx';
import Platform from './pages/Platform.jsx';

function Protected({ children }) {
  const { loading, user } = useAuth();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function Home() {
  const { can } = useAuth();
  if (can('bookings.view')) return <FrontDesk />;
  if (can('kitchen.view') && !can('pos.order')) return <Navigate to="/kitchen" replace />;
  if (can('pos.order')) return <Navigate to="/pos" replace />;
  if (can('hk.view')) return <Navigate to="/housekeeping" replace />;
  if (can('maintenance.view')) return <Navigate to="/maintenance" replace />;
  return <div className="text-ink-500">No modules assigned. Ask your manager for access.</div>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/g/:token" element={<GuestPortal />} />
      <Route path="/book/:slug" element={<PublicBooking />} />
      <Route path="/platform/*" element={<Platform />} />
      <Route path="/print/invoice/:id" element={<Protected><InvoicePrint /></Protected>} />
      <Route element={<Protected><Layout /></Protected>}>
        <Route index element={<Home />} />
        <Route path="calendar" element={<Calendar />} />
        <Route path="bookings" element={<Bookings />} />
        <Route path="bookings/new" element={<BookingNew />} />
        <Route path="bookings/:id" element={<BookingDetail />} />
        <Route path="folios/:id" element={<Folio />} />
        <Route path="billing" element={<Billing />} />
        <Route path="guests" element={<Guests />} />
        <Route path="guests/:id" element={<GuestDetail />} />
        <Route path="rooms" element={<Rooms />} />
        <Route path="pos" element={<Pos />} />
        <Route path="kitchen" element={<Kitchen />} />
        <Route path="housekeeping" element={<Housekeeping />} />
        <Route path="maintenance" element={<Maintenance />} />
        <Route path="requests" element={<Requests />} />
        <Route path="reports" element={<Reports />} />
        <Route path="staff" element={<Staff />} />
        <Route path="settings" element={<Settings />} />
        <Route path="activity" element={<Activity />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
